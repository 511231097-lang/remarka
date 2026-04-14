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
  runBookChapterStructuralFacts,
  runBookLiteraryPatternPass,
  runBookLiterarySynthesisFromChapterFacts,
  type BookLiteraryMergeFactsChapterInput,
  type BookLiteraryPattern,
} from "../extractionV2";
import { logger } from "../logger";

interface ProcessBookLiteraryPayload {
  bookId: string;
}

interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book literary processing failed";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
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

function addUsage(target: UsageTotals, usage: { promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null } | null | undefined): void {
  const prompt = Number(usage?.promptTokens || 0);
  const completion = Number(usage?.completionTokens || 0);
  const total = Number(usage?.totalTokens || 0);
  if (Number.isFinite(prompt)) target.promptTokens += Math.max(0, Math.floor(prompt));
  if (Number.isFinite(completion)) target.completionTokens += Math.max(0, Math.floor(completion));
  if (Number.isFinite(total)) target.totalTokens += Math.max(0, Math.floor(total));
}

function compactChapterFactsForStorage(chapterFacts: BookLiteraryMergeFactsChapterInput[]) {
  return chapterFacts.map((chapter) => ({
    chapterOrderIndex: chapter.chapterOrderIndex,
    chapterTitle: chapter.chapterTitle,
    events: chapter.facts.events.slice(0, 10),
    characterChanges: chapter.facts.characterChanges.slice(0, 3),
    conflicts: chapter.facts.conflicts.slice(0, 4),
    symbols: chapter.facts.symbols.slice(0, 3),
    facts: chapter.facts.facts.slice(0, 8),
  }));
}

function compactPatternsForStorage(patterns: BookLiteraryPattern[]) {
  return patterns.map((pattern) => ({
    id: pattern.id,
    name: pattern.name,
    core: pattern.core,
    whyItMatters: pattern.whyItMatters,
    evidence: pattern.evidence.slice(0, 6),
    evolution: pattern.evolution,
    strength: pattern.strength,
  }));
}

export async function processBookLiterary(payload: ProcessBookLiteraryPayload) {
  const bookId = String(payload.bookId || "").trim();
  if (!bookId) {
    throw new Error("Invalid book literary payload: bookId is required");
  }

  const lockKey = `book-analyzer:literary:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const existingBook = await prisma.book.findUnique({
      where: { id: bookId },
      include: {
        analyzerTasks: {
          where: {
            analyzerType: "literary",
          },
          select: {
            state: true,
          },
          take: 1,
        },
        literaryAnalysis: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!existingBook) return;

    const literaryTaskState = existingBook.analyzerTasks[0]?.state || null;
    if (literaryTaskState === "completed" && existingBook.literaryAnalysis) {
      return;
    }

    const startedAt = new Date();
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "literary",
        },
      },
      create: {
        bookId,
        analyzerType: "literary",
        state: "running",
        error: null,
        startedAt,
        completedAt: null,
      },
      update: {
        state: "running",
        error: null,
        startedAt,
        completedAt: null,
      },
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

    const chapterFactsPasses: BookLiteraryMergeFactsChapterInput[] = [];
    const chapterUsageTotals: UsageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let chaptersSkippedEmpty = 0;

    for (let index = 0; index < parsedBook.chapters.length; index += 1) {
      const parsedChapter = parsedBook.chapters[index];
      const chapterOrderIndex = index + 1;
      const chapterTitle = resolveChapterTitle(parsedChapter, chapterOrderIndex);
      const chapterText = buildPlainTextFromParsedChapter(parsedChapter);

      if (!compactWhitespace(chapterText)) {
        chaptersSkippedEmpty += 1;
        continue;
      }

      const chapterCall = await runBookChapterStructuralFacts({
        bookTitle: existingBook.title,
        bookAuthor: existingBook.author || null,
        chapterOrderIndex,
        chapterTitle,
        chapterText,
      });

      addUsage(chapterUsageTotals, chapterCall.meta.usage);
      chapterFactsPasses.push({
        chapterOrderIndex,
        chapterTitle,
        facts: chapterCall.result,
      });
    }

    if (!chapterFactsPasses.length) {
      throw new Error("Book has no non-empty chapters for literary synthesis");
    }

    const patternCall = await runBookLiteraryPatternPass({
      bookTitle: existingBook.title,
      chapterCount: parsedBook.chapters.length,
      chapterFacts: chapterFactsPasses,
    });

    const mergeCall = await runBookLiterarySynthesisFromChapterFacts({
      bookTitle: existingBook.title,
      bookAuthor: existingBook.author || null,
      chapterCount: Math.max(0, Number(existingBook.chapterCount || 0)),
      chapterFacts: chapterFactsPasses,
      patterns: patternCall.result.patterns,
    });

    const sectionsJson = {
      sections: mergeCall.result.sections,
      chapterFacts: compactChapterFactsForStorage(chapterFactsPasses),
      patterns: compactPatternsForStorage(patternCall.result.patterns),
      patternCount: patternCall.result.patterns.length,
      pipeline: "chapter_facts_v4_pattern_pass_v4_final_v7",
      chapterFactsCount: chapterFactsPasses.length,
      generatedAt: new Date().toISOString(),
    };

    await prisma.$transaction(async (tx: any) => {
      await tx.bookLiteraryAnalysis.upsert({
        where: {
          bookId,
        },
        create: {
          bookId,
          sectionsJson,
        },
        update: {
          sectionsJson,
        },
      });

      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "literary",
          },
        },
        create: {
          bookId,
          analyzerType: "literary",
          state: "completed",
          error: null,
          startedAt,
          completedAt: new Date(),
        },
        update: {
          state: "completed",
          error: null,
          startedAt,
          completedAt: new Date(),
        },
      });
    });

    logger.info(
      {
        bookId,
        chapterCount: parsedBook.chapters.length,
        chapterFactsCount: chapterFactsPasses.length,
        chaptersSkippedEmpty,
        chapterFactsUsage: chapterUsageTotals,
        patternProvider: patternCall.meta.provider,
        patternModel: patternCall.meta.model,
        patternAttempt: patternCall.meta.attempt,
        patternFinishReason: patternCall.meta.finishReason,
        patternStartedAt: patternCall.meta.startedAt,
        patternCompletedAt: patternCall.meta.completedAt,
        patternLatencyMs: patternCall.meta.latencyMs,
        patternPromptTokens: patternCall.meta.usage?.promptTokens ?? null,
        patternCompletionTokens: patternCall.meta.usage?.completionTokens ?? null,
        patternTotalTokens: patternCall.meta.usage?.totalTokens ?? null,
        patternCount: patternCall.result.patterns.length,
        mergeProvider: mergeCall.meta.provider,
        mergeModel: mergeCall.meta.model,
        mergeAttempt: mergeCall.meta.attempt,
        mergeFinishReason: mergeCall.meta.finishReason,
        mergeStartedAt: mergeCall.meta.startedAt,
        mergeCompletedAt: mergeCall.meta.completedAt,
        mergeLatencyMs: mergeCall.meta.latencyMs,
        mergePromptTokens: mergeCall.meta.usage?.promptTokens ?? null,
        mergeCompletionTokens: mergeCall.meta.usage?.completionTokens ?? null,
        mergeTotalTokens: mergeCall.meta.usage?.totalTokens ?? null,
      },
      "Book literary analysis completed with chapter-facts + pattern-pass pipeline"
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "literary",
        },
      },
      create: {
        bookId,
        analyzerType: "literary",
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
    throw error;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}
