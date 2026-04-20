import { randomUUID } from "node:crypto";
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
import { enrichBookCardsWithGoogleCovers } from "@/lib/bookCoverResolver";
import { toBookCardDTO, toBookCoreDTO, type BookCardDTO } from "@/lib/books";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const DEFAULT_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_LOCAL_BLOB_ROOT = "/tmp/remarka-imports";
const DEFAULT_BOOKS_S3_REGION = "us-east-1";
const DEFAULT_BOOKS_S3_KEY_PREFIX = "remarka/books";
const COVER_RESOLVE_TIMEOUT_MS = 6000;

async function resolveInitialBookCoverUrl(params: {
  title: string;
  author: string | null;
  ownerId: string;
}): Promise<string | null> {
  const normalizedTitle = String(params.title || "").trim();
  if (!normalizedTitle) return null;

  const probeCard: BookCardDTO = {
    id: `tmp:${normalizedTitle}:${params.author || ""}`,
    title: normalizedTitle,
    author: params.author || null,
    coverUrl: null,
    isPublic: true,
    createdAt: new Date().toISOString(),
    owner: {
      id: params.ownerId,
      name: params.ownerId,
      image: null,
    },
    status: "ready",
    chaptersCount: 0,
    charactersCount: 0,
    themesCount: 0,
    locationsCount: 0,
    libraryUsersCount: 0,
    isInLibrary: false,
    canAddToLibrary: false,
    canRemoveFromLibrary: false,
    isOwner: false,
  };

  try {
    const resolved = await Promise.race([
      enrichBookCardsWithGoogleCovers([probeCard]),
      new Promise<BookCardDTO[]>((resolve) => setTimeout(() => resolve([probeCard]), COVER_RESOLVE_TIMEOUT_MS)),
    ]);

    const candidate = resolved[0]?.coverUrl;
    return candidate ? String(candidate) : null;
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
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

function resolveUploadFormat(fileName: string): BookFormat | null {
  const detected = detectBookFormatFromFileName(fileName);
  if (detected) return detected;
  if (fileName.toLowerCase().endsWith(".zip")) return "fb2_zip";
  return null;
}

function parseScope(value: string | null): "explore" | "library" {
  if (value === "library") return "library";
  if (value === "favorites") return "library";
  return "explore";
}

function parseSort(value: string | null): "recent" | "popular" {
  return value === "popular" ? "popular" : "recent";
}

function resolveMimeType(format: BookFormat, fileType: string): string {
  const normalized = String(fileType || "").trim();
  if (normalized) return normalized;
  if (format === "fb2") return "application/x-fictionbook+xml";
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
  const scope = parseScope(searchParams.get("scope"));
  const authUser = await resolveAuthUser();
  if (scope === "library" && !authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const viewerUserId = authUser?.id || "__anonymous__";
  const sort = parseSort(searchParams.get("sort"));
  const q = String(searchParams.get("q") || "").trim();

  const page = parsePositiveInt(searchParams.get("page"), 1);
  const pageSize = Math.min(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const skip = (page - 1) * pageSize;

  const andFilters: Prisma.BookWhereInput[] = [];
  andFilters.push({ analysisStatus: "completed" });

  if (scope === "library") {
    andFilters.push({
      OR: [{ ownerUserId: authUser!.id }, { likes: { some: { userId: authUser!.id } } }],
    });
  } else {
    andFilters.push({ isPublic: true });
  }

  if (q) {
    andFilters.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        { owner: { name: { contains: q, mode: "insensitive" } } },
        { owner: { email: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  const where: Prisma.BookWhereInput =
    andFilters.length > 1
      ? { AND: andFilters }
      : andFilters[0] || {};

  const orderBy: Prisma.BookOrderByWithRelationInput[] =
    sort === "popular"
      ? [{ likes: { _count: "desc" } }, { createdAt: "desc" }]
      : [{ createdAt: "desc" }];

  const [total, rows] = await prisma.$transaction([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        likes: {
          where: {
            userId: viewerUserId,
          },
          select: {
            bookId: true,
          },
        },
        _count: {
          select: {
            likes: true,
            bookCharacters: true,
            bookThemes: true,
            bookLocations: true,
          },
        },
      },
    }),
  ]);

  const cards = rows.map((row) => toBookCardDTO(row, authUser?.id || null));

  return NextResponse.json({
    items: cards,
    page,
    pageSize,
    total,
  });
}

export async function POST(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const fileEntry = formData.get("file");

  if (!(fileEntry instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const importMaxFileBytes = parseIntEnv(process.env.IMPORT_MAX_FILE_BYTES, DEFAULT_IMPORT_MAX_FILE_BYTES);
  if (fileEntry.size > importMaxFileBytes) {
    return NextResponse.json(
      { error: `File too large. Max ${importMaxFileBytes} bytes` },
      { status: 413 }
    );
  }

  const format = resolveUploadFormat(fileEntry.name);
  if (!format) {
    return NextResponse.json({ error: "Unsupported format. Use FB2 or FB2 ZIP." }, { status: 415 });
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
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
      fileName: fileEntry.name,
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

    return NextResponse.json({ error: "Failed to parse FB2 file" }, { status: 422 });
  }

  let blob: Awaited<ReturnType<BlobStore["put"]>>;
  try {
    const blobStore = resolveBooksBlobStore();
    blob = await blobStore.put({
      bytes,
      fileName: fileEntry.name,
    });
  } catch {
    return NextResponse.json({ error: "Failed to store uploaded file" }, { status: 500 });
  }

  const resolvedBookTitle = parsedTitle || inferBookTitleFromFileName(fileEntry.name) || "Без названия";
  const resolvedCoverUrl = await resolveInitialBookCoverUrl({
    title: resolvedBookTitle,
    author: parsedAuthor,
    ownerId: authUser.id,
  });

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
            fileName: fileEntry.name,
            mimeType: resolveMimeType(format, fileEntry.type),
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
      try {
        await textCorpusBlobStore.delete(textCorpusBlob.storageKey);
      } catch {
        // keep upload flow resilient; orphan cleanup can run later if needed
      }
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
}
