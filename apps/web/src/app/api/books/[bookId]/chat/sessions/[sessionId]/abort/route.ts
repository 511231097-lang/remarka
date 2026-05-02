/**
 * Abort an in-flight chat turn.
 *
 * POST /api/books/[bookId]/chat/sessions/[sessionId]/abort
 *   ← 200 { aborted: boolean }
 *
 * Soft abort: sets a flag in the registry so the background runner stops
 * emitting events. The underlying LLM call may still complete on the
 * provider side (Vertex doesn't always honor cancellation), but the user
 * won't see further tokens. The runner emits a final `chat.error` with
 * code "ABORTED" on the way out.
 */

import { NextResponse } from "next/server";

import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { chatRegistry } from "@/lib/events/chatRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sessionId = String(params.sessionId || "").trim();
  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  // Verify the user can access this book — abort calls without context could
  // otherwise be used to probe session ids.
  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const aborted = chatRegistry.abort(sessionId, authUser.id);
  return NextResponse.json({ aborted });
}
