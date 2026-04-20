import type { Metadata } from "next";
import "@/styles/index.css";
import { ThemeProvider } from "@/lib/ThemeContext";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { resolveAuthUser } from "@/lib/authUser";

export const metadata: Metadata = {
  title: "Литанализ",
  description: "AI Literary Analysis App",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  const userName = authUser?.name?.trim() || authUser?.email || null;

  return (
    <html lang="ru">
      <body className="bg-background text-foreground">
        <ThemeProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader userName={userName} userImage={authUser?.image || null} userRole={authUser?.role || null} />
            <div className="app-content flex min-h-0 flex-1 flex-col">{children}</div>
            <SiteFooter />
          </div>
          <CookieConsentBanner />
        </ThemeProvider>
      </body>
    </html>
  );
}
