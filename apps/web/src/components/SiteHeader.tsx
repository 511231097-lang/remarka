"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Moon, Sparkles, Sun, X } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { useTheme } from "@/lib/ThemeContext";

interface SiteHeaderProps {
  userName?: string | null;
  userImage?: string | null;
  userRole?: UserRole | null;
}

interface NavItem {
  k: string;
  t: string;
  href: string;
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "landing";
  if (pathname.startsWith("/explore")) return "catalog";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/plans")) return "pricing";
  if (pathname.startsWith("/legal/copyright")) return "copyright";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/profile")) return "profile";
  return "";
}

export function SiteHeader({
  userName = null,
  userImage = null,
  userRole = null,
}: SiteHeaderProps) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close drawer on Escape, lock body scroll while open.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  // Close drawer when route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const normalizedUserName = userName?.trim() || null;
  const isAuthenticated = Boolean(normalizedUserName);
  const active = normalizePath(pathname || "");
  const logoHref = isAuthenticated ? "/explore" : "/";

  const items: NavItem[] = [
    { k: "catalog", t: "Каталог", href: "/explore" },
    { k: "library", t: "Мои книги", href: "/library" },
    { k: "pricing", t: "Тарифы", href: "/plans" },
    { k: "copyright", t: "Правообладателям", href: "/legal/copyright" },
    ...(isAuthenticated && userRole === "admin"
      ? [{ k: "admin", t: "Админка", href: "/admin/dashboard" }]
      : []),
  ];

  const drawer = (
    <div
      className={`mobile-drawer ${drawerOpen ? "open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) setDrawerOpen(false);
      }}
      aria-hidden={!drawerOpen}
    >
      <div className="mobile-drawer-panel" role="dialog" aria-label="Меню">
        <button
          type="button"
          className="mobile-drawer-close"
          onClick={() => setDrawerOpen(false)}
          aria-label="Закрыть"
        >
          <X size={18} />
        </button>

        {isAuthenticated && (
          <Link
            href="/profile"
            onClick={() => setDrawerOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 4px 18px",
              borderBottom: "1px solid var(--rule)",
              marginBottom: 10,
              textDecoration: "none",
              color: "var(--ink)",
            }}
          >
            <div className="avatar" style={{ margin: 0 }}>
              {userImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={userImage} alt="" className="h-full w-full object-cover" />
              ) : (
                normalizedUserName?.slice(0, 1).toUpperCase() || "А"
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{normalizedUserName || "Мой аккаунт"}</div>
              <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
                Тариф · Читатель
              </div>
            </div>
          </Link>
        )}

        {items.map((item) => (
          <Link
            key={item.k}
            href={item.href}
            onClick={() => setDrawerOpen(false)}
            className={`m-link ${active === item.k ? "active" : ""}`}
          >
            {item.t}
          </Link>
        ))}

        <button
          type="button"
          className="m-link"
          onClick={() => {
            toggleTheme();
            setDrawerOpen(false);
          }}
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          {theme === "light" ? "Тёмная тема" : "Светлая тема"}
        </button>

        <Link
          href="/plans"
          onClick={() => setDrawerOpen(false)}
          className="m-link"
          style={{ color: "var(--mark)", fontWeight: 500 }}
        >
          <Sparkles size={16} />
          Перейти на Плюс
        </Link>

        <div style={{ flex: 1 }} />

        {!isAuthenticated && (
          <Link
            href="/signin"
            onClick={() => setDrawerOpen(false)}
            className="btn btn-primary"
            style={{ marginTop: 14 }}
          >
            Войти
          </Link>
        )}
      </div>
    </div>
  );

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

        <button
          type="button"
          className="nav-burger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Меню"
          aria-expanded={drawerOpen}
        >
          <Menu size={20} />
        </button>
      </div>

      {mounted && createPortal(drawer, document.body)}
    </header>
  );
}
