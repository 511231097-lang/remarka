"use client";

import { usePathname } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

interface AppChromeProps {
  children: React.ReactNode;
  userName?: string | null;
  userImage?: string | null;
  userRole?: UserRole | null;
}

function isChatPath(pathname: string): boolean {
  return /^\/book\/[^/]+\/chat(?:\/[^/]+)?\/?$/.test(pathname);
}

export function AppChrome({
  children,
  userName = null,
  userImage = null,
  userRole = null,
}: AppChromeProps) {
  const pathname = usePathname();
  const chatRoute = isChatPath(pathname || "");

  // TEMPORARY: until the subscription model exists, treat admin users as Plus
  // so the design's pill renders for the dev/owner. Everyone else is Free.
  // Replace with real plan resolution from User.plan when wired up.
  const plan: "free" | "plus" = userRole === "admin" ? "plus" : "free";

  return (
    <div className="page">
      <SiteHeader userName={userName} userImage={userImage} userRole={userRole} plan={plan} />
      <main className="grow">{children}</main>
      {!chatRoute && <SiteFooter />}
    </div>
  );
}
