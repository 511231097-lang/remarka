import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalBlobStore, S3BlobStore, enqueueBookAnalyzerStage, type BlobStore, prisma } from "@remarka/db";
import {
  BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS,
  BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS,
  BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS,
  BOOK_EXPERT_CORE_QUOTE_TAGS,
  BOOK_EXPERT_CORE_QUOTE_TYPES,
  BOOK_EXPERT_CORE_STAGE_KEYS,
  BOOK_EXPERT_CORE_VERSION,
  BookExpertCoreCharacterSchema,
  BookExpertCoreIncidentSchema,
  BookExpertCoreLiterarySectionKeySchema,
  BookExpertCoreLiterarySectionSchema,
  BookExpertCoreLocationSchema,
  BookExpertCoreQuoteSchema,
  BookExpertCoreSnapshotSchema,
  BookExpertCoreThemeSchema,
  BookExpertCoreWindowScanSchema,
  buildPlainTextFromParsedChapter,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  normalizeEntityName,
  parseBook,
  type BookExpertCoreIncident,
  type BookExpertCoreSnapshot,
  type BookExpertCoreStageKey,
  type BookExpertCoreWindowScan,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import { callStrictJson } from "../extractionV2";
import { logger } from "../logger";

interface StagePayload {
  bookId: string;
}

type CoreAnalyzerType = BookExpertCoreStageKey;

interface LoadedBookSource {
  id: string;
  title: string;
  author: string | null;
  fileName: string;
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
}

interface ChapterSource {
  orderIndex: number;
  title: string;
  rawText: string;
}

interface WindowInput {
  windowIndex: number;
  chapterFrom: number;
  chapterTo: number;
  chapters: ChapterSource[];
  text: string;
  textChars: number;
}

interface CandidateEntityAggregate {
  normalizedName: string;
  name: string;
  aliases: Set<string>;
  mentionCount: number;
  firstAppearanceChapterOrder: number | null;
  descriptionHints: string[];
  roleHints: string[];
  arcHints: string[];
  motivationHints: string[];
  significanceHints: string[];
  anchors: Array<{ chapterOrderIndex: number; snippet: string }>;
  sourceWindows: Set<number>;
}

const MAX_PLOT_POINTS = 18;
const MAX_CHARACTERS = 12;
const MAX_THEMES = 10;
const MAX_LOCATIONS = 10;
const MAX_QUOTES = 60;
const MAX_INCIDENTS = 24;
const WINDOW_SCAN_CONCURRENCY = 3;
const WINDOW_TARGET_TOKENS = 9_000;
const WINDOW_MAX_TOKENS = 12_000;
const WINDOW_HARD_MAX = 16;
const DEFAULT_BOOK_BRIEF = {
  shortSummary: "Книга проходит расширенный semantic scan.",
  fullSummary: "Core книги ещё собирается. Подробный обзор появится после завершения merge и profile stage.",
  spoilerSummary: "Core книги ещё собирается. Подробный обзор появится после завершения merge и profile stage.",
};

const LooseProfileBatchInputSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { items: input } : input),
  z.object({
    items: z.array(z.unknown()).max(MAX_CHARACTERS),
  })
);
const CharacterProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    aliases: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    role: z.string().trim().min(1).max(220).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    arc: z.string().trim().min(1).max(900).optional(),
    motivations: z.array(z.string().trim().min(1).max(220)).max(6).optional(),
  })
  .passthrough();
const ThemeProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    aliases: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    development: z.string().trim().min(1).max(900).optional(),
  })
  .passthrough();
const LocationProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    aliases: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    significance: z.string().trim().min(1).max(900).optional(),
  })
  .passthrough();
const CharacterBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(CharacterProfilePatchSchema).max(MAX_CHARACTERS),
  })
);
const ThemeBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(ThemeProfilePatchSchema).max(MAX_THEMES),
  })
);
const LocationBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(LocationProfilePatchSchema).max(MAX_LOCATIONS),
  })
);

const LiteraryPatternSchema = z.object({
  patterns: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(180),
        summary: z.string().trim().min(1).max(400),
        evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
      })
    )
    .min(1)
    .max(12),
  centralTension: z.string().trim().min(1).max(500),
  interpretiveLens: z.string().trim().min(1).max(500),
});

const LooseLiteraryPatternSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { patterns: input } : input),
  z
    .object({
      patterns: z
        .array(
          z.union([
            z.string().trim().min(1).max(400),
            z
              .object({
                name: z.string().trim().min(1).max(180).optional(),
                title: z.string().trim().min(1).max(180).optional(),
                label: z.string().trim().min(1).max(180).optional(),
                summary: z.string().trim().min(1).max(400).optional(),
                description: z.string().trim().min(1).max(400).optional(),
                evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(8).optional().default([]),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      centralTension: z.string().trim().max(500).optional().default(""),
      interpretiveLens: z.string().trim().max(500).optional().default(""),
    })
    .passthrough()
);

const LooseLiterarySectionPatchSchema = z
  .object({
    key: BookExpertCoreLiterarySectionKeySchema.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
    bodyMarkdown: z.string().trim().min(1).max(6000).optional(),
    bullets: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    confidence: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();

const LiterarySectionsResultSchema = z.object({
  sections: z.object(
    Object.fromEntries(
      BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.map((key) => [key, BookExpertCoreLiterarySectionSchema])
    ) as Record<string, typeof BookExpertCoreLiterarySectionSchema>
  ),
});

const LooseLiterarySectionsResultSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if ("sections" in record) return input;
    return { sections: record };
  },
  z
    .object({
      sections: z.union([
        z.record(z.string(), LooseLiterarySectionPatchSchema),
        z.array(LooseLiterarySectionPatchSchema),
      ]),
    })
    .passthrough()
);

const LooseWindowScanNumberSchema = z.union([z.number(), z.string()]).optional().nullable();
const LooseWindowScanStringArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(z.string().trim().min(1).max(200)).max(16).optional().default([])
);
const LooseIncidentParticipantSchema = z.union([
  z.string().trim().min(1).max(200),
  z
    .object({
      kind: z.string().trim().min(1).max(40).optional(),
      value: z.string().trim().min(1).max(160).optional(),
      name: z.string().trim().min(1).max(160).optional(),
      normalizedValue: z.string().trim().min(1).max(160).optional(),
      role: z.string().trim().min(1).max(120).optional(),
    })
    .passthrough(),
]);
const LooseIncidentFactsSchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z
    .array(
      z.union([
        z.string().trim().min(1).max(260),
        z
          .object({
            fact: z.string().trim().min(1).max(260).optional(),
            text: z.string().trim().min(1).max(260).optional(),
            summary: z.string().trim().min(1).max(260).optional(),
            label: z.string().trim().min(1).max(260).optional(),
          })
          .passthrough(),
      ])
    )
    .max(12)
    .optional()
    .default([])
);

const LooseIncidentParticipantArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(LooseIncidentParticipantSchema).max(16).optional().default([])
);

const LooseIncidentQuoteArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(z.string().trim().min(1).max(1200)).max(8).optional().default([])
);

const WindowScanModelOutputSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { plotPoints: input } : input),
  z
    .object({
      summary: z.string().trim().max(900).optional().default(""),
      plotPoints: z
        .array(
          z.union([
            z.string().trim().min(1).max(500),
            z
              .object({
                label: z.string().trim().min(1).max(180).optional(),
                name: z.string().trim().min(1).max(180).optional(),
                summary: z.string().trim().min(1).max(500).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      characters: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                aliases: LooseWindowScanStringArraySchema,
                roleHint: z.string().trim().min(1).max(240).optional(),
                role: z.string().trim().min(1).max(240).optional(),
                traits: LooseWindowScanStringArraySchema,
                motivations: LooseWindowScanStringArraySchema,
                arcHint: z.string().trim().min(1).max(320).optional(),
                arc: z.string().trim().min(1).max(320).optional(),
                description: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      themes: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                label: z.string().trim().min(1).max(160).optional(),
                description: z.string().trim().min(1).max(260).optional(),
                developmentHint: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      locations: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                label: z.string().trim().min(1).max(160).optional(),
                description: z.string().trim().min(1).max(260).optional(),
                significanceHint: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      quotes: z
        .array(
          z.union([
            z.string().trim().min(1).max(1200),
            z
              .object({
                chapterOrderIndex: LooseWindowScanNumberSchema,
                startChar: LooseWindowScanNumberSchema,
                endChar: LooseWindowScanNumberSchema,
                text: z.string().trim().min(1).max(1200).optional(),
                quote: z.string().trim().min(1).max(1200).optional(),
                type: z.string().trim().min(1).max(40).optional(),
                tags: z.array(z.string().trim().min(1).max(60)).max(8).optional().default([]),
                commentary: z.string().trim().max(420).nullable().optional().default(null),
                mentions: z
                  .array(
                    z.union([
                      z.string().trim().min(1).max(160),
                      z
                        .object({
                          kind: z.string().trim().min(1).max(40).optional(),
                          value: z.string().trim().min(1).max(160).optional(),
                          name: z.string().trim().min(1).max(160).optional(),
                          normalizedValue: z.string().trim().min(1).max(160).optional(),
                          confidence: LooseWindowScanNumberSchema,
                        })
                        .passthrough(),
                    ])
                  )
                  .max(16)
                  .optional()
                  .default([]),
                confidence: LooseWindowScanNumberSchema,
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      incidents: z
        .array(
          z.union([
            z.string().trim().min(1).max(400),
            z
              .object({
                title: z.string().trim().min(1).max(200).optional(),
                label: z.string().trim().min(1).max(200).optional(),
                summary: z.string().trim().min(1).max(260).optional(),
                chapterFrom: LooseWindowScanNumberSchema,
                chapterTo: LooseWindowScanNumberSchema,
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                participants: LooseIncidentParticipantArraySchema,
                facts: LooseIncidentFactsSchema,
                consequences: LooseIncidentFactsSchema,
                supportingQuoteTexts: LooseIncidentQuoteArraySchema,
                quotes: LooseIncidentQuoteArraySchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
    })
    .passthrough()
);

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

function clampMarkdown(value: string, maxChars: number): string {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampUnitInterval(value: unknown, fallback: number): number {
  const numeric = coerceNumber(value);
  if (numeric === null) return fallback;
  if (numeric >= 0 && numeric <= 1) return numeric;
  if (numeric > 1 && numeric <= 10) return numeric / 10;
  if (numeric > 10 && numeric <= 100) return numeric / 100;
  return fallback;
}

function clampChapterOrderIndex(value: unknown, window: WindowInput): number {
  const numeric = coerceNumber(value);
  if (numeric === null) return window.chapterFrom;
  return Math.max(window.chapterFrom, Math.min(window.chapterTo, Math.round(numeric)));
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book expert core processing failed";
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

function dedupeStrings(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = compactWhitespace(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string, limit: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = compactWhitespace(keyFn(item)).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function hashId(prefix: string, parts: Array<string | number>): string {
  const hash = createHash("sha1")
    .update(parts.map((part) => String(part)).join("|"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${hash}`;
}

function createEmptySnapshot(bookId: string): BookExpertCoreSnapshot {
  return {
    version: BOOK_EXPERT_CORE_VERSION,
    bookId,
    completedStages: [],
    timingsMs: {},
    bookBrief: { ...DEFAULT_BOOK_BRIEF },
    plotSpine: [],
    characters: [],
    themes: [],
    locations: [],
    quoteBank: [],
    incidents: [],
    literarySections: null,
    windowScans: [],
    generatedAt: new Date().toISOString(),
  };
}

function mergeCompletedStages(existing: BookExpertCoreStageKey[], next: BookExpertCoreStageKey): BookExpertCoreStageKey[] {
  const out = new Set<BookExpertCoreStageKey>(existing);
  out.add(next);
  return BOOK_EXPERT_CORE_STAGE_KEYS.filter((stage) => out.has(stage));
}

async function readSnapshot(bookId: string): Promise<BookExpertCoreSnapshot | null> {
  const row = await prisma.bookExpertCore.findUnique({
    where: { bookId },
    select: {
      snapshotJson: true,
    },
  });
  if (!row) return null;
  const parsed = BookExpertCoreSnapshotSchema.safeParse(row.snapshotJson);
  return parsed.success ? parsed.data : null;
}

async function saveSnapshot(bookId: string, snapshot: BookExpertCoreSnapshot): Promise<void> {
  await prisma.bookExpertCore.upsert({
    where: { bookId },
    create: {
      bookId,
      version: snapshot.version,
      snapshotJson: snapshot,
      generatedAt: new Date(snapshot.generatedAt),
    },
    update: {
      version: snapshot.version,
      snapshotJson: snapshot,
      generatedAt: new Date(snapshot.generatedAt),
    },
  });
}

async function updateTaskState(params: {
  bookId: string;
  analyzerType: string;
  state: "queued" | "running" | "completed" | "failed";
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}) {
  await prisma.bookAnalyzerTask.upsert({
    where: {
      bookId_analyzerType: {
        bookId: params.bookId,
        analyzerType: params.analyzerType as any,
      },
    },
    create: {
      bookId: params.bookId,
      analyzerType: params.analyzerType as any,
      state: params.state,
      error: params.error || null,
      startedAt: params.startedAt || null,
      completedAt: params.completedAt || null,
    },
    update: {
      state: params.state,
      error: params.error || null,
      startedAt: params.startedAt === undefined ? undefined : params.startedAt,
      completedAt: params.completedAt === undefined ? undefined : params.completedAt,
    },
  });
}

async function queueNextStage(bookId: string, analyzerType: CoreAnalyzerType): Promise<void> {
  await enqueueBookAnalyzerStage({
    bookId,
    analyzerType,
    publishEvent: true,
  });
}

const CORE_STAGE_DEPENDENCIES: Partial<Record<CoreAnalyzerType, CoreAnalyzerType>> = {
  core_merge: "core_window_scan",
  core_profiles: "core_merge",
  core_quotes_finalize: "core_profiles",
  core_literary: "core_quotes_finalize",
};

async function loadBookSource(bookId: string): Promise<{ book: LoadedBookSource; chapters: ChapterSource[] }> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      fileName: true,
      storageProvider: true,
      storageKey: true,
      createdAt: true,
    },
  });
  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  const format = resolveUploadFormat(book.fileName);
  if (!format) {
    throw new Error(`Unsupported stored book format: ${book.fileName}`);
  }

  const blobStore = resolveBooksBlobStore(book.storageProvider);
  const bytes = await blobStore.get(book.storageKey);
  const parsedBook = ensureParsedBookHasChapters(
    await parseBook({
      format,
      fileName: book.fileName,
      bytes,
      maxZipUncompressedBytes: workerConfig.imports.maxZipUncompressedBytes,
    })
  );

  const chapters = parsedBook.chapters.map((chapter, index) => ({
    orderIndex: index + 1,
    title: resolveChapterTitle(chapter, index + 1),
    rawText: buildPlainTextFromParsedChapter(chapter),
  }));

  return { book, chapters };
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(compactWhitespace(value).length / 4));
}

function buildWindowText(chapters: ChapterSource[]): string {
  return chapters.map((item) => `### Глава ${item.orderIndex}: ${item.title}\n${item.rawText}`).join("\n\n");
}

function mergeSmallestAdjacentWindows(windows: WindowInput[]): WindowInput[] {
  if (windows.length <= WINDOW_HARD_MAX) return windows;
  const next = [...windows];
  while (next.length > WINDOW_HARD_MAX) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < next.length - 1; index += 1) {
      const left = next[index];
      const right = next[index + 1];
      const combinedScore = estimateTextTokens(left.text) + estimateTextTokens(right.text);
      if (combinedScore < bestScore) {
        bestScore = combinedScore;
        bestIndex = index;
      }
    }
    const mergedChapters = [...next[bestIndex].chapters, ...next[bestIndex + 1].chapters];
    const text = buildWindowText(mergedChapters);
    next.splice(bestIndex, 2, {
      windowIndex: bestIndex + 1,
      chapterFrom: mergedChapters[0].orderIndex,
      chapterTo: mergedChapters[mergedChapters.length - 1].orderIndex,
      chapters: mergedChapters,
      text,
      textChars: text.length,
    });
  }
  return next.map((window, index) => ({
    ...window,
    windowIndex: index + 1,
  }));
}

function chunkChaptersIntoWindows(chapters: ChapterSource[]): WindowInput[] {
  const nonEmpty = chapters.filter((chapter) => compactWhitespace(chapter.rawText));
  if (!nonEmpty.length) return [];

  const chapterTokens = nonEmpty.map((chapter) => ({
    chapter,
    tokens: estimateTextTokens(chapter.rawText),
  }));
  const totalTokens = chapterTokens.reduce((sum, item) => sum + item.tokens, 0);
  const desiredWindowCount = Math.max(4, Math.min(12, Math.round(totalTokens / WINDOW_TARGET_TOKENS)));
  const targetTokens = Math.max(4_500, Math.ceil(totalTokens / Math.max(1, desiredWindowCount)));

  const windows: WindowInput[] = [];
  let bucket: ChapterSource[] = [];
  let bucketTokens = 0;

  for (const { chapter, tokens } of chapterTokens) {
    const chapterText = compactWhitespace(chapter.rawText);
    if (!chapterText) continue;

    const nextTokens = bucketTokens + tokens;
    const shouldFlush =
      bucket.length > 0 &&
      (nextTokens > WINDOW_MAX_TOKENS || (bucketTokens >= targetTokens && windows.length + 1 < desiredWindowCount));

    if (shouldFlush) {
      const chapterFrom = bucket[0].orderIndex;
      const chapterTo = bucket[bucket.length - 1].orderIndex;
      const text = buildWindowText(bucket);
      windows.push({
        windowIndex: windows.length + 1,
        chapterFrom,
        chapterTo,
        chapters: bucket,
        text,
        textChars: text.length,
      });
      bucket = [];
      bucketTokens = 0;
    }

    bucket.push(chapter);
    bucketTokens += tokens;
  }

  if (bucket.length > 0) {
    const chapterFrom = bucket[0].orderIndex;
    const chapterTo = bucket[bucket.length - 1].orderIndex;
    const text = buildWindowText(bucket);
    windows.push({
      windowIndex: windows.length + 1,
      chapterFrom,
      chapterTo,
      chapters: bucket,
      text,
      textChars: text.length,
    });
  }

  return mergeSmallestAdjacentWindows(windows).map((window, index) => ({
    ...window,
    windowIndex: index + 1,
  }));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];

  const out = new Array<R>(items.length);
  const safeConcurrency = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await worker(items[index], index);
      }
    })
  );

  return out;
}

function buildWindowScanPrompt(book: LoadedBookSource, window: WindowInput): string {
  return [
    `Книга: ${book.title}${book.author ? ` (${book.author})` : ""}`,
    `Окно: главы ${window.chapterFrom}-${window.chapterTo}`,
    "",
    "Верни один JSON-объект для этого окна книги.",
    "Требования:",
    "1. Используй только материал окна.",
    "2. summary опиши как короткий смысловой снимок этого окна.",
    "3. plotPoints — только реально важные события или повороты.",
    "4. characters/themes/locations — только сущности, которые реально значимы в этом окне.",
    "5. quotes — только сильные фрагменты, полезные для будущего expert-chat. Не более 24.",
    "6. incidents — важные сцены или эпизоды этого окна, где есть понятная причинно-следственная цепочка.",
    "7. У incident нужны title, participants, facts, consequences и snippet. facts должны идти по порядку.",
    "8. Для chapterOrderIndex/chapterFrom/chapterTo используй реальные номера глав из окна.",
    "9. Не возвращай windowIndex, textChars: эти поля проставит система.",
    "10. Не придумывай startChar/endChar: если не уверен, верни null.",
    "11. Если для сущности или incident не хватает деталей, дай короткий объект, но не превращай весь ответ в массив строк.",
    "12. Корневой JSON должен быть объектом с ключами summary, plotPoints, characters, themes, locations, quotes, incidents.",
    "13. Предпочитай компактность и точность, а не полноту любой ценой.",
    "",
    "Минимальная форма объекта:",
    '{"summary":"...","plotPoints":[],"characters":[],"themes":[],"locations":[],"quotes":[],"incidents":[]}',
    "",
    "Текст окна:",
    window.text,
  ].join("\n");
}

function scoreSnippetRelevance(text: string, query: string): number {
  const haystack = normalizeEntityName(text);
  const needles = dedupeStrings(query.split(/\s+/g), 12).map((item) => normalizeEntityName(item)).filter(Boolean);
  if (!needles.length) return 0;
  let score = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) score += needle.length > 4 ? 2 : 1;
  }
  return score;
}

function buildWindowSource(window: BookExpertCoreWindowScan): { windowIndex: number; chapterFrom: number; chapterTo: number; chapterCount: number; textChars: number } {
  return {
    windowIndex: window.windowIndex,
    chapterFrom: window.chapterFrom,
    chapterTo: window.chapterTo,
    chapterCount: Math.max(1, window.chapterTo - window.chapterFrom + 1),
    textChars: window.textChars,
  };
}

function mergeWindowScans(
  bookId: string,
  windowScans: BookExpertCoreWindowScan[]
): Pick<BookExpertCoreSnapshot, "bookBrief" | "plotSpine" | "characters" | "themes" | "locations" | "quoteBank" | "incidents"> {
  const summaryBits = dedupeStrings(windowScans.map((window) => window.summary), 12);

  const plotPointMap = new Map<string, BookExpertCoreSnapshot["plotSpine"][number]>();
  const characterMap = new Map<string, CandidateEntityAggregate>();
  const themeMap = new Map<string, CandidateEntityAggregate>();
  const locationMap = new Map<string, CandidateEntityAggregate>();
  const quoteMap = new Map<string, BookExpertCoreSnapshot["quoteBank"][number]>();
  const incidentMap = new Map<string, BookExpertCoreIncident>();
  const incidentSupportingQuotes = new Map<string, string[]>();

  const pushAnchor = (target: CandidateEntityAggregate, chapterOrderIndex: number, snippet: string, windowIndex: number) => {
    if (target.anchors.length < 4) {
      target.anchors.push({
        chapterOrderIndex,
        snippet: clampText(snippet, 220),
      });
    }
    target.sourceWindows.add(windowIndex);
  };

  const mergeEntity = (
    map: Map<string, CandidateEntityAggregate>,
    raw: {
      name: string;
      aliases?: string[];
      roleHint?: string;
      description?: string;
      developmentHint?: string;
      significanceHint?: string;
      arcHint?: string;
      motivations?: string[];
      traits?: string[];
      chapterOrderIndex: number;
      snippet: string;
    },
    windowIndex: number,
    kind: "character" | "theme" | "location"
  ) => {
    const normalizedName = normalizeEntityName(raw.name);
    if (!normalizedName) return;

    const existing =
      map.get(normalizedName) ||
      ({
        normalizedName,
        name: compactWhitespace(raw.name),
        aliases: new Set<string>(),
        mentionCount: 0,
        firstAppearanceChapterOrder: null,
        descriptionHints: [],
        roleHints: [],
        arcHints: [],
        motivationHints: [],
        significanceHints: [],
        anchors: [],
        sourceWindows: new Set<number>(),
      } satisfies CandidateEntityAggregate);

    existing.mentionCount += 1;
    existing.firstAppearanceChapterOrder =
      existing.firstAppearanceChapterOrder === null
        ? raw.chapterOrderIndex
        : Math.min(existing.firstAppearanceChapterOrder, raw.chapterOrderIndex);
    for (const alias of raw.aliases || []) {
      const value = compactWhitespace(alias);
      if (value) existing.aliases.add(value);
    }
    const descriptionHint =
      kind === "theme"
        ? raw.description || raw.developmentHint || ""
        : kind === "location"
          ? raw.description || raw.significanceHint || ""
          : raw.description || raw.roleHint || raw.arcHint || "";
    if (descriptionHint) existing.descriptionHints.push(clampText(descriptionHint, 260));
    if (raw.roleHint) existing.roleHints.push(clampText(raw.roleHint, 180));
    if (raw.arcHint) existing.arcHints.push(clampText(raw.arcHint, 220));
    for (const item of raw.motivations || raw.traits || []) {
      const normalized = clampText(item, 160);
      if (normalized) existing.motivationHints.push(normalized);
    }
    if (raw.significanceHint) existing.significanceHints.push(clampText(raw.significanceHint, 220));
    pushAnchor(existing, raw.chapterOrderIndex, raw.snippet, windowIndex);
    map.set(normalizedName, existing);
  };

  for (const window of windowScans) {
    const windowSource = buildWindowSource(window);

    for (const plotPoint of window.plotPoints) {
      const key = `${plotPoint.chapterOrderIndex}:${normalizeEntityName(plotPoint.label)}`;
      const existing = plotPointMap.get(key);
      if (!existing) {
        plotPointMap.set(key, {
          id: hashId("plot", [bookId, key]),
          label: clampText(plotPoint.label, 180),
          summary: clampText(plotPoint.summary, 360),
          chapterOrderIndex: plotPoint.chapterOrderIndex,
          importance: plotPoint.importance,
          anchors: [
            {
              chapterOrderIndex: plotPoint.chapterOrderIndex,
              startChar: null,
              endChar: null,
              snippet: clampText(plotPoint.snippet, 220),
            },
          ],
          sourceWindows: [windowSource],
        });
        continue;
      }

      existing.importance = Math.max(existing.importance, plotPoint.importance);
      if (existing.anchors.length < 4) {
        existing.anchors.push({
          chapterOrderIndex: plotPoint.chapterOrderIndex,
          startChar: null,
          endChar: null,
          snippet: clampText(plotPoint.snippet, 220),
        });
      }
      if (existing.sourceWindows.length < 4) {
        existing.sourceWindows.push(windowSource);
      }
      if (existing.summary.length < plotPoint.summary.length) {
        existing.summary = clampText(plotPoint.summary, 360);
      }
    }

    for (const character of window.characters) {
      mergeEntity(characterMap, character, window.windowIndex, "character");
    }
    for (const theme of window.themes) {
      mergeEntity(themeMap, theme, window.windowIndex, "theme");
    }
    for (const location of window.locations) {
      mergeEntity(locationMap, location, window.windowIndex, "location");
    }

    for (const quote of window.quotes) {
      const normalizedText = normalizeEntityName(quote.text).slice(0, 280);
      if (!normalizedText) continue;
      const key = `${quote.chapterOrderIndex}:${normalizedText}`;
      const existing = quoteMap.get(key);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, quote.confidence);
        existing.tags = dedupeStrings([...existing.tags, ...(quote.tags || [])], 8) as typeof existing.tags;
        const mentions = [...existing.mentions, ...quote.mentions].sort((left, right) => right.confidence - left.confidence);
        const dedupedMentions = new Map<string, typeof mentions[number]>();
        for (const mention of mentions) {
          const mentionKey = `${mention.kind}:${mention.normalizedValue}`;
          if (!dedupedMentions.has(mentionKey)) {
            dedupedMentions.set(mentionKey, mention);
          }
        }
        existing.mentions = Array.from(dedupedMentions.values()).slice(0, 16);
        continue;
      }

      quoteMap.set(key, {
        id: hashId("quote", [bookId, key]),
        chapterOrderIndex: quote.chapterOrderIndex,
        startChar: typeof quote.startChar === "number" ? Math.max(0, quote.startChar) : 0,
        endChar:
          typeof quote.endChar === "number" && quote.endChar > Number(quote.startChar || 0)
            ? quote.endChar
            : Math.max(1, clampText(quote.text, 1200).length),
        text: clampText(quote.text, 1200),
        type: quote.type,
        tags: dedupeStrings(quote.tags || [], 8) as typeof quote.tags,
        commentary: quote.commentary ? clampText(quote.commentary, 420) : null,
        confidence: quote.confidence,
        mentions: (quote.mentions || []).slice(0, 16),
        anchors: [
          {
            chapterOrderIndex: quote.chapterOrderIndex,
            startChar: typeof quote.startChar === "number" ? Math.max(0, quote.startChar) : null,
            endChar: typeof quote.endChar === "number" ? Math.max(0, quote.endChar) : null,
            snippet: clampText(quote.text, 220),
          },
        ],
        sourceWindows: [windowSource],
      });
    }

    for (const incident of window.incidents) {
      const titleKey = normalizeEntityName(incident.title);
      const factKey = normalizeEntityName(incident.facts[0] || incident.snippet).slice(0, 220);
      const key = `${incident.chapterFrom}:${incident.chapterTo}:${titleKey || factKey}`;
      const existing = incidentMap.get(key);
      const anchor = {
        chapterOrderIndex: incident.chapterFrom,
        startChar: null,
        endChar: null,
        snippet: clampText(incident.snippet, 220),
      };
      const participants = dedupeBy(
        incident.participants.map((participant) => ({
          ...participant,
          entityId: null,
        })),
        (participant) => `${participant.kind}:${participant.normalizedValue}:${participant.role}`,
        12
      );

      if (!existing) {
        incidentMap.set(key, {
          id: hashId("incident", [bookId, key]),
          title: clampText(incident.title, 200),
          chapterFrom: incident.chapterFrom,
          chapterTo: incident.chapterTo,
          importance: incident.importance,
          participants,
          facts: dedupeStrings(incident.facts, 10),
          consequences: dedupeStrings(incident.consequences, 8),
          quoteIds: [],
          anchors: [anchor],
          sourceWindows: [windowSource],
        });
        incidentSupportingQuotes.set(key, dedupeStrings(incident.supportingQuoteTexts || [], 8));
        continue;
      }

      existing.importance = Math.max(existing.importance, incident.importance);
      existing.chapterFrom = Math.min(existing.chapterFrom, incident.chapterFrom);
      existing.chapterTo = Math.max(existing.chapterTo, incident.chapterTo);
      existing.facts = dedupeStrings([...existing.facts, ...incident.facts], 10);
      existing.consequences = dedupeStrings([...existing.consequences, ...incident.consequences], 8);
      existing.participants = dedupeBy(
        [...existing.participants, ...participants],
        (participant) => `${participant.kind}:${participant.normalizedValue}:${participant.role}`,
        12
      );
      if (existing.anchors.length < 4) {
        existing.anchors.push(anchor);
      }
      if (existing.sourceWindows.length < 6) {
        existing.sourceWindows.push(windowSource);
      }
      incidentSupportingQuotes.set(
        key,
        dedupeStrings([...(incidentSupportingQuotes.get(key) || []), ...(incident.supportingQuoteTexts || [])], 8)
      );
    }
  }

  const toCharacterCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("character", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 12),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    role: clampText(entry.roleHints[0] || "Ключевой участник сюжетной линии", 180),
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    arc: clampText(dedupeStrings(entry.arcHints, 3).join(" ") || dedupeStrings(entry.descriptionHints, 2).join(" ") || entry.name, 600),
    motivations: dedupeStrings(entry.motivationHints, 6),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: Array.from(entry.sourceWindows)
      .sort((left, right) => left - right)
      .slice(0, 6)
      .map((windowIndex) => ({ windowIndex, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 0 })),
  });

  const toThemeCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("theme", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 8),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    development: clampText(dedupeStrings([...entry.descriptionHints, ...entry.arcHints], 4).join(" ") || entry.name, 600),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: Array.from(entry.sourceWindows)
      .sort((left, right) => left - right)
      .slice(0, 6)
      .map((windowIndex) => ({ windowIndex, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 0 })),
  });

  const toLocationCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("location", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 8),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    significance: clampText(dedupeStrings([...entry.significanceHints, ...entry.descriptionHints], 4).join(" ") || entry.name, 600),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: Array.from(entry.sourceWindows)
      .sort((left, right) => left - right)
      .slice(0, 6)
      .map((windowIndex) => ({ windowIndex, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 0 })),
  });

  const plotSpine = Array.from(plotPointMap.values())
    .sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex || right.importance - left.importance)
    .slice(0, MAX_PLOT_POINTS);

  const characters = Array.from(characterMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_CHARACTERS)
    .map(toCharacterCard);

  const themes = Array.from(themeMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_THEMES)
    .map(toThemeCard);

  const locations = Array.from(locationMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_LOCATIONS)
    .map(toLocationCard);

  const quoteBank = Array.from(quoteMap.values())
    .sort((left, right) => right.confidence - left.confidence || left.chapterOrderIndex - right.chapterOrderIndex)
    .slice(0, MAX_QUOTES);

  const characterIds = new Map(characters.map((item) => [item.normalizedName, item.id] as const));
  const themeIds = new Map(themes.map((item) => [item.normalizedName, item.id] as const));
  const locationIds = new Map(locations.map((item) => [item.normalizedName, item.id] as const));
  const resolveIncidentParticipant = (participant: BookExpertCoreIncident["participants"][number]) => {
    const normalized = participant.normalizedValue;
    const characterId = characterIds.get(normalized);
    const themeId = themeIds.get(normalized);
    const locationId = locationIds.get(normalized);
    if (participant.kind === "character" && characterId) return { ...participant, entityId: characterId };
    if (participant.kind === "theme" && themeId) return { ...participant, entityId: themeId };
    if (participant.kind === "location" && locationId) return { ...participant, entityId: locationId };
    if (participant.kind === "unknown") {
      if (characterId) return { ...participant, kind: "character" as const, entityId: characterId };
      if (locationId) return { ...participant, kind: "location" as const, entityId: locationId };
      if (themeId) return { ...participant, kind: "theme" as const, entityId: themeId };
    }
    return participant;
  };
  const quoteTextIndex = quoteBank.map((quote) => ({
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    normalizedText: normalizeEntityName(quote.text).slice(0, 320),
  }));
  const incidents = Array.from(incidentMap.entries())
    .map(([key, incident]) => {
      const supportingQuotes = incidentSupportingQuotes.get(key) || [];
      const normalizedSupports = supportingQuotes.map((value) => normalizeEntityName(value)).filter(Boolean);
      const quoteIds = dedupeStrings(
        quoteTextIndex
          .filter((quote) => quote.chapterOrderIndex >= incident.chapterFrom && quote.chapterOrderIndex <= incident.chapterTo)
          .filter((quote) =>
            normalizedSupports.length === 0
              ? incident.anchors.some((anchor) => normalizeEntityName(anchor.snippet).includes(quote.normalizedText.slice(0, 160)))
              : normalizedSupports.some(
                  (support) => quote.normalizedText.includes(support) || support.includes(quote.normalizedText)
                )
          )
          .map((quote) => quote.id),
        12
      );

      return BookExpertCoreIncidentSchema.parse({
        ...incident,
        participants: incident.participants.map(resolveIncidentParticipant),
        quoteIds,
        sourceWindows: incident.sourceWindows
          .sort((left, right) => left.windowIndex - right.windowIndex)
          .slice(0, 6),
      });
    })
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance;
      if (left.chapterFrom !== right.chapterFrom) return left.chapterFrom - right.chapterFrom;
      return left.title.localeCompare(right.title, "ru");
    })
    .slice(0, MAX_INCIDENTS);

  const plotSummaries = plotSpine.slice(0, 6).map((item) => item.summary);
  const bookBrief = {
    shortSummary: clampText(summaryBits[0] || plotSummaries[0] || DEFAULT_BOOK_BRIEF.shortSummary, 320),
    fullSummary: clampText([...summaryBits.slice(0, 4), ...plotSummaries.slice(0, 4)].join(" ") || DEFAULT_BOOK_BRIEF.fullSummary, 1200),
    spoilerSummary: clampText(plotSpine.slice(0, 10).map((item) => item.summary).join(" ") || DEFAULT_BOOK_BRIEF.spoilerSummary, 1600),
  };

  return {
    bookBrief,
    plotSpine,
    characters,
    themes,
    locations,
    quoteBank,
    incidents,
  };
}

