import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { fetchBookShowcase, isBookVisibleToViewer } from "@/lib/server/bookView";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  // Showcase (summary/themes/characters/events/quotes) — read-only. Анонимам
  // отдаём для public-книг; чат и тяжёлые tools остаются под auth.
  const authUser = await resolveAuthUser();

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, isPublic: true, ownerUserId: true },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (!isBookVisibleToViewer(book, authUser ? { id: authUser.id } : null)) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const showcase = await fetchBookShowcase(bookId);
  return NextResponse.json({ item: showcase });
}
