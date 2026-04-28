import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { LocalBlobStore, S3BlobStore, type BlobStore, type BlobPutResult } from "./blobStore";

const DEFAULT_IMPORT_BLOB_DIR = "/tmp/remarka-imports";
const DEFAULT_BOOKS_LOCAL_DIR = `${DEFAULT_IMPORT_BLOB_DIR}/books`;
const DEFAULT_BOOKS_S3_REGION = "us-east-1";
const DEFAULT_BOOK_TEXT_CORPUS_KEY_PREFIX = "remarka/book-text-corpus";
export const BOOK_TEXT_CORPUS_SCHEMA_VERSION = "book-text-corpus-v1";
const DEFAULT_BOOK_TEXT_CORPUS_COMPRESSION = "gzip";
const DEFAULT_BOOK_TEXT_CORPUS_CACHE_TTL_MS = 600_000;
const DEFAULT_BOOK_TEXT_CORPUS_CACHE_MAX_BOOKS = 12;

export type BookTextCorpusChapter = {
  chapterId: string;
  orderIndex: number;
  title: string;
  rawText: string;
};

export type BookTextCorpusPayload = {
  schemaVersion: typeof BOOK_TEXT_CORPUS_SCHEMA_VERSION;
  bookId: string;
  chapters: BookTextCorpusChapter[];
};

export type BookTextCorpusBlobPointer = BlobPutResult & {
  compression: "gzip";
  schemaVersion: typeof BOOK_TEXT_CORPUS_SCHEMA_VERSION;
};

export type ResolvedBookTextCorpus = {
  bookId: string;
  chapters: BookTextCorpusChapter[];
  source: "s3" | "db";
  fallbackToDb: boolean;
  fallbackReason: string | null;
  cacheHit: boolean;
};

type BookTextCorpusLogger = {
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
};

type BookTextCorpusClient = {
  book?: {
    findUnique(args: any): Promise<any>;
  };
  bookChapter?: {
    findMany(args: any): Promise<any[]>;
  };
  [key: string]: any;
};

type LoadedBookTextCorpus = {
  bookId: string;
  chapters: BookTextCorpusChapter[];
  source: "s3" | "db";
  fallbackToDb: boolean;
  fallbackReason: string | null;
};

type ResolvedBookTextCorpusClient = {
  book: {
    findUnique(args: any): Promise<any>;
  };
  bookChapter: {
    findMany(args: any): Promise<any[]>;
  };
};

type BookTextCorpusCacheEntry = {
  cacheKey: string;
  value?: LoadedBookTextCorpus;
  loading?: Promise<LoadedBookTextCorpus>;
  expiresAt: number;
  lastAccessAt: number;
};

const bookTextCorpusCacheByBook = new Map<string, BookTextCorpusCacheEntry>();
let singletonBookTextCorpusBlobStore: BlobStore | null = null;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asRawString(value: unknown): string {
  return String(value ?? "");
}

function asPositiveInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeChapter(input: Partial<BookTextCorpusChapter>): BookTextCorpusChapter {
  return {
    chapterId: asString(input.chapterId),
    orderIndex: asPositiveInt(input.orderIndex),
    title: asString(input.title),
    rawText: asRawString(input.rawText),
  };
}

function normalizePayload(payload: unknown): BookTextCorpusPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid book text corpus payload");
  }

  const data = payload as Record<string, unknown>;
  const schemaVersion = asString(data.schemaVersion);
  if (schemaVersion && schemaVersion !== BOOK_TEXT_CORPUS_SCHEMA_VERSION) {
    throw new Error(`Unsupported book text corpus schema version: ${schemaVersion}`);
  }

  const bookId = asString(data.bookId);
  if (!bookId) {
    throw new Error("Book text corpus payload has empty bookId");
  }

  const chapters = Array.isArray(data.chapters)
    ? data.chapters
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const chapter = normalizeChapter(item as Partial<BookTextCorpusChapter>);
          if (!chapter.chapterId || chapter.orderIndex <= 0) return null;
          return chapter;
        })
        .filter((item): item is BookTextCorpusChapter => Boolean(item))
        .sort((left, right) => left.orderIndex - right.orderIndex)
    : [];

  return {
    schemaVersion: BOOK_TEXT_CORPUS_SCHEMA_VERSION,
    bookId,
    chapters,
  };
}

function resolveCacheTtlMs(): number {
  return parsePositiveIntEnv(
    process.env.BOOK_TEXT_CORPUS_CACHE_TTL_MS || process.env.BOOK_SEARCH_CACHE_TTL_MS,
    DEFAULT_BOOK_TEXT_CORPUS_CACHE_TTL_MS
  );
}

