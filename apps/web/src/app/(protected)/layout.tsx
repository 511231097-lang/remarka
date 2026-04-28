import { redirect } from "next/navigation";
import { resolveAuthUser } from "@/lib/authUser";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  return <>{children}</>;
}
