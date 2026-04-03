import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@remarka/db";
import type { MentionCandidate, Prisma } from "@prisma/client";
import {
  normalizeEntityName,
  splitParagraphs,
  type EntityPassResult,
  type EntityType,
  type MentionCandidateType,
  type MentionRouting,
  type PrepassResult,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import { runEntityPass, runPatchCompletion, type StrictJsonCallMeta } from "../extractionV2";
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
  confidence: number;
  resolvedBy: string;
}

interface RunLlmUsagePhase {
  provider: "kia" | "timeweb";
  model: string;
  attempt: number;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface RunLlmUsageSummary {
  total: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  entityPass?: RunLlmUsagePhase;
  mentionCompletion?: RunLlmUsagePhase;
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

function createRunLlmUsageSummary(): RunLlmUsageSummary {
  return {
    total: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
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
  };
}

function registerPhaseUsage(
  usageSummary: RunLlmUsageSummary,
  phase: "entityPass" | "mentionCompletion",
  meta: StrictJsonCallMeta
) {
  const phaseUsage = toRunLlmUsagePhase(meta);
  usageSummary[phase] = phaseUsage;
  usageSummary.total.promptTokens += phaseUsage.promptTokens;
  usageSummary.total.completionTokens += phaseUsage.completionTokens;
  usageSummary.total.totalTokens += phaseUsage.totalTokens;
}

function hasAnyPhaseUsage(usageSummary: RunLlmUsageSummary): boolean {
  return Boolean(usageSummary.entityPass || usageSummary.mentionCompletion);
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
    where: { projectId },
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

  const created = await params.tx.entity.create({
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

  return {
    id: created.id,
    type: created.type,
    canonicalName: created.canonicalName,
    normalizedName: created.normalizedName,
  };
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
        select: {
          id: true,
          type: true,
          canonicalName: true,
          normalizedName: true,
        },
      });

      if (existing) {
        resolved = {
          id: existing.id,
          type: existing.type,
          canonicalName: existing.canonicalName,
          normalizedName: existing.normalizedName,
        };
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
          source: "entity_pass",
          confidence: clamp01(alias.confidence),
          observed: alias.observed,
        },
        update: {
          alias: alias.alias,
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
          source: "canonical",
          confidence: 1,
          observed: true,
        },
        update: {
          alias: resolved.canonicalName,
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
    aliases: Array<{ alias: string }>;
  }>;
}): Array<{ entityId: string; alias: string; aliasNormalized: string }> {
  const out: Array<{ entityId: string; alias: string; aliasNormalized: string }> = [];
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
  aliases: Array<{ entityId: string; alias: string }>;
}): { candidates: SweepCandidate[]; mentions: SweepMention[] } {
  const paragraphs = splitParagraphs(params.content);
  const spanGroups = new Map<string, Array<{ entityId: string; alias: string; paragraphIndex: number; start: number; end: number; sourceText: string }>>();

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
        candidateType: "alias",
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
          confidence: 0.95,
          resolvedBy: "deterministic",
        });
      }
    }
  }

  return { candidates, mentions };
}

