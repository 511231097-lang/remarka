import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

// Personal data export — honours the right-to-portability declared in
// the Privacy policy (152-FZ art. 14 + the GDPR-style data-takeout norm).
//
// Returns a single JSON file with the user's profile, books, library
// entries, and chat history. Does NOT include:
//   - raw uploaded book files (large blobs, available on request via
//     privacy@ email — privacy п.10 makes this fallback explicit)
//   - auth internals (Account / Session / VerificationToken — nothing
//     user-meaningful, only OAuth refresh tokens etc.)
//   - per-turn LLM accounting (BookChatTurnMetric, BookChatToolRun) —
//     internal billing/observability data, not "the user's data"
//
// Schema versioning: bumped if the export shape changes so downstream
// tooling (or a future re-import path) can branch on it.

const EXPORT_SCHEMA_VERSION = 1;

type ExportPayload = {
  exportedAt: string;
  schemaVersion: number;
  notes: string[];
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    role: string;
    createdAt: string;
  } | null;
  books: Array<{
    id: string;
    title: string;
    author: string | null;
    isPublic: boolean;
    analysisState: string;
    chapterCount: number;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    summary: string | null;
    showcase: unknown;
  }>;
  libraryEntries: Array<{
    bookId: string;
    addedAt: string;
  }>;
  chats: Array<{
    bookId: string;
    threads: Array<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      compactedHistory: string | null;
      messages: Array<{
        id: string;
        role: string;
        content: string;
        createdAt: string;
      }>;
    }>;
  }>;
};

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user, ownedBooks, libraryEntries, threads] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    }),
    prisma.book.findMany({
      where: { ownerUserId: authUser.id },
      orderBy: { createdAt: "asc" },
      include: {
        summaryArtifacts: {
          where: { kind: "book_brief" },
          select: { summary: true, bodyMarkdown: true, metadataJson: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.bookLike.findMany({
      where: { userId: authUser.id },
      orderBy: { createdAt: "asc" },
      select: { bookId: true, createdAt: true },
    }),
    prisma.bookChatThread.findMany({
      where: { ownerUserId: authUser.id },
      orderBy: [{ bookId: "asc" }, { createdAt: "asc" }],
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  // User row should always exist (we just resolved auth from it). The
  // null branch is just a type-safety belt.
  const userPayload = user
    ? {
        ...user,
        // createdAt isn't stored on User in this schema (NextAuth default
        // doesn't add it), so emit the export time instead — best effort.
        createdAt: new Date().toISOString(),
      }
    : null;

  // Group threads by bookId for a more readable export (one entry per
  // book containing all the conversations the user had with it).
  const chatsByBook = new Map<string, ExportPayload["chats"][number]>();
  for (const thread of threads) {
    const entry = chatsByBook.get(thread.bookId) ?? {
      bookId: thread.bookId,
      threads: [],
    };
    entry.threads.push({
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      compactedHistory: thread.compactedHistory ?? null,
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
    });
    chatsByBook.set(thread.bookId, entry);
  }

  const payload: ExportPayload = {
    exportedAt: new Date().toISOString(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    notes: [
      "Этот файл — выгрузка ваших данных из сервиса ремарка по правилам политики обработки ПДн (п. 10).",
      "Сюда НЕ входят: исходные загруженные файлы книг (выгружаются по запросу на privacy@remarka.app — это слишком тяжёлые объекты для веб-выгрузки), служебные токены авторизации, внутренние метрики LLM.",
      "Поле books[].showcase — это публичный AI-разбор книги (если он был сгенерирован), он не уникален для вас как пользователя.",
      "Поле chats[].threads[].compactedHistory — текст сжатого summary вашей более ранней истории чата (используется внутри для экономии токенов).",
    ],
    user: userPayload,
    books: ownedBooks.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      isPublic: book.isPublic,
      analysisState: book.analysisState,
      chapterCount: book.chapterCount,
      fileName: book.fileName,
      mimeType: book.mimeType,
      sizeBytes: book.sizeBytes,
      createdAt: book.createdAt.toISOString(),
      summary: book.summary,
      showcase: book.summaryArtifacts[0] ?? null,
    })),
    libraryEntries: libraryEntries.map((entry) => ({
      bookId: entry.bookId,
      addedAt: entry.createdAt.toISOString(),
    })),
    chats: Array.from(chatsByBook.values()),
  };

  const body = JSON.stringify(payload, null, 2);
  const filename = `remarka-export-${authUser.id}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
