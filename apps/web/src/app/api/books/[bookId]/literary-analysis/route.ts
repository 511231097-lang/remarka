import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookLiteraryAnalysisDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
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

  const analysis = await prisma.bookLiteraryAnalysis.findUnique({
    where: { bookId },
    select: {
      bookId: true,
      sectionsJson: true,
      updatedAt: true,
    },
  });

  if (!analysis) {
    return NextResponse.json({ error: "Literary analysis not found" }, { status: 404 });
  }

  return NextResponse.json(toBookLiteraryAnalysisDTO(analysis));
}
