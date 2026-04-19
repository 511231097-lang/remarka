import type {
  Book,
  BookAnalysisState,
  BookChapter,
  BookCharacter,
  BookCharacterQuote,
  BookChatMessage,
  BookChatSession,
  BookLike,
  BookLocation,
  BookLocationQuote,
  BookLiteraryAnalysis,
  BookQuote,
  BookQuoteMention,
  BookQuoteMentionKind,
  BookQuoteTag,
  BookQuoteTagLink,
  BookQuoteType,
  BookTheme,
  BookThemeQuote,
  User,
} from "@prisma/client";

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
  likesCount: number;
  isLiked: boolean;
  canLike: boolean;
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

export interface BookLikeStateDTO {
  bookId: string;
  isLiked: boolean;
  likesCount: number;
}

export interface BookChapterDTO {
  id: string;
  orderIndex: number;
  title: string;
  summary: string | null;
}

export interface CharacterListItemDTO {
  id: string;
  name: string;
  role: string;
  description: string;
  arc: string;
  mentionCount: number;
}

export interface CharacterQuoteDTO {
  id: string;
  chapterOrderIndex: number;
  text: string;
  context: string;
}

export interface CharacterDetailDTO extends CharacterListItemDTO {
  firstAppearanceChapterOrder: number | null;
  quotes: CharacterQuoteDTO[];
}

export interface LocationListItemDTO {
  id: string;
  name: string;
  description: string;
  significance: string;
  mentionCount: number;
}

export interface LocationQuoteDTO {
  id: string;
  chapterOrderIndex: number;
  text: string;
  context: string;
}

export interface LocationDetailDTO extends LocationListItemDTO {
  firstAppearanceChapterOrder: number | null;
  quotes: LocationQuoteDTO[];
}

export interface ThemeListItemDTO {
  id: string;
  name: string;
  description: string;
  development: string;
  mentionCount: number;
}

export interface ThemeQuoteDTO {
  id: string;
  chapterOrderIndex: number;
  text: string;
  context: string;
}

