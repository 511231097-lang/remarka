import { NextResponse } from "next/server";
import { BookAnalysisRequestError, getBookAnalysis, requestBookAnalysis } from "@/lib/bookAnalysisService";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";

export async function GET(
  _request: Request,
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

  const analysis = await getBookAnalysis(bookId);

  if (!analysis) {
    return NextResponse.json({ error: "Book not found", code: "BOOK_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(analysis);
}

export async function POST(
  _request: Request,
  context: {
    params: Promise<{
      bookId: string;
    }>;
  }
) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const params = await context.params;
    const bookId = String(params.bookId || "").trim();
    const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
    if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });
    const analysis = await requestBookAnalysis(bookId, "manual");
    return NextResponse.json({ queued: true, analysis }, { status: 202 });
  } catch (error) {
    if (error instanceof BookAnalysisRequestError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    return NextResponse.json({ error: "Failed to request analysis", code: "ANALYSIS_REQUEST_FAILED" }, { status: 500 });
  }
}
