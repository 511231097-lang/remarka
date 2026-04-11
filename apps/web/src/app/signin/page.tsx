import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { SignIn } from "@/components/SignIn";
import { authOptions } from "@/auth";

export default async function SignInPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    redirect("/explore");
  }
  return <SignIn />;
}