function resolveCacheMaxBooks(): number {
  return parsePositiveIntEnv(
    process.env.BOOK_TEXT_CORPUS_CACHE_MAX_BOOKS || process.env.BOOK_SEARCH_CACHE_MAX_BOOKS,
    DEFAULT_BOOK_TEXT_CORPUS_CACHE_MAX_BOOKS
  );
}

function nowMs(): number {
  return Date.now();
}

function pruneBookTextCorpusCache(cache: Map<string, BookTextCorpusCacheEntry>, maxBooks: number) {
  const now = nowMs();
  for (const [bookId, entry] of cache.entries()) {
    if (entry.loading) continue;
    if (entry.expiresAt > now) continue;
    cache.delete(bookId);
  }

  if (cache.size <= maxBooks) return;

  const sorted = Array.from(cache.entries()).sort((left, right) => {
    return (left[1].lastAccessAt || 0) - (right[1].lastAccessAt || 0);
  });

  for (const [bookId] of sorted) {
    if (cache.size <= maxBooks) break;
    cache.delete(bookId);
  }
}

async function getOrLoadBookTextCorpusCache(params: {
  cache: Map<string, BookTextCorpusCacheEntry>;
  bookId: string;
  cacheKey: string;
  ttlMs: number;
  maxBooks: number;
  loader: () => Promise<LoadedBookTextCorpus>;
}): Promise<{ value: LoadedBookTextCorpus; hit: boolean }> {
  const now = nowMs();
  const current = params.cache.get(params.bookId);
  if (
    current &&
    current.cacheKey === params.cacheKey &&
    current.value !== undefined &&
    current.expiresAt > now
  ) {
    current.lastAccessAt = now;
    return {
      value: current.value,
      hit: true,
    };
  }

  if (current && current.cacheKey === params.cacheKey && current.loading) {
    const value = await current.loading;
    return {
      value,
      hit: true,
    };
  }

  const loading = params.loader();
  params.cache.set(params.bookId, {
    cacheKey: params.cacheKey,
    value: current?.value,
    loading,
    expiresAt: now,
    lastAccessAt: now,
  });

  try {
    const value = await loading;
    const refreshedAt = nowMs();
    params.cache.set(params.bookId, {
      cacheKey: params.cacheKey,
      value,
      expiresAt: refreshedAt + params.ttlMs,
      lastAccessAt: refreshedAt,
    });
    pruneBookTextCorpusCache(params.cache, params.maxBooks);
    return {
      value,
      hit: false,
    };
  } catch (error) {
    const entry = params.cache.get(params.bookId);
    if (entry?.loading === loading) {
      params.cache.delete(params.bookId);
    }
    throw error;
  }
}

function buildCacheKey(book: {
  updatedAt: Date | null | undefined;
  textCorpusStorageKey: string | null | undefined;
  textCorpusSha256: string | null | undefined;
  textCorpusSizeBytes: number | null | undefined;
  textCorpusCompression: string | null | undefined;
  textCorpusSchemaVersion: string | null | undefined;
  chapters: Array<{ id: string; orderIndex: number; title: string }>;
}): string {
  const updatedAt = book.updatedAt instanceof Date ? book.updatedAt.toISOString() : "updated:none";
  const storageKey = asString(book.textCorpusStorageKey) || "storage:none";
  const sha256 = asString(book.textCorpusSha256) || "sha:none";
  const sizeBytes = Number.isFinite(Number(book.textCorpusSizeBytes))
    ? String(Number(book.textCorpusSizeBytes))
    : "size:none";
  const compression = asString(book.textCorpusCompression) || DEFAULT_BOOK_TEXT_CORPUS_COMPRESSION;
  const schemaVersion = asString(book.textCorpusSchemaVersion) || BOOK_TEXT_CORPUS_SCHEMA_VERSION;
  const chapterStamp = book.chapters
    .map((chapter) => `${asString(chapter.id)}:${asPositiveInt(chapter.orderIndex)}:${asString(chapter.title)}`)
    .join("|");
  return [updatedAt, storageKey, sha256, sizeBytes, compression, schemaVersion, chapterStamp].join("::");
}

export function clearBookTextCorpusCache() {
  bookTextCorpusCacheByBook.clear();
}

export function encodeBookTextCorpus(payload: BookTextCorpusPayload): Uint8Array {
  const normalized = normalizePayload(payload);
  const encoded = new TextEncoder().encode(JSON.stringify(normalized));
  return gzipSync(encoded);
}

