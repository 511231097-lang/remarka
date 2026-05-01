import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookCoreDTO } from "@/lib/books";
import { deleteBookStoragePayloads } from "@/lib/bookStorageCleanup";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

async function resolveBook(context: RouteContext) {
  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return { bookId, error: NextResponse.json({ error: "bookId is required" }, { status: 400 }) };
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      _count: {
        select: {
          likes: true,
        },
      },
    },
  });

  if (!book) {
    return { bookId, error: NextResponse.json({ error: "Book not found" }, { status: 404 }) };
  }

  return { bookId, book };
}

export async function GET(_request: Request, context: RouteContext) {
  // Анонимам отдаём только public-книги (обзор: метаданные + библиотечные
  // флажки). Авторизованные могут видеть свои приватные тоже. Чат, upload
  // и прочие write-операции остаются под auth (отдельные роуты + layout).
  const authUser = await resolveAuthUser();

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book } = resolved;

  const isOwner = Boolean(authUser && book.ownerUserId === authUser.id);
  if (!book.isPublic && !isOwner) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (book.analysisStatus !== "completed") {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  // Library state — mirror BookCardDTO semantics so the book detail
  // page can drive the same add/remove flow as Explore. Для анонима
  // флажки isInLibrary/can* остаются false — клиент не покажет кнопки.
  const existingLike = authUser
    ? await prisma.bookLike.findUnique({
        where: {
          bookId_userId: {
            bookId: book.id,
            userId: authUser.id,
          },
        },
        select: { bookId: true },
      })
    : null;
  const hasLibraryEntry = Boolean(existingLike);

  const dto = toBookCoreDTO(book);
  dto.canManage = isOwner;
  dto.isInLibrary = isOwner || hasLibraryEntry;
  dto.canAddToLibrary = Boolean(authUser) && !isOwner && book.isPublic && !hasLibraryEntry;
  dto.canRemoveFromLibrary = Boolean(authUser) && !isOwner && hasLibraryEntry;
  dto.libraryUsersCount = book._count.likes;
  return NextResponse.json(dto);
}

export async function DELETE(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book, bookId } = resolved;

  if (book.ownerUserId !== authUser.id) {
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
