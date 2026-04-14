import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook, resolveOwnedChatSession } from "@/lib/chatAccess";
import { toBookChatMessageDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
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

  const session = await resolveOwnedChatSession({
    sessionId,
    bookId,
    userId: authUser.id,
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const messages = await prisma.bookChatMessage.findMany({
    where: {
      sessionId: session.id,
    },
    orderBy: [{ createdAt: "asc" }],
  });

  return NextResponse.json({
    items: messages.map(toBookChatMessageDTO),
  });
}
