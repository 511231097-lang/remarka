import { prisma } from "./client";
import {
  createBookTextCorpusBlobStoreFromEnv,
  putBookTextCorpus,
  type BookTextCorpusChapter,
} from "./bookTextCorpusStore";

function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const normalized = String(process.env[name] || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function main() {
  const batchSize = parsePositiveIntEnv("BOOK_TEXT_CORPUS_BACKFILL_BATCH_SIZE", 25);
  const maxBooks = parsePositiveIntEnv("BOOK_TEXT_CORPUS_BACKFILL_MAX_BOOKS", Number.MAX_SAFE_INTEGER);
  const dryRun = parseBooleanEnv("BOOK_TEXT_CORPUS_BACKFILL_DRY_RUN", false);
  const stopOnError = parseBooleanEnv("BOOK_TEXT_CORPUS_BACKFILL_STOP_ON_ERROR", false);
  let cursorId = String(process.env.BOOK_TEXT_CORPUS_BACKFILL_AFTER_ID || "").trim() || null;

  const store = createBookTextCorpusBlobStoreFromEnv();
  const startedAt = Date.now();
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let maxReached = false;

  console.info("[book-text-corpus-backfill] started", {
    batchSize,
    maxBooks,
    dryRun,
    cursorId,
  });

  while (true) {
    const take = Math.min(batchSize, Math.max(0, maxBooks - scanned));
    if (take <= 0) {
      maxReached = true;
      break;
    }

    const rows = await prisma.book.findMany({
      where: {
        textCorpusStorageKey: null,
        chapters: {
          some: {
            rawText: {
              not: null,
            },
          },
        },
      },
      orderBy: {
        id: "asc",
      },
      ...(cursorId
        ? {
            cursor: {
              id: cursorId,
            },
            skip: 1,
          }
        : {}),
      take,
      select: {
        id: true,
        title: true,
        chapters: {
          orderBy: {
            orderIndex: "asc",
          },
          select: {
            id: true,
            orderIndex: true,
            title: true,
            rawText: true,
          },
        },
      },
    });

    if (!rows.length) {
      break;
    }

    for (const book of rows) {
      if (scanned >= maxBooks) {
        maxReached = true;
        break;
      }

      scanned += 1;
      cursorId = book.id;
      const chapters: BookTextCorpusChapter[] = book.chapters.map((chapter) => ({
        chapterId: String(chapter.id),
        orderIndex: Number(chapter.orderIndex || 0),
        title: String(chapter.title || "").trim(),
        rawText: String(chapter.rawText || ""),
      }));
      const hasAnyText = chapters.some((chapter) => chapter.rawText.length > 0);

      if (!hasAnyText) {
        skipped += 1;
        console.info("[book-text-corpus-backfill] skipped empty", {
          bookId: book.id,
          chapterCount: chapters.length,
        });
        continue;
      }

      if (dryRun) {
        migrated += 1;
        console.info("[book-text-corpus-backfill] dry-run", {
          bookId: book.id,
          chapterCount: chapters.length,
        });
        continue;
      }

      let uploadedKey: string | null = null;
      try {
        const stored = await putBookTextCorpus({
          store,
          bookId: book.id,
          chapters,
        });
        uploadedKey = stored.storageKey;

        const updateResult = await prisma.book.updateMany({
          where: {
            id: book.id,
            textCorpusStorageKey: null,
          },
          data: {
            textCorpusStorageProvider: stored.provider,
            textCorpusStorageKey: stored.storageKey,
            textCorpusSizeBytes: stored.sizeBytes,
            textCorpusSha256: stored.sha256,
            textCorpusCompression: stored.compression,
            textCorpusSchemaVersion: stored.schemaVersion,
          },
        });

        if (updateResult.count === 0) {
          skipped += 1;
          try {
            await store.delete(stored.storageKey);
          } catch {
            // no-op
          }
          console.info("[book-text-corpus-backfill] skipped race", {
            bookId: book.id,
          });
          continue;
        }

        migrated += 1;
        console.info("[book-text-corpus-backfill] migrated", {
          bookId: book.id,
          chapterCount: chapters.length,
          storageKey: stored.storageKey,
          sizeBytes: stored.sizeBytes,
        });
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error("[book-text-corpus-backfill] failed", {
          bookId: book.id,
          error: message,
        });

        if (uploadedKey) {
          try {
            await store.delete(uploadedKey);
          } catch {
            // no-op
          }
        }

        if (stopOnError) {
          throw error;
        }
      }
    }

    if (maxReached) break;
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  console.info("[book-text-corpus-backfill] completed", {
    scanned,
    migrated,
    skipped,
    failed,
    elapsedMs,
    nextCursor: cursorId,
    maxReached,
  });

  if (failed > 0 && !dryRun) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[book-text-corpus-backfill] fatal", { error: message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

