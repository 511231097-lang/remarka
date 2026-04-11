import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

async function resolveBookForLike(context: RouteContext) {
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

  if (!book || !book.isPublic) {
    return {
      bookId,
      error: NextResponse.json({ error: "Book not found" }, { status: 404 }),
    };
  }

  return { bookId, book };
}

function forbidSelfLike() {
  return NextResponse.json({ error: "Cannot like your own book" }, { status: 403 });
}

export async function POST(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBookForLike(context);
  if (resolved.error) return resolved.error;

  const { bookId, book } = resolved;
  if (book.ownerUserId === authUser.id) {
    return forbidSelfLike();
  }

  const [, likesCount] = await prisma.$transaction([
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
      where: {
        bookId,
      },
    }),
  ]);

  return NextResponse.json({
    bookId,
    isLiked: true,
    likesCount,
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBookForLike(context);
  if (resolved.error) return resolved.error;

  const { bookId, book } = resolved;
  if (book.ownerUserId === authUser.id) {
    return forbidSelfLike();
  }

  const [, likesCount] = await prisma.$transaction([
    prisma.bookLike.deleteMany({
      where: {
        bookId,
        userId: authUser.id,
      },
    }),
    prisma.bookLike.count({
      where: {
        bookId,
      },
    }),
  ]);

  return NextResponse.json({
    bookId,
    isLiked: false,
    likesCount,
  });
}