function buildProfilesPrompt(params: {
  kind: "characters" | "themes" | "locations";
  book: LoadedBookSource;
  bookBrief: BookExpertCoreSnapshot["bookBrief"];
  plotSpine: BookExpertCoreSnapshot["plotSpine"];
  items: unknown[];
}): string {
  const label = params.kind === "characters" ? "персонажей" : params.kind === "themes" ? "тем" : "локаций";
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    `Собери narrative patch для карточек ${label} по уже агрегированному semantic core.`,
    "Требования:",
    "1. Не придумывай новых сущностей и не удаляй существующие.",
    "2. Верни только items с идентификатором (id или normalizedName) и narrative-полями для патча.",
    "3. Не переписывай anchors, sourceWindows, mentionCount, firstAppearanceChapterOrder.",
    "4. Пиши коротко, конкретно, без академической воды.",
    "5. Поля description/development/arc/significance должны быть полезны для expert-chat, а не общими фразами.",
    "6. motivations для персонажей — только то, что реально следует из core, не более 6 пунктов.",
    "7. aliases обновляй только если это реально полезные и точные варианты имени.",
    "",
    `Book brief: ${JSON.stringify(params.bookBrief)}`,
    `Plot spine: ${JSON.stringify(params.plotSpine.slice(0, 12))}`,
    `Входные кандидаты ${label}: ${JSON.stringify(params.items)}`,
  ].join("\n");
}

