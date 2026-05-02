import { createVertexClient } from "@remarka/ai";
import {
  computeRerankCostUsd,
  prisma,
  recordBookRerankCalls,
  resolvePricingVersion,
  resolveTokenPricing,
} from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";

const PGVECTOR_EMBEDDING_DIMENSIONS = 768;
const SCENE_EMBEDDING_VERSION = Math.max(1, Number.parseInt(String(process.env.SCENE_EMBEDDING_VERSION || "1"), 10) || 1);
const PARAGRAPH_EMBEDDING_VERSION = Math.max(
  1,
  Number.parseInt(String(process.env.PARAGRAPH_EMBEDDING_VERSION || "1"), 10) || 1
);
const EVIDENCE_FRAGMENT_EMBEDDING_VERSION = Math.max(
  1,
  Number.parseInt(String(process.env.EVIDENCE_FRAGMENT_EMBEDDING_VERSION || "1"), 10) || 1
);
const RERANK_CONTENT_MAX_CHARS = Math.max(500, Number.parseInt(String(process.env.VERTEX_RANKING_CONTENT_MAX_CHARS || "3200"), 10) || 3200);

type SearchMode = "hybrid" | "lexical" | "semantic" | "paragraphs" | "scenes" | "fragments";
type MatchKind = "lexical" | "semantic" | "rerank";
type SearchSort = "rerank" | "chronological";

type ParagraphSearchHit = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  orderIndex: number;
  text: string;
  sceneId: string | null;
  sceneIndex: number | null;
  sceneCard: string | null;
  matchedBy: MatchKind[];
  semanticScore: number | null;
  lexicalRank: number | null;
  rerankScore: number | null;
  score: number;
};

type SceneSearchHit = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  sceneSummary: string;
  participantsJson: unknown;
  mentionedEntitiesJson: unknown;
  eventLabelsJson: unknown;
  factsJson: unknown;
  excerptText: string;
  matchedBy: MatchKind[];
  semanticScore: number | null;
  lexicalRank: number | null;
  rerankScore: number | null;
  score: number;
};

type FragmentSearchHit = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  fragmentType: string;
  primarySceneId: string | null;
  sceneIndex: number | null;
  sceneCard: string | null;
  paragraphStart: number;
  paragraphEnd: number;
  text: string;
  matchedBy: MatchKind[];
  semanticScore: number | null;
  lexicalRank: number | null;
  rerankScore: number | null;
  score: number;
};

type SemanticParagraphRow = {
  id: string | null;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  orderIndex: number | null;
  sourceText: string;
  semanticScore: number;
};

type SemanticSceneRow = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  sceneSummary: string;
  participantsJson: unknown;
  mentionedEntitiesJson: unknown;
  eventLabelsJson: unknown;
  factsJson: unknown;
  excerptText: string;
  semanticScore: number;
};

type SemanticFragmentRow = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  fragmentType: string;
  primarySceneId: string | null;
  sceneIndex: number | null;
  sceneCard: string | null;
  paragraphStart: number;
  paragraphEnd: number;
  sourceText: string;
  semanticScore: number;
};

function parsePositiveInt(value: string | null, fallback: number, options: { min: number; max: number }) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(options.min, Math.min(options.max, parsed));
}

function normalizeQuery(value: string | null) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseMode(value: string | null): SearchMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (["lexical", "semantic", "paragraphs", "scenes", "fragments"].includes(normalized)) return normalized as SearchMode;
  return "hybrid";
}

function parseSort(value: string | null): SearchSort {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "chronological" || normalized === "chrono") return "chronological";
  return "rerank";
}

function parseBool(value: string | null, fallback: boolean) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clampText(value: unknown, maxChars: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function asStringArray(value: unknown, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, maxItems);
}

function sceneToPayload(scene: SceneSearchHit) {
  return {
    id: scene.id,
    chapterId: scene.chapterId,
    chapterOrderIndex: scene.chapterOrderIndex,
    chapterTitle: scene.chapterTitle,
    sceneIndex: scene.sceneIndex,
    paragraphStart: scene.paragraphStart,
    paragraphEnd: scene.paragraphEnd,
    sceneCard: scene.sceneCard,
    sceneSummary: scene.sceneSummary,
    participants: asStringArray(scene.participantsJson),
    mentionedEntities: asStringArray(scene.mentionedEntitiesJson),
    eventLabels: asStringArray(scene.eventLabelsJson),
    facts: asStringArray(scene.factsJson, 16),
    excerptText: clampText(scene.excerptText, 1200),
    matchedBy: scene.matchedBy,
    semanticScore: scene.semanticScore,
    lexicalRank: scene.lexicalRank,
    rerankScore: scene.rerankScore,
    score: scene.score,
  };
}

function serializeVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) return "[]";
  return `[${vector
    .map((value) => {
      const normalized = Number(value || 0);
      if (!Number.isFinite(normalized)) return "0";
      return Number(normalized.toFixed(12)).toString();
    })
    .join(",")}]`;
}

function addMatch(hit: { matchedBy: MatchKind[] }, kind: MatchKind) {
  if (!hit.matchedBy.includes(kind)) hit.matchedBy.push(kind);
}