export interface ThemeDetailDTO extends ThemeListItemDTO {
  firstAppearanceChapterOrder: number | null;
  quotes: ThemeQuoteDTO[];
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

export interface BookQuoteDetailDTO extends BookQuoteListItemDTO {
  retrievalScore: number | null;
}

export const LITERARY_SECTION_KEYS = [
  "what_is_really_going_on",
  "main_idea",
  "how_it_works",
  "hidden_details",
  "characters",
  "conflicts",
  "structure",
  "important_turns",
  "takeaways",
  "conclusion",
] as const;

export type LiterarySectionKeyDTO = (typeof LITERARY_SECTION_KEYS)[number];

export interface BookLiterarySectionDTO {
  key: LiterarySectionKeyDTO;
  title: string;
  summary: string;
  bodyMarkdown: string;
  bullets: string[];
  evidenceQuoteIds: string[];
  confidence: number;
  evidenceQuotes?: BookQuoteListItemDTO[];
}

export interface BookLiteraryAnalysisDTO {
  bookId: string;
  sections: Record<LiterarySectionKeyDTO, BookLiterarySectionDTO>;
  updatedAt: string;
}

export interface BookTokenUsageDTO {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface BookReportModelUsageDTO extends BookTokenUsageDTO {
  model: string;
  requests: number;
}

export interface BookReportChatSessionDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  usage: BookTokenUsageDTO;
  models: string[];
}

export interface BookReportAnalyzerStepDTO {
  key: string;
  label: string;
  state: BookAnalyzerStateDTO;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usage: BookTokenUsageDTO | null;
  models: string[];
  attempts: number | null;
  degraded: boolean;
  fallbackKind: string | null;
  lastReason: string | null;
  selectedModel: string | null;
  note: string | null;
}

export interface BookReportDTO {
  bookId: string;
  generatedAt: string;
  analysis: {
    totalSteps: number;
    completedSteps: number;
    runningSteps: number;
    failedSteps: number;
    pendingSteps: number;
    usage: BookTokenUsageDTO | null;
    steps: BookReportAnalyzerStepDTO[];
  };
  chat: {
    totalSessions: number;
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    usage: BookTokenUsageDTO;
    byModel: BookReportModelUsageDTO[];
    sessions: BookReportChatSessionDTO[];
  };
  notes: string[];
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
  sectionKey?: LiterarySectionKeyDTO;
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
  type: "session" | "status" | "token" | "final" | "error";
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

export function toBookCardDTO(book: BookCardProjection, viewerUserId: string): BookCardDTO {
  const isLiked = book.likes.length > 0;
  const canLike = book.isPublic && book.ownerUserId !== viewerUserId;

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
    likesCount: book._count.likes,
    isLiked,
    canLike,
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

export function toCharacterListItemDTO(character: BookCharacter): CharacterListItemDTO {
  return {
    id: character.id,
    name: character.name,
    role: character.role,
    description: character.description,
    arc: character.arc,
    mentionCount: character.mentionCount,
  };
}

export function toCharacterQuoteDTO(quote: BookCharacterQuote): CharacterQuoteDTO {
  return {
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    text: quote.text,
    context: quote.context,
  };
}

export function toLocationListItemDTO(location: BookLocation): LocationListItemDTO {
  return {
    id: location.id,
    name: location.name,
    description: location.description,
    significance: location.significance,
    mentionCount: location.mentionCount,
  };
}

export function toLocationQuoteDTO(quote: BookLocationQuote): LocationQuoteDTO {
  return {
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    text: quote.text,
    context: quote.context,
  };
}

export function toThemeListItemDTO(theme: BookTheme): ThemeListItemDTO {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    development: theme.development,
    mentionCount: theme.mentionCount,
  };
}

export function toThemeQuoteDTO(quote: BookThemeQuote): ThemeQuoteDTO {
  return {
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    text: quote.text,
    context: quote.context,
  };
}

type BookQuoteProjection = BookQuote & {
  tags: Pick<BookQuoteTagLink, "tag">[];
  mentions: BookQuoteMention[];
};

const LITERARY_SECTION_TITLE_BY_KEY: Record<LiterarySectionKeyDTO, string> = {
  what_is_really_going_on: "Что на самом деле происходит",
  main_idea: "Главная идея",
  how_it_works: "Как это работает",
  hidden_details: "Скрытые детали",
  characters: "Персонажи",
  conflicts: "Конфликты",
  structure: "Структура",
  important_turns: "Важные повороты",
  takeaways: "Что важно вынести",
  conclusion: "Вывод",
};

export function toBookQuoteMentionDTO(mention: BookQuoteMention): BookQuoteMentionDTO {
  return {
    kind: mention.kind,
    value: mention.value,
    normalizedValue: mention.normalizedValue,
    startChar: mention.startChar,
    endChar: mention.endChar,
    confidence: mention.confidence,
  };
}

export function toBookQuoteListItemDTO(quote: BookQuoteProjection): BookQuoteListItemDTO {
  const tags = Array.from(new Set(quote.tags.map((entry) => entry.tag)));
  const mentions = [...quote.mentions]
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (left.startChar !== right.startChar) return left.startChar - right.startChar;
      return left.value.localeCompare(right.value, "ru");
    })
    .map(toBookQuoteMentionDTO);

  return {
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    startChar: quote.startChar,
    endChar: quote.endChar,
    text: quote.text,
    type: quote.type,
    tags,
    confidence: quote.confidence,
    commentary: quote.commentary || null,
    mentions,
  };
}

function asChatCitation(value: unknown): BookChatCitationDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const chunkId = String(record.chunkId || "").trim();
  const text = String(record.text || "").trim();
  const chapterOrderIndex = Number(record.chapterOrderIndex);
  const startChar = Number(record.startChar);
  const endChar = Number(record.endChar);
  const score = Number(record.score);

  if (!chunkId || !text) return null;
  if (!Number.isFinite(chapterOrderIndex)) return null;
  if (!Number.isFinite(startChar) || !Number.isFinite(endChar)) return null;

  return {
    chunkId,
    chapterOrderIndex: Math.max(1, Math.floor(chapterOrderIndex)),
    startChar: Math.max(0, Math.floor(startChar)),
    endChar: Math.max(0, Math.floor(endChar)),
    score: Number.isFinite(score) ? score : 0,
    text,
  };
}

