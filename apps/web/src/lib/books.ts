import type {
  Book,
  BookAnalysisState,
  BookChapter,
  BookLike,
  BookQuoteMentionKind,
  BookQuoteTag,
  BookQuoteType,
  BookSummaryArtifact,
  User,
} from "@prisma/client";

export type { AnalyzingBookDTO } from "./libraryAnalyzing";

export interface BookOwnerDTO {
  id: string;
  name: string;
  image: string | null;
}

export interface BookCardDTO {
  id: string;
  title: string;
  author: string | null;
  coverUrl?: string | null;
  isPublic: boolean;
  createdAt: string;
  owner: BookOwnerDTO;
  status: "ready";
  chaptersCount: number;
  charactersCount: number;
  themesCount: number;
  locationsCount: number;
  libraryUsersCount: number;
  isInLibrary: boolean;
  canAddToLibrary: boolean;
  canRemoveFromLibrary: boolean;
  isOwner: boolean;
}

export interface BookCoreDTO {
  id: string;
  title: string;
  author: string | null;
  coverUrl?: string | null;
  summary: string | null;
  isPublic: boolean;
  analysisState: BookAnalysisState;
  chapterCount: number;
  canManage: boolean;
  createdAt: string;
  owner: BookOwnerDTO;
}

export interface BooksListResponseDTO {
  items: BookCardDTO[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BookLibraryStateDTO {
  bookId: string;
  isInLibrary: boolean;
  libraryUsersCount: number;
}

export interface BookChapterDTO {
  id: string;
  orderIndex: number;
  title: string;
  summary: string | null;
}

export interface BookChapterParagraphDTO {
  paragraphIndex: number;
  text: string;
}

export interface BookChapterContentDTO {
  id: string;
  orderIndex: number;
  title: string;
  rawText: string;
  paragraphs: BookChapterParagraphDTO[];
  totalChapters: number;
}

export type BookQuoteTypeDTO = BookQuoteType;
export type BookQuoteTagDTO = BookQuoteTag;
export type BookQuoteMentionKindDTO = BookQuoteMentionKind;

export interface BookQuoteMentionDTO {
  kind: BookQuoteMentionKindDTO;
  value: string;
  normalizedValue: string;
  startChar: number;
  endChar: number;
  confidence: number;
}

export interface BookQuoteListItemDTO {
  id: string;
  chapterOrderIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  type: BookQuoteTypeDTO;
  tags: BookQuoteTagDTO[];
  confidence: number;
  commentary: string | null;
  mentions: BookQuoteMentionDTO[];
}

export interface BookShowcaseThemeDTO {
  name: string;
  description: string;
}

export interface BookShowcaseSummaryDTO {
  shortSummary: string;
  mainIdea: string;
}

export interface BookShowcaseCharacterDTO {
  name: string;
  description: string;
  rank: number;
}

export interface BookShowcaseEventDTO {
  title: string;
  importance: "critical" | "high" | "medium";
  description: string;
}

export interface BookShowcaseQuoteDTO {
  text: string;
  chapterOrderIndex: number | null;
  chapterTitle: string | null;
}

export interface BookShowcaseBlockStatsDTO {
  ok: boolean;
  usedFallback: boolean;
  attempts: number;
  elapsedMs: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
  embeddingInputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
}

export interface BookShowcaseStatsDTO {
  totalElapsedMs: number;
  fallbackBlocks: Array<"summary" | "themes" | "characters" | "events" | "quotes">;
  blocks: {
    summary: BookShowcaseBlockStatsDTO;
    themes: BookShowcaseBlockStatsDTO;
    characters: BookShowcaseBlockStatsDTO;
    events: BookShowcaseBlockStatsDTO;
    quotes: BookShowcaseBlockStatsDTO;
  };
}

export interface BookShowcaseDTO {
  bookId: string;
  summary: BookShowcaseSummaryDTO;
  themes: BookShowcaseThemeDTO[];
  characters: BookShowcaseCharacterDTO[];
  keyEvents: BookShowcaseEventDTO[];
  quotes: BookShowcaseQuoteDTO[];
  stats: BookShowcaseStatsDTO;
  generationMode: "chat_blocks" | "fallback" | "unknown";
  updatedAt: string;
}

export interface BookChunkCitationDTO {
  chunkId: string;
  chapterOrderIndex: number;
  startChar: number;
  endChar: number;
  score: number;
  text: string;
}

export type BookChatCitationDTO = BookChunkCitationDTO;
export type BookChatEvidenceKindDTO =
  | "scene"
  | "event"
  | "relation"
  | "summary_artifact"
  | "quote"
  | "chapter_span"
  | "character"
  | "theme"
  | "location"
  | "literary_section";
export type BookChatConfidenceDTO = "high" | "medium" | "low";
export type BookChatModeDTO = "fast" | "expert" | "degraded";
export type BookChatEntryContextDTO = "overview" | "section" | "full_chat";
export type BookAnalyzerStateDTO = "queued" | "running" | "completed" | "failed" | "not_requested";
export type BookToolCapabilityLevelDTO = "high" | "medium" | "low" | "disabled";
export const BOOK_PIPELINE_STAGE_KEYS = [
  "ingest_normalize",
  "structural_pass",
  "local_extraction_mentions",
  "local_extraction_quotes",
  "local_extraction_events",
  "local_extraction_relations",
  "local_extraction_time_location",
  "validation_pass",
  "entity_resolution",
  "scene_assembly",
  "event_timeline",
  "relation_aggregation",
  "summary_synthesis",
  "index_build",
  "repair",
] as const;
export type BookPipelineStageKeyDTO = (typeof BOOK_PIPELINE_STAGE_KEYS)[number];
export type BookAnalysisViewKeyDTO = "source" | "observations" | "canonical" | "read_layer";

export interface BookAnalyzerStatusDTO {
  state: BookAnalyzerStateDTO;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type BookChatReadinessModeDTO = "indexing" | "fast" | "expert" | "degraded";

export interface BookChatReadinessStageDTO {
  key: BookPipelineStageKeyDTO;
  label: string;
  state: BookAnalyzerStateDTO;
  requiredForFast: boolean;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BookChatReadinessDTO {
  mode: BookChatReadinessModeDTO;
  canChat: boolean;
  summary: string;
  stages: BookChatReadinessStageDTO[];
}

export interface BookCapabilitySnapshotDTO {
  bookId: string;
  analysisVersion: string | null;
  analysisState: "processing" | "completed" | "failed";
  coverage: "none" | "partial" | "full";
  capabilities: {
    resolve_target: BookToolCapabilityLevelDTO;
    get_entity: BookToolCapabilityLevelDTO;
    get_presence: BookToolCapabilityLevelDTO;
    get_evidence: BookToolCapabilityLevelDTO;
    read_passages: BookToolCapabilityLevelDTO;
    get_processing_status: BookToolCapabilityLevelDTO;
  };
  trustedTools: {
    resolve_target: boolean;
    get_entity: boolean;
    get_presence: boolean;
    get_evidence: boolean;
    read_passages: boolean;
    get_processing_status: boolean;
  };
  warnings: string[];
}

export interface BookAnalysisStatusDTO {
  bookId: string;
  contentVersion: number | null;
  overallState: "queued" | "running" | "completed" | "failed";
  coverage: "full" | "partial" | "unknown";
  capabilitySnapshot: BookCapabilitySnapshotDTO;
  analyzers: Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>;
  views: Record<BookAnalysisViewKeyDTO, BookAnalyzerStatusDTO>;
  chatReadiness: BookChatReadinessDTO;
  counts: {
    source: {
      chapters: number;
      paragraphs: number;
      windows: number;
    };
    observations: {
      total: number;
      valid: number;
      invalid: number;
    };
    canonical: {
      entities: number;
      scenes: number;
      events: number;
      relations: number;
      quotes: number;
      summaries: number;
    };
    readLayer: {
      entityCards: number;
      sceneCards: number;
      relationCards: number;
      timelineSlices: number;
      quoteSlices: number;
      searchDocuments: number;
      evidenceHits: number;
      presenceMaps: number;
      processingReports: number;
    };
  };
  unresolvedIssues: {
    paragraphsWithoutScene: number;
    ambiguousEntities: number;
    validationFailures: number;
  };
  chapterStats: BookAnalysisChapterStatusDTO[];
  degraded: boolean;
  degradationReasons: string[];
  shouldPoll: boolean;
  pollIntervalMs: number;
}

export type BookAnalysisChapterStateDTO = "queued" | "running" | "completed" | "failed";

export interface BookAnalysisChapterStatusDTO {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  state: BookAnalysisChapterStateDTO;
  totalBlocks: number;
  checkedBlocks: number;
  remainingBlocks: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BookChatEvidenceDTO {
  kind: BookChatEvidenceKindDTO;
  sourceId: string;
  label: string;
  chapterOrderIndex?: number | null;
  snippet: string;
  score?: number | null;
}

export interface BookChatInlineCitationAnchorDTO {
  anchorId: string;
  quotes: BookQuoteListItemDTO[];
}

export interface BookChatAnswerItemDTO {
  id: string;
  ordinal: number | null;
  label: string;
  summary: string;
  linkedEntityIds: string[];
  linkedEvidenceIds: string[];
}

export interface BookChatReferenceResolutionDTO {
  resolvedEntityIds: string[];
  resolvedAnswerItemId: string | null;
  confidence: BookChatConfidenceDTO | null;
  reason: string | null;
  overrideMode: string | null;
  fallbackUsed: boolean;
}

export type BookChatMessageRoleDTO = "user" | "assistant";

export interface BookChatMessageDTO {
  id: string;
  role: BookChatMessageRoleDTO;
  content: string;
  rawAnswer: string | null;
  evidence: BookChatEvidenceDTO[];
  usedSources: string[];
  confidence: BookChatConfidenceDTO | null;
  mode: BookChatModeDTO | null;
  citations: BookChatCitationDTO[];
  inlineCitations: BookChatInlineCitationAnchorDTO[];
  answerItems: BookChatAnswerItemDTO[];
  referenceResolution: BookChatReferenceResolutionDTO | null;
  createdAt: string;
}

export interface BookChatSessionDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export interface BookChatCreateSessionRequestDTO {
  title?: string;
}

export interface BookChatCreateSessionResponseDTO {
  session: BookChatSessionDTO;
}

export interface BookChatSessionsResponseDTO {
  items: BookChatSessionDTO[];
}

export interface BookChatMessagesResponseDTO {
  items: BookChatMessageDTO[];
}

export interface BookChatStreamRequestDTO {
  message: string;
  topK?: number;
  entryContext?: BookChatEntryContextDTO;
}

export interface BookChatStreamFinalEventDTO {
  sessionId: string;
  messageId: string;
  answer: string;
  rawAnswer: string | null;
  evidence: BookChatEvidenceDTO[];
  usedSources: string[];
  confidence: BookChatConfidenceDTO | null;
  mode: BookChatModeDTO | null;
  citations: BookChunkCitationDTO[];
  inlineCitations: BookChatInlineCitationAnchorDTO[];
  answerItems: BookChatAnswerItemDTO[];
  referenceResolution: BookChatReferenceResolutionDTO | null;
}

export interface BookChatStreamEventDTO {
  type: "session" | "status" | "reasoning" | "token" | "final" | "error";
  sessionId?: string;
  text?: string;
  error?: string;
  final?: BookChatStreamFinalEventDTO;
}

type BookWithOwner = Book & {
  owner: Pick<User, "id" | "name" | "email" | "image">;
};

type BookCardProjection = BookWithOwner & {
  _count: {
    likes: number;
    bookCharacters: number;
    bookThemes: number;
    bookLocations: number;
  };
  likes: Pick<BookLike, "bookId">[];
};

export function resolveOwnerName(owner: Pick<User, "name" | "email">): string {
  const name = String(owner.name || "").trim();
  if (name) return name;
  const email = String(owner.email || "").trim();
  if (email) return email;
  return "Пользователь";
}

export function toBookOwnerDTO(owner: Pick<User, "id" | "name" | "email" | "image">): BookOwnerDTO {
  return {
    id: owner.id,
    name: resolveOwnerName(owner),
    image: owner.image || null,
  };
}

export function toBookCardDTO(book: BookCardProjection, viewerUserId?: string | null): BookCardDTO {
  const normalizedViewerUserId = String(viewerUserId || "").trim();
  const isViewerAuthenticated = Boolean(normalizedViewerUserId);
  const isOwner = isViewerAuthenticated && book.ownerUserId === normalizedViewerUserId;
  const hasLibraryEntry = isViewerAuthenticated && book.likes.length > 0;
  const isInLibrary = isOwner || hasLibraryEntry;
  const canAddToLibrary = isViewerAuthenticated && book.isPublic && !isOwner && !hasLibraryEntry;
  const canRemoveFromLibrary = isViewerAuthenticated && !isOwner && hasLibraryEntry;

  return {
    id: book.id,
    title: book.title,
    author: book.author || null,
    coverUrl: book.coverUrl || null,
    isPublic: book.isPublic,
    createdAt: book.createdAt.toISOString(),
    owner: toBookOwnerDTO(book.owner),
    status: "ready",
    chaptersCount: book.chapterCount,
    charactersCount: book._count.bookCharacters,
    themesCount: book._count.bookThemes,
    locationsCount: book._count.bookLocations,
    libraryUsersCount: book._count.likes,
    isInLibrary,
    canAddToLibrary,
    canRemoveFromLibrary,
    isOwner,
  };
}

export function toBookCoreDTO(book: BookWithOwner): BookCoreDTO {
  return {
    id: book.id,
    title: book.title,
    author: book.author || null,
    coverUrl: book.coverUrl || null,
    summary: book.summary || null,
    isPublic: book.isPublic,
    analysisState: book.analysisState,
    chapterCount: book.chapterCount,
    canManage: false,
    createdAt: book.createdAt.toISOString(),
    owner: toBookOwnerDTO(book.owner),
  };
}

export function toBookChapterDTO(chapter: BookChapter): BookChapterDTO {
  return {
    id: chapter.id,
    orderIndex: chapter.orderIndex,
    title: chapter.title,
    summary: chapter.summary || null,
  };
}


function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampShowcaseText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function asShowcaseThemeList(value: unknown): BookShowcaseThemeDTO[] {
  if (!Array.isArray(value)) return [];
  const out: BookShowcaseThemeDTO[] = [];
  for (const item of value) {
    const row = asObject(item);
    if (!row) continue;
    const name = clampShowcaseText(row.name, 100);
    const description = clampShowcaseText(row.description, 260);
    if (!name || !description) continue;
    out.push({ name, description });
    if (out.length >= 10) break;
  }
  return out;
}

function asShowcaseCharacterList(value: unknown): BookShowcaseCharacterDTO[] {
  if (!Array.isArray(value)) return [];
  const out: BookShowcaseCharacterDTO[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const row = asObject(item);
    if (!row) continue;
    const name = clampShowcaseText(row.name, 120);
    const description = clampShowcaseText(row.description, 260);
    const rankRaw = Number.parseInt(String(row.rank || ""), 10);
    const rank = Number.isFinite(rankRaw) && rankRaw > 0 ? rankRaw : index + 1;
    if (!name || !description) continue;
    out.push({ name, description, rank });
    if (out.length >= 10) break;
  }
  return out.sort((left, right) => left.rank - right.rank).map((item, index) => ({ ...item, rank: index + 1 }));
}

function asShowcaseEventList(value: unknown): BookShowcaseEventDTO[] {
  if (!Array.isArray(value)) return [];
  const out: BookShowcaseEventDTO[] = [];
  for (const item of value) {
    const row = asObject(item);
    if (!row) continue;
    const title = clampShowcaseText(row.title, 120);
    const importanceRaw = String(row.importance || "").trim().toLowerCase();
    const importance =
      importanceRaw === "critical" || importanceRaw === "high" || importanceRaw === "medium"
        ? (importanceRaw as "critical" | "high" | "medium")
        : null;
    const description = clampShowcaseText(row.description, 260);
    if (!title || !importance || !description) continue;
    out.push({ title, importance, description });
    if (out.length >= 10) break;
  }
  return out;
}

function asShowcaseQuoteList(value: unknown): BookShowcaseQuoteDTO[] {
  if (!Array.isArray(value)) return [];
  const out: BookShowcaseQuoteDTO[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = asObject(item);
    if (!row) continue;
    const text = clampShowcaseText(row.text, 360);
    const chapterOrderIndexRaw = Number.parseInt(String(row.chapterOrderIndex || ""), 10);
    const chapterOrderIndex = Number.isFinite(chapterOrderIndexRaw) && chapterOrderIndexRaw > 0 ? chapterOrderIndexRaw : null;
    const chapterTitle = clampShowcaseText(row.chapterTitle, 180) || null;
    if (!text || text.length < 10) continue;
    const dedupeKey = text.toLocaleLowerCase("ru");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      text,
      chapterOrderIndex,
      chapterTitle,
    });
    if (out.length >= 10) break;
  }
  return out;
}

function resolveShowcaseGenerationMode(value: unknown): "chat_blocks" | "fallback" | "unknown" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "chat_blocks") return "chat_blocks";
  if (normalized === "fallback") return "fallback";
  return "unknown";
}

const SHOWCASE_BLOCK_KEYS = ["summary", "themes", "characters", "events", "quotes"] as const;
type ShowcaseBlockKey = (typeof SHOWCASE_BLOCK_KEYS)[number];

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function toNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function asShowcaseBlockStats(value: unknown): BookShowcaseBlockStatsDTO {
  const row = asObject(value) || {};
  return {
    ok: Boolean(row.ok),
    usedFallback: Boolean(row.usedFallback),
    attempts: toNonNegativeInteger(row.attempts),
    elapsedMs: toNonNegativeInteger(row.elapsedMs),
    modelInputTokens: toNonNegativeInteger(row.modelInputTokens),
    modelOutputTokens: toNonNegativeInteger(row.modelOutputTokens),
    modelTotalTokens: toNonNegativeInteger(row.modelTotalTokens),
    embeddingInputTokens: toNonNegativeInteger(row.embeddingInputTokens),
    totalCostUsd: Number(toNonNegativeNumber(row.totalCostUsd).toFixed(8)),
    totalLatencyMs: toNonNegativeInteger(row.totalLatencyMs),
  };
}

function asShowcaseStats(value: unknown): BookShowcaseStatsDTO {
  const row = asObject(value) || {};
  const blocks = asObject(row.blocks) || {};

  const fallbackBlocks = Array.isArray(row.fallbackBlocks)
    ? row.fallbackBlocks
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item): item is ShowcaseBlockKey =>
          SHOWCASE_BLOCK_KEYS.some((blockKey) => blockKey === item)
        )
    : [];

  return {
    totalElapsedMs: toNonNegativeInteger(row.totalElapsedMs),
    fallbackBlocks,
    blocks: {
      summary: asShowcaseBlockStats(blocks.summary),
      themes: asShowcaseBlockStats(blocks.themes),
      characters: asShowcaseBlockStats(blocks.characters),
      events: asShowcaseBlockStats(blocks.events),
      quotes: asShowcaseBlockStats(blocks.quotes),
    },
  };
}

