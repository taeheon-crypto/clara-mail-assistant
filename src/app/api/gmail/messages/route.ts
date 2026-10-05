import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const maxDuration = 30; // 재시도 여유를 위해 기본 타임아웃보다 넉넉하게

function decodeB64Url(str: string): string {
  try {
    const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function getHeader(headers: { name: string; value: string }[] | undefined, name: string): string {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// 본문 추출: text/plain 과 text/html 을 각각 따로 찾는다 (HTML은 안 건드리고 그대로 보존)
function findPartByMime(payload: any, mime: string): any {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload;
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findPartByMime(p, mime);
      if (found) return found;
    }
  }
  return null;
}

// 일부 메일 시스템(메일플러그 등)은 text/plain 파트에도 HTML 태그/엔티티를 그대로 남겨둠 → 항상 방어적으로 정리
function stripHtmlAndDecode(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlainBody(payload: any): string {
  const part = findPartByMime(payload, "text/plain");
  if (part) {
    const raw = decodeB64Url(part.body.data);
    // 실제로 HTML 태그가 섞여 있을 때만 정리(일반 평문 줄바꿈은 보존)
    return /<[a-z][\s\S]*>/i.test(raw) ? stripHtmlAndDecode(raw) : raw;
  }
  // text/plain이 없으면 HTML에서 태그만 제거해 미리보기/AI 컨텍스트용으로 사용
  const htmlPart = findPartByMime(payload, "text/html");
  if (htmlPart) {
    return stripHtmlAndDecode(decodeB64Url(htmlPart.body.data));
  }
  return "";
}

function getRawHtmlBody(payload: any): string | null {
  const part = findPartByMime(payload, "text/html");
  if (!part) return null;
  return decodeB64Url(part.body.data);
}

// 인라인 이미지(Content-ID로 cid: 참조되는 이미지) 수집
// 작은 이미지는 attachmentId 없이 body.data에 바로 들어있고, 큰 이미지만 attachmentId로 별도 조회해야 함 — 둘 다 처리
type InlineImage = { cid: string; mimeType: string; dataUri?: string; attachmentId?: string };

function getInlineImages(payload: any): InlineImage[] {
  const out: InlineImage[] = [];
  function walk(part: any) {
    if (!part) return;
    const headers = part.headers || [];
    const cidHeader = headers.find((h: any) => h.name.toLowerCase() === "content-id");
    if (cidHeader) {
      const cid = cidHeader.value.replace(/^<|>$/g, "");
      const mimeType = part.mimeType || "image/png";
      if (part.body?.data) {
        const b64 = part.body.data.replace(/-/g, "+").replace(/_/g, "/");
        out.push({ cid, mimeType, dataUri: `data:${mimeType};base64,${b64}` });
      } else if (part.body?.attachmentId) {
        out.push({ cid, mimeType, attachmentId: part.body.attachmentId });
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

// 기본 XSS 방지 + 원본 메일에 박힌 고정 높이/스크롤 스타일 제거(중첩 스크롤박스 방지) + cid: 이미지 치환
function sanitizeAndResolveHtml(html: string, messageId: string, inlineImages: InlineImage[]): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    // 발신 메일 클라이언트가 인용문 등에 박아둔 고정 height/overflow 제거 → 우리 컨테이너가 자연스럽게 전체 높이를 가짐
    .replace(/(style\s*=\s*"[^"]*)\b(max-height|height|overflow(?:-y)?)\s*:\s*[^;"]+;?/gi, "$1")
    .replace(/(style\s*=\s*'[^']*)\b(max-height|height|overflow(?:-y)?)\s*:\s*[^;']+;?/gi, "$1");

  for (const img of inlineImages) {
    const src = img.dataUri
      ? img.dataUri
      : `/api/gmail/attachment?messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(img.attachmentId!)}&mimeType=${encodeURIComponent(img.mimeType)}&filename=inline`;
    const re = new RegExp(`cid:${img.cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    out = out.replace(re, src);
  }
  return out;
}

function getAttachments(payload: any): { attachmentId: string; name: string; size: string; type: string; mimeType: string }[] {
  const out: { attachmentId: string; name: string; size: string; type: string; mimeType: string }[] = [];
  function walk(part: any) {
    if (!part) return;
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      const sizeBytes = part.body.size || 0;
      const sizeStr = sizeBytes > 1024 ? `${Math.round(sizeBytes / 1024)}KB` : `${sizeBytes}B`;
      out.push({
        attachmentId: part.body.attachmentId,
        name: part.filename,
        size: sizeStr,
        type: (part.mimeType || "").includes("pdf") ? "pdf" : "img",
        mimeType: part.mimeType || "application/octet-stream",
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { searchParams } = new URL(req.url);
  const pageToken = searchParams.get("pageToken");
  const folder = searchParams.get("folder") || "inbox";
  const mailboxes: Record<string, { label?: string; query?: string; includeSpamTrash?: boolean }> = {
    inbox: { label: "INBOX" }, starred: { label: "STARRED" }, snoozed: { query: "in:snoozed" },
    important: { label: "IMPORTANT" }, sent: { label: "SENT" }, drafts: { label: "DRAFT" },
    purchases: { query: "category:purchases" }, social: { query: "category:social" },
    updates: { query: "category:updates" }, forums: { query: "category:forums" }, promotions: { query: "category:promotions" },
    all: {}, spam: { label: "SPAM", includeSpamTrash: true }, deleted: { label: "TRASH", includeSpamTrash: true },
    primary: { label: "INBOX", query: "category:primary" },
  };
  if (!Object.hasOwn(mailboxes, folder)) return NextResponse.json({ error: "invalid_mailbox" }, { status: 400 });
  const mailbox = mailboxes[folder];

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", "30");
  if (mailbox.label) listUrl.searchParams.set("labelIds", mailbox.label);
  if (mailbox.query) listUrl.searchParams.set("q", mailbox.query);
  if (mailbox.includeSpamTrash) listUrl.searchParams.set("includeSpamTrash", "true");
  if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    const bodyText = await listRes.text().catch(() => "");
    console.error(`gmail list failed status=${listRes.status} body=${bodyText.slice(0, 400)}`);
    const quotaExceeded = listRes.status === 429 || /quota|rateLimitExceeded|dailyLimitExceeded/i.test(bodyText);
    return NextResponse.json(
      { error: quotaExceeded ? "quota_exceeded" : "gmail_list_failed", detail: bodyText.slice(0, 300) },
      { status: listRes.status }
    );
  }
  const listData = await listRes.json();
  const ids: { id: string }[] = listData.messages || [];
  const nextPageToken: string | null = listData.nextPageToken || null;

  let quotaHit = false;
  let incompletePage = false;
  // A resumed page only needs the messages not already held by this browser.
  const loadedIds = new Set((searchParams.get("loadedIds") || "").split(",").filter(id => /^[a-f0-9]{1,32}$/i.test(id)).slice(0, 30));
  // 한꺼번에 너무 많이 병렬 요청하면 Gmail API 레이트리밋에 걸려 일부 메일이 누락됨 → 작은 배치 + 재시도로 보완.
  // 단, "분당 할당량 초과"는 몇 초 재시도한다고 풀리지 않으므로 그 경우엔 즉시 포기한다 (더 두드리면 역효과).
  async function fetchOne(id: string, attempt = 0): Promise<any | null> {
    if (quotaHit) return null; // 이미 할당량 초과를 확인했으면 나머지는 시도조차 하지 않음
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.ok) return r.json();
    const bodyText = await r.text().catch(() => "");
    if (r.status === 429 || /quota|rateLimitExceeded|dailyLimitExceeded/i.test(bodyText)) {
      quotaHit = true;
      incompletePage = true;
      console.error(`gmail quota exceeded, aborting remaining fetches`);
      return null;
    }
    const retryable = r.status === 429 || r.status >= 500;
    if (retryable && attempt < 4) {
      await new Promise((res) => setTimeout(res, 300 * Math.pow(2, attempt)));
      return fetchOne(id, attempt + 1);
    }
    if (r.status !== 404) incompletePage = true;
    console.error(`gmail message fetch failed permanently: ${id} status=${r.status}`);
    return null; // 재시도해도 실패하면 이 메일은 건너뜀 (깨진 행 대신 그냥 제외)
  }

  const BATCH_SIZE = 5;
  const messages: any[] = [];
  const pendingIds = ids.filter(message => !loadedIds.has(message.id));
  for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
    const batch = pendingIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((m) => fetchOne(m.id)));
    messages.push(...results);
    if (quotaHit) break;
    if (i + BATCH_SIZE < pendingIds.length) await new Promise((res) => setTimeout(res, 120));
  }

  const emails = messages.filter((msg) => msg && msg.payload).map((msg) => {
    const headers = msg.payload?.headers || [];
    const subject = getHeader(headers, "Subject") || "(제목 없음)";
    const from = getHeader(headers, "From");
    const date = getHeader(headers, "Date");
    const sender = from.replace(/<[^>]+>/g, "").replace(/"/g, "").trim() || from;
    const senderEmailMatch = from.match(/<([^>]+)>/);
    const senderEmail = senderEmailMatch ? senderEmailMatch[1] : from.trim();
    const messageIdHeader = getHeader(headers, "Message-ID");
    const referencesHeader = getHeader(headers, "References");
    const ccHeader = getHeader(headers, "Cc");
    const toHeader = getHeader(headers, "To");
    const body = getPlainBody(msg.payload);
    const rawHtml = getRawHtmlBody(msg.payload);
    const inlineImages = rawHtml ? getInlineImages(msg.payload) : [];
    const bodyHtml = rawHtml ? sanitizeAndResolveHtml(rawHtml, msg.id, inlineImages) : null;
    const unread = (msg.labelIds || []).includes("UNREAD");
    const starred = (msg.labelIds || []).includes("STARRED");
    const attachments = getAttachments(msg.payload);

    return {
      id: msg.id,
      threadId: msg.threadId,
      sender,
      senderEmail,
      messageIdHeader,
      referencesHeader,
      ccHeader,
      toHeader,
      subject,
      preview: body.slice(0, 140),
      body,
      bodyHtml,
      date,
      unread,
      starred,
      attachments,
      labelIds: msg.labelIds || [],
      mailbox: folder,
    };
  });

  return NextResponse.json({ emails, mailbox: folder, nextPageToken: incompletePage ? pageToken : nextPageToken, retryPage: incompletePage, quotaExceeded: quotaHit, retryAfterMs: quotaHit ? 60000 : incompletePage ? 5000 : 0 });
}
