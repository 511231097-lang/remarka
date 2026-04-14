import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { LocalBlobStore, S3BlobStore, enqueueBookAnalyzerStage, type BlobStore, prisma } from "@remarka/db";
import {
  BookExpertCoreSnapshotSchema,
  BOOK_CHAT_GRAPH_STAGE_KEYS,
  canonicalizeDocumentContent,
  buildPlainTextFromParsedChapter,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  normalizeEntityName,
  parseBook,
  type BookChatGraphStageKey,
  type BookExpertCoreSnapshot,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import { processBookChatIndex } from "./processBookChatIndex";
import { logger } from "../logger";
import { workerConfig } from "../config";

type GraphAnalyzerType = BookChatGraphStageKey;

interface StagePayload {
  bookId: string;
}

interface LoadedBookSource {
  id: string;
  title: string;
  author: string | null;
  fileName: string;
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
  summary: string | null;
}

interface ChapterSource {
  id: string;
  orderIndex: number;
  title: string;
  rawText: string;
  summary: string | null;
}

interface ParagraphDraft {
  id: string;
  bookId: string;
  chapterId: string;
  orderIndex: number;
  orderInChapter: number;
  startChar: number;
  endChar: number;
  text: string;
}

interface SentenceDraft {
  id: string;
  bookId: string;
  chapterId: string;
  paragraphId: string;
  orderIndex: number;
  orderInChapter: number;
  orderInScene: number;
  startChar: number;
  endChar: number;
  text: string;
}

interface SceneDraft {
  id: string;
  bookId: string;
  chapterId: string;
  orderIndex: number;
  title: string;
  summary: string;
  startParagraphOrder: number;
  endParagraphOrder: number;
  startChar: number;
  endChar: number;
  text: string;
  metadataJson: Record<string, unknown>;
}

interface EntitySourceRecord {
  id: string;
  type: "character" | "location" | "theme" | "group" | "object" | "concept" | "motif";
  name: string;
  normalizedName: string;
  summary: string;
  aliases: string[];
  role?: string | null;
  arc?: string | null;
  development?: string | null;
  significance?: string | null;
}

interface EventSourceRecord {
  id: string;
  chapterOrderIndex: number;
  title: string;
  summary: string;
  importance: number;
  sceneId: string | null;
  quoteIds: string[];
  participants: Array<{
    entityId: string | null;
    normalizedName: string;
    displayName: string;
    role: string;
  }>;
}

interface LoadedGraphPrereqs {
  book: LoadedBookSource;
  chapters: ChapterSource[];
  expertCore: BookExpertCoreSnapshot | null;
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampText(value: string, maxChars: number): string {
  const text = compactWhitespace(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function countPattern(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

function isLikelyForeignToRussian(primary: string, fallback: string): boolean {
  const left = compactWhitespace(primary);
  const right = compactWhitespace(fallback);
  if (!left || !right) return false;
  const leftLatin = countPattern(left, /[A-Za-z]/g);
  const leftCyrillic = countPattern(left, /[А-Яа-яЁё]/g);
  const rightLatin = countPattern(right, /[A-Za-z]/g);
  const rightCyrillic = countPattern(right, /[А-Яа-яЁё]/g);
  return leftLatin >= 8 && leftLatin > leftCyrillic * 2 && rightCyrillic > rightLatin;
}

function preferLocalizedText(primary: string | null | undefined, fallback: string | null | undefined): string {
  const preferred = compactWhitespace(primary || "");
  const alternate = compactWhitespace(fallback || "");
  if (!preferred) return alternate;
  if (!alternate) return preferred;
  return isLikelyForeignToRussian(preferred, alternate) ? alternate : preferred;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error || "Book graph stage failed").slice(0, 2000);
}

function hashId(prefix: string, parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha1")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function resolveUploadFormat(fileName: string): BookFormat | null {
  const detected = detectBookFormatFromFileName(fileName);
  if (detected) return detected;
  if (String(fileName || "").toLowerCase().endsWith(".zip")) return "fb2_zip";
  return null;
}

function resolveChapterTitle(chapter: ParsedChapter, orderIndex: number): string {
  const title = compactWhitespace(String(chapter.title || ""));
  return title || `Глава ${orderIndex}`;
}

function resolveBooksBlobStore(storageProviderRaw: string): BlobStore {
  const storageProvider = String(storageProviderRaw || "").trim().toLowerCase();
  if (storageProvider === "s3") {
    return new S3BlobStore({
      bucket: workerConfig.books.s3.bucket,
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

async function loadBookSource(bookId: string): Promise<LoadedGraphPrereqs> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      summary: true,
      fileName: true,
      storageProvider: true,
      storageKey: true,
      createdAt: true,
      expertCore: {
        select: {
          snapshotJson: true,
        },
      },
      chapters: {
        select: {
          id: true,
          orderIndex: true,
          title: true,
          rawText: true,
          summary: true,
        },
        orderBy: [{ orderIndex: "asc" }],
      },
    },
  });

  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  let chapters = book.chapters.map((chapter) => ({
    id: chapter.id,
    orderIndex: chapter.orderIndex,
    title: chapter.title,
    rawText: chapter.rawText || "",
    summary: chapter.summary,
  }));

  if (chapters.every((chapter) => !compactWhitespace(chapter.rawText))) {
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

    chapters = parsedBook.chapters.map((chapter, index) => ({
      id: book.chapters[index]?.id || hashId("book_chapter", [book.id, index + 1]),
      orderIndex: index + 1,
      title: resolveChapterTitle(chapter, index + 1),
      rawText: buildPlainTextFromParsedChapter(chapter),
      summary: book.chapters[index]?.summary || null,
    }));
  }

  const expertCore = book.expertCore
    ? BookExpertCoreSnapshotSchema.safeParse(book.expertCore.snapshotJson)
    : null;

  return {
    book: {
      id: book.id,
      title: book.title,
      author: book.author || null,
      fileName: book.fileName,
      storageProvider: book.storageProvider,
      storageKey: book.storageKey,
      createdAt: book.createdAt,
      summary: book.summary || null,
    },
    chapters,
    expertCore: expertCore?.success ? expertCore.data : null,
  };
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

async function queueNextStages(bookId: string, analyzerTypes: GraphAnalyzerType[]) {
  for (const analyzerType of analyzerTypes) {
    await enqueueBookAnalyzerStage({
      bookId,
      analyzerType,
      publishEvent: true,
    });
  }
}

const GRAPH_STAGE_DEPENDENCIES: Partial<Record<GraphAnalyzerType, string[]>> = {
  scene_build: ["canonical_text"],
  entity_graph: ["scene_build"],
  event_relation_graph: ["entity_graph", "core_merge"],
  summary_store: ["scene_build"],
  evidence_store: ["event_relation_graph", "summary_store", "quote_store"],
  text_index: ["scene_build"],
  quote_store: ["core_quotes_finalize"],
};

const GRAPH_STAGE_DEPENDENTS = Object.entries(GRAPH_STAGE_DEPENDENCIES).reduce<Partial<Record<string, GraphAnalyzerType[]>>>(
  (acc, [stage, dependencies]) => {
    for (const dependency of dependencies || []) {
      const existing = acc[dependency] || [];
      if (!existing.includes(stage as GraphAnalyzerType)) {
        acc[dependency] = [...existing, stage as GraphAnalyzerType];
      }
    }
    return acc;
  },
  {}
);

async function wakeDependentStages(bookId: string, completedStage: string) {
  const dependents = GRAPH_STAGE_DEPENDENTS[completedStage] || [];
  if (dependents.length === 0) return;
  await queueNextStages(bookId, dependents);
}

async function dependenciesSatisfied(bookId: string, analyzerType: GraphAnalyzerType): Promise<boolean> {
  const required = GRAPH_STAGE_DEPENDENCIES[analyzerType] || [];
  if (required.length === 0) return true;
  const tasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      bookId,
      analyzerType: { in: required as any },
    },
    select: {
      analyzerType: true,
      state: true,
    },
  });
  const byType = new Map(tasks.map((task) => [task.analyzerType, task.state] as const));
  return required.every((dependency) => byType.get(dependency as any) === "completed");
}

type StageHandlerResult = {
  nextStages?: GraphAnalyzerType[];
};

async function runGraphStage(params: {
  analyzerType: GraphAnalyzerType;
  bookId: string;
  handler: (ctx: LoadedGraphPrereqs) => Promise<StageHandlerResult | void>;
}) {
  const bookId = compactWhitespace(params.bookId);
  if (!bookId) {
    throw new Error(`Invalid ${params.analyzerType} payload: bookId is required`);
  }

  const lockKey = `book-analyzer:${params.analyzerType}:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  if (!lockRows?.[0]?.locked) return;

  try {
    if (!(await dependenciesSatisfied(bookId, params.analyzerType))) {
      logger.info({ bookId, analyzerType: params.analyzerType }, "Book graph stage deferred until dependencies complete");
      return;
    }

    const startedAt = new Date();
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "running",
      startedAt,
      completedAt: null,
      error: null,
    });

    const prereqs = await loadBookSource(bookId);
    const result = (await params.handler(prereqs)) || {};

    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "completed",
      startedAt,
      completedAt: new Date(),
      error: null,
    });

    await wakeDependentStages(bookId, params.analyzerType);

    if (result.nextStages?.length) {
      await queueNextStages(bookId, result.nextStages);
    }
  } catch (error) {
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "failed",
      completedAt: new Date(),
      error: safeErrorMessage(error),
    });
    throw error;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}

function splitParagraphs(text: string): Array<{ startChar: number; endChar: number; text: string }> {
  const normalized = canonicalizeDocumentContent(text);
  const out: Array<{ startChar: number; endChar: number; text: string }> = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    while (cursor < normalized.length && /\n/.test(normalized[cursor])) cursor += 1;
    if (cursor >= normalized.length) break;
    const start = cursor;
    while (cursor < normalized.length) {
      const isBoundary =
        normalized[cursor] === "\n" &&
        normalized[cursor + 1] === "\n";
      if (isBoundary) break;
      cursor += 1;
    }
    const end = cursor;
    const value = compactWhitespace(normalized.slice(start, end));
    if (value) {
      out.push({
        startChar: start,
        endChar: end,
        text: value,
      });
    }
    while (cursor < normalized.length && /\n/.test(normalized[cursor])) cursor += 1;
  }
  return out;
}

function splitSentences(text: string): Array<{ startChar: number; endChar: number; text: string }> {
  const value = compactWhitespace(text);
  if (!value) return [];
  const out: Array<{ startChar: number; endChar: number; text: string }> = [];
  const regex = /[^.!?…]+[.!?…]*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const sentence = compactWhitespace(match[0]);
    if (!sentence) continue;
    out.push({
      startChar: match.index,
      endChar: match.index + match[0].length,
      text: sentence,
    });
  }
  if (out.length === 0) {
    out.push({ startChar: 0, endChar: value.length, text: value });
  }
  return out;
}

function summarizeSceneText(text: string): string {
  const sentences = splitSentences(text).map((item) => item.text);
  return clampText(sentences.slice(0, 2).join(" "), 360);
}

function buildScenesForChapter(params: {
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  paragraphs: ParagraphDraft[];
  sceneOrderStart: number;
}): SceneDraft[] {
  const out: SceneDraft[] = [];
  let cursor = 0;
  let sceneOrder = params.sceneOrderStart;
  while (cursor < params.paragraphs.length) {
    const group: ParagraphDraft[] = [];
    let charBudget = 0;
    while (cursor < params.paragraphs.length) {
      const next = params.paragraphs[cursor];
      const nextChars = next.text.length;
      const startsDialogue = /^\p{Pd}|\s*—/u.test(next.text);
      if (group.length >= 4 && (charBudget >= 2200 || startsDialogue)) break;
      if (group.length >= 6 || charBudget >= 3200) break;
      group.push(next);
      charBudget += nextChars;
      cursor += 1;
    }
    if (group.length === 0) {
      group.push(params.paragraphs[cursor]);
      cursor += 1;
    }

    const text = group.map((item) => item.text).join("\n\n");
    const first = group[0];
    const last = group[group.length - 1];
    out.push({
      id: hashId("book_scene", [params.bookId, params.chapterOrderIndex, sceneOrder]),
      bookId: params.bookId,
      chapterId: params.chapterId,
      orderIndex: sceneOrder,
      title: `Сцена ${sceneOrder}`,
      summary: summarizeSceneText(text),
      startParagraphOrder: first.orderIndex,
      endParagraphOrder: last.orderIndex,
      startChar: first.startChar,
      endChar: last.endChar,
      text,
      metadataJson: {
        chapterOrderIndex: params.chapterOrderIndex,
        paragraphCount: group.length,
      },
    });
    sceneOrder += 1;
  }
  return out;
}

function mapEntityType(value: EntitySourceRecord["type"]): "character" | "location" | "theme" | "group" | "object" | "motif" | "concept" {
  return value;
}

function coalesceEntitySources(params: {
  expertCore: BookExpertCoreSnapshot | null;
  characters: Array<{ id: string; name: string; normalizedName: string; description: string; arc: string; role: string }>;
  themes: Array<{ id: string; name: string; normalizedName: string; description: string; development: string }>;
  locations: Array<{ id: string; name: string; normalizedName: string; description: string; significance: string }>;
}): EntitySourceRecord[] {
  const out = new Map<string, EntitySourceRecord>();
  const upsert = (record: EntitySourceRecord) => {
    const normalizedName = normalizeEntityName(record.normalizedName || record.name);
    if (!normalizedName) return;
    const key = `${record.type}:${normalizedName}`;
    const existing = out.get(key);
    if (!existing) {
      out.set(key, {
        ...record,
        id: hashId("book_entity", [record.type, normalizedName]),
        normalizedName,
        aliases: Array.from(new Set(record.aliases.filter(Boolean))),
      });
      return;
    }
    existing.summary = clampText([existing.summary, record.summary].filter(Boolean).join(" "), 900);
    existing.aliases = Array.from(new Set([...existing.aliases, ...record.aliases].filter(Boolean)));
    existing.role = existing.role || record.role || null;
    existing.arc = existing.arc || record.arc || null;
    existing.development = existing.development || record.development || null;
    existing.significance = existing.significance || record.significance || null;
  };

  for (const item of params.expertCore?.characters || []) {
    upsert({
      id: item.id,
      type: "character",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.role, item.description, item.arc].join(" "), 900),
      aliases: item.aliases,
      role: item.role,
      arc: item.arc,
    });
  }
  for (const item of params.expertCore?.themes || []) {
    upsert({
      id: item.id,
      type: "theme",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.description, item.development].join(" "), 900),
      aliases: item.aliases,
      development: item.development,
    });
  }
  for (const item of params.expertCore?.locations || []) {
    upsert({
      id: item.id,
      type: "location",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.description, item.significance].join(" "), 900),
      aliases: item.aliases,
      significance: item.significance,
    });
  }

  for (const item of params.characters) {
    upsert({
      id: item.id,
      type: "character",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.role, item.description, item.arc].join(" "), 900),
      aliases: [],
      role: item.role,
      arc: item.arc,
    });
  }
  for (const item of params.themes) {
    upsert({
      id: item.id,
      type: "theme",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.description, item.development].join(" "), 900),
      aliases: [],
      development: item.development,
    });
  }
  for (const item of params.locations) {
    upsert({
      id: item.id,
      type: "location",
      name: item.name,
      normalizedName: item.normalizedName,
      summary: clampText([item.description, item.significance].join(" "), 900),
      aliases: [],
      significance: item.significance,
    });
  }

  for (const incident of params.expertCore?.incidents || []) {
    for (const participant of incident.participants) {
      const normalizedName = normalizeEntityName(participant.normalizedValue || participant.value);
      if (!normalizedName) continue;
      upsert({
        id: participant.entityId || hashId("book_entity", [participant.kind, normalizedName]),
        type:
          participant.kind === "character"
            ? "character"
            : participant.kind === "location"
              ? "location"
              : "concept",
        name: participant.value,
        normalizedName,
        summary: participant.role,
        aliases: [],
      });
    }
  }

  return [...out.values()];
}

function findTextMatchOffsets(haystack: string, needle: string): { start: number; end: number } | null {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\b)${escaped}(\\b|$)`, "iu");
  const match = regex.exec(haystack);
  if (!match) return null;
  const start = match.index + (match[1] ? match[1].length : 0);
  return {
    start,
    end: start + needle.length,
  };
}

function detectMentionsForParagraph(params: {
  bookId: string;
  chapterId: string;
  sceneId: string;
  paragraph: ParagraphDraft;
  entities: Array<{ id: string; normalizedName: string; aliases: string[] }>;
}): Array<{
  entityId: string;
  startChar: number;
  endChar: number;
  sourceText: string;
}> {
  const out: Array<{
    entityId: string;
    startChar: number;
    endChar: number;
    sourceText: string;
  }> = [];

  for (const entity of params.entities) {
    const candidateAliases = [entity.normalizedName, ...entity.aliases.map((alias) => normalizeEntityName(alias))]
      .map((item) => compactWhitespace(item))
      .filter((item) => item.length >= 2)
      .sort((left, right) => right.length - left.length);

    const normalizedParagraph = normalizeEntityName(params.paragraph.text);
    for (const alias of candidateAliases) {
      const match = findTextMatchOffsets(normalizedParagraph, alias);
      if (!match) continue;
      out.push({
        entityId: entity.id,
        startChar: params.paragraph.startChar + match.start,
        endChar: params.paragraph.startChar + match.end,
        sourceText: params.paragraph.text.slice(Math.max(0, match.start), Math.min(params.paragraph.text.length, match.end)),
      });
      break;
    }
  }

  return out;
}

function inferRelationType(summary: string, roles: string[]): "family" | "authority" | "conflict" | "symbolic_association" {
  const corpus = normalizeEntityName(`${summary} ${roles.join(" ")}`);
  if (/(mother|father|brother|sister|wife|husband|son|daughter|мать|отец|брат|сестра|жена|муж|сын|дочь)/i.test(corpus)) {
    return "family";
  }
  if (/(teacher|commander|boss|профессор|учитель|командир|начальник)/i.test(corpus)) {
    return "authority";
  }
  if (/(kill|beat|conflict|fight|violence|избил|убил|ссора|конфликт|драка|насили)/i.test(corpus)) {
    return "conflict";
  }
  return "symbolic_association";
}

async function syncLegacyEntityReadModels(bookId: string, entities: EntitySourceRecord[]) {
  const characters = entities.filter((item) => item.type === "character");
  const themes = entities.filter((item) => item.type === "theme");
  const locations = entities.filter((item) => item.type === "location");

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.bookCharacter.deleteMany({ where: { bookId } });
    await tx.bookTheme.deleteMany({ where: { bookId } });
    await tx.bookLocation.deleteMany({ where: { bookId } });

    if (characters.length > 0) {
      await tx.bookCharacter.createMany({
        data: characters.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          role: clampText(item.role || item.summary || item.name, 220),
          description: clampText(item.summary || item.name, 900),
          arc: clampText(item.arc || item.summary || item.name, 900),
          mentionCount: 0,
          firstAppearanceChapterOrder: null,
        })),
      });
    }

    if (themes.length > 0) {
      await tx.bookTheme.createMany({
        data: themes.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: clampText(item.summary || item.name, 900),
          development: clampText(item.development || item.summary || item.name, 900),
          mentionCount: 0,
          firstAppearanceChapterOrder: null,
        })),
      });
    }

    if (locations.length > 0) {
      await tx.bookLocation.createMany({
        data: locations.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: clampText(item.summary || item.name, 900),
          significance: clampText(item.significance || item.summary || item.name, 900),
          mentionCount: 0,
          firstAppearanceChapterOrder: null,
        })),
      });
    }
  });
}

