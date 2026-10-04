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

function getBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.size > 0) return decodeB64Url(payload.body.data || "");
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain) return getBody(plain);
    const html = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (html) return getBody(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    for (const part of payload.parts) {
      const r = getBody(part);
      if (r) return r;
    }
  }
  return "";
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
    const body = getBody(msg.payload);
    const unread = (msg.labelIds || []).includes("UNREAD");
    const starred = (msg.labelIds || []).includes("STARRED");
    const attachments = getAttachments(msg.payload);

    return {
      id: msg.id,
      sender,
      subject,
      preview: body.slice(0, 140),
      body,
      date,
      unread,
      starred,
      attachments,
    };
  });

  return NextResponse.json({ emails });
}
