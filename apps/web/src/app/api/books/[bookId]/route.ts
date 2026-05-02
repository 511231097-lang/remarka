import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { fetchBookForViewer } from "@/lib/server/bookView";
import { deleteBookStoragePayloads } from "@/lib/bookStorageCleanup";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  // Анонимам отдаём только public-книги (обзор: метаданные + библиотечные
  // флажки). Авторизованные могут видеть свои приватные тоже. Чат, upload
  // и прочие write-операции остаются под auth (отдельные роуты + layout).
  //
  // Visibility rules and 404 responses are derived from `fetchBookForViewer`
  // — same helper drives `app/book/[bookId]/page.tsx` SSR so privacy can
  // never drift between SSR and JSON responses.
  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const authUser = await resolveAuthUser();
  const result = await fetchBookForViewer({
    bookId,
    viewer: authUser ? { id: authUser.id } : null,
  });

  if (!result) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  return NextResponse.json(result.book);
}

export async function DELETE(_request: Request, context: RouteContext) {
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
      ownerUserId: true,
      storageProvider: true,
      storageKey: true,
      textCorpusStorageKey: true,
    },
  });

  if (!book || book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  await prisma.book.delete({
    where: { id: bookId },
  });

  await deleteBookStoragePayloads({
    bookId,
    storageProvider: book.storageProvider,
    storageKey: book.storageKey,
    textCorpusStorageKey: book.textCorpusStorageKey,
  });

  return new NextResponse(null, { status: 204 });
}
