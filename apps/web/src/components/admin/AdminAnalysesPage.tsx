"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  ANALYSIS_STATE_OPTIONS,
  WINDOW_OPTIONS,
  displayUserName,
  fetchJson,
  formatInt,
  formatIso,
  formatMs,
  formatUsd,
} from "@/components/admin/adminClientUtils";

interface AnalysesResponse {
  total: number;
  page: number;
  pageSize: number;
  state: (typeof ANALYSIS_STATE_OPTIONS)[number];
  statusCounts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    superseded: number;
  };
  items: Array<{
    id: string;
    attempt: number;
    state: "queued" | "running" | "completed" | "failed" | "superseded";
    currentStageKey: string | null;
    error: string | null;
    extractModel: string | null;
    chatModel: string | null;
    embeddingModel: string | null;
    tokens: {
      llmPrompt: number;
      llmCompletion: number;
      llmTotal: number;
      embeddingInput: number;
      embeddingTotal: number;
      total: number;
    };
    costUsd: {
      llm: number;
      embedding: number;
      total: number;
    };
    totalElapsedMs: number;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    book: {
      id: string;
      title: string;
      author: string | null;
      analysisStatus: string;
    };
    owner: {
      id: string;
      name: string | null;
      email: string | null;
      role: "user" | "admin";
    };
  }>;
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  queued: "bg-slate-600/20 text-slate-300",
  running: "bg-sky-600/20 text-sky-300",
  completed: "bg-emerald-600/20 text-emerald-300",
  failed: "bg-red-600/20 text-red-300",
  superseded: "bg-amber-600/20 text-amber-300",
};

export function AdminAnalysesPage() {
  const [window, setWindow] = useState<AdminMetricsWindow>("30d");
  const [state, setState] = useState<(typeof ANALYSIS_STATE_OPTIONS)[number]>("all");
  const [query, setQuery] = useState("");
  const [userId, setUserId] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<AnalysesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("window", window);
    params.set("page", String(page));
    params.set("pageSize", "20");
    params.set("state", state);
    if (query.trim()) params.set("q", query.trim());
    if (userId.trim()) params.set("userId", userId.trim());
    return params.toString();
  }, [window, page, state, query, userId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<AnalysesResponse>(`/api/admin/analyses?${apiQuery}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить анализы");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [apiQuery]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl text-foreground">Анализы и статусы</h2>
            <p className="text-sm text-muted-foreground">Запуски анализа по пользователям и книгам.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={window}
              onChange={(event) => {
                setWindow(event.target.value as AdminMetricsWindow);
                setPage(1);
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {WINDOW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select
              value={state}
              onChange={(event) => {
                setState(event.target.value as (typeof ANALYSIS_STATE_OPTIONS)[number]);
                setPage(1);
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {ANALYSIS_STATE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Поиск: run/book/model/email"
              className="w-64 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
                setPage(1);
              }}
              placeholder="userId"
              className="w-64 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-border bg-card p-3 text-sm text-foreground">
              queued: {formatInt(data.statusCounts.queued)}
            </div>
            <div className="rounded-xl border border-border bg-card p-3 text-sm text-foreground">
              running: {formatInt(data.statusCounts.running)}
            </div>
            <div className="rounded-xl border border-border bg-card p-3 text-sm text-foreground">
              completed: {formatInt(data.statusCounts.completed)}
            </div>
            <div className="rounded-xl border border-border bg-card p-3 text-sm text-foreground">
              failed: {formatInt(data.statusCounts.failed)}
            </div>
            <div className="rounded-xl border border-border bg-card p-3 text-sm text-foreground">
              superseded: {formatInt(data.statusCounts.superseded)}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1560px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-left uppercase text-muted-foreground">
                    <th className="py-2 pr-2">Run</th>
                    <th className="py-2 pr-2">Статус</th>
                    <th className="py-2 pr-2">Пользователь</th>
                    <th className="py-2 pr-2">Книга</th>
                    <th className="py-2 pr-2">Модели</th>
                    <th className="py-2 pr-2">Токены</th>
                    <th className="py-2 pr-2">Стоимость</th>
                    <th className="py-2 pr-2">Время</th>
                    <th className="py-2 pr-2">Ошибка</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-2 text-foreground">
                        <p>{item.id}</p>
                        <p className="text-muted-foreground">attempt {item.attempt}</p>
                        <p className="text-muted-foreground">{formatIso(item.createdAt)}</p>
                      </td>
                      <td className="py-2 pr-2">
                        <span className={`rounded px-2 py-0.5 ${STATUS_BADGE_CLASS[item.state] || "bg-slate-600/20 text-slate-300"}`}>
                          {item.state}
                        </span>
                        <p className="mt-1 text-muted-foreground">{item.currentStageKey || "-"}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>{displayUserName(item.owner)}</p>
                        <p className="text-muted-foreground">{item.owner.email || "-"}</p>
                        <p className="text-muted-foreground">{item.owner.id}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>{item.book.title}</p>
                        <p className="text-muted-foreground">{item.book.author || "Автор не указан"}</p>
                        <p className="text-muted-foreground">status {item.book.analysisStatus}</p>
                        <p className="text-muted-foreground">book {item.book.id}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>extract: {item.extractModel || "-"}</p>
                        <p>chat: {item.chatModel || "-"}</p>
                        <p>embedding: {item.embeddingModel || "-"}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>llm in/out: {formatInt(item.tokens.llmPrompt)} / {formatInt(item.tokens.llmCompletion)}</p>
                        <p>llm total: {formatInt(item.tokens.llmTotal)}</p>
                        <p>emb in: {formatInt(item.tokens.embeddingInput)}</p>
                        <p>total: {formatInt(item.tokens.total)}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>llm: {formatUsd(item.costUsd.llm)}</p>
                        <p>emb: {formatUsd(item.costUsd.embedding)}</p>
                        <p>total: {formatUsd(item.costUsd.total)}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p>{formatMs(item.totalElapsedMs)}</p>
                        <p className="text-muted-foreground">start: {item.startedAt ? formatIso(item.startedAt) : "-"}</p>
                        <p className="text-muted-foreground">end: {item.completedAt ? formatIso(item.completedAt) : "-"}</p>
                      </td>
                      <td className="py-2 pr-2 text-foreground">
                        <p className="max-w-[260px] whitespace-pre-wrap break-words text-red-300">{item.error || "-"}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Всего: {formatInt(data.total)} | Страница {data.page}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={data.page <= 1}
                  className="rounded-md border border-border px-3 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  Назад
                </button>
                <button
                  onClick={() => setPage((value) => value + 1)}
                  disabled={data.page * data.pageSize >= data.total}
                  className="rounded-md border border-border px-3 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  Вперед
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