export async function processBookCanonicalText(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "canonical_text",
    bookId: payload.bookId,
    handler: async ({ book, chapters }) => {
      const paragraphDrafts: ParagraphDraft[] = [];
      const sentenceDrafts: SentenceDraft[] = [];
      let paragraphOrder = 1;
      let sentenceOrder = 1;

      for (const chapter of chapters) {
        const normalizedText = canonicalizeDocumentContent(chapter.rawText || "");
        const paragraphs = splitParagraphs(normalizedText);
        for (let index = 0; index < paragraphs.length; index += 1) {
          const paragraph = paragraphs[index];
          const paragraphId = hashId("book_paragraph", [book.id, chapter.orderIndex, paragraphOrder]);
          paragraphDrafts.push({
            id: paragraphId,
            bookId: book.id,
            chapterId: chapter.id,
            orderIndex: paragraphOrder,
            orderInChapter: index + 1,
            startChar: paragraph.startChar,
            endChar: paragraph.endChar,
            text: paragraph.text,
          });

          const sentences = splitSentences(paragraph.text);
          for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
            const sentence = sentences[sentenceIndex];
            sentenceDrafts.push({
              id: hashId("book_sentence", [book.id, chapter.orderIndex, paragraphOrder, sentenceIndex + 1]),
              bookId: book.id,
              chapterId: chapter.id,
              paragraphId,
              orderIndex: sentenceOrder,
              orderInChapter: sentenceIndex + 1,
              orderInScene: sentenceIndex + 1,
              startChar: paragraph.startChar + sentence.startChar,
              endChar: paragraph.startChar + sentence.endChar,
              text: sentence.text,
            });
            sentenceOrder += 1;
          }

          paragraphOrder += 1;
        }

        await prisma.bookChapter.update({
          where: { id: chapter.id },
          data: {
            rawText: normalizedText,
          },
        });
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookSentence.deleteMany({ where: { bookId: book.id } });
        await tx.bookParagraph.deleteMany({ where: { bookId: book.id } });

        if (paragraphDrafts.length > 0) {
          await tx.bookParagraph.createMany({
            data: paragraphDrafts.map((paragraph) => ({
              id: paragraph.id,
              bookId: paragraph.bookId,
              chapterId: paragraph.chapterId,
              sceneId: null,
              orderIndex: paragraph.orderIndex,
              orderInChapter: paragraph.orderInChapter,
              startChar: paragraph.startChar,
              endChar: paragraph.endChar,
              text: paragraph.text,
            })),
          });
        }

        if (sentenceDrafts.length > 0) {
          await tx.bookSentence.createMany({
            data: sentenceDrafts.map((sentence) => ({
              id: sentence.id,
              bookId: sentence.bookId,
              chapterId: sentence.chapterId,
              paragraphId: sentence.paragraphId,
              sceneId: null,
              orderIndex: sentence.orderIndex,
              orderInChapter: sentence.orderInChapter,
              orderInScene: sentence.orderInScene,
              startChar: sentence.startChar,
              endChar: sentence.endChar,
              text: sentence.text,
            })),
          });
        }
      });

      logger.info({ bookId: book.id, paragraphs: paragraphDrafts.length, sentences: sentenceDrafts.length }, "Book canonical text built");
      return { nextStages: ["scene_build"] };
    },
  });
}