export function decodeBookTextCorpus(bytes: Uint8Array): BookTextCorpusPayload {
  const inflated = gunzipSync(Buffer.from(bytes));
  const parsed = JSON.parse(inflated.toString("utf-8"));
  return normalizePayload(parsed);
}

export function createBookTextCorpusBlobStoreFromEnv(): BlobStore {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || DEFAULT_IMPORT_BLOB_DIR).trim() || DEFAULT_IMPORT_BLOB_DIR;
  const provider = String(process.env.BOOK_TEXT_CORPUS_STORAGE_PROVIDER || process.env.BOOKS_STORAGE_PROVIDER || "local")
    .trim()
    .toLowerCase();

  if (provider === "s3") {
    const bucket = String(process.env.BOOK_TEXT_CORPUS_S3_BUCKET || process.env.BOOKS_S3_BUCKET || "").trim();
    if (!bucket) {
      throw new Error("BOOK_TEXT_CORPUS_S3_BUCKET or BOOKS_S3_BUCKET is required for S3 text corpus storage");
    }

    const accessKeyId = String(
      process.env.BOOK_TEXT_CORPUS_S3_ACCESS_KEY_ID || process.env.BOOKS_S3_ACCESS_KEY_ID || ""
    ).trim();
    const secretAccessKey = String(
      process.env.BOOK_TEXT_CORPUS_S3_SECRET_ACCESS_KEY || process.env.BOOKS_S3_SECRET_ACCESS_KEY || ""
    ).trim();
    const sessionToken = String(
      process.env.BOOK_TEXT_CORPUS_S3_SESSION_TOKEN || process.env.BOOKS_S3_SESSION_TOKEN || ""
    ).trim();

    return new S3BlobStore({
      bucket,
      region:
        String(process.env.BOOK_TEXT_CORPUS_S3_REGION || process.env.BOOKS_S3_REGION || DEFAULT_BOOKS_S3_REGION).trim() ||
        DEFAULT_BOOKS_S3_REGION,
      endpoint:
        String(process.env.BOOK_TEXT_CORPUS_S3_ENDPOINT || process.env.BOOKS_S3_ENDPOINT || "").trim() || undefined,
      keyPrefix:
        String(process.env.BOOK_TEXT_CORPUS_S3_KEY_PREFIX || DEFAULT_BOOK_TEXT_CORPUS_KEY_PREFIX).trim() ||
        DEFAULT_BOOK_TEXT_CORPUS_KEY_PREFIX,
      forcePathStyle: parseBooleanEnv(
        process.env.BOOK_TEXT_CORPUS_S3_FORCE_PATH_STYLE || process.env.BOOKS_S3_FORCE_PATH_STYLE,
        true
      ),
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
              sessionToken: sessionToken || undefined,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir:
      String(process.env.BOOK_TEXT_CORPUS_LOCAL_DIR || process.env.BOOKS_LOCAL_DIR || DEFAULT_BOOKS_LOCAL_DIR).trim() ||
      DEFAULT_BOOKS_LOCAL_DIR,
    provider: "local",
  });
}

export async function putBookTextCorpus(params: {
  store: BlobStore;
  bookId: string;
  chapters: BookTextCorpusChapter[];
  prefix?: string;
}): Promise<BookTextCorpusBlobPointer> {
  const payload: BookTextCorpusPayload = {
    schemaVersion: BOOK_TEXT_CORPUS_SCHEMA_VERSION,
    bookId: asString(params.bookId),
    chapters: params.chapters.map((chapter) => normalizeChapter(chapter)),
  };
  if (!payload.bookId) {
    throw new Error("Book text corpus put requires non-empty bookId");
  }

  const bytes = encodeBookTextCorpus(payload);
  const prefix = asString(params.prefix) || `book-${payload.bookId}`;
  const stored = await params.store.put({
    bytes,
    prefix,
    fileName: `${payload.bookId}.book-text-corpus.json.gz`,
  });

  return {
    ...stored,
    compression: DEFAULT_BOOK_TEXT_CORPUS_COMPRESSION,
    schemaVersion: BOOK_TEXT_CORPUS_SCHEMA_VERSION,
  };
}

