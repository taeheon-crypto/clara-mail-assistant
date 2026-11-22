import { redirect } from "next/navigation";
import { auth } from "@/auth";

export async function GET() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  redirect("/app.html");
}
