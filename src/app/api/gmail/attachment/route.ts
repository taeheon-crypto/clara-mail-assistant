import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { searchParams } = new URL(req.url);
  const messageId = searchParams.get("messageId");
  const attachmentId = searchParams.get("attachmentId");
  const filename = searchParams.get("filename") || "attachment";
  const mimeType = searchParams.get("mimeType") || "application/octet-stream";

  if (!messageId || !attachmentId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    return NextResponse.json({ error: "gmail_attachment_failed" }, { status: res.status });
  }
  const data = await res.json();
  const base64 = (data.data || "").replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(base64, "base64");

  return new Response(buffer, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
