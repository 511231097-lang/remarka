import { prisma } from "@remarka/db";

export async function resolveAccessibleBook(params: { bookId: string; userId: string }) {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return null;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      ownerUserId: true,
      isPublic: true,
    },
  });

  if (!book) return null;
  if (!book.isPublic && book.ownerUserId !== params.userId) return null;
  return book;
}

export async function resolveOwnedChatSession(params: {
  sessionId: string;
  bookId: string;
  userId: string;
}) {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return null;

  return prisma.bookChatSession.findFirst({
    where: {
      id: sessionId,
      bookId: params.bookId,
      userId: params.userId,
    },
  });
}
