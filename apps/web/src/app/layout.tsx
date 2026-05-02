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

const themeInitScript = `
(() => {
  try {
    const saved = localStorage.getItem("remarka-theme") || localStorage.getItem("theme") || "auto";
    const mode = saved === "light" || saved === "dark" || saved === "auto" ? saved : "auto";
    const effective = mode === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : mode;
    document.documentElement.setAttribute("data-theme", effective);
    document.documentElement.setAttribute("data-theme-mode", mode);
    document.documentElement.classList.toggle("dark", effective === "dark");
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-theme-mode", "auto");
  }
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authUser = await resolveAuthUser();
  const userName = authUser?.name?.trim() || authUser?.email || null;

  return (
    <html lang="ru">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-background text-foreground">
        <ThemeProvider>
          <AppChrome
            userName={userName}
            userImage={authUser?.image || null}
            userRole={authUser?.role || null}
            userTier={authUser?.tier || null}
            isAuthenticated={Boolean(authUser)}
          >
            {children}
          </AppChrome>
          <CookieConsentBanner />
        </ThemeProvider>
      </body>
    </html>
  );
}
