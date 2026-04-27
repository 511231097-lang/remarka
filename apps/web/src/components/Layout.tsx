"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { BookOpen, LogIn, LogOut } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { UserAvatar } from "@/components/UserAvatar";

interface LayoutProps {
  children: React.ReactNode;
  userName?: string | null;
  userImage?: string | null;
  userRole?: UserRole;
}

export function Layout({
  children,
  userName = null,
  userImage = null,
  userRole = "user",
}: LayoutProps) {
  const pathname = usePathname();
  const normalizedUserName = userName?.trim() || null;
  const isAuthenticated = Boolean(normalizedUserName);

  const navigation = [
    { name: "Каталог", href: "/explore" },
    { name: "Мои книги", href: "/library" },
    { name: "Тарифы", href: "/plans" },
    ...(userRole === "admin" ? [{ name: "Админка", href: "/admin/dashboard" }] : []),
  ];

  const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

  const handleLogout = () => {
    void signOut({ callbackUrl: "/signin" });
  };

  const navItemClass = (path: string) =>
    `inline-flex items-center rounded-lg px-3 py-2 text-sm transition-colors ${
      isActive(path)
        ? "bg-secondary text-foreground"
        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
    }`;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/90">
        <div className="mx-auto px-4 sm:px-6">
          <div className="grid h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <Link
              href="/explore"
              className="flex items-center gap-3 justify-self-start"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary">
                <BookOpen className="h-5 w-5 text-primary-foreground" />
              </div>
              <span
                className="text-base text-foreground sm:text-lg"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                ремарка.
              </span>
            </Link>

            <nav className="hidden items-center gap-1 justify-self-center md:flex">
              {navigation.map((item) => (
                <Link key={item.href} href={item.href} className={navItemClass(item.href)}>
                  {item.name}
                </Link>
              ))}
            </nav>

            <div className="flex items-center gap-2 justify-self-end">
              {isAuthenticated ? (
                <>
                  <Link
                    href="/profile"
                    className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                      isActive("/profile")
                        ? "bg-secondary text-foreground"
                        : "hover:bg-secondary/60"
                    }`}
                  >
                    <UserAvatar
                      name={normalizedUserName || "Пользователь"}
                      image={userImage}
                      size="xxs"
                      fallbackTextClassName="text-[10px]"
                    />
                    <span className="hidden max-w-[140px] truncate text-sm text-foreground sm:block">
                      {normalizedUserName}
                    </span>
                  </Link>

                  <button
                    onClick={handleLogout}
                    className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-destructive"
                    title="Выйти"
                  >
                    <LogOut className="h-4 w-4" />
                    <span className="hidden lg:inline">Выйти</span>
                  </button>
                </>
              ) : (
                <Link
                  href="/signin"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-secondary/60"
                >
                  <LogIn className="h-4 w-4" />
                  <span>Войти</span>
                </Link>
              )}
            </div>
          </div>
        </div>

        <nav className="border-t border-border/70 px-3 py-2 md:hidden">
          <div className="flex items-center gap-1 overflow-x-auto">
            {navigation.map((item) => (
              <Link key={item.href} href={item.href} className={navItemClass(item.href)}>
                {item.name}
              </Link>
            ))}
          </div>
        </nav>
      </header>

      <main>{children}</main>
    </div>
  );
}
