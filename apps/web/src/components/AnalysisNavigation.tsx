"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import {
  AlertCircle,
  BookMarked,
  CheckCircle,
  ChevronDown,
  FileText,
  Lightbulb,
  MapPin,
  Palette,
  Swords,
  User,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

export function AnalysisNavigation() {
  const params = useParams<{ bookId: string }>();
  const pathname = usePathname();
  const bookId = String(params.bookId || "");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = useMemo(
    () => [
      { name: "Что на самом деле происходит", href: `/book/${bookId}/what-is-really-going-on`, icon: FileText },
      { name: "Главная идея", href: `/book/${bookId}/main-idea`, icon: Lightbulb },
      { name: "Как это работает", href: `/book/${bookId}/how-it-works`, icon: BookMarked },
      { name: "Скрытые детали", href: `/book/${bookId}/hidden-details`, icon: User },
      { name: "Персонажи", href: `/book/${bookId}/characters`, icon: Users },
      { name: "Конфликты", href: `/book/${bookId}/conflicts`, icon: Swords },
      { name: "Структура", href: `/book/${bookId}/structure`, icon: MapPin },
      { name: "Важные повороты", href: `/book/${bookId}/important-turns`, icon: Palette },
      { name: "Что важно вынести", href: `/book/${bookId}/takeaways`, icon: AlertCircle },
      { name: "Вывод", href: `/book/${bookId}/conclusion`, icon: CheckCircle },
    ],
    [bookId]
  );

  const isActive = (href: string) => pathname === href;
  const currentSection = navItems.find((item) => isActive(item.href));

  return (
    <>
      <div className="xl:hidden mb-6 sticky top-16 z-20 bg-background pb-4">
        <button
          onClick={() => setIsMobileMenuOpen((value) => !value)}
          className="w-full flex items-center justify-between px-4 py-3 bg-card border border-border rounded-lg text-foreground"
        >
          <div className="flex items-center gap-3">
            {currentSection ? <currentSection.icon className="w-4 h-4 text-primary" /> : null}
            <span className="text-sm">{currentSection?.name || "Выберите раздел"}</span>
          </div>
          <ChevronDown className={`w-4 h-4 transition-transform ${isMobileMenuOpen ? "rotate-180" : ""}`} />
        </button>

        {isMobileMenuOpen ? (
          <div className="absolute top-full left-0 right-0 mt-2 bg-card border border-border rounded-lg shadow-lg overflow-hidden z-30">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setIsMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  isActive(item.href)
                    ? "bg-primary/10 text-primary border-l-2 border-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span className="text-sm">{item.name}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <nav className="hidden xl:block w-56 flex-shrink-0">
        <div className="sticky top-24">
          <div className="space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  isActive(item.href)
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span className="text-sm">{item.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </nav>
    </>
  );
}
