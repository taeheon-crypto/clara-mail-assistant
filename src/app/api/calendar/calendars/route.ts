import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET() {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return NextResponse.json({ error: "calendar_list_failed", detail: bodyText.slice(0, 300) }, { status: res.status });
  }
  const data = await res.json();
  const calendars = (data.items || []).map((c: any) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    backgroundColor: c.backgroundColor,
    primary: !!c.primary,
    selected: c.selected !== false,
  }));
  return NextResponse.json({ calendars });
}
