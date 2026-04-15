import { LocalBlobStore, S3BlobStore, type BlobStore, prisma } from "@remarka/db";
import {
  buildPlainTextFromParsedChapter,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  normalizeEntityName,
  parseBook,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import {
  completedExecution,
  deferredLockExecution,
  type AnalyzerExecutionResult,
} from "../analyzerExecution";
import {
  runBookChapterLocations,
  runBookLocationProfileSynthesis,
} from "../extractionV2";
import { logger } from "../logger";

interface ProcessBookLocationsPayload {
  bookId: string;
}

interface LocationObservation {
  chapterOrderIndex: number;
  chapterTitle: string;
  normalizedName: string;
  name: string;
  aliases: Array<{
    value: string;
    normalized: string;
  }>;
  functionInChapter: string;
  mentionCount: number;
  quotes: Array<{
    text: string;
    context: string;
  }>;
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
  if (!error) return "Book locations processing failed";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/["'`’.,!?;:()[\]{}\-–—«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteExistsInChapter(quoteText: string, chapterSearchText: string): boolean {
  const needle = normalizeSearchText(quoteText);
  if (!needle || needle.length < 6) return false;
  return chapterSearchText.includes(needle);
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

function upsertPreferredLabel(labelByKey: Map<string, string>, key: string, candidate: string): void {
  const trimmed = compactWhitespace(candidate);
  if (!trimmed) return;
  const existing = labelByKey.get(key);
  if (!existing || trimmed.length > existing.length) {
    labelByKey.set(key, trimmed);
  }
}

function pickTopStringByWeight(weightByValue: Map<string, number>, fallback: string): string {
  let best = fallback;
  let bestWeight = Number.NEGATIVE_INFINITY;

  for (const [value, weight] of weightByValue.entries()) {
    if (weight > bestWeight || (weight === bestWeight && value.localeCompare(best, "ru") < 0)) {
      best = value;
      bestWeight = weight;
    }
  }

  return compactWhitespace(best) || fallback;
}

class DisjointSet {
  private parent = new Map<string, string>();

  find(value: string): string {
    const current = this.parent.get(value);
    if (!current) {
      this.parent.set(value, value);
      return value;
    }
    if (current === value) return value;
    const root = this.find(current);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) {
      this.parent.set(rightRoot, leftRoot);
      return;
    }
    this.parent.set(leftRoot, rightRoot);
  }
}

export async function processBookLocations(payload: ProcessBookLocationsPayload): Promise<AnalyzerExecutionResult> {
  const bookId = String(payload.bookId || "").trim();
  if (!bookId) {
    throw new Error("Invalid book locations payload: bookId is required");
  }

  const lockKey = `book-analyzer:locations:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) {
    return deferredLockExecution(
      `Book locations stage deferred because advisory lock is busy for ${bookId}`,
      workerConfig.outbox.deferredLockDelayMs
    );
  }

  try {
    const existingBook = await prisma.book.findUnique({
      where: { id: bookId },
      include: {
        analyzerTasks: {
          where: {
            analyzerType: "locations",
          },
          select: {
            state: true,
          },
          take: 1,
        },
      },
    });
    if (!existingBook) return completedExecution(`book ${bookId} not found for locations stage`);

    const existingTaskState = existingBook.analyzerTasks[0]?.state || null;
    if (existingTaskState === "completed") {
      const existingLocationsCount = await prisma.bookLocation.count({
        where: { bookId },
      });
      if (existingLocationsCount > 0) {
        return completedExecution("book locations already built");
      }
    }

    const startedAt = new Date();
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "locations",
        },
      },
      create: {
        bookId,
        analyzerType: "locations",
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

    const observations: LocationObservation[] = [];

    for (let index = 0; index < parsedBook.chapters.length; index += 1) {
      const parsedChapter = parsedBook.chapters[index];
      const chapterOrderIndex = index + 1;
      const chapterTitle = resolveChapterTitle(parsedChapter, chapterOrderIndex);
      const chapterText = buildPlainTextFromParsedChapter(parsedChapter);
      const chapterSearchText = normalizeSearchText(chapterText);
      if (!chapterSearchText) continue;

      const chapterLocationsCall = await runBookChapterLocations({
        chapterTitle,
        chapterText,
      });

      logger.info(
        {
          bookId,
          chapterOrderIndex,
          provider: chapterLocationsCall.meta.provider,
          model: chapterLocationsCall.meta.model,
          attempt: chapterLocationsCall.meta.attempt,
          finishReason: chapterLocationsCall.meta.finishReason,
          startedAt: chapterLocationsCall.meta.startedAt,
          completedAt: chapterLocationsCall.meta.completedAt,
          latencyMs: chapterLocationsCall.meta.latencyMs,
          promptTokens: chapterLocationsCall.meta.usage?.promptTokens ?? null,
          completionTokens: chapterLocationsCall.meta.usage?.completionTokens ?? null,
          totalTokens: chapterLocationsCall.meta.usage?.totalTokens ?? null,
          extractedLocations: chapterLocationsCall.result.locations.length,
        },
        "Book chapter locations generated"
      );

      for (const extractedLocation of chapterLocationsCall.result.locations) {
        const name = clampText(extractedLocation.name, 140);
        const normalizedName = normalizeEntityName(name);
        if (!normalizedName) continue;

        const aliases = extractedLocation.aliases
          .map((alias) => clampText(alias, 140))
          .map((alias) => ({
            value: alias,
            normalized: normalizeEntityName(alias),
          }))
          .filter((alias) => alias.value && alias.normalized && alias.normalized !== normalizedName)
          .slice(0, 16);
        const functionInChapter = clampText(extractedLocation.functionInChapter, 220) || "Важная локация главы";
        const mentionCount = Math.max(1, Math.min(500, Math.round(extractedLocation.mentionCount || 1)));

        const quoteMap = new Map<string, { text: string; context: string }>();
        for (const quote of extractedLocation.quotes) {
          const text = clampText(quote.text, 320);
          const context = clampText(quote.context, 320) || "Эпизод главы";
          if (!text || !context) continue;
          if (!quoteExistsInChapter(text, chapterSearchText)) continue;
          const key = text.toLowerCase();
          if (quoteMap.has(key)) continue;
          quoteMap.set(key, { text, context });
          if (quoteMap.size >= 8) break;
        }

        observations.push({
          chapterOrderIndex,
          chapterTitle,
          normalizedName,
          name,
          aliases,
          functionInChapter,
          mentionCount,
          quotes: Array.from(quoteMap.values()),
        });
      }
    }

    const unionFind = new DisjointSet();
    const labelByKey = new Map<string, string>();

    for (const observation of observations) {
      unionFind.find(observation.normalizedName);
      upsertPreferredLabel(labelByKey, observation.normalizedName, observation.name);

      for (const alias of observation.aliases) {
        unionFind.find(alias.normalized);
        unionFind.union(observation.normalizedName, alias.normalized);
        upsertPreferredLabel(labelByKey, alias.normalized, alias.value);
      }
    }

    type AggregatedChapterSignal = {
      chapterOrderIndex: number;
      chapterTitle: string;
      functionByWeight: Map<string, number>;
      quotes: Array<{ text: string; context: string }>;
    };

    type AggregatedLocation = {
      root: string;
      namesByWeight: Map<string, number>;
      mentionCount: number;
      firstAppearanceChapterOrder: number | null;
      aliasKeys: Set<string>;
      chapters: Map<number, AggregatedChapterSignal>;
    };

    const aggregatedByRoot = new Map<string, AggregatedLocation>();

    for (const observation of observations) {
      const root = unionFind.find(observation.normalizedName);
      const aggregated = aggregatedByRoot.get(root) || {
        root,
        namesByWeight: new Map<string, number>(),
        mentionCount: 0,
        firstAppearanceChapterOrder: null,
        aliasKeys: new Set<string>(),
        chapters: new Map<number, AggregatedChapterSignal>(),
      };
      aggregatedByRoot.set(root, aggregated);

      aggregated.mentionCount += observation.mentionCount;
      const currentNameWeight = aggregated.namesByWeight.get(observation.name) || 0;
      aggregated.namesByWeight.set(observation.name, currentNameWeight + observation.mentionCount);

      if (
        aggregated.firstAppearanceChapterOrder === null ||
        observation.chapterOrderIndex < aggregated.firstAppearanceChapterOrder
      ) {
        aggregated.firstAppearanceChapterOrder = observation.chapterOrderIndex;
      }

      aggregated.aliasKeys.add(observation.normalizedName);
      for (const alias of observation.aliases) {
        aggregated.aliasKeys.add(alias.normalized);
      }

      const chapterSignal = aggregated.chapters.get(observation.chapterOrderIndex) || {
        chapterOrderIndex: observation.chapterOrderIndex,
        chapterTitle: observation.chapterTitle,
        functionByWeight: new Map<string, number>(),
        quotes: [],
      };
      aggregated.chapters.set(observation.chapterOrderIndex, chapterSignal);

      const currentFunctionWeight = chapterSignal.functionByWeight.get(observation.functionInChapter) || 0;
      chapterSignal.functionByWeight.set(observation.functionInChapter, currentFunctionWeight + observation.mentionCount);

      const quoteMap = new Map(chapterSignal.quotes.map((quote) => [quote.text.toLowerCase(), quote] as const));
      for (const quote of observation.quotes) {
        const key = quote.text.toLowerCase();
        if (quoteMap.has(key)) continue;
        if (quoteMap.size >= 8) break;
        quoteMap.set(key, quote);
      }
      chapterSignal.quotes = Array.from(quoteMap.values()).slice(0, 8);
    }

    const aggregatedLocations = Array.from(aggregatedByRoot.values())
      .map((aggregated) => {
        const defaultName = labelByKey.get(aggregated.root) || "Неизвестная локация";
        const name = pickTopStringByWeight(aggregated.namesByWeight, defaultName);
        const normalizedName = normalizeEntityName(name) || aggregated.root;
        const aliases = Array.from(aggregated.aliasKeys)
          .map((key) => labelByKey.get(key) || "")
          .map((value) => clampText(value, 140))
          .filter(Boolean)
          .filter((value) => normalizeEntityName(value) !== normalizedName)
          .filter((value, index, array) => array.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index)
          .slice(0, 16);
        const chapters = Array.from(aggregated.chapters.values())
          .sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex)
          .map((chapterSignal) => ({
            chapterOrderIndex: chapterSignal.chapterOrderIndex,
            chapterTitle: chapterSignal.chapterTitle,
            functionInChapter: pickTopStringByWeight(chapterSignal.functionByWeight, "Важная локация главы"),
            quotes: chapterSignal.quotes.slice(0, 3),
          }));

        return {
          normalizedName,
          name,
          mentionCount: aggregated.mentionCount,
          firstAppearanceChapterOrder: aggregated.firstAppearanceChapterOrder,
          aliases,
          chapters,
        };
      })
      .sort((left, right) => {
        if (right.mentionCount !== left.mentionCount) return right.mentionCount - left.mentionCount;
        const leftFirst = left.firstAppearanceChapterOrder ?? Number.POSITIVE_INFINITY;
        const rightFirst = right.firstAppearanceChapterOrder ?? Number.POSITIVE_INFINITY;
        if (leftFirst !== rightFirst) return leftFirst - rightFirst;
        return left.name.localeCompare(right.name, "ru");
      })
      .slice(0, 60);

    const locationsForPersist: Array<{
      normalizedName: string;
      name: string;
      description: string;
      significance: string;
      mentionCount: number;
      firstAppearanceChapterOrder: number | null;
      quotes: Array<{
        chapterOrderIndex: number;
        text: string;
        context: string;
      }>;
    }> = [];

    for (const aggregatedLocation of aggregatedLocations) {
      const synthesisCall = await runBookLocationProfileSynthesis({
        bookTitle: existingBook.title,
        bookAuthor: existingBook.author || null,
        locationName: aggregatedLocation.name,
        aliases: aggregatedLocation.aliases,
        mentionCount: aggregatedLocation.mentionCount,
        firstAppearanceChapterOrder: aggregatedLocation.firstAppearanceChapterOrder,
        chapterSignals: aggregatedLocation.chapters.map((chapter) => ({
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          functionInChapter: chapter.functionInChapter,
          quotes: chapter.quotes,
        })),
      });

      logger.info(
        {
          bookId,
          locationName: aggregatedLocation.name,
          provider: synthesisCall.meta.provider,
          model: synthesisCall.meta.model,
          attempt: synthesisCall.meta.attempt,
          finishReason: synthesisCall.meta.finishReason,
          startedAt: synthesisCall.meta.startedAt,
          completedAt: synthesisCall.meta.completedAt,
          latencyMs: synthesisCall.meta.latencyMs,
          promptTokens: synthesisCall.meta.usage?.promptTokens ?? null,
          completionTokens: synthesisCall.meta.usage?.completionTokens ?? null,
          totalTokens: synthesisCall.meta.usage?.totalTokens ?? null,
        },
        "Book location profile synthesized"
      );

      const chapterQuotes = aggregatedLocation.chapters.flatMap((chapter) =>
        chapter.quotes.map((quote) => ({
          chapterOrderIndex: chapter.chapterOrderIndex,
          text: clampText(quote.text, 320),
          context: clampText(quote.context, 320) || "Эпизод главы",
        }))
      );
      const dedupedQuoteMap = new Map<string, { chapterOrderIndex: number; text: string; context: string }>();
      for (const quote of chapterQuotes) {
        if (!quote.text || !quote.context) continue;
        const key = `${quote.chapterOrderIndex}:${quote.text.toLowerCase()}`;
        if (dedupedQuoteMap.has(key)) continue;
        dedupedQuoteMap.set(key, quote);
        if (dedupedQuoteMap.size >= 12) break;
      }

      locationsForPersist.push({
        normalizedName: aggregatedLocation.normalizedName,
        name: clampText(aggregatedLocation.name, 140) || "Неизвестная локация",
        description:
          clampText(synthesisCall.result.description, 360) ||
          `${aggregatedLocation.name} — локация книги, упоминаемая в ключевых эпизодах.`,
        significance:
          clampText(synthesisCall.result.significance, 360) ||
          "Локация влияет на развитие событий и атмосферу произведения.",
        mentionCount: Math.max(1, Math.round(aggregatedLocation.mentionCount)),
        firstAppearanceChapterOrder: aggregatedLocation.firstAppearanceChapterOrder,
        quotes: Array.from(dedupedQuoteMap.values()),
      });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.bookLocation.deleteMany({
        where: { bookId },
      });

      for (const location of locationsForPersist) {
        const createdLocation = await tx.bookLocation.create({
          data: {
            bookId,
            name: location.name,
            normalizedName: location.normalizedName,
            description: location.description,
            significance: location.significance,
            mentionCount: location.mentionCount,
            firstAppearanceChapterOrder: location.firstAppearanceChapterOrder,
          },
          select: {
            id: true,
          },
        });

        if (location.quotes.length > 0) {
          await tx.bookLocationQuote.createMany({
            data: location.quotes.map((quote) => ({
              bookLocationId: createdLocation.id,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.context,
            })),
          });
        }
      }

      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "locations",
          },
        },
        create: {
          bookId,
          analyzerType: "locations",
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
        locationsPersisted: locationsForPersist.length,
      },
      "Book locations analysis completed"
    );
    return completedExecution();
  } catch (error) {
    const message = safeErrorMessage(error);
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "locations",
        },
      },
      create: {
        bookId,
        analyzerType: "locations",
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
