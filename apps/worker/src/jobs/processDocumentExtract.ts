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

interface AnnotationSnapshot {
  paragraphIndex: number;
  type: EntityType;
  label: string;
  entity: {
    id: string;
    name: string;
  } | null;
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
  existingAnnotations: AnnotationSnapshot[];
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

  const reusedAnnotations = params.existingAnnotations
    .map((annotation) => {
      const newIndex = newByOld.get(annotation.paragraphIndex);
      if (newIndex === undefined) return null;

      return {
        ...(annotation.entity?.id ? { entityRef: toKnownEntityRef(annotation.entity.id) } : {}),
        paragraphIndex: newIndex,
        type: annotation.type,
        label: annotation.label,
        ...(annotation.entity?.name ? { name: annotation.entity.name } : {}),
      };
    })
    .filter((annotation): annotation is NonNullable<typeof annotation> => Boolean(annotation));

  return {
    entities: [...params.changedExtraction.entities],
    mentions: [...reusedMentions, ...params.changedExtraction.mentions],
    annotations: [...reusedAnnotations, ...params.changedExtraction.annotations],
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
        prompt: trace.prompt,
        rawResponse: trace.rawResponse,
        jsonCandidate: trace.jsonCandidate || null,
        normalizedPayload:
          trace.normalizedPayload === null || trace.normalizedPayload === undefined
            ? null
            : (trace.normalizedPayload as any),
        parseError: trace.parseError,
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

  await prisma.analysisJob.update({
    where: { id: payload.jobId },
    data: {
      status: "running",
      startedAt: new Date(),
      error: null,
    },
  });

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

  if (!document) {
    await prisma.analysisJob.update({
      where: { id: payload.jobId },
      data: {
        status: "failed",
        error: "Document not found",
        completedAt: new Date(),
      },
    });
    return;
  }

  if (document.contentVersion !== payload.contentVersion) {
    await markJobStale(payload.jobId);
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
    const diff = buildParagraphDiff(document.lastAnalyzedContent, document.content);
    const traceSink: ExtractionTraceSink = (trace) => persistModelCallTrace(payload.jobId, trace);

    let changedExtraction = emptyExtraction();
    let fullExtraction: ExtractionResult | null = null;
    let skipExtractionWrite = false;

    if (diff.mode === "incremental") {
      if (diff.changedNewIndices.length > 0) {
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

        const registry: KnownProjectEntity[] = knownEntities.map((entity: any) => {
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

        try {
          changedExtraction = await runExtractionIncremental(
            {
              content: document.content,
              changedParagraphIndices: diff.changedNewIndices,
              knownEntities: registry,
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
        }
      }
    } else {
      try {
        fullExtraction = await runExtraction(document.content, { traceSink });
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

        try {
          fullExtraction = await runExtractionIncremental(
            {
              content: document.content,
              changedParagraphIndices: fullParagraphIndices,
              knownEntities: [],
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
        }
      }
    }

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
          annotations: {
            select: {
              paragraphIndex: true,
              type: true,
              label: true,
              entity: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
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
              existingAnnotations: freshDocument.annotations,
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

      const annotations = mergedExtraction.annotations
        .map((annotation) => {
          const entityByRefLink = annotation.entityRef ? entityByRef.get(annotation.entityRef) : null;
          const entityByName = annotation.name
            ? entityByCandidateKey.get(toCandidateKey(annotation.type, annotation.name))
            : null;
          const linkedEntity = entityByRefLink || entityByName;

          return {
            documentId: payload.documentId,
            paragraphIndex: annotation.paragraphIndex,
            entityId: linkedEntity?.id || null,
            type: annotation.type,
            label: annotation.label,
          };
        })
        .filter((annotation) => annotation.label.trim().length > 0);

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

      if (annotations.length) {
        await tx.annotation.createMany({
          data: annotations,
        });
      }

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
  }
}