export async function processBookSceneBuild(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "scene_build",
    bookId: payload.bookId,
    handler: async ({ book, chapters }) => {
      const paragraphs = await prisma.bookParagraph.findMany({
        where: { bookId: book.id },
        orderBy: [{ orderIndex: "asc" }],
      });
      const byChapter = new Map<string, ParagraphDraft[]>();
      for (const paragraph of paragraphs) {
        const list = byChapter.get(paragraph.chapterId) || [];
        list.push({
          id: paragraph.id,
          bookId: paragraph.bookId,
          chapterId: paragraph.chapterId,
          orderIndex: paragraph.orderIndex,
          orderInChapter: paragraph.orderInChapter,
          startChar: paragraph.startChar,
          endChar: paragraph.endChar,
          text: paragraph.text,
        });
        byChapter.set(paragraph.chapterId, list);
      }

      const sceneDrafts: SceneDraft[] = [];
      let sceneOrder = 1;
      for (const chapter of chapters) {
        const chapterParagraphs = byChapter.get(chapter.id) || [];
        const built = buildScenesForChapter({
          bookId: book.id,
          chapterId: chapter.id,
          chapterOrderIndex: chapter.orderIndex,
          paragraphs: chapterParagraphs,
          sceneOrderStart: sceneOrder,
        });
        sceneDrafts.push(...built);
        sceneOrder += built.length;
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookScene.deleteMany({ where: { bookId: book.id } });
        if (sceneDrafts.length > 0) {
          await tx.bookScene.createMany({
            data: sceneDrafts.map((scene) => ({
              id: scene.id,
              bookId: scene.bookId,
              chapterId: scene.chapterId,
              orderIndex: scene.orderIndex,
              title: scene.title,
              summary: scene.summary,
              startParagraphOrder: scene.startParagraphOrder,
              endParagraphOrder: scene.endParagraphOrder,
              startChar: scene.startChar,
              endChar: scene.endChar,
              text: scene.text,
              metadataJson: scene.metadataJson as Prisma.InputJsonValue,
            })),
          });
        }

        for (const scene of sceneDrafts) {
          await tx.bookParagraph.updateMany({
            where: {
              bookId: book.id,
              chapterId: scene.chapterId,
              orderIndex: {
                gte: scene.startParagraphOrder,
                lte: scene.endParagraphOrder,
              },
            },
            data: {
              sceneId: scene.id,
            },
          });
          await tx.bookSentence.updateMany({
            where: {
              bookId: book.id,
              chapterId: scene.chapterId,
              paragraph: {
                orderIndex: {
                  gte: scene.startParagraphOrder,
                  lte: scene.endParagraphOrder,
                },
              },
            },
            data: {
              sceneId: scene.id,
            },
          });
        }
      }, { maxWait: 10_000, timeout: 60_000 });

      logger.info({ bookId: book.id, scenes: sceneDrafts.length }, "Book scenes built");
      return { nextStages: ["entity_graph", "summary_store", "text_index"] };
    },
  });
}

