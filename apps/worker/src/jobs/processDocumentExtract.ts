import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@remarka/db";
import { Prisma } from "@prisma/client";
import type { MentionCandidate } from "@prisma/client";
import {
  AliasTypeSchema,
  classifyMentionTypeFromAlias,
  isPronounConfidenceAccepted,
  normalizeImportAnalysisModelId,
  normalizeEntityName,
  splitParagraphs,
  type AliasType,
  type EntityPassResult,
  type EntityType,
  type ImportAnalysisModelId,
  type MentionCandidateType,
  type MentionType,
  type MentionRouting,
  type PrepassResult,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import { getArtifactBlobStore, persistRunArtifact, type RunArtifactRecord } from "../artifactStore";
import {
  ExtractionStructuredOutputError,
  runActPass,
  runAppearancePass,
  runCharacterBookPassCanonicalization,
  runCharacterMergeArbiter,
  runCharacterProfileSynthesis,
  runEntityPass,
  runPatchCompletion,
  type StrictJsonCallDebug,
  type StrictJsonCallMeta,
} from "../extractionV2";
import { logger } from "../logger";
import { runPrepass } from "../preprocessorClient";

type Tx = Prisma.TransactionClient;

interface ProcessRunPayload {
  runId: string;
}

interface ResolvedEntity {
  id: string;
  type: EntityType;
  canonicalName: string;
  normalizedName: string;
}

interface SweepCandidate {
  id: string;
  runId: string;
  documentId: string;
  contentVersion: number;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  candidateType: MentionCandidateType;
  routing: MentionRouting;
  decisionStatus: "pending" | "accepted";
  confidence: number;
  featuresJson?: Prisma.InputJsonValue;
  conflictGroupId: string | null;
  entityHintId: string | null;
}

interface SweepMention {
  id: string;
  runId: string;
  documentId: string;
  contentVersion: number;
  entityId: string;
  candidateId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  mentionType: MentionType;
  confidence: number;
  resolvedBy: string;
}

const MENTION_TYPE_PRIORITY: Record<string, number> = {
  named: 4,
  alias: 3,
  descriptor: 2,
  pronoun: 1,
};

interface RunLlmUsagePhase {
  provider: "kia" | "timeweb" | "vertex";
  model: string;
  attempt: number;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
}

interface RunLlmUsageSummary {
  total: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  entityPass?: RunLlmUsagePhase;
  actPass?: RunLlmUsagePhase;
  appearancePass?: RunLlmUsagePhase;
  mentionCompletion?: RunLlmUsagePhase;
}

interface RunArtifactsSummary {
  entityPass: RunArtifactRecord[];
  actPass: RunArtifactRecord[];
  appearancePass: RunArtifactRecord[];
  mentionCompletion: RunArtifactRecord[];
}

type AutoRerunReason = "failed" | "quality_gate_empty";

interface AutoRerunScheduleResult {
  scheduled: boolean;
  reason: AutoRerunReason;
  attempt: number;
  maxAttempts: number;
  runId: string | null;
}

const AUTO_RERUN_IDEMPOTENCY_PREFIX = "auto-rerun";

function parseRequestedImportModelId(qualityFlags: unknown): ImportAnalysisModelId | null {
  if (!qualityFlags || typeof qualityFlags !== "object" || Array.isArray(qualityFlags)) return null;
  const root = qualityFlags as Record<string, unknown>;
  const requested = root.requestedExtractionModel;
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return null;
  const requestedRecord = requested as Record<string, unknown>;
  if (String(requestedRecord.provider || "").trim().toLowerCase() !== "timeweb") return null;
  return normalizeImportAnalysisModelId(requestedRecord.modelId);
}

function buildRequestedModelQualityFlags(modelId: ImportAnalysisModelId | null): Record<string, unknown> {
  if (!modelId) return {};
  return {
    requestedExtractionModel: {
      provider: "timeweb",
      modelId,
    },
  };
}

function createRunLlmUsageSummary(): RunLlmUsageSummary {
  return {
    total: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

function createRunArtifactsSummary(): RunArtifactsSummary {
  return {
    entityPass: [],
    actPass: [],
    appearancePass: [],
    mentionCompletion: [],
  };
}

function summarizeRunArtifacts(artifacts: RunArtifactsSummary) {
  const all = [...artifacts.entityPass, ...artifacts.actPass, ...artifacts.appearancePass, ...artifacts.mentionCompletion];
  const totalSizeBytes = all.reduce((sum, item) => sum + item.sizeBytes, 0);
  const providers = all.reduce<Record<string, number>>((bucket, item) => {
    const key = item.provider || "unknown";
    bucket[key] = (bucket[key] || 0) + 1;
    return bucket;
  }, {});

  return {
    totalCount: all.length,
    totalSizeBytes,
    providers,
    byPhase: {
      entityPass: {
        count: artifacts.entityPass.length,
        totalSizeBytes: artifacts.entityPass.reduce((sum, item) => sum + item.sizeBytes, 0),
      },
      actPass: {
        count: artifacts.actPass.length,
        totalSizeBytes: artifacts.actPass.reduce((sum, item) => sum + item.sizeBytes, 0),
      },
      appearancePass: {
        count: artifacts.appearancePass.length,
        totalSizeBytes: artifacts.appearancePass.reduce((sum, item) => sum + item.sizeBytes, 0),
      },
      mentionCompletion: {
        count: artifacts.mentionCompletion.length,
        totalSizeBytes: artifacts.mentionCompletion.reduce((sum, item) => sum + item.sizeBytes, 0),
      },
    },
  };
}

function toRunLlmUsagePhase(meta: StrictJsonCallMeta): RunLlmUsagePhase {
  const promptTokens = meta.usage?.promptTokens ?? 0;
  const completionTokens = meta.usage?.completionTokens ?? 0;
  const totalTokens = meta.usage?.totalTokens ?? promptTokens + completionTokens;

  return {
    provider: meta.provider,
    model: meta.model,
    attempt: meta.attempt,
    finishReason: meta.finishReason,
    promptTokens,
    completionTokens,
    totalTokens,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    latencyMs: meta.latencyMs,
  };
}

function registerPhaseUsage(
  usageSummary: RunLlmUsageSummary,
  phase: "entityPass" | "actPass" | "appearancePass" | "mentionCompletion",
  meta: StrictJsonCallMeta
) {
  const phaseUsage = toRunLlmUsagePhase(meta);
  usageSummary[phase] = phaseUsage;
  usageSummary.total.promptTokens += phaseUsage.promptTokens;
  usageSummary.total.completionTokens += phaseUsage.completionTokens;
  usageSummary.total.totalTokens += phaseUsage.totalTokens;
}

function hasAnyPhaseUsage(usageSummary: RunLlmUsageSummary): boolean {
  return Boolean(usageSummary.entityPass || usageSummary.actPass || usageSummary.appearancePass || usageSummary.mentionCompletion);
}

function buildExtractionFailureDebug(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ExtractionStructuredOutputError)) {
    return null;
  }

  return {
    phase: error.phase,
    provider: error.provider,
    model: error.model,
    attempt: error.attempt,
    finishReason: error.finishReason,
    usage: error.usage,
    rawResponseSnippet: error.rawResponseSnippet,
    jsonCandidateSnippet: error.jsonCandidateSnippet,
  };
}

function buildAutoRerunIdempotencyKey(params: {
  reason: AutoRerunReason;
  documentId: string;
  contentVersion: number;
  attempt: number;
}): string {
  return `${AUTO_RERUN_IDEMPOTENCY_PREFIX}:${params.reason}:${params.documentId}:${params.contentVersion}:${params.attempt}`;
}

function shouldAutoRerunForFailure(message: string): boolean {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) return true;

  const skipPatterns = [
    "version gate failed",
    "document not found",
    "contentversion mismatch",
    "run superseded",
    "entity normalizedname cannot be empty",
  ];

  return !skipPatterns.some((pattern) => normalized.includes(pattern));
}

function shouldFailQualityGate(params: {
  prepassCandidates: number;
  mentionCount: number;
  contentChars: number;
}): boolean {
  if (params.mentionCount > 0) return false;
  if (params.prepassCandidates < workerConfig.pipeline.analysisAutoRerunEmptyMinCandidates) return false;
  if (params.contentChars < workerConfig.pipeline.analysisAutoRerunEmptyMinContentChars) return false;
  return true;
}

function isWordBoundaryChar(value: string): boolean {
  return /[\p{L}\p{N}\p{M}]/u.test(value);
}

function isWholeWordMatch(haystack: string, start: number, length: number): boolean {
  const before = start > 0 ? haystack[start - 1] : "";
  const after = start + length < haystack.length ? haystack[start + length] : "";
  return (!before || !isWordBoundaryChar(before)) && (!after || !isWordBoundaryChar(after));
}

function findAllWholeWordOccurrences(text: string, needle: string): number[] {
  if (!needle) return [];

  const source = text.toLowerCase();
  const target = needle.toLowerCase();
  const result: number[] = [];
  let cursor = 0;

  while (cursor <= source.length - target.length) {
    const index = source.indexOf(target, cursor);
    if (index < 0) break;

    if (isWholeWordMatch(text, index, needle.length)) {
      result.push(index);
    }

    cursor = index + Math.max(1, target.length);
  }

  return result;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampText(value: string, maxChars: number): string {
  const text = String(value || "");
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAliasTypeSafe(value: unknown, fallback: AliasType = "name"): AliasType {
  const parsed = AliasTypeSchema.safeParse(String(value || "").trim().toLowerCase());
  return parsed.success ? parsed.data : fallback;
}

const PRONOUN_PATTERN =
  /\b(он|она|они|его|ее|её|ему|ей|их|ими|им|него|неё|ней|ним|ними|сам|сама|сами|кто-то|кто-нибудь)\b/giu;

const CATASTROPHIC_SUMMARY_FALLBACK_MIN_ENTITIES = 8;
const CHARACTER_PROFILE_BATCH_SIZE = 12;
const CHARACTER_PROFILE_EVIDENCE_PER_ENTITY = 5;
const CHARACTER_PROFILE_EVIDENCE_FETCH_LIMIT = 16;
const CHARACTER_PROFILE_CHAPTER_SUMMARIES_PER_ENTITY = 10;

function buildGenericEntitySummary(type: EntityType, canonicalName: string): string {
  const name = String(canonicalName || "").trim() || "сущность";
  if (type === "character") return `Персонаж ${name}, упоминаемый в текущей главе.`;
  if (type === "location") return `Локация ${name}, упоминаемая в текущей главе.`;
  return `Событие ${name}, отмеченное в текущей главе.`;
}

function buildContextualEntitySummary(type: EntityType, canonicalName: string, context: string | null): string {
  const name = compactWhitespace(canonicalName) || "сущность";
  const snippet = clampText(compactWhitespace(context || ""), 220);
  if (!snippet) return buildGenericEntitySummary(type, name);

  if (type === "character") return `Персонаж ${name}, упоминаемый в эпизоде: «${snippet}».`;
  if (type === "location") return `Локация ${name}, упоминаемая в эпизоде: «${snippet}».`;
  return `Событие ${name}, связанное с эпизодом: «${snippet}».`;
}

function extractContextByOffsets(content: string, startOffset: number, endOffset: number, radius = 96): string | null {
  const text = String(content || "");
  if (!text) return null;

  const safeStart = Math.max(0, Math.min(startOffset, text.length));
  const safeEnd = Math.max(safeStart, Math.min(endOffset, text.length));
  const from = Math.max(0, safeStart - radius);
  const to = Math.min(text.length, safeEnd + radius);
  const raw = text.slice(from, to);
  const compact = compactWhitespace(raw);
  return compact || null;
}

async function backfillMissingEntitySummariesForRun(params: {
  runId: string;
  content: string;
}): Promise<number> {
  const rows = await prisma.mention.findMany({
    where: {
      runId: params.runId,
      entity: {
        is: {
          summary: "",
        },
      },
    },
    select: {
      entityId: true,
      startOffset: true,
      endOffset: true,
      sourceText: true,
      entity: {
        select: {
          id: true,
          type: true,
          canonicalName: true,
        },
      },
    },
    orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
  });

  if (!rows.length) return 0;

  const updates = new Map<string, { summary: string }>();
  for (const row of rows) {
    if (!row.entity) continue;
    if (updates.has(row.entity.id)) continue;

    const context =
      extractContextByOffsets(params.content, row.startOffset, row.endOffset) ||
      compactWhitespace(row.sourceText || "") ||
      null;
    const summary = buildContextualEntitySummary(row.entity.type, row.entity.canonicalName, context);
    updates.set(row.entity.id, { summary: clampText(compactWhitespace(summary), 500) });
  }

  if (!updates.size) return 0;

  await prisma.$transaction(async (tx: Tx) => {
    for (const [entityId, payload] of updates.entries()) {
      await tx.entity.updateMany({
        where: {
          id: entityId,
          summary: "",
        },
        data: {
          summary: payload.summary,
        },
      });
    }
  });

  return updates.size;
}

function shouldRunSummaryBackfillOnCatastrophe(result: EntityPassResult): boolean {
  const total = result.entities.length;
  if (total < CATASTROPHIC_SUMMARY_FALLBACK_MIN_ENTITIES) return false;

  const nonEmpty = result.entities.reduce((count, entity) => {
    return count + (String(entity.summary || "").trim().length > 0 ? 1 : 0);
  }, 0);

  return nonEmpty === 0;
}

interface EntityPassBatchStats {
  batches: number;
  candidatesTotal: number;
  snippetsTotal: number;
  candidatesMaxPerBatch: number;
  snippetsMaxPerBatch: number;
}

function buildEntityPassBatches(prepass: PrepassResult): { batches: PrepassResult[]; stats: EntityPassBatchStats } {
  const batchCandidates = workerConfig.pipeline.entityPassBatchCandidates;
  const batchSnippetsCap = workerConfig.pipeline.entityPassBatchSnippetsCap;
  const snippetMaxChars = workerConfig.pipeline.entityPassBatchSnippetMaxChars;
  const candidateTextMaxChars = workerConfig.pipeline.entityPassBatchCandidateTextMaxChars;

  const sortedCandidates = [...prepass.candidates].sort((left, right) => {
    if (left.paragraphIndex !== right.paragraphIndex) return left.paragraphIndex - right.paragraphIndex;
    if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset;
    return left.endOffset - right.endOffset;
  });

  const snippetByParagraph = new Map<number, PrepassResult["snippets"][number]>();
  for (const snippet of prepass.snippets) {
    if (!snippetByParagraph.has(snippet.paragraphIndex)) {
      snippetByParagraph.set(snippet.paragraphIndex, {
        ...snippet,
        text: clampText(snippet.text, snippetMaxChars),
      });
    }
  }

  for (const paragraph of prepass.paragraphs) {
    if (snippetByParagraph.has(paragraph.index)) continue;
    const text = clampText(paragraph.text, snippetMaxChars);
    if (!text.trim()) continue;
    snippetByParagraph.set(paragraph.index, {
      snippetId: `snip:auto:${paragraph.index}`,
      paragraphIndex: paragraph.index,
      text,
    });
  }

  const fallbackSnippets = [...snippetByParagraph.values()].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const candidateChunks = chunkArray(sortedCandidates, batchCandidates);

  const batches = candidateChunks.map((chunk) => {
    const candidates = chunk.map((candidate) => ({
      ...candidate,
      text: clampText(candidate.text, candidateTextMaxChars),
      normalizedText: clampText(candidate.normalizedText, candidateTextMaxChars),
    }));

    const targetParagraphs = [...new Set(candidates.map((candidate) => candidate.paragraphIndex))];
    const snippets: PrepassResult["snippets"] = [];
    const snippetIds = new Set<string>();

    for (const paragraphIndex of targetParagraphs) {
      const snippet = snippetByParagraph.get(paragraphIndex);
      if (!snippet || snippetIds.has(snippet.snippetId)) continue;
      snippets.push(snippet);
      snippetIds.add(snippet.snippetId);
      if (snippets.length >= batchSnippetsCap) break;
    }

    const minimumSnippetFallback = Math.min(3, batchSnippetsCap);
    if (snippets.length < minimumSnippetFallback) {
      for (const snippet of fallbackSnippets) {
        if (snippetIds.has(snippet.snippetId)) continue;
        snippets.push(snippet);
        snippetIds.add(snippet.snippetId);
        if (snippets.length >= minimumSnippetFallback || snippets.length >= batchSnippetsCap) break;
      }
    }

    return {
      ...prepass,
      candidates,
      snippets,
    };
  });

  const stats = batches.reduce<EntityPassBatchStats>(
    (acc, batch) => {
      acc.batches += 1;
      acc.candidatesTotal += batch.candidates.length;
      acc.snippetsTotal += batch.snippets.length;
      acc.candidatesMaxPerBatch = Math.max(acc.candidatesMaxPerBatch, batch.candidates.length);
      acc.snippetsMaxPerBatch = Math.max(acc.snippetsMaxPerBatch, batch.snippets.length);
      return acc;
    },
    {
      batches: 0,
      candidatesTotal: 0,
      snippetsTotal: 0,
      candidatesMaxPerBatch: 0,
      snippetsMaxPerBatch: 0,
    }
  );

  return {
    batches,
    stats,
  };
}

function mergeEntityPassResults(contentVersion: number, results: EntityPassResult[]): EntityPassResult {
  const merged = new Map<string, EntityPassResult["entities"][number]>();

  for (const result of results) {
    for (const entity of result.entities) {
      const normalizedKey = normalizeEntityName(entity.normalizedName || entity.canonicalName) || entity.tempEntityId;
      const key = `${entity.type}:${normalizedKey}`;
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          ...entity,
          aliases: [...entity.aliases],
          evidence: [...entity.evidence],
        });
        continue;
      }

      if (!existing.summary && entity.summary) {
        existing.summary = entity.summary;
      }

      if (existing.resolution.action !== "link_existing" && entity.resolution.action === "link_existing") {
        existing.resolution = entity.resolution;
      }

      const aliasSeen = new Set(existing.aliases.map((alias) => alias.normalizedAlias));
      for (const alias of entity.aliases) {
        if (aliasSeen.has(alias.normalizedAlias)) continue;
        existing.aliases.push(alias);
        aliasSeen.add(alias.normalizedAlias);
      }

      const evidenceSeen = new Set(existing.evidence.map((item) => `${item.snippetId}:${item.quote}`));
      for (const evidence of entity.evidence) {
        const evidenceKey = `${evidence.snippetId}:${evidence.quote}`;
        if (evidenceSeen.has(evidenceKey)) continue;
        existing.evidence.push(evidence);
        evidenceSeen.add(evidenceKey);
      }
    }
  }

  return {
    contentVersion,
    entities: [...merged.values()],
  };
}

