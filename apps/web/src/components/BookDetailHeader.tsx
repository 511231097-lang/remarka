"use client";

import Link from "next/link";
import { ArrowLeft, BookOpenText, MessageSquareText } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
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

const TAB_BASE_STYLE: CSSProperties = {
  alignItems: "center",
  borderRadius: 999,
  display: "inline-flex",
  fontFamily: "inherit",
  fontSize: 14,
  gap: 8,
  padding: "8px 16px",
  textDecoration: "none",
  transition: "all .15s",
};

function resolveTabStyle(isActive: boolean): CSSProperties {
  return {
    ...TAB_BASE_STYLE,
    background: isActive ? "var(--ink)" : "transparent",
    color: isActive ? "var(--paper)" : "var(--ink-muted)",
  };
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        marginBottom: 32,
      }}
    >
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <Link
          href={backTarget.href}
          className="lnk"
          style={{
            alignItems: "center",
            color: "var(--ink-muted)",
            display: "inline-flex",
            fontSize: 14,
            gap: 8,
            textDecoration: "none",
          }}
        >
          <ArrowLeft size={16} />
          {backTarget.label}
        </Link>

        {action ? <div className="row-sm" style={{ alignItems: "center" }}>{action}</div> : null}
      </div>

      <div
        role="tablist"
        style={{
          alignItems: "center",
          background: "var(--paper-2)",
          border: "1px solid var(--rule)",
          borderRadius: 999,
          display: "inline-flex",
          gap: 4,
          padding: 4,
          width: "fit-content",
        }}
      >
        <Link
          href={overviewHref}
          role="tab"
          aria-selected={activeTab === "overview"}
          style={resolveTabStyle(activeTab === "overview")}
        >
          <BookOpenText size={14} />
          Обзор
        </Link>
        <Link
          href={chatHref}
          role="tab"
          aria-selected={activeTab === "chat"}
          style={resolveTabStyle(activeTab === "chat")}
        >
          <MessageSquareText size={14} />
          Чат
        </Link>
      </div>
    </div>
  );
}
