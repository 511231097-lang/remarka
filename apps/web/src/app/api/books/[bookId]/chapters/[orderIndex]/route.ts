import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import type { BookChapterContentDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; orderIndex: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  // Содержимое глав доступно анонимам для public-книг (читалка внутри
  // обзора). Чат и инструменты по содержимому идут через auth-only роуты.
  const authUser = await resolveAuthUser();

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const orderIndexRaw = String(params.orderIndex || "").trim();
  const orderIndex = Number.parseInt(orderIndexRaw, 10);

  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!Number.isFinite(orderIndex) || orderIndex < 1) {
    return NextResponse.json({ error: "orderIndex must be a positive integer" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, isPublic: true, ownerUserId: true },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (!book.isPublic && book.ownerUserId !== authUser?.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const [chapter, totalChapters] = await Promise.all([
    prisma.bookChapter.findUnique({
      where: { bookId_orderIndex: { bookId, orderIndex } },
      select: { id: true, orderIndex: true, title: true, rawText: true },
    }),
    prisma.bookChapter.count({ where: { bookId } }),
  ]);

  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  const paragraphs = await prisma.bookParagraph.findMany({
    where: { bookId, chapterId: chapter.id },
    orderBy: { paragraphIndex: "asc" },
    select: { paragraphIndex: true, text: true },
  });

  const dto: BookChapterContentDTO = {
    id: chapter.id,
    orderIndex: chapter.orderIndex,
    title: chapter.title,
    rawText: chapter.rawText || "",
    paragraphs: paragraphs.map((p) => ({ paragraphIndex: p.paragraphIndex, text: p.text })),
    totalChapters,
  };

  return NextResponse.json(dto);
}
