import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { BookChatError, createBookChatThread, listBookChatThreads } from "@/lib/bookChatService";

interface RouteContext {
  params: Promise<{ bookId: string }>;
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

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  try {
    const threads = await listBookChatThreads(book.id);
    return NextResponse.json({
      items: threads.map(toSessionDTO),
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to list chat sessions" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const title = String(body.title || "").trim().slice(0, 120) || "Новый чат";

  try {
    const thread = await createBookChatThread({
      bookId: book.id,
      title,
    });

    return NextResponse.json({
      session: toSessionDTO(thread),
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to create chat session" }, { status: 500 });
  }
}
