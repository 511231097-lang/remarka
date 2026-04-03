import { prisma } from "@remarka/db";
import {
  normalizeEntityName,
  resolveMentionOffsets,
  splitParagraphs,
  type EntityType,
  type ExtractionResult,
} from "@remarka/contracts";
import {
  runExtraction,
  runExtractionIncremental,
  type ExtractionModelCallTrace,
  type ExtractionTraceSink,
  type KnownProjectEntity,
} from "../extraction";
import { logger } from "../logger";
import { collectEntityCandidates, orderCandidatesForUpsert, toCandidateKey } from "./entityCandidates";
import { buildParagraphDiff } from "./paragraphDiff";
import { expandUnambiguousCharacterMentions } from "./mentionExpansion";

interface DocumentExtractPayload {
  jobId: string;
  projectId: string;
  documentId: string;
  contentVersion: number;
}

interface MentionSnapshot {
  paragraphIndex: number;
  sourceText: string;
  entity: {
    id: string;
    type: EntityType;
    name: string;
  };
}

interface ResolvedEntityLink {
  id: string;
  type: EntityType;
  name: string;
}

interface EntityRecord extends ResolvedEntityLink {
  normalizedName: string;
  summary: string;
}

function toKnownEntityRef(entityId: string): string {
  return `known:${entityId}`;
}

function emptyExtraction(): ExtractionResult {
  return {
    entities: [],
    mentions: [],
    annotations: [],
    locationContainments: [],
  };
}

function mergeIncrementalExtraction(params: {
  unchangedMap: Array<{ newIndex: number; oldIndex: number }>;
  changedExtraction: ExtractionResult;
  existingMentions: MentionSnapshot[];
}): ExtractionResult {
  const newByOld = new Map<number, number>();
  for (const entry of params.unchangedMap) {
    newByOld.set(entry.oldIndex, entry.newIndex);
  }

  const reusedMentions = params.existingMentions
    .map((mention) => {
      const newIndex = newByOld.get(mention.paragraphIndex);
      if (newIndex === undefined) return null;

      return {
        entityRef: toKnownEntityRef(mention.entity.id),
        type: mention.entity.type,
        name: mention.entity.name,
        paragraphIndex: newIndex,
        mentionText: mention.sourceText,
      };
    })
    .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention));

  return {
    entities: [...params.changedExtraction.entities],
    mentions: [...reusedMentions, ...params.changedExtraction.mentions],
    annotations: [],
    locationContainments: [...params.changedExtraction.locationContainments],
  };
}

async function markJobStale(jobId: string) {
  await prisma.analysisJob.update({
    where: { id: jobId },
    data: {
      status: "stale",
      completedAt: new Date(),
      error: null,
    },
  });
}

interface StageMetricInput {
  stage: string;
  startedAt: Date;
  completedAt: Date;
  metadata?: Record<string, unknown>;
}

async function persistStageMetric(jobId: string, metric: StageMetricInput) {
  const durationMs = Math.max(0, metric.completedAt.getTime() - metric.startedAt.getTime());

  try {
    await prisma.analysisJobStageMetric.create({
      data: {
        analysisJobId: jobId,
        stage: metric.stage,
        startedAt: metric.startedAt,
        completedAt: metric.completedAt,
        durationMs,
        metadata: metric.metadata === undefined ? null : (metric.metadata as any),
      },
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        jobId,
        stage: metric.stage,
      },
      "Failed to persist stage metric"
    );
  }
}

function isContentFilterExtractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("finish_reason=content_filter");
}

function wouldCreateCycle(childId: string, parentId: string, parentByChildId: Map<string, string>): boolean {
  if (childId === parentId) return true;

  const visited = new Set<string>();
  let cursor: string | undefined = parentId;

  while (cursor) {
    if (cursor === childId) return true;
    if (visited.has(cursor)) return true;

    visited.add(cursor);
    cursor = parentByChildId.get(cursor);
  }

  return false;
}