export async function processBookEntityGraph(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "entity_graph",
    bookId: payload.bookId,
    handler: async ({ book, expertCore }) => {
      const [characters, themes, locations, scenes, paragraphs] = await Promise.all([
        prisma.bookCharacter.findMany({
          where: { bookId: book.id },
          select: { id: true, name: true, normalizedName: true, description: true, arc: true, role: true },
        }),
        prisma.bookTheme.findMany({
          where: { bookId: book.id },
          select: { id: true, name: true, normalizedName: true, description: true, development: true },
        }),
        prisma.bookLocation.findMany({
          where: { bookId: book.id },
          select: { id: true, name: true, normalizedName: true, description: true, significance: true },
        }),
        prisma.bookScene.findMany({
          where: { bookId: book.id },
          orderBy: [{ orderIndex: "asc" }],
          select: { id: true, orderIndex: true, chapterId: true, chapter: { select: { orderIndex: true } } },
        }),
        prisma.bookParagraph.findMany({
          where: { bookId: book.id, sceneId: { not: null } },
          orderBy: [{ orderIndex: "asc" }],
          select: {
            id: true,
            bookId: true,
            chapterId: true,
            sceneId: true,
            orderIndex: true,
            orderInChapter: true,
            startChar: true,
            endChar: true,
            text: true,
          },
        }),
      ]);

      const sceneById = new Map(scenes.map((scene) => [scene.id, scene] as const));
      const entitySources = coalesceEntitySources({
        expertCore,
        characters,
        themes,
        locations,
      });

      const mentionsDraft: Array<{
        id: string;
        bookId: string;
        entityId: string;
        chapterId: string;
        sceneId: string;
        paragraphId: string;
        startChar: number;
        endChar: number;
        sourceText: string;
      }> = [];

      const mentionEntityShape = entitySources.map((entity) => ({
        id: entity.id,
        normalizedName: entity.normalizedName,
        aliases: entity.aliases,
      }));

      for (const paragraph of paragraphs) {
        const sceneId = paragraph.sceneId;
        if (!sceneId) continue;
        const detected = detectMentionsForParagraph({
          bookId: book.id,
          chapterId: paragraph.chapterId,
          sceneId,
          paragraph: paragraph as ParagraphDraft,
          entities: mentionEntityShape,
        });
        for (const mention of detected) {
          mentionsDraft.push({
            id: hashId("book_mention", [book.id, paragraph.id, mention.entityId, mention.startChar, mention.endChar]),
            bookId: book.id,
            entityId: mention.entityId,
            chapterId: paragraph.chapterId,
            sceneId,
            paragraphId: paragraph.id,
            startChar: mention.startChar,
            endChar: mention.endChar,
            sourceText: mention.sourceText || paragraph.text,
          });
        }
      }

      const mentionStats = new Map<string, { count: number; firstSceneId: string | null; lastSceneId: string | null }>();
      for (const mention of mentionsDraft) {
        const current = mentionStats.get(mention.entityId) || { count: 0, firstSceneId: null, lastSceneId: null };
        current.count += 1;
        const scene = sceneById.get(mention.sceneId);
        const firstScene = current.firstSceneId ? sceneById.get(current.firstSceneId) : null;
        const lastScene = current.lastSceneId ? sceneById.get(current.lastSceneId) : null;
        if (!firstScene || (scene && scene.orderIndex < firstScene.orderIndex)) current.firstSceneId = mention.sceneId;
        if (!lastScene || (scene && scene.orderIndex > lastScene.orderIndex)) current.lastSceneId = mention.sceneId;
        mentionStats.set(mention.entityId, current);
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookMention.deleteMany({ where: { bookId: book.id } });
        await tx.bookEntityAlias.deleteMany({
          where: {
            entity: { bookId: book.id },
          },
        });
        await tx.bookEntity.deleteMany({ where: { bookId: book.id } });

        if (entitySources.length > 0) {
          await tx.bookEntity.createMany({
            data: entitySources.map((entity) => {
              const stats = mentionStats.get(entity.id);
              return {
                id: entity.id,
                bookId: book.id,
                type: mapEntityType(entity.type),
                canonicalName: entity.name,
                normalizedName: entity.normalizedName,
                summary: clampText(entity.summary || entity.name, 2000),
                mentionCount: stats?.count || 0,
                firstSceneId: stats?.firstSceneId || null,
                lastSceneId: stats?.lastSceneId || null,
              };
            }),
          });
        }

        const aliasRows = entitySources.flatMap((entity) => {
          const aliases = Array.from(new Set([entity.name, ...entity.aliases].map((alias) => compactWhitespace(alias)).filter(Boolean)));
          return aliases.map((alias) => ({
            id: hashId("book_entity_alias", [entity.id, alias]),
            entityId: entity.id,
            alias,
            normalizedAlias: normalizeEntityName(alias),
            aliasType: (alias === entity.name ? "name" : "descriptor") as "name" | "descriptor",
            confidence: 1,
          }));
        });
        if (aliasRows.length > 0) {
          await tx.bookEntityAlias.createMany({ data: aliasRows });
        }

        if (mentionsDraft.length > 0) {
          await tx.bookMention.createMany({
            data: mentionsDraft.map((mention) => ({
              id: mention.id,
              bookId: mention.bookId,
              entityId: mention.entityId,
              chapterId: mention.chapterId,
              sceneId: mention.sceneId,
              paragraphId: mention.paragraphId,
              sentenceId: null,
              mentionType: "alias",
              startChar: mention.startChar,
              endChar: mention.endChar,
              sourceText: mention.sourceText,
              confidence: 0.75,
            })),
          });
        }
      });

      await syncLegacyEntityReadModels(book.id, entitySources);
      logger.info({ bookId: book.id, entities: entitySources.length, mentions: mentionsDraft.length }, "Book entity graph built");
      return { nextStages: ["event_relation_graph"] };
    },
  });
}

