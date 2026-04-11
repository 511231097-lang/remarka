"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  BookOpen,
  Compass,
  Library as LibraryIcon,
  Heart,
  LogOut,
  Crown,
  CreditCard,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { UserAvatar } from "@/components/UserAvatar";

interface LayoutProps {
  children: React.ReactNode;
  userName: string;
  userImage?: string | null;
  isPlusPlan?: boolean;
}

export function Layout({
  children,
  userName,
  userImage = null,
  isPlusPlan = true,
}: LayoutProps) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navigation = [
    { name: "Каталог", href: "/explore", icon: Compass },
    { name: "Мои книги", href: "/library", icon: LibraryIcon },
    { name: "Избранное", href: "/favorites", icon: Heart },
  ];

  const isActive = (path: string) => pathname === path;

  const handleLogout = () => {
    void signOut({ callbackUrl: "/signin" });
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-background flex">
      <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-card border-b border-border z-40 flex items-center px-4">
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="p-2 rounded-lg hover:bg-secondary transition-colors"
        >
          <Menu className="w-6 h-6 text-foreground" />
        </button>
        <Link href="/explore" className="ml-4 flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-primary-foreground" />
          </div>
          <span
            className="text-lg text-foreground"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Литанализ
          </span>
        </Link>
      </header>

      {isMobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={closeMobileMenu}
        />
      )}

      <aside
        className={`w-64 bg-card border-r border-border flex flex-col fixed left-0 top-0 bottom-0 z-50 transition-transform lg:translate-x-0 ${
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-border flex items-center justify-between">
          <Link
            href="/explore"
            className="flex items-center gap-3"
            onClick={closeMobileMenu}
          >
            <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-primary-foreground" />
            </div>
            <span
              className="text-lg text-foreground"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Литанализ
            </span>
          </Link>
          <button
            onClick={closeMobileMenu}
            className="lg:hidden p-2 rounded-lg hover:bg-secondary transition-colors"
          >
            <X className="w-5 h-5 text-foreground" />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeMobileMenu}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                isActive(item.href)
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">{item.name}</span>
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-border space-y-1">
          <Link
            href="/plans"
            onClick={closeMobileMenu}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              isActive("/plans")
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            }`}
          >
            <CreditCard className="w-5 h-5" />
            <span className="text-sm">Тарифы</span>
          </Link>

          <div className="relative">
            <Link
              href="/profile"
              onClick={closeMobileMenu}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors pr-12 ${
                isActive("/profile")
                  ? "bg-secondary text-foreground"
                  : "hover:bg-secondary/50"
              }`}
            >
              <UserAvatar
                name={userName}
                image={userImage}
                size="xs"
                fallbackTextClassName="text-xs"
              />
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate text-foreground">{userName}</p>
                {isPlusPlan && (
                  <div className="flex items-center gap-1 text-xs text-primary">
                    <Crown className="w-3 h-3" />
                    <span>Плюс</span>
                  </div>
                )}
              </div>
            </Link>

            <button
              onClick={handleLogout}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary/50 transition-colors"
              title="Выйти"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 lg:ml-64 overflow-auto pt-16 lg:pt-0">
        {children}
      </main>
    </div>
  );
}
