export type AdminMetricsWindow = "24h" | "7d" | "30d" | "90d" | "all";

const WINDOW_MS: Record<Exclude<AdminMetricsWindow, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export function parseAdminMetricsWindow(value: string | null | undefined): AdminMetricsWindow {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "24h") return "24h";
  if (normalized === "7d") return "7d";
  if (normalized === "90d") return "90d";
  if (normalized === "all") return "all";
  return "30d";
}

export function resolveAdminMetricsWindowStart(window: AdminMetricsWindow): Date | null {
  if (window === "all") return null;
  const ms = WINDOW_MS[window];
  return new Date(Date.now() - ms);
}

export function parsePositiveInt(
  value: string | null | undefined,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = bounds?.min ?? 1;
  const max = bounds?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, parsed));
}

export function computeP95(input: number[]): number {
  const values = input
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .sort((left, right) => left - right);
  if (!values.length) return 0;
  const rank = Math.ceil(values.length * 0.95) - 1;
  return Math.round(values[Math.max(0, Math.min(values.length - 1, rank))]);
}

export function roundMetric(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const precision = Math.pow(10, digits);
  return Math.round(value * precision) / precision;
}

export function computeTokensPerSecond(totalTokens: number, totalElapsedMs: number): number {
  const safeTokens = Math.max(0, Number(totalTokens || 0));
  const safeElapsed = Math.max(0, Number(totalElapsedMs || 0));
  if (safeTokens <= 0 || safeElapsed <= 0) return 0;
  return roundMetric(safeTokens / (safeElapsed / 1000), 3);
}
