import { normalizeEntityName } from "@remarka/contracts";
import { prisma } from "@remarka/db";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookQuoteListItemDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

const DEFAULT_TOP_K = 24;
const MAX_TOP_K = 120;
const MAX_OFFSET = 5000;

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value || "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function parseSort(value: unknown): "relevance" | "chapter_asc" | "confidence_desc" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "chapter_asc") return "chapter_asc";
  if (normalized === "confidence_desc") return "confidence_desc";
  return "relevance";
}

function parseQuoteTypeList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of source) {
    const normalized = String(item || "").trim().toLowerCase();
    if (
      normalized === "dialogue" ||
      normalized === "monologue" ||
      normalized === "narration" ||
      normalized === "description" ||
      normalized === "reflection" ||
      normalized === "action"
    ) {
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

function parseQuoteTagList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of source) {
    const normalized = String(item || "").trim().toLowerCase();
    if (
      normalized === "conflict" ||
      normalized === "relationship" ||
      normalized === "identity" ||
      normalized === "morality" ||
      normalized === "power" ||
      normalized === "freedom" ||
      normalized === "fear" ||
      normalized === "guilt" ||
      normalized === "hope" ||
      normalized === "fate" ||
      normalized === "society" ||
      normalized === "violence" ||
      normalized === "love" ||
      normalized === "death" ||
      normalized === "faith"
    ) {
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

function parseChapterList(value: unknown): number[] {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const out: number[] = [];
  for (const item of source) {
    const parsed = toInt(item, 0);
    if (parsed > 0 && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

function parseMentionKind(value: unknown): "character" | "theme" | "location" | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "character" || normalized === "theme" || normalized === "location") return normalized;
  return null;
}

function toTotal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "bigint") return Number(value);
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

export async function POST(request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      isPublic: true,
      ownerUserId: true,
    },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const query = String(body?.query || "").trim().slice(0, 320);
  const sort = parseSort(body?.sort);
  const effectiveSort = sort === "relevance" && !query ? "chapter_asc" : sort;
  const topK = Math.min(Math.max(1, toInt(body?.topK, DEFAULT_TOP_K)), MAX_TOP_K);
  const offset = Math.min(Math.max(0, toInt(body?.offset, 0)), MAX_OFFSET);

  const filters = body?.filters && typeof body.filters === "object" ? body.filters : {};
  const chapterList = parseChapterList(filters.chapter);
  const typeList = parseQuoteTypeList(filters.type);
  const tagList = parseQuoteTagList(filters.tags);
  const mentionKind = parseMentionKind(filters.mentionKind);
  const mentionValue = String(filters.mentionValue || "").trim();
  const normalizedMentionValue = normalizeEntityName(mentionValue);
  const minConfidenceRaw = toNumber(filters.minConfidence, Number.NaN);
  const minConfidence = Number.isFinite(minConfidenceRaw)
    ? Math.max(0, Math.min(1, minConfidenceRaw))
    : null;

  const conditions: Prisma.Sql[] = [Prisma.sql`q."bookId" = ${bookId}`];

  if (chapterList.length > 0) {
    conditions.push(Prisma.sql`q."chapterOrderIndex" IN (${Prisma.join(chapterList)})`);
  }

  if (typeList.length > 0) {
    conditions.push(Prisma.sql`q."type" IN (${Prisma.join(typeList)})`);
  }

  if (tagList.length > 0) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "BookQuoteTagLink" qtl
        WHERE qtl."quoteId" = q."id"
          AND qtl."tag" IN (${Prisma.join(tagList)})
      )`
    );
  }

  if (mentionKind || normalizedMentionValue) {
    const mentionConditions: Prisma.Sql[] = [Prisma.sql`qm."quoteId" = q."id"`];
    if (mentionKind) {
      mentionConditions.push(Prisma.sql`qm."kind" = ${mentionKind}`);
    }
    if (normalizedMentionValue) {
      mentionConditions.push(Prisma.sql`LOWER(qm."normalizedValue") LIKE ${`%${normalizedMentionValue.toLowerCase()}%`}`);
    }

    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "BookQuoteMention" qm
        WHERE ${Prisma.join(mentionConditions, " AND ")}
      )`
    );
  }

  if (typeof minConfidence === "number") {
    conditions.push(Prisma.sql`q."confidence" >= ${minConfidence}`);
  }

  if (query) {
    conditions.push(
      Prisma.sql`to_tsvector('russian', COALESCE(q."text", '') || ' ' || COALESCE(q."commentary", '')) @@ websearch_to_tsquery('russian', ${query})`
    );
  }

  const whereSql = Prisma.join(conditions, " AND ");

  const totalRows = await prisma.$queryRaw<Array<{ total: unknown }>>`
    SELECT COUNT(*)::bigint AS total
    FROM "BookQuote" q
    WHERE ${whereSql}
  `;
  const total = toTotal(totalRows[0]?.total);

  const rankingRows =
    effectiveSort === "relevance"
      ? await prisma.$queryRaw<Array<{ id: string; score: number | null }>>`
          SELECT
            q."id" AS id,
            ts_rank_cd(
              to_tsvector('russian', COALESCE(q."text", '') || ' ' || COALESCE(q."commentary", '')),
              websearch_to_tsquery('russian', ${query})
            ) AS score
          FROM "BookQuote" q
          WHERE ${whereSql}
          ORDER BY score DESC, q."chapterOrderIndex" ASC, q."startChar" ASC
          OFFSET ${offset}
          LIMIT ${topK}
        `
      : effectiveSort === "confidence_desc"
        ? await prisma.$queryRaw<Array<{ id: string; score: number | null }>>`
            SELECT q."id" AS id, NULL::double precision AS score
            FROM "BookQuote" q
            WHERE ${whereSql}
            ORDER BY q."confidence" DESC NULLS LAST, q."chapterOrderIndex" ASC, q."startChar" ASC
            OFFSET ${offset}
            LIMIT ${topK}
          `
        : await prisma.$queryRaw<Array<{ id: string; score: number | null }>>`
            SELECT q."id" AS id, NULL::double precision AS score
            FROM "BookQuote" q
            WHERE ${whereSql}
            ORDER BY q."chapterOrderIndex" ASC, q."startChar" ASC
            OFFSET ${offset}
            LIMIT ${topK}
          `;

  const orderedIds = rankingRows.map((row) => row.id);
  if (orderedIds.length === 0) {
    return NextResponse.json({
      items: [],
      total,
      topK,
      offset,
    });
  }

  const scoreById = new Map(
    rankingRows.map((row) => [row.id, typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null] as const)
  );

  const rows = await prisma.bookQuote.findMany({
    where: {
      bookId,
      id: {
        in: orderedIds,
      },
    },
    include: {
      tags: {
        select: {
          tag: true,
        },
      },
      mentions: {
        orderBy: [
          { confidence: "desc" },
          { startChar: "asc" },
        ],
      },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row] as const));

  const items = orderedIds
    .map((id) => {
      const quote = byId.get(id);
      if (!quote) return null;
      return {
        ...toBookQuoteListItemDTO(quote),
        retrievalScore: scoreById.get(id) ?? null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return NextResponse.json({
    items,
    total,
    topK,
    offset,
  });
}
