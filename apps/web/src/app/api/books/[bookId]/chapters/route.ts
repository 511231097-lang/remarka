import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookChapterDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  // TOC доступен анонимам для public-книг (нужен для navigation внутри
  // обзора + reader). Чат сидит за auth и тут не задействован.
  const authUser = await resolveAuthUser();

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

  if (!book.isPublic && book.ownerUserId !== authUser?.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapters = await prisma.bookChapter.findMany({
    where: { bookId },
    orderBy: { orderIndex: "asc" },
  });

  return NextResponse.json(chapters.map(toBookChapterDTO));
}