async function markRunSuperseded(runId: string, supersededByRunId?: string | null) {
  await prisma.analysisRun.updateMany({
    where: { id: runId },
    data: {
      state: "superseded",
      phase: "superseded",
      supersededByRunId: supersededByRunId || null,
      completedAt: new Date(),
    },
  });
}

async function isRunCurrent(runId: string): Promise<boolean> {
  const run = await prisma.analysisRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      documentId: true,
      contentVersion: true,
    },
  });
  if (!run) return false;

  const document = await prisma.document.findUnique({
    where: { id: run.documentId },
    select: {
      contentVersion: true,
      currentRunId: true,
    },
  });

  if (!document) return false;
  return document.contentVersion === run.contentVersion && document.currentRunId === run.id;
}

async function updateRunPhase(runId: string, phase: string, state: "running" | null = null) {
  await prisma.analysisRun.updateMany({
    where: { id: runId },
    data: {
      phase: phase as any,
      ...(state ? { state } : {}),
    },
  });
}

async function loadKnownEntities(projectId: string) {
  const entities = await prisma.entity.findMany({
    where: {
      projectId,
      mergedIntoEntityId: null,
    },
    include: {
      aliases: {
        select: {
          alias: true,
          normalizedAlias: true,
        },
      },
    },
    orderBy: [{ type: "asc" }, { canonicalName: "asc" }],
  });

  return entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    canonicalName: entity.canonicalName,
    normalizedName: entity.normalizedName,
    aliases: entity.aliases,
  }));
}