export async function processBookEventRelationGraph(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "event_relation_graph",
    bookId: payload.bookId,
    handler: async ({ book, expertCore }) => {
      const [chapters, scenes, entities] = await Promise.all([
        prisma.bookChapter.findMany({
          where: { bookId: book.id },
          select: { id: true, orderIndex: true },
        }),
        prisma.bookScene.findMany({
          where: { bookId: book.id },
          select: { id: true, orderIndex: true, title: true, summary: true, chapter: { select: { orderIndex: true } } },
          orderBy: [{ orderIndex: "asc" }],
        }),
        prisma.bookEntity.findMany({
          where: { bookId: book.id },
          select: { id: true, normalizedName: true, canonicalName: true, type: true },
        }),
      ]);

      const chapterByOrder = new Map(chapters.map((chapter) => [chapter.orderIndex, chapter.id] as const));
      const sceneByChapter = new Map<number, Array<{ id: string; orderIndex: number; title: string; summary: string }>>();
      for (const scene of scenes) {
        const list = sceneByChapter.get(scene.chapter.orderIndex) || [];
        list.push({
          id: scene.id,
          orderIndex: scene.orderIndex,
          title: compactWhitespace(scene.title || ""),
          summary: compactWhitespace(scene.summary || scene.title || ""),
        });
        sceneByChapter.set(scene.chapter.orderIndex, list);
      }
      const entityByNormalized = new Map(entities.map((entity) => [entity.normalizedName, entity] as const));

      const eventSources: EventSourceRecord[] = [];
      const relationRows = new Map<string, {
        id: string;
        fromEntityId: string;
        toEntityId: string;
        type: "family" | "authority" | "conflict" | "symbolic_association";
        summary: string;
        sceneId: string | null;
      }>();

      const incidents = expertCore?.incidents || [];
      const plotSpine = expertCore?.plotSpine || [];

      for (let index = 0; index < incidents.length; index += 1) {
        const incident = incidents[index];
        const chapterId = chapterByOrder.get(incident.chapterFrom);
        if (!chapterId) continue;
        const sceneCandidates = sceneByChapter.get(incident.chapterFrom) || [];
        const sceneFallback = sceneCandidates[0] || null;
        const sceneId = sceneFallback?.id || null;
        const participants = incident.participants.map((participant) => {
          const entity =
            (participant.entityId && entities.find((item) => item.id === participant.entityId)) ||
            entityByNormalized.get(normalizeEntityName(participant.normalizedValue || participant.value));
          return {
            entityId: entity?.id || null,
            normalizedName: entity?.normalizedName || normalizeEntityName(participant.value),
            displayName: entity?.canonicalName || participant.value,
            role: participant.role,
          };
        });
        const summaryText = preferLocalizedText(
          [...incident.facts, ...incident.consequences].join(" "),
          sceneFallback?.summary || sceneFallback?.title || null
        );
        const titleText = preferLocalizedText(
          incident.title,
          sceneFallback?.title || (sceneFallback?.summary ? clampText(sceneFallback.summary, 120) : `Событие в главе ${incident.chapterFrom}`)
        );
        eventSources.push({
          id: incident.id,
          chapterOrderIndex: incident.chapterFrom,
          title: clampText(titleText, 180),
          summary: clampText(summaryText, 1200),
          importance: incident.importance,
          sceneId,
          quoteIds: incident.quoteIds,
          participants,
        });

        const namedParticipants = participants.filter((participant) => participant.entityId);
        for (let leftIndex = 0; leftIndex < namedParticipants.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < namedParticipants.length; rightIndex += 1) {
            const left = namedParticipants[leftIndex];
            const right = namedParticipants[rightIndex];
            if (!left.entityId || !right.entityId) continue;
            const [fromEntityId, toEntityId] = [left.entityId, right.entityId].sort();
            const type = inferRelationType(summaryText, [left.role, right.role]);
            const id = hashId("book_relation", [book.id, fromEntityId, toEntityId, type]);
            relationRows.set(id, {
              id,
              fromEntityId,
              toEntityId,
              type,
              summary: summaryText,
              sceneId,
            });
          }
        }
      }

      for (const point of plotSpine) {
        if (eventSources.some((event) => event.id === point.id)) continue;
        const chapterId = chapterByOrder.get(point.chapterOrderIndex);
        if (!chapterId) continue;
        const sceneCandidates = sceneByChapter.get(point.chapterOrderIndex) || [];
        const sceneFallback = sceneCandidates[0] || null;
        eventSources.push({
          id: point.id,
          chapterOrderIndex: point.chapterOrderIndex,
          title: clampText(
            preferLocalizedText(
              point.label,
              sceneFallback?.title || (sceneFallback?.summary ? clampText(sceneFallback.summary, 120) : `Событие в главе ${point.chapterOrderIndex}`)
            ),
            180
          ),
          summary: clampText(
            preferLocalizedText(point.summary, sceneFallback?.summary || sceneFallback?.title || null),
            1200
          ),
          importance: point.importance,
          sceneId: sceneFallback?.id || null,
          quoteIds: [],
          participants: [],
        });
      }

      eventSources.sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex || right.importance - left.importance);

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookEventEdge.deleteMany({ where: { bookId: book.id } });
        await tx.bookEventParticipant.deleteMany({
          where: {
            event: { bookId: book.id },
          },
        });
        await tx.bookEvent.deleteMany({ where: { bookId: book.id } });
        await tx.bookRelationEdge.deleteMany({ where: { bookId: book.id } });

        if (eventSources.length > 0) {
          await tx.bookEvent.createMany({
            data: eventSources.map((event, index) => ({
              id: event.id,
              bookId: book.id,
              chapterId: chapterByOrder.get(event.chapterOrderIndex)!,
              sceneId: event.sceneId,
              orderIndex: index + 1,
              title: event.title,
              summary: event.summary,
              importance: event.importance,
            })),
          });

          const participantRows = eventSources.flatMap((event) =>
            event.participants.map((participant) => ({
              id: hashId("book_event_participant", [event.id, participant.entityId || participant.normalizedName, participant.role]),
              eventId: event.id,
              entityId: participant.entityId,
              role: participant.role || "participant",
              displayName: participant.displayName || participant.normalizedName,
              normalizedName: participant.normalizedName,
            }))
          );
          if (participantRows.length > 0) {
            await tx.bookEventParticipant.createMany({ data: participantRows });
          }

          const edgeRows = eventSources
            .slice(1)
            .map((event, index) => ({
              id: hashId("book_event_edge", [book.id, eventSources[index].id, event.id, "before"]),
              bookId: book.id,
              fromEventId: eventSources[index].id,
              toEventId: event.id,
              type: "before" as const,
              confidence: 0.85,
            }));
          if (edgeRows.length > 0) {
            await tx.bookEventEdge.createMany({ data: edgeRows });
          }
        }

        if (relationRows.size > 0) {
          await tx.bookRelationEdge.createMany({
            data: [...relationRows.values()].map((relation) => ({
              id: relation.id,
              bookId: book.id,
              fromEntityId: relation.fromEntityId,
              toEntityId: relation.toEntityId,
              type: relation.type,
              summary: clampText(relation.summary, 1200),
              confidence: 0.7,
              sceneId: relation.sceneId,
            })),
          });
        }
      });

      logger.info({ bookId: book.id, events: eventSources.length, relations: relationRows.size }, "Book event/relation graph built");
      return { nextStages: ["evidence_store"] };
    },
  });
}

