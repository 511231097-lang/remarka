import type { Prisma } from "@prisma/client";

export interface BookAnalyzerTaskMetadata {
  attempts?: number;
  deferredReason?: string | null;
  selectedModel?: string | null;
  models?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  degraded?: boolean;
  fallbackKind?: string | null;
  lastValidationError?: string | null;
  lastReason?: string | null;
  entityMentionCount?: number;
  entitiesWithMentionsRate?: number;
  resolvedQuoteMentionRate?: number;
  resolvedMembershipRate?: number;
  entityEvidenceCoverage?: number;
  degradedEntitySummaryRate?: number;
}

export interface StrictJsonAttemptUsageLike {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}

export interface StrictJsonAttemptLike {
  model?: string | null;
  usage?: StrictJsonAttemptUsageLike | null;
  error?: string | null;
  success?: boolean;
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(value: string | null | undefined, maxChars: number): string | null {
  const text = compactWhitespace(value || "");
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function toNonNegativeInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function toUnitInterval(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeStringList(value: unknown, limit: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = clampText(String(item || ""), maxChars);
    if (!normalized || seen.has(normalized)) continue;
    out.push(normalized);
    seen.add(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function parseBookAnalyzerTaskMetadata(value: unknown): BookAnalyzerTaskMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    attempts: toNonNegativeInt(record.attempts),
    deferredReason: clampText(String(record.deferredReason || ""), 500),
    selectedModel: clampText(String(record.selectedModel || ""), 200),
    models: normalizeStringList(record.models, 8, 200),
    promptTokens: toNonNegativeInt(record.promptTokens),
    completionTokens: toNonNegativeInt(record.completionTokens),
    totalTokens: toNonNegativeInt(record.totalTokens),
    degraded: record.degraded === true,
    fallbackKind: clampText(String(record.fallbackKind || ""), 200),
    lastValidationError: clampText(String(record.lastValidationError || ""), 2000),
    lastReason: clampText(String(record.lastReason || ""), 2000),
    entityMentionCount: toNonNegativeInt(record.entityMentionCount),
    entitiesWithMentionsRate: toUnitInterval(record.entitiesWithMentionsRate),
    resolvedQuoteMentionRate: toUnitInterval(record.resolvedQuoteMentionRate),
    resolvedMembershipRate: toUnitInterval(record.resolvedMembershipRate),
    entityEvidenceCoverage: toUnitInterval(record.entityEvidenceCoverage),
    degradedEntitySummaryRate: toUnitInterval(record.degradedEntitySummaryRate),
  };
}

export function mergeBookAnalyzerTaskMetadata(
  current: unknown,
  patch: Partial<BookAnalyzerTaskMetadata>
): Prisma.InputJsonValue | null {
  const next: BookAnalyzerTaskMetadata = {
    ...parseBookAnalyzerTaskMetadata(current),
  };

  if (patch.attempts !== undefined) next.attempts = Math.max(0, Math.floor(Number(patch.attempts) || 0));
  if (patch.deferredReason !== undefined) next.deferredReason = clampText(patch.deferredReason, 500);
  if (patch.selectedModel !== undefined) next.selectedModel = clampText(patch.selectedModel, 200);
  if (patch.models !== undefined) next.models = normalizeStringList(patch.models, 8, 200);
  if (patch.promptTokens !== undefined) next.promptTokens = Math.max(0, Math.floor(Number(patch.promptTokens) || 0));
  if (patch.completionTokens !== undefined) next.completionTokens = Math.max(0, Math.floor(Number(patch.completionTokens) || 0));
  if (patch.totalTokens !== undefined) next.totalTokens = Math.max(0, Math.floor(Number(patch.totalTokens) || 0));
  if (patch.degraded !== undefined) next.degraded = patch.degraded === true;
  if (patch.fallbackKind !== undefined) next.fallbackKind = clampText(patch.fallbackKind, 200);
  if (patch.lastValidationError !== undefined) next.lastValidationError = clampText(patch.lastValidationError, 2000);
  if (patch.lastReason !== undefined) next.lastReason = clampText(patch.lastReason, 2000);
  if (patch.entityMentionCount !== undefined) next.entityMentionCount = Math.max(0, Math.floor(Number(patch.entityMentionCount) || 0));
  if (patch.entitiesWithMentionsRate !== undefined) next.entitiesWithMentionsRate = toUnitInterval(patch.entitiesWithMentionsRate);
  if (patch.resolvedQuoteMentionRate !== undefined) next.resolvedQuoteMentionRate = toUnitInterval(patch.resolvedQuoteMentionRate);
  if (patch.resolvedMembershipRate !== undefined) next.resolvedMembershipRate = toUnitInterval(patch.resolvedMembershipRate);
  if (patch.entityEvidenceCoverage !== undefined) next.entityEvidenceCoverage = toUnitInterval(patch.entityEvidenceCoverage);
  if (patch.degradedEntitySummaryRate !== undefined) next.degradedEntitySummaryRate = toUnitInterval(patch.degradedEntitySummaryRate);

  const models = normalizeStringList(next.models, 8, 200);
  next.models = models.length > 0 ? models : undefined;

  const normalized: Record<string, unknown> = {};
  if (typeof next.attempts === "number") normalized.attempts = next.attempts;
  if (next.deferredReason) normalized.deferredReason = next.deferredReason;
  if (next.selectedModel) normalized.selectedModel = next.selectedModel;
  if (next.models?.length) normalized.models = next.models;
  if (typeof next.promptTokens === "number") normalized.promptTokens = next.promptTokens;
  if (typeof next.completionTokens === "number") normalized.completionTokens = next.completionTokens;
  if (typeof next.totalTokens === "number") normalized.totalTokens = next.totalTokens;
  if (next.degraded === true) normalized.degraded = true;
  if (next.fallbackKind) normalized.fallbackKind = next.fallbackKind;
  if (next.lastValidationError) normalized.lastValidationError = next.lastValidationError;
  if (next.lastReason) normalized.lastReason = next.lastReason;
  if (typeof next.entityMentionCount === "number") normalized.entityMentionCount = next.entityMentionCount;
  if (typeof next.entitiesWithMentionsRate === "number") normalized.entitiesWithMentionsRate = next.entitiesWithMentionsRate;
  if (typeof next.resolvedQuoteMentionRate === "number") normalized.resolvedQuoteMentionRate = next.resolvedQuoteMentionRate;
  if (typeof next.resolvedMembershipRate === "number") normalized.resolvedMembershipRate = next.resolvedMembershipRate;
  if (typeof next.entityEvidenceCoverage === "number") normalized.entityEvidenceCoverage = next.entityEvidenceCoverage;
  if (typeof next.degradedEntitySummaryRate === "number") normalized.degradedEntitySummaryRate = next.degradedEntitySummaryRate;

  return Object.keys(normalized).length > 0 ? (normalized as Prisma.InputJsonValue) : null;
}

export function applyStrictJsonAttemptToTaskMetadata(
  current: Partial<BookAnalyzerTaskMetadata>,
  attempt: StrictJsonAttemptLike
): Partial<BookAnalyzerTaskMetadata> {
  const next: Partial<BookAnalyzerTaskMetadata> = {
    ...current,
  };

  next.attempts = Math.max(0, Math.floor(Number(next.attempts || 0))) + 1;

  const promptTokens = Math.max(0, Math.floor(Number(attempt.usage?.promptTokens || 0)));
  const completionTokens = Math.max(0, Math.floor(Number(attempt.usage?.completionTokens || 0)));
  const totalTokens = Math.max(
    0,
    Math.floor(
      Number(
        attempt.usage?.totalTokens ||
          promptTokens + completionTokens
      )
    )
  );

  next.promptTokens = Math.max(0, Math.floor(Number(next.promptTokens || 0))) + promptTokens;
  next.completionTokens = Math.max(0, Math.floor(Number(next.completionTokens || 0))) + completionTokens;
  next.totalTokens = Math.max(0, Math.floor(Number(next.totalTokens || 0))) + totalTokens;

  const model = clampText(attempt.model, 200);
  if (model) {
    next.selectedModel = model;
    next.models = normalizeStringList([...(next.models || []), model], 8, 200);
  }

  const error = clampText(attempt.error, 2000);
  if (error) {
    next.lastReason = error;
    if (attempt.success === false) {
      next.lastValidationError = error;
    }
  }

  return next;
}
