import { signOut } from "@/auth";

export async function GET() {
  await signOut({ redirectTo: "/" });
  return undefined as never;
}