async function persistModelCallTrace(jobId: string, trace: ExtractionModelCallTrace) {
  try {
    await prisma.analysisModelCall.create({
      data: {
        analysisJobId: jobId,
        phase: trace.phase,
        extractionMode: trace.extractionMode,
        batchIndex: trace.batchIndex,
        targetParagraphIndices: trace.targetParagraphIndices,
        model: trace.model,
        attempt: trace.attempt,
        finishReason: trace.finishReason,
        prompt: trace.prompt,
        rawResponse: trace.rawResponse,
        jsonCandidate: trace.jsonCandidate || null,
        normalizedPayload:
          trace.normalizedPayload === null || trace.normalizedPayload === undefined
            ? null
            : (trace.normalizedPayload as any),
        parseError: trace.parseError,
        requestStartedAt: trace.requestStartedAt,
        requestCompletedAt: trace.requestCompletedAt,
        durationMs: trace.durationMs,
      },
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        jobId,
        phase: trace.phase,
        extractionMode: trace.extractionMode,
        batchIndex: trace.batchIndex,
      },
      "Failed to persist model call trace"
    );
  }
}

function getKnownEntityIdFromRef(entityRef: string): string | null {
  if (!entityRef.startsWith("known:")) return null;
  const raw = entityRef.slice("known:".length).trim();
  return raw.length > 0 ? raw : null;
}