export async function getBookTextCorpus(params: {
  store: BlobStore;
  storageKey: string;
  compression?: string | null;
  expectedSha256?: string | null;
  expectedSizeBytes?: number | null;
}): Promise<BookTextCorpusPayload> {
  const compression = asString(params.compression || DEFAULT_BOOK_TEXT_CORPUS_COMPRESSION).toLowerCase();
  if (compression !== DEFAULT_BOOK_TEXT_CORPUS_COMPRESSION) {
    throw new Error(`Unsupported book text corpus compression: ${compression}`);
  }

  const bytes = await params.store.get(asString(params.storageKey));
  if (Number.isFinite(Number(params.expectedSizeBytes)) && Number(params.expectedSizeBytes) >= 0) {
    const expectedSizeBytes = Number(params.expectedSizeBytes);
    if (bytes.byteLength !== expectedSizeBytes) {
      throw new Error(`Book text corpus size mismatch: expected ${expectedSizeBytes}, got ${bytes.byteLength}`);
    }
  }

  const expectedSha256 = asString(params.expectedSha256).toLowerCase();
  if (expectedSha256) {
    const actualSha256 = computeSha256(bytes).toLowerCase();
    if (actualSha256 !== expectedSha256) {
      throw new Error("Book text corpus checksum mismatch");
    }
  }

  return decodeBookTextCorpus(bytes);
}

function mapCorpusToBookChapters(params: {
  bookId: string;
  metadataChapters: Array<{ id: string; orderIndex: number; title: string }>;
  payloadChapters: BookTextCorpusChapter[];
}) {
  const textByChapterId = new Map<string, string>();
  const textByOrderIndex = new Map<number, string>();
  for (const chapter of params.payloadChapters) {
    if (chapter.chapterId) {
      textByChapterId.set(chapter.chapterId, asRawString(chapter.rawText));
    }
    if (chapter.orderIndex > 0 && !textByOrderIndex.has(chapter.orderIndex)) {
      textByOrderIndex.set(chapter.orderIndex, asRawString(chapter.rawText));
    }
  }

  const missingChapterIds: string[] = [];
  const chapters = params.metadataChapters.map((chapter) => {
    const fallbackByOrder = textByOrderIndex.get(asPositiveInt(chapter.orderIndex));
    const rawText = textByChapterId.get(asString(chapter.id)) ?? fallbackByOrder;
    if (rawText === undefined) {
      missingChapterIds.push(asString(chapter.id));
    }
    return {
      chapterId: asString(chapter.id),
      orderIndex: asPositiveInt(chapter.orderIndex),
      title: asString(chapter.title),
      rawText: asRawString(rawText),
    } satisfies BookTextCorpusChapter;
  });

  return {
    chapters,
    missingChapterIds,
  };
}

async function loadBookTextCorpusFromDb(params: {
  client: ResolvedBookTextCorpusClient;
  bookId: string;
  reason: string;
  logger?: BookTextCorpusLogger;
  requireText: boolean;
}): Promise<LoadedBookTextCorpus | null> {
  const rows = await params.client.bookChapter.findMany({
    where: {
      bookId: params.bookId,
    },
    orderBy: {
      orderIndex: "asc",
    },
    select: {
      id: true,
      orderIndex: true,
      title: true,
      rawText: true,
    },
  });

  const chapters = rows.map((row: any) => ({
    chapterId: asString(row.id),
    orderIndex: asPositiveInt(row.orderIndex),
    title: asString(row.title),
    rawText: asRawString(row.rawText),
  }));
  const hasAnyText = chapters.some((chapter) => chapter.rawText.length > 0);

  if (params.requireText && !hasAnyText) {
    return null;
  }

  params.logger?.warn?.("book_text_corpus_fallback_to_db", {
    bookId: params.bookId,
    reason: params.reason,
    chapterCount: chapters.length,
    hasAnyText,
  });

  return {
    bookId: params.bookId,
    chapters,
    source: "db",
    fallbackToDb: true,
    fallbackReason: params.reason,
  };
}

