import { redirect } from "next/navigation";
import { Library } from "@/components/Library";
import { resolveAuthUser } from "@/lib/authUser";

export default async function LibraryPage() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }
  return <Library tier={authUser.tier} />;
}
