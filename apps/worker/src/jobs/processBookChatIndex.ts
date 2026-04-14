import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
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
import { logger } from "../logger";

interface ProcessBookChatIndexPayload {
  bookId: string;
}

interface ChapterTextRecord {
  orderIndex: number;
  title: string;
  rawText: string;
}

interface ChunkCandidate {
  id: string;
  bookId: string;
  chapterOrderIndex: number;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  embeddingModel: string;
  metadataJson: Record<string, unknown>;
  embedding: number[];
}

interface VertexEmbeddingPrediction {
  embeddings?: {
    values?: unknown;
    statistics?: {
      truncated?: boolean;
      token_count?: number;
    };
  };
}

interface VertexEmbeddingResponse {
  predictions?: VertexEmbeddingPrediction[];
}

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book chat index processing failed";
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

function clampDimensions(values: number[], dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) return values;
  if (values.length === dimensions) return values;
  if (values.length > dimensions) return values.slice(0, dimensions);

  const out = [...values];
  while (out.length < dimensions) {
    out.push(0);
  }
  return out;
}

function toVectorLiteral(values: number[]): string {
  const serialized = values
    .map((value) => {
      if (!Number.isFinite(value)) return "0";
      return String(value);
    })
    .join(",");
  return `[${serialized}]`;
}

function getSafeConcurrency(value: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.max(1, Math.floor(parsed));
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const out: T[][] = [];
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  for (let index = 0; index < items.length; index += safeBatchSize) {
    out.push(items.slice(index, index + safeBatchSize));
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const out = new Array<R>(items.length);
  const safeConcurrency = Math.min(getSafeConcurrency(concurrency), items.length);
  let cursor = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const nextIndex = cursor;
      cursor += 1;
      if (nextIndex >= items.length) return;
      out[nextIndex] = await worker(items[nextIndex], nextIndex);
    }
  });

  await Promise.all(runners);
  return out;
}

function buildBookChunkInsertSql(chunks: ChunkCandidate[]): Prisma.Sql {
  const valuesSql = Prisma.join(
    chunks.map((chunk) => {
      const vectorLiteral = toVectorLiteral(chunk.embedding);
      const metadataJson = JSON.stringify(chunk.metadataJson || {});

      return Prisma.sql`(
        ${chunk.id},
        ${chunk.bookId},
        ${chunk.chapterOrderIndex},
        ${chunk.chunkIndex},
        ${chunk.startChar},
        ${chunk.endChar},
        ${chunk.text},
        ${vectorLiteral}::vector,
        ${chunk.embeddingModel},
        ${metadataJson}::jsonb,
        NOW(),
        NOW()
      )`;
    })
  );

  return Prisma.sql`
    INSERT INTO "BookChunk" (
      "id",
      "bookId",
      "chapterOrderIndex",
      "chunkIndex",
      "startChar",
      "endChar",
      "text",
      "embedding",
      "embeddingModel",
      "metadataJson",
      "createdAt",
      "updatedAt"
    )
    VALUES ${valuesSql}
  `;
}

function splitChunkBoundaries(text: string, targetChars: number, overlapChars: number): Array<{ startChar: number; endChar: number }> {
  const out: Array<{ startChar: number; endChar: number }> = [];
  const value = String(text || "");
  if (!value.trim()) return out;

  const length = value.length;
  const target = Math.max(400, targetChars);
  const overlap = Math.max(0, Math.min(overlapChars, Math.floor(target * 0.7)));

  let cursor = 0;
  while (cursor < length) {
    const maxEnd = Math.min(length, cursor + target);
    let end = maxEnd;

    if (maxEnd < length) {
      const backwardMin = Math.max(cursor + Math.floor(target * 0.6), cursor + 1);
      const preferredBreak = value.lastIndexOf("\n\n", maxEnd);
      if (preferredBreak >= backwardMin) {
        end = preferredBreak;
      } else {
        const forwardMax = Math.min(length, cursor + Math.floor(target * 1.3));
        const nextBreak = value.indexOf("\n\n", maxEnd);
        if (nextBreak >= 0 && nextBreak <= forwardMax) {
          end = nextBreak;
        }
      }
    }

    if (end <= cursor) {
      end = Math.min(length, cursor + target);
    }

    let startChar = cursor;
    let endChar = end;

    while (startChar < endChar && /\s/u.test(value[startChar])) startChar += 1;
    while (endChar > startChar && /\s/u.test(value[endChar - 1])) endChar -= 1;

    if (endChar > startChar) {
      out.push({ startChar, endChar });
    }

    if (end >= length) break;

    cursor = Math.max(end - overlap, cursor + 1);
  }

  return out;
}

