import type { AdminMetricsWindow } from "@/lib/adminMetrics";

export const WINDOW_OPTIONS: AdminMetricsWindow[] = ["24h", "7d", "30d", "90d", "all"];
export const BOOK_STATUS_OPTIONS = ["all", "not_started", "queued", "running", "completed", "failed"] as const;
export const ANALYSIS_STATE_OPTIONS = ["all", "queued", "running", "completed", "failed", "superseded"] as const;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || "Request failed"));
  }
  return (await response.json()) as T;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.round(Number(value || 0))));
}

export function formatUsd(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  return `$${amount.toFixed(4)}`;
}

export function formatMs(value: number): string {
  return `${formatInt(value)} ms`;
}

export function formatIso(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString("ru-RU");
}

export function displayUserName(user: { name: string | null; email: string | null }): string {
  const name = String(user.name || "").trim();
  if (name) return name;
  const email = String(user.email || "").trim();
  if (email) return email;
  return "Пользователь";
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
