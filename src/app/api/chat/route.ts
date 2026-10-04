import { NextResponse } from "next/server";
import { auth } from "@/auth";

// OpenRouter에서 제공하는 모델 — 필요시 교체 가능
const MODEL = "anthropic/claude-sonnet-4.5";

// 프런트(원본 app.html)는 Anthropic Messages API 형태로 요청/응답을 기대함
// ({model, max_tokens, system, messages} → {content:[{text}]})
// 그 형태를 그대로 받아 내부적으로 OpenRouter(OpenAI 호환) 포맷으로 변환해 호출한다.
export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { message: "로그인이 필요합니다." } }, { status: 401 });
  }

  const body = await req.json();
  const { system, messages, max_tokens } = body;

  const openaiMessages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...(messages || []).map((m: any) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Clara Mail Assistant",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: max_tokens || 1024,
      messages: openaiMessages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json(
      { error: { message: `OpenRouter 오류 (${res.status}): ${errText.slice(0, 200)}` } },
      { status: res.status }
    );
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";

  // 원본 프런트의 파싱 코드(d.content?.[0]?.text)와 호환되는 형태로 반환
  return NextResponse.json({ content: [{ text }] });
}
