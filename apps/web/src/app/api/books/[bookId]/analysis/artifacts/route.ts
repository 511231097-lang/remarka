import { NextResponse } from "next/server";
import { getBookAnalysisArtifacts } from "@/lib/bookAnalysisService";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";

function parseLimit(url: URL): number {
  const raw = Number.parseInt(String(url.searchParams.get("limit") || ""), 10);
  if (!Number.isFinite(raw)) return 50;
  return Math.min(200, Math.max(1, raw));
}

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      bookId: string;
    }>;
  }
) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const limit = parseLimit(new URL(request.url));
  const artifacts = await getBookAnalysisArtifacts({
    bookId,
    limit,
  });

  if (!artifacts) {
    return NextResponse.json({ error: "Book not found", code: "BOOK_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(artifacts);
}