function buildLiteraryPatternPrompt(snapshot: BookExpertCoreSnapshot): string {
  return [
    `Книга: ${snapshot.bookId}`,
    "Построй argument map для literary synthesis на основе готового semantic core.",
    "Нужны только те паттерны, которые реально поддержаны incidents, plot spine, entity cards и quote bank.",
    "Можно вернуть либо массив паттернов, либо объект с patterns/centralTension/interpretiveLens.",
    "Для паттерна достаточно name/summary/evidenceQuoteIds. Если не уверен, не заполняй лишние поля.",
    `Book brief: ${JSON.stringify(snapshot.bookBrief)}`,
    `Incidents: ${JSON.stringify(snapshot.incidents.slice(0, 18))}`,
    `Plot spine: ${JSON.stringify(snapshot.plotSpine.slice(0, 16))}`,
    `Characters: ${JSON.stringify(snapshot.characters.slice(0, 10))}`,
    `Themes: ${JSON.stringify(snapshot.themes.slice(0, 10))}`,
    `Locations: ${JSON.stringify(snapshot.locations.slice(0, 8))}`,
    `Quote bank: ${JSON.stringify(snapshot.quoteBank.slice(0, 24))}`,
  ].join("\n");
}

function buildLiterarySectionsPrompt(snapshot: BookExpertCoreSnapshot, patternMap: z.infer<typeof LiteraryPatternSchema>): string {
  return [
    "На основе semantic core и argument map собери полный literary analysis книги.",
    "Требования:",
    "1. Верни все 10 разделов.",
    "2. Допустим partial patch: можно вернуть только sections с теми полями, которые ты уверен заполнить качественно.",
    "3. Каждый раздел должен быть конкретен и опираться на incidents, plot spine, themes, characters и quotes.",
    "4. bodyMarkdown должен быть компактным, пригодным для UI.",
    "5. evidenceQuoteIds выбирай только из переданного quote bank.",
    "6. Не используй внешнее знание о книге.",
    `Book brief: ${JSON.stringify(snapshot.bookBrief)}`,
    `Pattern map: ${JSON.stringify(patternMap)}`,
    `Incidents: ${JSON.stringify(snapshot.incidents.slice(0, 18))}`,
    `Plot spine: ${JSON.stringify(snapshot.plotSpine.slice(0, 16))}`,
    `Characters: ${JSON.stringify(snapshot.characters.slice(0, 10))}`,
    `Themes: ${JSON.stringify(snapshot.themes.slice(0, 10))}`,
    `Quote bank: ${JSON.stringify(snapshot.quoteBank.slice(0, 32))}`,
  ].join("\n");
}