async function embedChunkText(params: {
  text: string;
  model: string;
  outputDimensionality: number;
}): Promise<number[]> {
  const endpoint = `${workerConfig.vertex.baseUrl}/v1/publishers/google/models/${encodeURIComponent(
    params.model
  )}:predict?key=${encodeURIComponent(workerConfig.vertex.apiKey)}`;

  const body = {
    instances: [
      {
        task_type: "RETRIEVAL_DOCUMENT",
        content: params.text,
      },
    ],
    parameters: {
      outputDimensionality: params.outputDimensionality,
      autoTruncate: true,
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-source": workerConfig.vertex.proxySource,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: VertexEmbeddingResponse | null = null;
  try {
    parsed = text ? (JSON.parse(text) as VertexEmbeddingResponse) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      (parsed &&
        typeof parsed === "object" &&
        (parsed as { error?: { message?: string } }).error?.message) ||
      text ||
      `Vertex embedding request failed with status ${response.status}`;
    throw new Error(String(message));
  }

  const valuesRaw = parsed?.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) {
    throw new Error("Vertex embedding response has no values");
  }

  const values = valuesRaw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (values.length === 0) {
    throw new Error("Vertex embedding response contains invalid values");
  }

  return clampDimensions(values, params.outputDimensionality);
}

function buildChunkCandidates(params: {
  bookId: string;
  chapters: ChapterTextRecord[];
  embeddingModel: string;
  targetChars: number;
  overlapChars: number;
}): Omit<ChunkCandidate, "embedding">[] {
  const out: Omit<ChunkCandidate, "embedding">[] = [];

  for (const chapter of params.chapters) {
    const boundaries = splitChunkBoundaries(chapter.rawText, params.targetChars, params.overlapChars);
    for (let index = 0; index < boundaries.length; index += 1) {
      const boundary = boundaries[index];
      const text = chapter.rawText.slice(boundary.startChar, boundary.endChar);
      const normalizedText = compactWhitespace(text);
      if (!normalizedText) continue;

      out.push({
        id: `bchunk_${randomUUID().replace(/-/g, "")}`,
        bookId: params.bookId,
        chapterOrderIndex: chapter.orderIndex,
        chunkIndex: index + 1,
        startChar: boundary.startChar,
        endChar: boundary.endChar,
        text: normalizedText,
        embeddingModel: params.embeddingModel,
        metadataJson: {
          chapterOrderIndex: chapter.orderIndex,
          chapterTitle: chapter.title,
          chunkIndex: index + 1,
        },
      });
    }
  }

  return out;
}

export async function processBookChatIndex(payload: ProcessBookChatIndexPayload) {
  const bookId = String(payload.bookId || "").trim();
  if (!bookId) {
    throw new Error("Invalid book chat_index payload: bookId is required");
  }

  const lockKey = `book-analyzer:chat_index:${bookId}`;
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
            analyzerType: "chat_index",
          },
          select: {
            state: true,
          },
          take: 1,
        },
      },
    });

    if (!existingBook) return;

    const existingTaskState = existingBook.analyzerTasks[0]?.state || null;
    if (existingTaskState === "completed") {
      const existingChunkCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "BookChunk"
        WHERE "bookId" = ${bookId}
      `;
      if (Number(existingChunkCount[0]?.count || 0) > 0) {
        return;
      }
    }

    const startedAt = new Date();
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "chat_index",
        },
      },
      create: {
        bookId,
        analyzerType: "chat_index",
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

    const chapters: ChapterTextRecord[] = parsedBook.chapters.map((chapter, index) => ({
      orderIndex: index + 1,
      title: resolveChapterTitle(chapter, index + 1),
      rawText: buildPlainTextFromParsedChapter(chapter),
    }));

    const chunksWithoutEmbeddings = buildChunkCandidates({
      bookId,
      chapters,
      embeddingModel: workerConfig.vertex.embeddingModel,
      targetChars: workerConfig.pipeline.bookChunkTargetChars,
      overlapChars: workerConfig.pipeline.bookChunkOverlapChars,
    });

    if (chunksWithoutEmbeddings.length === 0) {
      throw new Error("No chunk candidates were produced for chat index");
    }

    const chunksForPersist = await mapWithConcurrency(
      chunksWithoutEmbeddings,
      workerConfig.pipeline.bookEmbeddingConcurrency,
      async (chunk) => {
        const embedding = await embedChunkText({
          text: chunk.text,
          model: workerConfig.vertex.embeddingModel,
          outputDimensionality: workerConfig.vertex.embeddingDimensions,
        });

        return {
          ...chunk,
          embedding,
        } satisfies ChunkCandidate;
      }
    );

    await prisma.$transaction(async (tx: any) => {
      for (const chapter of chapters) {
        await tx.bookChapter.updateMany({
          where: {
            bookId,
            orderIndex: chapter.orderIndex,
          },
          data: {
            rawText: chapter.rawText,
          },
        });
      }

      await tx.$executeRaw`DELETE FROM "BookChunk" WHERE "bookId" = ${bookId}`;

      const insertBatches = splitIntoBatches(chunksForPersist, workerConfig.pipeline.bookChunkInsertBatchSize);
      for (const batch of insertBatches) {
        const insertSql = buildBookChunkInsertSql(batch);
        await tx.$executeRaw(insertSql);
      }

      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "chat_index",
          },
        },
        create: {
          bookId,
          analyzerType: "chat_index",
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
        chapters: chapters.length,
        chunksIndexed: chunksForPersist.length,
        embeddingConcurrency: workerConfig.pipeline.bookEmbeddingConcurrency,
        chunkInsertBatchSize: workerConfig.pipeline.bookChunkInsertBatchSize,
        embeddingModel: workerConfig.vertex.embeddingModel,
        embeddingDimensions: workerConfig.vertex.embeddingDimensions,
      },
      "Book chat_index analysis completed"
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "chat_index",
        },
      },
      create: {
        bookId,
        analyzerType: "chat_index",
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

    logger.error(
      {
        err: error,
        bookId,
      },
      "Book chat_index analysis failed"
    );
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}
