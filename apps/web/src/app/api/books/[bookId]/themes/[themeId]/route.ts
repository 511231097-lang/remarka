import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toThemeListItemDTO, toThemeQuoteDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; themeId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const themeId = String(params.themeId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!themeId) {
    return NextResponse.json({ error: "themeId is required" }, { status: 400 });
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

  const theme = await prisma.bookTheme.findFirst({
    where: {
      id: themeId,
      bookId,
    },
    include: {
      quotes: {
        orderBy: [{ chapterOrderIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!theme) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }

  const base = toThemeListItemDTO(theme);

  return NextResponse.json({
    ...base,
    firstAppearanceChapterOrder: theme.firstAppearanceChapterOrder ?? null,
    quotes: theme.quotes.map(toThemeQuoteDTO),
  });
}
