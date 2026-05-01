"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, BookOpen, ClipboardList, Scale, Search, Users } from "lucide-react";

interface AdminShellProps {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  {
    href: "/admin/dashboard",
    label: "Общий дашборд",
    icon: BarChart3,
    activePrefixes: ["/admin/dashboard"],
  },
  {
    href: "/admin/users",
    label: "Пользователи",
    icon: Users,
    activePrefixes: ["/admin/users"],
  },
  {
    href: "/admin/analyses",
    label: "Анализы",
    icon: ClipboardList,
    activePrefixes: ["/admin/analyses"],
  },
  {
    href: "/admin/books",
    label: "Книги",
    icon: BookOpen,
    activePrefixes: ["/admin/books"],
  },
  {
    href: "/admin/book-search",
    label: "Поиск по книге",
    icon: Search,
    activePrefixes: ["/admin/book-search"],
  },
  {
    href: "/admin/copyright-complaints",
    label: "Жалобы правообладателей",
    icon: Scale,
    activePrefixes: ["/admin/copyright-complaints"],
  },
] as const;

function isActivePath(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname();

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-[1500px] px-4 py-6 md:px-6">
        <div className="mb-5 rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Admin</p>
          <h1 className="mt-1 text-xl text-foreground">Управление платформой</h1>
        </div>

        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="h-fit rounded-xl border border-border bg-card p-2 lg:sticky lg:top-4">
            <nav className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const active = isActivePath(pathname, item.activePrefixes);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </aside>

          <section className="min-w-0">{children}</section>
        </div>
      </div>
    </div>
  );
}
