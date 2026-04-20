import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { BookChatError, deleteBookChatThread, listBookChatThreads } from "@/lib/bookChatService";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

function toSessionDTO(thread: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}) {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastMessageAt: thread.messageCount > 0 ? thread.updatedAt : null,
  };
}

async function resolveContext(context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sessionId = String(params.sessionId || "").trim();

  if (!bookId) return { error: NextResponse.json({ error: "bookId is required" }, { status: 400 }) };
  if (!sessionId) return { error: NextResponse.json({ error: "sessionId is required" }, { status: 400 }) };

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return { error: NextResponse.json({ error: "Book not found" }, { status: 404 }) };

  return { bookId: book.id, sessionId, authUserId: authUser.id };
}

export async function GET(_request: Request, context: RouteContext) {
  const resolved = await resolveContext(context);
  if ("error" in resolved) return resolved.error;

  try {
    const threads = await listBookChatThreads({
      bookId: resolved.bookId,
      ownerUserId: resolved.authUserId,
    });
    const thread = threads.find((item) => item.id === resolved.sessionId);
    if (!thread) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    return NextResponse.json({
      session: toSessionDTO(thread),
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to load chat session" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const resolved = await resolveContext(context);
  if ("error" in resolved) return resolved.error;

  try {
    await deleteBookChatThread({
      bookId: resolved.bookId,
      threadId: resolved.sessionId,
      ownerUserId: resolved.authUserId,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to delete chat session" }, { status: 500 });
  }
}