function normalizeWindowScan(window: WindowInput, result: z.infer<typeof WindowScanModelOutputSchema>): BookExpertCoreWindowScan {
  const quoteTypeSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_TYPES);
  const quoteTagSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_TAGS);
  const mentionKindSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS);
  const incidentParticipantKindSet = new Set<string>(BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS);

  const normalizeStringList = (items: string[] | undefined, limit: number, maxChars: number): string[] =>
    dedupeStrings(
      Array.isArray(items)
        ? items.map((item) => clampText(item, maxChars)).filter(Boolean)
        : [],
      limit
    );
  const normalizeIncidentFactList = (items: Array<string | Record<string, unknown>> | undefined, limit: number): string[] =>
    dedupeStrings(
      Array.isArray(items)
        ? items
            .map((item) => {
              if (typeof item === "string") return clampText(item, 260);
              const record = item || {};
              return clampText(
                String(
                  record.fact ||
                    record.text ||
                    record.summary ||
                    record.label ||
                    ""
                ),
                260
              );
            })
            .filter(Boolean)
        : [],
      limit
    );
  const splitEventStatements = (value: string, limit: number): string[] =>
    dedupeStrings(
      compactWhitespace(value)
        .split(/(?<=[.!?;])\s+|(?:\s+[-–]\s+)/u)
        .map((item) => clampText(item, 260))
        .filter(Boolean),
      limit
    );
  const normalizeIncidentParticipants = (items: Array<string | Record<string, unknown>> | undefined) =>
    dedupeBy(
      Array.isArray(items)
        ? items
            .map((item) => {
              if (typeof item === "string") {
                const value = clampText(item, 160);
                const normalizedValue = normalizeEntityName(value);
                if (!value || !normalizedValue) return null;
                return {
                  kind: "unknown" as const,
                  value,
                  normalizedValue,
                  role: "participant",
                  entityId: null,
                };
              }

              const kindRaw = String(item.kind || "").trim().toLowerCase();
              const value = clampText(String(item.value || item.name || item.normalizedValue || ""), 160);
              const normalizedValue = normalizeEntityName(String(item.normalizedValue || value || ""));
              if (!value || !normalizedValue) return null;
              return {
                kind: (
                  incidentParticipantKindSet.has(kindRaw) ? kindRaw : "unknown"
                ) as BookExpertCoreIncident["participants"][number]["kind"],
                value,
                normalizedValue,
                role: clampText(String(item.role || "participant"), 120),
                entityId: null,
              };
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        : [],
      (item) => `${item.kind}:${item.normalizedValue}:${item.role}`,
      12
    );

  const plotPoints = (result.plotPoints || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const text = clampText(item, 500);
        if (!text) return null;
        return {
          label: clampText(text, 180),
          summary: text,
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.4, 0.72 - index * 0.05),
          snippet: clampText(text, 280),
        };
      }

      const label = clampText(item.label || item.name || item.summary || "", 180);
      const summary = clampText(item.summary || item.label || item.name || "", 500);
      if (!label || !summary) return null;
      return {
        label,
        summary,
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.72 - index * 0.05)),
        snippet: clampText(item.snippet || summary, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const characters = (result.characters || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          aliases: [],
          roleHint: "Заметный участник событий этого фрагмента",
          traits: [],
          motivations: [],
          arcHint: "Его роль заметна в пределах этого окна книги.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.7 - index * 0.04),
          snippet: name,
        };
      }

      const name = clampText(item.name || "", 160);
      if (!name) return null;
      const roleHint = clampText(item.roleHint || item.role || item.description || "Заметный участник событий этого фрагмента", 240);
      const arcHint = clampText(item.arcHint || item.arc || item.description || roleHint, 320);
      return {
        name,
        aliases: normalizeStringList(item.aliases, 8, 160),
        roleHint,
        traits: normalizeStringList(item.traits, 6, 160),
        motivations: normalizeStringList(item.motivations, 6, 160),
        arcHint,
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.7 - index * 0.04)),
        snippet: clampText(item.snippet || item.description || roleHint, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 16);

  const themes = (result.themes || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          description: name,
          developmentHint: "Тема заметно проявляется в этом фрагменте.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.66 - index * 0.05),
          snippet: name,
        };
      }

      const name = clampText(item.name || item.label || "", 160);
      if (!name) return null;
      const description = clampText(item.description || name, 260);
      return {
        name,
        description,
        developmentHint: clampText(item.developmentHint || description, 320),
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.66 - index * 0.05)),
        snippet: clampText(item.snippet || description, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const locations = (result.locations || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          description: name,
          significanceHint: "Локация заметна в событиях этого фрагмента.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.66 - index * 0.05),
          snippet: name,
        };
      }

      const name = clampText(item.name || item.label || "", 160);
      if (!name) return null;
      const description = clampText(item.description || name, 260);
      return {
        name,
        description,
        significanceHint: clampText(item.significanceHint || description, 320),
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.66 - index * 0.05)),
        snippet: clampText(item.snippet || description, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const quotes = (result.quotes || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const text = clampText(item, 1200);
        if (!text) return null;
        return {
          chapterOrderIndex: window.chapterFrom,
          startChar: null,
          endChar: null,
          text,
          type: "dialogue" as const,
          tags: [],
          commentary: null,
          mentions: [],
          confidence: Math.max(0.45, 0.72 - index * 0.03),
        };
      }

      const text = clampText(item.text || item.quote || "", 1200);
      if (!text) return null;
      const normalizedType = String(item.type || "").trim().toLowerCase();
      const normalizedTags = Array.isArray(item.tags)
        ? item.tags
            .map((tag) => String(tag || "").trim().toLowerCase())
            .filter((tag): tag is (typeof BOOK_EXPERT_CORE_QUOTE_TAGS)[number] => quoteTagSet.has(tag))
        : [];
      const mentions = Array.isArray(item.mentions)
        ? item.mentions
            .map((mention) => {
              if (typeof mention === "string") return null;
              const kind = String(mention.kind || "").trim().toLowerCase();
              const value = clampText(mention.value || mention.name || mention.normalizedValue || "", 160);
              const normalizedValue = normalizeEntityName(mention.normalizedValue || value);
              if (!mentionKindSet.has(kind) || !value || !normalizedValue) return null;
              return {
                kind: kind as (typeof BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS)[number],
                value,
                normalizedValue,
                confidence: clampUnitInterval(mention.confidence, 0.7),
              };
            })
            .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention))
            .slice(0, 16)
        : [];
      return {
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        startChar: coerceNumber(item.startChar),
        endChar: coerceNumber(item.endChar),
        text,
        type: (quoteTypeSet.has(normalizedType) ? normalizedType : "dialogue") as (typeof BOOK_EXPERT_CORE_QUOTE_TYPES)[number],
        tags: dedupeStrings(normalizedTags, 8) as (typeof BOOK_EXPERT_CORE_QUOTE_TAGS)[number][],
        commentary: item.commentary ? clampText(item.commentary, 420) : null,
        mentions,
        confidence: clampUnitInterval(item.confidence, Math.max(0.45, 0.72 - index * 0.03)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 24);

  const incidents = (result.incidents || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const fact = clampText(item, 260);
        if (!fact) return null;
        return {
          title: clampText(fact, 200),
          chapterFrom: window.chapterFrom,
          chapterTo: window.chapterTo,
          importance: Math.max(0.45, 0.74 - index * 0.05),
          participants: [],
          facts: [fact],
          consequences: [],
          supportingQuoteTexts: [],
          snippet: clampText(fact, 280),
        };
      }

      const title = clampText(String(item.title || item.label || item.summary || ""), 200);
      const facts = normalizeIncidentFactList(item.facts, 10);
      const consequences = normalizeIncidentFactList(item.consequences, 8);
      const snippet = clampText(String(item.snippet || facts[0] || item.summary || title || ""), 280);
      if ((!title && facts.length === 0) || !snippet) return null;
      const chapterFrom = clampChapterOrderIndex(item.chapterFrom || item.chapterOrderIndex, window);
      const chapterTo = clampChapterOrderIndex(item.chapterTo || item.chapterOrderIndex || chapterFrom, window);
      return {
        title: title || clampText(facts[0] || snippet, 200),
        chapterFrom: Math.min(chapterFrom, chapterTo),
        chapterTo: Math.max(chapterFrom, chapterTo),
        importance: clampUnitInterval(item.importance, Math.max(0.45, 0.74 - index * 0.05)),
        participants: normalizeIncidentParticipants(item.participants),
        facts: facts.length > 0 ? facts : [clampText(snippet, 260)],
        consequences,
        supportingQuoteTexts: dedupeStrings(
          [...(Array.isArray(item.supportingQuoteTexts) ? item.supportingQuoteTexts : []), ...(Array.isArray(item.quotes) ? item.quotes : [])]
            .map((value) => clampText(String(value || ""), 1200))
            .filter(Boolean),
          8
        ),
        snippet,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const fallbackIncidents =
    incidents.length === 0
      ? plotPoints
          .slice(0, 3)
          .map((plotPoint, index) => {
            const statements = splitEventStatements(plotPoint.summary, 4);
            const facts = statements.slice(0, Math.max(1, Math.min(3, statements.length)));
            const consequences = statements.slice(facts.length);
            const supportingQuoteTexts = quotes
              .filter((quote) => quote.chapterOrderIndex === plotPoint.chapterOrderIndex)
              .slice(0, 2)
              .map((quote) => quote.text);
            return {
              title: clampText(plotPoint.label, 200),
              chapterFrom: plotPoint.chapterOrderIndex,
              chapterTo: plotPoint.chapterOrderIndex,
              importance: clampUnitInterval(plotPoint.importance, Math.max(0.45, 0.68 - index * 0.04)),
              participants: [],
              facts: facts.length > 0 ? facts : [clampText(plotPoint.summary, 260)],
              consequences,
              supportingQuoteTexts: dedupeStrings(supportingQuoteTexts, 8),
              snippet: clampText(plotPoint.snippet || plotPoint.summary, 280),
            };
          })
          .filter((item) => Boolean(item.title && item.snippet))
      : [];

  const summary =
    clampText(
      result.summary ||
        plotPoints[0]?.summary ||
        (window.chapterFrom === window.chapterTo
          ? `Смысловой снимок главы ${window.chapterFrom}.`
          : `Смысловой снимок глав ${window.chapterFrom}-${window.chapterTo}.`),
      900
    ) || `Смысловой снимок глав ${window.chapterFrom}-${window.chapterTo}.`;

  return {
    windowIndex: window.windowIndex,
    chapterFrom: window.chapterFrom,
    chapterTo: window.chapterTo,
    textChars: window.textChars,
    summary,
    plotPoints,
    characters,
    themes,
    locations,
    quotes,
    incidents: incidents.length > 0 ? incidents : fallbackIncidents,
  };
}

type CharacterProfilePatch = z.infer<typeof CharacterProfilePatchSchema>;
type ThemeProfilePatch = z.infer<typeof ThemeProfilePatchSchema>;
type LocationProfilePatch = z.infer<typeof LocationProfilePatchSchema>;
type LiteraryPatternMap = z.infer<typeof LiteraryPatternSchema>;
type LiterarySectionKey = (typeof BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS)[number];

const LITERARY_SECTION_TITLES: Record<(typeof BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS)[number], string> = {
  what_is_really_going_on: "Что на самом деле происходит",
  main_idea: "Главная идея",
  how_it_works: "Как это работает",
  hidden_details: "Скрытые детали",
  characters: "Персонажи",
  conflicts: "Конфликты",
  structure: "Структура",
  important_turns: "Важные повороты",
  takeaways: "Ключевые выводы",
  conclusion: "Вывод",
};

function resolvePatchMatchKey(input: { id?: string; normalizedName?: string; name?: string }): { id: string; normalizedName: string } {
  return {
    id: String(input.id || "").trim(),
    normalizedName: normalizeEntityName(input.normalizedName || input.name || ""),
  };
}

function dedupeAliases(items: string[] | undefined, limit: number): string[] {
  return dedupeStrings(Array.isArray(items) ? items.map((item) => clampText(item, 160)).filter(Boolean) : [], limit);
}

function mergeCharacterProfilePatches(
  items: BookExpertCoreSnapshot["characters"],
  patches: CharacterProfilePatch[]
): BookExpertCoreSnapshot["characters"] {
  const byId = new Map<string, CharacterProfilePatch>();
  const byNormalizedName = new Map<string, CharacterProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    return {
      ...item,
      aliases: patch.aliases ? dedupeAliases(patch.aliases, 12) : item.aliases,
      role: patch.role ? clampText(patch.role, 220) : item.role,
      description: patch.description ? clampText(patch.description, 900) : item.description,
      arc: patch.arc ? clampText(patch.arc, 900) : item.arc,
      motivations: patch.motivations ? dedupeStrings(patch.motivations.map((value) => clampText(value, 220)).filter(Boolean), 6) : item.motivations,
    };
  });
}

function mergeThemeProfilePatches(
  items: BookExpertCoreSnapshot["themes"],
  patches: ThemeProfilePatch[]
): BookExpertCoreSnapshot["themes"] {
  const byId = new Map<string, ThemeProfilePatch>();
  const byNormalizedName = new Map<string, ThemeProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    return {
      ...item,
      aliases: patch.aliases ? dedupeAliases(patch.aliases, 8) : item.aliases,
      description: patch.description ? clampText(patch.description, 900) : item.description,
      development: patch.development ? clampText(patch.development, 900) : item.development,
    };
  });
}

