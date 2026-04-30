import { redirect } from "next/navigation";
import { UploadFlow } from "@/components/UploadFlow";
import { resolveAuthUser } from "@/lib/authUser";

export default async function UploadPage() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  // TEMPORARY: until the subscription model exists, every authenticated user
  // is treated as Plus and can hit /upload. When billing is wired up, gate
  // here on `authUser.plan !== "plus"` and redirect to `/library?paywall=upload`.

  return <UploadFlow />;
}
