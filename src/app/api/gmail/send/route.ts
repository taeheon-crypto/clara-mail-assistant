import { NextResponse } from "next/server";
import { auth } from "@/auth";

function encodeSubject(subject: string): string {
  // ASCII만 있으면 그대로, 한글 등 비ASCII가 섞이면 RFC 2047 인코딩 필요
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;
  const fromEmail = (session as any).user?.email as string | undefined;

  const { to, subject, bodyText, threadId, inReplyTo, references } = await req.json();
  if (!to || !String(to).trim()) {
    return NextResponse.json({ error: "missing_to" }, { status: 400 });
  }
  if (!bodyText || !String(bodyText).trim()) {
    return NextResponse.json({ error: "missing_body" }, { status: 400 });
  }

  const headerLines = [
    ...(fromEmail ? [`From: ${fromEmail}`] : []),
    `To: ${to}`,
    `Subject: ${encodeSubject(subject || "")}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    `MIME-Version: 1.0`,
  ];
  if (inReplyTo) headerLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headerLines.push(`References: ${references}`);

  const bodyB64 = Buffer.from(bodyText, "utf-8").toString("base64");
  const rawMessage = headerLines.join("\r\n") + "\r\n\r\n" + bodyB64;
  const encodedMessage = Buffer.from(rawMessage, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const payload: Record<string, unknown> = { raw: encodedMessage };
  if (threadId) payload.threadId = threadId;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ error: "gmail_send_failed", detail: errText.slice(0, 300) }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json({ success: true, id: data.id, threadId: data.threadId });
}