async function loadBookTextCorpusUncached(params: {
  client: ResolvedBookTextCorpusClient;
  bookId: string;
  book: {
    id: string;
    textCorpusStorageProvider?: string | null;
    textCorpusStorageKey?: string | null;
    textCorpusSizeBytes?: number | null;
    textCorpusSha256?: string | null;
    textCorpusCompression?: string | null;
    textCorpusSchemaVersion?: string | null;
    chapters: Array<{ id: string; orderIndex: number; title: string }>;
  };
  store: BlobStore;
  logger?: BookTextCorpusLogger;
}): Promise<LoadedBookTextCorpus> {
  const storageKey = asString(params.book.textCorpusStorageKey);
  if (!storageKey) {
    const legacy = await loadBookTextCorpusFromDb({
      client: params.client,
      bookId: params.bookId,
      reason: "legacy_missing_s3_pointer",
      logger: params.logger,
      requireText: false,
    });
    if (!legacy) {
      throw new Error(`Book ${params.bookId} text corpus is unavailable`);
    }
    return legacy;
  }

  try {
    const fetchStartedAt = nowMs();
    const payload = await getBookTextCorpus({
      store: params.store,
      storageKey,
      compression: params.book.textCorpusCompression,
      expectedSha256: params.book.textCorpusSha256,
      expectedSizeBytes: params.book.textCorpusSizeBytes,
    });
    const fetchMs = Math.max(0, nowMs() - fetchStartedAt);

    params.logger?.info?.("book_text_corpus_fetch_ms", {
      bookId: params.bookId,
      storageKey,
      fetchMs,
      sizeBytes: params.book.textCorpusSizeBytes ?? null,
      provider: asString(params.book.textCorpusStorageProvider) || "unknown",
    });

    const mapped = mapCorpusToBookChapters({
      bookId: params.bookId,
      metadataChapters: params.book.chapters,
      payloadChapters: payload.chapters,
    });
    if (mapped.missingChapterIds.length === 0) {
      return {
        bookId: params.bookId,
        chapters: mapped.chapters,
        source: "s3",
        fallbackToDb: false,
        fallbackReason: null,
      };
    }

    const fallback = await loadBookTextCorpusFromDb({
      client: params.client,
      bookId: params.bookId,
      reason: "s3_payload_mismatch",
      logger: params.logger,
      requireText: true,
    });

    if (fallback) {
      return fallback;
    }

    throw new Error(
      `Book text corpus payload missing chapters: ${mapped.missingChapterIds.join(", ") || "unknown missing chapters"}`
    );
  } catch (error) {
    const fallback = await loadBookTextCorpusFromDb({
      client: params.client,
      bookId: params.bookId,
      reason: "s3_read_error",
      logger: params.logger,
      requireText: true,
    });
    if (fallback) {
      return fallback;
    }

    const normalizedError = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to load S3 book text corpus for book ${params.bookId}: ${normalizedError.message}`);
  }
}

function getBookTextCorpusBlobStore(): BlobStore {
  if (!singletonBookTextCorpusBlobStore) {
    singletonBookTextCorpusBlobStore = createBookTextCorpusBlobStoreFromEnv();
  }
  return singletonBookTextCorpusBlobStore;
}

export async function resolveBookTextCorpus(params: {
  client: BookTextCorpusClient;
  bookId: string;
  logger?: BookTextCorpusLogger;
  store?: BlobStore;
  cacheTtlMs?: number;
  cacheMaxBooks?: number;
}): Promise<ResolvedBookTextCorpus> {
  const bookId = asString(params.bookId);
  if (!bookId) {
    throw new Error("resolveBookTextCorpus requires non-empty bookId");
  }

  const client = params.client as ResolvedBookTextCorpusClient;
  if (!client?.book || !client?.bookChapter) {
    throw new Error("resolveBookTextCorpus requires client.book and client.bookChapter delegates");
  }

  const book = await client.book.findUnique({
    where: {
      id: bookId,
    },
    select: {
      id: true,
      updatedAt: true,
      textCorpusStorageProvider: true,
      textCorpusStorageKey: true,
      textCorpusSizeBytes: true,
      textCorpusSha256: true,
      textCorpusCompression: true,
      textCorpusSchemaVersion: true,
      chapters: {
        orderBy: {
          orderIndex: "asc",
        },
        select: {
          id: true,
          orderIndex: true,
          title: true,
        },
      },
    },
  });

  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  const cacheTtlMs = Math.max(30_000, Number(params.cacheTtlMs || resolveCacheTtlMs()));
  const cacheMaxBooks = Math.max(2, Number(params.cacheMaxBooks || resolveCacheMaxBooks()));
  const cacheKey = buildCacheKey({
    updatedAt: book.updatedAt,
    textCorpusStorageKey: book.textCorpusStorageKey,
    textCorpusSha256: book.textCorpusSha256,
    textCorpusSizeBytes: book.textCorpusSizeBytes,
    textCorpusCompression: book.textCorpusCompression,
    textCorpusSchemaVersion: book.textCorpusSchemaVersion,
    chapters: Array.isArray(book.chapters) ? book.chapters : [],
  });

  const { value, hit } = await getOrLoadBookTextCorpusCache({
    cache: bookTextCorpusCacheByBook,
    bookId,
    cacheKey,
    ttlMs: cacheTtlMs,
    maxBooks: cacheMaxBooks,
    loader: () =>
      loadBookTextCorpusUncached({
        client,
        bookId,
        book,
        store: params.store || getBookTextCorpusBlobStore(),
        logger: params.logger,
      }),
  });

  params.logger?.info?.("book_text_corpus_cache_hit", {
    bookId,
    hit,
    source: value.source,
  });

  return {
    ...value,
    cacheHit: hit,
  };
}
