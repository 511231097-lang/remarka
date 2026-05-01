"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, formatIso, formatInt } from "@/components/admin/adminClientUtils";

type ComplaintStatus = "new" | "under_review" | "accepted" | "rejected" | "counter_received";
type ClaimantType = "rightsholder" | "authorized_person" | "org_representative";

const STATUS_OPTIONS: Array<{ value: ComplaintStatus; label: string; hint: string }> = [
  { value: "new", label: "Новая", hint: "Заявление поступило, ещё не разбирали." },
  { value: "under_review", label: "На рассмотрении", hint: "Проверяем основания и материал." },
  { value: "accepted", label: "Удовлетворена", hint: "Жалоба принята, материал ограничен." },
  { value: "rejected", label: "Отклонена", hint: "Жалоба не обоснована или неполна." },
  {
    value: "counter_received",
    label: "Встречное обращение",
    hint: "Пользователь оспорил блокировку — нужен повторный разбор.",
  },
];

const CLAIMANT_TYPE_LABEL: Record<ClaimantType, string> = {
  rightsholder: "Правообладатель лично",
  authorized_person: "Доверенное лицо",
  org_representative: "Представитель организации",
};

interface AttachmentRecord {
  index: number;
  storageProvider: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

interface ComplaintResponse {
  id: string;
  status: ComplaintStatus;
  claimantType: ClaimantType;
  claimantName: string;
  claimantOrganization: string | null;
  claimantEmail: string;
  workTitle: string;
  disputedUrls: string;
  rightsBasis: string;
  powerOfAttorneyDetails: string | null;
  description: string;
  swornStatementHash: string;
  swornStatementLabel: string;
  attachments: AttachmentRecord[];
  ipAddress: string | null;
  userAgent: string | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function AdminCopyrightComplaintDetailPage({ complaintId }: { complaintId: string }) {
  const [data, setData] = useState<ComplaintResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState<ComplaintStatus>("new");
  const [reviewerNotes, setReviewerNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    void fetchJson<ComplaintResponse>(`/api/admin/copyright-complaints/${complaintId}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
        setStatus(payload.status);
        setReviewerNotes(payload.reviewerNotes || "");
      })
      .catch((reason) => {
        if (!active) return;
        setLoadError(reason instanceof Error ? reason.message : "Не удалось загрузить заявление");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [complaintId]);

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);

    try {
      const updated = await fetchJson<ComplaintResponse>(
        `/api/admin/copyright-complaints/${complaintId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status,
            reviewerNotes: reviewerNotes.trim() || null,
          }),
        },
      );

      // Refetch to pick up reviewedAt/By updates
      const refreshed = await fetchJson<ComplaintResponse>(
        `/api/admin/copyright-complaints/${complaintId}`,
      );
      setData(refreshed);
      setStatus(refreshed.status);
      setReviewerNotes(refreshed.reviewerNotes || "");
      setSaveOk(true);
      void updated;
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <Link
          href="/admin/copyright-complaints"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Все заявления
        </Link>
        <h2 className="mt-2 text-xl text-foreground">Заявление #{complaintId}</h2>
        {data ? (
          <p className="text-sm text-muted-foreground">
            Получено: {formatIso(data.createdAt)}
            {data.reviewedAt ? ` · Последнее ревью: ${formatIso(data.reviewedAt)}` : null}
          </p>
        ) : null}
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}

      {data ? (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-base text-foreground">Заявитель</h3>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label="Тип" value={CLAIMANT_TYPE_LABEL[data.claimantType]} />
              <Field label="Ф.И.О." value={data.claimantName} />
              <Field label="Организация" value={data.claimantOrganization || "—"} />
              <Field label="E-mail" value={data.claimantEmail} mono />
              <Field label="IP" value={data.ipAddress || "—"} mono />
              <Field label="User agent" value={data.userAgent || "—"} mono small />
            </dl>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-base text-foreground">Спорный материал</h3>
            <dl className="mt-3 space-y-3">
              <Field label="Произведение" value={data.workTitle} />
              <Field label="URL / bookId" value={data.disputedUrls} preserve />
              <Field label="Основание прав" value={data.rightsBasis} preserve />
              {data.powerOfAttorneyDetails ? (
                <Field label="Реквизиты доверенности" value={data.powerOfAttorneyDetails} preserve />
              ) : null}
              <Field label="Описание нарушения" value={data.description} preserve />
            </dl>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-base text-foreground">Подтверждение добросовестности</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Заявитель подтвердил текст редакции{" "}
              <span className="font-mono">{data.swornStatementLabel}</span>. SHA-256 текста:{" "}
              <span className="font-mono">{data.swornStatementHash.slice(0, 16)}…</span>
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-base text-foreground">Вложения</h3>
            {data.attachments.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Заявитель не приложил файлов.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.attachments.map((att) => (
                  <li
                    key={att.index}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-foreground">{att.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(att.sizeBytes)} · {att.mimeType} · sha256{" "}
                        <span className="font-mono">{att.sha256.slice(0, 12)}…</span>
                      </p>
                    </div>
                    <a
                      href={`/api/admin/copyright-complaints/${complaintId}/attachments/${att.index}`}
                      className="ml-3 inline-flex shrink-0 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-secondary"
                    >
                      Скачать
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Всего: {formatInt(data.attachments.length)}. Дополнительные документы могут
              приходить на abuse@remarka.app со ссылкой на номер заявки.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-base text-foreground">Решение</h3>
            <div className="mt-3 grid gap-3">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Статус
                </p>
                <div className="grid gap-2">
                  {STATUS_OPTIONS.map((option) => {
                    const checked = status === option.value;
                    return (
                      <label
                        key={option.value}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                          checked ? "border-foreground bg-secondary" : "border-border"
                        }`}
                      >
                        <input
                          type="radio"
                          name="status"
                          value={option.value}
                          checked={checked}
                          onChange={() => setStatus(option.value)}
                          className="mt-1"
                        />
                        <span className="flex-1 text-sm">
                          <span className="text-foreground">{option.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {option.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Заметки ревьюера (только для админов)
                </p>
                <textarea
                  rows={4}
                  value={reviewerNotes}
                  onChange={(event) => setReviewerNotes(event.target.value)}
                  placeholder="Что проверили, к каким выводам пришли, какие документы запросили дополнительно…"
                  maxLength={8_000}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </div>

              {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
              {saveOk ? <p className="text-sm text-foreground">Сохранено.</p> : null}

              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-secondary disabled:opacity-50"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  {saving ? "Сохраняем…" : "Сохранить решение"}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  small,
  preserve,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  preserve?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 text-foreground ${mono ? "font-mono" : ""} ${small ? "text-xs" : "text-sm"}`}
        style={preserve ? { whiteSpace: "pre-wrap", wordBreak: "break-word" } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
