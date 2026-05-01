"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchJson, formatIso, formatInt } from "@/components/admin/adminClientUtils";

type ComplaintStatus = "new" | "under_review" | "accepted" | "rejected" | "counter_received";
type ClaimantType = "rightsholder" | "authorized_person" | "org_representative";

const STATUS_FILTER_OPTIONS: Array<{ value: "all" | ComplaintStatus; label: string }> = [
  { value: "all", label: "Все" },
  { value: "new", label: "Новые" },
  { value: "under_review", label: "На рассмотрении" },
  { value: "accepted", label: "Удовлетворены" },
  { value: "rejected", label: "Отклонены" },
  { value: "counter_received", label: "Встречные обращения" },
];

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  new: "Новая",
  under_review: "На рассмотрении",
  accepted: "Удовлетворена",
  rejected: "Отклонена",
  counter_received: "Встречное обращение",
};

const CLAIMANT_TYPE_LABEL: Record<ClaimantType, string> = {
  rightsholder: "Правообладатель",
  authorized_person: "Доверенное лицо",
  org_representative: "Представитель организации",
};

const STATUS_BADGE_COLOR: Record<ComplaintStatus, string> = {
  new: "rgb(217, 119, 6)",
  under_review: "rgb(37, 99, 235)",
  accepted: "rgb(22, 163, 74)",
  rejected: "rgb(107, 114, 128)",
  counter_received: "rgb(168, 85, 247)",
};

interface ListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    status: ComplaintStatus;
    claimantType: ClaimantType;
    claimantName: string;
    claimantOrganization: string | null;
    claimantEmail: string;
    workTitle: string;
    createdAt: string;
    reviewedAt: string | null;
    attachmentCount: number;
  }>;
}

export function AdminCopyrightComplaintsPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | ComplaintStatus>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (query.trim()) params.set("q", query.trim());
    params.set("page", String(page));
    params.set("pageSize", "20");
    return params.toString();
  }, [statusFilter, query, page]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<ListResponse>(`/api/admin/copyright-complaints?${apiQuery}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить заявления");
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
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl text-foreground">Жалобы правообладателей</h2>
            <p className="text-sm text-muted-foreground">
              Заявления по процедуре ст. 1253.1 ГК РФ. Срок рассмотрения — до 10 рабочих дней,
              блокировка по очевидно обоснованным — до 24 часов.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as "all" | ComplaintStatus);
                setPage(1);
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Поиск по email, имени, произведению"
              className="w-72 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <section className="rounded-xl border border-border bg-card p-4">
          {data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Заявлений нет.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3">Заявитель</th>
                    <th className="py-2 pr-3">Тип</th>
                    <th className="py-2 pr-3">Произведение</th>
                    <th className="py-2 pr-3">Статус</th>
                    <th className="py-2 pr-3">Файлы</th>
                    <th className="py-2 pr-3">Получено</th>
                    <th className="py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-border/60 align-top">
                      <td className="py-3 pr-3">
                        <p className="text-foreground">{item.claimantName}</p>
                        <p className="text-xs text-muted-foreground">{item.claimantEmail}</p>
                        {item.claimantOrganization ? (
                          <p className="text-xs text-muted-foreground">
                            {item.claimantOrganization}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-3 text-xs text-foreground">
                        {CLAIMANT_TYPE_LABEL[item.claimantType]}
                      </td>
                      <td className="py-3 pr-3 text-foreground">
                        <p className="line-clamp-2">{item.workTitle}</p>
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs"
                          style={{
                            background: `${STATUS_BADGE_COLOR[item.status]}1A`,
                            color: STATUS_BADGE_COLOR[item.status],
                          }}
                        >
                          {STATUS_LABEL[item.status]}
                        </span>
                      </td>
                      <td className="py-3 pr-3 text-xs text-foreground">
                        {item.attachmentCount > 0 ? formatInt(item.attachmentCount) : "—"}
                      </td>
                      <td className="py-3 pr-3 text-xs text-muted-foreground">
                        {formatIso(item.createdAt)}
                      </td>
                      <td className="py-3 pr-3">
                        <Link
                          href={`/admin/copyright-complaints/${item.id}`}
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
          )}

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
