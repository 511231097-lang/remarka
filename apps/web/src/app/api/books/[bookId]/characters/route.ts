import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toCharacterListItemDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
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
  const limit = parseLimit(searchParams.get("limit"));

  const [total, rows] = await prisma.$transaction([
    prisma.bookCharacter.count({
      where: { bookId },
    }),
    prisma.bookCharacter.findMany({
      where: { bookId },
      orderBy: [
        { mentionCount: "desc" },
        { firstAppearanceChapterOrder: "asc" },
        { name: "asc" },
      ],
      take: limit,
    }),
  ]);

  return NextResponse.json({
    items: rows.map(toCharacterListItemDTO),
    total,
  });
}
