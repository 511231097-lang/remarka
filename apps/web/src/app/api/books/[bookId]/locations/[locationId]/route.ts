import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toLocationListItemDTO, toLocationQuoteDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; locationId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const locationId = String(params.locationId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }
  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
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

  const location = await prisma.bookLocation.findFirst({
    where: {
      id: locationId,
      bookId,
    },
    include: {
      quotes: {
        orderBy: [{ chapterOrderIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const base = toLocationListItemDTO(location);

  return NextResponse.json({
    ...base,
    firstAppearanceChapterOrder: location.firstAppearanceChapterOrder ?? null,
    quotes: location.quotes.map(toLocationQuoteDTO),
  });
}
