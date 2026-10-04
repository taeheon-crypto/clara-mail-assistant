import { auth } from '@/auth';
import { NextResponse } from 'next/server';

export const maxDuration = 30;
type Header = { name: string; value: string };
type MailPart = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; attachmentId?: string }; parts?: MailPart[] };
type GoogleRecord = {
  id: string; threadId?: string; internalDate?: string; labelIds?: string[];
  payload?: MailPart; snippet?: string; summary?: string; status?: string;
  start?: Record<string, string>; end?: Record<string, string>; description?: string;
  location?: string; attendees?: { email?: string; displayName?: string }[];
  organizer?: { email?: string; displayName?: string }; recurrence?: string[]; htmlLink?: string;
};
type GoogleResponse = GoogleRecord & { messages?: GoogleRecord[]; items?: GoogleRecord[]; nextPageToken?: string; resultSizeEstimate?: number };
const privateHeaders = { 'Cache-Control': 'private, no-store' };
class ProviderError extends Error {
  constructor(public status: number, public quota: boolean) { super('Google API request failed'); }
}
function header(headers: Header[], name: string) {
  return (headers || []).find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}
function bodyPart(part: MailPart, mime: string): string {
  if (part.mimeType === mime && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts || []) { const text = bodyPart(child, mime); if (text) return text; }
  return '';
}
function mailText(part: MailPart): string {
  const plain = bodyPart(part, 'text/plain');
  if (plain) return plain;
  return bodyPart(part, 'text/html')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:br|p|div|li)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").trim();
}
function attachments(part: MailPart): Record<string, unknown>[] {
  return [...(part.filename ? [{ name: part.filename, attachmentId: part.body?.attachmentId, mimeType: part.mimeType }] : []), ...(part.parts || []).flatMap(attachments)];
}
export async function GET(req: Request) {
  const session = await auth();
  const token = (session as unknown as { accessToken?: string; error?: string } | null);
  if (!session || !token?.accessToken || token.error) return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: privateHeaders });
  const params = new URL(req.url).searchParams;
  const source = params.get('source');
  const deadline = AbortSignal.timeout(24000);
  async function google(url: URL | string): Promise<GoogleResponse> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token!.accessToken}` }, cache: 'no-store', signal: deadline });
    if (!res.ok) {
      const text = await res.text();
      const quota = res.status === 429 || /quota|rateLimitExceeded|userRateLimitExceeded/i.test(text);
      throw new ProviderError(res.status, quota);
    }
    return res.json();
  }
  try {
    if (source === 'mail') {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('maxResults', '10');
      url.searchParams.set('includeSpamTrash', 'true');
      if (params.get('cursor')) url.searchParams.set('pageToken', params.get('cursor')!);
      const list = await google(url);
      const records: Record<string, unknown>[] = [];
      // Sequential reads keep indexing below the per-user query quota.
      // A failed page is atomic: its cursor is not advanced by the client.
      for (const item of list.messages || []) {
        let mail: GoogleRecord;
        try { mail = await google(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`); }
        catch (err) { if (err instanceof ProviderError && err.status === 404) continue; throw err; }
        const h = mail.payload?.headers || [];
        const from = header(h, 'From');
        const senderEmail = (from.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/i) || [''])[0].toLowerCase();
        records.push({
          id: mail.id, threadId: mail.threadId, subject: header(h, 'Subject'),
          sender: from.replace(/<[^>]+>/g, '').replace(/"/g, '').trim(), senderEmail,
          toHeader: header(h, 'To'), ccHeader: header(h, 'Cc'),
          dateISO: new Date(Number(mail.internalDate)).toISOString(), labelIds: mail.labelIds || [],
          body: (mailText(mail.payload || {}) || mail.snippet || '').slice(0, 24000),
          attachments: attachments(mail.payload || {})
        });
      }
      return NextResponse.json({ records, cursor: list.nextPageToken || null, estimatedTotal: list.resultSizeEstimate }, { headers: privateHeaders });
    }
    if (source === 'calendars') {
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', '100');
      if (params.get('cursor')) url.searchParams.set('pageToken', params.get('cursor')!);
      const data = await google(url);
      return NextResponse.json({ records: (data.items || []).map((c: GoogleRecord) => ({ id: c.id, name: c.summary })), cursor: data.nextPageToken || null }, { headers: privateHeaders });
    }
    if (source === 'events' && params.get('calendarId')) {
      const calendarId = params.get('calendarId')!;
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('maxResults', '100');
      // Index complete stored events and recurring series, not a silently limited time window.
      url.searchParams.set('singleEvents', 'false');
      url.searchParams.set('showDeleted', 'false');
      if (params.get('cursor')) url.searchParams.set('pageToken', params.get('cursor')!);
      const data = await google(url);
      const records = (data.items || []).filter((e: GoogleRecord) => e.status !== 'cancelled').map((e: GoogleRecord) => ({
        id: e.id, calendarId, title: e.summary, start: e.start, end: e.end,
        description: e.description, location: e.location, attendees: e.attendees,
        organizer: e.organizer, recurrence: e.recurrence, htmlLink: e.htmlLink
      }));
      return NextResponse.json({ records, cursor: data.nextPageToken || null }, { headers: privateHeaders });
    }
    return NextResponse.json({ error: 'invalid_source' }, { status: 400, headers: privateHeaders });
  } catch (err) {
    if (err instanceof ProviderError) return NextResponse.json({ error: err.quota ? 'quota_exceeded' : 'google_sync_failed', retryAfter: err.quota ? 60 : undefined }, { status: err.quota ? 429 : err.status, headers: privateHeaders });
    return NextResponse.json({ error: 'sync_unavailable' }, { status: 503, headers: privateHeaders });
  }
}
