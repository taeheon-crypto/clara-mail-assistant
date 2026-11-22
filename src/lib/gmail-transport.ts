import { createHash } from 'node:crypto';

type Entry = { body: string; expires: number };
type Account = { cache: Map<string, Entry>; pending: Map<string, Promise<Response>>; tail: Promise<void>; next: number; blockedUntil: number; failures: number; touched: number; generation: number };
// Shared by inbox, AI indexing and original-body reads in this worker. Tokens
// are hashed and never stored in keys or logs; responses never enter a CDN.
const accounts = new Map<string, Account>();
let cacheBytes = 0;
function removeCached(account: Account, url: string) {
  const entry = account.cache.get(url);
  if (entry) { cacheBytes -= entry.body.length * 2; account.cache.delete(url); }
}
const keyFor = (token: string) => createHash('sha256').update(token).digest('hex');
function accountFor(token: string) {
  const key = keyFor(token);
  let account = accounts.get(key);
  if (!account) {
    for (const [k, a] of accounts) if (Date.now() - a.touched > 3600000 && !a.pending.size) { for (const url of a.cache.keys()) removeCached(a, url); accounts.delete(k); }
    account = { cache: new Map(), pending: new Map(), tail: Promise.resolve(), next: 0, blockedUntil: 0, failures: 0, touched: Date.now(), generation: 0 };
    accounts.set(key, account);
  }
  account.touched = Date.now();
  return account;
}
export function invalidateGmail(token: string, id?: string) {
  const a = accountFor(token);
  a.generation++;
  for (const url of a.cache.keys()) if (!id || url.includes('/messages/' + encodeURIComponent(id)) || new URL(url).pathname.endsWith('/messages')) removeCached(a, url);
  for (const url of a.pending.keys()) if (!id || url.includes('/messages/' + encodeURIComponent(id)) || new URL(url).pathname.endsWith('/messages')) a.pending.delete(url);
}
export async function gmailFetch(url: URL | string, token: string, signal?: AbortSignal): Promise<Response> {
  const key = String(url), a = accountFor(token), cached = a.cache.get(key);
  if (cached && cached.expires > Date.now()) return new Response(cached.body, { headers: { 'Content-Type': 'application/json' } });
  const existing = a.pending.get(key);
  if (existing) return (await existing).clone();
  const generation = a.generation;
  const job = (async () => {
    // Serialize only the launch slot, not response downloads. Four starts per
    // second leaves room for other Gmail clients and bounds aggregate bursts.
    let release!: () => void;
    const previous = a.tail;
    a.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      signal?.throwIfAborted();
      if (a.blockedUntil > Date.now()) return Response.json({ error: { reason: 'rateLimitExceeded' } }, { status: 429, headers: { 'Retry-After': String(Math.ceil((a.blockedUntil - Date.now()) / 1000)) } });
      const delay = a.next - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      a.next = Date.now() + 250;
    } finally { release(); }
    const res = await fetch(key, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: signal || AbortSignal.timeout(20000) });
    const body = await res.clone().text();
    if (res.status === 429 || (res.status === 403 && /quota|rateLimitExceeded|dailyLimitExceeded/i.test(body))) {
      const alreadyBlocked = a.blockedUntil > Date.now();
      if (!alreadyBlocked) a.failures++;
      const header = res.headers.get('Retry-After');
      const specified = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
      // Parallel failures are one throttle event, not five new backoffs.
      a.blockedUntil = alreadyBlocked
        ? Math.max(a.blockedUntil, Date.now() + (specified || 0))
        : Date.now() + Math.max(specified || 0, Math.min(120000, 60000 * 2 ** (a.failures - 1))) + Math.floor(Math.random() * 1000);
      return new Response(body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((a.blockedUntil - Date.now()) / 1000)) } });
    }
    if (res.ok) {
      a.failures = 0;
      const ttl = new URL(key).pathname.includes('/attachments/') ? 300000 : new URL(key).pathname.endsWith('/messages') ? 15000 : key.includes('format=full') ? 60000 : 0;
      if (ttl && a.generation === generation) {
        if (a.cache.size >= 1000) removeCached(a, a.cache.keys().next().value!);
        // Bound memory even for unusually large message payloads.
        if (body.length < 1000000) {
          removeCached(a, key);
          for (const owner of accounts.values()) {
            for (const url of owner.cache.keys()) {
              if (cacheBytes + body.length * 2 <= 32 * 1024 * 1024) break;
              removeCached(owner, url);
            }
          }
          a.cache.set(key, { body, expires: Date.now() + ttl }); cacheBytes += body.length * 2;
        }
      }
    }
    return res;
  })();
  a.pending.set(key, job);
  try { return (await job).clone(); } finally { if (a.pending.get(key) === job) a.pending.delete(key); }
}

