"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  WINDOW_OPTIONS,
  displayUserName,
  fetchJson,
  formatInt,
  formatIso,
  formatMs,
  formatUsd,
} from "@/components/admin/adminClientUtils";

interface UserDetailResponse {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    role: "user" | "admin";
    tier: "free" | "plus";
    tierActivatedAt: string | null;
    createdAt: string;
    counts: {
      books: number;
      chatThreads: number;
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
  };
  books: Array<{
    id: string;
    title: string;
    author: string | null;
    analysisStatus: string;
    isPublic: boolean;
    createdAt: string;
    analysis: {
      runs: number;
      tokens: {
        total: number;
      };
      costUsd: number;
    };
    chat: {
      turns: number;
      tokens: {
        total: number;
      };
      costUsd: number;
    };
  }>;
  chats: Array<{
    id: string;
    title: string;
    bookId: string;
    bookTitle: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
    chat: {
      turns: number;
      tokens: {
        total: number;
      };
      costUsd: number;
    };
  }>;
}

interface ChatMessagesResponse {
  thread: {
    id: string;
    title: string;
    bookId: string;
    bookTitle: string;
    owner: {
      id: string;
      name: string | null;
      email: string | null;
      role: "user" | "admin";
    };
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  };
  limit: number;
  items: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    turnMetric: {
      modelInputTokens: number;
      modelOutputTokens: number;
      modelTotalTokens: number;
      embeddingInputTokens: number;
      totalCostUsd: number;
      totalLatencyMs: number;
    } | null;
    createdAt: string;
  }>;
}

interface AdminUserDetailPageProps {
  userId: string;
  initialWindow: AdminMetricsWindow;
}

