import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { resolveAuthUser } from "@/lib/authUser";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }
  if (authUser.role !== "admin") {
    redirect("/explore");
  }

  return <AdminShell>{children}</AdminShell>;
}