async function persistFullMentionsBatchPreview(params: {
  projectId: string;
  documentId: string;
  contentVersion: number;
  targetParagraphIndices: number[];
  mentions: ExtractionResult["mentions"];
  initializedRef: { value: boolean };
  resolvedByRef: Map<string, ResolvedEntityLink>;
  resolvedByTypeAndName: Map<string, ResolvedEntityLink>;
}) {
  const targetParagraphIndices = Array.from(new Set(params.targetParagraphIndices))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
  if (!targetParagraphIndices.length) {
    return;
  }

  const targetSet = new Set(targetParagraphIndices);
  const scopedMentions = params.mentions.filter((mention) => targetSet.has(mention.paragraphIndex));

  await prisma.$transaction(async (tx: any) => {
    const freshDocument = await tx.document.findUnique({
      where: { id: params.documentId },
      select: {
        id: true,
        content: true,
        contentVersion: true,
      },
    });

    if (!freshDocument) {
      return;
    }

    if (freshDocument.contentVersion !== params.contentVersion) {
      return;
    }

    const resolveEntityByTypeAndName = async (type: EntityType, name: string): Promise<ResolvedEntityLink | null> => {
      const normalizedName = normalizeEntityName(name);
      if (!normalizedName) return null;

      const typeNameKey = `${type}::${normalizedName}`;
      const cached = params.resolvedByTypeAndName.get(typeNameKey);
      if (cached) return cached;

      const existing = await tx.entity.findFirst({
        where: {
          projectId: params.projectId,
          type,
          normalizedName,
        },
        select: {
          id: true,
          type: true,
          name: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const resolved = existing
        ? {
            id: existing.id,
            type: existing.type,
            name: existing.name,
          }
        : await tx.entity.create({
            data: {
              projectId: params.projectId,
              type,
              name,
              normalizedName,
              summary: "",
            },
            select: {
              id: true,
              type: true,
              name: true,
            },
          });

      const link: ResolvedEntityLink = {
        id: resolved.id,
        type: resolved.type,
        name: resolved.name,
      };

      params.resolvedByTypeAndName.set(typeNameKey, link);
      return link;
    };

    const resolveEntityByRef = async (
      entityRef: string,
      fallbackType: EntityType,
      fallbackName: string
    ): Promise<ResolvedEntityLink | null> => {
      const cached = params.resolvedByRef.get(entityRef);
      if (cached) return cached;

      const knownEntityId = getKnownEntityIdFromRef(entityRef);
      if (knownEntityId) {
        const known = await tx.entity.findFirst({
          where: {
            id: knownEntityId,
            projectId: params.projectId,
          },
          select: {
            id: true,
            type: true,
            name: true,
          },
        });

        if (!known) {
          return null;
        }

        const knownLink: ResolvedEntityLink = {
          id: known.id,
          type: known.type,
          name: known.name,
        };

        params.resolvedByRef.set(entityRef, knownLink);
        const knownKey = `${known.type}::${normalizeEntityName(known.name)}`;
        if (!params.resolvedByTypeAndName.has(knownKey)) {
          params.resolvedByTypeAndName.set(knownKey, knownLink);
        }
        return knownLink;
      }

      const resolved = await resolveEntityByTypeAndName(fallbackType, fallbackName);
      if (resolved) {
        params.resolvedByRef.set(entityRef, resolved);
      }
      return resolved;
    };

    if (!params.initializedRef.value) {
      await tx.mention.deleteMany({
        where: {
          documentId: params.documentId,
        },
      });

      await tx.annotation.deleteMany({
        where: {
          documentId: params.documentId,
        },
      });

      params.initializedRef.value = true;
    }

    const resolvedMentionOffsets = resolveMentionOffsets(freshDocument.content, scopedMentions);
    const mentionRows: Array<{
      entityId: string;
      documentId: string;
      startOffset: number;
      endOffset: number;
      paragraphIndex: number;
      sourceText: string;
    }> = [];

    for (const mention of resolvedMentionOffsets) {
      const resolvedEntity = await resolveEntityByRef(mention.entityRef, mention.type, mention.name);
      if (!resolvedEntity) continue;

      mentionRows.push({
        entityId: resolvedEntity.id,
        documentId: params.documentId,
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
        paragraphIndex: mention.paragraphIndex,
        sourceText: mention.sourceText,
      });
    }

    await tx.mention.deleteMany({
      where: {
        documentId: params.documentId,
        paragraphIndex: {
          in: targetParagraphIndices,
        },
      },
    });

    if (mentionRows.length) {
      await tx.mention.createMany({
        data: mentionRows,
      });
    }

    await tx.annotation.deleteMany({
      where: {
        documentId: params.documentId,
        paragraphIndex: {
          in: targetParagraphIndices,
        },
      },
    });

    await tx.document.update({
      where: {
        id: params.documentId,
      },
      data: {
        analysisStatus: "running",
      },
    });
  });
}

export async function processDocumentExtract(payload: DocumentExtractPayload) {
  const job = await prisma.analysisJob.findUnique({
    where: { id: payload.jobId },
  });

  if (!job) {
    logger.warn({ payload }, "Skip document extract: job not found");
    return;
  }

  if (job.status !== "queued" && job.status !== "running") {
    logger.warn({ jobId: job.id, status: job.status }, "Skip document extract: job already finalized");
    return;
  }

  const processingStartedAt = new Date();
  let processingOutcome: "completed" | "failed" | "stale" = "failed";

  await prisma.analysisJob.update({
    where: { id: payload.jobId },
    data: {
      status: "running",
      startedAt: processingStartedAt,
      error: null,
    },
  });

  await persistStageMetric(payload.jobId, {
    stage: "queue_wait",
    startedAt: job.createdAt,
    completedAt: processingStartedAt,
    metadata: {
      queuedAt: job.createdAt.toISOString(),
      startedAt: processingStartedAt.toISOString(),
    },
  });

  const loadDocumentStartedAt = new Date();
  const document = await prisma.document.findUnique({
    where: { id: payload.documentId },
    select: {
      id: true,
      projectId: true,
      content: true,
      contentVersion: true,
      lastAnalyzedContent: true,
    },
  });
  const loadDocumentCompletedAt = new Date();

  await persistStageMetric(payload.jobId, {
    stage: "load_document",
    startedAt: loadDocumentStartedAt,
    completedAt: loadDocumentCompletedAt,
    metadata: {
      found: Boolean(document),
    },
  });

  if (!document) {
    await prisma.analysisJob.update({
      where: { id: payload.jobId },
      data: {
        status: "failed",
        error: "Document not found",
        completedAt: new Date(),
      },
    });
    processingOutcome = "failed";
    await persistStageMetric(payload.jobId, {
      stage: "processing_total",
      startedAt: processingStartedAt,
      completedAt: new Date(),
      metadata: {
        outcome: processingOutcome,
      },
    });
    return;
  }

  if (document.contentVersion !== payload.contentVersion) {
    await markJobStale(payload.jobId);
    processingOutcome = "stale";
    await persistStageMetric(payload.jobId, {
      stage: "processing_total",
      startedAt: processingStartedAt,
      completedAt: new Date(),
      metadata: {
        outcome: processingOutcome,
      },
    });
    return;
  }

  await prisma.document.updateMany({
    where: {
      id: payload.documentId,
      contentVersion: payload.contentVersion,
    },
    data: {
      analysisStatus: "running",
    },
  });

  try {
    const diffStartedAt = new Date();
    const diff = buildParagraphDiff(document.lastAnalyzedContent, document.content);
    const diffCompletedAt = new Date();

    await persistStageMetric(payload.jobId, {
      stage: "paragraph_diff",
      startedAt: diffStartedAt,
      completedAt: diffCompletedAt,
      metadata: {
        mode: diff.mode,
        algorithm: diff.algorithm,
        reason: diff.reason,
        confidence: Number(diff.confidence.toFixed(4)),
        oldParagraphCount: diff.oldParagraphCount,
        newParagraphCount: diff.newParagraphCount,
        changedParagraphs: diff.changedNewIndices.length,
      },
    });

    const traceSink: ExtractionTraceSink = (trace) => persistModelCallTrace(payload.jobId, trace);
    let projectKnownEntities: KnownProjectEntity[] = [];

    const knownEntitiesStartedAt = new Date();
    if (diff.mode === "full" || diff.changedNewIndices.length > 0) {
      const knownEntities = await prisma.entity.findMany({
        where: {
          projectId: payload.projectId,
        },
        select: {
          id: true,
          type: true,
          name: true,
          summary: true,
          containedByLinks: {
            take: 1,
            select: {
              parentEntity: {
                select: {
                  id: true,
                  type: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      projectKnownEntities = knownEntities.map((entity: any) => {
        const container = entity.containedByLinks[0]?.parentEntity;

        return {
          entityRef: toKnownEntityRef(entity.id),
          type: entity.type,
          name: entity.name,
          summary: entity.summary || "",
          ...(container?.id
            ? {
                container: {
                  entityRef: toKnownEntityRef(container.id),
                  name: container.name,
                },
              }
            : {}),
        };
      });
    }
    const knownEntitiesCompletedAt = new Date();

    await persistStageMetric(payload.jobId, {
      stage: "load_known_entities",
      startedAt: knownEntitiesStartedAt,
      completedAt: knownEntitiesCompletedAt,
      metadata: {
        requested: diff.mode === "full" || diff.changedNewIndices.length > 0,
        knownEntityCount: projectKnownEntities.length,
      },
    });

    let changedExtraction = emptyExtraction();
    let fullExtraction: ExtractionResult | null = null;
    let skipExtractionWrite = false;
    let staleDuringTransaction = false;
    let extractionFallback: "none" | "incremental_content_filter" | "full_to_incremental_content_filter" | "skip_write" =
      "none";
    const extractionStartedAt = new Date();
    const fullParagraphCount = splitParagraphs(document.content).length;
    const fullMentionsPreviewInitialized = { value: false };
    const fullMentionsPreviewResolvedByRef = new Map<string, ResolvedEntityLink>();
    const fullMentionsPreviewResolvedByTypeAndName = new Map<string, ResolvedEntityLink>();
    const fullMentionsProcessedParagraphIndices = new Set<number>();
    let fullMentionsPreviewPersistChain: Promise<void> = Promise.resolve();

    if (diff.mode === "incremental") {
      if (diff.changedNewIndices.length > 0) {
        try {
          changedExtraction = await runExtractionIncremental(
            {
              content: document.content,
              changedParagraphIndices: diff.changedNewIndices,
              knownEntities: projectKnownEntities,
            },
            { traceSink }
          );
        } catch (error) {
          if (!isContentFilterExtractionError(error)) {
            throw error;
          }

          logger.warn(
            {
              jobId: payload.jobId,
              projectId: payload.projectId,
              contentVersion: payload.contentVersion,
              changedParagraphs: diff.changedNewIndices.length,
            },
            "Incremental extraction blocked by content filter, reusing unchanged snapshot only"
          );

          changedExtraction = emptyExtraction();
          extractionFallback = "incremental_content_filter";
        }
      }
    } else {
      try {
        fullExtraction = await runExtraction(document.content, {
          traceSink,
          knownEntities: projectKnownEntities,
          onFullMentionsBatch: async (batchPayload) => {
            const runPersist = async () => {
              const batchPersistStartedAt = new Date();

              try {
                await persistFullMentionsBatchPreview({
                  projectId: payload.projectId,
                  documentId: payload.documentId,
                  contentVersion: payload.contentVersion,
                  targetParagraphIndices: batchPayload.targetParagraphIndices,
                  mentions: batchPayload.mentions,
                  initializedRef: fullMentionsPreviewInitialized,
                  resolvedByRef: fullMentionsPreviewResolvedByRef,
                  resolvedByTypeAndName: fullMentionsPreviewResolvedByTypeAndName,
                });

                for (const paragraphIndex of batchPayload.targetParagraphIndices) {
                  fullMentionsProcessedParagraphIndices.add(paragraphIndex);
                }
              } catch (error) {
                logger.warn(
                  {
                    err: error,
                    jobId: payload.jobId,
                    batchIndex: batchPayload.batchIndex,
                    targetParagraphIndices: batchPayload.targetParagraphIndices,
                  },
                  "Failed to persist partial full-mentions preview batch"
                );
              } finally {
                await persistStageMetric(payload.jobId, {
                  stage: "partial_preview_persist",
                  startedAt: batchPersistStartedAt,
                  completedAt: new Date(),
                  metadata: {
                    mode: "full",
                    batchIndex: batchPayload.batchIndex,
                    targetParagraphs: batchPayload.targetParagraphIndices.length,
                    processedParagraphs: fullMentionsProcessedParagraphIndices.size,
                    totalParagraphs: fullParagraphCount,
                  },
                });
              }
            };

            fullMentionsPreviewPersistChain = fullMentionsPreviewPersistChain.then(runPersist, runPersist);
            await fullMentionsPreviewPersistChain;
          },
        });
      } catch (error) {
        if (!isContentFilterExtractionError(error)) {
          throw error;
        }

        const fullParagraphIndices = splitParagraphs(document.content).map((paragraph) => paragraph.index);

        logger.warn(
          {
            jobId: payload.jobId,
            projectId: payload.projectId,
            contentVersion: payload.contentVersion,
          },
          "Full extraction blocked by content filter, retrying with chunked incremental fallback"
        );
        extractionFallback = "full_to_incremental_content_filter";

        try {
          fullExtraction = await runExtractionIncremental(
            {
              content: document.content,
              changedParagraphIndices: fullParagraphIndices,
              knownEntities: projectKnownEntities,
            },
            { traceSink }
          );
        } catch (fallbackError) {
          if (!isContentFilterExtractionError(fallbackError)) {
            throw fallbackError;
          }

          logger.warn(
            {
              jobId: payload.jobId,
              projectId: payload.projectId,
              contentVersion: payload.contentVersion,
            },
            "Chunked fallback also blocked by content filter, keeping previous extraction snapshot"
          );

          skipExtractionWrite = true;
          extractionFallback = "skip_write";
        }
      }
    }

    const extractionCompletedAt = new Date();
    await persistStageMetric(payload.jobId, {
      stage: "extraction",
      startedAt: extractionStartedAt,
      completedAt: extractionCompletedAt,
      metadata: {
        requestedMode: diff.mode,
        changedParagraphs: diff.changedNewIndices.length,
        skipExtractionWrite,
        fallback: extractionFallback,
        partialPreviewParagraphs:
          diff.mode === "full" ? fullMentionsProcessedParagraphIndices.size : diff.changedNewIndices.length,
        totalParagraphs: diff.mode === "full" ? fullParagraphCount : diff.changedNewIndices.length,
      },
    });

    const persistStartedAt = new Date();
    await prisma.$transaction(async (tx: any) => {
      const freshDocument = await tx.document.findUnique({
        where: { id: payload.documentId },
        select: {
          id: true,
          content: true,
          contentVersion: true,
          mentions: {
            select: {
              paragraphIndex: true,
              sourceText: true,
              entity: {
                select: {
                  id: true,
                  type: true,
                  name: true,
                },
              },
            },
            orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
          },
        },
      });

      if (!freshDocument) {
        throw new Error("Document disappeared during extraction transaction");
      }

      if (freshDocument.contentVersion !== payload.contentVersion) {
        await tx.analysisJob.update({
          where: { id: payload.jobId },
          data: {
            status: "stale",
            completedAt: new Date(),
            error: null,
          },
        });
        staleDuringTransaction = true;
        processingOutcome = "stale";
        return;
      }

      if (diff.mode === "full" && !fullExtraction) {
        if (!skipExtractionWrite) {
          throw new Error("Missing full extraction payload");
        }
      }

      if (skipExtractionWrite) {
        await tx.document.update({
          where: {
            id: payload.documentId,
          },
          data: {
            analysisStatus: "completed",
            lastAnalyzedVersion: payload.contentVersion,
            lastAnalyzedContent: freshDocument.content,
          },
        });

        await tx.analysisJob.update({
          where: { id: payload.jobId },
          data: {
            status: "completed",
            error: null,
            completedAt: new Date(),
          },
        });

        return;
      }

      const mergedExtraction =
        diff.mode === "incremental"
          ? mergeIncrementalExtraction({
              unchangedMap: diff.unchangedMap,
              changedExtraction,
              existingMentions: freshDocument.mentions,
            })
          : (fullExtraction as ExtractionResult);

      const candidateExtraction = diff.mode === "incremental" ? changedExtraction : mergedExtraction;
      const candidates = orderCandidatesForUpsert(collectEntityCandidates(candidateExtraction));

      const existingEntities = await tx.entity.findMany({
        where: {
          projectId: payload.projectId,
        },
        select: {
          id: true,
          type: true,
          name: true,
          normalizedName: true,
          summary: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const existingContainments = await tx.locationContainment.findMany({
        where: {
          projectId: payload.projectId,
        },
        select: {
          childEntityId: true,
          parentEntityId: true,
        },
      });

      const parentByChildId = new Map<string, string>();
      for (const containment of existingContainments) {
        parentByChildId.set(containment.childEntityId, containment.parentEntityId);
      }

      const entityById = new Map<string, EntityRecord>();
      const entityByRef = new Map<string, ResolvedEntityLink>();
      const entityByCandidateKey = new Map<string, ResolvedEntityLink>();
      const canonicalByTypeAndName = new Map<string, EntityRecord>();
      const locationByParentAndName = new Map<string, EntityRecord>();

      for (const entity of existingEntities) {
        const record: EntityRecord = {
          id: entity.id,
          type: entity.type,
          name: entity.name,
          normalizedName: entity.normalizedName,
          summary: entity.summary || "",
        };

        entityById.set(record.id, record);
        entityByRef.set(toKnownEntityRef(record.id), {
          id: record.id,
          type: record.type,
          name: record.name,
        });

        const fallbackKey = toCandidateKey(record.type, record.name);
        if (!entityByCandidateKey.has(fallbackKey)) {
          entityByCandidateKey.set(fallbackKey, {
            id: record.id,
            type: record.type,
            name: record.name,
          });
        }

        if (record.type === "location") {
          const parentId = parentByChildId.get(record.id) || null;
          const locationKey = parentId ? `${parentId}::${record.normalizedName}` : `ROOT::${record.normalizedName}`;
          if (!locationByParentAndName.has(locationKey)) {
            locationByParentAndName.set(locationKey, record);
          }
          continue;
        }

        const canonicalKey = `${record.type}::${record.normalizedName}`;
        if (!canonicalByTypeAndName.has(canonicalKey)) {
          canonicalByTypeAndName.set(canonicalKey, record);
        }
      }

      const candidateByRef = new Map(candidates.map((candidate) => [candidate.entityRef, candidate] as const));
      const containmentByChildRef = new Map<string, string>();

      for (const containment of candidateExtraction.locationContainments) {
        const childRef = containment.childRef.trim();
        const parentRef = containment.parentRef.trim();
        if (!childRef || !parentRef) continue;
        if (childRef === parentRef) continue;
        containmentByChildRef.set(childRef, parentRef);
      }

      const touchCandidateKey = (entity: { type: EntityType; name: string }, resolved: ResolvedEntityLink) => {
        const candidateKey = toCandidateKey(entity.type, entity.name);
        if (!entityByCandidateKey.has(candidateKey)) {
          entityByCandidateKey.set(candidateKey, resolved);
        }
      };

      const touchEntityRecord = (record: EntityRecord) => {
        entityById.set(record.id, record);

        const knownRef = toKnownEntityRef(record.id);
        if (!entityByRef.has(knownRef)) {
          entityByRef.set(knownRef, {
            id: record.id,
            type: record.type,
            name: record.name,
          });
        }
      };

      const ensureSummary = async (record: EntityRecord, summary: string) => {
        const nextSummary = summary.trim();
        if (!nextSummary || record.summary) return;

        const updated = await tx.entity.update({
          where: { id: record.id },
          data: {
            summary: nextSummary,
          },
          select: {
            id: true,
            type: true,
            name: true,
            normalizedName: true,
            summary: true,
          },
        });

        const nextRecord: EntityRecord = {
          id: updated.id,
          type: updated.type,
          name: updated.name,
          normalizedName: updated.normalizedName,
          summary: updated.summary || "",
        };

        entityById.set(nextRecord.id, nextRecord);
      };

      const createEntityRecord = async (params: {
        type: EntityType;
        name: string;
        normalizedName: string;
        summary: string;
      }): Promise<EntityRecord> => {
        const created = await tx.entity.create({
          data: {
            projectId: payload.projectId,
            type: params.type,
            name: params.name,
            normalizedName: params.normalizedName,
            summary: params.summary,
          },
          select: {
            id: true,
            type: true,
            name: true,
            normalizedName: true,
            summary: true,
          },
        });

        const record: EntityRecord = {
          id: created.id,
          type: created.type,
          name: created.name,
          normalizedName: created.normalizedName,
          summary: created.summary || "",
        };

        touchEntityRecord(record);
        touchCandidateKey({ type: record.type, name: record.name }, { id: record.id, type: record.type, name: record.name });

        return record;
      };

      const resolveEntityByRef = async (entityRef: string, stack: string[] = []): Promise<ResolvedEntityLink | null> => {
        const direct = entityByRef.get(entityRef);
        if (direct) return direct;

        const candidate = candidateByRef.get(entityRef);
        if (!candidate) return null;

        const normalizedName = normalizeEntityName(candidate.name);
        if (!normalizedName) return null;

        if (candidate.type !== "location") {
          const canonicalKey = `${candidate.type}::${normalizedName}`;
          let record = canonicalByTypeAndName.get(canonicalKey);

          if (!record) {
            record = await createEntityRecord({
              type: candidate.type,
              name: candidate.name,
              normalizedName,
              summary: candidate.summary,
            });
            canonicalByTypeAndName.set(canonicalKey, record);
          } else {
            await ensureSummary(record, candidate.summary);
            record = entityById.get(record.id) || record;
          }

          const resolved: ResolvedEntityLink = {
            id: record.id,
            type: record.type,
            name: record.name,
          };

          entityByRef.set(entityRef, resolved);
          touchCandidateKey(candidate, resolved);
          return resolved;
        }

        let parentId: string | null = null;
        const parentRef = containmentByChildRef.get(entityRef);

        if (parentRef) {
          if (parentRef === entityRef || stack.includes(parentRef)) {
            logger.warn(
              {
                jobId: payload.jobId,
                entityRef,
                parentRef,
              },
              "Cycle detected in extraction refs, dropping containment relation"
            );
          } else {
            const resolvedParent = await resolveEntityByRef(parentRef, [...stack, entityRef]);
            if (resolvedParent?.type === "location") {
              parentId = resolvedParent.id;
            }
          }
        }

        const locationKey = parentId ? `${parentId}::${normalizedName}` : `ROOT::${normalizedName}`;
        let record = locationByParentAndName.get(locationKey);

        if (!record) {
          record = await createEntityRecord({
            type: "location",
            name: candidate.name,
            normalizedName,
            summary: candidate.summary,
          });
          locationByParentAndName.set(locationKey, record);
        } else {
          await ensureSummary(record, candidate.summary);
          record = entityById.get(record.id) || record;
        }

        const resolved: ResolvedEntityLink = {
          id: record.id,
          type: record.type,
          name: record.name,
        };

        entityByRef.set(entityRef, resolved);
        touchCandidateKey(candidate, resolved);
        return resolved;
      };

      for (const candidate of candidates) {
        await resolveEntityByRef(candidate.entityRef);
      }

      const touchedLocationRefs = new Set<string>();
      for (const candidate of candidates) {
        if (candidate.type === "location") {
          touchedLocationRefs.add(candidate.entityRef);
        }
      }
      for (const containment of candidateExtraction.locationContainments) {
        touchedLocationRefs.add(containment.childRef);
      }

      for (const childRef of touchedLocationRefs) {
        const childEntity = await resolveEntityByRef(childRef);
        if (!childEntity || childEntity.type !== "location") continue;

        const desiredParentRef = containmentByChildRef.get(childRef) || null;
        const desiredParentEntity = desiredParentRef ? await resolveEntityByRef(desiredParentRef) : null;
        const desiredParentId = desiredParentEntity?.type === "location" ? desiredParentEntity.id : null;
        const currentParentId = parentByChildId.get(childEntity.id) || null;

        if (!desiredParentId) {
          if (currentParentId) {
            await tx.locationContainment.deleteMany({
              where: {
                childEntityId: childEntity.id,
              },
            });
            parentByChildId.delete(childEntity.id);
          }
          continue;
        }

        if (wouldCreateCycle(childEntity.id, desiredParentId, parentByChildId)) {
          logger.warn(
            {
              jobId: payload.jobId,
              childEntityId: childEntity.id,
              parentEntityId: desiredParentId,
            },
            "Skipped location containment update because it would create a cycle"
          );
          continue;
        }

        if (currentParentId === desiredParentId) {
          continue;
        }

        if (currentParentId) {
          await tx.locationContainment.update({
            where: {
              childEntityId: childEntity.id,
            },
            data: {
              parentEntityId: desiredParentId,
            },
          });
        } else {
          await tx.locationContainment.create({
            data: {
              projectId: payload.projectId,
              childEntityId: childEntity.id,
              parentEntityId: desiredParentId,
            },
          });
        }

        parentByChildId.set(childEntity.id, desiredParentId);

        const childRecord = entityById.get(childEntity.id);
        if (childRecord) {
          const locationKey = `${desiredParentId}::${childRecord.normalizedName}`;
          if (!locationByParentAndName.has(locationKey)) {
            locationByParentAndName.set(locationKey, childRecord);
          }
        }
      }

      const expandedMentions = expandUnambiguousCharacterMentions(freshDocument.content, mergedExtraction.mentions);

      const resolvedMentions = resolveMentionOffsets(freshDocument.content, expandedMentions)
        .map((mention) => {
          const byRef = entityByRef.get(mention.entityRef);
          const byFallback = entityByCandidateKey.get(toCandidateKey(mention.type, mention.name));
          const entity = byRef || byFallback;

          if (!entity) return null;

          return {
            entityId: entity.id,
            documentId: payload.documentId,
            startOffset: mention.startOffset,
            endOffset: mention.endOffset,
            paragraphIndex: mention.paragraphIndex,
            sourceText: mention.sourceText,
          };
        })
        .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention));

      await tx.mention.deleteMany({
        where: {
          documentId: payload.documentId,
        },
      });

      if (resolvedMentions.length) {
        await tx.mention.createMany({
          data: resolvedMentions,
        });
      }

      await tx.annotation.deleteMany({
        where: {
          documentId: payload.documentId,
        },
      });

      await tx.entity.deleteMany({
        where: {
          projectId: payload.projectId,
          mentions: {
            none: {},
          },
          containerLinks: {
            none: {},
          },
        },
      });

      await tx.document.update({
        where: {
          id: payload.documentId,
        },
        data: {
          analysisStatus: "completed",
          lastAnalyzedVersion: payload.contentVersion,
          lastAnalyzedContent: freshDocument.content,
        },
      });

      await tx.analysisJob.update({
        where: { id: payload.jobId },
        data: {
          status: "completed",
          error: null,
          completedAt: new Date(),
        },
      });
    });
    const persistCompletedAt = new Date();

    await persistStageMetric(payload.jobId, {
      stage: "persist_results",
      startedAt: persistStartedAt,
      completedAt: persistCompletedAt,
      metadata: {
        skipExtractionWrite,
        staleDuringTransaction,
      },
    });

    if (staleDuringTransaction) {
      return;
    }

    logger.info(
      {
        jobId: payload.jobId,
        projectId: payload.projectId,
        contentVersion: payload.contentVersion,
        extractionMode: diff.mode,
        diffAlgorithm: diff.algorithm,
        diffConfidence: Number(diff.confidence.toFixed(4)),
        changedParagraphs: diff.changedNewIndices.length,
        diffReason: diff.reason,
      },
      "Document extract completed"
    );
    processingOutcome = "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error";

    await prisma.$transaction(async (tx: any) => {
      await tx.analysisJob.update({
        where: { id: payload.jobId },
        data: {
          status: "failed",
          error: message.slice(0, 1000),
          completedAt: new Date(),
        },
      });

      await tx.document.updateMany({
        where: {
          id: payload.documentId,
          contentVersion: payload.contentVersion,
        },
        data: {
          analysisStatus: "failed",
        },
      });
    });

    logger.error(
      {
        err: error,
        jobId: payload.jobId,
        projectId: payload.projectId,
        contentVersion: payload.contentVersion,
      },
      "Document extract failed"
    );
    processingOutcome = "failed";
  } finally {
    await persistStageMetric(payload.jobId, {
      stage: "processing_total",
      startedAt: processingStartedAt,
      completedAt: new Date(),
      metadata: {
        outcome: processingOutcome,
      },
    });
  }
}
