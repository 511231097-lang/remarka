import { redirect } from "next/navigation";
import { UploadFlow } from "@/components/UploadFlow";
import { resolveAuthUser } from "@/lib/authUser";

export default async function UploadPage() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  return <UploadFlow />;
}
