import { LocalBlobStore, S3BlobStore, type BlobStore, prisma } from "@remarka/db";
import {
  BookImportError,
  buildPlainTextFromParsedChapter,
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
import { toBookCardDTO, toBookCoreDTO } from "@/lib/books";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const DEFAULT_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_LOCAL_BLOB_ROOT = "/tmp/remarka-imports";
const DEFAULT_BOOKS_S3_REGION = "us-east-1";
const DEFAULT_BOOKS_S3_KEY_PREFIX = "remarka/books";
const PREVIEW_MAX_CHARS = 160;

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

function parseScope(value: string | null): "explore" | "library" | "favorites" {
  if (value === "library") return "library";
  if (value === "favorites") return "favorites";
  return "explore";
}

function parseSort(value: string | null): "recent" | "popular" {
  return value === "popular" ? "popular" : "recent";
}

function parseIsPublic(value: FormDataEntryValue | null): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
}

function resolveMimeType(format: BookFormat, fileType: string): string {
  const normalized = String(fileType || "").trim();
  if (normalized) return normalized;
  if (format === "fb2") return "application/x-fictionbook+xml";
  return "application/zip";
}

function normalizePreviewText(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[\t ]+/g, " ")
    .trim();
}

function trimPreviewText(value: string, maxChars: number): string {
  const normalized = normalizePreviewText(value);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;

  let candidate = normalized.slice(0, maxChars).trimEnd();
  if (!candidate) return "";

  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxChars * 0.6)) {
    candidate = candidate.slice(0, lastSpace).trimEnd();
  }

  if (!candidate) {
    candidate = normalized.slice(0, maxChars).trimEnd();
  }

  return `${candidate}…`;
}

function inlineTextFromChapterBlock(block: ParsedChapter["blocks"][number]): string {
  return normalizePreviewText(block.inlines.map((part) => part.text).join(""));
}

function resolveChapterPreview(chapter: ParsedChapter): string | null {
  const firstParagraph = chapter.blocks.find((block) => {
    if (block.type !== "paragraph") return false;
    return Boolean(inlineTextFromChapterBlock(block));
  });

  if (firstParagraph) {
    const preview = trimPreviewText(inlineTextFromChapterBlock(firstParagraph), PREVIEW_MAX_CHARS);
    return preview || null;
  }

  const fallback = trimPreviewText(buildPlainTextFromParsedChapter(chapter), PREVIEW_MAX_CHARS);
  return fallback || null;
}

function resolveChapterTitle(chapter: ParsedChapter, orderIndex: number): string {
  const title = String(chapter.title || "").trim();
  return title || `Глава ${orderIndex}`;
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
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const scope = parseScope(searchParams.get("scope"));
  const sort = parseSort(searchParams.get("sort"));
  const q = String(searchParams.get("q") || "").trim();

  const page = parsePositiveInt(searchParams.get("page"), 1);
  const pageSize = Math.min(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const skip = (page - 1) * pageSize;

  const andFilters: Prisma.BookWhereInput[] = [];
  if (scope === "library") {
    andFilters.push({ ownerUserId: authUser.id });
  } else if (scope === "favorites") {
    andFilters.push({ isPublic: true });
    andFilters.push({ ownerUserId: { not: authUser.id } });
    andFilters.push({ likes: { some: { userId: authUser.id } } });
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
            userId: authUser.id,
          },
          select: {
            bookId: true,
          },
        },
        _count: {
          select: {
            likes: true,
          },
        },
      },
    }),
  ]);

  return NextResponse.json({
    items: rows.map((row) => toBookCardDTO(row, authUser.id)),
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
  let chaptersToCreate: Array<{ orderIndex: number; title: string; previewText: string | null }> = [];

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

    chaptersToCreate = normalizedBook.chapters.map((chapter, index) => {
      const orderIndex = index + 1;
      return {
        orderIndex,
        title: resolveChapterTitle(chapter, orderIndex),
        previewText: resolveChapterPreview(chapter),
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

  const created = await prisma.book.create({
    data: {
      ownerUserId: authUser.id,
      title: parsedTitle || inferBookTitleFromFileName(fileEntry.name) || "Без названия",
      author: parsedAuthor,
      chapterCount: chaptersToCreate.length,
      isPublic: parseIsPublic(formData.get("isPublic")),
      fileName: fileEntry.name,
      mimeType: resolveMimeType(format, fileEntry.type),
      sizeBytes: blob.sizeBytes,
      storageProvider: blob.provider,
      storageKey: blob.storageKey,
      fileSha256: blob.sha256,
      chapters: {
        create: chaptersToCreate,
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

  const dto = toBookCoreDTO(created);
  dto.canManage = true;
  return NextResponse.json(dto, { status: 201 });
}
