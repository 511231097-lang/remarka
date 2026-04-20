import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

async function resolveBookForLibrary(context: RouteContext) {
  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return {
      bookId,
      error: NextResponse.json({ error: "bookId is required" }, { status: 400 }),
    };
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      ownerUserId: true,
      isPublic: true,
    },
  });

  if (!book) {
    return {
      bookId,
      error: NextResponse.json({ error: "Book not found" }, { status: 404 }),
    };
  }

  return { bookId, book };
}

function toLibraryState(bookId: string, isInLibrary: boolean, libraryUsersCount: number) {
  return {
    bookId,
    isInLibrary,
    libraryUsersCount,
  };
}

export async function POST(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBookForLibrary(context);
  if (resolved.error) return resolved.error;

  const { bookId, book } = resolved;
  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (book.ownerUserId === authUser.id) {
    const libraryUsersCount = await prisma.bookLike.count({ where: { bookId } });
    return NextResponse.json(toLibraryState(bookId, true, libraryUsersCount));
  }

  if (!book.isPublic) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const [, libraryUsersCount] = await prisma.$transaction([
    prisma.bookLike.upsert({
      where: {
        bookId_userId: {
          bookId,
          userId: authUser.id,
        },
      },
      update: {},
      create: {
        bookId,
        userId: authUser.id,
      },
    }),
    prisma.bookLike.count({
      where: { bookId },
    }),
  ]);

  return NextResponse.json(toLibraryState(bookId, true, libraryUsersCount));
}

export async function DELETE(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBookForLibrary(context);
  if (resolved.error) return resolved.error;

  const { bookId, book } = resolved;
  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (book.ownerUserId === authUser.id) {
    return NextResponse.json({ error: "Cannot remove own book from library" }, { status: 403 });
  }

  if (!book.isPublic) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const [, libraryUsersCount] = await prisma.$transaction([
    prisma.bookLike.deleteMany({
      where: {
        bookId,
        userId: authUser.id,
      },
    }),
    prisma.bookLike.count({
      where: { bookId },
    }),
  ]);

  return NextResponse.json(toLibraryState(bookId, false, libraryUsersCount));
}
