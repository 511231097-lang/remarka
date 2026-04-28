import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookShowcaseDTO } from "@/lib/books";
import { resolveAccessibleBook } from "@/lib/chatAccess";

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

  const book = await resolveAccessibleBook({
    bookId,
    userId: authUser.id,
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const artifact = await prisma.bookSummaryArtifact.findUnique({
    where: {
      bookId_kind_key: {
        bookId,
        kind: "book_brief",
        key: "showcase_v2",
      },
    },
    select: {
      bookId: true,
      summary: true,
      metadataJson: true,
      updatedAt: true,
    },
  });

  if (!artifact) {
    return NextResponse.json({ item: null });
  }

  return NextResponse.json({
    item: toBookShowcaseDTO(artifact),
  });
}
