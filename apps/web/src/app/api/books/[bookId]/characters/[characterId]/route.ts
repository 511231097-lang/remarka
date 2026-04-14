import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toCharacterListItemDTO, toCharacterQuoteDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; characterId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const characterId = String(params.characterId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!characterId) {
    return NextResponse.json({ error: "characterId is required" }, { status: 400 });
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

  const character = await prisma.bookCharacter.findFirst({
    where: {
      id: characterId,
      bookId,
    },
    include: {
      quotes: {
        orderBy: [{ chapterOrderIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!character) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  const base = toCharacterListItemDTO(character);

  return NextResponse.json({
    ...base,
    firstAppearanceChapterOrder: character.firstAppearanceChapterOrder ?? null,
    quotes: character.quotes.map(toCharacterQuoteDTO),
  });
}
