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
  isAuthenticated?: boolean;
}

function isChatPath(pathname: string): boolean {
  return /^\/book\/[^/]+\/chat(?:\/[^/]+)?\/?$/.test(pathname);
}

export function AppChrome({
  children,
  userName = null,
  userImage = null,
  userRole = null,
  isAuthenticated = false,
}: AppChromeProps) {
  const pathname = usePathname();
  const chatRoute = isChatPath(pathname || "");

  // TEMPORARY: until the subscription model exists, treat every authenticated
  // user as Plus so the design's plan-pill, upload, and analysis flows are
  // testable end-to-end. Replace with real `User.plan` resolution when the
  // billing backend is wired up.
  const plan: "free" | "plus" = "plus";

  return (
    <div className="page">
      <SiteHeader
        userName={userName}
        userImage={userImage}
        userRole={userRole}
        plan={plan}
        isAuthenticated={isAuthenticated}
      />
      <main className="grow">{children}</main>
      {!chatRoute && <SiteFooter isAuthenticated={isAuthenticated} />}
    </div>
  );
}
