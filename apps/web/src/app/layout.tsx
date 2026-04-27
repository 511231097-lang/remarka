import type { Metadata } from "next";
import "@/styles/index.css";
import { ThemeProvider } from "@/lib/ThemeContext";
import { AppChrome } from "@/components/AppChrome";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import { resolveAuthUser } from "@/lib/authUser";

export const metadata: Metadata = {
  title: "ремарка.",
  description: "AI-чат с книгами",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  const userName = authUser?.name?.trim() || authUser?.email || null;

  return (
    <html lang="ru">
      <body className="bg-background text-foreground">
        <ThemeProvider>
          <AppChrome userName={userName} userImage={authUser?.image || null} userRole={authUser?.role || null}>
            {children}
          </AppChrome>
          <CookieConsentBanner />
        </ThemeProvider>
      </body>
    </html>
  );
}
