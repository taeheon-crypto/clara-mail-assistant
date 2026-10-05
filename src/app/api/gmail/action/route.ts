import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function POST(req: Request) {
  const session = await auth();
  if (!session || (session as any).error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const accessToken = (session as any).accessToken as string;

  const { action, gmailId, senderEmail } = await req.json();
  if (!action) return NextResponse.json({ error: "missing_action" }, { status: 400 });

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  async function modify(addLabelIds: string[] = [], removeLabelIds: string[] = []) {
    return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}/modify`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  let res: Response;

  switch (action) {
    case "archive":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify([], ["INBOX"]);
      break;
    case "star":
    case "unstar":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = action === "star" ? await modify(["STARRED"], []) : await modify([], ["STARRED"]);
      break;
    case "trash":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}/trash`, {
        method: "POST",
        headers: authHeaders,
      });
      break;
    case "markRead":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify([], ["UNREAD"]);
      break;
    case "markUnread":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify(["UNREAD"], []);
      break;
    case "important":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify(["IMPORTANT"], []);
      break;
    case "unimportant":
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify([], ["IMPORTANT"]);
      break;
    case "spam":
      // 스팸 신고: Gmail의 실제 "스팸 신고"와 동일하게 SPAM 라벨 추가 + 받은편지함에서 제거
      if (!gmailId) return NextResponse.json({ error: "missing_gmailId" }, { status: 400 });
      res = await modify(["SPAM"], ["INBOX"]);
      break;
    case "block":
      // 발신자 차단: Gmail 필터를 생성해서 그 발신자의 앞으로 받을 메일을 자동으로 건너뛰고 휴지통으로 보냄
      if (!senderEmail) return NextResponse.json({ error: "missing_senderEmail" }, { status: 400 });
      res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/settings/filters", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          criteria: { from: senderEmail },
          action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] },
        }),
      });
      break;
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ error: "gmail_action_failed", detail: errText.slice(0, 300) }, { status: res.status });
  }

  return NextResponse.json({ success: true });
}
