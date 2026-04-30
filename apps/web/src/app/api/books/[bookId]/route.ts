import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookCoreDTO } from "@/lib/books";
import { deleteArtifactPayloadsForBook, deleteBookBlob } from "@/lib/bookStorageCleanup";

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
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book } = resolved;

  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (book.analysisStatus !== "completed") {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  // Library state — mirror BookCardDTO semantics so the book detail
  // page can drive the same add/remove flow as Explore.
  const isOwner = book.ownerUserId === authUser.id;
  const existingLike = await prisma.bookLike.findUnique({
    where: {
      bookId_userId: {
        bookId: book.id,
        userId: authUser.id,
      },
    },
    select: { bookId: true },
  });
  const hasLibraryEntry = Boolean(existingLike);

  const dto = toBookCoreDTO(book);
  dto.canManage = isOwner;
  dto.isInLibrary = isOwner || hasLibraryEntry;
  dto.canAddToLibrary = !isOwner && book.isPublic && !hasLibraryEntry;
  dto.canRemoveFromLibrary = !isOwner && hasLibraryEntry;
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

  try {
    await deleteBookBlob({
      storageProvider: book.storageProvider,
      storageKey: book.storageKey,
    });
  } catch {
    // Blob cleanup failures should not block successful book deletion.
  }

  try {
    await deleteArtifactPayloadsForBook(bookId);
  } catch {
    // Artifact payload cleanup failures should not block successful book deletion.
  }

  return new NextResponse(null, { status: 204 });
}
