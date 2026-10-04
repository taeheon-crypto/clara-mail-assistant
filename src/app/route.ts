import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export async function GET() {
  const session = await auth();

  if (!session) {
    await signIn("google", { redirectTo: "/app.html" });
  }

  redirect("/app.html");
}