function mergeLocationProfilePatches(
  items: BookExpertCoreSnapshot["locations"],
  patches: LocationProfilePatch[]
): BookExpertCoreSnapshot["locations"] {
  const byId = new Map<string, LocationProfilePatch>();
  const byNormalizedName = new Map<string, LocationProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    return {
      ...item,
      aliases: patch.aliases ? dedupeAliases(patch.aliases, 8) : item.aliases,
      description: patch.description ? clampText(patch.description, 900) : item.description,
      significance: patch.significance ? clampText(patch.significance, 900) : item.significance,
    };
  });
}

function pickEvidenceQuoteIds(snapshot: BookExpertCoreSnapshot, queries: string[], limit: number): string[] {
  const scored = snapshot.quoteBank
    .map((quote) => {
      const corpus = [quote.text, quote.commentary || "", quote.tags.join(" "), quote.mentions.map((item) => item.value).join(" ")].join(" ");
      const score =
        queries.reduce((sum, query) => sum + scoreSnippetRelevance(corpus, query), 0) +
        Math.round(quote.confidence * 10);
      return {
        id: quote.id,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const positive = scored.filter((item) => item.score > 0).slice(0, limit).map((item) => item.id);
  if (positive.length >= limit) return positive;
  return dedupeStrings([...positive, ...snapshot.quoteBank.slice(0, limit).map((item) => item.id)], limit);
}

function buildDeterministicPatternMap(snapshot: BookExpertCoreSnapshot): LiteraryPatternMap {
  const patterns = [
    ...snapshot.incidents.slice(0, 4).map((incident) => ({
      name: incident.title,
      summary: clampText([...incident.facts.slice(0, 2), ...incident.consequences.slice(0, 1)].join(" "), 400),
      evidenceQuoteIds: dedupeStrings(incident.quoteIds, 3),
    })),
    ...snapshot.themes.slice(0, 4).map((theme) => ({
      name: theme.name,
      summary: clampText(theme.development || theme.description, 400),
      evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [theme.name, theme.description, theme.development], 3),
    })),
    ...snapshot.plotSpine.slice(0, 4).map((plotPoint) => ({
      name: plotPoint.label,
      summary: clampText(plotPoint.summary, 400),
      evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [plotPoint.label, plotPoint.summary], 3),
    })),
  ];
  const dedupedPatterns = Array.from(
    patterns.reduce((acc, pattern) => {
      const key = normalizeEntityName(pattern.name);
      if (key && !acc.has(key)) {
        acc.set(key, pattern);
      }
      return acc;
    }, new Map<string, LiteraryPatternMap["patterns"][number]>()).values()
  )
    .filter((item) => item.name && item.summary)
    .slice(0, 8);
  const centralTension = clampText(
    [
      snapshot.incidents[0]?.facts[0] || "",
      snapshot.plotSpine[0]?.summary || "",
      snapshot.plotSpine[1]?.summary || "",
      snapshot.themes[0]?.development || snapshot.themes[0]?.description || "",
    ]
      .filter(Boolean)
      .join(" "),
    500
  ) || DEFAULT_BOOK_BRIEF.fullSummary;
  const interpretiveLens = clampText(
    [
      snapshot.bookBrief.shortSummary,
      snapshot.themes.slice(0, 3).map((item) => item.name).join(", "),
      snapshot.characters[0]?.name ? `Через линию ${snapshot.characters[0].name}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    500
  ) || snapshot.bookBrief.shortSummary;
  return LiteraryPatternSchema.parse({
    patterns: dedupedPatterns.length > 0
      ? dedupedPatterns
      : [
          {
            name: snapshot.plotSpine[0]?.label || "Ключевой сюжетный конфликт",
            summary: snapshot.plotSpine[0]?.summary || snapshot.bookBrief.shortSummary,
            evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [snapshot.bookBrief.shortSummary], 3),
          },
        ],
    centralTension,
    interpretiveLens,
  });
}

function normalizeLiteraryPatternMap(
  snapshot: BookExpertCoreSnapshot,
  result: z.infer<typeof LooseLiteraryPatternSchema>
): LiteraryPatternMap {
  const quoteIdSet = new Set(snapshot.quoteBank.map((quote) => quote.id));
  const normalizedPatterns = (result.patterns || [])
    .map((item) => {
      if (typeof item === "string") {
        const summary = clampText(item, 400);
        if (!summary) return null;
        return {
          name: clampText(item, 180),
          summary,
          evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [summary], 3),
        };
      }
      const name = clampText(item.name || item.title || item.label || item.summary || item.description || "", 180);
      const summary = clampText(item.summary || item.description || name, 400);
      if (!name || !summary) return null;
      const evidenceQuoteIds = dedupeStrings(
        (item.evidenceQuoteIds || []).filter((quoteId) => quoteIdSet.has(quoteId)),
        8
      );
      return {
        name,
        summary,
        evidenceQuoteIds: evidenceQuoteIds.length > 0 ? evidenceQuoteIds : pickEvidenceQuoteIds(snapshot, [name, summary], 3),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (normalizedPatterns.length === 0) {
    return buildDeterministicPatternMap(snapshot);
  }

  const fallback = buildDeterministicPatternMap(snapshot);
  const dedupedPatterns = Array.from(
    [...normalizedPatterns, ...fallback.patterns].reduce((acc, pattern) => {
      const key = normalizeEntityName(pattern.name);
      if (key && !acc.has(key)) {
        acc.set(key, {
          name: clampText(pattern.name, 180),
          summary: clampText(pattern.summary, 400),
          evidenceQuoteIds: dedupeStrings(pattern.evidenceQuoteIds, 8),
        });
      }
      return acc;
    }, new Map<string, LiteraryPatternMap["patterns"][number]>()).values()
  ).slice(0, 8);

  return LiteraryPatternSchema.parse({
    patterns: dedupedPatterns,
    centralTension: clampText(result.centralTension || fallback.centralTension, 500),
    interpretiveLens: clampText(result.interpretiveLens || fallback.interpretiveLens, 500),
  });
}

function resolveLiterarySectionKey(value: string): LiterarySectionKey | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const direct = BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.find((key) => key === normalized);
  if (direct) return direct;
  const collapsed = normalized.replace(/_/g, "");
  return (
    BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.find((key) => key.replace(/_/g, "") === collapsed) ||
    null
  );
}

function buildSectionBodyMarkdown(summary: string, bullets: string[], extra: string[]): string {
  return (
    clampMarkdown(
      [
        clampText(summary, 500),
        ...extra.map((item) => clampText(item, 600)).filter(Boolean),
        bullets.length > 0 ? bullets.map((item) => `- ${clampText(item, 220)}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      6000
    ) || clampText(summary, 500)
  );
}

function buildDeterministicLiterarySections(
  snapshot: BookExpertCoreSnapshot,
  patternMap: LiteraryPatternMap
): NonNullable<BookExpertCoreSnapshot["literarySections"]> {
  const topPatterns = patternMap.patterns.slice(0, 6);
  const topPlot = snapshot.plotSpine.slice(0, 6);
  const topIncidents = snapshot.incidents.slice(0, 4);
  const topThemes = snapshot.themes.slice(0, 4);
  const topCharacters = snapshot.characters.slice(0, 4);
  const bulletsByKey: Record<LiterarySectionKey, string[]> = {
    what_is_really_going_on: dedupeStrings([patternMap.centralTension, ...topIncidents.map((item) => item.title), ...topPatterns.map((item) => item.name)], 5),
    main_idea: dedupeStrings(topThemes.map((item) => `${item.name}: ${item.description}`), 5),
    how_it_works: dedupeStrings([...topIncidents.map((item) => `${item.title}: ${item.facts[0] || ""}`), ...topPlot.map((item) => `${item.label}: ${item.summary}`)], 5),
    hidden_details: dedupeStrings(snapshot.quoteBank.slice(0, 4).map((item) => item.commentary || item.text), 4),
    characters: dedupeStrings(topCharacters.map((item) => `${item.name}: ${item.arc}`), 5),
    conflicts: dedupeStrings([patternMap.centralTension, ...topCharacters.map((item) => `${item.name}: ${item.role}`)], 5),
    structure: dedupeStrings(topPlot.map((item) => `Глава ${item.chapterOrderIndex}: ${item.label}`), 5),
    important_turns: dedupeStrings([...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.summary)], 5),
    takeaways: dedupeStrings(topThemes.map((item) => item.development || item.description), 5),
    conclusion: dedupeStrings([snapshot.bookBrief.shortSummary, patternMap.interpretiveLens], 4),
  };
  const summaryByKey: Record<LiterarySectionKey, string> = {
    what_is_really_going_on: clampText(patternMap.centralTension, 500),
    main_idea: clampText([snapshot.bookBrief.shortSummary, topThemes.map((item) => item.name).join(", ")].filter(Boolean).join(" "), 500),
    how_it_works: clampText([...topIncidents.slice(0, 2).map((item) => item.facts[0] || item.title), ...topPlot.slice(0, 3).map((item) => item.summary)].join(" "), 500),
    hidden_details: clampText(topPatterns.map((item) => item.summary).join(" "), 500),
    characters: clampText(topCharacters.map((item) => `${item.name}: ${item.arc}`).join(" "), 500),
    conflicts: clampText([patternMap.centralTension, ...topThemes.map((item) => item.name)].join(" "), 500),
    structure: clampText(topPlot.map((item) => `${item.chapterOrderIndex}. ${item.label}`).join(" "), 500),
    important_turns: clampText([...topIncidents.slice(0, 2).map((item) => item.title), ...topPlot.slice(0, 4).map((item) => item.summary)].join(" "), 500),
    takeaways: clampText(topThemes.map((item) => item.development || item.description).join(" "), 500),
    conclusion: clampText([snapshot.bookBrief.fullSummary, patternMap.interpretiveLens].join(" "), 500),
  };
  const evidenceQueriesByKey: Record<LiterarySectionKey, string[]> = {
    what_is_really_going_on: [patternMap.centralTension, ...topIncidents.map((item) => item.title), ...topPatterns.map((item) => item.name)],
    main_idea: [...topThemes.map((item) => item.name), snapshot.bookBrief.shortSummary],
    how_it_works: [...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.label)],
    hidden_details: topPatterns.map((item) => item.summary),
    characters: topCharacters.map((item) => item.name),
    conflicts: [patternMap.centralTension, ...topCharacters.map((item) => item.name)],
    structure: topPlot.map((item) => item.label),
    important_turns: [...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.summary)],
    takeaways: topThemes.map((item) => item.name),
    conclusion: [snapshot.bookBrief.fullSummary, patternMap.interpretiveLens],
  };
  const sections = Object.fromEntries(
    BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.map((key) => {
      const evidenceQuoteIds = pickEvidenceQuoteIds(snapshot, evidenceQueriesByKey[key], 4);
      const summary = summaryByKey[key] || snapshot.bookBrief.shortSummary;
      return [
        key,
        {
          key,
          title: LITERARY_SECTION_TITLES[key],
          summary,
          bodyMarkdown: buildSectionBodyMarkdown(summary, bulletsByKey[key], [
            patternMap.interpretiveLens,
            topPatterns.map((item) => item.summary).slice(0, 2).join(" "),
          ]),
          bullets: bulletsByKey[key].slice(0, 5),
          evidenceQuoteIds,
          confidence: 0.58,
        },
      ];
    })
  ) as NonNullable<BookExpertCoreSnapshot["literarySections"]>;
  return sections;
}

