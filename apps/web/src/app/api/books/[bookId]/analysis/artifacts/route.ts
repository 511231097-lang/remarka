import { NextResponse } from "next/server";
import { getBookAnalysisArtifacts } from "@/lib/bookAnalysisService";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";

function parseLimit(url: URL): number {
  const raw = Number.parseInt(String(url.searchParams.get("limit") || ""), 10);
  if (!Number.isFinite(raw)) return 50;
  return Math.min(200, Math.max(1, raw));
}

function parseIncludePayload(url: URL): boolean {
  const normalized = String(url.searchParams.get("includePayload") || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
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

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const artifacts = await getBookAnalysisArtifacts({
    bookId,
    limit,
    runId: url.searchParams.get("runId"),
    includePayload: parseIncludePayload(url),
  });

  if (!artifacts) {
    return NextResponse.json({ error: "Book not found", code: "BOOK_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(artifacts);
}