export function AdminUserDetailPage({ userId, initialWindow }: AdminUserDetailPageProps) {
  const [window, setWindow] = useState<AdminMetricsWindow>(initialWindow);

  const [detail, setDetail] = useState<UserDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessagesResponse | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const [tierUpdating, setTierUpdating] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);

  const handleTierChange = async (nextTier: "free" | "plus") => {
    if (!detail) return;
    if (detail.user.tier === nextTier) return;
    if (tierUpdating) return;
    const verb = nextTier === "plus" ? "перевести на Plus" : "вернуть на Free";
    // `window` is shadowed in this component by state of the same name —
    // use globalThis to reach the browser-window confirm dialog.
    if (!globalThis.confirm(`Точно ${verb} пользователя ${detail.user.email || detail.user.id}?`)) {
      return;
    }
    setTierUpdating(true);
    setTierError(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}/tier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: nextTier }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        user: { tier: "free" | "plus"; tierActivatedAt: string | null };
      };
      // Optimistically patch detail in state — saves a re-fetch.
      setDetail((current) =>
        current
          ? {
              ...current,
              user: {
                ...current.user,
                tier: data.user.tier,
                tierActivatedAt: data.user.tierActivatedAt,
              },
            }
          : current
      );
    } catch (err) {
      setTierError(err instanceof Error ? err.message : "Не удалось изменить тариф");
    } finally {
      setTierUpdating(false);
    }
  };

  const detailQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("window", window);
    params.set("bookLimit", "50");
    params.set("chatLimit", "50");
    return params.toString();
  }, [window]);

  useEffect(() => {
    let active = true;
    setDetailLoading(true);
    setDetailError(null);

    void fetchJson<UserDetailResponse>(`/api/admin/users/${userId}?${detailQuery}`)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setSelectedThreadId((current) => {
          if (!payload.chats.length) return null;
          if (current && payload.chats.some((chat) => chat.id === current)) {
            return current;
          }
          return payload.chats[0].id;
        });
      })
      .catch((reason) => {
        if (!active) return;
        setDetailError(reason instanceof Error ? reason.message : "Не удалось загрузить детали пользователя");
      })
      .finally(() => {
        if (!active) return;
        setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId, detailQuery]);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages(null);
      setMessagesLoading(false);
      setMessagesError(null);
      return;
    }

    let active = true;
    setMessagesLoading(true);
    setMessagesError(null);

    void fetchJson<ChatMessagesResponse>(`/api/admin/chats/${selectedThreadId}/messages?limit=300`)
      .then((payload) => {
        if (!active) return;
        setMessages(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setMessagesError(reason instanceof Error ? reason.message : "Не удалось загрузить сообщения чата");
      })
      .finally(() => {
        if (!active) return;
        setMessagesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedThreadId]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl text-foreground">Детали пользователя</h2>
            <p className="text-sm text-muted-foreground">Книги и чаты в режиме read-only.</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={window}
              onChange={(event) => setWindow(event.target.value as AdminMetricsWindow)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {WINDOW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {detailLoading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {detailError ? <p className="text-sm text-destructive">{detailError}</p> : null}

      {detail ? (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <p className="text-lg text-foreground">{displayUserName(detail.user)}</p>
            <p className="text-sm text-muted-foreground">{detail.user.email || "-"}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
                role: {detail.user.role}
              </div>
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
                книги: {formatInt(detail.user.counts.books)} | чаты: {formatInt(detail.user.counts.chatThreads)}
              </div>
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
                analysis: {formatInt(detail.user.analysis.tokens.total)} токенов • {formatUsd(detail.user.analysis.costUsd)}
              </div>
              <div className="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
                chat: {formatInt(detail.user.chat.tokens.total)} токенов • {formatUsd(detail.user.chat.costUsd)}
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
              <div className="text-sm text-foreground">
                <span className="text-muted-foreground">Тариф:</span>{" "}
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    detail.user.tier === "plus"
                      ? "bg-emerald-600/20 text-emerald-300"
                      : "bg-slate-600/20 text-slate-300"
                  }`}
                >
                  {detail.user.tier === "plus" ? "Plus" : "Free"}
                </span>
                {detail.user.tier === "plus" && detail.user.tierActivatedAt ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    активирован {formatIso(detail.user.tierActivatedAt)}
                  </span>
                ) : null}
                <span className="ml-2 text-xs text-muted-foreground">
                  · регистрация {formatIso(detail.user.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {detail.user.tier === "free" ? (
                  <button
                    type="button"
                    onClick={() => void handleTierChange("plus")}
                    disabled={tierUpdating}
                    className="rounded-md border border-emerald-500 bg-emerald-600/20 px-3 py-1.5 text-sm text-emerald-300 transition hover:bg-emerald-600/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {tierUpdating ? "Применяю…" : "Перевести на Plus"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleTierChange("free")}
                    disabled={tierUpdating}
                    className="rounded-md border border-amber-500 bg-amber-600/20 px-3 py-1.5 text-sm text-amber-300 transition hover:bg-amber-600/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {tierUpdating ? "Применяю…" : "Вернуть на Free"}
                  </button>
                )}
              </div>
            </div>
            {tierError ? (
              <p className="mt-2 text-sm text-destructive">{tierError}</p>
            ) : null}
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm text-foreground">Книги</h3>
              <div className="mt-3 space-y-2">
                {detail.books.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Нет книг.</p>
                ) : (
                  detail.books.map((book) => (
                    <div key={book.id} className="rounded-lg border border-border/70 bg-background p-3">
                      <p className="text-sm text-foreground">{book.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {book.author || "Автор не указан"} • {book.analysisStatus} • {book.isPublic ? "public" : "private"}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatIso(book.createdAt)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        analysis {formatInt(book.analysis.tokens.total)} токенов / {formatUsd(book.analysis.costUsd)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        chat {formatInt(book.chat.tokens.total)} токенов / {formatUsd(book.chat.costUsd)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm text-foreground">Чаты пользователя</h3>
              <div className="mt-3 space-y-2">
                {detail.chats.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Нет чатов.</p>
                ) : (
                  detail.chats.map((chat) => {
                    const active = selectedThreadId === chat.id;
                    return (
                      <button
                        key={chat.id}
                        onClick={() => setSelectedThreadId(chat.id)}
                        className={`block w-full rounded-lg border p-3 text-left transition-colors ${
                          active
                            ? "border-primary bg-secondary text-foreground"
                            : "border-border/70 bg-background text-foreground hover:bg-secondary/50"
                        }`}
                      >
                        <p className="text-sm">{chat.title}</p>
                        <p className="text-xs text-muted-foreground">
                          Книга: {chat.bookTitle} • сообщений: {formatInt(chat.messageCount)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatIso(chat.updatedAt)} • turns {formatInt(chat.chat.turns)} • {formatUsd(chat.chat.costUsd)}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm text-foreground">Сообщения чата (read-only)</h3>
              {messages?.thread ? (
                <p className="text-xs text-muted-foreground">
                  {messages.thread.title} • {messages.thread.bookTitle}
                </p>
              ) : null}
            </div>

            {messagesLoading ? <p className="mt-3 text-sm text-muted-foreground">Загрузка сообщений...</p> : null}
            {messagesError ? <p className="mt-3 text-sm text-destructive">{messagesError}</p> : null}

            {!messagesLoading && messages ? (
              <div className="mt-3 space-y-2">
                {messages.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Нет сообщений.</p>
                ) : (
                  messages.items.map((message) => (
                    <div key={message.id} className="rounded-lg border border-border/70 bg-background p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span
                          className={`rounded px-2 py-0.5 ${
                            message.role === "assistant"
                              ? "bg-emerald-600/20 text-emerald-300"
                              : "bg-slate-600/20 text-slate-300"
                          }`}
                        >
                          {message.role}
                        </span>
                        <span>{formatIso(message.createdAt)}</span>
                        {message.turnMetric ? (
                          <span>
                            {formatInt(message.turnMetric.modelInputTokens)} in / {formatInt(message.turnMetric.modelOutputTokens)} out
                            • {formatMs(message.turnMetric.totalLatencyMs)} • {formatUsd(message.turnMetric.totalCostUsd)}
                          </span>
                        ) : null}
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{message.content}</pre>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
