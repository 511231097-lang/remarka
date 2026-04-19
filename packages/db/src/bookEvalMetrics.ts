import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

type JsonRecord = Record<string, unknown>;

export interface BookEvalHeadEntitySample {
  id: string;
  canonicalName: string;
  type: string;
  status: string;
  supportCount: number;
  aliasCount: number;
  duplicateRisk: boolean;
  duplicateMatches: string[];
}

export interface BookEvalSnapshot {
  book: {
    id: string;
    title: string;
    author: string | null;
  };
  analysis: {
    contentVersionId: string;
    analysisVersion: number;
    coverage: "full" | "partial" | "unknown";
  };
  counts: {
    chapters: number;
    paragraphs: number;
    windows: number;
    observations: number;
    validObservations: number;
    invalidObservations: number;
    entities: number;
    ambiguousEntities: number;
    scenes: number;
    events: number;
    relations: number;
    quotes: number;
    evidenceHits: number;
    presenceMaps: number;
    validationFailures: number;
  };
  metrics: {
    validationFailureRate: number | null;
    invalidObservationRate: number | null;
    ambiguousEntityRatio: number | null;
    singletonEntityRatio: number | null;
    scenesPerChapter: number | null;
    eventsPerScene: number | null;
    sceneSegmentation: {
      fullChapterSceneRatio: number | null;
      chaptersWithMultipleScenesRatio: number | null;
      chaptersWithMultipleScenes: number;
      fullChapterSceneCount: number;
    };
    eventGranularity: {
      scenesWithMultipleEventsRatio: number | null;
      scenesWithMultipleEvents: number;
      microEventSupportAverage: number | null;
    };
    evidenceValidity: {
      evidenceQuoteMismatchCount: number;
      spanOutOfBoundsCount: number;
      invalidPayloadCount: number;
      anchorFailureCount: number;
    };
    evidenceHitUsefulnessProxy: {
      usefulHitRatio: number | null;
      hitsWithSpanRatio: number | null;
      hitsWithLinkedObjectsRatio: number | null;
      hitsWithSnippetRatio: number | null;
      averageLinkedObjectsPerHit: number | null;
    };
    topEntityPurityProxy: {
      topN: number;
      cleanEntityRatio: number | null;
      duplicateRiskCount: number;
      ambiguousHeadCount: number;
      samples: BookEvalHeadEntitySample[];
    };
  };
  validationFailureBreakdown: Array<{
    code: string;
    count: number;
  }>;
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function roundMetric(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return roundMetric(numerator / denominator);
}

function toRecord(value: Prisma.JsonValue | null | undefined): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeNameForEval(value: string): string {
  return compactWhitespace(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigramSet(value: string): Set<string> {
  const normalized = normalizeNameForEval(value).replace(/\s+/g, " ");
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const out = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    out.add(normalized.slice(index, index + 2));
  }
  return out;
}

function diceCoefficient(left: string, right: string): number {
  const leftSet = bigramSet(left);
  const rightSet = bigramSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1;
  }
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function parseSpanCount(value: Prisma.JsonValue | null | undefined): number {
  if (Array.isArray(value)) {
    return value.filter((item) => Boolean(toRecord(item as Prisma.JsonValue))).length;
  }
  return toRecord(value) ? 1 : 0;
}

function isPotentialHeadDuplicate(params: {
  canonicalName: string;
  aliases: string[];
  type: string;
  otherCanonicalName: string;
  otherAliases: string[];
  otherType: string;
}): boolean {
  if (params.type !== params.otherType) return false;

  const selfNames = [params.canonicalName, ...params.aliases].map((item) => normalizeNameForEval(item)).filter(Boolean);
  const otherNames = [params.otherCanonicalName, ...params.otherAliases]
    .map((item) => normalizeNameForEval(item))
    .filter(Boolean);

  for (const left of selfNames) {
    for (const right of otherNames) {
      if (!left || !right || left === right) return true;
      if (diceCoefficient(left, right) >= 0.88) return true;
      if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) return true;
    }
  }

  return false;
}

function parseCoverage(value: unknown): "full" | "partial" | "unknown" {
  if (value === "full" || value === "partial") return value;
  return "unknown";
}

export async function computeBookEvalSnapshot(params: {
  bookId: string;
  contentVersionId?: string | null;
  topEntityCount?: number;
}): Promise<BookEvalSnapshot> {
  const book = await prisma.book.findUnique({
    where: { id: params.bookId },
    select: {
      id: true,
      title: true,
      author: true,
    },
  });

  if (!book) {
    throw new Error(`Book ${params.bookId} not found`);
  }

  const contentVersion =
    (params.contentVersionId
      ? await prisma.bookContentVersion.findUnique({
          where: { id: params.contentVersionId },
          select: { id: true, version: true },
        })
      : null) ||
    (await prisma.bookContentVersion.findFirst({
      where: { bookId: params.bookId },
      orderBy: [{ version: "desc" }],
      select: { id: true, version: true },
    }));

  if (!contentVersion) {
    throw new Error(`No content version found for book ${params.bookId}`);
  }

  const topEntityCount = Math.max(1, Math.min(50, params.topEntityCount || 20));

  const [
    processingReport,
    validationBreakdown,
    sourceChapters,
    sourceParagraphCount,
    windowCount,
    observationCount,
    validObservationCount,
    invalidObservationCount,
    entityRows,
    scenes,
    events,
    relationCount,
    quoteCount,
    evidenceHitRows,
    presenceMapCount,
    validationFailureCount,
  ] = await Promise.all([
    prisma.bookProcessingReport.findUnique({
      where: { contentVersionId: contentVersion.id },
      select: {
        coverage: true,
      },
    }),
    prisma.bookValidationFailure.groupBy({
      by: ["code"],
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      _count: { code: true },
      orderBy: { _count: { code: "desc" } },
    }),
    prisma.bookSourceChapter.findMany({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      select: { id: true, paragraphStart: true, paragraphEnd: true },
      orderBy: [{ orderIndex: "asc" }],
    }),
    prisma.bookSourceParagraph.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookAnalysisWindow.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookObservation.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookObservation.count({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id, validationStatus: "valid" },
    }),
    prisma.bookObservation.count({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id, validationStatus: "invalid" },
    }),
    prisma.bookCanonicalEntity.findMany({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      select: {
        id: true,
        type: true,
        canonicalName: true,
        aliasesJson: true,
        status: true,
        supportingObservationIds: true,
      },
    }),
    prisma.bookCanonicalScene.findMany({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      select: { id: true, sourceChapterId: true, paragraphStart: true, paragraphEnd: true },
    }),
    prisma.bookCanonicalEvent.findMany({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      select: { id: true, sceneId: true, metadataJson: true, supportingObservationIds: true },
    }),
    prisma.bookCanonicalRelation.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookCanonicalQuote.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookEvidenceHit.findMany({
      where: { bookId: params.bookId, contentVersionId: contentVersion.id },
      select: {
        linkedObjectIds: true,
        spanRefJson: true,
        snippet: true,
      },
    }),
    prisma.bookPresenceMap.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
    prisma.bookValidationFailure.count({ where: { bookId: params.bookId, contentVersionId: contentVersion.id } }),
  ]);

  const ambiguousEntityCount = entityRows.filter((row) => row.status === "ambiguous").length;
  const singletonEntityCount = entityRows.filter((row) => row.supportingObservationIds.length <= 1).length;
  const sceneCount = scenes.length;
  const eventCount = events.length;
  const sourceChapterCount = sourceChapters.length;

  const rankedEntities = entityRows
    .map((row) => ({
      id: row.id,
      type: row.type,
      canonicalName: row.canonicalName,
      aliases: toStringArray(row.aliasesJson),
      status: row.status,
      supportCount: row.supportingObservationIds.length,
    }))
    .sort((left, right) => right.supportCount - left.supportCount || left.canonicalName.localeCompare(right.canonicalName, "ru"));

  const headEntities = rankedEntities.slice(0, topEntityCount);
  const headSamples: BookEvalHeadEntitySample[] = headEntities.map((entity) => {
    const duplicateMatches = rankedEntities
      .filter((candidate) => candidate.id !== entity.id)
      .filter((candidate) =>
        isPotentialHeadDuplicate({
          canonicalName: entity.canonicalName,
          aliases: entity.aliases,
          type: entity.type,
          otherCanonicalName: candidate.canonicalName,
          otherAliases: candidate.aliases,
          otherType: candidate.type,
        })
      )
      .slice(0, 5)
      .map((candidate) => candidate.canonicalName);

    return {
      id: entity.id,
      canonicalName: entity.canonicalName,
      type: entity.type,
      status: entity.status,
      supportCount: entity.supportCount,
      aliasCount: entity.aliases.length,
      duplicateRisk: duplicateMatches.length > 0,
      duplicateMatches,
    };
  });

  const usefulEvidenceHitCount = evidenceHitRows.filter((row) => {
    const linkedCount = row.linkedObjectIds.filter(Boolean).length;
    const spanCount = parseSpanCount(row.spanRefJson);
    const snippetLength = compactWhitespace(row.snippet).length;
    return linkedCount > 0 && spanCount > 0 && snippetLength >= 20;
  }).length;

  const hitsWithSpanCount = evidenceHitRows.filter((row) => parseSpanCount(row.spanRefJson) > 0).length;
  const hitsWithLinkedObjectsCount = evidenceHitRows.filter((row) => row.linkedObjectIds.filter(Boolean).length > 0).length;
  const hitsWithSnippetCount = evidenceHitRows.filter((row) => compactWhitespace(row.snippet).length >= 20).length;
  const linkedObjectsTotal = evidenceHitRows.reduce(
    (sum, row) => sum + row.linkedObjectIds.filter(Boolean).length,
    0
  );
  const eventsBySceneId = new Map<string, number>();
  let microEventSupportTotal = 0;
  for (const event of events) {
    if (event.sceneId) {
      eventsBySceneId.set(event.sceneId, (eventsBySceneId.get(event.sceneId) || 0) + 1);
    }
    const metadata = toRecord(event.metadataJson);
    microEventSupportTotal += Number(metadata?.microEventCount || event.supportingObservationIds.length || 0);
  }
  const fullChapterSceneCount = scenes.filter((scene) =>
    sourceChapters.some(
      (chapter) =>
        chapter.id === scene.sourceChapterId &&
        chapter.paragraphStart === scene.paragraphStart &&
        chapter.paragraphEnd === scene.paragraphEnd
    )
  ).length;
  const chaptersWithMultipleScenes = sourceChapters.filter((chapter) =>
    scenes.filter((scene) => scene.sourceChapterId === chapter.id).length >= 2
  ).length;
  const scenesWithMultipleEvents = scenes.filter((scene) => (eventsBySceneId.get(scene.id) || 0) >= 2).length;
  const validationBreakdownMap = new Map(validationBreakdown.map((row) => [row.code, row._count.code] as const));

  return {
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
    },
    analysis: {
      contentVersionId: contentVersion.id,
      analysisVersion: contentVersion.version,
      coverage: parseCoverage(processingReport?.coverage),
    },
    counts: {
      chapters: sourceChapterCount,
      paragraphs: sourceParagraphCount,
      windows: windowCount,
      observations: observationCount,
      validObservations: validObservationCount,
      invalidObservations: invalidObservationCount,
      entities: entityRows.length,
      ambiguousEntities: ambiguousEntityCount,
      scenes: sceneCount,
      events: eventCount,
      relations: relationCount,
      quotes: quoteCount,
      evidenceHits: evidenceHitRows.length,
      presenceMaps: presenceMapCount,
      validationFailures: validationFailureCount,
    },
    metrics: {
      validationFailureRate: ratio(validationFailureCount, observationCount),
      invalidObservationRate: ratio(invalidObservationCount, observationCount),
      ambiguousEntityRatio: ratio(ambiguousEntityCount, entityRows.length),
      singletonEntityRatio: ratio(singletonEntityCount, entityRows.length),
      scenesPerChapter: ratio(sceneCount, sourceChapterCount),
      eventsPerScene: ratio(eventCount, sceneCount),
      sceneSegmentation: {
        fullChapterSceneRatio: ratio(fullChapterSceneCount, sceneCount),
        chaptersWithMultipleScenesRatio: ratio(chaptersWithMultipleScenes, sourceChapterCount),
        chaptersWithMultipleScenes,
        fullChapterSceneCount,
      },
      eventGranularity: {
        scenesWithMultipleEventsRatio: ratio(scenesWithMultipleEvents, sceneCount),
        scenesWithMultipleEvents,
        microEventSupportAverage: ratio(microEventSupportTotal, eventCount),
      },
      evidenceValidity: {
        evidenceQuoteMismatchCount: validationBreakdownMap.get("evidence_quote_mismatch") || 0,
        spanOutOfBoundsCount: validationBreakdownMap.get("span_out_of_bounds") || 0,
        invalidPayloadCount: validationBreakdownMap.get("invalid_payload") || 0,
        anchorFailureCount:
          (validationBreakdownMap.get("anchor_not_found") || 0) +
          (validationBreakdownMap.get("anchor_paragraph_not_found") || 0) +
          (validationBreakdownMap.get("anchor_span_mismatch") || 0),
      },
      evidenceHitUsefulnessProxy: {
        usefulHitRatio: ratio(usefulEvidenceHitCount, evidenceHitRows.length),
        hitsWithSpanRatio: ratio(hitsWithSpanCount, evidenceHitRows.length),
        hitsWithLinkedObjectsRatio: ratio(hitsWithLinkedObjectsCount, evidenceHitRows.length),
        hitsWithSnippetRatio: ratio(hitsWithSnippetCount, evidenceHitRows.length),
        averageLinkedObjectsPerHit: ratio(linkedObjectsTotal, evidenceHitRows.length),
      },
      topEntityPurityProxy: {
        topN: headSamples.length,
        cleanEntityRatio: ratio(
          headSamples.filter((sample) => !sample.duplicateRisk && sample.status !== "ambiguous").length,
          headSamples.length
        ),
        duplicateRiskCount: headSamples.filter((sample) => sample.duplicateRisk).length,
        ambiguousHeadCount: headSamples.filter((sample) => sample.status === "ambiguous").length,
        samples: headSamples,
      },
    },
    validationFailureBreakdown: validationBreakdown.map((row) => ({
      code: row.code,
      count: row._count.code,
    })),
  };
}