function asChatQuoteMention(value: unknown): BookQuoteMentionDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = String(record.kind || "").trim();
  const valueText = String(record.value || "").trim();
  const normalizedValue = String(record.normalizedValue || "").trim();
  const startChar = Number(record.startChar);
  const endChar = Number(record.endChar);
  const confidence = Number(record.confidence);

  if (kind !== "character" && kind !== "theme" && kind !== "location") return null;
  if (!valueText || !normalizedValue) return null;
  if (!Number.isFinite(startChar) || !Number.isFinite(endChar)) return null;

  return {
    kind,
    value: valueText,
    normalizedValue,
    startChar: Math.max(0, Math.floor(startChar)),
    endChar: Math.max(0, Math.floor(endChar)),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

function asBookQuoteType(value: unknown): BookQuoteTypeDTO | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "dialogue" ||
    normalized === "monologue" ||
    normalized === "narration" ||
    normalized === "description" ||
    normalized === "reflection" ||
    normalized === "action"
  ) {
    return normalized;
  }
  return null;
}

function asBookQuoteTag(value: unknown): BookQuoteTagDTO | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "conflict" ||
    normalized === "relationship" ||
    normalized === "identity" ||
    normalized === "morality" ||
    normalized === "power" ||
    normalized === "freedom" ||
    normalized === "fear" ||
    normalized === "guilt" ||
    normalized === "hope" ||
    normalized === "fate" ||
    normalized === "society" ||
    normalized === "violence" ||
    normalized === "love" ||
    normalized === "death" ||
    normalized === "faith"
  ) {
    return normalized;
  }
  return null;
}

function asBookQuoteListItem(value: unknown): BookQuoteListItemDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const text = String(record.text || "").trim();
  const type = asBookQuoteType(record.type);
  const chapterOrderIndex = Number(record.chapterOrderIndex);
  const startChar = Number(record.startChar);
  const endChar = Number(record.endChar);
  const confidence = Number(record.confidence);

  if (!id || !text || !type) return null;
  if (!Number.isFinite(chapterOrderIndex) || !Number.isFinite(startChar) || !Number.isFinite(endChar)) return null;

  const tags = Array.isArray(record.tags)
    ? record.tags.map(asBookQuoteTag).filter((item): item is BookQuoteTagDTO => Boolean(item))
    : [];
  const mentions = Array.isArray(record.mentions)
    ? record.mentions.map(asChatQuoteMention).filter((item): item is BookQuoteMentionDTO => Boolean(item))
    : [];

  return {
    id,
    chapterOrderIndex: Math.max(1, Math.floor(chapterOrderIndex)),
    startChar: Math.max(0, Math.floor(startChar)),
    endChar: Math.max(0, Math.floor(endChar)),
    text,
    type,
    tags,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    commentary: typeof record.commentary === "string" ? record.commentary.trim() || null : null,
    mentions,
  };
}

function asChatInlineCitation(value: unknown): BookChatInlineCitationAnchorDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const anchorId = String(record.anchorId || record.id || "").trim();
  if (!anchorId) return null;

  const quotes = Array.isArray(record.quotes)
    ? record.quotes.map(asBookQuoteListItem).filter((item): item is BookQuoteListItemDTO => Boolean(item))
    : [];
  if (quotes.length === 0) return null;

  return {
    anchorId,
    quotes: quotes.slice(0, 3),
  };
}

function asChatAnswerItem(value: unknown): BookChatAnswerItemDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const label = String(record.label || "").trim();
  const summary = String(record.summary || "").trim();
  const ordinalRaw = Number(record.ordinal);
  if (!id || !label || !summary) return null;

  return {
    id,
    ordinal: Number.isFinite(ordinalRaw) ? Math.max(1, Math.floor(ordinalRaw)) : null,
    label,
    summary,
    linkedEntityIds: normalizeStringArray(record.linkedEntityIds, 8),
    linkedEvidenceIds: normalizeStringArray(record.linkedEvidenceIds, 8),
  };
}