export function toBookShowcaseDTO(
  artifact: Pick<BookSummaryArtifact, "bookId" | "summary" | "metadataJson" | "updatedAt">
): BookShowcaseDTO | null {
  const metadata = asObject(artifact.metadataJson) || {};
  const showcaseSource = asObject(metadata.showcase) || metadata;
  const summarySource = asObject(showcaseSource.summary) || showcaseSource;

  const shortSummary = clampShowcaseText(summarySource.shortSummary || artifact.summary, 360);
  const mainIdea = clampShowcaseText(summarySource.mainIdea, 380);
  const themes = asShowcaseThemeList(showcaseSource.themes);
  const characters = asShowcaseCharacterList(showcaseSource.characters);
  const keyEvents = asShowcaseEventList(showcaseSource.keyEvents);
  const quotes = asShowcaseQuoteList(showcaseSource.quotes);
  const stats = asShowcaseStats(metadata.stats);

  if (!shortSummary && !mainIdea && themes.length === 0 && characters.length === 0 && keyEvents.length === 0 && quotes.length === 0) {
    return null;
  }

  return {
    bookId: artifact.bookId,
    summary: {
      shortSummary: shortSummary || "Краткая сводка временно недоступна.",
      mainIdea: mainIdea || "Основная идея временно недоступна.",
    },
    themes,
    characters,
    keyEvents,
    quotes,
    stats,
    generationMode: resolveShowcaseGenerationMode(metadata.generationMode),
    updatedAt: artifact.updatedAt.toISOString(),
  };
}

export function displayAuthor(author: string | null): string {
  const value = String(author || "").trim();
  return value || "Автор не указан";
}
