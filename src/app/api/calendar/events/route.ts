import { NextResponse } from "next/server";
import { auth } from "@/auth";

function toDateKey(dt: string): string {
  // dt는 'YYYY-MM-DD' (종일) 또는 ISO datetime
  return dt.length === 10 ? dt : dt.slice(0, 10);
}
function toMinutes(dt: string): number | null {
  if (dt.length === 10) return null; // 종일 일정
  const d = new Date(dt);
  return d.getHours() * 60 + d.getMinutes();
}

const TYPE_BY_COLOR: Record<string, string> = {}; // 필요시 colorId → type 매핑 확장 가능

export async function GET(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { searchParams } = new URL(req.url);
  const timeMin = searchParams.get("timeMin");
  const timeMax = searchParams.get("timeMax");
  const calendarIdsParam = searchParams.get("calendarIds") || "primary";
  const calendarIds = calendarIdsParam.split(",").filter(Boolean);

  if (!timeMin || !timeMax) {
    return NextResponse.json({ error: "missing_range" }, { status: 400 });
  }

  const results = await Promise.all(
    calendarIds.map(async (calId) => {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "100");
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) return { calId, items: [] as any[] };
      const d = await r.json();
      return { calId, items: d.items || [] };
    })
  );

  const events: any[] = [];
  for (const { calId, items } of results) {
    for (const ev of items) {
      if (ev.status === "cancelled") continue;
      const startRaw = ev.start?.dateTime || ev.start?.date;
      const endRaw = ev.end?.dateTime || ev.end?.date;
      if (!startRaw) continue;
      const startMin = toMinutes(startRaw);
      const endMin = endRaw ? toMinutes(endRaw) : null;
      events.push({
        id: ev.id,
        calendarId: calId,
        date: toDateKey(startRaw),
        title: ev.summary || "(제목 없음)",
        allDay: startMin === null,
        startMin: startMin ?? 0,
        endMin: endMin ?? (startMin !== null ? startMin + 60 : 24 * 60),
        loc: ev.location || "",
        detail: ev.description || "",
      });
    }
  }

  return NextResponse.json({ events });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { calendarId, title, date, startTime, endTime, location, description } = await req.json();
  if (!title || !date) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const calId = calendarId || "primary";

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
  const body: any = {
    summary: title,
    location: location || undefined,
    description: description || undefined,
  };
  if (startTime && endTime) {
    body.start = { dateTime: `${date}T${startTime}:00`, timeZone: tz };
    body.end = { dateTime: `${date}T${endTime}:00`, timeZone: tz };
  } else {
    body.start = { date };
    body.end = { date };
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return NextResponse.json({ error: "calendar_create_failed", detail: bodyText.slice(0, 300) }, { status: res.status });
  }
  const data = await res.json();
  return NextResponse.json({ success: true, id: data.id });
}