function asChatReferenceResolution(value: unknown): BookChatReferenceResolutionDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const resolvedAnswerItemId = typeof record.resolvedAnswerItemId === "string" ? record.resolvedAnswerItemId.trim() || null : null;
  const reason = typeof record.reason === "string" ? record.reason.trim() || null : null;
  const overrideMode = typeof record.overrideMode === "string" ? record.overrideMode.trim() || null : null;
  const fallbackUsed = Boolean(record.fallbackUsed);

  return {
    resolvedEntityIds: normalizeStringArray(record.resolvedEntityIds, 8),
    resolvedAnswerItemId,
    confidence: asChatConfidence(record.confidence),
    reason,
    overrideMode,
    fallbackUsed,
  };
}

function asChatConfidence(value: unknown): BookChatConfidenceDTO | null {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return null;
}

function asChatMode(value: unknown): BookChatModeDTO | null {
  if (value === "fast" || value === "expert" || value === "degraded") {
    return value;
  }
  return null;
}

function asChatEvidence(value: unknown): BookChatEvidenceDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = String(record.kind || "").trim();
  const sourceId = String(record.sourceId || "").trim();
  const label = String(record.label || "").trim();
  const snippet = String(record.snippet || "").trim();
  const chapterOrderIndex = Number(record.chapterOrderIndex);
  const score = Number(record.score);

  if (
    kind !== "scene" &&
    kind !== "event" &&
    kind !== "relation" &&
    kind !== "summary_artifact" &&
    kind !== "quote" &&
    kind !== "chapter_span" &&
    kind !== "character" &&
    kind !== "theme" &&
    kind !== "location" &&
    kind !== "literary_section"
  ) {
    return null;
  }

  if (!sourceId || !label || !snippet) return null;

  return {
    kind,
    sourceId,
    label,
    chapterOrderIndex: Number.isFinite(chapterOrderIndex) ? Math.max(1, Math.floor(chapterOrderIndex)) : null,
    snippet,
    score: Number.isFinite(score) ? score : null,
  };
}

function asChatEvidenceFromCitation(citation: BookChatCitationDTO): BookChatEvidenceDTO {
  return {
    kind: "chapter_span",
    sourceId: citation.chunkId,
    label: `Глава ${citation.chapterOrderIndex}, фрагмент`,
    chapterOrderIndex: citation.chapterOrderIndex,
    snippet: citation.text,
    score: citation.score,
  };
}

function normalizeChatUsedSources(value: unknown, evidence: BookChatEvidenceDTO[]): string[] {
  const source = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  if (out.length > 0) return out;

  for (const item of evidence) {
    if (seen.has(item.kind)) continue;
    seen.add(item.kind);
    out.push(item.kind);
  }

  return out;
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function toBookChatSessionDTO(session: BookChatSession): BookChatSessionDTO {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    lastMessageAt: session.lastMessageAt ? session.lastMessageAt.toISOString() : null,
  };
}

