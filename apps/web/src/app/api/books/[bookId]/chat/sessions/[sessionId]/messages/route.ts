import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { BookChatError, listBookChatMessages } from "@/lib/bookChatService";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

function toMessageDTO(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    rawAnswer: message.role === "assistant" ? message.content : null,
    evidence: [],
    usedSources: [],
    confidence: null,
    mode: null,
    citations: [],
    inlineCitations: [],
    answerItems: [],
    referenceResolution: null,
    createdAt: message.createdAt,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sessionId = String(params.sessionId || "").trim();

  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  try {
    const messages = await listBookChatMessages({
      bookId: book.id,
      threadId: sessionId,
      ownerUserId: authUser.id,
    });

    return NextResponse.json({
      items: messages.map(toMessageDTO),
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to list chat messages" }, { status: 500 });
  }
}
