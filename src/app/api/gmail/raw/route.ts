import { gmailFetch } from '@/lib/gmail-transport';
import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { searchParams } = new URL(req.url);
  const gmailId = searchParams.get("gmailId");
  const download = searchParams.get("download") === "1";
  if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });

  const res = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=raw`, accessToken);
  if (!res.ok) {
    return NextResponse.json({ error: "gmail_raw_failed" }, { status: res.status });
  }
  const data = await res.json();
  const raw = (data.raw || "").replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(raw, "base64");

  if (download) {
    return new Response(buffer, {
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Disposition": `attachment; filename="${gmailId}.eml"`,
      },
    });
  }

  return new Response(buffer.toString("utf-8"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
