import { redirect } from "next/navigation";
import { auth } from "@/auth";
import LoginCard from "./LoginCard";

export default async function LoginPage() {
  const session = await auth();

  if (session) {
    redirect("/app.html");
  }

  return <LoginCard />;
}