function normalizeLiterarySections(
  snapshot: BookExpertCoreSnapshot,
  patternMap: LiteraryPatternMap,
  result: z.infer<typeof LooseLiterarySectionsResultSchema>
): NonNullable<BookExpertCoreSnapshot["literarySections"]> {
  const fallbackSections = buildDeterministicLiterarySections(snapshot, patternMap);
  const sectionPatches = result.sections;
  const entries: Array<readonly [string, z.infer<typeof LooseLiterarySectionPatchSchema>]> = Array.isArray(sectionPatches)
    ? sectionPatches.map((item) => [String(item.key || item.title || ""), item] as const)
    : (Object.entries(sectionPatches) as Array<readonly [string, z.infer<typeof LooseLiterarySectionPatchSchema>]>);
  const quoteIdSet = new Set(snapshot.quoteBank.map((quote) => quote.id));
  for (const [rawKey, patch] of entries) {
    const key = resolveLiterarySectionKey(String(patch.key || rawKey || patch.title || ""));
    if (!key) continue;
    const currentSection = fallbackSections[key];
    if (!currentSection) continue;
    fallbackSections[key] = {
      ...currentSection,
      key,
      title: patch.title ? clampText(patch.title, 160) : currentSection.title,
      summary: patch.summary ? clampText(patch.summary, 500) : currentSection.summary,
      bodyMarkdown: patch.bodyMarkdown ? clampMarkdown(patch.bodyMarkdown, 6000) : currentSection.bodyMarkdown,
      bullets: patch.bullets ? dedupeStrings(patch.bullets.map((item) => clampText(item, 240)).filter(Boolean), 8) : currentSection.bullets,
      evidenceQuoteIds: patch.evidenceQuoteIds
        ? dedupeStrings(patch.evidenceQuoteIds.filter((quoteId) => quoteIdSet.has(quoteId)), 10)
        : currentSection.evidenceQuoteIds,
      confidence: clampUnitInterval(patch.confidence, currentSection.confidence),
    };
  }
  return LiterarySectionsResultSchema.parse({
    sections: fallbackSections,
  }).sections;
}

function buildSnapshotWithStage(params: {
  bookId: string;
  previous: BookExpertCoreSnapshot | null;
  stage: BookExpertCoreStageKey;
  durationMs: number;
  patch: Partial<BookExpertCoreSnapshot>;
}): BookExpertCoreSnapshot {
  const base = params.previous || createEmptySnapshot(params.bookId);
  return BookExpertCoreSnapshotSchema.parse({
    ...base,
    version: BOOK_EXPERT_CORE_VERSION,
    ...params.patch,
    completedStages: mergeCompletedStages(base.completedStages, params.stage),
    timingsMs: {
      ...base.timingsMs,
      [params.stage]: Math.max(0, Math.floor(params.durationMs)),
    },
    generatedAt: new Date().toISOString(),
  });
}

function findQuoteOffsets(chapters: ChapterSource[], chapterOrderIndex: number, text: string): { startChar: number; endChar: number } {
  const chapter = chapters.find((item) => item.orderIndex === chapterOrderIndex);
  if (!chapter) {
    return { startChar: 0, endChar: Math.max(1, text.length) };
  }

  const exact = chapter.rawText.indexOf(text);
  if (exact >= 0) {
    return {
      startChar: exact,
      endChar: exact + text.length,
    };
  }

  const normalizedNeedle = normalizeEntityName(text);
  const normalizedChapter = normalizeEntityName(chapter.rawText);
  const normalizedIndex = normalizedChapter.indexOf(normalizedNeedle);
  if (normalizedIndex >= 0) {
    return {
      startChar: normalizedIndex,
      endChar: normalizedIndex + text.length,
    };
  }

  return { startChar: 0, endChar: Math.max(1, text.length) };
}

