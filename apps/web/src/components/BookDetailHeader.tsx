"use client";

import Link from "next/link";
import { ArrowLeft, BookOpenText, MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";
import {
  appendBookDetailSource,
  resolveBookDetailBackTarget,
  type BookDetailSource,
} from "@/lib/bookDetailNavigation";

interface BookDetailHeaderProps {
  bookId: string;
  activeTab: "overview" | "chat";
  source: BookDetailSource | null;
  fallbackSource?: BookDetailSource;
  currentSessionId?: string | null;
  action?: ReactNode;
}

function resolveTabClass(isActive: boolean): string {
  return isActive
    ? "bg-primary text-primary-foreground shadow-[0_10px_24px_rgba(124,94,71,0.22)]"
    : "text-muted-foreground hover:bg-secondary hover:text-foreground";
}

export function BookDetailHeader({
  bookId,
  activeTab,
  source,
  fallbackSource = "explore",
  currentSessionId = null,
  action,
}: BookDetailHeaderProps) {
  const backTarget = resolveBookDetailBackTarget(source, fallbackSource);
  const overviewHref = appendBookDetailSource(`/book/${bookId}`, backTarget.source);
  const chatHref = appendBookDetailSource(
    currentSessionId ? `/book/${bookId}/chat/${currentSessionId}` : `/book/${bookId}/chat`,
    backTarget.source
  );

  return (
    <div className="mb-8 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <Link
          href={backTarget.href}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {backTarget.label}
        </Link>

        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>

      <div className="inline-flex w-fit items-center gap-1 rounded-full border border-border/80 bg-card/75 p-1 shadow-[0_12px_24px_rgba(42,37,32,0.04)]">
        <Link
          href={overviewHref}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors ${resolveTabClass(activeTab === "overview")}`}
        >
          <BookOpenText className="h-4 w-4" />
          Обзор
        </Link>
        <Link
          href={chatHref}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors ${resolveTabClass(activeTab === "chat")}`}
        >
          <MessageSquareText className="h-4 w-4" />
          Чат
        </Link>
      </div>
    </div>
  );
}
