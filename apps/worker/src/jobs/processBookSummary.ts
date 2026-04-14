import { LocalBlobStore, S3BlobStore, type BlobStore, prisma } from "@remarka/db";
import {
  buildPlainTextFromParsedChapter,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  parseBook,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import {
  runBookChapterSummary,
  runBookSummaryFromChapterSummaries,
} from "../extractionV2";
import { logger } from "../logger";

interface ProcessBookSummaryPayload {
  bookId: string;
}

function resolveUploadFormat(fileName: string): BookFormat | null {
  const detected = detectBookFormatFromFileName(fileName);
  if (detected) return detected;
  if (String(fileName || "").toLowerCase().endsWith(".zip")) return "fb2_zip";
  return null;
}

function resolveChapterTitle(chapter: ParsedChapter, orderIndex: number): string {
  const title = String(chapter.title || "").trim();
  return title || `Глава ${orderIndex}`;
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(value: string, maxChars: number): string {
  const text = compactWhitespace(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book summary processing failed";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function resolveBooksBlobStore(storageProviderRaw: string): BlobStore {
  const storageProvider = String(storageProviderRaw || "").trim().toLowerCase();

  if (storageProvider === "s3") {
    const bucket = String(workerConfig.books.s3.bucket || "").trim();
    if (!bucket) {
      throw new Error("BOOKS_S3_BUCKET is required to read s3 book blobs");
    }

    return new S3BlobStore({
      bucket,
      region: workerConfig.books.s3.region,
      endpoint: workerConfig.books.s3.endpoint || undefined,
      keyPrefix: workerConfig.books.s3.keyPrefix,
      forcePathStyle: workerConfig.books.s3.forcePathStyle,
      credentials:
        workerConfig.books.s3.accessKeyId && workerConfig.books.s3.secretAccessKey
          ? {
              accessKeyId: workerConfig.books.s3.accessKeyId,
              secretAccessKey: workerConfig.books.s3.secretAccessKey,
              sessionToken: workerConfig.books.s3.sessionToken || undefined,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir: workerConfig.books.localDir,
    provider: "local",
  });
}

export async function processBookSummary(payload: ProcessBookSummaryPayload) {
  const bookId = String(payload.bookId || "").trim();
  if (!bookId) {
    throw new Error("Invalid book summary payload: bookId is required");
  }

  const lockKey = `book-analyzer:summary:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const existingBook = await prisma.book.findUnique({
      where: { id: bookId },
      include: {
        chapters: {
          orderBy: { orderIndex: "asc" },
          select: {
            id: true,
            orderIndex: true,
            summary: true,
          },
        },
        analyzerTasks: {
          where: {
            analyzerType: "summary",
          },
          select: {
            state: true,
          },
          take: 1,
        },
      },
    });

    if (!existingBook) {
      return;
    }

    const hasBookSummary = compactWhitespace(existingBook.summary || "").length > 0;
    const chaptersHaveSummaries = existingBook.chapters.every((chapter) => compactWhitespace(chapter.summary || "").length > 0);
    const summaryTaskState = existingBook.analyzerTasks[0]?.state || null;
    if (summaryTaskState === "completed" && hasBookSummary && chaptersHaveSummaries) {
      return;
    }

    const analysisStartedAt = new Date();
    await prisma.$transaction(async (tx: any) => {
      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "summary",
          },
        },
        create: {
          bookId,
          analyzerType: "summary",
          state: "running",
          error: null,
          startedAt: analysisStartedAt,
          completedAt: null,
        },
        update: {
          state: "running",
          error: null,
          startedAt: analysisStartedAt,
          completedAt: null,
        },
      });

      await tx.book.updateMany({
        where: { id: bookId },
        data: {
          analysisState: "running",
          analysisError: null,
          analysisStartedAt,
          analysisCompletedAt: null,
        },
      });
    });

    const format = resolveUploadFormat(existingBook.fileName);
    if (!format) {
      throw new Error(`Unsupported stored book format: ${existingBook.fileName}`);
    }

    const blobStore = resolveBooksBlobStore(existingBook.storageProvider);
    const bytes = await blobStore.get(existingBook.storageKey);
    const parsedBook = ensureParsedBookHasChapters(
      await parseBook({
        format,
        fileName: existingBook.fileName,
        bytes,
        maxZipUncompressedBytes: workerConfig.imports.maxZipUncompressedBytes,
      })
    );

    const chapterSummaries: Array<{
      orderIndex: number;
      title: string;
      summary: string;
    }> = [];

    for (let index = 0; index < parsedBook.chapters.length; index += 1) {
      const parsedChapter = parsedBook.chapters[index];
      const orderIndex = index + 1;
      const title = resolveChapterTitle(parsedChapter, orderIndex);
      const chapterText = buildPlainTextFromParsedChapter(parsedChapter);

      const summaryCall = await runBookChapterSummary({
        chapterTitle: title,
        chapterText,
      });
      const summary = clampText(summaryCall.result.summary, 200);
      if (!summary) {
        throw new Error(`Chapter summary is empty for chapter ${orderIndex}`);
      }

      chapterSummaries.push({
        orderIndex,
        title,
        summary,
      });

      logger.info(
        {
          bookId,
          chapterOrderIndex: orderIndex,
          provider: summaryCall.meta.provider,
          model: summaryCall.meta.model,
          attempt: summaryCall.meta.attempt,
          finishReason: summaryCall.meta.finishReason,
          startedAt: summaryCall.meta.startedAt,
          completedAt: summaryCall.meta.completedAt,
          latencyMs: summaryCall.meta.latencyMs,
          promptTokens: summaryCall.meta.usage?.promptTokens ?? null,
          completionTokens: summaryCall.meta.usage?.completionTokens ?? null,
          totalTokens: summaryCall.meta.usage?.totalTokens ?? null,
        },
        "Book chapter summary generated"
      );
    }

    if (!chapterSummaries.length) {
      throw new Error("No chapters available for summary generation");
    }

    const bookSummaryCall = await runBookSummaryFromChapterSummaries({
      bookTitle: existingBook.title,
      author: existingBook.author || null,
      chapterSummaries,
    });
    const bookSummary = clampText(bookSummaryCall.result.summary, 280);
    if (!bookSummary) {
      throw new Error("Book summary is empty");
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "summary",
          },
        },
        create: {
          bookId,
          analyzerType: "summary",
          state: "completed",
          error: null,
          startedAt: analysisStartedAt,
          completedAt: new Date(),
        },
        update: {
          state: "completed",
          error: null,
          startedAt: analysisStartedAt,
          completedAt: new Date(),
        },
      });

      await tx.book.updateMany({
        where: { id: bookId },
        data: {
          summary: bookSummary,
          analysisState: "completed",
          analysisError: null,
          analysisStartedAt,
          analysisCompletedAt: new Date(),
        },
      });

      for (const chapter of chapterSummaries) {
        await tx.bookChapter.updateMany({
          where: {
            bookId,
            orderIndex: chapter.orderIndex,
          },
          data: {
            summary: chapter.summary,
          },
        });
      }
    });

    logger.info(
      {
        bookId,
        chaptersProcessed: chapterSummaries.length,
        provider: bookSummaryCall.meta.provider,
        model: bookSummaryCall.meta.model,
        attempt: bookSummaryCall.meta.attempt,
        finishReason: bookSummaryCall.meta.finishReason,
        startedAt: bookSummaryCall.meta.startedAt,
        completedAt: bookSummaryCall.meta.completedAt,
        latencyMs: bookSummaryCall.meta.latencyMs,
        promptTokens: bookSummaryCall.meta.usage?.promptTokens ?? null,
        completionTokens: bookSummaryCall.meta.usage?.completionTokens ?? null,
        totalTokens: bookSummaryCall.meta.usage?.totalTokens ?? null,
      },
      "Book summary analysis completed"
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    await prisma.$transaction(async (tx: any) => {
      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "summary",
          },
        },
        create: {
          bookId,
          analyzerType: "summary",
          state: "failed",
          error: message,
          startedAt: null,
          completedAt: new Date(),
        },
        update: {
          state: "failed",
          error: message,
          completedAt: new Date(),
        },
      });

      await tx.book.updateMany({
        where: { id: bookId },
        data: {
          analysisState: "failed",
          analysisError: message,
          analysisCompletedAt: new Date(),
        },
      });
    });
    throw error;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}