export function toBookChatMessageDTO(message: BookChatMessage): BookChatMessageDTO {
  const payload =
    message.citationsJson && typeof message.citationsJson === "object" && !Array.isArray(message.citationsJson)
      ? (message.citationsJson as Record<string, unknown>)
      : null;

  const rawCitations = Array.isArray(message.citationsJson)
    ? message.citationsJson
    : Array.isArray(payload?.citations)
      ? payload.citations
      : Array.isArray(payload?.legacyCitations)
        ? payload.legacyCitations
        : [];
  const citations = rawCitations.map(asChatCitation).filter((item): item is BookChatCitationDTO => Boolean(item));

  const rawEvidence = Array.isArray(payload?.evidence) ? payload.evidence : [];
  const evidence = rawEvidence
    .map(asChatEvidence)
    .filter((item): item is BookChatEvidenceDTO => Boolean(item));
  const normalizedEvidence = evidence.length > 0 ? evidence : citations.map(asChatEvidenceFromCitation);
  const usedSources = normalizeChatUsedSources(payload?.usedSources, normalizedEvidence);
  const confidence = asChatConfidence(payload?.confidence);
  const mode = asChatMode(payload?.mode);
  const inlineCitations = Array.isArray(payload?.inlineCitations)
    ? payload.inlineCitations
        .map(asChatInlineCitation)
        .filter((item): item is BookChatInlineCitationAnchorDTO => Boolean(item))
    : [];
  const answerItems = Array.isArray(payload?.answerItems)
    ? payload.answerItems.map(asChatAnswerItem).filter((item): item is BookChatAnswerItemDTO => Boolean(item))
    : [];
  const referenceResolution = asChatReferenceResolution(payload?.referenceResolution);

  const role: BookChatMessageRoleDTO = message.role === "assistant" ? "assistant" : "user";
  const rawAnswer =
    role === "assistant"
      ? typeof payload?.rawAnswer === "string" && payload.rawAnswer.trim()
        ? payload.rawAnswer.trim()
        : message.content
      : null;

  return {
    id: message.id,
    role,
    content: message.content,
    rawAnswer,
    evidence: normalizedEvidence,
    usedSources,
    confidence,
    mode,
    citations,
    inlineCitations,
    answerItems,
    referenceResolution,
    createdAt: message.createdAt.toISOString(),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringLike(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.toLowerCase() === "[object object]") return null;
    return trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const record = asObject(value);
  if (!record) return null;

  const candidate =
    (typeof record.fact === "string" ? record.fact : null) ||
    (typeof record.text === "string" ? record.text : null) ||
    (typeof record.value === "string" ? record.value : null) ||
    (typeof record.description === "string" ? record.description : null) ||
    (typeof record.ref === "string" ? record.ref : null) ||
    (typeof record.name === "string" ? record.name : null) ||
    (typeof record.title === "string" ? record.title : null) ||
    (typeof record.label === "string" ? record.label : null);

  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === "[object object]") return null;
  return trimmed;
}

function normalizeStringLikeList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = asStringLike(item);
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(text);
    if (out.length >= maxItems) break;
  }

  return out;
}

function normalizeLiterarySection(
  key: LiterarySectionKeyDTO,
  input: unknown
): BookLiterarySectionDTO {
  const record = asObject(input) || {};
  const title = String(record.title || "").trim() || LITERARY_SECTION_TITLE_BY_KEY[key];
  const summary =
    String(record.summary || "").trim() ||
    `Раздел «${LITERARY_SECTION_TITLE_BY_KEY[key]}» сформирован на основе фактов глав и паттернов книги.`;
  const bodyMarkdown = String(record.bodyMarkdown || record.body || summary).trim() || summary;

  const bullets = normalizeStringLikeList(record.bullets, 8);

  const evidenceQuoteIds = normalizeStringLikeList(record.evidenceQuoteIds, 24);

  const confidenceRaw = Number(record.confidence);
  const confidence =
    Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1
      ? confidenceRaw
      : 0.65;

  return {
    key,
    title,
    summary,
    bodyMarkdown,
    bullets,
    evidenceQuoteIds,
    confidence,
  };
}

export function toBookLiteraryAnalysisDTO(
  analysis: Pick<BookLiteraryAnalysis, "bookId" | "sectionsJson" | "updatedAt">
): BookLiteraryAnalysisDTO {
  const root = asObject(analysis.sectionsJson) || {};
  const sectionsSource = asObject(root.sections) || root;

  const sections = Object.fromEntries(
    LITERARY_SECTION_KEYS.map((key) => [key, normalizeLiterarySection(key, sectionsSource[key])])
  ) as Record<LiterarySectionKeyDTO, BookLiterarySectionDTO>;

  return {
    bookId: analysis.bookId,
    sections,
    updatedAt: analysis.updatedAt.toISOString(),
  };
}

export function displayAuthor(author: string | null): string {
  const value = String(author || "").trim();
  return value || "Автор не указан";
}