async function applyPatchWindows(params: {
  runId: string;
  contentVersion: number;
  projectId: string;
  documentId: string;
  patch: Awaited<ReturnType<typeof runPatchCompletion>>;
  usageJson?: Prisma.InputJsonValue | null;
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

          if (op.op === "reject_candidate") {
            await tx.mentionCandidate.update({
              where: { id: candidate.id },
              data: {
                decisionStatus: "rejected",
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
                confidence: 0.8,
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
        model: workerConfig.extraction.provider === "kia" ? workerConfig.kia.extractModel : workerConfig.timeweb.extractModel,
        ...(index === 0 && params.usageJson ? { usageJson: params.usageJson } : {}),
        applied,
        validationError,
        responseHashSha256: patchHash,
        rawResponseSnippet: patchRaw.slice(0, 5000),
        responseBytes: Buffer.byteLength(patchRaw, "utf8"),
      },
    });
  }
}

async function computeAndFinalizeRun(params: {
  runId: string;
  documentId: string;
  contentVersion: number;
  llmUsage?: RunLlmUsageSummary | null;
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
    isPatched: appliedPatchCount > 0,
    patchBudgetReached: false,
    uncertainCountRemaining,
    eligibleCoverage: eligibleTotal > 0 ? eligibleResolved / eligibleTotal : 1,
    hasConflicts: uncertainCountRemaining > 0,
  };
  if (params.llmUsage && hasAnyPhaseUsage(params.llmUsage)) {
    qualityFlags.llmUsage = params.llmUsage;
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
  llmUsage?: RunLlmUsageSummary | null;
}) {
  const failedUpdateData: Prisma.AnalysisRunUpdateManyMutationInput = {
    state: "failed",
    phase: "failed",
    error: String(params.message || "Analysis run failed").slice(0, 2000),
    completedAt: new Date(),
  };

  if (params.llmUsage && hasAnyPhaseUsage(params.llmUsage)) {
    failedUpdateData.qualityFlags = {
      llmUsage: params.llmUsage,
    } as unknown as Prisma.InputJsonValue;
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
  const run = await prisma.analysisRun.findUnique({
    where: { id: payload.runId },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      chapterId: true,
      contentVersion: true,
      state: true,
    },
  });

  if (!run) {
    logger.warn({ runId: payload.runId }, "Skip run processing: run not found");
    return;
  }

  if (run.state !== "queued" && run.state !== "running") {
    return;
  }

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
        });
        registerPhaseUsage(llmUsage, "entityPass", entityPassCall.meta);

        if (entityPassCall.result.contentVersion !== run.contentVersion) {
          throw new Error(
            `Entity-pass contentVersion mismatch: expected ${run.contentVersion}, got ${entityPassCall.result.contentVersion}`
          );
        }

        batchResults.push(entityPassCall.result);

        logger.info(
          {
            runId: run.id,
            contentVersion: run.contentVersion,
            batchIndex: index + 1,
            batchCount: entityPassBatches.batches.length,
            candidates: batch.candidates.length,
            snippets: batch.snippets.length,
            promptTokens: entityPassCall.meta.usage?.promptTokens ?? null,
            totalTokens: entityPassCall.meta.usage?.totalTokens ?? null,
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
        });
        registerPhaseUsage(llmUsage, "mentionCompletion", patchCall.meta);

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
          });
        }
      }
    }

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
        llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
      });

      const rerun = await scheduleAutoRerun({
        runId: run.id,
        projectId: run.projectId,
        documentId: run.documentId,
        chapterId: run.chapterId,
        contentVersion: run.contentVersion,
        reason: "quality_gate_empty",
      });

      logger.warn(
        {
          runId: run.id,
          contentVersion: run.contentVersion,
          reason: "quality_gate_empty",
          prepassCandidates: prepass.candidates.length,
          mentionCount: mentionCountAfterPatch,
          contentChars: document.content.length,
          rerunScheduled: rerun.scheduled,
          rerunAttempt: rerun.attempt,
          rerunMaxAttempts: rerun.maxAttempts,
          rerunRunId: rerun.runId,
        },
        "Analysis quality gate failed"
      );
      return;
    }

    await updateRunPhase(run.id, "apply");
    await computeAndFinalizeRun({
      runId: run.id,
      documentId: run.documentId,
      contentVersion: run.contentVersion,
      llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
    });

    logger.info({ runId: run.id, contentVersion: run.contentVersion }, "Analysis run completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunFailed({
      runId: run.id,
      message,
      llmUsage: hasAnyPhaseUsage(llmUsage) ? llmUsage : null,
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
      });
    }

    logger.error({ err: error, runId: run.id }, "Analysis run failed");
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
