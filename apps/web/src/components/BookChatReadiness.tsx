"use client";

import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import type { BookAnalyzerStateDTO, BookChatModeDTO, BookChatReadinessDTO } from "@/lib/books";

interface ChatReadinessGateProps {
  readiness: BookChatReadinessDTO;
  compact?: boolean;
}

interface ChatReadinessBannerProps {
  readiness: BookChatReadinessDTO;
  compact?: boolean;
}

interface ChatModePillProps {
  mode: BookChatModeDTO | null;
  confidence?: "high" | "medium" | "low" | null;
  compact?: boolean;
}

function resolveStateLabel(state: BookAnalyzerStateDTO): string {
  if (state === "completed") return "Готово";
  if (state === "failed") return "Ошибка";
  if (state === "running") return "В работе";
  if (state === "queued") return "В очереди";
  return "Ожидает";
}

function renderStateIcon(state: BookAnalyzerStateDTO) {
  if (state === "completed") return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  if (state === "failed") return <AlertTriangle className="w-4 h-4 text-amber-500" />;
  if (state === "running") return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
  if (state === "queued") return <Clock3 className="w-4 h-4 text-primary" />;
  return <Clock3 className="w-4 h-4 text-muted-foreground" />;
}

function resolveBannerTone(mode: BookChatReadinessDTO["mode"]): string {
  if (mode === "expert") return "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
  if (mode === "degraded") return "border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300";
  return "border-primary/20 bg-primary/5 text-foreground";
}

function resolveModeLabel(mode: BookChatModeDTO | null): string | null {
  if (mode === "expert") return "Экспертный режим";
  if (mode === "degraded") return "Ограниченный режим";
  if (mode === "fast") return "Быстрый режим";
  return null;
}

function resolveConfidenceLabel(confidence: "high" | "medium" | "low" | null | undefined): string | null {
  if (confidence === "high") return "Уверенность: высокая";
  if (confidence === "medium") return "Уверенность: средняя";
  if (confidence === "low") return "Уверенность: низкая";
  return null;
}

export function ChatReadinessGate({ readiness, compact = false }: ChatReadinessGateProps) {
  const completedStages = readiness.stages.filter((stage) => stage.state === "completed").length;

  return (
    <div className={`rounded-2xl border border-border bg-card ${compact ? "p-4" : "p-6 lg:p-8"}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-primary/10 p-2">
          <Loader2 className={`text-primary animate-spin ${compact ? "w-4 h-4" : "w-5 h-5"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-foreground ${compact ? "text-sm" : "text-lg"}`}>Чат подготавливается</div>
          <p className={`mt-1 text-muted-foreground ${compact ? "text-xs leading-5" : "text-sm leading-6"}`}>{readiness.summary}</p>
          <div className={`mt-2 text-muted-foreground ${compact ? "text-[11px]" : "text-xs"}`}>
            Готово {completedStages} из {readiness.stages.length}
          </div>
        </div>
      </div>

      <div className={`mt-4 ${compact ? "space-y-2" : "space-y-2.5"}`}>
        {readiness.stages.map((stage) => (
          <div
            key={stage.key}
            className={`flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/70 ${compact ? "px-3 py-2" : "px-4 py-3"}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {renderStateIcon(stage.state)}
              <div className="min-w-0">
                <div className={`truncate text-foreground ${compact ? "text-xs" : "text-sm"}`}>{stage.label}</div>
                {stage.error ? <div className="mt-0.5 text-[11px] text-destructive">{stage.error}</div> : null}
              </div>
            </div>
            <div className={`shrink-0 text-muted-foreground ${compact ? "text-[10px]" : "text-xs"}`}>{resolveStateLabel(stage.state)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChatReadinessBanner({ readiness, compact = false }: ChatReadinessBannerProps) {
  if (!readiness.canChat) return null;

  return (
    <div className={`rounded-xl border ${resolveBannerTone(readiness.mode)} ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <div className={`font-medium ${compact ? "text-xs" : "text-sm"}`}>{readiness.summary}</div>
      <div className={`mt-1 text-muted-foreground ${compact ? "text-[11px] leading-5" : "text-xs leading-5"}`}>
        {readiness.mode === "expert"
          ? "Все основные слои книги готовы и используются в ответах."
          : readiness.mode === "degraded"
            ? "Ответы остаются быстрыми, но глубокий слой знаний собран не полностью."
            : "Можно спрашивать уже сейчас: чат ответит быстро и автоматически станет глубже, когда core достроится."}
      </div>
    </div>
  );
}

export function ChatModePill({ mode, confidence, compact = false }: ChatModePillProps) {
  const modeLabel = resolveModeLabel(mode);
  const confidenceLabel = resolveConfidenceLabel(confidence);
  if (!modeLabel && !confidenceLabel) return null;

  const pillClass = compact ? "px-2 py-1 text-[10px]" : "px-2.5 py-1 text-[11px]";

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {modeLabel ? <span className={`rounded-full border border-border bg-background text-muted-foreground ${pillClass}`}>{modeLabel}</span> : null}
      {confidenceLabel ? (
        <span className={`rounded-full border border-border bg-background text-muted-foreground ${pillClass}`}>{confidenceLabel}</span>
      ) : null}
    </div>
  );
}