export async function processBookSummaryStore(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "summary_store",
    bookId: payload.bookId,
    handler: async ({ book, chapters, expertCore }) => {
      const [scenes, entities, relations] = await Promise.all([
        prisma.bookScene.findMany({
          where: { bookId: book.id },
          orderBy: [{ orderIndex: "asc" }],
          select: { id: true, orderIndex: true, title: true, summary: true, chapterId: true, chapter: { select: { orderIndex: true, title: true } } },
        }),
        prisma.bookEntity.findMany({
          where: { bookId: book.id },
          orderBy: [{ mentionCount: "desc" }, { canonicalName: "asc" }],
        }),
        prisma.bookRelationEdge.findMany({
          where: { bookId: book.id },
          include: {
            fromEntity: { select: { canonicalName: true } },
            toEntity: { select: { canonicalName: true } },
          },
          orderBy: [{ confidence: "desc" }],
        }),
      ]);

      const artifacts: Array<{
        id: string;
        kind:
          | "book_brief"
          | "scene_summary"
          | "chapter_summary"
          | "character_arc"
          | "relationship_summary"
          | "theme_note"
          | "motif_note"
          | "chapter_retelling"
          | "literary_section";
        key: string | null;
        title: string;
        summary: string;
        bodyMarkdown: string | null;
        chapterId: string | null;
        sceneId: string | null;
        entityId: string | null;
        metadataJson: Record<string, unknown> | null;
        confidence: number;
      }> = [];

      const chapterSummaryFallbacks = chapters
        .map((chapter) => {
          const chapterScenes = scenes.filter((scene) => scene.chapter.orderIndex === chapter.orderIndex);
          return clampText(chapter.summary || chapterScenes.map((scene) => scene.summary || scene.title || "").join(" "), 360);
        })
        .filter(Boolean);

      const briefFallback = clampText(
        [chapterSummaryFallbacks[0], chapterSummaryFallbacks[Math.floor(chapterSummaryFallbacks.length / 2)], chapterSummaryFallbacks[chapterSummaryFallbacks.length - 1]]
          .filter(Boolean)
          .join(" "),
        1200
      );

      const briefBodyFallback = clampText(chapterSummaryFallbacks.slice(0, 4).join("\n\n"), 4000);

      artifacts.push({
        id: hashId("book_summary_artifact", [book.id, "book_brief"]),
        kind: "book_brief",
        key: "book_brief",
        title: "О книге",
        summary: clampText(preferLocalizedText(expertCore?.bookBrief.shortSummary || book.summary || null, briefFallback || `Книга «${book.title}».`), 1200),
        bodyMarkdown: preferLocalizedText(expertCore?.bookBrief.fullSummary || book.summary || null, briefBodyFallback || null) || null,
        chapterId: null,
        sceneId: null,
        entityId: null,
        metadataJson: null,
        confidence: 0.9,
      });

      for (const scene of scenes) {
        artifacts.push({
          id: hashId("book_summary_artifact", [book.id, "scene_summary", scene.id]),
          kind: "scene_summary",
          key: `scene:${scene.id}`,
          title: scene.title || `Сцена ${scene.orderIndex}`,
          summary: clampText(scene.summary || scene.title || `Сцена ${scene.orderIndex}`, 1000),
          bodyMarkdown: null,
          chapterId: scene.chapterId,
          sceneId: scene.id,
          entityId: null,
          metadataJson: {
            sceneOrderIndex: scene.orderIndex,
            chapterOrderIndex: scene.chapter.orderIndex,
          },
          confidence: 0.75,
        });
      }

      for (const chapter of chapters) {
        const chapterScenes = scenes.filter((scene) => scene.chapter.orderIndex === chapter.orderIndex);
        artifacts.push({
          id: hashId("book_summary_artifact", [book.id, "chapter_summary", chapter.id]),
          kind: "chapter_summary",
          key: `chapter:${chapter.orderIndex}`,
          title: chapter.title,
          summary: clampText(chapter.summary || chapterScenes.map((scene) => scene.summary || scene.title || "").join(" "), 1200),
          bodyMarkdown: null,
          chapterId: chapter.id,
          sceneId: null,
          entityId: null,
          metadataJson: {
            chapterOrderIndex: chapter.orderIndex,
          },
          confidence: 0.8,
        });
      }

      for (const entity of entities) {
        if (entity.type === "character") {
          artifacts.push({
            id: hashId("book_summary_artifact", [book.id, "character_arc", entity.id]),
            kind: "character_arc",
            key: entity.id,
            title: entity.canonicalName,
            summary: clampText(entity.summary || entity.canonicalName, 1200),
            bodyMarkdown: null,
            chapterId: null,
            sceneId: null,
            entityId: entity.id,
            metadataJson: null,
            confidence: 0.8,
          });
        } else if (entity.type === "theme") {
          artifacts.push({
            id: hashId("book_summary_artifact", [book.id, "theme_note", entity.id]),
            kind: "theme_note",
            key: entity.id,
            title: entity.canonicalName,
            summary: clampText(entity.summary || entity.canonicalName, 1200),
            bodyMarkdown: null,
            chapterId: null,
            sceneId: null,
            entityId: entity.id,
            metadataJson: null,
            confidence: 0.75,
          });
        } else if (entity.type === "motif") {
          artifacts.push({
            id: hashId("book_summary_artifact", [book.id, "motif_note", entity.id]),
            kind: "motif_note",
            key: entity.id,
            title: entity.canonicalName,
            summary: clampText(entity.summary || entity.canonicalName, 1200),
            bodyMarkdown: null,
            chapterId: null,
            sceneId: null,
            entityId: entity.id,
            metadataJson: null,
            confidence: 0.75,
          });
        }
      }

      for (const relation of relations) {
        artifacts.push({
          id: hashId("book_summary_artifact", [book.id, "relationship_summary", relation.id]),
          kind: "relationship_summary",
          key: relation.id,
          title: `${relation.fromEntity.canonicalName} ↔ ${relation.toEntity.canonicalName}`,
          summary: clampText(relation.summary, 1200),
          bodyMarkdown: null,
          chapterId: null,
          sceneId: relation.sceneId,
          entityId: null,
          metadataJson: {
            relationType: relation.type,
          },
          confidence: relation.confidence,
        });
      }

      for (const [key, section] of Object.entries(expertCore?.literarySections || {})) {
        artifacts.push({
          id: hashId("book_summary_artifact", [book.id, "literary_section", key]),
          kind: "literary_section",
          key,
          title: section.title,
          summary: clampText(section.summary, 1200),
          bodyMarkdown: section.bodyMarkdown,
          chapterId: null,
          sceneId: null,
          entityId: null,
          metadataJson: {
            evidenceQuoteIds: section.evidenceQuoteIds,
            bullets: section.bullets,
          },
          confidence: section.confidence,
        });
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookSummaryArtifact.deleteMany({ where: { bookId: book.id } });
        if (artifacts.length > 0) {
          await tx.bookSummaryArtifact.createMany({
            data: artifacts.map((artifact) => ({
              id: artifact.id,
              bookId: book.id,
              kind: artifact.kind,
              key: artifact.key,
              title: artifact.title,
              summary: artifact.summary,
              bodyMarkdown: artifact.bodyMarkdown,
              chapterId: artifact.chapterId,
              sceneId: artifact.sceneId,
              entityId: artifact.entityId,
              metadataJson: artifact.metadataJson === null ? Prisma.JsonNull : (artifact.metadataJson as Prisma.InputJsonValue),
              confidence: artifact.confidence,
            })),
          });
        }

        const literarySections = artifacts.filter((artifact) => artifact.kind === "literary_section");
        if (literarySections.length > 0) {
          await tx.bookLiteraryAnalysis.upsert({
            where: { bookId: book.id },
            create: {
              bookId: book.id,
              sectionsJson: Object.fromEntries(
                literarySections.map((artifact) => [
                  artifact.key,
                  {
                    key: artifact.key,
                    title: artifact.title,
                    summary: artifact.summary,
                    bodyMarkdown: artifact.bodyMarkdown || artifact.summary,
                    bullets: Array.isArray(artifact.metadataJson?.bullets) ? artifact.metadataJson?.bullets : [],
                    evidenceQuoteIds: Array.isArray(artifact.metadataJson?.evidenceQuoteIds)
                      ? artifact.metadataJson?.evidenceQuoteIds
                      : [],
                    confidence: artifact.confidence,
                  },
                ])
              ) as Prisma.InputJsonValue,
            },
            update: {
              sectionsJson: Object.fromEntries(
                literarySections.map((artifact) => [
                  artifact.key,
                  {
                    key: artifact.key,
                    title: artifact.title,
                    summary: artifact.summary,
                    bodyMarkdown: artifact.bodyMarkdown || artifact.summary,
                    bullets: Array.isArray(artifact.metadataJson?.bullets) ? artifact.metadataJson?.bullets : [],
                    evidenceQuoteIds: Array.isArray(artifact.metadataJson?.evidenceQuoteIds)
                      ? artifact.metadataJson?.evidenceQuoteIds
                      : [],
                    confidence: artifact.confidence,
                  },
                ])
              ) as Prisma.InputJsonValue,
            },
          });
        }
      });

      logger.info({ bookId: book.id, artifacts: artifacts.length }, "Book summary store built");
      return { nextStages: ["evidence_store"] };
    },
  });
}

