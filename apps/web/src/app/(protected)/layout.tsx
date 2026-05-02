import { redirect } from "next/navigation";
import { resolveAuthUser } from "@/lib/authUser";
import { EventChannelProvider } from "@/lib/events/EventChannelProvider";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    redirect("/signin");
  }

  return <EventChannelProvider>{children}</EventChannelProvider>;
}