async function persistProfiles(bookId: string, snapshot: BookExpertCoreSnapshot): Promise<void> {
  await prisma.$transaction(async (tx: any) => {
    await tx.book.update({
      where: { id: bookId },
      data: {
        summary: snapshot.bookBrief.shortSummary,
      },
    });

    await tx.bookCharacter.deleteMany({ where: { bookId } });
    await tx.bookTheme.deleteMany({ where: { bookId } });
    await tx.bookLocation.deleteMany({ where: { bookId } });

    if (snapshot.characters.length > 0) {
      await tx.bookCharacter.createMany({
        data: snapshot.characters.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          role: item.role,
          description: item.description,
          arc: item.arc,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }

    if (snapshot.themes.length > 0) {
      await tx.bookTheme.createMany({
        data: snapshot.themes.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: item.description,
          development: item.development,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }

    if (snapshot.locations.length > 0) {
      await tx.bookLocation.createMany({
        data: snapshot.locations.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: item.description,
          significance: item.significance,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }
  });
}

async function persistQuotes(bookId: string, snapshot: BookExpertCoreSnapshot, chapters: ChapterSource[]): Promise<void> {
  const characterIds = new Map(snapshot.characters.map((item) => [item.normalizedName, item.id] as const));
  const themeIds = new Map(snapshot.themes.map((item) => [item.normalizedName, item.id] as const));
  const locationIds = new Map(snapshot.locations.map((item) => [item.normalizedName, item.id] as const));

  await prisma.$transaction(async (tx: any) => {
    await tx.bookCharacterQuote.deleteMany({
      where: {
        character: {
          bookId,
        },
      },
    });
    await tx.bookThemeQuote.deleteMany({
      where: {
        theme: {
          bookId,
        },
      },
    });
    await tx.bookLocationQuote.deleteMany({
      where: {
        location: {
          bookId,
        },
      },
    });
    await tx.bookQuoteTagLink.deleteMany({
      where: {
        quote: {
          bookId,
        },
      },
    });
    await tx.bookQuoteMention.deleteMany({
      where: {
        quote: {
          bookId,
        },
      },
    });
    await tx.bookQuote.deleteMany({ where: { bookId } });

    if (snapshot.quoteBank.length > 0) {
      await tx.bookQuote.createMany({
        data: snapshot.quoteBank.map((quote) => {
          const offsets = findQuoteOffsets(chapters, quote.chapterOrderIndex, quote.text);
          return {
            id: quote.id,
            bookId,
            chapterOrderIndex: quote.chapterOrderIndex,
            startChar: offsets.startChar,
            endChar: offsets.endChar,
            text: quote.text,
            type: quote.type,
            confidence: quote.confidence,
            commentary: quote.commentary,
          };
        }),
      });

      const tagRows = snapshot.quoteBank.flatMap((quote) =>
        quote.tags.map((tag) => ({
          quoteId: quote.id,
          tag,
        }))
      );
      if (tagRows.length > 0) {
        await tx.bookQuoteTagLink.createMany({ data: tagRows });
      }

      const mentionRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions.map((mention, index) => ({
          id: hashId("mention", [quote.id, mention.kind, mention.normalizedValue, index]),
          quoteId: quote.id,
          kind: mention.kind,
          value: mention.value,
          normalizedValue: mention.normalizedValue,
          startChar: 0,
          endChar: Math.max(1, mention.value.length),
          confidence: mention.confidence,
        }))
      );
      if (mentionRows.length > 0) {
        await tx.bookQuoteMention.createMany({ data: mentionRows });
      }

      const characterQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "character")
          .map((mention, index) => {
            const characterId = characterIds.get(mention.normalizedValue);
            if (!characterId) return null;
            return {
              id: hashId("character_quote", [quote.id, characterId, index]),
              bookCharacterId: characterId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (characterQuoteRows.length > 0) {
        await tx.bookCharacterQuote.createMany({ data: characterQuoteRows });
      }

      const themeQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "theme")
          .map((mention, index) => {
            const themeId = themeIds.get(mention.normalizedValue);
            if (!themeId) return null;
            return {
              id: hashId("theme_quote", [quote.id, themeId, index]),
              bookThemeId: themeId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (themeQuoteRows.length > 0) {
        await tx.bookThemeQuote.createMany({ data: themeQuoteRows });
      }

      const locationQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "location")
          .map((mention, index) => {
            const locationId = locationIds.get(mention.normalizedValue);
            if (!locationId) return null;
            return {
              id: hashId("location_quote", [quote.id, locationId, index]),
              bookLocationId: locationId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (locationQuoteRows.length > 0) {
        await tx.bookLocationQuote.createMany({ data: locationQuoteRows });
      }
    }
  });
}

async function runStage(params: {
  analyzerType: CoreAnalyzerType;
  bookId: string;
  handler: (ctx: {
    book: LoadedBookSource;
    chapters: ChapterSource[];
    snapshot: BookExpertCoreSnapshot | null;
    startedAt: Date;
  }) => Promise<{ snapshot: BookExpertCoreSnapshot; nextStage?: CoreAnalyzerType | null }>;
}) {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    throw new Error(`Invalid ${params.analyzerType} payload: bookId is required`);
  }

  const lockKey = `book-analyzer:${params.analyzerType}:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const snapshotBefore = await readSnapshot(bookId);
    const dependency = CORE_STAGE_DEPENDENCIES[params.analyzerType];
    if (dependency) {
      const dependencyTask = await prisma.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: dependency as any,
          },
        },
        select: { state: true },
      });
      if (dependencyTask?.state !== "completed") {
        logger.info(
          {
            bookId,
            analyzerType: params.analyzerType,
            dependency,
            dependencyState: dependencyTask?.state || "missing",
            completedStages: snapshotBefore?.completedStages || [],
          },
          "Book expert core stage deferred until dependency task completes"
        );
        return;
      }
    }
    if (snapshotBefore?.completedStages.includes(params.analyzerType)) {
      const task = await prisma.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: params.analyzerType as any,
          },
        },
        select: { state: true },
      });
      if (task?.state === "completed") {
        return;
      }
    }

    const startedAt = new Date();
    await prisma.$transaction(async (tx: any) => {
      await tx.book.updateMany({
        where: { id: bookId },
        data: {
          analysisState: "running",
          analysisError: null,
          analysisStartedAt: startedAt,
          analysisCompletedAt: null,
        },
      });
      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: params.analyzerType,
          },
        },
        create: {
          bookId,
          analyzerType: params.analyzerType,
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
    });

    const { book, chapters } = await loadBookSource(bookId);
    const result = await params.handler({
      book,
      chapters,
      snapshot: snapshotBefore,
      startedAt,
    });

    await saveSnapshot(bookId, result.snapshot);
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "completed",
      error: null,
      startedAt,
      completedAt: new Date(),
    });

    if (params.analyzerType === "core_literary") {
      await prisma.book.update({
        where: { id: bookId },
        data: {
          analysisState: "completed",
          analysisError: null,
          analysisCompletedAt: new Date(),
        },
      });
      logger.info(
        {
          bookId,
          upload_to_expert_ms: Math.max(0, Date.now() - book.createdAt.getTime()),
          timingsMs: result.snapshot.timingsMs,
          completedStages: result.snapshot.completedStages,
        },
        "Book expert core completed"
      );
    } else {
      logger.info(
        {
          bookId,
          analyzerType: params.analyzerType,
          upload_to_fast_ms:
            params.analyzerType === "core_window_scan" ? Math.max(0, Date.now() - book.createdAt.getTime()) : null,
          window_count: result.snapshot.windowScans.length || null,
          timingsMs: result.snapshot.timingsMs,
          completedStages: result.snapshot.completedStages,
        },
        "Book expert core stage completed"
      );
    }

    if (result.nextStage) {
      await queueNextStage(bookId, result.nextStage);
    }

    if (params.analyzerType === "core_merge") {
      await enqueueBookAnalyzerStage({
        bookId,
        analyzerType: "event_relation_graph",
        publishEvent: true,
      });
    }

    if (params.analyzerType === "core_quotes_finalize") {
      await enqueueBookAnalyzerStage({
        bookId,
        analyzerType: "quote_store",
        publishEvent: true,
      });
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "failed",
      error: message,
      completedAt: new Date(),
    });
    await prisma.book.updateMany({
      where: { id: bookId },
      data: {
        analysisState: "failed",
        analysisError: message,
        analysisCompletedAt: new Date(),
      },
    });
    throw error;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}

export async function processBookCoreWindowScan(payload: StagePayload) {
  await runStage({
    analyzerType: "core_window_scan",
    bookId: payload.bookId,
    handler: async ({ book, chapters, snapshot, startedAt }) => {
      const windows = chunkChaptersIntoWindows(chapters);
      if (windows.length === 0) {
        throw new Error("Book has no non-empty chapters for semantic core window scan");
      }

      const scans = await mapWithConcurrency(windows, WINDOW_SCAN_CONCURRENCY, async (window) => {
        const call = await callStrictJson({
          phase: "book_core_window_scan",
          prompt: buildWindowScanPrompt(book, window),
          schema: WindowScanModelOutputSchema,
          allowedModels: [workerConfig.vertex.modelByTier.lite],
          disableGlobalFallback: true,
          maxAttempts: 2,
          vertexModel: workerConfig.vertex.modelByTier.lite,
          vertexThinkingLevel: "MINIMAL",
          maxTokens: 3200,
        });
        logger.info(
          {
            bookId: book.id,
            analyzerType: "core_window_scan",
            windowIndex: window.windowIndex,
            chapterFrom: window.chapterFrom,
            chapterTo: window.chapterTo,
            provider: call.meta.provider,
            model: call.meta.model,
            latencyMs: call.meta.latencyMs,
            promptTokens: call.meta.usage?.promptTokens ?? null,
            completionTokens: call.meta.usage?.completionTokens ?? null,
          },
          "Book expert core window scanned"
        );
        return normalizeWindowScan(window, call.result);
      });

      const merged = mergeWindowScans(book.id, scans);
      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: snapshot,
        stage: "core_window_scan",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          windowScans: scans,
          ...merged,
        },
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_merge",
      };
    },
  });
}

export async function processBookCoreMerge(payload: StagePayload) {
  await runStage({
    analyzerType: "core_merge",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current || current.windowScans.length === 0) {
        throw new Error("core_merge requires completed window scans");
      }

      const merged = mergeWindowScans(book.id, current.windowScans);
      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_merge",
        durationMs: Date.now() - startedAt.getTime(),
        patch: merged,
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_profiles",
      };
    },
  });
}

export async function processBookCoreProfiles(payload: StagePayload) {
  await runStage({
    analyzerType: "core_profiles",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_profiles requires semantic core snapshot");
      }

      const refineProfiles = async <TPatch extends { id?: string; normalizedName?: string; name?: string }, TItem>(params: {
        kind: "characters" | "themes" | "locations";
        items: TItem[];
        schema: z.ZodType<{ items: TPatch[] }, z.ZodTypeDef, unknown>;
        merge: (items: TItem[], patches: TPatch[]) => TItem[];
        maxTokens: number;
      }): Promise<TItem[]> => {
        if (params.items.length === 0) return [];
        try {
          const result = await callStrictJson({
            phase: "book_core_profiles",
            prompt: buildProfilesPrompt({
              kind: params.kind,
              book,
              bookBrief: current.bookBrief,
              plotSpine: current.plotSpine,
              items: params.items,
            }),
            schema: params.schema,
            allowedModels: [workerConfig.vertex.modelByTier.lite],
            disableGlobalFallback: true,
            maxAttempts: 1,
            vertexModel: workerConfig.vertex.modelByTier.lite,
            vertexThinkingLevel: null,
            maxTokens: params.maxTokens,
          });
          logger.info(
            {
              bookId: book.id,
              analyzerType: "core_profiles",
              kind: params.kind,
              selected_model: result.meta.model,
              llm_attempt_count: result.meta.attempt,
              fallback_used: false,
              latencyMs: result.meta.latencyMs,
            },
            "Book expert core profiles refined"
          );
          return params.merge(params.items, result.result.items);
        } catch (error) {
          logger.warn(
            {
              bookId: book.id,
              analyzerType: "core_profiles",
              kind: params.kind,
              error: safeErrorMessage(error),
              fallback_used: true,
            },
            "Book expert core profiles refinement failed, falling back to merged semantic cards"
          );
          return params.items;
        }
      };

      const [charactersItems, themesItems, locationsItems] = await Promise.all([
        refineProfiles({
          kind: "characters",
          items: current.characters,
          schema: CharacterBatchSchema,
          merge: mergeCharacterProfilePatches,
          maxTokens: 2600,
        }),
        refineProfiles({
          kind: "themes",
          items: current.themes,
          schema: ThemeBatchSchema,
          merge: mergeThemeProfilePatches,
          maxTokens: 2200,
        }),
        refineProfiles({
          kind: "locations",
          items: current.locations,
          schema: LocationBatchSchema,
          merge: mergeLocationProfilePatches,
          maxTokens: 2200,
        }),
      ]);

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_profiles",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          characters: charactersItems,
          themes: themesItems,
          locations: locationsItems,
        },
      });

      await persistProfiles(book.id, nextSnapshot);

      return {
        snapshot: nextSnapshot,
        nextStage: "core_quotes_finalize",
      };
    },
  });
}

export async function processBookCoreQuotesFinalize(payload: StagePayload) {
  await runStage({
    analyzerType: "core_quotes_finalize",
    bookId: payload.bookId,
    handler: async ({ book, chapters, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_quotes_finalize requires semantic core snapshot");
      }

      await persistProfiles(book.id, current);
      await persistQuotes(book.id, current, chapters);

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_quotes_finalize",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {},
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_literary",
      };
    },
  });
}

export async function processBookCoreLiterary(payload: StagePayload) {
  await runStage({
    analyzerType: "core_literary",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_literary requires semantic core snapshot");
      }
      if (current.quoteBank.length === 0) {
        throw new Error("core_literary requires quote bank");
      }

      let patternMap: LiteraryPatternMap;
      let patternFallbackUsed = false;
      try {
        const patternMapCall = await callStrictJson({
          phase: "book_core_literary_pattern",
          prompt: buildLiteraryPatternPrompt(current),
          schema: LooseLiteraryPatternSchema,
          allowedModels: [workerConfig.vertex.modelByTier.lite],
          disableGlobalFallback: true,
          maxAttempts: 1,
          vertexModel: workerConfig.vertex.modelByTier.lite,
          vertexThinkingLevel: null,
          maxTokens: 2200,
        });
        patternMap = normalizeLiteraryPatternMap(current, patternMapCall.result);
        logger.info(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "pattern",
            selected_model: patternMapCall.meta.model,
            llm_attempt_count: patternMapCall.meta.attempt,
            fallback_used: false,
            latencyMs: patternMapCall.meta.latencyMs,
          },
          "Book expert core literary pattern map built"
        );
      } catch (error) {
        patternFallbackUsed = true;
        logger.warn(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "pattern",
            error: safeErrorMessage(error),
            fallback_used: true,
          },
          "Book expert core literary pattern map failed, using deterministic fallback"
        );
        patternMap = buildDeterministicPatternMap(current);
      }

      let literarySections: NonNullable<BookExpertCoreSnapshot["literarySections"]>;
      let sectionsFallbackUsed = false;
      try {
        const sectionsCall = await callStrictJson({
          phase: "book_core_literary_synthesis",
          prompt: buildLiterarySectionsPrompt(current, patternMap),
          schema: LooseLiterarySectionsResultSchema,
          allowedModels: [workerConfig.vertex.modelByTier.lite],
          disableGlobalFallback: true,
          maxAttempts: 1,
          vertexModel: workerConfig.vertex.modelByTier.lite,
          vertexThinkingLevel: null,
          maxTokens: workerConfig.vertex.literaryMaxTokens,
        });
        literarySections = normalizeLiterarySections(current, patternMap, sectionsCall.result);
        logger.info(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "sections",
            selected_model: sectionsCall.meta.model,
            llm_attempt_count: sectionsCall.meta.attempt,
            fallback_used: false,
            latencyMs: sectionsCall.meta.latencyMs,
            pattern_fallback_used: patternFallbackUsed,
          },
          "Book expert core literary sections built"
        );
      } catch (error) {
        sectionsFallbackUsed = true;
        logger.warn(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "sections",
            error: safeErrorMessage(error),
            fallback_used: true,
            pattern_fallback_used: patternFallbackUsed,
          },
          "Book expert core literary sections failed, using deterministic fallback"
        );
        literarySections = buildDeterministicLiterarySections(current, patternMap);
      }

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_literary",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          literarySections,
        },
      });

      await prisma.bookLiteraryAnalysis.upsert({
        where: { bookId: book.id },
        create: {
          bookId: book.id,
          sectionsJson: literarySections,
        },
        update: {
          sectionsJson: literarySections,
        },
      });

      return {
        snapshot: nextSnapshot,
        nextStage: null,
      };
    },
  });
}
