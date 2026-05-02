import { redirect } from "next/navigation";
import { UploadFlow } from "@/components/UploadFlow";
import { resolveAuthUser } from "@/lib/authUser";

export default async function UploadPage() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  // Tariff gate: book uploads are Plus-only. Free users get bounced to
  // /library with `?paywall=upload` so the existing PaywallModal opens
  // automatically (Library reads that query param on mount).
  if (authUser.tier !== "plus") {
    redirect("/library?paywall=upload");
  }

  return <UploadFlow />;
}