function computeScore(hit: { semanticScore: number | null; lexicalRank: number | null; rerankScore: number | null }) {
  if (hit.rerankScore !== null) return Number(hit.rerankScore || 0);
  const semantic = Number(hit.semanticScore || 0);
  const lexical = hit.lexicalRank ? 1 / (20 + hit.lexicalRank) : 0;
  return Math.max(semantic, lexical);
}

function compareByScore(a: { score: number }, b: { score: number }) {
  return b.score - a.score;
}

function compareParagraphChronological(
  a: { chapterOrderIndex: number; paragraphIndex: number; score: number },
  b: { chapterOrderIndex: number; paragraphIndex: number; score: number }
) {
  if (a.chapterOrderIndex !== b.chapterOrderIndex) return a.chapterOrderIndex - b.chapterOrderIndex;
  if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
  return compareByScore(a, b);
}

function compareSceneChronological(
  a: { chapterOrderIndex: number; paragraphStart: number; sceneIndex: number; score: number },
  b: { chapterOrderIndex: number; paragraphStart: number; sceneIndex: number; score: number }
) {
  if (a.chapterOrderIndex !== b.chapterOrderIndex) return a.chapterOrderIndex - b.chapterOrderIndex;
  if (a.paragraphStart !== b.paragraphStart) return a.paragraphStart - b.paragraphStart;
  if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex - b.sceneIndex;
  return compareByScore(a, b);
}

function compareFragmentChronological(
  a: { chapterOrderIndex: number; paragraphStart: number; paragraphEnd: number; score: number },
  b: { chapterOrderIndex: number; paragraphStart: number; paragraphEnd: number; score: number }
) {
  if (a.chapterOrderIndex !== b.chapterOrderIndex) return a.chapterOrderIndex - b.chapterOrderIndex;
  if (a.paragraphStart !== b.paragraphStart) return a.paragraphStart - b.paragraphStart;
  if (a.paragraphEnd !== b.paragraphEnd) return a.paragraphEnd - b.paragraphEnd;
  return compareByScore(a, b);
}

function sortParagraphHits<T extends { chapterOrderIndex: number; paragraphIndex: number; score: number }>(hits: T[], sort: SearchSort) {
  return [...hits].sort(sort === "chronological" ? compareParagraphChronological : compareByScore);
}

function sortSceneHits<T extends { chapterOrderIndex: number; paragraphStart: number; sceneIndex: number; score: number }>(hits: T[], sort: SearchSort) {
  return [...hits].sort(sort === "chronological" ? compareSceneChronological : compareByScore);
}

function sortFragmentHits<T extends { chapterOrderIndex: number; paragraphStart: number; paragraphEnd: number; score: number }>(hits: T[], sort: SearchSort) {
  return [...hits].sort(sort === "chronological" ? compareFragmentChronological : compareByScore);
}

function shouldSearchParagraphs(mode: SearchMode) {
  return mode === "hybrid" || mode === "semantic" || mode === "lexical" || mode === "paragraphs";
}

function shouldSearchScenes(mode: SearchMode) {
  return mode === "hybrid" || mode === "semantic" || mode === "lexical" || mode === "scenes";
}

function shouldSearchFragments(mode: SearchMode) {
  return mode === "hybrid" || mode === "semantic" || mode === "lexical" || mode === "fragments";
}

function shouldUseSemantic(mode: SearchMode) {
  return mode !== "lexical";
}

function shouldUseLexical(mode: SearchMode) {
  return mode !== "semantic";
}

async function rerankHits<
  T extends {
    id: string;
    matchedBy: MatchKind[];
    semanticScore: number | null;
    lexicalRank: number | null;
    rerankScore: number | null;
    score: number;
  },
