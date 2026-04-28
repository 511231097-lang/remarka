"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  WINDOW_OPTIONS,
  displayUserName,
  fetchJson,
  formatInt,
  formatMs,
  formatUsd,
} from "@/components/admin/adminClientUtils";

type Role = "user" | "admin";

interface UsersResponse {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    name: string | null;
    email: string | null;
    role: Role;
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
  }>;
}

export function AdminUsersPage() {
  const [window, setWindow] = useState<AdminMetricsWindow>("30d");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleUpdateError, setRoleUpdateError] = useState<string | null>(null);
  const [roleUpdatingUserId, setRoleUpdatingUserId] = useState<string | null>(null);

  const apiQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("window", window);
    params.set("page", String(page));
    params.set("pageSize", "20");
    if (query.trim()) params.set("q", query.trim());
    return params.toString();
  }, [window, page, query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<UsersResponse>(`/api/admin/users?${apiQuery}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить пользователей");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [apiQuery]);

  async function updateRole(userId: string, role: Role) {
    setRoleUpdateError(null);
    setRoleUpdatingUserId(userId);

    try {
      await fetchJson(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ role }),
      });

      const refreshed = await fetchJson<UsersResponse>(`/api/admin/users?${apiQuery}`);
      setData(refreshed);
    } catch (reason) {
      setRoleUpdateError(reason instanceof Error ? reason.message : "Не удалось обновить роль");
    } finally {
      setRoleUpdatingUserId(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl text-foreground">Пользователи</h2>
            <p className="text-sm text-muted-foreground">Роли, расходы, скорость, книги и чаты.</p>
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
              placeholder="Поиск по имени/email"
              className="w-64 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>
      </section>

      {roleUpdateError ? <p className="text-sm text-destructive">{roleUpdateError}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">Пользователь</th>
                  <th className="py-2 pr-3">Роль</th>
                  <th className="py-2 pr-3">Книги / чаты</th>
                  <th className="py-2 pr-3">Analysis</th>
                  <th className="py-2 pr-3">Chat</th>
                  <th className="py-2 pr-3">Детали</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <tr key={user.id} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-3">
                      <p className="text-foreground">{displayUserName(user)}</p>
                      <p className="text-xs text-muted-foreground">{user.email || "-"}</p>
                      <p className="text-xs text-muted-foreground">id: {user.id}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <select
                        value={user.role}
                        onChange={(event) => void updateRole(user.id, event.target.value as Role)}
                        disabled={roleUpdatingUserId === user.id}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-60"
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="py-3 pr-3 text-xs text-foreground">
                      {formatInt(user.counts.books)} / {formatInt(user.counts.chatThreads)}
                    </td>
                    <td className="py-3 pr-3 text-xs text-foreground">
                      <p>runs: {formatInt(user.analysis.runs)}</p>
                      <p>tokens: {formatInt(user.analysis.tokens.total)}</p>
                      <p>cost: {formatUsd(user.analysis.costUsd)}</p>
                      <p>avg: {formatMs(user.analysis.speed.avgMs)}</p>
                    </td>
                    <td className="py-3 pr-3 text-xs text-foreground">
                      <p>turns: {formatInt(user.chat.turns)}</p>
                      <p>tokens: {formatInt(user.chat.tokens.total)}</p>
                      <p>cost: {formatUsd(user.chat.costUsd)}</p>
                      <p>avg: {formatMs(user.chat.speed.avgMs)}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <Link
                        href={`/admin/users/${user.id}?window=${window}`}
                        className="inline-flex rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-secondary"
                      >
                        Открыть
                      </Link>
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
