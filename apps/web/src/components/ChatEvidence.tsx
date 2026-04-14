"use client";

import type { BookChatEvidenceDTO } from "@/lib/books";

interface ChatEvidenceProps {
  evidence: BookChatEvidenceDTO[];
  maxItems?: number;
  compact?: boolean;
}

function resolveKindLabel(kind: BookChatEvidenceDTO["kind"]): string {
  if (kind === "scene") return "Сцена";
  if (kind === "event") return "Событие";
  if (kind === "relation") return "Связь";
  if (kind === "summary_artifact") return "Сводка";
  if (kind === "quote") return "Цитата";
  if (kind === "chapter_span") return "Фрагмент";
  if (kind === "character") return "Персонаж";
  if (kind === "theme") return "Тема";
  if (kind === "location") return "Локация";
  return "Раздел анализа";
}

export function ChatEvidence({ evidence, maxItems = 4, compact = false }: ChatEvidenceProps) {
  const items = evidence.slice(0, maxItems);
  if (items.length === 0) return null;

  return (
    <div className={`mt-4 rounded-xl border border-border/70 bg-background/70 ${compact ? "p-2.5" : "p-3.5"}`}>
      <div className={`text-muted-foreground ${compact ? "text-[10px]" : "text-xs"}`}>На чем основан ответ</div>
      <div className={compact ? "mt-2 space-y-2" : "mt-2 space-y-2.5"}>
        {items.map((item) => (
          <div key={`${item.kind}:${item.sourceId}`} className="rounded-lg border border-border/60 bg-card/70 px-3 py-2">
            <div className={`text-muted-foreground ${compact ? "text-[10px]" : "text-[11px]"}`}>
              {resolveKindLabel(item.kind)}
              {item.label ? ` · ${item.label}` : ""}
              {item.chapterOrderIndex ? ` · Глава ${item.chapterOrderIndex}` : ""}
            </div>
            <div className={`mt-1 text-foreground ${compact ? "text-[11px] leading-5" : "text-sm leading-6"}`}>
              {item.snippet}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