>(params: {
  enabled: boolean;
  query: string;
  hits: T[];
  limit: number;
  toRecord: (hit: T) => { id: string; title?: string; content: string };
  /** Book under search — used to attribute the rerank call in BookRerankCall. */
  bookId: string;
}): Promise<{ hits: T[]; meta: { enabled: boolean; used: boolean; model: string | null; candidateCount: number; returned: number; error?: string } }> {
  const client = createVertexClient();
  if (!params.enabled || !params.query || !params.hits.length || !client.config.rankingEnabled) {
    const sorted = params.hits.sort((a, b) => b.score - a.score).slice(0, params.limit);
    return {
      hits: sorted,
      meta: {
        enabled: params.enabled && client.config.rankingEnabled,
        used: false,
        model: client.config.rankingModel || null,
        candidateCount: params.hits.length,
        returned: sorted.length,
      },
    };
  }

  const candidates = params.hits.slice(0, Math.max(params.limit, Math.min(120, params.limit * 4)));
  const records = candidates.map((hit) => {
    const record = params.toRecord(hit);
    return {
      id: record.id,
      title: record.title,
      content: clampText(record.content, RERANK_CONTENT_MAX_CHARS),
    };
  });

  const startedAt = Date.now();
  const pricing = resolveTokenPricing({
    chatModel: "",
    embeddingModel: "",
  });
  const pricingVersion = resolvePricingVersion();

  try {
    const ranked = await client.ranking.rank({
      query: params.query,
      records,
      topN: params.limit,
      ignoreRecordDetailsInResponse: true,
    });
    const latencyMs = Date.now() - startedAt;
    const byId = new Map(candidates.map((hit) => [hit.id, hit]));
    const returned: T[] = [];
    for (const record of ranked.records) {
      const hit = byId.get(record.id);
      if (!hit) continue;
      hit.rerankScore = Number(record.score || 0);
      addMatch(hit, "rerank");
      hit.score = computeScore(hit);
      returned.push(hit);
    }
    const returnedIds = new Set(returned.map((hit) => hit.id));
    for (const hit of candidates) {
      if (returned.length >= params.limit) break;
      if (returnedIds.has(hit.id)) continue;
      returned.push(hit);
    }

    // Audit trail. Admin search has no chat thread / turn metric, so those
    // FK fields stay null. `bookId` is always present (route validates it).
    if (ranked.enabled) {
      const costUsd = computeRerankCostUsd({
        callCount: 1,
        rerankPer1KQueriesUsd: pricing.rerankPer1KQueriesUsd,
      });
      try {
        await recordBookRerankCalls({
          client: prisma,
          pricingVersion,
          calls: [
            {
              source: "admin",
              bookId: params.bookId,
              threadId: null,
              turnMetricId: null,
              model: ranked.model,
              recordCount: ranked.recordCount,
              returnedCount: ranked.returnedCount,
              latencyMs,
              costUsd,
              errorCode: null,
            },
          ],
        });
      } catch (recordError) {
        console.warn("[admin-book-search] failed to record rerank call", recordError);
      }
    }

    return {
      hits: returned.slice(0, params.limit),
      meta: {
        enabled: true,
        used: true,
        model: ranked.model,
        candidateCount: candidates.length,
        returned: returned.length,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const sorted = params.hits.sort((a, b) => b.score - a.score).slice(0, params.limit);
    const errorMessage = error instanceof Error ? error.message : "Vertex rerank failed";

    // Failed call still hit the API — record it with errorCode and zero cost.
    try {
      await recordBookRerankCalls({
        client: prisma,
        pricingVersion,
        calls: [
          {
            source: "admin",
            bookId: params.bookId,
            threadId: null,
            turnMetricId: null,
            model: client.config.rankingModel || "",
            recordCount: candidates.length,
            returnedCount: 0,
            latencyMs,
            costUsd: 0,
            errorCode: errorMessage.slice(0, 200),
          },
        ],
      });
    } catch (recordError) {
      console.warn("[admin-book-search] failed to record failed rerank call", recordError);
    }

    return {
      hits: sorted,
      meta: {
        enabled: true,
        used: false,
        model: client.config.rankingModel || null,
        candidateCount: params.hits.length,
        returned: sorted.length,
        error: errorMessage,
      },
    };
  }
}

async function createQueryVector(q: string) {
  const client = createVertexClient();
  const embedding = await client.embeddings.create({
    text: q,
    taskType: "RETRIEVAL_QUERY",
    outputDimensionality: PGVECTOR_EMBEDDING_DIMENSIONS,
  });
  return {
    vector: embedding.vector,
    model: client.config.embeddingModel,
    usage: embedding.usage,
  };
}

type SearchScope = {
  chapterOrderIndex: number | null;
  paragraphStart: number | null;
  paragraphEnd: number | null;
};

async function searchParagraphsSemantic(bookId: string, queryVector: number[], limit: number, scope: SearchScope) {
  if (queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) return [];
  const vectorLiteral = serializeVectorLiteral(queryVector);
  const chapterOrderIndex = scope.chapterOrderIndex || 0;
  const paragraphStart = scope.paragraphStart || 0;
  const paragraphEnd = scope.paragraphEnd || 0;
  return prisma.$queryRaw<SemanticParagraphRow[]>`
    SELECT
      COALESCE(p."id", e."id") AS "id",
      e."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      e."paragraphIndex" AS "paragraphIndex",
      p."orderIndex" AS "orderIndex",
      COALESCE(p."text", e."sourceText") AS "sourceText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookParagraphEmbedding" e
    INNER JOIN "BookChapter" c ON c."id" = e."chapterId"
    LEFT JOIN "BookParagraph" p
      ON p."id" = e."paragraphId"
       OR (
        p."bookId" = e."bookId"
        AND p."chapterId" = e."chapterId"
        AND p."paragraphIndex" = e."paragraphIndex"
       )
    WHERE e."bookId" = ${bookId}
      AND e."embeddingVersion" = ${PARAGRAPH_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
      AND (${chapterOrderIndex} = 0 OR c."orderIndex" = ${chapterOrderIndex})
      AND (${paragraphStart} = 0 OR e."paragraphIndex" >= ${paragraphStart})
      AND (${paragraphEnd} = 0 OR e."paragraphIndex" <= ${paragraphEnd})
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${limit}
  `;
}

async function searchScenesSemantic(bookId: string, queryVector: number[], limit: number, scope: SearchScope) {
  if (queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) return [];
  const vectorLiteral = serializeVectorLiteral(queryVector);
  const chapterOrderIndex = scope.chapterOrderIndex || 0;
  const paragraphStart = scope.paragraphStart || 0;
  const paragraphEnd = scope.paragraphEnd || 0;
  return prisma.$queryRaw<SemanticSceneRow[]>`
    SELECT
      s."id" AS "id",
      s."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      s."sceneIndex" AS "sceneIndex",
      s."paragraphStart" AS "paragraphStart",
      s."paragraphEnd" AS "paragraphEnd",
      s."sceneCard" AS "sceneCard",
      s."sceneSummary" AS "sceneSummary",
      s."participantsJson" AS "participantsJson",
      s."mentionedEntitiesJson" AS "mentionedEntitiesJson",
      s."eventLabelsJson" AS "eventLabelsJson",
      s."factsJson" AS "factsJson",
      s."excerptText" AS "excerptText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookSceneEmbedding" e
    INNER JOIN "BookAnalysisScene" s ON s."id" = e."sceneId"
    INNER JOIN "BookChapter" c ON c."id" = s."chapterId"
    WHERE e."bookId" = ${bookId}
      AND e."embeddingVersion" = ${SCENE_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
      AND (${chapterOrderIndex} = 0 OR c."orderIndex" = ${chapterOrderIndex})
      AND (${paragraphStart} = 0 OR s."paragraphEnd" >= ${paragraphStart})
      AND (${paragraphEnd} = 0 OR s."paragraphStart" <= ${paragraphEnd})
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${limit}
  `;
}

async function searchFragmentsSemantic(bookId: string, queryVector: number[], limit: number, scope: SearchScope) {
  if (queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) return [];
  const vectorLiteral = serializeVectorLiteral(queryVector);
  const chapterOrderIndex = scope.chapterOrderIndex || 0;
  const paragraphStart = scope.paragraphStart || 0;
  const paragraphEnd = scope.paragraphEnd || 0;
  return prisma.$queryRaw<SemanticFragmentRow[]>`
    SELECT
      f."id" AS "id",
      f."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      f."fragmentType" AS "fragmentType",
      f."primarySceneId" AS "primarySceneId",
      s."sceneIndex" AS "sceneIndex",
      s."sceneCard" AS "sceneCard",
      f."paragraphStart" AS "paragraphStart",
      f."paragraphEnd" AS "paragraphEnd",
      f."text" AS "sourceText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookEvidenceFragmentEmbedding" e
    INNER JOIN "BookEvidenceFragment" f ON f."id" = e."fragmentId"
    INNER JOIN "BookChapter" c ON c."id" = f."chapterId"
    LEFT JOIN "BookAnalysisScene" s ON s."id" = f."primarySceneId"
    WHERE e."bookId" = ${bookId}
      AND e."embeddingVersion" = ${EVIDENCE_FRAGMENT_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
      AND (${chapterOrderIndex} = 0 OR c."orderIndex" = ${chapterOrderIndex})
      AND (${paragraphStart} = 0 OR f."paragraphEnd" >= ${paragraphStart})
      AND (${paragraphEnd} = 0 OR f."paragraphStart" <= ${paragraphEnd})
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${limit}
  `;
}

async function attachScenesToParagraphs(bookId: string, paragraphs: ParagraphSearchHit[]) {
  if (!paragraphs.length) return paragraphs;
  const scenes = await prisma.bookAnalysisScene.findMany({
    where: {
      bookId,
      OR: paragraphs.map((paragraph) => ({
        chapterId: paragraph.chapterId,
        paragraphStart: { lte: paragraph.paragraphIndex },
        paragraphEnd: { gte: paragraph.paragraphIndex },
      })),
    },
    orderBy: [{ chapter: { orderIndex: "asc" } }, { sceneIndex: "asc" }],
    select: {
      id: true,
      chapterId: true,
      sceneIndex: true,
      paragraphStart: true,
      paragraphEnd: true,
      sceneCard: true,
    },
  });

  for (const paragraph of paragraphs) {
    const scene = scenes.find(
      (item) =>
        item.chapterId === paragraph.chapterId &&
        item.paragraphStart <= paragraph.paragraphIndex &&
        item.paragraphEnd >= paragraph.paragraphIndex
    );
    if (!scene) continue;
    paragraph.sceneId = scene.id;
    paragraph.sceneIndex = scene.sceneIndex;
    paragraph.sceneCard = scene.sceneCard;
  }
  return paragraphs;
}

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const bookId = normalizeQuery(searchParams.get("bookId"));
  const q = normalizeQuery(searchParams.get("q"));
  const mode = parseMode(searchParams.get("mode"));
  const sort = parseSort(searchParams.get("sort"));
  const rerankEnabled = parseBool(searchParams.get("rerank"), true);
  const chapter = Number.parseInt(String(searchParams.get("chapter") || ""), 10);
  const start = Number.parseInt(String(searchParams.get("start") || ""), 10);
  const end = Number.parseInt(String(searchParams.get("end") || ""), 10);
  const limit = parsePositiveInt(searchParams.get("limit"), 50, { min: 1, max: 200 });
  const candidateLimit = Math.max(limit, Math.min(200, limit * 4));

  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      analysisStatus: true,
    },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapterMode = Number.isFinite(chapter) && chapter > 0;
  const rangeMode = chapterMode && Number.isFinite(start) && start > 0;
  const rangeStart = rangeMode ? Math.max(1, start) : 0;
  const rangeEnd = rangeMode ? Math.max(rangeStart, Number.isFinite(end) && end > 0 ? end : rangeStart + 30) : 0;
  const scope: SearchScope = {
    chapterOrderIndex: chapterMode ? chapter : null,
    paragraphStart: rangeMode ? rangeStart : null,
    paragraphEnd: rangeMode ? rangeEnd : null,
  };
  const canSearch = Boolean(q);
  const semanticEnabled = canSearch && shouldUseSemantic(mode);
  const lexicalEnabled = shouldUseLexical(mode);

  const queryEmbedding = semanticEnabled ? await createQueryVector(q) : null;
  const queryVector = queryEmbedding?.vector || [];

  const chapterRowsPromise = prisma.bookChapter.findMany({
    where: { bookId },
    orderBy: [{ orderIndex: "asc" }],
    select: {
      id: true,
      orderIndex: true,
      title: true,
    },
  });

  const paragraphLexicalPromise =
    lexicalEnabled && shouldSearchParagraphs(mode) && (canSearch || rangeMode)
      ? prisma.bookParagraph.findMany({
          where: {
            bookId,
            ...(canSearch ? { text: { contains: q, mode: "insensitive" as const } } : {}),
            ...(chapterMode ? { chapterOrderIndex: chapter } : {}),
            ...(rangeMode
              ? {
                  paragraphIndex: {
                    gte: rangeStart,
                    lte: rangeEnd,
                  },
                }
              : {}),
          },
          orderBy: [{ chapterOrderIndex: "asc" }, { paragraphIndex: "asc" }],
          take: candidateLimit,
          select: {
            id: true,
            chapterId: true,
            chapterOrderIndex: true,
            paragraphIndex: true,
            orderIndex: true,
            text: true,
            chapter: { select: { title: true } },
          },
        })
      : Promise.resolve([]);

  const sceneLexicalPromise =
    lexicalEnabled && shouldSearchScenes(mode) && (canSearch || rangeMode)
      ? prisma.bookAnalysisScene.findMany({
          where: {
            bookId,
            ...(canSearch
              ? {
                  OR: [
                    { sceneCard: { contains: q, mode: "insensitive" as const } },
                    { sceneSummary: { contains: q, mode: "insensitive" as const } },
                    { excerptText: { contains: q, mode: "insensitive" as const } },
                  ],
                }
              : {}),
            ...(chapterMode || rangeMode
              ? {
                  chapter: { orderIndex: chapter },
                  ...(rangeMode
                    ? {
                  paragraphEnd: { gte: rangeStart },
                  paragraphStart: { lte: rangeEnd },
                      }
                    : {}),
                }
              : {}),
          },
          orderBy: [{ chapter: { orderIndex: "asc" } }, { sceneIndex: "asc" }],
          take: candidateLimit,
          select: {
            id: true,
            chapterId: true,
            sceneIndex: true,
            paragraphStart: true,
            paragraphEnd: true,
            sceneCard: true,
            sceneSummary: true,
            participantsJson: true,
            mentionedEntitiesJson: true,
            eventLabelsJson: true,
            factsJson: true,
            excerptText: true,
            chapter: { select: { orderIndex: true, title: true } },
          },
        })
      : Promise.resolve([]);

  const fragmentLexicalPromise =
    lexicalEnabled && shouldSearchFragments(mode) && canSearch
      ? prisma.bookEvidenceFragment.findMany({
          where: {
            bookId,
            text: { contains: q, mode: "insensitive" as const },
            ...(chapterMode ? { chapter: { orderIndex: chapter } } : {}),
            ...(rangeMode
              ? {
                  paragraphEnd: { gte: rangeStart },
                  paragraphStart: { lte: rangeEnd },
                }
              : {}),
          },
          orderBy: [{ chapter: { orderIndex: "asc" } }, { paragraphStart: "asc" }],
          take: candidateLimit,
          select: {
            id: true,
            chapterId: true,
            fragmentType: true,
            primarySceneId: true,
            paragraphStart: true,
            paragraphEnd: true,
            text: true,
            chapter: { select: { orderIndex: true, title: true } },
            primaryScene: { select: { sceneIndex: true, sceneCard: true } },
          },
        })
      : Promise.resolve([]);

  const paragraphSemanticPromise =
    semanticEnabled && shouldSearchParagraphs(mode) ? searchParagraphsSemantic(bookId, queryVector, candidateLimit, scope) : Promise.resolve([]);
  const sceneSemanticPromise = semanticEnabled && shouldSearchScenes(mode) ? searchScenesSemantic(bookId, queryVector, candidateLimit, scope) : Promise.resolve([]);
  const fragmentSemanticPromise =
    semanticEnabled && shouldSearchFragments(mode) ? searchFragmentsSemantic(bookId, queryVector, candidateLimit, scope) : Promise.resolve([]);

  const [chapterRows, paragraphLexical, sceneLexical, fragmentLexical, paragraphSemantic, sceneSemantic, fragmentSemantic] =
    await Promise.all([
      chapterRowsPromise,
      paragraphLexicalPromise,
      sceneLexicalPromise,
      fragmentLexicalPromise,
      paragraphSemanticPromise,
      sceneSemanticPromise,
      fragmentSemanticPromise,
    ]);

  const paragraphById = new Map<string, ParagraphSearchHit>();
  paragraphLexical.forEach((paragraph, index) => {
    paragraphById.set(paragraph.id, {
      id: paragraph.id,
      chapterId: paragraph.chapterId,
      chapterOrderIndex: paragraph.chapterOrderIndex,
      chapterTitle: paragraph.chapter.title,
      paragraphIndex: paragraph.paragraphIndex,
      orderIndex: paragraph.orderIndex,
      text: paragraph.text,
      sceneId: null,
      sceneIndex: null,
      sceneCard: null,
      matchedBy: ["lexical"],
      semanticScore: null,
      lexicalRank: index + 1,
      rerankScore: null,
      score: 1 / (20 + index + 1),
    });
  });
  paragraphSemantic.forEach((paragraph) => {
    const id = paragraph.id || `${paragraph.chapterId}:${paragraph.paragraphIndex}`;
    const existing = paragraphById.get(id);
    if (existing) {
      existing.semanticScore = Math.max(existing.semanticScore || 0, Number(paragraph.semanticScore || 0));
      addMatch(existing, "semantic");
      existing.score = computeScore(existing);
      return;
    }
    const hit: ParagraphSearchHit = {
      id,
      chapterId: paragraph.chapterId,
      chapterOrderIndex: Number(paragraph.chapterOrderIndex || 0),
      chapterTitle: String(paragraph.chapterTitle || "").trim(),
      paragraphIndex: Number(paragraph.paragraphIndex || 0),
      orderIndex: Number(paragraph.orderIndex || paragraph.paragraphIndex || 0),
      text: normalizeText(paragraph.sourceText),
      sceneId: null,
      sceneIndex: null,
      sceneCard: null,
      matchedBy: ["semantic"],
      semanticScore: Number(paragraph.semanticScore || 0),
      lexicalRank: null,
      rerankScore: null,
      score: Number(paragraph.semanticScore || 0),
    };
    paragraphById.set(id, hit);
  });

  const sceneById = new Map<string, SceneSearchHit>();
  sceneLexical.forEach((scene, index) => {
    sceneById.set(scene.id, {
      id: scene.id,
      chapterId: scene.chapterId,
      chapterOrderIndex: scene.chapter.orderIndex,
      chapterTitle: scene.chapter.title,
      sceneIndex: scene.sceneIndex,
      paragraphStart: scene.paragraphStart,
      paragraphEnd: scene.paragraphEnd,
      sceneCard: scene.sceneCard,
      sceneSummary: scene.sceneSummary,
      participantsJson: scene.participantsJson,
      mentionedEntitiesJson: scene.mentionedEntitiesJson,
      eventLabelsJson: scene.eventLabelsJson,
      factsJson: scene.factsJson,
      excerptText: scene.excerptText,
      matchedBy: ["lexical"],
      semanticScore: null,
      lexicalRank: index + 1,
      rerankScore: null,
      score: 1 / (20 + index + 1),
    });
  });
  sceneSemantic.forEach((scene) => {
    const existing = sceneById.get(scene.id);
    if (existing) {
      existing.semanticScore = Math.max(existing.semanticScore || 0, Number(scene.semanticScore || 0));
      addMatch(existing, "semantic");
      existing.score = computeScore(existing);
      return;
    }
    sceneById.set(scene.id, {
      id: scene.id,
      chapterId: scene.chapterId,
      chapterOrderIndex: Number(scene.chapterOrderIndex || 0),
      chapterTitle: String(scene.chapterTitle || "").trim(),
      sceneIndex: Number(scene.sceneIndex || 0),
      paragraphStart: Number(scene.paragraphStart || 0),
      paragraphEnd: Number(scene.paragraphEnd || 0),
      sceneCard: String(scene.sceneCard || ""),
      sceneSummary: String(scene.sceneSummary || ""),
      participantsJson: scene.participantsJson,
      mentionedEntitiesJson: scene.mentionedEntitiesJson,
      eventLabelsJson: scene.eventLabelsJson,
      factsJson: scene.factsJson,
      excerptText: String(scene.excerptText || ""),
      matchedBy: ["semantic"],
      semanticScore: Number(scene.semanticScore || 0),
      lexicalRank: null,
      rerankScore: null,
      score: Number(scene.semanticScore || 0),
    });
  });

  const fragmentById = new Map<string, FragmentSearchHit>();
  fragmentLexical.forEach((fragment, index) => {
    fragmentById.set(fragment.id, {
      id: fragment.id,
      chapterId: fragment.chapterId,
      chapterOrderIndex: fragment.chapter.orderIndex,
      chapterTitle: fragment.chapter.title,
      fragmentType: fragment.fragmentType,
      primarySceneId: fragment.primarySceneId,
      sceneIndex: fragment.primaryScene?.sceneIndex ?? null,
      sceneCard: fragment.primaryScene?.sceneCard ?? null,
      paragraphStart: fragment.paragraphStart,
      paragraphEnd: fragment.paragraphEnd,
      text: fragment.text,
      matchedBy: ["lexical"],
      semanticScore: null,
      lexicalRank: index + 1,
      rerankScore: null,
      score: 1 / (20 + index + 1),
    });
  });
  fragmentSemantic.forEach((fragment) => {
    const existing = fragmentById.get(fragment.id);
    if (existing) {
      existing.semanticScore = Math.max(existing.semanticScore || 0, Number(fragment.semanticScore || 0));
      addMatch(existing, "semantic");
      existing.score = computeScore(existing);
      return;
    }
    fragmentById.set(fragment.id, {
      id: fragment.id,
      chapterId: fragment.chapterId,
      chapterOrderIndex: Number(fragment.chapterOrderIndex || 0),
      chapterTitle: String(fragment.chapterTitle || "").trim(),
      fragmentType: String(fragment.fragmentType || ""),
      primarySceneId: fragment.primarySceneId,
      sceneIndex: typeof fragment.sceneIndex === "number" ? fragment.sceneIndex : fragment.sceneIndex ? Number(fragment.sceneIndex) : null,
      sceneCard: fragment.sceneCard,
      paragraphStart: Number(fragment.paragraphStart || 0),
      paragraphEnd: Number(fragment.paragraphEnd || 0),
      text: normalizeText(fragment.sourceText),
      matchedBy: ["semantic"],
      semanticScore: Number(fragment.semanticScore || 0),
      lexicalRank: null,
      rerankScore: null,
      score: Number(fragment.semanticScore || 0),
    });
  });

  const paragraphRerank = await rerankHits({
    enabled: rerankEnabled && canSearch,
    query: q,
    hits: await attachScenesToParagraphs(bookId, Array.from(paragraphById.values())),
    limit,
    bookId,
    toRecord: (hit) => ({
      id: hit.id,
      title: `Глава ${hit.chapterOrderIndex}, параграф ${hit.paragraphIndex}`,
      content: hit.text,
    }),
  });
  const sceneRerank = await rerankHits({
    enabled: rerankEnabled && canSearch,
    query: q,
    hits: Array.from(sceneById.values()),
    limit,
    bookId,
    toRecord: (hit) => ({
      id: hit.id,
      title: hit.sceneCard || `Глава ${hit.chapterOrderIndex}, сцена ${hit.sceneIndex}`,
      content: [hit.sceneCard, hit.sceneSummary, hit.excerptText].filter(Boolean).join("\n\n"),
    }),
  });
  const fragmentRerank = await rerankHits({
    enabled: rerankEnabled && canSearch,
    query: q,
    hits: Array.from(fragmentById.values()),
    limit,
    bookId,
    toRecord: (hit) => ({
      id: hit.id,
      title: `Глава ${hit.chapterOrderIndex}, ${hit.fragmentType}, p${hit.paragraphStart}-${hit.paragraphEnd}`,
      content: hit.text,
    }),
  });

  const scoreParagraphHits = sortParagraphHits(paragraphRerank.hits, "rerank");
  const scoreSceneHits = sortSceneHits(sceneRerank.hits, "rerank");
  const scoreFragmentHits = sortFragmentHits(fragmentRerank.hits, "rerank");
  const sortedParagraphHits = sortParagraphHits(scoreParagraphHits, sort);
  const sortedSceneHits = sortSceneHits(scoreSceneHits, sort);
  const sortedFragmentHits = sortFragmentHits(scoreFragmentHits, sort);

  const groupedSceneById = new Map<string, SceneSearchHit>();
  for (const scene of scoreSceneHits.slice(0, Math.min(12, limit))) {
    groupedSceneById.set(scene.id, scene);
  }

  const missingSceneIds = new Set<string>();
  for (const paragraph of scoreParagraphHits.slice(0, Math.min(30, limit))) {
    if (paragraph.sceneId && !groupedSceneById.has(paragraph.sceneId)) missingSceneIds.add(paragraph.sceneId);
  }
  for (const fragment of scoreFragmentHits.slice(0, Math.min(30, limit))) {
    if (fragment.primarySceneId && !groupedSceneById.has(fragment.primarySceneId)) missingSceneIds.add(fragment.primarySceneId);
  }

  if (missingSceneIds.size) {
    const missingScenes = await prisma.bookAnalysisScene.findMany({
      where: {
        bookId,
        id: { in: Array.from(missingSceneIds).slice(0, 20) },
      },
      select: {
        id: true,
        chapterId: true,
        sceneIndex: true,
        paragraphStart: true,
        paragraphEnd: true,
        sceneCard: true,
        sceneSummary: true,
        participantsJson: true,
        mentionedEntitiesJson: true,
        eventLabelsJson: true,
        factsJson: true,
        excerptText: true,
        chapter: { select: { orderIndex: true, title: true } },
      },
    });
    for (const scene of missingScenes) {
      groupedSceneById.set(scene.id, {
        id: scene.id,
        chapterId: scene.chapterId,
        chapterOrderIndex: scene.chapter.orderIndex,
        chapterTitle: scene.chapter.title,
        sceneIndex: scene.sceneIndex,
        paragraphStart: scene.paragraphStart,
        paragraphEnd: scene.paragraphEnd,
        sceneCard: scene.sceneCard,
        sceneSummary: scene.sceneSummary,
        participantsJson: scene.participantsJson,
        mentionedEntitiesJson: scene.mentionedEntitiesJson,
        eventLabelsJson: scene.eventLabelsJson,
        factsJson: scene.factsJson,
        excerptText: scene.excerptText,
        matchedBy: [],
        semanticScore: null,
        lexicalRank: null,
        rerankScore: null,
        score: 0,
      });
    }
  }

  const groupedScenes = Array.from(groupedSceneById.values())
    .sort(sort === "chronological" ? compareSceneChronological : compareByScore)
    .slice(0, Math.min(16, limit));

  const groupedParagraphRows = groupedScenes.length
    ? await prisma.bookParagraph.findMany({
        where: {
          bookId,
          OR: groupedScenes.map((scene) => ({
            chapterId: scene.chapterId,
            paragraphIndex: {
              gte: scene.paragraphStart,
              lte: scene.paragraphEnd,
            },
          })),
        },
        orderBy: [{ chapterOrderIndex: "asc" }, { paragraphIndex: "asc" }],
        select: {
          id: true,
          chapterId: true,
          chapterOrderIndex: true,
          paragraphIndex: true,
          orderIndex: true,
          text: true,
        },
      })
    : [];

  const paragraphHitByRef = new Map(sortedParagraphHits.map((paragraph) => [`${paragraph.chapterId}:${paragraph.paragraphIndex}`, paragraph]));
  const fragmentsBySceneId = new Map<string, FragmentSearchHit[]>();
  for (const fragment of sortedFragmentHits) {
    if (!fragment.primarySceneId) continue;
    const existing = fragmentsBySceneId.get(fragment.primarySceneId) || [];
    existing.push(fragment);
    fragmentsBySceneId.set(fragment.primarySceneId, existing);
  }

  const sceneGroups = groupedScenes.map((scene) => {
    const paragraphs = groupedParagraphRows
      .filter(
        (paragraph) =>
          paragraph.chapterId === scene.chapterId &&
          paragraph.paragraphIndex >= scene.paragraphStart &&
          paragraph.paragraphIndex <= scene.paragraphEnd
      )
      .map((paragraph) => {
        const hit = paragraphHitByRef.get(`${paragraph.chapterId}:${paragraph.paragraphIndex}`);
        return {
          id: paragraph.id,
          chapterId: paragraph.chapterId,
          chapterOrderIndex: paragraph.chapterOrderIndex,
          paragraphIndex: paragraph.paragraphIndex,
          orderIndex: paragraph.orderIndex,
          text: paragraph.text,
          textPreview: clampText(paragraph.text, 900),
          matchedBy: hit?.matchedBy || [],
          semanticScore: hit?.semanticScore ?? null,
          lexicalRank: hit?.lexicalRank ?? null,
          rerankScore: hit?.rerankScore ?? null,
          score: hit?.score ?? 0,
          isHit: Boolean(hit),
        };
      });

    const fragments = sortFragmentHits(fragmentsBySceneId.get(scene.id) || [], sort).map((fragment) => ({
        id: fragment.id,
        fragmentType: fragment.fragmentType,
        paragraphStart: fragment.paragraphStart,
        paragraphEnd: fragment.paragraphEnd,
        textPreview: clampText(fragment.text, 700),
        matchedBy: fragment.matchedBy,
        semanticScore: fragment.semanticScore,
        lexicalRank: fragment.lexicalRank,
        rerankScore: fragment.rerankScore,
        score: fragment.score,
      }));

    return {
      scene: sceneToPayload(scene),
      hitParagraphCount: paragraphs.filter((paragraph) => paragraph.isHit).length,
      paragraphCount: paragraphs.length,
      fragments,
      paragraphs,
    };
  });

  return NextResponse.json({
    book,
    query: q,
    mode,
    sort,
    range: rangeMode
      ? {
          chapter,
          start: rangeStart,
          end: rangeEnd,
        }
      : chapterMode
        ? {
            chapter,
            start: 0,
            end: 0,
          }
      : null,
    limit,
    debug: {
      semanticEnabled,
      lexicalEnabled,
      rerankRequested: rerankEnabled,
      embedding: queryEmbedding
        ? {
            model: queryEmbedding.model,
            dimensions: queryEmbedding.vector.length,
            inputTokens: queryEmbedding.usage.input_tokens,
          }
        : null,
      rerank: {
        paragraphs: paragraphRerank.meta,
        scenes: sceneRerank.meta,
        fragments: fragmentRerank.meta,
      },
      versions: {
        paragraphEmbeddingVersion: PARAGRAPH_EMBEDDING_VERSION,
        sceneEmbeddingVersion: SCENE_EMBEDDING_VERSION,
        evidenceFragmentEmbeddingVersion: EVIDENCE_FRAGMENT_EMBEDDING_VERSION,
      },
    },
    chapters: chapterRows.map((chapterRow) => ({
      id: chapterRow.id,
      orderIndex: chapterRow.orderIndex,
      title: chapterRow.title,
    })),
    paragraphs: sortedParagraphHits.map((paragraph) => ({
      ...paragraph,
      textPreview: clampText(paragraph.text, 900),
    })),
    scenes: sortedSceneHits.map(sceneToPayload),
    fragments: sortedFragmentHits.map((fragment) => ({
      ...fragment,
      textPreview: clampText(fragment.text, 1000),
    })),
    sceneGroups,
  });
}
