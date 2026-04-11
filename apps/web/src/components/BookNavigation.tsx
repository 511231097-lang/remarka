"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { BookOpen, Users, Lightbulb, Quote, Search, MapPin } from "lucide-react";

export function BookNavigation() {
  const params = useParams<{ bookId: string }>();
  const pathname = usePathname();
  const bookId = String(params.bookId || "");

  const navItems = [
    { name: "Обзор", href: `/book/${bookId}`, icon: BookOpen },
    { name: "Персонажи", href: `/book/${bookId}/characters`, icon: Users },
    { name: "Темы", href: `/book/${bookId}/themes`, icon: Lightbulb },
    { name: "Локации", href: `/book/${bookId}/locations`, icon: MapPin },
    { name: "Цитаты", href: `/book/${bookId}/quotes`, icon: Quote },
    { name: "Поиск", href: `/book/${bookId}/search`, icon: Search },
  ];

  const isActive = (href: string) => pathname === href;

  return (
    <nav className="border-b border-border bg-card mb-8 sticky top-16 lg:top-0 z-30">
      <div className="max-w-6xl mx-auto px-4 lg:px-6">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 px-3 lg:px-4 py-4 border-b-2 transition-colors whitespace-nowrap ${
                isActive(item.href)
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <item.icon className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm hidden sm:inline">{item.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
