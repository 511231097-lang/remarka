"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  BOOK_STATUS_OPTIONS,
  WINDOW_OPTIONS,
  displayUserName,
  fetchJson,
  formatInt,
  formatIso,
  formatMs,
  formatUsd,
} from "@/components/admin/adminClientUtils";

interface LibraryResponse {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    title: string;
    author: string | null;
    isPublic: boolean;
    analysisStatus: string;
    createdAt: string;
    owner: {
      id: string;
      name: string | null;
      email: string | null;
    };
    analysis: {
      runs: number;
      tokens: {
        total: number;
      };
      costUsd: number;
      speed: {
        avgMs: number;
      };
    };
    chat: {
      turns: number;
      tokens: {
        total: number;
      };
      costUsd: number;
      speed: {
        avgMs: number;
      };
    };
  }>;
}

export function AdminBooksPage() {
  const [window, setWindow] = useState<AdminMetricsWindow>("30d");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<(typeof BOOK_STATUS_OPTIONS)[number]>("all");
  const [ownerId, setOwnerId] = useState("");
  const [page, setPage] = useState(1);
  const [visibilityPendingIds, setVisibilityPendingIds] = useState<Set<string>>(new Set());

  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("window", window);
    params.set("page", String(page));
    params.set("pageSize", "20");
    params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    if (ownerId.trim()) params.set("ownerId", ownerId.trim());
    return params.toString();
  }, [window, page, status, query, ownerId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<LibraryResponse>(`/api/admin/library?${apiQuery}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить библиотеку");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [apiQuery]);

  const updateBookVisibility = async (bookId: string, isPublic: boolean) => {
    if (!data) return;
    if (visibilityPendingIds.has(bookId)) return;

    setVisibilityPendingIds((prev) => {
      const next = new Set(prev);
      next.add(bookId);
      return next;
    });
    setError(null);

    const prevItems = data.items;
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.id === bookId ? { ...item, isPublic } : item)),
          }
        : current
    );

    try {
      await fetchJson<{ id: string; isPublic: boolean }>(`/api/admin/books/${bookId}/visibility`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ isPublic }),
      });
    } catch (reason) {
      setData((current) => (current ? { ...current, items: prevItems } : current));
      setError(reason instanceof Error ? reason.message : "Не удалось обновить видимость книги");
    } finally {
      setVisibilityPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(bookId);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl text-foreground">Книги</h2>
            <p className="text-sm text-muted-foreground">Глобальная библиотека со статусами анализа и метриками.</p>
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
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Поиск title/author/owner"
              className="w-64 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as (typeof BOOK_STATUS_OPTIONS)[number]);
                setPage(1);
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {BOOK_STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <input
              value={ownerId}
              onChange={(event) => {
                setOwnerId(event.target.value);
                setPage(1);
              }}
              placeholder="ownerId"
              className="w-64 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1280px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left uppercase text-muted-foreground">
                  <th className="py-2 pr-2">Книга</th>
                  <th className="py-2 pr-2">Owner</th>
                  <th className="py-2 pr-2">Статус</th>
                  <th className="py-2 pr-2">Analysis</th>
                  <th className="py-2 pr-2">Chat</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((book) => (
                  <tr key={book.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-2 text-foreground">
                      <p>{book.title}</p>
                      <p className="text-muted-foreground">{book.author || "Автор не указан"}</p>
                      <p className="text-muted-foreground">{formatIso(book.createdAt)}</p>
                      <p className="text-muted-foreground">book {book.id}</p>
                      <Link
                        href={`/admin/book-search?bookId=${encodeURIComponent(book.id)}`}
                        className="mt-2 inline-flex rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                      >
                        Искать по книге
                      </Link>
                    </td>
                    <td className="py-2 pr-2 text-foreground">
                      <p>{displayUserName(book.owner)}</p>
                      <p className="text-muted-foreground">{book.owner.email || "-"}</p>
                      <p className="text-muted-foreground">owner {book.owner.id}</p>
                    </td>
                    <td className="py-2 pr-2 text-foreground">
                      <p>{book.analysisStatus}</p>
                      <p className="text-muted-foreground">{book.isPublic ? "public" : "private"}</p>
                      <button
                        onClick={() => {
                          void updateBookVisibility(book.id, !book.isPublic);
                        }}
                        disabled={visibilityPendingIds.has(book.id)}
                        className="mt-2 rounded-md border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:border-primary/40 disabled:opacity-50"
                      >
                        {visibilityPendingIds.has(book.id)
                          ? "Сохраняем..."
                          : book.isPublic
                            ? "Сделать private"
                            : "Сделать public"}
                      </button>
                    </td>
                    <td className="py-2 pr-2 text-foreground">
                      <p>runs: {formatInt(book.analysis.runs)}</p>
                      <p>tokens: {formatInt(book.analysis.tokens.total)}</p>
                      <p>cost: {formatUsd(book.analysis.costUsd)}</p>
                      <p>avg: {formatMs(book.analysis.speed.avgMs)}</p>
                    </td>
                    <td className="py-2 pr-2 text-foreground">
                      <p>turns: {formatInt(book.chat.turns)}</p>
                      <p>tokens: {formatInt(book.chat.tokens.total)}</p>
                      <p>cost: {formatUsd(book.chat.costUsd)}</p>
                      <p>avg: {formatMs(book.chat.speed.avgMs)}</p>
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
      ) : null}
    </div>
  );
}