export async function processBookQuoteStore(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "quote_store",
    bookId: payload.bookId,
    handler: async ({ book, expertCore, chapters }) => {
      const quotesCount = await prisma.bookQuote.count({ where: { bookId: book.id } });
      if (quotesCount === 0 && expertCore?.quoteBank?.length) {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.bookQuote.createMany({
            data: expertCore.quoteBank.map((quote) => ({
              id: quote.id,
              bookId: book.id,
              chapterOrderIndex: quote.chapterOrderIndex,
              startChar: quote.startChar,
              endChar: quote.endChar,
              text: quote.text,
              type: quote.type,
              confidence: quote.confidence,
              commentary: quote.commentary,
            })),
            skipDuplicates: true,
          });
        });
      }

      logger.info({ bookId: book.id, quotesCount: await prisma.bookQuote.count({ where: { bookId: book.id } }) }, "Book quote store ready");
      return { nextStages: ["evidence_store"] };
    },
  });
}

export async function processBookTextIndex(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "text_index",
    bookId: payload.bookId,
    handler: async ({ book }) => {
      await processBookChatIndex({ bookId: book.id });
      logger.info({ bookId: book.id }, "Book text index ready");
      return {};
    },
  });
}

export async function processBookEvidenceStore(payload: StagePayload) {
  await runGraphStage({
    analyzerType: "evidence_store",
    bookId: payload.bookId,
    handler: async ({ book, expertCore }) => {
      const [scenes, events, relations, artifacts] = await Promise.all([
        prisma.bookScene.findMany({
          where: { bookId: book.id },
          select: { id: true, chapter: { select: { orderIndex: true } }, summary: true, text: true },
        }),
        prisma.bookEvent.findMany({
          where: { bookId: book.id },
          select: { id: true, sceneId: true, title: true, summary: true, chapter: { select: { orderIndex: true } } },
        }),
        prisma.bookRelationEdge.findMany({
          where: { bookId: book.id },
          select: { id: true, sceneId: true, summary: true },
        }),
        prisma.bookSummaryArtifact.findMany({
          where: { bookId: book.id },
          select: { id: true, kind: true, key: true, sceneId: true, summary: true, metadataJson: true },
        }),
      ]);

      const quoteIdByIncident = new Map((expertCore?.incidents || []).map((incident) => [incident.id, incident.quoteIds] as const));
      const quoteIdBySection = new Map(
        Object.entries(expertCore?.literarySections || {}).map(([key, section]) => [key, section.evidenceQuoteIds] as const)
      );

      const links: Array<{
        id: string;
        subjectType: "scene" | "event" | "relation" | "summary_artifact" | "entity";
        subjectId: string;
        evidenceType: "scene" | "paragraph" | "sentence" | "quote";
        evidenceId: string;
        chapterOrderIndex: number | null;
        snippet: string | null;
        confidence: number;
      }> = [];

      for (const scene of scenes) {
        links.push({
          id: hashId("book_evidence", [book.id, "scene", scene.id, "scene", scene.id]),
          subjectType: "scene",
          subjectId: scene.id,
          evidenceType: "scene",
          evidenceId: scene.id,
          chapterOrderIndex: scene.chapter.orderIndex,
          snippet: clampText(scene.summary || scene.text, 320),
          confidence: 1,
        });
      }

      for (const event of events) {
        if (event.sceneId) {
          links.push({
            id: hashId("book_evidence", [book.id, "event", event.id, "scene", event.sceneId]),
            subjectType: "event",
            subjectId: event.id,
            evidenceType: "scene",
            evidenceId: event.sceneId,
            chapterOrderIndex: event.chapter.orderIndex,
            snippet: clampText(event.summary, 320),
            confidence: 0.9,
          });
        }
        for (const quoteId of quoteIdByIncident.get(event.id) || []) {
          links.push({
            id: hashId("book_evidence", [book.id, "event", event.id, "quote", quoteId]),
            subjectType: "event",
            subjectId: event.id,
            evidenceType: "quote",
            evidenceId: quoteId,
            chapterOrderIndex: event.chapter.orderIndex,
            snippet: clampText(event.summary, 320),
            confidence: 0.9,
          });
        }
      }

      for (const relation of relations) {
        if (!relation.sceneId) continue;
        links.push({
          id: hashId("book_evidence", [book.id, "relation", relation.id, "scene", relation.sceneId]),
          subjectType: "relation",
          subjectId: relation.id,
          evidenceType: "scene",
          evidenceId: relation.sceneId,
          chapterOrderIndex: null,
          snippet: clampText(relation.summary, 320),
          confidence: 0.8,
        });
      }

      for (const artifact of artifacts) {
        if (artifact.sceneId) {
          links.push({
            id: hashId("book_evidence", [book.id, "summary_artifact", artifact.id, "scene", artifact.sceneId]),
            subjectType: "summary_artifact",
            subjectId: artifact.id,
            evidenceType: "scene",
            evidenceId: artifact.sceneId,
            chapterOrderIndex: null,
            snippet: clampText(artifact.summary, 320),
            confidence: 0.8,
          });
        }
        const quoteIds = artifact.kind === "literary_section" ? quoteIdBySection.get(String(artifact.key || artifact.id)) || [] : [];
        for (const quoteId of quoteIds) {
          links.push({
            id: hashId("book_evidence", [book.id, "summary_artifact", artifact.id, "quote", quoteId]),
            subjectType: "summary_artifact",
            subjectId: artifact.id,
            evidenceType: "quote",
            evidenceId: quoteId,
            chapterOrderIndex: null,
            snippet: clampText(artifact.summary, 320),
            confidence: 0.75,
          });
        }
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.bookEvidenceLink.deleteMany({ where: { bookId: book.id } });
        if (links.length > 0) {
          await tx.bookEvidenceLink.createMany({
            data: links.map((link) => ({
              id: link.id,
              bookId: book.id,
              subjectType: link.subjectType,
              subjectId: link.subjectId,
              evidenceType: link.evidenceType,
              evidenceId: link.evidenceId,
              chapterOrderIndex: link.chapterOrderIndex,
              snippet: link.snippet,
              confidence: link.confidence,
            })),
          });
        }
      });

      logger.info({ bookId: book.id, evidenceLinks: links.length }, "Book evidence store built");
      return {};
    },
  });
}
