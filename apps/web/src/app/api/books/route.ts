import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  LocalBlobStore,
  S3BlobStore,
  createBookTextCorpusBlobStoreFromEnv,
  enqueueOutboxEvent,
  putBookTextCorpus,
  type BlobStore,
  prisma,
} from "@remarka/db";
import {
  BookImportError,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  inferBookTitleFromFileName,
  parseBook,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookCoreDTO } from "@/lib/books";
import { getBucketUsage } from "@/lib/bucketUsage";
import {
  LibraryRequiresAuthError,
  listCatalogBooks,
  parseCatalogScope,
  parseCatalogSort,
} from "@/lib/server/catalog";
import { getTierLimits } from "@/lib/tiers";
import { MultipartUploadError, parseStreamingMultipart, type TempUploadedFile } from "@/lib/streamingMultipart";

const DEFAULT_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_LOCAL_BLOB_ROOT = "/tmp/remarka-imports";
const DEFAULT_BOOKS_S3_REGION = "us-east-1";
const DEFAULT_BOOKS_S3_KEY_PREFIX = "remarka/books";

function parsePositiveIntOrNull(value: string | null): number | null {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function cleanupStoredUploadPayloads(params: {
  originalBlobStore?: BlobStore;
  originalStorageKey?: string;
  textCorpusBlobStore?: BlobStore;
  textCorpusStorageKey?: string;
}): Promise<void> {
  const deletions: Promise<void>[] = [];
  if (params.originalBlobStore && params.originalStorageKey) {
    deletions.push(params.originalBlobStore.delete(params.originalStorageKey));
  }
  if (params.textCorpusBlobStore && params.textCorpusStorageKey) {
    deletions.push(params.textCorpusBlobStore.delete(params.textCorpusStorageKey));
  }
  await Promise.allSettled(deletions);
}

function resolveUploadFormat(fileName: string): BookFormat | null {
  const detected = detectBookFormatFromFileName(fileName);
  if (detected) return detected;
  if (fileName.toLowerCase().endsWith(".zip")) return "fb2_zip";
  return null;
}

function resolveMimeType(format: BookFormat, fileType: string): string {
  const normalized = String(fileType || "").trim();
  if (normalized) return normalized;
  if (format === "fb2") return "application/x-fictionbook+xml";
  if (format === "epub") return "application/epub+zip";
  if (format === "pdf") return "application/pdf";
  return "application/zip";
}

function resolveChapterTitle(chapter: ParsedChapter, orderIndex: number): string {
  const title = String(chapter.title || "").trim();
  return title || `Глава ${orderIndex}`;
}

function normalizeWhitespace(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function resolveChapterRawText(chapter: ParsedChapter): string {
  const blocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
  const chunks = blocks
    .map((block) => {
      const inlines = Array.isArray(block?.inlines) ? block.inlines : [];
      return inlines.map((inline) => String(inline?.text || "")).join("").trim();
    })
    .filter(Boolean);

  return normalizeWhitespace(chunks.join("\n\n"));
}

function createOpaqueId(): string {
  return `c${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function resolveLocalBooksBlobRoot(): string {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || DEFAULT_LOCAL_BLOB_ROOT).trim() || DEFAULT_LOCAL_BLOB_ROOT;
  return String(process.env.BOOKS_LOCAL_DIR || `${importRoot}/books`).trim() || `${importRoot}/books`;
}

function resolveBooksBlobStore(): BlobStore {
  const provider = String(process.env.BOOKS_STORAGE_PROVIDER || "local").trim().toLowerCase();

  if (provider === "s3") {
    const bucket = String(process.env.BOOKS_S3_BUCKET || "").trim();
    if (!bucket) {
      throw new Error("BOOKS_S3_BUCKET is required for BOOKS_STORAGE_PROVIDER=s3");
    }

    const accessKeyId = String(process.env.BOOKS_S3_ACCESS_KEY_ID || "").trim();
    const secretAccessKey = String(process.env.BOOKS_S3_SECRET_ACCESS_KEY || "").trim();
    const sessionToken = String(process.env.BOOKS_S3_SESSION_TOKEN || "").trim() || undefined;

    return new S3BlobStore({
      bucket,
      region: String(process.env.BOOKS_S3_REGION || DEFAULT_BOOKS_S3_REGION).trim() || DEFAULT_BOOKS_S3_REGION,
      endpoint: String(process.env.BOOKS_S3_ENDPOINT || "").trim() || undefined,
      keyPrefix: String(process.env.BOOKS_S3_KEY_PREFIX || DEFAULT_BOOKS_S3_KEY_PREFIX).trim() || DEFAULT_BOOKS_S3_KEY_PREFIX,
      forcePathStyle: parseBooleanEnv(process.env.BOOKS_S3_FORCE_PATH_STYLE, true),
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
              sessionToken,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir: resolveLocalBooksBlobRoot(),
    provider: "local",
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scope = parseCatalogScope(searchParams.get("scope"));
  const authUser = await resolveAuthUser();

  try {
    const result = await listCatalogBooks({
      scope,
      viewer: authUser ? { id: authUser.id } : null,
      q: searchParams.get("q"),
      sort: parseCatalogSort(searchParams.get("sort")),
      page: parsePositiveIntOrNull(searchParams.get("page")),
      pageSize: parsePositiveIntOrNull(searchParams.get("pageSize")),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LibraryRequiresAuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Tariff gate — book uploads are Plus-only (Free has analyses bucket
  // locked at 0). Hard-reject Free with 403 before parsing the upload to
  // avoid wasting bandwidth + temp storage on rejected requests.
  const tierLimits = getTierLimits(authUser.tier);
  if (tierLimits.analyses === 0) {
    return NextResponse.json(
      {
        error: "Загрузка книг доступна на тарифе Plus.",
        code: "UPLOAD_REQUIRES_PLUS",
      },
      { status: 403 },
    );
  }

  // Plus-tier user: check analysis bucket. If exhausted, reject with 429
  // before parsing the upload (we don't want to charge the slot for a turn
  // that wouldn't be processed).
  const usage = await getBucketUsage({
    id: authUser.id,
    tier: authUser.tier,
    createdAt: authUser.createdAt,
    tierActivatedAt: authUser.tierActivatedAt,
  });
  if (usage.buckets.analyses.exhausted) {
    return NextResponse.json(
      {
        error: "Достигнут лимит анализов в этом периоде.",
        code: "ANALYSIS_LIMIT_REACHED",
        usage,
      },
      { status: 429 },
    );
  }

  // Per-tier upload size cap (separate from IMPORT_MAX_FILE_BYTES which is
  // a global infrastructure ceiling). Plus = 30 MiB, Free = 0 (already
  // rejected above).
  const tierMaxBytes = tierLimits.uploadMaxMiB * 1024 * 1024;
  const importMaxFileBytes = Math.min(
    parseIntEnv(process.env.IMPORT_MAX_FILE_BYTES, DEFAULT_IMPORT_MAX_FILE_BYTES),
    tierMaxBytes,
  );
  let upload: Awaited<ReturnType<typeof parseStreamingMultipart>>;
  try {
    upload = await parseStreamingMultipart(request, {
      fileFieldNames: ["file"],
      maxFiles: 1,
      maxFileSizeBytes: importMaxFileBytes,
      tempPrefix: "remarka-book-upload",
      maxFieldSizeBytes: 1024,
    });
  } catch (error) {
    if (error instanceof MultipartUploadError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: error.status });
    }
    console.error("Book upload multipart parsing failed", error);
    return NextResponse.json({ error: "Failed to parse multipart body" }, { status: 400 });
  }

  try {
    const fileEntry: TempUploadedFile | undefined = upload.files.find((file) => file.fieldName === "file");
    if (!fileEntry || fileEntry.sizeBytes <= 0) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const format = resolveUploadFormat(fileEntry.fileName);
    if (!format) {
      return NextResponse.json({ error: "Unsupported format. Use FB2, FB2 ZIP, EPUB or PDF." }, { status: 415 });
    }

    const bytes = new Uint8Array(await fs.readFile(fileEntry.tempPath));
    const importMaxZipBytes = parseIntEnv(
      process.env.IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES,
      DEFAULT_IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES
    );

    let parsedTitle: string | null = null;
    let parsedAuthor: string | null = null;
    let parsedSummary: string | null = null;
    const preparedBookId = createOpaqueId();
    const dualWriteRawText = parseBooleanEnv(process.env.BOOK_TEXT_CORPUS_DUAL_WRITE_ENABLED, true);
    let chaptersToCreate: Array<{ id: string; orderIndex: number; title: string; summary: string | null; rawText: string }> =
      [];

    try {
      const parsed = await parseBook({
        format,
        fileName: fileEntry.fileName,
        bytes,
        maxZipUncompressedBytes: importMaxZipBytes,
      });

      const normalizedBook = ensureParsedBookHasChapters(parsed);
      parsedTitle = String(normalizedBook.metadata.title || "").trim() || null;
      parsedAuthor = String(normalizedBook.metadata.author || "").trim() || null;
      parsedSummary = String(normalizedBook.metadata.annotation || "").trim() || null;

      chaptersToCreate = normalizedBook.chapters.map((chapter, index) => {
        const orderIndex = index + 1;
        return {
          id: createOpaqueId(),
          orderIndex,
          title: resolveChapterTitle(chapter, orderIndex),
          summary: null,
          rawText: resolveChapterRawText(chapter),
        };
      });
    } catch (error) {
      if (error instanceof BookImportError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
      }

      console.error("Book import failed", error);
      return NextResponse.json({ error: "Failed to parse book file" }, { status: 422 });
    }

    let blobStore: BlobStore;
    let blob: Awaited<ReturnType<BlobStore["putFile"]>>;
    try {
      blobStore = resolveBooksBlobStore();
      blob = await blobStore.putFile({
        filePath: fileEntry.tempPath,
        fileName: fileEntry.fileName,
      });
    } catch {
      return NextResponse.json({ error: "Failed to store uploaded file" }, { status: 500 });
    }

    const resolvedBookTitle = parsedTitle || inferBookTitleFromFileName(fileEntry.fileName) || "Без названия";
    // Uploaded books start private. Do not send private title/author metadata to
    // third-party cover search providers before an explicit public-catalog flow.
    const resolvedCoverUrl: string | null = null;

    let textCorpusBlobStore: BlobStore;
    let textCorpusBlob: Awaited<ReturnType<typeof putBookTextCorpus>>;
    try {
      textCorpusBlobStore = createBookTextCorpusBlobStoreFromEnv();
      textCorpusBlob = await putBookTextCorpus({
        store: textCorpusBlobStore,
        bookId: preparedBookId,
        chapters: chaptersToCreate.map((chapter) => ({
          chapterId: chapter.id,
          orderIndex: chapter.orderIndex,
          title: chapter.title,
          rawText: chapter.rawText,
        })),
      });
    } catch {
      await cleanupStoredUploadPayloads({
        originalBlobStore: blobStore,
        originalStorageKey: blob.storageKey,
      });
      return NextResponse.json({ error: "Failed to store parsed text corpus" }, { status: 500 });
    }

    const created = await (async () => {
      try {
        return await prisma.$transaction(async (tx): Promise<
          Prisma.BookGetPayload<{
            include: {
              owner: {
                select: {
                  id: true;
                  name: true;
                  email: true;
                  image: true;
                };
              };
            };
          }>
        > => {
          const createdBook = await tx.book.create({
            data: {
              id: preparedBookId,
              ownerUserId: authUser.id,
              title: resolvedBookTitle,
              author: parsedAuthor,
              coverUrl: resolvedCoverUrl,
              summary: parsedSummary,
              chapterCount: chaptersToCreate.length,
              isPublic: false,
              analysisState: "queued",
              analysisStatus: "queued",
              analysisError: null,
              analysisTotalBlocks: 0,
              analysisCheckedBlocks: 0,
              analysisPromptTokens: 0,
              analysisCompletionTokens: 0,
              analysisTotalTokens: 0,
              analysisChapterStatsJson: [],
              analysisRequestedAt: new Date(),
              analysisStartedAt: null,
              analysisFinishedAt: null,
              analysisCompletedAt: null,
              fileName: fileEntry.fileName,
              mimeType: resolveMimeType(format, fileEntry.mimeType),
              sizeBytes: blob.sizeBytes,
              storageProvider: blob.provider,
              storageKey: blob.storageKey,
              fileSha256: blob.sha256,
              textCorpusStorageProvider: textCorpusBlob.provider,
              textCorpusStorageKey: textCorpusBlob.storageKey,
              textCorpusSizeBytes: textCorpusBlob.sizeBytes,
              textCorpusSha256: textCorpusBlob.sha256,
              textCorpusCompression: textCorpusBlob.compression,
              textCorpusSchemaVersion: textCorpusBlob.schemaVersion,
              chapters: {
                create: chaptersToCreate.map((chapter) => ({
                  id: chapter.id,
                  orderIndex: chapter.orderIndex,
                  title: chapter.title,
                  summary: chapter.summary,
                  rawText: dualWriteRawText ? chapter.rawText : null,
                })),
              },
            },
            include: {
              owner: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          });

          await enqueueOutboxEvent({
            client: tx,
            aggregateType: "book",
            aggregateId: createdBook.id,
            eventType: "book.npz-analysis.requested",
            payloadJson: {
              bookId: createdBook.id,
              ownerUserId: createdBook.ownerUserId,
              requestedAt: new Date().toISOString(),
              requestId: randomUUID(),
              triggerSource: "auto_upload",
              source: "auto_upload",
            },
          });

          return createdBook;
        });
      } catch (error) {
        await cleanupStoredUploadPayloads({
          originalBlobStore: blobStore,
          originalStorageKey: blob.storageKey,
          textCorpusBlobStore,
          textCorpusStorageKey: textCorpusBlob.storageKey,
        });
        throw error;
      }
    })();

    const dto = toBookCoreDTO(created);
    dto.canManage = true;
    console.info("[book-analysis-queued]", {
      bookId: created.id,
      chapterCount: created.chapterCount,
    });
    return NextResponse.json(dto, { status: 201 });
  } finally {
    await upload.cleanup();
  }
}
