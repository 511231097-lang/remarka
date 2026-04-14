import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { toBookChatSessionDTO } from "@/lib/books";
import { BookChatTurnStateSchema } from "@remarka/contracts";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  const sessions = await prisma.bookChatSession.findMany({
    where: {
      bookId,
      userId: authUser.id,
    },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    take: 50,
  });

  return NextResponse.json({
    items: sessions.map(toBookChatSessionDTO),
  });
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

  const session = await prisma.bookChatSession.create({
    data: {
      bookId,
      userId: authUser.id,
      title,
      lastMessageAt: null,
    },
  });

  await prisma.bookChatSessionState.create({
    data: {
      sessionId: session.id,
      bookId,
      stateJson: BookChatTurnStateSchema.parse({}) as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({
    session: toBookChatSessionDTO(session),
  });
}