async function getOrCreateEntity(params: {
  tx: Tx;
  projectId: string;
  runId: string;
  type: EntityType;
  canonicalName: string;
  normalizedName: string;
  summary?: string;
  }): Promise<ResolvedEntity> {
  const normalizedName = normalizeEntityName(params.normalizedName || params.canonicalName);
  if (!normalizedName) {
    throw new Error("Entity normalizedName cannot be empty");
  }

  const existing = await params.tx.entity.findFirst({
    where: {
      projectId: params.projectId,
      type: params.type,
      normalizedName,
    },
    select: {
      id: true,
      type: true,
      canonicalName: true,
      normalizedName: true,
    },
  });

  if (existing) {
    if ((params.summary || "").trim().length > 0) {
      await params.tx.entity.update({
        where: { id: existing.id },
        data: {
          summary: {
            set: params.summary,
          },
          lastSeenAt: new Date(),
        },
      });
    }

    return {
      id: existing.id,
      type: existing.type,
      canonicalName: existing.canonicalName,
      normalizedName: existing.normalizedName,
    };
  }

  let created:
    | {
        id: string;
        type: EntityType;
        canonicalName: string;
        normalizedName: string;
      }
    | null = null;

  try {
    created = await params.tx.entity.create({
      data: {
        projectId: params.projectId,
        type: params.type,
        canonicalName: params.canonicalName,
        normalizedName,
        summary: (params.summary || "").trim(),
        createdByRunId: params.runId,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        type: true,
        canonicalName: true,
        normalizedName: true,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }

    const concurrent = await params.tx.entity.findFirst({
      where: {
        projectId: params.projectId,
        type: params.type,
        normalizedName,
      },
      select: {
        id: true,
        type: true,
        canonicalName: true,
        normalizedName: true,
      },
    });

    if (!concurrent) {
      throw error;
    }

    if ((params.summary || "").trim().length > 0) {
      await params.tx.entity.update({
        where: { id: concurrent.id },
        data: {
          summary: {
            set: params.summary,
          },
          lastSeenAt: new Date(),
        },
      });
    }

    created = concurrent;
  }

  if (!created) {
    throw new Error("Entity create failed unexpectedly");
  }

  return {
    id: created.id,
    type: created.type,
    canonicalName: created.canonicalName,
    normalizedName: created.normalizedName,
  };
}

function buildNormalizedAliasSet(params: {
  canonicalName: string;
  normalizedName?: string | null;
  aliases: Array<{ alias?: string | null; normalizedAlias?: string | null }>;
}): Set<string> {
  const out = new Set<string>();

  const canonicalNormalized = normalizeEntityName(params.normalizedName || params.canonicalName);
  if (canonicalNormalized) out.add(canonicalNormalized);

  for (const alias of params.aliases) {
    const normalized = normalizeEntityName(alias.normalizedAlias || alias.alias || "");
    if (!normalized) continue;
    out.add(normalized);
  }

  return out;
}

function hasAliasIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

async function applyEntityPass(params: {
  tx: Tx;
  projectId: string;
  runId: string;
  result: EntityPassResult;
}): Promise<Map<string, ResolvedEntity>> {
  const resolvedByTempId = new Map<string, ResolvedEntity>();

  for (const item of params.result.entities) {
    if (!workerConfig.pipeline.enableEventExtraction && item.type === "event") {
      continue;
    }

    let resolved: ResolvedEntity | null = null;

    if (item.resolution.action === "link_existing" && item.resolution.existingEntityId) {
      const existing = await params.tx.entity.findFirst({
        where: {
          id: item.resolution.existingEntityId,
          projectId: params.projectId,
        },
        include: {
          aliases: {
            select: {
              alias: true,
              normalizedAlias: true,
            },
          },
        },
      });

      if (existing) {
        const incomingAliasSet = buildNormalizedAliasSet({
          canonicalName: item.canonicalName,
          normalizedName: item.normalizedName,
          aliases: item.aliases.map((alias) => ({
            alias: alias.alias,
            normalizedAlias: alias.normalizedAlias,
          })),
        });
        const existingAliasSet = buildNormalizedAliasSet({
          canonicalName: existing.canonicalName,
          normalizedName: existing.normalizedName,
          aliases: existing.aliases,
        });

        if (hasAliasIntersection(incomingAliasSet, existingAliasSet)) {
          resolved = {
            id: existing.id,
            type: existing.type,
            canonicalName: existing.canonicalName,
            normalizedName: existing.normalizedName,
          };
        } else {
          logger.warn(
            {
              runId: params.runId,
              projectId: params.projectId,
              incomingCanonicalName: item.canonicalName,
              linkExistingEntityId: existing.id,
              linkExistingCanonicalName: existing.canonicalName,
            },
            "Rejected entity-pass link_existing: no alias overlap with target entity"
          );
        }
      }
    }

    if (!resolved) {
      resolved = await getOrCreateEntity({
        tx: params.tx,
        projectId: params.projectId,
        runId: params.runId,
        type: item.type,
        canonicalName: item.canonicalName,
        normalizedName: item.normalizedName,
        summary: item.summary,
      });
    }

    for (const alias of item.aliases) {
      const normalizedAlias = normalizeEntityName(alias.normalizedAlias || alias.alias);
      if (!normalizedAlias) continue;

      await params.tx.entityAlias.upsert({
        where: {
          entityId_normalizedAlias: {
            entityId: resolved.id,
            normalizedAlias,
          },
        },
        create: {
          entityId: resolved.id,
          alias: alias.alias,
          normalizedAlias,
          aliasType: normalizeAliasTypeSafe(alias.aliasType, "name"),
          source: "entity_pass",
          confidence: clamp01(alias.confidence),
          observed: alias.observed,
        },
        update: {
          alias: alias.alias,
          aliasType: normalizeAliasTypeSafe(alias.aliasType, "name"),
          source: "entity_pass",
          confidence: clamp01(alias.confidence),
          observed: alias.observed,
        },
      });
    }

    const canonicalNormalizedAlias = normalizeEntityName(resolved.canonicalName);
    if (canonicalNormalizedAlias) {
      await params.tx.entityAlias.upsert({
        where: {
          entityId_normalizedAlias: {
            entityId: resolved.id,
            normalizedAlias: canonicalNormalizedAlias,
          },
        },
        create: {
          entityId: resolved.id,
          alias: resolved.canonicalName,
          normalizedAlias: canonicalNormalizedAlias,
          aliasType: "name",
          source: "canonical",
          confidence: 1,
          observed: true,
        },
        update: {
          alias: resolved.canonicalName,
          aliasType: "name",
          source: "canonical",
          confidence: 1,
          observed: true,
        },
      });
    }

    resolvedByTempId.set(item.tempEntityId, resolved);
  }

  return resolvedByTempId;
}

function buildAliasRegistry(params: {
  entities: Array<{
    id: string;
    type: EntityType;
    canonicalName: string;
    aliases: Array<{ alias: string; aliasType: AliasType }>;
  }>;
}): Array<{ entityId: string; alias: string; aliasNormalized: string; mentionType: MentionType }> {
  const out: Array<{ entityId: string; alias: string; aliasNormalized: string; mentionType: MentionType }> = [];
  const seen = new Set<string>();

  for (const entity of params.entities) {
    const candidateAliases = [entity.canonicalName, ...entity.aliases.map((entry) => entry.alias)];
    for (const rawAlias of candidateAliases) {
      const alias = String(rawAlias || "").trim();
      if (!alias) continue;
      const aliasNormalized = normalizeEntityName(alias);
      if (!aliasNormalized) continue;
      const key = `${entity.id}::${aliasNormalized}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        entityId: entity.id,
        alias,
        aliasNormalized,
        mentionType: classifyMentionTypeFromAlias({
          alias,
          canonicalName: entity.canonicalName,
          aliasType:
            entity.aliases.find((entry) => normalizeEntityName(entry.alias) === aliasNormalized)?.aliasType || "name",
        }),
      });
    }
  }

  return out;
}

function buildSweepCandidates(params: {
  runId: string;
  documentId: string;
  contentVersion: number;
  content: string;
  aliases: Array<{ entityId: string; alias: string; mentionType: MentionType }>;
  characterEntityIds: Set<string>;
}): { candidates: SweepCandidate[]; mentions: SweepMention[] } {
  const paragraphs = splitParagraphs(params.content);
  const spanGroups = new Map<
    string,
    Array<{ entityId: string; alias: string; mentionType: MentionType; paragraphIndex: number; start: number; end: number; sourceText: string }>
  >();

  for (const paragraph of paragraphs) {
    for (const aliasEntry of params.aliases) {
      const hits = findAllWholeWordOccurrences(paragraph.text, aliasEntry.alias);
      for (const localStart of hits) {
        const globalStart = paragraph.startOffset + localStart;
        const globalEnd = globalStart + aliasEntry.alias.length;
        const sourceText = params.content.slice(globalStart, globalEnd);
        const key = `${paragraph.index}:${globalStart}:${globalEnd}:${sourceText.toLowerCase()}`;
        const group = spanGroups.get(key) || [];
        group.push({
          entityId: aliasEntry.entityId,
          alias: aliasEntry.alias,
          mentionType: aliasEntry.mentionType,
          paragraphIndex: paragraph.index,
          start: globalStart,
          end: globalEnd,
          sourceText,
        });
        spanGroups.set(key, group);
      }
    }
  }

  const candidates: SweepCandidate[] = [];
  const mentions: SweepMention[] = [];
  const deterministicCharacterByParagraph = new Map<number, Set<string>>();

  for (const group of spanGroups.values()) {
    if (!group.length) continue;
    const uniqueEntityIds = Array.from(new Set(group.map((entry) => entry.entityId)));
    const conflictGroupId = uniqueEntityIds.length > 1 ? `cg:${group[0].paragraphIndex}:${group[0].start}:${group[0].end}` : null;

    for (const entityId of uniqueEntityIds) {
      const candidateId = randomUUID();
      const base = group[0];
      const deterministic = uniqueEntityIds.length === 1;

      candidates.push({
        id: candidateId,
        runId: params.runId,
        documentId: params.documentId,
        contentVersion: params.contentVersion,
        paragraphIndex: base.paragraphIndex,
        startOffset: base.start,
        endOffset: base.end,
        sourceText: base.sourceText,
        candidateType: base.mentionType === "descriptor" ? "role" : "alias",
        routing: deterministic ? "deterministic" : "patch",
        decisionStatus: deterministic ? "accepted" : "pending",
        confidence: deterministic ? 0.95 : 0.5,
        featuresJson: {
          aliasCountInConflict: uniqueEntityIds.length,
        },
        conflictGroupId,
        entityHintId: entityId,
      });

      if (deterministic) {
        mentions.push({
          id: randomUUID(),
          runId: params.runId,
          documentId: params.documentId,
          contentVersion: params.contentVersion,
          entityId,
          candidateId,
          paragraphIndex: base.paragraphIndex,
          startOffset: base.start,
          endOffset: base.end,
          sourceText: base.sourceText,
          mentionType: base.mentionType,
          confidence: 0.95,
          resolvedBy: "deterministic",
        });

        if (params.characterEntityIds.has(entityId)) {
          const bucket = deterministicCharacterByParagraph.get(base.paragraphIndex) || new Set<string>();
          bucket.add(entityId);
          deterministicCharacterByParagraph.set(base.paragraphIndex, bucket);
        }
      }
    }
  }

  for (const paragraph of paragraphs) {
    const sameParagraph = deterministicCharacterByParagraph.get(paragraph.index) || new Set<string>();
    const previousParagraph = deterministicCharacterByParagraph.get(paragraph.index - 1) || new Set<string>();
    PRONOUN_PATTERN.lastIndex = 0;
    const pronounMatches = Array.from(paragraph.text.matchAll(PRONOUN_PATTERN));
    for (const match of pronounMatches) {
      const sourceText = String(match[0] || "").trim();
      if (!sourceText) continue;
      const localStart = Number(match.index ?? -1);
      if (localStart < 0) continue;

      let entityHintId: string | null = null;
      let confidence = 0.75;
      let resolutionSource: "same_paragraph" | "previous_paragraph" | "none" = "none";

      if (sameParagraph.size === 1) {
        entityHintId = Array.from(sameParagraph)[0];
        confidence = 0.92;
        resolutionSource = "same_paragraph";
      } else if (previousParagraph.size === 1) {
        entityHintId = Array.from(previousParagraph)[0];
        confidence = 0.9;
        resolutionSource = "previous_paragraph";
      }

      if (!entityHintId) continue;

      const startOffset = paragraph.startOffset + localStart;
      const endOffset = startOffset + sourceText.length;
      const candidateId = randomUUID();
      candidates.push({
        id: candidateId,
        runId: params.runId,
        documentId: params.documentId,
        contentVersion: params.contentVersion,
        paragraphIndex: paragraph.index,
        startOffset,
        endOffset,
        sourceText,
        candidateType: "coreference",
        routing: "patch",
        decisionStatus: "pending",
        confidence,
        featuresJson: {
          pronoun: sourceText.toLowerCase(),
          resolutionSource,
        },
        conflictGroupId: `cg:pronoun:${paragraph.index}:${startOffset}:${endOffset}`,
        entityHintId,
      });
    }
  }

  return collapseDeterministicContainedMentions({ candidates, mentions });
}

async function loadCharacterSignalsForActPass(runId: string): Promise<
  Array<{
    paragraphIndex: number;
    characterId: string;
    canonicalName: string;
    mentionText: string;
  }>
> {
  const rows = await prisma.mention.findMany({
    where: {
      runId,
      entity: {
        type: "character",
      },
    },
    include: {
      entity: {
        select: {
          id: true,
          canonicalName: true,
        },
      },
    },
    orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
    take: 2500,
  });

  return rows.map((row) => ({
    paragraphIndex: row.paragraphIndex,
    characterId: row.entity.id,
    canonicalName: row.entity.canonicalName,
    mentionText: row.sourceText,
  }));
}

interface AppearanceEvidenceCandidate {
  evidenceId: string;
  mentionId: string;
  characterId: string;
  canonicalName: string;
  actId: string | null;
  actOrderIndex: number | null;
  actTitle: string | null;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  mentionText: string;
  context: string;
}

const APPEARANCE_PASS_SIGNAL_CAP = 1400;
const APPEARANCE_PASS_BASE_SIGNALS_PER_CHARACTER = 6;

function capAppearanceEvidenceCandidates(items: AppearanceEvidenceCandidate[]): AppearanceEvidenceCandidate[] {
  if (items.length <= APPEARANCE_PASS_SIGNAL_CAP) {
    return items;
  }

  const selected: AppearanceEvidenceCandidate[] = [];
  const selectedById = new Set<string>();
  const baseCountByCharacter = new Map<string, number>();

  for (const item of items) {
    if (selected.length >= APPEARANCE_PASS_SIGNAL_CAP) break;
    const currentCount = baseCountByCharacter.get(item.characterId) || 0;
    if (currentCount >= APPEARANCE_PASS_BASE_SIGNALS_PER_CHARACTER) continue;
    selected.push(item);
    selectedById.add(item.evidenceId);
    baseCountByCharacter.set(item.characterId, currentCount + 1);
  }

  if (selected.length >= APPEARANCE_PASS_SIGNAL_CAP) return selected;

  for (const item of items) {
    if (selected.length >= APPEARANCE_PASS_SIGNAL_CAP) break;
    if (selectedById.has(item.evidenceId)) continue;
    selected.push(item);
    selectedById.add(item.evidenceId);
  }

  return selected;
}

async function loadAppearanceEvidenceCandidates(params: {
  runId: string;
  content: string;
}): Promise<AppearanceEvidenceCandidate[]> {
  const rows = await prisma.mention.findMany({
    where: {
      runId: params.runId,
      entity: {
        type: "character",
        mergedIntoEntityId: null,
      },
    },
    include: {
      entity: {
        select: {
          id: true,
          canonicalName: true,
        },
      },
      act: {
        select: {
          id: true,
          orderIndex: true,
          title: true,
        },
      },
    },
    orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
    take: 8000,
  });

  const mapped = rows.map((row) => ({
    evidenceId: row.id,
    mentionId: row.id,
    characterId: row.entity.id,
    canonicalName: row.entity.canonicalName,
    actId: row.act?.id || null,
    actOrderIndex: row.act ? Number(row.act.orderIndex) : null,
    actTitle: row.act?.title || null,
    paragraphIndex: row.paragraphIndex,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    mentionText: row.sourceText,
    context: extractContextByOffsets(params.content, row.startOffset, row.endOffset, 120) || row.sourceText,
  }));

  return capAppearanceEvidenceCandidates(mapped);
}

function resolveDominantActId(candidates: AppearanceEvidenceCandidate[]): string | null {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.actId) continue;
    counts.set(candidate.actId, (counts.get(candidate.actId) || 0) + 1);
  }
  const top = [...counts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  })[0];
  return top ? top[0] : null;
}

async function replaceActsForRun(params: {
  tx: Tx;
  runId: string;
  projectId: string;
  chapterId: string;
  documentId: string;
  contentVersion: number;
  acts: Array<{
    orderIndex: number;
    title: string;
    summary: string;
    paragraphStart: number;
    paragraphEnd: number;
  }>;
}) {
  await params.tx.act.deleteMany({
    where: {
      documentId: params.documentId,
      contentVersion: params.contentVersion,
    },
  });

  await params.tx.mention.updateMany({
    where: {
      runId: params.runId,
    },
    data: {
      actId: null,
    },
  });

  if (!params.acts.length) {
    return;
  }

  const actRows = params.acts
    .map((act, index) => ({
      id: randomUUID(),
      projectId: params.projectId,
      chapterId: params.chapterId,
      documentId: params.documentId,
      contentVersion: params.contentVersion,
      orderIndex: index,
      title: String(act.title || "").trim() || `Акт ${index + 1}`,
      summary: String(act.summary || "").trim().slice(0, 1200),
      paragraphStart: Math.max(0, Math.floor(act.paragraphStart)),
      paragraphEnd: Math.max(0, Math.floor(act.paragraphEnd)),
      createdByRunId: params.runId,
    }))
    .filter((act) => act.paragraphEnd >= act.paragraphStart)
    .sort((left, right) => {
      if (left.paragraphStart !== right.paragraphStart) return left.paragraphStart - right.paragraphStart;
      return left.paragraphEnd - right.paragraphEnd;
    });

  if (!actRows.length) return;

  await params.tx.act.createMany({
    data: actRows,
  });

  for (const act of actRows) {
    await params.tx.mention.updateMany({
      where: {
        runId: params.runId,
        paragraphIndex: {
          gte: act.paragraphStart,
          lte: act.paragraphEnd,
        },
      },
      data: {
        actId: act.id,
      },
    });
  }
}

async function replaceAppearanceObservationsForRun(params: {
  tx: Tx;
  runId: string;
  projectId: string;
  chapterId: string;
  documentId: string;
  contentVersion: number;
  observations: Array<{
    orderIndex: number;
    characterId: string;
    attributeKey: string;
    attributeLabel: string;
    value: string;
    scope: "stable" | "temporary" | "scene";
    actOrderIndex?: number | null;
    summary: string;
    confidence: number;
    evidenceIds: string[];
  }>;
  evidenceCandidates: AppearanceEvidenceCandidate[];
}) {
  await params.tx.characterAppearanceObservation.deleteMany({
    where: {
      documentId: params.documentId,
      contentVersion: params.contentVersion,
    },
  });

  if (!params.observations.length) return;

  const actRows = await params.tx.act.findMany({
    where: {
      documentId: params.documentId,
      contentVersion: params.contentVersion,
    },
    select: {
      id: true,
      orderIndex: true,
    },
  });
  const actIdByOrderIndex = new Map<number, string>(actRows.map((item) => [item.orderIndex, item.id] as const));
  const evidenceById = new Map(params.evidenceCandidates.map((item) => [item.evidenceId, item] as const));

  for (const observation of params.observations) {
    const evidenceCandidates = observation.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is AppearanceEvidenceCandidate => Boolean(item))
      .filter((item) => item.characterId === observation.characterId);

    if (!evidenceCandidates.length) continue;

    const actId =
      (typeof observation.actOrderIndex === "number" ? actIdByOrderIndex.get(observation.actOrderIndex) : null) ||
      resolveDominantActId(evidenceCandidates);

    const created = await params.tx.characterAppearanceObservation.create({
      data: {
        id: randomUUID(),
        projectId: params.projectId,
        chapterId: params.chapterId,
        documentId: params.documentId,
        contentVersion: params.contentVersion,
        runId: params.runId,
        characterId: observation.characterId,
        actId: actId || null,
        orderIndex: Math.max(0, Math.floor(observation.orderIndex)),
        attributeKey: clampText(compactWhitespace(observation.attributeKey || "appearance"), 64),
        attributeLabel: clampText(compactWhitespace(observation.attributeLabel || "Внешность"), 120),
        valueText: clampText(compactWhitespace(observation.value || ""), 280),
        summary: clampText(compactWhitespace(observation.summary || ""), 280),
        scope: observation.scope,
        confidence: clamp01(Number(observation.confidence ?? 0.7)),
      },
      select: {
        id: true,
      },
    });

    const evidenceRows = evidenceCandidates.map((candidate, index) => ({
      id: randomUUID(),
      observationId: created.id,
      mentionId: candidate.mentionId,
      evidenceOrder: index,
      paragraphIndex: candidate.paragraphIndex,
      startOffset: candidate.startOffset,
      endOffset: candidate.endOffset,
      sourceText: candidate.mentionText,
      snippet: clampText(compactWhitespace(candidate.context), 360),
    }));

    if (evidenceRows.length > 0) {
      await params.tx.characterAppearanceEvidence.createMany({
        data: evidenceRows,
        skipDuplicates: true,
      });
    }
  }
}

function isStrictSpanContainment(left: { startOffset: number; endOffset: number }, right: { startOffset: number; endOffset: number }): boolean {
  return (
    left.startOffset <= right.startOffset &&
    left.endOffset >= right.endOffset &&
    (left.startOffset < right.startOffset || left.endOffset > right.endOffset)
  );
}

function compareMentionSpecificity(left: SweepMention, right: SweepMention): number {
  const leftLength = Math.max(0, left.endOffset - left.startOffset);
  const rightLength = Math.max(0, right.endOffset - right.startOffset);
  if (leftLength !== rightLength) return leftLength - rightLength;

  const leftType = MENTION_TYPE_PRIORITY[left.mentionType] || 0;
  const rightType = MENTION_TYPE_PRIORITY[right.mentionType] || 0;
  if (leftType !== rightType) return leftType - rightType;

  if (left.confidence !== right.confidence) return left.confidence - right.confidence;

  return right.id.localeCompare(left.id);
}

function collapseDeterministicContainedMentions(params: {
  candidates: SweepCandidate[];
  mentions: SweepMention[];
}): { candidates: SweepCandidate[]; mentions: SweepMention[] } {
  const deterministicMentions = params.mentions.filter((item) => item.resolvedBy === "deterministic");
  if (deterministicMentions.length < 2) {
    return params;
  }

  const byEntityDoc = new Map<string, SweepMention[]>();
  for (const mention of deterministicMentions) {
    const key = `${mention.entityId}::${mention.documentId}::${mention.contentVersion}`;
    const bucket = byEntityDoc.get(key) || [];
    bucket.push(mention);
    byEntityDoc.set(key, bucket);
  }

  const droppedMentionIds = new Set<string>();
  for (const group of byEntityDoc.values()) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i += 1) {
      const left = group[i];
      if (droppedMentionIds.has(left.id)) continue;

      for (let j = i + 1; j < group.length; j += 1) {
        const right = group[j];
        if (droppedMentionIds.has(right.id)) continue;

        const leftContainsRight = isStrictSpanContainment(left, right);
        const rightContainsLeft = isStrictSpanContainment(right, left);
        if (!leftContainsRight && !rightContainsLeft) continue;

        const specificity = compareMentionSpecificity(left, right);
        if (specificity === 0) {
          droppedMentionIds.add(right.id);
          continue;
        }

        if (specificity > 0) {
          droppedMentionIds.add(right.id);
        } else {
          droppedMentionIds.add(left.id);
          break;
        }
      }
    }
  }

  if (droppedMentionIds.size === 0) {
    return params;
  }

  const droppedCandidateIds = new Set<string>();
  for (const mention of params.mentions) {
    if (!droppedMentionIds.has(mention.id)) continue;
    droppedCandidateIds.add(mention.candidateId);
  }

  const mentions = params.mentions.filter((item) => !droppedMentionIds.has(item.id));
  const candidates = params.candidates.filter((item) => !droppedCandidateIds.has(item.id));

  return { candidates, mentions };
}

async function applyPatchWindows(params: {
  runId: string;
  contentVersion: number;
  projectId: string;
  documentId: string;
  patch: Awaited<ReturnType<typeof runPatchCompletion>>;
  usageJson?: Prisma.InputJsonValue | null;
  artifactBlobKey?: string | null;
}) {
  const patchRaw = JSON.stringify(params.patch.result);
  const patchHash = createHash("sha256").update(patchRaw).digest("hex");

  for (const [index, window] of params.patch.result.windows.entries()) {
    let applied = false;
    let validationError: string | null = null;

    try {
      await prisma.$transaction(async (tx: Tx) => {
        const gateDocument = await tx.document.findUnique({
          where: { id: params.documentId },
          select: {
            currentRunId: true,
            contentVersion: true,
          },
        });
        if (!gateDocument) {
          throw new Error("Version gate failed: document not found");
        }
        if (gateDocument.currentRunId !== params.runId || gateDocument.contentVersion !== params.contentVersion) {
          throw new Error("Version gate failed: run superseded");
        }

        const candidateIds = window.ops.map((op) => op.candidateId);
        const candidates = await tx.mentionCandidate.findMany({
          where: {
            runId: params.runId,
            id: {
              in: candidateIds,
            },
          },
        });

        const byId = new Map<string, MentionCandidate>(candidates.map((item) => [item.id, item] as const));

        for (const op of window.ops) {
          const candidate = byId.get(op.candidateId);
          if (!candidate) {
            throw new Error(`Unknown candidateId ${op.candidateId}`);
          }
          if (candidate.decisionStatus !== "pending") {
            continue;
          }

          const decisionConfidence = clamp01(
            typeof op.confidence === "number" && Number.isFinite(op.confidence) ? op.confidence : candidate.confidence
          );
          const mentionType: MentionType =
            candidate.candidateType === "coreference"
              ? "pronoun"
              : candidate.candidateType === "role"
                ? "descriptor"
                : "alias";

          if (op.op === "reject_candidate") {
            await tx.mentionCandidate.update({
              where: { id: candidate.id },
              data: {
                decisionStatus: "rejected",
                confidence: decisionConfidence,
              },
            });
            continue;
          }

          if (mentionType === "pronoun" && !isPronounConfidenceAccepted(decisionConfidence, workerConfig.pipeline.pronounConfidenceThreshold)) {
            await tx.mentionCandidate.update({
              where: { id: candidate.id },
              data: {
                decisionStatus: "rejected",
                confidence: decisionConfidence,
              },
            });
            continue;
          }

          let linkedEntityId = op.entityId || candidate.entityHintId;

          if (op.op === "create_entity_and_link") {
            if (!op.newEntity) {
              throw new Error("create_entity_and_link requires newEntity");
            }

            const normalizedName = normalizeEntityName(op.newEntity.normalizedName || op.newEntity.canonicalName);
            const entity = await getOrCreateEntity({
              tx,
              projectId: params.projectId,
              runId: params.runId,
              type: op.newEntity.type,
              canonicalName: op.newEntity.canonicalName,
              normalizedName,
              summary: "",
            });
            linkedEntityId = entity.id;
          }

          if (!linkedEntityId) {
            throw new Error(`No entity resolved for candidate ${candidate.id}`);
          }

          await tx.mentionCandidate.update({
            where: { id: candidate.id },
            data: {
              decisionStatus: "accepted",
              entityHintId: linkedEntityId,
              confidence: decisionConfidence,
            },
          });

          if (op.op === "set_location_parent") {
            if (!op.entityId || !op.parentLocationId) {
              throw new Error("set_location_parent requires entityId and parentLocationId");
            }

            await tx.locationContainment.upsert({
              where: {
                childEntityId: op.entityId,
              },
              create: {
                projectId: params.projectId,
                childEntityId: op.entityId,
                parentEntityId: op.parentLocationId,
              },
              update: {
                parentEntityId: op.parentLocationId,
              },
            });
          }

          const existingMention = await tx.mention.findFirst({
            where: {
              runId: params.runId,
              candidateId: candidate.id,
            },
            select: { id: true },
          });

          if (!existingMention) {
            await tx.mention.create({
              data: {
                id: randomUUID(),
                runId: params.runId,
                documentId: params.documentId,
                contentVersion: params.contentVersion,
                entityId: linkedEntityId,
                candidateId: candidate.id,
                paragraphIndex: candidate.paragraphIndex,
                startOffset: candidate.startOffset,
                endOffset: candidate.endOffset,
                sourceText: candidate.sourceText,
                mentionType,
                confidence: decisionConfidence,
                resolvedBy: "patch",
              },
            });
          }
        }
      });
      applied = true;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      applied = false;
    }

    await prisma.patchDecision.create({
      data: {
        runId: params.runId,
        windowKey: window.windowKey,
        inputCandidateIds: window.ops.map((op) => op.candidateId),
        model: params.patch.meta.model,
        ...(index === 0 && params.usageJson ? { usageJson: params.usageJson } : {}),
        applied,
        validationError,
        responseHashSha256: patchHash,
        rawResponseSnippet: patchRaw.slice(0, 5000),
        responseBytes: Buffer.byteLength(patchRaw, "utf8"),
        blobKey: params.artifactBlobKey || null,
      },
    });
  }
}

function compareMentionOrder(
  left: { chapterOrderIndex: number; startOffset: number; endOffset: number },
  right: { chapterOrderIndex: number; startOffset: number; endOffset: number }
): number {
  if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
  if (left.startOffset !== right.startOffset) return left.startOffset - right.startOffset;
  return left.endOffset - right.endOffset;
}

async function recomputeCharacterAggregatesForProject(projectId: string) {
  const rows = await prisma.mention.findMany({
    where: {
      entity: {
        projectId,
        type: "character",
        mergedIntoEntityId: null,
      },
    },
    include: {
      entity: {
        select: {
          id: true,
        },
      },
      document: {
        select: {
          contentVersion: true,
          chapterId: true,
          chapter: {
            select: {
              orderIndex: true,
            },
          },
        },
      },
    },
  });

  const activeCharacterIds = await prisma.entity.findMany({
    where: {
      projectId,
      type: "character",
      mergedIntoEntityId: null,
    },
    select: {
      id: true,
    },
  });

  const mentionRows = rows.filter((row) => row.document && row.contentVersion === row.document.contentVersion);
  const chapterStats = new Map<string, number>();
  const actStats = new Map<string, number>();
  const aggregateByCharacter = new Map<
    string,
    {
      mentionCount: number;
      first: { chapterId: string; chapterOrderIndex: number; startOffset: number; endOffset: number } | null;
      last: { chapterId: string; chapterOrderIndex: number; startOffset: number; endOffset: number } | null;
    }
  >();

  for (const row of mentionRows) {
    const characterId = row.entity.id;
    const chapterId = row.document.chapterId;
    const chapterOrderIndex = Number(row.document.chapter?.orderIndex ?? 0);

    const chapterKey = `${characterId}:${chapterId}`;
    chapterStats.set(chapterKey, (chapterStats.get(chapterKey) || 0) + 1);
    if (row.actId) {
      const actKey = `${characterId}:${row.actId}`;
      actStats.set(actKey, (actStats.get(actKey) || 0) + 1);
    }

    const aggregate =
      aggregateByCharacter.get(characterId) || {
        mentionCount: 0,
        first: null,
        last: null,
      };
    aggregate.mentionCount += 1;

    const current = {
      chapterId,
      chapterOrderIndex,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
    };
    if (!aggregate.first || compareMentionOrder(current, aggregate.first) < 0) {
      aggregate.first = current;
    }
    if (!aggregate.last || compareMentionOrder(current, aggregate.last) > 0) {
      aggregate.last = current;
    }

    aggregateByCharacter.set(characterId, aggregate);
  }

  await prisma.$transaction(async (tx: Tx) => {
    if (activeCharacterIds.length > 0) {
      const ids = activeCharacterIds.map((item) => item.id);
      await tx.characterChapterStat.deleteMany({
        where: {
          characterId: {
            in: ids,
          },
        },
      });
      await tx.characterActStat.deleteMany({
        where: {
          characterId: {
            in: ids,
          },
        },
      });

      await tx.entity.updateMany({
        where: {
          id: {
            in: ids,
          },
        },
        data: {
          mentionCount: 0,
          firstAppearanceChapterId: null,
          firstAppearanceOffset: null,
          lastAppearanceChapterId: null,
          lastAppearanceOffset: null,
        },
      });
    }

    const chapterStatRows = Array.from(chapterStats.entries()).map(([key, mentionCount]) => {
      const [characterId, chapterId] = key.split(":");
      return {
        id: randomUUID(),
        characterId,
        chapterId,
        mentionCount,
      };
    });

    if (chapterStatRows.length > 0) {
      await tx.characterChapterStat.createMany({
        data: chapterStatRows,
      });
    }

    const actStatRows = Array.from(actStats.entries()).map(([key, mentionCount]) => {
      const [characterId, actId] = key.split(":");
      return {
        id: randomUUID(),
        characterId,
        actId,
        mentionCount,
      };
    });

    if (actStatRows.length > 0) {
      await tx.characterActStat.createMany({
        data: actStatRows,
      });
    }

    for (const [characterId, aggregate] of aggregateByCharacter.entries()) {
      await tx.entity.update({
        where: { id: characterId },
        data: {
          mentionCount: aggregate.mentionCount,
          firstAppearanceChapterId: aggregate.first?.chapterId || null,
          firstAppearanceOffset: aggregate.first?.startOffset ?? null,
          lastAppearanceChapterId: aggregate.last?.chapterId || null,
          lastAppearanceOffset: aggregate.last?.startOffset ?? null,
        },
      });
    }
  });
}

function shouldMergeCharacterPair(params: {
  leftCanonical: string;
  rightCanonical: string;
  leftAliases: Set<string>;
  rightAliases: Set<string>;
}): boolean {
  const leftCanonicalNormalized = normalizeEntityName(params.leftCanonical);
  const rightCanonicalNormalized = normalizeEntityName(params.rightCanonical);
  const leftHasRight = rightCanonicalNormalized ? params.leftAliases.has(rightCanonicalNormalized) : false;
  const rightHasLeft = leftCanonicalNormalized ? params.rightAliases.has(leftCanonicalNormalized) : false;
  if (!leftHasRight && !rightHasLeft) return false;

  let shared = 0;
  for (const alias of params.leftAliases) {
    if (params.rightAliases.has(alias)) {
      shared += 1;
      if (shared >= 2) break;
    }
  }

  const leftTokenCount = params.leftCanonical.trim().split(/\s+/u).filter(Boolean).length;
  const rightTokenCount = params.rightCanonical.trim().split(/\s+/u).filter(Boolean).length;
  const strongName = leftTokenCount >= 2 || rightTokenCount >= 2;
  return strongName || shared >= 2;
}

interface CharacterBookPassEntity {
  id: string;
  canonicalName: string;
  mentionCount: number;
  aliases: Array<{
    alias: string;
    normalizedAlias: string;
    aliasType: AliasType;
  }>;
}

interface CharacterProfileEvidence {
  chapterId: string;
  sourceText: string;
  context: string;
  mentionType: MentionType;
  confidence: number;
}

interface CharacterProfileEntityInput {
  id: string;
  canonicalName: string;
  mentionCount: number;
  aliases: string[];
}

interface CharacterProfileChapterSummary {
  chapterId: string;
  summary: string;
}

interface CharacterMergeArbiterPairCandidate {
  leftId: string;
  rightId: string;
  sharedAliases: string[];
  surnameDistance: number;
}

interface CharacterMergeArbiterEvidence {
  chapterId: string;
  sourceText: string;
  context: string;
}

function splitNormalizedNameTokens(value: string): string[] {
  return normalizeEntityName(value)
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSoftOrthography(value: string): string {
  return normalizeEntityName(value)
    .replace(/ё/gu, "е")
    .replace(/э/gu, "е")
    .replace(/й/gu, "и")
    .replace(/[ьъ]/gu, "");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const prev = new Array(rightChars.length + 1).fill(0).map((_, idx) => idx);
  const curr = new Array(rightChars.length + 1).fill(0);

  for (let i = 1; i <= leftChars.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= rightChars.length; j += 1) {
      const cost = leftChars[i - 1] === rightChars[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= rightChars.length; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[rightChars.length];
}

function buildMergeArbiterPairCandidate(params: {
  left: CharacterBookPassEntity;
  right: CharacterBookPassEntity;
  leftAliases: Set<string>;
  rightAliases: Set<string>;
}): CharacterMergeArbiterPairCandidate | null {
  const minMentionCount = workerConfig.pipeline.bookPassMergeArbiterMinMentionCount;
  if (params.left.mentionCount < minMentionCount || params.right.mentionCount < minMentionCount) {
    return null;
  }

  const leftTokens = splitNormalizedNameTokens(params.left.canonicalName);
  const rightTokens = splitNormalizedNameTokens(params.right.canonicalName);
  if (leftTokens.length < 2 || rightTokens.length < 2) return null;
  if (leftTokens[0] !== rightTokens[0]) return null;

  const leftSurname = normalizeSoftOrthography(leftTokens[leftTokens.length - 1]);
  const rightSurname = normalizeSoftOrthography(rightTokens[rightTokens.length - 1]);
  if (!leftSurname || !rightSurname) return null;
  if (leftTokens[leftTokens.length - 1] === rightTokens[rightTokens.length - 1]) return null;

  const maxSurnameDistance = Math.max(1, workerConfig.pipeline.bookPassMergeArbiterSurnameDistance);
  const surnameDistance = levenshteinDistance(leftSurname, rightSurname);
  if (surnameDistance > maxSurnameDistance) return null;

  const sharedAliases: string[] = [];
  for (const alias of params.leftAliases) {
    if (!params.rightAliases.has(alias)) continue;
    sharedAliases.push(alias);
  }
  if (sharedAliases.length === 0) return null;

  const sharedHasGivenName = sharedAliases.some((alias) => alias === leftTokens[0]);
  if (!sharedHasGivenName) return null;

  return {
    leftId: params.left.id,
    rightId: params.right.id,
    sharedAliases: sharedAliases.slice(0, 24),
    surnameDistance,
  };
}

const GENERIC_CHARACTER_ALIAS_STOPWORDS = new Set([
  "господин",
  "госпожа",
  "мистер",
  "мисс",
  "миссис",
  "сэр",
  "леди",
  "король",
  "королева",
  "принц",
  "принцесса",
  "лорд",
  "капитан",
  "майор",
  "генерал",
  "старик",
  "старуха",
  "отец",
  "мать",
  "сын",
  "дочь",
  "брат",
  "сестра",
]);

function buildNormalizedCharacterAliasSet(entity: CharacterBookPassEntity): Set<string> {
  const aliases = new Set<string>();
  const canonicalNormalized = normalizeEntityName(entity.canonicalName);
  if (canonicalNormalized) aliases.add(canonicalNormalized);
  for (const alias of entity.aliases) {
    const normalized = normalizeEntityName(alias.normalizedAlias || alias.alias);
    if (normalized) aliases.add(normalized);
  }
  return aliases;
}

function collectSharedCharacterAliases(leftAliases: Set<string>, rightAliases: Set<string>): string[] {
  const shared: string[] = [];
  for (const alias of leftAliases) {
    if (!rightAliases.has(alias)) continue;
    shared.push(alias);
  }
  return shared;
}

function hasSafeExactAliasOverlap(params: {
  left: CharacterBookPassEntity;
  right: CharacterBookPassEntity;
  leftAliases: Set<string>;
  rightAliases: Set<string>;
}): boolean {
  const sharedAliases = collectSharedCharacterAliases(params.leftAliases, params.rightAliases);
  if (sharedAliases.length === 0) return false;

  const leftCanonical = normalizeEntityName(params.left.canonicalName);
  const rightCanonical = normalizeEntityName(params.right.canonicalName);
  return sharedAliases.some((alias) => {
    if (!alias) return false;
    if (alias === leftCanonical || alias === rightCanonical) return true;
    const tokens = alias.split(/\s+/u).filter(Boolean);
    if (tokens.length >= 2) return true;
    if (alias.length < 6) return false;
    return !GENERIC_CHARACTER_ALIAS_STOPWORDS.has(alias);
  });
}

function hasRepeatedCrossSceneEvidence(
  leftEvidence: CharacterMergeArbiterEvidence[],
  rightEvidence: CharacterMergeArbiterEvidence[]
): boolean {
  const chapterIds = new Set<string>();
  for (const item of leftEvidence) chapterIds.add(item.chapterId);
  for (const item of rightEvidence) chapterIds.add(item.chapterId);
  return chapterIds.size >= 2 && leftEvidence.length >= 2 && rightEvidence.length >= 2;
}

async function loadCharacterMergeArbiterEvidence(
  entityId: string,
  cache: Map<string, CharacterMergeArbiterEvidence[]>
): Promise<CharacterMergeArbiterEvidence[]> {
  const cached = cache.get(entityId);
  if (cached) return cached;

  const mentionsLimit = Math.max(1, workerConfig.pipeline.bookPassMergeArbiterEvidenceMentionsPerEntity);
  const mentions = await prisma.mention.findMany({
    where: {
      entityId,
    },
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
    take: mentionsLimit,
    select: {
      documentId: true,
      startOffset: true,
      endOffset: true,
      sourceText: true,
    },
  });

  if (!mentions.length) {
    cache.set(entityId, []);
    return [];
  }

  const documentIds = Array.from(new Set(mentions.map((item) => item.documentId)));
  const documents = await prisma.document.findMany({
    where: {
      id: {
        in: documentIds,
      },
    },
    select: {
      id: true,
      chapterId: true,
      content: true,
    },
  });
  const docById = new Map(documents.map((item) => [item.id, item] as const));

  const snippets: CharacterMergeArbiterEvidence[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const doc = docById.get(mention.documentId);
    if (!doc) continue;
    const context = extractContextByOffsets(doc.content, mention.startOffset, mention.endOffset, 120);
    if (!context) continue;

    const sourceText = compactWhitespace(mention.sourceText || "");
    const key = `${doc.chapterId}:${mention.startOffset}:${mention.endOffset}:${sourceText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    snippets.push({
      chapterId: doc.chapterId,
      sourceText: clampText(sourceText, 64),
      context: clampText(context, 320),
    });
  }

  cache.set(entityId, snippets);
  return snippets;
}

async function loadCharacterProfileEvidence(entityId: string): Promise<CharacterProfileEvidence[]> {
  const rows = await prisma.mention.findMany({
    where: {
      entityId,
    },
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
    take: CHARACTER_PROFILE_EVIDENCE_FETCH_LIMIT,
    select: {
      mentionType: true,
      confidence: true,
      sourceText: true,
      startOffset: true,
      endOffset: true,
      contentVersion: true,
      document: {
        select: {
          chapterId: true,
          contentVersion: true,
          content: true,
        },
      },
    },
  });

  if (!rows.length) return [];

  const selected: CharacterProfileEvidence[] = [];
  const chapterQuota = new Map<string, number>();
  const seen = new Set<string>();

  for (const row of rows) {
    const document = row.document;
    if (!document) continue;
    if (row.contentVersion !== document.contentVersion) continue;

    const chapterId = document.chapterId;
    const quota = chapterQuota.get(chapterId) || 0;
    if (quota >= 2) continue;

    const sourceText = clampText(compactWhitespace(row.sourceText || ""), 80);
    if (!sourceText) continue;

    const context = extractContextByOffsets(document.content, row.startOffset, row.endOffset, 120);
    if (!context) continue;
    const contextCompact = clampText(compactWhitespace(context), 280);
    if (!contextCompact) continue;

    const key = `${chapterId}:${row.startOffset}:${row.endOffset}:${sourceText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    selected.push({
      chapterId,
      sourceText,
      context: contextCompact,
      mentionType: row.mentionType,
      confidence: clamp01(row.confidence),
    });
    chapterQuota.set(chapterId, quota + 1);

    if (selected.length >= CHARACTER_PROFILE_EVIDENCE_PER_ENTITY) break;
  }

  return selected;
}

function extractEntityPassArtifactStorageKeys(qualityFlags: unknown): string[] {
  const root = asRecord(qualityFlags);
  const artifacts = asRecord(root?.artifacts);
  const entityPass = artifacts?.entityPass;
  if (!Array.isArray(entityPass)) return [];

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of entityPass) {
    const record = asRecord(item);
    const storageKey = asString(record?.storageKey);
    if (!storageKey || seen.has(storageKey)) continue;
    seen.add(storageKey);
    keys.push(storageKey);
  }
  return keys;
}

function addCharacterProfileSummarySignal(
  map: Map<string, CharacterProfileChapterSummary[]>,
  entityId: string,
  signal: CharacterProfileChapterSummary
) {
  const bucket = map.get(entityId) || [];
  if (bucket.length >= CHARACTER_PROFILE_CHAPTER_SUMMARIES_PER_ENTITY) {
    map.set(entityId, bucket);
    return;
  }

  const exists = bucket.some((item) => item.chapterId === signal.chapterId && item.summary === signal.summary);
  if (!exists) {
    bucket.push(signal);
  }
  map.set(entityId, bucket);
}

async function loadEntityPassChapterSummariesForCharacters(params: {
  projectId: string;
  entities: CharacterProfileEntityInput[];
}): Promise<Map<string, CharacterProfileChapterSummary[]>> {
  const store = getArtifactBlobStore();
  if (!store) return new Map();

  const entityIdSet = new Set(params.entities.map((entity) => entity.id));
  const aliasLookup = new Map<string, Set<string>>();
  for (const entity of params.entities) {
    const aliases = [entity.canonicalName, ...entity.aliases];
    for (const alias of aliases) {
      const normalized = normalizeEntityName(alias);
      if (!normalized) continue;
      const bucket = aliasLookup.get(normalized) || new Set<string>();
      bucket.add(entity.id);
      aliasLookup.set(normalized, bucket);
    }
  }

  const documents = await prisma.document.findMany({
    where: {
      projectId: params.projectId,
      currentRunId: {
        not: null,
      },
    },
    select: {
      currentRunId: true,
      chapterId: true,
    },
  });
  const runIds = Array.from(new Set(documents.map((item) => item.currentRunId).filter((value): value is string => Boolean(value))));
  if (!runIds.length) return new Map();

  const chapterIdByRunId = new Map(
    documents
      .filter((item): item is { currentRunId: string; chapterId: string } => Boolean(item.currentRunId))
      .map((item) => [item.currentRunId, item.chapterId] as const)
  );

  const runs = await prisma.analysisRun.findMany({
    where: {
      id: {
        in: runIds,
      },
    },
    select: {
      id: true,
      chapterId: true,
      qualityFlags: true,
    },
  });

  const summarySignals = new Map<string, CharacterProfileChapterSummary[]>();
  const artifactJsonCache = new Map<string, unknown>();

  for (const run of runs) {
    const chapterId = run.chapterId || chapterIdByRunId.get(run.id);
    if (!chapterId) continue;

    const artifactKeys = extractEntityPassArtifactStorageKeys(run.qualityFlags);
    for (const storageKey of artifactKeys) {
      let payload: unknown;
      if (artifactJsonCache.has(storageKey)) {
        payload = artifactJsonCache.get(storageKey);
      } else {
        try {
          const bytes = await store.get(storageKey);
          const jsonText = new TextDecoder("utf-8").decode(bytes);
          payload = JSON.parse(jsonText);
          artifactJsonCache.set(storageKey, payload);
        } catch (error) {
          logger.warn({ err: error, storageKey, runId: run.id, projectId: params.projectId }, "Failed to read entity-pass artifact");
          continue;
        }
      }

      const root = asRecord(payload);
      const output = asRecord(root?.output);
      const result = asRecord(output?.result);
      const entities = Array.isArray(result?.entities) ? result.entities : [];

      for (const itemRaw of entities) {
        const item = asRecord(itemRaw);
        if (!item) continue;

        const type = asString(item.type) || "character";
        if (type !== "character") continue;

        const rawSummary = asString(item.summary) || asString(item.description) || asString(item.bio) || asString(item.blurb);
        const summary = clampText(compactWhitespace(rawSummary || ""), 180);
        if (!summary) continue;

        let targetEntityId: string | null = null;
        const resolution = asRecord(item.resolution);
        const existingEntityId = asString(resolution?.existingEntityId) || asString(item.existingEntityId);
        if (existingEntityId && entityIdSet.has(existingEntityId)) {
          targetEntityId = existingEntityId;
        }

        if (!targetEntityId) {
          const canonicalName = asString(item.canonicalName) || "";
          const normalizedName = normalizeEntityName(asString(item.normalizedName) || canonicalName);
          if (!normalizedName) continue;
          const candidates = aliasLookup.get(normalizedName);
          if (candidates && candidates.size === 1) {
            targetEntityId = Array.from(candidates)[0];
          }
        }

        if (!targetEntityId) continue;
        addCharacterProfileSummarySignal(summarySignals, targetEntityId, {
          chapterId,
          summary,
        });
      }
    }
  }

  return summarySignals;
}

async function runProjectCharacterProfileSynthesis(projectId: string) {
  const lockKey = `book-profile:${projectId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const pendingRuns = await prisma.analysisRun.count({
      where: {
        projectId,
        state: {
          in: ["queued", "running"],
        },
      },
    });
    if (pendingRuns > 0) return;

    const entitiesRaw = await prisma.entity.findMany({
      where: {
        projectId,
        type: "character",
        mergedIntoEntityId: null,
      },
      include: {
        aliases: {
          select: {
            alias: true,
          },
        },
      },
      orderBy: [{ mentionCount: "desc" }, { createdAt: "asc" }],
    });
    if (!entitiesRaw.length) return;

    const entities: CharacterProfileEntityInput[] = entitiesRaw.map((entity) => ({
      id: entity.id,
      canonicalName: entity.canonicalName,
      mentionCount: entity.mentionCount,
      aliases: entity.aliases.map((alias) => alias.alias),
    }));

    const evidenceByEntityId = new Map<string, CharacterProfileEvidence[]>();
    for (const batch of chunkArray(entities, 8)) {
      const results = await Promise.all(
        batch.map(async (entity) => ({
          entityId: entity.id,
          evidence: await loadCharacterProfileEvidence(entity.id),
        }))
      );
      for (const result of results) {
        evidenceByEntityId.set(result.entityId, result.evidence);
      }
    }

    const chapterSummariesByEntityId = await loadEntityPassChapterSummariesForCharacters({
      projectId,
      entities,
    });

    const synthesisInput = entities
      .map((entity) => {
        const chapterSummaries = chapterSummariesByEntityId.get(entity.id) || [];
        const evidenceFallback = evidenceByEntityId.get(entity.id) || [];
        return {
          id: entity.id,
          canonicalName: entity.canonicalName,
          mentionCount: entity.mentionCount,
          aliases: entity.aliases,
          chapterSummaries,
          // Prefer entity-pass summaries as the primary source of truth.
          evidence: chapterSummaries.length > 0 ? [] : evidenceFallback,
        };
      })
      .filter((entity) => entity.evidence.length > 0 || entity.chapterSummaries.length > 0);
    if (!synthesisInput.length) return;
    const batches = chunkArray(synthesisInput, CHARACTER_PROFILE_BATCH_SIZE);

    const summaryUpdates = new Map<string, string>();
    let callsTotal = 0;
    let callsFailed = 0;
    const usageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      try {
        const synthesisCall = await runCharacterProfileSynthesis({
          projectId,
          characters: batch,
        });
        callsTotal += 1;
        usageTotals.promptTokens += synthesisCall.meta.usage?.promptTokens ?? 0;
        usageTotals.completionTokens += synthesisCall.meta.usage?.completionTokens ?? 0;
        usageTotals.totalTokens += synthesisCall.meta.usage?.totalTokens ?? 0;
        usageTotals.latencyMs += synthesisCall.meta.latencyMs;

        logger.info(
          {
            projectId,
            batchIndex: batchIndex + 1,
            batchCount: batches.length,
            charactersInBatch: batch.length,
            provider: synthesisCall.meta.provider,
            model: synthesisCall.meta.model,
            attempt: synthesisCall.meta.attempt,
            finishReason: synthesisCall.meta.finishReason,
            startedAt: synthesisCall.meta.startedAt,
            completedAt: synthesisCall.meta.completedAt,
            latencyMs: synthesisCall.meta.latencyMs,
            promptTokens: synthesisCall.meta.usage?.promptTokens ?? null,
            completionTokens: synthesisCall.meta.usage?.completionTokens ?? null,
            totalTokens: synthesisCall.meta.usage?.totalTokens ?? null,
          },
          "Character profile synthesis batch completed"
        );

        for (const profile of synthesisCall.result.profiles) {
          const summary = clampText(compactWhitespace(profile.shortDescription || ""), 180);
          if (!summary) continue;
          summaryUpdates.set(profile.characterId, summary);
        }
      } catch (error) {
        callsTotal += 1;
        callsFailed += 1;
        logger.warn({ err: error, projectId, batchIndex: batchIndex + 1, batchCount: batches.length }, "Character profile synthesis batch failed");
      }
    }

    if (summaryUpdates.size > 0) {
      await prisma.$transaction(async (tx: Tx) => {
        for (const [characterId, summary] of summaryUpdates.entries()) {
          await tx.entity.updateMany({
            where: {
              id: characterId,
              projectId,
              type: "character",
              mergedIntoEntityId: null,
            },
            data: {
              summary,
              lastSeenAt: new Date(),
            },
          });
        }
      });
    }

    logger.info(
      {
        projectId,
        callsTotal,
        callsFailed,
        updatedProfiles: summaryUpdates.size,
        promptTokens: usageTotals.promptTokens,
        completionTokens: usageTotals.completionTokens,
        totalTokens: usageTotals.totalTokens,
        totalLatencyMs: usageTotals.latencyMs,
      },
      "Book-level character profile synthesis completed"
    );
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}

async function runProjectCharacterBookPass(projectId: string) {
  const lockKey = `book-pass:${projectId}`;
  const lockRows = await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const pendingRuns = await prisma.analysisRun.count({
      where: {
        projectId,
        state: {
          in: ["queued", "running"],
        },
      },
    });
    if (pendingRuns > 0) return;

    const entitiesRaw = await prisma.entity.findMany({
      where: {
        projectId,
        type: "character",
        mergedIntoEntityId: null,
      },
      include: {
        aliases: {
          select: {
            alias: true,
            normalizedAlias: true,
            aliasType: true,
          },
        },
      },
      orderBy: [{ mentionCount: "desc" }, { createdAt: "asc" }],
    });
    const entities: CharacterBookPassEntity[] = entitiesRaw.map((entity) => ({
      id: entity.id,
      canonicalName: entity.canonicalName,
      mentionCount: entity.mentionCount,
      aliases: entity.aliases.map((alias) => ({
        alias: alias.alias,
        normalizedAlias: alias.normalizedAlias,
        aliasType: normalizeAliasTypeSafe(alias.aliasType, "name"),
      })),
    }));
    if (entities.length < 2) return;
    const entityById = new Map(entities.map((item) => [item.id, item] as const));
    const mergeConfidenceThreshold = clamp01(workerConfig.pipeline.bookPassMergeArbiterConfidenceThreshold);
    const evidenceCache = new Map<string, CharacterMergeArbiterEvidence[]>();

    let canonicalizationCall:
      | Awaited<ReturnType<typeof runCharacterBookPassCanonicalization>>
      | null = null;
    try {
      canonicalizationCall = await runCharacterBookPassCanonicalization({
        projectId,
        entities: entities.map((entity) => ({
          id: entity.id,
          canonicalName: entity.canonicalName,
          normalizedName: normalizeEntityName(entity.canonicalName),
          mentionCount: entity.mentionCount,
          aliases: entity.aliases.map((alias) => ({
            alias: alias.alias,
            aliasType: alias.aliasType,
          })),
        })),
      });
    } catch (error) {
      logger.warn(
        { err: error, projectId },
        "Book-pass canonicalization model call failed; skipping merge application"
      );
      return;
    }

    logger.info(
      {
        projectId,
        entitiesCount: entities.length,
        provider: canonicalizationCall.meta.provider,
        model: canonicalizationCall.meta.model,
        attempt: canonicalizationCall.meta.attempt,
        finishReason: canonicalizationCall.meta.finishReason,
        startedAt: canonicalizationCall.meta.startedAt,
        completedAt: canonicalizationCall.meta.completedAt,
        latencyMs: canonicalizationCall.meta.latencyMs,
        promptTokens: canonicalizationCall.meta.usage?.promptTokens ?? null,
        completionTokens: canonicalizationCall.meta.usage?.completionTokens ?? null,
        totalTokens: canonicalizationCall.meta.usage?.totalTokens ?? null,
      },
      "Book-pass canonicalization call completed"
    );

    const parent = new Map<string, string>();
    for (const entity of entities) {
      parent.set(entity.id, entity.id);
    }

    const find = (id: string): string => {
      const current = parent.get(id) || id;
      if (current === id) return current;
      const root = find(current);
      parent.set(id, root);
      return root;
    };

    const pickBestCanonicalId = (ids: string[]): string => {
      let bestId = ids[0];
      let bestMentionCount = -1;
      let bestNameLength = -1;

      for (const id of ids) {
        const entity = entityById.get(id);
        if (!entity) continue;
        if (
          entity.mentionCount > bestMentionCount ||
          (entity.mentionCount === bestMentionCount && entity.canonicalName.length > bestNameLength)
        ) {
          bestId = id;
          bestMentionCount = entity.mentionCount;
          bestNameLength = entity.canonicalName.length;
        }
      }

      return bestId;
    };

    const unionToCanonical = (canonicalId: string, memberId: string) => {
      const canonicalRoot = find(canonicalId);
      const memberRoot = find(memberId);
      if (canonicalRoot === memberRoot) return;
      parent.set(memberRoot, canonicalRoot);
    };

    const groups = canonicalizationCall.result.groups
      .map((group) => ({
        canonicalEntityId: group.canonicalEntityId,
        memberEntityIds: Array.from(
          new Set(
            group.memberEntityIds.filter((id) => typeof id === "string" && id.length > 0 && entityById.has(id))
          )
        ),
        confidence: clamp01(group.confidence),
      }))
      .filter((group) => group.memberEntityIds.length >= 2)
      .sort((left, right) => right.confidence - left.confidence);

    let acceptedGroupCount = 0;
    let exactAliasApprovedPairs = 0;
    let arbiterApprovedPairs = 0;
    let ambiguousPairs = 0;
    for (const group of groups) {
      if (group.confidence < mergeConfidenceThreshold) continue;
      const canonicalId = group.memberEntityIds.includes(group.canonicalEntityId)
        ? group.canonicalEntityId
        : pickBestCanonicalId(group.memberEntityIds);
      const canonicalEntity = entityById.get(canonicalId);
      if (!canonicalEntity) continue;

      let groupAccepted = false;
      for (const memberId of group.memberEntityIds) {
        if (memberId === canonicalId) continue;
        const memberEntity = entityById.get(memberId);
        if (!memberEntity) continue;

        const leftAliases = buildNormalizedCharacterAliasSet(canonicalEntity);
        const rightAliases = buildNormalizedCharacterAliasSet(memberEntity);

        if (
          hasSafeExactAliasOverlap({
            left: canonicalEntity,
            right: memberEntity,
            leftAliases,
            rightAliases,
          })
        ) {
          unionToCanonical(canonicalId, memberId);
          groupAccepted = true;
          exactAliasApprovedPairs += 1;
          continue;
        }

        const pairCandidate = buildMergeArbiterPairCandidate({
          left: canonicalEntity,
          right: memberEntity,
          leftAliases,
          rightAliases,
        });
        if (!pairCandidate) {
          ambiguousPairs += 1;
          logger.info(
            {
              projectId,
              canonicalId,
              memberId,
              reason: "no_safe_alias_overlap_or_arbiter_candidate",
            },
            "Book-pass canonicalization pair kept separate"
          );
          continue;
        }

        const [leftEvidence, rightEvidence] = await Promise.all([
          loadCharacterMergeArbiterEvidence(canonicalEntity.id, evidenceCache),
          loadCharacterMergeArbiterEvidence(memberEntity.id, evidenceCache),
        ]);
        if (!hasRepeatedCrossSceneEvidence(leftEvidence, rightEvidence)) {
          ambiguousPairs += 1;
          logger.info(
            {
              projectId,
              canonicalId,
              memberId,
              reason: "insufficient_cross_scene_evidence",
              leftEvidenceCount: leftEvidence.length,
              rightEvidenceCount: rightEvidence.length,
            },
            "Book-pass canonicalization pair kept separate"
          );
          continue;
        }

        const arbiterCall = await runCharacterMergeArbiter({
          pairId: `${canonicalEntity.id}:${memberEntity.id}`,
          sharedAliases: pairCandidate.sharedAliases,
          leftEntity: {
            id: canonicalEntity.id,
            canonicalName: canonicalEntity.canonicalName,
            normalizedName: normalizeEntityName(canonicalEntity.canonicalName),
            mentionCount: canonicalEntity.mentionCount,
            aliases: canonicalEntity.aliases.map((alias) => ({
              alias: alias.alias,
              aliasType: alias.aliasType,
            })),
            evidence: leftEvidence,
          },
          rightEntity: {
            id: memberEntity.id,
            canonicalName: memberEntity.canonicalName,
            normalizedName: normalizeEntityName(memberEntity.canonicalName),
            mentionCount: memberEntity.mentionCount,
            aliases: memberEntity.aliases.map((alias) => ({
              alias: alias.alias,
              aliasType: alias.aliasType,
            })),
            evidence: rightEvidence,
          },
        });

        if (
          arbiterCall.result.decision === "merge" &&
          clamp01(arbiterCall.result.confidence) >= mergeConfidenceThreshold &&
          arbiterCall.result.preferredEntity !== "right"
        ) {
          unionToCanonical(canonicalId, memberId);
          groupAccepted = true;
          arbiterApprovedPairs += 1;
          continue;
        }

        ambiguousPairs += 1;
        logger.info(
          {
            projectId,
            canonicalId,
            memberId,
            arbiterDecision: arbiterCall.result.decision,
            arbiterConfidence: clamp01(arbiterCall.result.confidence),
            arbiterPreferredEntity: arbiterCall.result.preferredEntity,
            arbiterRationale: arbiterCall.result.rationale,
          },
          "Book-pass canonicalization pair kept separate after arbiter"
        );
      }

      if (groupAccepted) {
        acceptedGroupCount += 1;
      }
    }

    const mergePairs: Array<{ fromId: string; toId: string }> = [];
    for (const entity of entities) {
      const root = find(entity.id);
      if (root !== entity.id) {
        mergePairs.push({
          fromId: entity.id,
          toId: root,
        });
      }
    }
    if (mergePairs.length === 0) {
      logger.info(
        {
          projectId,
          mergeCount: 0,
          groupsReceived: groups.length,
          groupsAccepted: acceptedGroupCount,
          exactAliasApprovedPairs,
          arbiterApprovedPairs,
          ambiguousPairs,
          confidenceThreshold: mergeConfidenceThreshold,
          model: canonicalizationCall.meta.model,
          provider: canonicalizationCall.meta.provider,
          attempt: canonicalizationCall.meta.attempt,
          promptTokens: canonicalizationCall.meta.usage?.promptTokens ?? null,
          completionTokens: canonicalizationCall.meta.usage?.completionTokens ?? null,
          totalTokens: canonicalizationCall.meta.usage?.totalTokens ?? null,
          latencyMs: canonicalizationCall.meta.latencyMs,
        },
        "Book-pass character canonicalization completed"
      );
      return;
    }

    await prisma.$transaction(async (tx: Tx) => {
      for (const pair of mergePairs) {
        const sourceAliases = await tx.entityAlias.findMany({
          where: {
            entityId: pair.fromId,
          },
        });

        for (const alias of sourceAliases) {
          await tx.entityAlias.upsert({
            where: {
              entityId_normalizedAlias: {
                entityId: pair.toId,
                normalizedAlias: alias.normalizedAlias,
              },
            },
            create: {
              entityId: pair.toId,
              alias: alias.alias,
              normalizedAlias: alias.normalizedAlias,
              aliasType: alias.aliasType,
              source: "book_pass",
              confidence: alias.confidence,
              observed: alias.observed,
            },
            update: {
              alias: alias.alias,
              aliasType: alias.aliasType,
              source: "book_pass",
              confidence: Math.max(alias.confidence, 0.9),
              observed: true,
            },
          });
        }

        await tx.mention.updateMany({
          where: {
            entityId: pair.fromId,
          },
          data: {
            entityId: pair.toId,
          },
        });

        await tx.mentionCandidate.updateMany({
          where: {
            entityHintId: pair.fromId,
          },
          data: {
            entityHintId: pair.toId,
          },
        });

        await tx.characterChapterStat.deleteMany({
          where: {
            characterId: pair.fromId,
          },
        });

        await tx.entity.update({
          where: { id: pair.fromId },
          data: {
            status: "merged",
            mergedIntoEntityId: pair.toId,
            mentionCount: 0,
            firstAppearanceChapterId: null,
            firstAppearanceOffset: null,
            lastAppearanceChapterId: null,
            lastAppearanceOffset: null,
          },
        });
      }
    });

    logger.info(
      {
        projectId,
        mergeCount: mergePairs.length,
        groupsReceived: groups.length,
        groupsAccepted: acceptedGroupCount,
        exactAliasApprovedPairs,
        arbiterApprovedPairs,
        ambiguousPairs,
        confidenceThreshold: mergeConfidenceThreshold,
        model: canonicalizationCall.meta.model,
        provider: canonicalizationCall.meta.provider,
        attempt: canonicalizationCall.meta.attempt,
        promptTokens: canonicalizationCall.meta.usage?.promptTokens ?? null,
        completionTokens: canonicalizationCall.meta.usage?.completionTokens ?? null,
        totalTokens: canonicalizationCall.meta.usage?.totalTokens ?? null,
        latencyMs: canonicalizationCall.meta.latencyMs,
      },
      "Book-pass character canonicalization completed"
    );
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}

async function computeAndFinalizeRun(params: {
  runId: string;
  documentId: string;
  contentVersion: number;
  requestedImportModelId?: ImportAnalysisModelId | null;
  llmUsage?: RunLlmUsageSummary | null;
  artifacts?: RunArtifactsSummary | null;
}) {
  const [eligibleTotal, eligibleResolved, uncertainCountRemaining, appliedPatchCount] = await Promise.all([
    prisma.mentionCandidate.count({
      where: {
        runId: params.runId,
        routing: "patch",
      },
    }),
    prisma.mentionCandidate.count({
      where: {
        runId: params.runId,
        routing: "patch",
        decisionStatus: {
          in: ["accepted", "rejected"],
        },
      },
    }),
    prisma.mentionCandidate.count({
      where: {
        runId: params.runId,
        decisionStatus: "pending",
      },
    }),
    prisma.patchDecision.count({
      where: {
        runId: params.runId,
        applied: true,
      },
    }),
  ]);

  const qualityFlags: Record<string, unknown> = {
    ...buildRequestedModelQualityFlags(params.requestedImportModelId || null),
    isPatched: appliedPatchCount > 0,
    patchBudgetReached: false,
    uncertainCountRemaining,
    eligibleCoverage: eligibleTotal > 0 ? eligibleResolved / eligibleTotal : 1,
    hasConflicts: uncertainCountRemaining > 0,
  };
  if (params.llmUsage && hasAnyPhaseUsage(params.llmUsage)) {
    qualityFlags.llmUsage = params.llmUsage;
  }
  if (
    params.artifacts &&
    (params.artifacts.entityPass.length > 0 ||
      params.artifacts.actPass.length > 0 ||
      params.artifacts.appearancePass.length > 0 ||
      params.artifacts.mentionCompletion.length > 0)
  ) {
    qualityFlags.artifacts = params.artifacts;
  }

  await prisma.analysisRun.updateMany({
    where: { id: params.runId },
    data: {
      state: "completed",
      phase: "completed",
      qualityFlags: qualityFlags as Prisma.InputJsonValue,
      eligibleTotal,
      eligibleResolved,
      uncertainCountRemaining,
      patchBudgetReached: false,
      completedAt: new Date(),
    },
  });

  await prisma.document.updateMany({
    where: {
      id: params.documentId,
      contentVersion: params.contentVersion,
      currentRunId: params.runId,
    },
    data: {
      updatedAt: new Date(),
    },
  });
}

async function markRunFailed(params: {
  runId: string;
  message: string;
  requestedImportModelId?: ImportAnalysisModelId | null;
  llmUsage?: RunLlmUsageSummary | null;
  extractionFailure?: Record<string, unknown> | null;
  artifacts?: RunArtifactsSummary | null;
}) {
  const failedUpdateData: Prisma.AnalysisRunUpdateManyMutationInput = {
    state: "failed",
    phase: "failed",
    error: String(params.message || "Analysis run failed").slice(0, 2000),
    completedAt: new Date(),
  };

  const qualityFlags: Record<string, unknown> = {
    ...buildRequestedModelQualityFlags(params.requestedImportModelId || null),
  };
  if (params.llmUsage && hasAnyPhaseUsage(params.llmUsage)) {
    qualityFlags.llmUsage = params.llmUsage;
  }
  if (params.extractionFailure && Object.keys(params.extractionFailure).length > 0) {
    qualityFlags.extractionFailure = params.extractionFailure;
  }
  if (
    params.artifacts &&
    (params.artifacts.entityPass.length > 0 ||
      params.artifacts.actPass.length > 0 ||
      params.artifacts.appearancePass.length > 0 ||
      params.artifacts.mentionCompletion.length > 0)
  ) {
    qualityFlags.artifacts = params.artifacts;
  }
  if (Object.keys(qualityFlags).length > 0) {
    failedUpdateData.qualityFlags = qualityFlags as Prisma.InputJsonValue;
  }

  await prisma.analysisRun.updateMany({
    where: { id: params.runId },
    data: failedUpdateData,
  });
}

async function scheduleAutoRerun(params: {
  runId: string;
  projectId: string;
  documentId: string;
  chapterId: string;
  contentVersion: number;
  reason: AutoRerunReason;
  requestedImportModelId?: ImportAnalysisModelId | null;
}): Promise<AutoRerunScheduleResult> {
  const maxAttempts = workerConfig.pipeline.analysisAutoRerunMaxAttempts;
  if (!workerConfig.pipeline.analysisAutoRerunEnabled || maxAttempts <= 0) {
    return {
      scheduled: false,
      reason: params.reason,
      attempt: 0,
      maxAttempts,
      runId: null,
    };
  }

  return prisma.$transaction(async (tx: Tx) => {
    const gateDocument = await tx.document.findUnique({
      where: { id: params.documentId },
      select: {
        currentRunId: true,
        contentVersion: true,
      },
    });

    if (!gateDocument) {
      return {
        scheduled: false,
        reason: params.reason,
        attempt: 0,
        maxAttempts,
        runId: null,
      };
    }

    if (gateDocument.currentRunId !== params.runId || gateDocument.contentVersion !== params.contentVersion) {
      return {
        scheduled: false,
        reason: params.reason,
        attempt: 0,
        maxAttempts,
        runId: null,
      };
    }

    const existingAttempts = await tx.analysisRun.count({
      where: {
        documentId: params.documentId,
        contentVersion: params.contentVersion,
        idempotencyKey: {
          startsWith: `${AUTO_RERUN_IDEMPOTENCY_PREFIX}:`,
        },
      },
    });
    const nextAttempt = existingAttempts + 1;

    if (nextAttempt > maxAttempts) {
      return {
        scheduled: false,
        reason: params.reason,
        attempt: nextAttempt,
        maxAttempts,
        runId: null,
      };
    }

    const idempotencyKey = buildAutoRerunIdempotencyKey({
      reason: params.reason,
      documentId: params.documentId,
      contentVersion: params.contentVersion,
      attempt: nextAttempt,
    });

    const existingByKey = await tx.analysisRun.findFirst({
      where: {
        documentId: params.documentId,
        idempotencyKey,
      },
      select: {
        id: true,
      },
    });

    if (existingByKey) {
      return {
        scheduled: true,
        reason: params.reason,
        attempt: nextAttempt,
        maxAttempts,
        runId: existingByKey.id,
      };
    }

    const rerun = await tx.analysisRun.create({
      data: {
        projectId: params.projectId,
        documentId: params.documentId,
        chapterId: params.chapterId,
        contentVersion: params.contentVersion,
        state: "queued",
        phase: "queued",
        idempotencyKey,
        ...(params.requestedImportModelId
          ? {
              qualityFlags: buildRequestedModelQualityFlags(params.requestedImportModelId) as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: {
        id: true,
      },
    });

    await tx.analysisRun.updateMany({
      where: {
        documentId: params.documentId,
        id: { not: rerun.id },
        state: {
          in: ["queued", "running"],
        },
      },
      data: {
        state: "superseded",
        phase: "superseded",
        supersededByRunId: rerun.id,
        completedAt: new Date(),
      },
    });

    await tx.document.update({
      where: { id: params.documentId },
      data: {
        currentRunId: rerun.id,
      },
    });

    await tx.outbox.create({
      data: {
        aggregateType: "analysis_run",
        aggregateId: rerun.id,
        eventType: "analysis.run.requested",
        payloadJson: {
          runId: rerun.id,
          projectId: params.projectId,
          documentId: params.documentId,
          chapterId: params.chapterId,
          contentVersion: params.contentVersion,
        },
      },
    });

    return {
      scheduled: true,
      reason: params.reason,
      attempt: nextAttempt,
      maxAttempts,
      runId: rerun.id,
    };
  });
}

export async function processDocumentExtract(payload: ProcessRunPayload) {
  const processingStartedAtMs = Date.now();
  const run = await prisma.analysisRun.findUnique({
    where: { id: payload.runId },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      chapterId: true,
      contentVersion: true,
      state: true,
      qualityFlags: true,
    },
  });

  if (!run) {
    logger.warn({ runId: payload.runId }, "Skip run processing: run not found");
    return;
  }

  if (run.state !== "queued" && run.state !== "running") {
    return;
  }

  const requestedImportModelId = parseRequestedImportModelId(run.qualityFlags);

  if (!(await isRunCurrent(run.id))) {
    await markRunSuperseded(run.id);
    return;
  }

  await prisma.analysisRun.updateMany({
    where: { id: run.id },
    data: {
      state: "running",
      phase: "prepass",
      startedAt: new Date(),
      error: null,
    },
  });

  const llmUsage = createRunLlmUsageSummary();
  const runArtifacts = createRunArtifactsSummary();

  logger.info(
    {
      runId: run.id,
      projectId: run.projectId,
      chapterId: run.chapterId,
      contentVersion: run.contentVersion,
      requestedImportModelId,
    },
    "Analysis run started"
  );

  try {
    const document = await prisma.document.findUnique({
      where: { id: run.documentId },
      select: {
        id: true,
        content: true,
        contentVersion: true,
      },
    });

    if (!document) {
      throw new Error("Document not found");
    }

    if (document.contentVersion !== run.contentVersion) {
      await markRunSuperseded(run.id);
      return;
    }

    const prepass = await runPrepass({
      content: document.content,
      contentVersion: run.contentVersion,
    });
    const entityPassBatches = buildEntityPassBatches(prepass);

    logger.info(
      {
        runId: run.id,
        contentVersion: run.contentVersion,
        candidatesBefore: prepass.candidates.length,
        snippetsBefore: prepass.snippets.length,
        batchCount: entityPassBatches.stats.batches,
        batchCandidatesTotal: entityPassBatches.stats.candidatesTotal,
        batchSnippetsTotal: entityPassBatches.stats.snippetsTotal,
        batchCandidatesMax: entityPassBatches.stats.candidatesMaxPerBatch,
        batchSnippetsMax: entityPassBatches.stats.snippetsMaxPerBatch,
      },
      "Prepared entity-pass batches"
    );

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    await updateRunPhase(run.id, "entity_pass");

    let entityPass: EntityPassResult;
    if (workerConfig.pipeline.entityPassSkipWhenNoCandidates && prepass.candidates.length === 0) {
      entityPass = {
        contentVersion: run.contentVersion,
        entities: [],
      };
      logger.info(
        {
          runId: run.id,
          contentVersion: run.contentVersion,
        },
        "Skip entity pass: prepass produced no candidates"
      );
    } else {
      const knownEntities = await loadKnownEntities(run.projectId);
      const batchResults: EntityPassResult[] = [];

      for (let index = 0; index < entityPassBatches.batches.length; index += 1) {
        const batch = entityPassBatches.batches[index];
        const entityPassCall = await runEntityPass({
          contentVersion: run.contentVersion,
          prepass: batch,
          knownEntities,
        }, {
          timewebModelId: requestedImportModelId,
        });
        registerPhaseUsage(llmUsage, "entityPass", entityPassCall.meta);

        if (entityPassCall.result.contentVersion !== run.contentVersion) {
          throw new Error(
            `Entity-pass contentVersion mismatch: expected ${run.contentVersion}, got ${entityPassCall.result.contentVersion}`
          );
        }

        batchResults.push(entityPassCall.result);

        const entityPassArtifact = await persistRunArtifact({
          projectId: run.projectId,
          runId: run.id,
          phase: "entity_pass",
          label: `entity-pass-batch-${index + 1}`,
          payload: {
            phase: "entity_pass",
            runId: run.id,
            projectId: run.projectId,
            chapterId: run.chapterId,
            contentVersion: run.contentVersion,
            batchIndex: index + 1,
            batchCount: entityPassBatches.batches.length,
            input: {
              knownEntitiesCount: knownEntities.length,
              batch,
            },
            output: {
              result: entityPassCall.result,
              meta: entityPassCall.meta,
              debug: entityPassCall.debug,
            },
            recordedAt: new Date().toISOString(),
          },
        });
        if (entityPassArtifact) {
          runArtifacts.entityPass.push(entityPassArtifact);
        }

        logger.info(
          {
            runId: run.id,
            projectId: run.projectId,
            chapterId: run.chapterId,
            contentVersion: run.contentVersion,
            batchIndex: index + 1,
            batchCount: entityPassBatches.batches.length,
            candidates: batch.candidates.length,
            snippets: batch.snippets.length,
            provider: entityPassCall.meta.provider,
            model: entityPassCall.meta.model,
            attempt: entityPassCall.meta.attempt,
            finishReason: entityPassCall.meta.finishReason,
            startedAt: entityPassCall.meta.startedAt,
            completedAt: entityPassCall.meta.completedAt,
            latencyMs: entityPassCall.meta.latencyMs,
            promptTokens: entityPassCall.meta.usage?.promptTokens ?? null,
            completionTokens: entityPassCall.meta.usage?.completionTokens ?? null,
            totalTokens: entityPassCall.meta.usage?.totalTokens ?? null,
            artifact: entityPassArtifact
              ? {
                  provider: entityPassArtifact.provider,
                  storageKey: entityPassArtifact.storageKey,
                  sizeBytes: entityPassArtifact.sizeBytes,
                  sha256: entityPassArtifact.sha256,
                }
              : null,
          },
          "Entity-pass batch completed"
        );
      }

      entityPass = mergeEntityPassResults(run.contentVersion, batchResults);
    }

    if (entityPass.contentVersion !== run.contentVersion) {
      throw new Error(
        `Entity-pass contentVersion mismatch: expected ${run.contentVersion}, got ${entityPass.contentVersion}`
      );
    }

    await prisma.$transaction(async (tx: Tx) => {
      await applyEntityPass({
        tx,
        projectId: run.projectId,
        runId: run.id,
        result: entityPass,
      });
    });

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    await updateRunPhase(run.id, "sweep");

    const entityRegistry = await prisma.entity.findMany({
      where: {
        projectId: run.projectId,
        ...(workerConfig.pipeline.enableEventExtraction ? {} : { type: { in: ["character", "location"] } }),
      },
      include: {
        aliases: {
          select: {
            alias: true,
            aliasType: true,
          },
        },
      },
    });

    const aliases = buildAliasRegistry({
      entities: entityRegistry.map((item) => ({
        id: item.id,
        type: item.type,
        canonicalName: item.canonicalName,
        aliases: item.aliases,
      })),
    });

    const sweep = buildSweepCandidates({
      runId: run.id,
      documentId: run.documentId,
      contentVersion: run.contentVersion,
      content: document.content,
      aliases,
      characterEntityIds: new Set(entityRegistry.filter((item) => item.type === "character").map((item) => item.id)),
    });

    await prisma.$transaction(async (tx: Tx) => {
      await tx.mention.deleteMany({
        where: {
          documentId: run.documentId,
          contentVersion: run.contentVersion,
        },
      });

      await tx.mentionCandidate.deleteMany({
        where: {
          documentId: run.documentId,
          contentVersion: run.contentVersion,
        },
      });

      if (sweep.candidates.length) {
        await tx.mentionCandidate.createMany({
          data: sweep.candidates,
        });
      }

      if (sweep.mentions.length) {
        await tx.mention.createMany({
          data: sweep.mentions,
        });
      }
    });

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    await updateRunPhase(run.id, "mention_completion");

    const pendingCandidates = await prisma.mentionCandidate.findMany({
      where: {
        runId: run.id,
        routing: "patch",
        decisionStatus: "pending",
      },
      include: {
        entityHint: {
          select: {
            id: true,
            canonicalName: true,
          },
        },
      },
      orderBy: [{ conflictGroupId: "asc" }, { paragraphIndex: "asc" }, { startOffset: "asc" }],
    });

    if (pendingCandidates.length > 0) {
      const candidatesByGroup = new Map<string, typeof pendingCandidates>();
      for (const item of pendingCandidates) {
        const groupKey = item.conflictGroupId || `cg:${item.id}`;
        const group = candidatesByGroup.get(groupKey) || [];
        group.push(item);
        candidatesByGroup.set(groupKey, group);
      }

      const groups = Array.from(candidatesByGroup.entries()).slice(0, workerConfig.pipeline.patchWindowsCap);
      const windows = chunkArray(groups, workerConfig.pipeline.patchWindowSize).map((chunk, index) => ({
        windowKey: `w:${index + 1}`,
        candidates: chunk.flatMap(([groupKey, entries]) =>
          entries.map((entry) => ({
            candidateId: entry.id,
            sourceText: entry.sourceText,
            candidateType: entry.candidateType,
            paragraphIndex: entry.paragraphIndex,
            startOffset: entry.startOffset,
            endOffset: entry.endOffset,
            conflictGroupId: groupKey,
            entityHintId: entry.entityHintId,
            entityHintName: entry.entityHint?.canonicalName || null,
          }))
        ),
      }));

      if (windows.length > 0) {
        const patchCall = await runPatchCompletion({
          runId: run.id,
          contentVersion: run.contentVersion,
          windows,
          entities: entityRegistry.map((entity) => ({
            id: entity.id,
            type: entity.type,
            canonicalName: entity.canonicalName,
            normalizedName: entity.normalizedName,
          })),
        }, {
          timewebModelId: requestedImportModelId,
        });
        registerPhaseUsage(llmUsage, "mentionCompletion", patchCall.meta);

        const mentionArtifact = await persistRunArtifact({
          projectId: run.projectId,
          runId: run.id,
          phase: "mention_completion",
          label: `mention-completion-${windows.length}-windows`,
          payload: {
            phase: "mention_completion",
            runId: run.id,
            projectId: run.projectId,
            chapterId: run.chapterId,
            contentVersion: run.contentVersion,
            input: {
              windows,
              entities: entityRegistry.map((entity) => ({
                id: entity.id,
                type: entity.type,
                canonicalName: entity.canonicalName,
                normalizedName: entity.normalizedName,
              })),
            },
            output: {
              result: patchCall.result,
              meta: patchCall.meta,
              debug: patchCall.debug,
            },
            recordedAt: new Date().toISOString(),
          },
        });
        if (mentionArtifact) {
          runArtifacts.mentionCompletion.push(mentionArtifact);
        }

        const patchOpsCount = patchCall.result.windows.reduce((sum, window) => sum + window.ops.length, 0);
        logger.info(
          {
            runId: run.id,
            projectId: run.projectId,
            chapterId: run.chapterId,
            contentVersion: run.contentVersion,
            windowCount: windows.length,
            patchOpsCount,
            provider: patchCall.meta.provider,
            model: patchCall.meta.model,
            attempt: patchCall.meta.attempt,
            finishReason: patchCall.meta.finishReason,
            startedAt: patchCall.meta.startedAt,
            completedAt: patchCall.meta.completedAt,
            latencyMs: patchCall.meta.latencyMs,
            promptTokens: patchCall.meta.usage?.promptTokens ?? null,
            completionTokens: patchCall.meta.usage?.completionTokens ?? null,
            totalTokens: patchCall.meta.usage?.totalTokens ?? null,
            artifact: mentionArtifact
              ? {
                  provider: mentionArtifact.provider,
                  storageKey: mentionArtifact.storageKey,
                  sizeBytes: mentionArtifact.sizeBytes,
                  sha256: mentionArtifact.sha256,
                }
              : null,
          },
          "Mention-completion batch completed"
        );

        const patch = patchCall.result;
        if (patch.runId === run.id && patch.contentVersion === run.contentVersion) {
          await applyPatchWindows({
            runId: run.id,
            contentVersion: run.contentVersion,
            projectId: run.projectId,
            documentId: run.documentId,
            patch: patchCall,
            usageJson: {
              provider: patchCall.meta.provider,
              model: patchCall.meta.model,
              attempt: patchCall.meta.attempt,
              finishReason: patchCall.meta.finishReason,
              usage: patchCall.meta.usage,
            } as Prisma.InputJsonValue,
            artifactBlobKey: mentionArtifact?.storageKey || null,
          });
        }
      }
    }

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    await updateRunPhase(run.id, "act_pass");

    const characterSignalsForActPass = await loadCharacterSignalsForActPass(run.id);
    const actPassCall = await runActPass(
      {
        contentVersion: run.contentVersion,
        paragraphs: prepass.paragraphs,
        characterSignals: characterSignalsForActPass,
      },
      {
        timewebModelId: requestedImportModelId,
      }
    );
    registerPhaseUsage(llmUsage, "actPass", actPassCall.meta);

    if (actPassCall.result.contentVersion !== run.contentVersion) {
      throw new Error(
        `Act-pass contentVersion mismatch: expected ${run.contentVersion}, got ${actPassCall.result.contentVersion}`
      );
    }

    const actArtifact = await persistRunArtifact({
      projectId: run.projectId,
      runId: run.id,
      phase: "act_pass",
      label: `act-pass-${actPassCall.result.acts.length}-acts`,
      payload: {
        phase: "act_pass",
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        input: {
          paragraphCount: prepass.paragraphs.length,
          characterSignalCount: characterSignalsForActPass.length,
          paragraphs: prepass.paragraphs.map((paragraph) => ({
            index: paragraph.index,
            text: clampText(compactWhitespace(paragraph.text), 1200),
          })),
          characterSignals: characterSignalsForActPass,
        },
        output: {
          result: actPassCall.result,
          meta: actPassCall.meta,
          debug: actPassCall.debug,
        },
        recordedAt: new Date().toISOString(),
      },
    });
    if (actArtifact) {
      runArtifacts.actPass.push(actArtifact);
    }

    await prisma.$transaction(async (tx: Tx) => {
      await replaceActsForRun({
        tx,
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        documentId: run.documentId,
        contentVersion: run.contentVersion,
        acts: actPassCall.result.acts,
      });
    });

    logger.info(
      {
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        acts: actPassCall.result.acts.length,
        paragraphCount: prepass.paragraphs.length,
        characterSignalCount: characterSignalsForActPass.length,
        provider: actPassCall.meta.provider,
        model: actPassCall.meta.model,
        attempt: actPassCall.meta.attempt,
        finishReason: actPassCall.meta.finishReason,
        startedAt: actPassCall.meta.startedAt,
        completedAt: actPassCall.meta.completedAt,
        latencyMs: actPassCall.meta.latencyMs,
        promptTokens: actPassCall.meta.usage?.promptTokens ?? null,
        completionTokens: actPassCall.meta.usage?.completionTokens ?? null,
        totalTokens: actPassCall.meta.usage?.totalTokens ?? null,
        artifact: actArtifact
          ? {
              provider: actArtifact.provider,
              storageKey: actArtifact.storageKey,
              sizeBytes: actArtifact.sizeBytes,
              sha256: actArtifact.sha256,
            }
          : null,
      },
      "Act-pass completed"
    );

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    await updateRunPhase(run.id, "appearance_pass");

    const appearanceEvidenceCandidates = await loadAppearanceEvidenceCandidates({
      runId: run.id,
      content: document.content,
    });

    let appearanceResult: {
      contentVersion: number;
      observations: Array<{
        orderIndex: number;
        characterId: string;
        attributeKey: string;
        attributeLabel: string;
        value: string;
        scope: "stable" | "temporary" | "scene";
        actOrderIndex?: number | null;
        summary: string;
        confidence: number;
        evidenceIds: string[];
      }>;
    } = {
      contentVersion: run.contentVersion,
      observations: [],
    };
    let appearanceMeta: StrictJsonCallMeta | null = null;
    let appearanceDebug: StrictJsonCallDebug | null = null;

    if (appearanceEvidenceCandidates.length > 0) {
      const appearancePassCall = await runAppearancePass(
        {
          contentVersion: run.contentVersion,
          acts: actPassCall.result.acts,
          evidenceCandidates: appearanceEvidenceCandidates.map((item) => ({
            evidenceId: item.evidenceId,
            characterId: item.characterId,
            canonicalName: item.canonicalName,
            actOrderIndex: item.actOrderIndex,
            actTitle: item.actTitle,
            paragraphIndex: item.paragraphIndex,
            startOffset: item.startOffset,
            endOffset: item.endOffset,
            mentionText: item.mentionText,
            context: item.context,
          })),
        },
        {
          timewebModelId: requestedImportModelId,
        }
      );
      registerPhaseUsage(llmUsage, "appearancePass", appearancePassCall.meta);

      if (appearancePassCall.result.contentVersion !== run.contentVersion) {
        throw new Error(
          `Appearance-pass contentVersion mismatch: expected ${run.contentVersion}, got ${appearancePassCall.result.contentVersion}`
        );
      }

      appearanceResult = appearancePassCall.result;
      appearanceMeta = appearancePassCall.meta;
      appearanceDebug = appearancePassCall.debug;
    } else {
      logger.info(
        {
          runId: run.id,
          projectId: run.projectId,
          chapterId: run.chapterId,
          contentVersion: run.contentVersion,
        },
        "Skip appearance-pass: no character evidence candidates"
      );
    }

    const appearanceArtifact = await persistRunArtifact({
      projectId: run.projectId,
      runId: run.id,
      phase: "appearance_pass",
      label: `appearance-pass-${appearanceResult.observations.length}-observations`,
      payload: {
        phase: "appearance_pass",
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        input: {
          actsCount: actPassCall.result.acts.length,
          evidenceCandidateCount: appearanceEvidenceCandidates.length,
          evidenceCandidates: appearanceEvidenceCandidates.map((item) => ({
            evidenceId: item.evidenceId,
            characterId: item.characterId,
            canonicalName: item.canonicalName,
            actOrderIndex: item.actOrderIndex,
            actTitle: item.actTitle,
            paragraphIndex: item.paragraphIndex,
            startOffset: item.startOffset,
            endOffset: item.endOffset,
            mentionText: item.mentionText,
            context: clampText(compactWhitespace(item.context), 360),
          })),
        },
        output: {
          result: appearanceResult,
          meta: appearanceMeta,
          debug: appearanceDebug,
        },
        recordedAt: new Date().toISOString(),
      },
    });
    if (appearanceArtifact) {
      runArtifacts.appearancePass.push(appearanceArtifact);
    }

    await prisma.$transaction(async (tx: Tx) => {
      await replaceAppearanceObservationsForRun({
        tx,
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        documentId: run.documentId,
        contentVersion: run.contentVersion,
        observations: appearanceResult.observations,
        evidenceCandidates: appearanceEvidenceCandidates,
      });
    });

    logger.info(
      {
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        acts: actPassCall.result.acts.length,
        evidenceCandidateCount: appearanceEvidenceCandidates.length,
        observations: appearanceResult.observations.length,
        provider: appearanceMeta?.provider || null,
        model: appearanceMeta?.model || null,
        attempt: appearanceMeta?.attempt ?? null,
        finishReason: appearanceMeta?.finishReason ?? null,
        startedAt: appearanceMeta?.startedAt || null,
        completedAt: appearanceMeta?.completedAt || null,
        latencyMs: appearanceMeta?.latencyMs ?? null,
        promptTokens: appearanceMeta?.usage?.promptTokens ?? null,
        completionTokens: appearanceMeta?.usage?.completionTokens ?? null,
        totalTokens: appearanceMeta?.usage?.totalTokens ?? null,
        artifact: appearanceArtifact
          ? {
              provider: appearanceArtifact.provider,
              storageKey: appearanceArtifact.storageKey,
              sizeBytes: appearanceArtifact.sizeBytes,
              sha256: appearanceArtifact.sha256,
            }
          : null,
      },
      "Appearance-pass completed"
    );

    if (!(await isRunCurrent(run.id))) {
      await markRunSuperseded(run.id);
      return;
    }

    const mentionCountAfterPatch = await prisma.mention.count({
      where: {
        runId: run.id,
      },
    });

    if (
      shouldFailQualityGate({
        prepassCandidates: prepass.candidates.length,
        mentionCount: mentionCountAfterPatch,
        contentChars: document.content.length,
      })
    ) {
      const message = `Quality gate failed: empty mentions (candidates=${prepass.candidates.length}, contentChars=${document.content.length})`;
      await markRunFailed({
        runId: run.id,
        message,
        requestedImportModelId,
        llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
        artifacts: runArtifacts,
      });

      const rerun = await scheduleAutoRerun({
        runId: run.id,
        projectId: run.projectId,
        documentId: run.documentId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        reason: "quality_gate_empty",
        requestedImportModelId,
      });

      logger.warn(
        {
          runId: run.id,
          projectId: run.projectId,
          chapterId: run.chapterId,
          contentVersion: run.contentVersion,
          reason: "quality_gate_empty",
          prepassCandidates: prepass.candidates.length,
          mentionCount: mentionCountAfterPatch,
          contentChars: document.content.length,
          llmPromptTokens: llmUsage.total.promptTokens,
          llmCompletionTokens: llmUsage.total.completionTokens,
          llmTotalTokens: llmUsage.total.totalTokens,
          artifacts: summarizeRunArtifacts(runArtifacts),
          processingDurationMs: Math.max(0, Date.now() - processingStartedAtMs),
          rerunScheduled: rerun.scheduled,
          rerunAttempt: rerun.attempt,
          rerunMaxAttempts: rerun.maxAttempts,
          rerunRunId: rerun.runId,
        },
        "Analysis quality gate failed"
      );
      return;
    }

    const summaryBackfillTriggered = shouldRunSummaryBackfillOnCatastrophe(entityPass);
    if (summaryBackfillTriggered) {
      const backfilledSummaries = await backfillMissingEntitySummariesForRun({
        runId: run.id,
        content: document.content,
      });
      if (backfilledSummaries > 0) {
        logger.warn(
          {
            runId: run.id,
            contentVersion: run.contentVersion,
            updatedEntities: backfilledSummaries,
            reason: "catastrophic_summary_gap",
          },
          "Backfilled empty entity summaries"
        );
      }
    }

    await updateRunPhase(run.id, "apply");
    await computeAndFinalizeRun({
      runId: run.id,
      documentId: run.documentId,
      contentVersion: run.contentVersion,
      requestedImportModelId,
      llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
      artifacts: runArtifacts,
    });

    try {
      await recomputeCharacterAggregatesForProject(run.projectId);
      await runProjectCharacterBookPass(run.projectId);
      await recomputeCharacterAggregatesForProject(run.projectId);
      await runProjectCharacterProfileSynthesis(run.projectId);
    } catch (postProcessError) {
      logger.error(
        { err: postProcessError, runId: run.id, projectId: run.projectId },
        "Post-processing for character aggregates/book-pass/profiles failed"
      );
    }

    logger.info(
      {
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        llmPromptTokens: llmUsage.total.promptTokens,
        llmCompletionTokens: llmUsage.total.completionTokens,
        llmTotalTokens: llmUsage.total.totalTokens,
        llmByPhase: {
          entityPass: llmUsage.entityPass || null,
          actPass: llmUsage.actPass || null,
          appearancePass: llmUsage.appearancePass || null,
          mentionCompletion: llmUsage.mentionCompletion || null,
        },
        artifacts: summarizeRunArtifacts(runArtifacts),
        processingDurationMs: Math.max(0, Date.now() - processingStartedAtMs),
      },
      "Analysis run completed"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const extractionFailure = buildExtractionFailureDebug(error);
    await markRunFailed({
      runId: run.id,
      message,
      requestedImportModelId,
      llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
      extractionFailure,
      artifacts: runArtifacts,
    });

    let rerun: AutoRerunScheduleResult | null = null;
    if (shouldAutoRerunForFailure(message)) {
      rerun = await scheduleAutoRerun({
        runId: run.id,
        projectId: run.projectId,
        documentId: run.documentId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        reason: "failed",
        requestedImportModelId,
      });
    }

    logger.error(
      {
        err: error,
        runId: run.id,
        projectId: run.projectId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        llmPromptTokens: llmUsage.total.promptTokens,
        llmCompletionTokens: llmUsage.total.completionTokens,
        llmTotalTokens: llmUsage.total.totalTokens,
        artifacts: summarizeRunArtifacts(runArtifacts),
        processingDurationMs: Math.max(0, Date.now() - processingStartedAtMs),
      },
      "Analysis run failed"
    );
    if (rerun) {
      logger.warn(
        {
          runId: run.id,
          reason: rerun.reason,
          rerunScheduled: rerun.scheduled,
          rerunAttempt: rerun.attempt,
          rerunMaxAttempts: rerun.maxAttempts,
          rerunRunId: rerun.runId,
        },
        "Auto-rerun decision completed"
      );
    }
  }
}
