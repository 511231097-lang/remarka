import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { normalizeEntityName } from "@remarka/contracts";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookQuoteListItemDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 120;

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseScore(value: string | null): number | null {
  const parsed = Number.parseFloat(String(value || "").trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function asQuoteSort(value: string | null): "chapter_asc" | "confidence_desc" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "confidence_desc") return "confidence_desc";
  return "chapter_asc";
}

function asQuoteType(value: string | null): Prisma.BookQuoteWhereInput["type"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "dialogue" ||
    normalized === "monologue" ||
    normalized === "narration" ||
    normalized === "description" ||
    normalized === "reflection" ||
    normalized === "action"
  ) {
    return normalized;
  }
  return undefined;
}

function asQuoteTag(value: string | null): Prisma.BookQuoteTagLinkWhereInput["tag"] {
  const normalized = String(value || "").trim().toLowerCase();
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
    return normalized;
  }
  return undefined;
}

function asMentionKind(value: string | null): Prisma.BookQuoteMentionWhereInput["kind"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "character" || normalized === "theme" || normalized === "location") {
    return normalized;
  }
  return undefined;
}

export async function GET(request: Request, context: RouteContext) {
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

  const { searchParams } = new URL(request.url);
  const page = parsePositiveInt(searchParams.get("page"), DEFAULT_PAGE);
  const pageSize = Math.min(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const chapter = parsePositiveInt(searchParams.get("chapter"), 0);
  const quoteType = asQuoteType(searchParams.get("type"));
  const quoteTag = asQuoteTag(searchParams.get("tag"));
  const mentionKind = asMentionKind(searchParams.get("mentionKind"));
  const mentionValue = String(searchParams.get("mentionValue") || "").trim();
  const normalizedMentionValue = normalizeEntityName(mentionValue);
  const confidenceGte = parseScore(searchParams.get("confidenceGte"));
  const q = String(searchParams.get("q") || "").trim().slice(0, 240);
  const sort = asQuoteSort(searchParams.get("sort"));

  const where: Prisma.BookQuoteWhereInput = {
    bookId,
    ...(chapter > 0 ? { chapterOrderIndex: chapter } : {}),
    ...(quoteType ? { type: quoteType } : {}),
    ...(typeof confidenceGte === "number" ? { confidence: { gte: confidenceGte } } : {}),
    ...(q
      ? {
          OR: [
            { text: { contains: q, mode: "insensitive" } },
            { commentary: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(quoteTag
      ? {
          tags: {
            some: {
              tag: quoteTag,
            },
          },
        }
      : {}),
    ...((mentionKind || normalizedMentionValue)
      ? {
          mentions: {
            some: {
              ...(mentionKind ? { kind: mentionKind } : {}),
              ...(normalizedMentionValue
                ? {
                    normalizedValue: {
                      contains: normalizedMentionValue,
                      mode: "insensitive",
                    },
                  }
                : {}),
            },
          },
        }
      : {}),
  };

  const orderBy: Prisma.BookQuoteOrderByWithRelationInput[] =
    sort === "confidence_desc"
      ? [
          { confidence: "desc" },
          { chapterOrderIndex: "asc" },
          { startChar: "asc" },
        ]
      : [
          { chapterOrderIndex: "asc" },
          { startChar: "asc" },
        ];

  const skip = (page - 1) * pageSize;

  const [total, rows] = await prisma.$transaction([
    prisma.bookQuote.count({ where }),
    prisma.bookQuote.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
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
    }),
  ]);

  return NextResponse.json({
    items: rows.map(toBookQuoteListItemDTO),
    total,
    page,
    pageSize,
  });
}
