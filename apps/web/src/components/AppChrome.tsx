"use client";

import { usePathname } from "next/navigation";
import type { UserRole, UserTier } from "@prisma/client";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

interface AppChromeProps {
  children: React.ReactNode;
  userName?: string | null;
  userImage?: string | null;
  userRole?: UserRole | null;
  // Authenticated user's subscription tier — drives the "Plus" pill in the
  // header. null for anonymous viewers (footer-only chrome).
  userTier?: UserTier | null;
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
  userTier = null,
  isAuthenticated = false,
}: AppChromeProps) {
  const pathname = usePathname();
  const chatRoute = isChatPath(pathname || "");

  // Sourced from `User.tier` via resolveAuthUser in the root layout.
  // Falls back to "free" for safety — the header treats free as the
  // default (no Plus pill, "Перейти на Плюс" CTA shown).
  const plan: "free" | "plus" = userTier === "plus" ? "plus" : "free";

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
