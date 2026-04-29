"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Moon, Sparkles, Sun } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { useTheme } from "@/lib/ThemeContext";

interface SiteHeaderProps {
  userName?: string | null;
  userImage?: string | null;
  userRole?: UserRole | null;
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "landing";
  if (pathname.startsWith("/explore")) return "catalog";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/plans")) return "pricing";
  if (pathname.startsWith("/legal/copyright")) return "copyright";
  if (pathname.startsWith("/admin")) return "admin";
  return "";
}

export function SiteHeader({
  userName = null,
  userImage = null,
  userRole = null,
}: SiteHeaderProps) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const normalizedUserName = userName?.trim() || null;
  const isAuthenticated = Boolean(normalizedUserName);
  const active = normalizePath(pathname || "");
  const logoHref = isAuthenticated ? "/explore" : "/";

  const items = [
    { k: "catalog", t: "Каталог", href: "/explore" },
    { k: "library", t: "Мои книги", href: "/library" },
    { k: "pricing", t: "Тарифы", href: "/plans" },
    { k: "copyright", t: "Правообладателям", href: "/legal/copyright" },
    ...(isAuthenticated && userRole === "admin"
      ? [{ k: "admin", t: "Админка", href: "/admin/dashboard" }]
      : []),
  ];

  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <Link href={logoHref} className="logo" aria-label="ремарка">
          ремарка<span className="dot">.</span>
        </Link>

        <nav className="nav-links" aria-label="Основная навигация">
          {items.map((item) => (
            <Link
              key={item.k}
              href={item.href}
              className={`nav-link ${active === item.k ? "active" : ""}`}
            >
              {item.t}
            </Link>
          ))}

          <div style={{ width: 16 }} />

          <button
            type="button"
            className="btn-plain"
            onClick={toggleTheme}
            title={theme === "light" ? "Тёмная тема" : "Светлая тема"}
            aria-label={theme === "light" ? "Включить тёмную тему" : "Включить светлую тему"}
            style={{ padding: 8, borderRadius: "var(--r-sm)" }}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>

          {isAuthenticated ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Link href="/plans" className="plan-pill plus" title="Тариф Плюс">
                <Sparkles size={14} /> Плюс
              </Link>
              <Link href="/profile" className="avatar" title="Профиль">
                {userImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={userImage} alt="" className="h-full w-full object-cover" />
                ) : (
                  normalizedUserName?.slice(0, 1).toUpperCase() || "А"
                )}
              </Link>
            </div>
          ) : (
            <Link href="/signin" className="btn btn-ghost btn-sm">
              Войти
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
