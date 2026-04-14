import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookQuoteListItemDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; quoteId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const quoteId = String(params.quoteId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!quoteId) {
    return NextResponse.json({ error: "quoteId is required" }, { status: 400 });
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

  const quote = await prisma.bookQuote.findFirst({
    where: {
      id: quoteId,
      bookId,
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

  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...toBookQuoteListItemDTO(quote),
    retrievalScore: null,
  });
}
