import { NextResponse } from "next/server";
import { getBookAnalysisRun } from "@/lib/bookAnalysisService";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      bookId: string;
      runId: string;
    }>;
  }
) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const runId = String(params.runId || "").trim();
  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const run = await getBookAnalysisRun({
    bookId,
    runId,
  });

  if (!run) {
    return NextResponse.json({ error: "Analysis run not found", code: "RUN_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(run);
}
