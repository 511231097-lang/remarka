import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import {
  LITERARY_SECTION_KEYS,
  toBookLiteraryAnalysisDTO,
  toBookQuoteListItemDTO,
  type LiterarySectionKeyDTO,
} from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; sectionKey: string }>;
}

function isSectionKey(value: string): value is LiterarySectionKeyDTO {
  return LITERARY_SECTION_KEYS.includes(value as LiterarySectionKeyDTO);
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sectionKey = String(params.sectionKey || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!isSectionKey(sectionKey)) {
    return NextResponse.json({ error: "sectionKey is invalid" }, { status: 400 });
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

  const analysis = await prisma.bookLiteraryAnalysis.findUnique({
    where: { bookId },
    select: {
      bookId: true,
      sectionsJson: true,
      updatedAt: true,
    },
  });

  if (!analysis) {
    return NextResponse.json({ error: "Literary analysis not found" }, { status: 404 });
  }

  const dto = toBookLiteraryAnalysisDTO(analysis);
  const section = dto.sections[sectionKey];

  const evidenceQuoteIds = section.evidenceQuoteIds.slice(0, 24);
  if (!evidenceQuoteIds.length) {
    return NextResponse.json(section);
  }

  const rows = await prisma.bookQuote.findMany({
    where: {
      bookId,
      id: {
        in: evidenceQuoteIds,
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
  const evidenceQuotes = evidenceQuoteIds
    .map((quoteId) => byId.get(quoteId))
    .filter((quote): quote is NonNullable<typeof quote> => Boolean(quote))
    .map(toBookQuoteListItemDTO);

  return NextResponse.json({
    ...section,
    evidenceQuotes,
  });
}