// Gmail supports metadata-only multipart reads. One page uses two HTTP
// connections (IDs + metadata batch), rather than downloading thirty bodies.
export async function gmailMetadataBatch(ids: string[], token: string): Promise<Response[]> {
  const a = accountFor(token), generation = a.generation;
  const results: Response[] = [], missing: { id: string; index: number; url: string }[] = [];
  for (const [index, id] of ids.entries()) {
    const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=`;
    const cached = a.cache.get(base + 'metadata') || a.cache.get(base + 'full');
    if (cached && cached.expires > Date.now()) results[index] = new Response(cached.body);
    else missing.push({ id, index, url: base + 'metadata' });
  }
  if (!missing.length) return results;
  if (a.blockedUntil > Date.now()) {
    for (const item of missing) results[item.index] = Response.json({ error: 'rateLimitExceeded' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((a.blockedUntil - Date.now()) / 1000)) } });
    return results;
  }
  const boundary = 'clara_gmail_metadata';
  const body = missing.map(({ id, index }) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <mail${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata HTTP/1.1\r\n\r\n`).join('') + `--${boundary}--\r\n`;
  const response = await fetch('https://gmail.googleapis.com/batch', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` }, body, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const text = await response.text();
    for (const item of missing) results[item.index] = new Response(text, { status: response.status, headers: response.headers });
  } else {
    const delimiter = response.headers.get('Content-Type')?.match(/boundary="?([^";\s]+)/i)?.[1];
    if (!delimiter) throw new Error('Invalid Gmail batch response');
    const parts = (await response.text()).split('--' + delimiter);
    for (const part of parts) {
      const index = Number(part.match(/Content-ID:\s*<response-mail(\d+)>/i)?.[1]);
      const item = missing.find(m => m.index === index);
      const match = part.match(/HTTP\/1\.[01]\s+(\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)/);
      if (!item || !match) continue;
      const status = Number(match[1]), text = match[3].trim();
      if (status === 200) {
        try { if (JSON.parse(text).id !== item.id) continue; } catch { continue; }
      }
      const retry = match[2].match(/Retry-After:\s*(\d+)/i)?.[1];
      results[index] = new Response(text, { status, headers: retry ? { 'Retry-After': retry } : {} });
      if (status === 200 && a.generation === generation) {
        removeCached(a, item.url);
        if (cacheBytes + text.length * 2 < 32 * 1024 * 1024) { a.cache.set(item.url, { body: text, expires: Date.now() + 60000 }); cacheBytes += text.length * 2; }
      }
    }
  }
  // One failed part must not turn successful rows into a blank page.
  for (const item of missing) {
    results[item.index] ||= Response.json({ error: 'missing_batch_part' }, { status: 502 });
    const r = results[item.index];
    if (r.status === 429 || (r.status === 403 && /quota|rateLimitExceeded/i.test(await r.clone().text()))) {
      a.blockedUntil = Math.max(a.blockedUntil, Date.now() + Number(r.headers.get('Retry-After') || 60) * 1000);
    }
  }
  return results;
}
