import { NextResponse } from "next/server";
import { auth } from "@/auth";

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

function getPlainBody(payload: any): string {
  const part = findPartByMime(payload, "text/plain");
  if (part) return decodeB64Url(part.body.data);
  // text/plain이 없으면 HTML에서 태그만 제거해 미리보기/AI 컨텍스트용으로 사용
  const htmlPart = findPartByMime(payload, "text/html");
  if (htmlPart) {
    return decodeB64Url(htmlPart.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function getRawHtmlBody(payload: any): string | null {
  const part = findPartByMime(payload, "text/html");
  if (!part) return null;
  return decodeB64Url(part.body.data);
}

// 인라인 이미지(Content-ID로 cid: 참조되는 이미지) 수집
function getInlineImages(payload: any): { cid: string; attachmentId: string; mimeType: string }[] {
  const out: { cid: string; attachmentId: string; mimeType: string }[] = [];
  function walk(part: any) {
    if (!part) return;
    const headers = part.headers || [];
    const cidHeader = headers.find((h: any) => h.name.toLowerCase() === "content-id");
    if (cidHeader && part.body?.attachmentId) {
      const cid = cidHeader.value.replace(/^<|>$/g, "");
      out.push({ cid, attachmentId: part.body.attachmentId, mimeType: part.mimeType || "image/png" });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

// 기본 XSS 방지: script/이벤트핸들러/javascript: 제거, cid: 이미지를 프록시 URL로 치환
function sanitizeAndResolveHtml(html: string, messageId: string, inlineImages: { cid: string; attachmentId: string; mimeType: string }[]): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");

  for (const img of inlineImages) {
    const proxyUrl = `/api/gmail/attachment?messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(img.attachmentId)}&mimeType=${encodeURIComponent(img.mimeType)}&filename=inline`;
    const re = new RegExp(`cid:${img.cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    out = out.replace(re, proxyUrl);
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

export async function GET() {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&labelIds=INBOX",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) {
    return NextResponse.json({ error: "gmail_list_failed" }, { status: listRes.status });
  }
  const listData = await listRes.json();
  const ids: { id: string }[] = listData.messages || [];

  const messages = await Promise.all(
    ids.map(async (m) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return r.json();
    })
  );

  const emails = messages.filter(Boolean).map((msg) => {
    const headers = msg.payload?.headers || [];
    const subject = getHeader(headers, "Subject") || "(제목 없음)";
    const from = getHeader(headers, "From");
    const date = getHeader(headers, "Date");
    const sender = from.replace(/<[^>]+>/g, "").replace(/"/g, "").trim() || from;
    const body = getPlainBody(msg.payload);
    const rawHtml = getRawHtmlBody(msg.payload);
    const inlineImages = rawHtml ? getInlineImages(msg.payload) : [];
    const bodyHtml = rawHtml ? sanitizeAndResolveHtml(rawHtml, msg.id, inlineImages) : null;
    const unread = (msg.labelIds || []).includes("UNREAD");
    const starred = (msg.labelIds || []).includes("STARRED");
    const attachments = getAttachments(msg.payload);

    return {
      id: msg.id,
      sender,
      subject,
      preview: body.slice(0, 140),
      body,
      bodyHtml,
      date,
      unread,
      starred,
      attachments,
    };
  });

  return NextResponse.json({ emails });
}
