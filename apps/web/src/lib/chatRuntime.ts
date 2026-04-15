import {
  BookChatFollowupRefsSchema,
  BookChatPlanSchema,
  BookChatTurnStateSchema,
  normalizeEntityName,
  type BookChatFollowupRefs,
  type BookChatPlan,
  type BookChatTurnState,
} from "@remarka/contracts";
import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import {
  toBookQuoteListItemDTO,
  type BookChatAnswerItemDTO,
  type BookChatConfidenceDTO,
  type BookChatEntryContextDTO,
  type BookChatEvidenceDTO,
  type BookChatInlineCitationAnchorDTO,
  type BookChatMessageDTO,
  type BookChatModeDTO,
  type BookChatReferenceResolutionDTO,
  type BookChunkCitationDTO,
  type BookQuoteListItemDTO,
  type LiterarySectionKeyDTO,
} from "@/lib/books";
import {
  buildBookChatReadiness,
  createEmptyAnalyzerStatus,
  mapReadinessToChatMode,
  normalizePipelineAnalyzers,
} from "@/lib/bookChatReadiness";
import { type InlineAnnotationCandidate, validateInlineCitationAnnotation } from "@/lib/chatInlineCitations";

type VertexEmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

interface HistoryTurn {
  role: BookChatMessageDTO["role"];
  content: string;
  payload?: Record<string, unknown> | null;
}

interface VertexEmbeddingPrediction {
  embeddings?: {
    values?: unknown;
  };
}

interface VertexEmbeddingResponse {
  predictions?: VertexEmbeddingPrediction[];
}

interface VertexGeneratePart {
  text?: string;
}

interface VertexGenerateCandidate {
  content?: {
    parts?: VertexGeneratePart[];
  };
}

interface VertexUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface VertexGenerateResponse {
  candidates?: VertexGenerateCandidate[];
  usageMetadata?: VertexUsageMetadata;
}

interface StaticBookContext {
  title: string;
  author: string | null;
  bookBrief: string | null;
  chatMode: BookChatModeDTO;
  readinessSummary: string;
}

interface ResolvedEntity {
  id: string;
  kind: "character" | "location" | "theme" | "group" | "object" | "motif" | "concept";
  name: string;
  normalizedName: string;
  summary: string;
  mentionCount: number;
}

interface PlannerContext {
  sectionKey: LiterarySectionKeyDTO | null;
  entryContext: BookChatEntryContextDTO;
  state: BookChatTurnState;
  recentUserTurns: string[];
  referenceResolution: BookChatReferenceResolutionDTO | null;
  resolvedAnswerItem: BookChatAnswerItemDTO | null;
}

interface TargetResolutionResult {
  focusEntities: ResolvedEntity[];
  unresolvedTargets: string[];
}

interface RetrievalBundle {
  directEvidence: BookChatEvidenceDTO[];
  contextEvidence: BookChatEvidenceDTO[];
  citations: BookChunkCitationDTO[];
  quoteCards: BookQuoteListItemDTO[];
  usedSources: string[];
  requiredFacts: Array<{ id: string; text: string }>;
  focusEntities: ResolvedEntity[];
  activeSceneIds: string[];
  activeEventIds: string[];
  activeRelationIds: string[];
  bundleStats: {
    scenes: number;
    events: number;
    relations: number;
    summaries: number;
    quotes: number;
    rawSpans: number;
  };
}

interface ManagedChatTurnResult {
  answer: string;
  rawAnswer: string;
  evidence: BookChatEvidenceDTO[];
  citations: BookChunkCitationDTO[];
  inlineCitations: BookChatInlineCitationAnchorDTO[];
  answerItems: BookChatAnswerItemDTO[];
  referenceResolution: BookChatReferenceResolutionDTO | null;
  usedSources: string[];
  confidence: BookChatConfidenceDTO;
  mode: BookChatModeDTO;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  intent: string;
  focusEntities: Array<{ kind: string; id: string; name: string; normalizedName: string }>;
  directEvidenceIds: string[];
  contextEvidenceIds: string[];
  activeIncidentIds: string[];
  activeEntityIds: string[];
  mustCarryFacts: string[];
  turnKind: "social" | "factual" | "analysis";
  turnState: BookChatTurnState;
  strategy: "default";
  planner: BookChatPlan;
  bundleStats: RetrievalBundle["bundleStats"];
  requiredFactIds: string[];
  usedEvidenceIds: string[];
  stateDelta: Record<string, unknown>;
  verifier: {
    passed: boolean;
    missingFactIds: string[];
    strippedClaims: string[];
  };
}

interface InlineAnnotationPayload {
  annotatedAnswerMarkdown: string;
  anchors: InlineAnnotationCandidate[];
}

type ReferenceResolverOverrideMode = "none" | "followup_entity" | "followup_item";

interface ReferenceResolverResult {
  resolvedEntityIds: string[];
  resolvedAnswerItemId: string | null;
  confidence: BookChatConfidenceDTO;
  reason: string | null;
  overrideMode: ReferenceResolverOverrideMode;
  fallbackUsed: boolean;
}

const QUOTE_SEARCH_STOPWORDS = new Set([
  "книга",
  "роман",
  "произведение",
  "показывает",
  "показано",
  "почему",
  "какой",
  "какая",
  "какие",
  "есть",
  "если",
  "ли",
  "это",
  "эта",
  "этой",
  "этот",
  "этом",
  "там",
  "где",
  "чем",
  "что",
  "кто",
  "как",
  "про",
  "его",
  "ее",
  "её",
  "них",
  "она",
  "они",
  "для",
  "или",
  "еще",
  "ещё",
  "время",
  "отношению",
  "мирному",
  "населению",
]);

const STATIC_BOOK_CONTEXT_TTL_MS = Math.max(10_000, Math.min(300_000, toInt(process.env.BOOK_CHAT_CONTEXT_TTL_MS, 20_000)));
const staticBookContextCache = new Map<string, { expiresAt: number; value: StaticBookContext; canChat: boolean }>();

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeModelAnswerWhitespace(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function clampText(value: string, maxChars: number): string {
  const text = compactWhitespace(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function isOverviewPlan(params: {
  plan: BookChatPlan;
  sectionKey: LiterarySectionKeyDTO | null;
  focusEntities: Array<{ id: string }>;
}): boolean {
  return (
    params.plan.intent === "analysis" &&
    params.plan.scope === "full_book" &&
    params.sectionKey === null &&
    params.focusEntities.length === 0
  );
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function clampInt(value: number, min: number, max: number): number {
  const int = Math.floor(Number(value));
  if (!Number.isFinite(int)) return min;
  return Math.max(min, Math.min(max, int));
}

function safeJsonParse<T = unknown>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const direct = safeJsonParse<Record<string, unknown>>(raw);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const sliced = raw.slice(start, end + 1);
  const parsed = safeJsonParse<Record<string, unknown>>(sliced);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function resolveVertexBaseUrl(): string {
  return String(process.env.VERTEX_BASE_URL || "https://aiplatform.googleapis.com").replace(/\/+$/, "");
}

function resolveVertexApiKey(): string {
  const apiKey = String(process.env.VERTEX_API_KEY || "").trim();
  if (!apiKey) throw new Error("VERTEX_API_KEY is required for chat runtime");
  return apiKey;
}

function resolveVertexProxySource(): string {
  return String(process.env.VERTEX_PROXY_SOURCE || process.env.TIMEWEB_PROXY_SOURCE || "remarka-web-vertex").trim();
}

function resolveEmbeddingModel(): { model: string; dimensions: number } {
  const model = String(process.env.VERTEX_EMBEDDING_MODEL || "gemini-embedding-001").trim() || "gemini-embedding-001";
  const dimensions = Math.max(128, Math.min(3072, toInt(process.env.VERTEX_EMBEDDING_DIM, 768)));
  return { model, dimensions };
}

function resolvePlannerModel(): string {
  return String(process.env.VERTEX_CHAT_PLANNER_MODEL || "gemini-3.1-flash-lite-preview").trim() || "gemini-3.1-flash-lite-preview";
}

function resolveChatModel(): string {
  return String(process.env.VERTEX_CHAT_MODEL || "gemini-3.1-flash-lite-preview").trim() || "gemini-3.1-flash-lite-preview";
}

function resolveChatMaxTokens(): number {
  return Math.max(256, Math.min(8192, toInt(process.env.VERTEX_CHAT_MAX_TOKENS, 1100)));
}

export function resolveChatTopK(input: unknown): number {
  const fallback = toInt(process.env.BOOK_CHAT_TOP_K, 12);
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input || "").trim(), 10);
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(24, fallback));
  return Math.max(1, Math.min(24, Math.floor(parsed)));
}

function parseMessagePayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeLegacyTurnStateInput(value: unknown): Record<string, unknown> {
  const record = parseMessagePayload(value) || {};
  const candidate = parseMessagePayload(record.turnState) || record;
  const normalized = { ...candidate };
  delete normalized.pronounAnchors;
  return normalized;
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = compactWhitespace(String(item || ""));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function asTurnState(value: unknown): BookChatTurnState {
  const parsed = BookChatTurnStateSchema.safeParse(normalizeLegacyTurnStateInput(value));
  if (parsed.success) return parsed.data;
  return BookChatTurnStateSchema.parse({});
}

function normalizeIdList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = compactWhitespace(String(item || ""));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function asFollowupAnswerItem(value: unknown): BookChatAnswerItemDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = compactWhitespace(String(record.id || ""));
  const label = compactWhitespace(String(record.label || ""));
  const summary = compactWhitespace(String(record.summary || ""));
  const ordinal = Number(record.ordinal);
  if (!id || !label || !summary) return null;
  return {
    id,
    ordinal: Number.isFinite(ordinal) ? Math.max(1, Math.floor(ordinal)) : null,
    label,
    summary,
    linkedEntityIds: normalizeIdList(record.linkedEntityIds, 8),
    linkedEvidenceIds: normalizeIdList(record.linkedEvidenceIds, 8),
  };
}

function asFollowupRefs(value: unknown): BookChatFollowupRefs | null {
  const record = parseMessagePayload(value);
  if (!record) return null;
  const normalized = {
    primaryEntityId: typeof record.primaryEntityId === "string" ? compactWhitespace(record.primaryEntityId) || null : null,
    activeEntityIds: normalizeIdList(record.activeEntityIds, 16),
    lastAssistantMessageId:
      typeof record.lastAssistantMessageId === "string" ? compactWhitespace(record.lastAssistantMessageId) || null : null,
    answerItems: Array.isArray(record.answerItems)
      ? record.answerItems.map(asFollowupAnswerItem).filter((item): item is BookChatAnswerItemDTO => Boolean(item))
      : [],
  };
  const parsed = BookChatFollowupRefsSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function buildEmptyReferenceResolution(): ReferenceResolverResult {
  return {
    resolvedEntityIds: [],
    resolvedAnswerItemId: null,
    confidence: "low",
    reason: null,
    overrideMode: "none",
    fallbackUsed: true,
  };
}

function sumTokenCounts(first: number | null, second: number | null): number | null {
  if (first === null && second === null) return null;
  return Number(first || 0) + Number(second || 0);
}

async function embedTextViaVertex(params: {
  text: string;
  taskType: VertexEmbeddingTaskType;
}): Promise<number[]> {
  const { model, dimensions } = resolveEmbeddingModel();
  const endpoint = `${resolveVertexBaseUrl()}/v1/publishers/google/models/${encodeURIComponent(
    model
  )}:predict?key=${encodeURIComponent(resolveVertexApiKey())}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-source": resolveVertexProxySource(),
    },
    body: JSON.stringify({
      instances: [
        {
          task_type: params.taskType,
          content: params.text,
        },
      ],
      parameters: {
        outputDimensionality: dimensions,
        autoTruncate: true,
      },
    }),
  });

  const text = await response.text();
  const parsed = safeJsonParse<VertexEmbeddingResponse>(text);
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
    throw new Error("Vertex embeddings response does not contain values");
  }

  const values = valuesRaw.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (values.length === 0) {
    throw new Error("Vertex embeddings response contains invalid vector values");
  }
  if (values.length === dimensions) return values;
  if (values.length > dimensions) return values.slice(0, dimensions);
  const out = [...values];
  while (out.length < dimensions) out.push(0);
  return out;
}

function toVectorLiteral(values: number[]): string {
  return `[${values
    .map((value) => {
      if (!Number.isFinite(value)) return "0";
      return String(value);
    })
    .join(",")}]`;
}

async function generateVertexContent(body: Record<string, unknown>, model = resolvePlannerModel()): Promise<VertexGenerateResponse> {
  const endpoint = `${resolveVertexBaseUrl()}/v1/publishers/google/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(resolveVertexApiKey())}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-source": resolveVertexProxySource(),
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const parsed = safeJsonParse<VertexGenerateResponse>(raw);

  if (!response.ok) {
    const message =
      (parsed &&
        typeof parsed === "object" &&
        (parsed as { error?: { message?: string } }).error?.message) ||
      raw ||
      `Vertex generateContent failed with status ${response.status}`;
    throw new Error(String(message));
  }

  return parsed || {};
}

function parseSseBlock(block: string): string | null {
  const lines = block.split(/\r?\n/g);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  return data;
}

function extractNextSseBlock(buffer: string): { block: string; rest: string } | null {
  const lfBoundary = buffer.indexOf("\n\n");
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  let boundary = -1;
  let boundaryLen = 0;
  if (lfBoundary >= 0 && crlfBoundary >= 0) {
    if (lfBoundary <= crlfBoundary) {
      boundary = lfBoundary;
      boundaryLen = 2;
    } else {
      boundary = crlfBoundary;
      boundaryLen = 4;
    }
  } else if (lfBoundary >= 0) {
    boundary = lfBoundary;
    boundaryLen = 2;
  } else if (crlfBoundary >= 0) {
    boundary = crlfBoundary;
    boundaryLen = 4;
  }
  if (boundary < 0) return null;
  return {
    block: buffer.slice(0, boundary),
    rest: buffer.slice(boundary + boundaryLen),
  };
}

async function streamVertexChatAnswer(params: {
  systemPrompt: string;
  userPrompt: string;
  onToken?: (token: string) => void;
  model?: string;
}): Promise<{
  answer: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}> {
  const model = String(params.model || resolveChatModel()).trim() || resolveChatModel();
  const endpoint = `${resolveVertexBaseUrl()}/v1/publishers/google/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(resolveVertexApiKey())}`;

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: params.userPrompt }],
      },
    ],
    systemInstruction: {
      role: "system",
      parts: [{ text: params.systemPrompt }],
    },
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: resolveChatMaxTokens(),
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-source": resolveVertexProxySource(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Vertex stream request failed with status ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Vertex stream body is empty");
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let answer = "";
  let cumulativeFromPayload = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const extracted = extractNextSseBlock(buffer);
      if (!extracted) break;
      buffer = extracted.rest;
      const data = parseSseBlock(extracted.block);
      if (!data) continue;
      const parsed = safeJsonParse<VertexGenerateResponse>(data);
      if (!parsed) continue;

      const partTexts = (parsed.candidates?.[0]?.content?.parts || [])
        .map((part) => String(part?.text || ""))
        .filter((text) => text.length > 0);
      const candidateText = partTexts.join("");
      if (candidateText) {
        let delta = "";
        if (candidateText.startsWith(cumulativeFromPayload)) {
          delta = candidateText.slice(cumulativeFromPayload.length);
          cumulativeFromPayload = candidateText;
        } else {
          delta = candidateText;
          cumulativeFromPayload += candidateText;
        }
        if (delta) {
          answer += delta;
          params.onToken?.(delta);
        }
      }

      const usage = parsed.usageMetadata || {};
      if (Number.isFinite(Number(usage.promptTokenCount))) promptTokens = Number(usage.promptTokenCount);
      if (Number.isFinite(Number(usage.candidatesTokenCount))) completionTokens = Number(usage.candidatesTokenCount);
    }
  }

  return {
    answer: normalizeModelAnswerWhitespace(answer),
    model,
    promptTokens,
    completionTokens,
  };
}

async function getStaticBookContext(bookId: string): Promise<{ context: StaticBookContext | null; canChat: boolean }> {
  const cached = staticBookContextCache.get(bookId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { context: cached.value, canChat: cached.canChat };
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      title: true,
      author: true,
      summary: true,
      analyzerTasks: {
        where: {
          analyzerType: {
            in: [
              "canonical_text",
              "scene_build",
              "entity_graph",
              "event_relation_graph",
              "summary_store",
              "evidence_store",
              "text_index",
              "quote_store",
            ],
          },
        },
        select: {
          analyzerType: true,
          state: true,
          error: true,
          startedAt: true,
          completedAt: true,
        },
      },
      _count: {
        select: {
          paragraphs: true,
          sentences: true,
          scenes: true,
          entities: true,
          eventsGraph: true,
          summaryArtifacts: true,
          evidenceLinks: true,
          bookQuotes: true,
        },
      },
    },
  });
  if (!book) return { context: null, canChat: false };

  const taskByType = new Map(book.analyzerTasks.map((task) => [task.analyzerType, task] as const));
  const serializeTask = (type: string) => {
    const task = taskByType.get(type as any);
    if (!task) return createEmptyAnalyzerStatus();
    return {
      state: task.state,
      error: task.error || null,
      startedAt: task.startedAt ? task.startedAt.toISOString() : null,
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    };
  };

  const analyzers = normalizePipelineAnalyzers({
    analyzers: {
      canonical_text: serializeTask("canonical_text"),
      scene_build: serializeTask("scene_build"),
      entity_graph: serializeTask("entity_graph"),
      event_relation_graph: serializeTask("event_relation_graph"),
      summary_store: serializeTask("summary_store"),
      evidence_store: serializeTask("evidence_store"),
      text_index: serializeTask("text_index"),
      quote_store: serializeTask("quote_store"),
    },
    presence: {
      paragraphs: book._count.paragraphs > 0,
      sentences: book._count.sentences > 0,
      scenes: book._count.scenes > 0,
      entities: book._count.entities > 0,
      events: book._count.eventsGraph > 0,
      summaries: book._count.summaryArtifacts > 0,
      evidence: book._count.evidenceLinks > 0,
      quotes: book._count.bookQuotes > 0,
    },
  });

  const readiness = buildBookChatReadiness(analyzers);
  const value: StaticBookContext = {
    title: book.title,
    author: book.author || null,
    bookBrief: clampText(book.summary || "", 320) || null,
    chatMode: mapReadinessToChatMode(readiness.mode),
    readinessSummary: readiness.summary,
  };
  staticBookContextCache.set(bookId, {
    value,
    canChat: readiness.canChat,
    expiresAt: now + STATIC_BOOK_CONTEXT_TTL_MS,
  });
  return { context: value, canChat: readiness.canChat };
}

async function loadSessionState(sessionId: string): Promise<BookChatTurnState> {
  const row = await prisma.bookChatSessionState.findUnique({
    where: { sessionId },
    select: { stateJson: true },
  });
  const parsed = BookChatTurnStateSchema.safeParse(normalizeLegacyTurnStateInput(row?.stateJson || {}));
  return parsed.success ? parsed.data : BookChatTurnStateSchema.parse({});
}

function summarizeRecentUserTurns(history: HistoryTurn[]): string[] {
  return history
    .filter((turn) => turn.role === "user")
    .map((turn) => compactWhitespace(turn.content))
    .filter(Boolean)
    .slice(-3);
}

function getLatestAssistantPayload(history: HistoryTurn[]): Record<string, unknown> | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn?.role !== "assistant") continue;
    const payload = parseMessagePayload(turn.payload);
    if (payload) return payload;
  }
  return null;
}

function extractPreviousFocusEntities(history: HistoryTurn[]): Array<{
  id: string;
  name: string;
  kind: string;
  summary: string | null;
}> {
  const payload = getLatestAssistantPayload(history);
  const raw = Array.isArray(payload?.focusEntities) ? payload.focusEntities : [];
  return raw
    .map((item) => {
      const record = parseMessagePayload(item);
      if (!record) return null;
      const id = compactWhitespace(String(record.id || ""));
      const name = compactWhitespace(String(record.name || ""));
      const kind = compactWhitespace(String(record.kind || ""));
      const summary = typeof record.summary === "string" ? compactWhitespace(record.summary) || null : null;
      if (!id || !name || !kind) return null;
      return { id, name, kind, summary };
    })
    .filter(
      (
        item
      ): item is {
        id: string;
        name: string;
        kind: string;
        summary: string | null;
      } => Boolean(item)
    )
    .slice(0, 8);
}

function resolvePreviousFollowupRefs(previousState: BookChatTurnState, history: HistoryTurn[]): BookChatFollowupRefs | null {
  if (previousState.followupRefs) return previousState.followupRefs;
  const lastAssistantPayload = getLatestAssistantPayload(history);
  return asFollowupRefs(lastAssistantPayload?.followupRefs);
}

function findAnswerItemById(
  followupRefs: BookChatFollowupRefs | null,
  itemId: string | null | undefined
): BookChatAnswerItemDTO | null {
  const resolvedId = compactWhitespace(String(itemId || ""));
  if (!followupRefs || !resolvedId) return null;
  return followupRefs.answerItems.find((item) => item.id === resolvedId) || null;
}

async function runReferenceResolver(params: {
  question: string;
  plannerContext: PlannerContext;
  followupRefs: BookChatFollowupRefs | null;
  previousFocusEntities: Array<{ id: string; name: string; kind: string; summary: string | null }>;
}): Promise<ReferenceResolverResult> {
  const followupRefs = params.followupRefs;
  if (!followupRefs || (followupRefs.answerItems.length === 0 && followupRefs.activeEntityIds.length === 0)) {
    return buildEmptyReferenceResolution();
  }

  const body = {
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: [
            "Ты resolver ссылок в диалоге о книге.",
            "Верни только JSON без пояснений.",
            "Тебе можно выбирать только ids из followupRefs прошлого ответа.",
            "Если текущий вопрос явно переключает тему на нового персонажа или новый объект, не удерживай старый контекст: верни пустое разрешение.",
            "Если вопрос продолжает предыдущий ход, выбери answerItem и/или entity ids из followupRefs.",
            "Не придумывай ids, которых нет во входе.",
          ].join("\n"),
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify(
              {
                question: params.question,
                recentUserTurns: params.plannerContext.recentUserTurns,
                turnState: {
                  lastIntent: params.plannerContext.state.lastIntent,
                  lastScope: params.plannerContext.state.lastScope,
                  lastUserQuestion: params.plannerContext.state.lastUserQuestion,
                },
                previousFocusEntities: params.previousFocusEntities,
                followupRefs,
                outputShape: {
                  resolvedEntityIds: ["entity-id"],
                  resolvedAnswerItemId: "item-1",
                  confidence: "high | medium | low",
                  reason: "short string",
                  overrideMode: "followup_entity | followup_item | none",
                },
              },
              null,
              2
            ),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
    },
  };

  try {
    const response = await generateVertexContent(body, resolvePlannerModel());
    const rawText = (response.candidates?.[0]?.content?.parts || []).map((part) => String(part.text || "")).join("");
    const parsed = extractJsonObject(rawText);
    const resolvedEntityIds = normalizeIdList(parsed?.resolvedEntityIds, 8).filter((item) => followupRefs.activeEntityIds.includes(item));
    const resolvedAnswerItemId = compactWhitespace(String(parsed?.resolvedAnswerItemId || "")) || null;
    const resolvedAnswerItem = findAnswerItemById(followupRefs, resolvedAnswerItemId);
    const derivedEntityIds =
      resolvedEntityIds.length > 0
        ? resolvedEntityIds
        : resolvedAnswerItem?.linkedEntityIds.filter((item) => followupRefs.activeEntityIds.includes(item)).slice(0, 8) || [];
    const confidence =
      parsed?.confidence === "high" || parsed?.confidence === "medium" || parsed?.confidence === "low"
        ? parsed.confidence
        : "low";
    const overrideMode: ReferenceResolverOverrideMode =
      parsed?.overrideMode === "followup_entity" || parsed?.overrideMode === "followup_item" ? parsed.overrideMode : "none";
    const reason = typeof parsed?.reason === "string" ? compactWhitespace(parsed.reason) || null : null;
    const hasResolution = Boolean(resolvedAnswerItem || derivedEntityIds.length > 0);

    if (!hasResolution || confidence === "low" || overrideMode === "none") {
      return {
        ...buildEmptyReferenceResolution(),
        reason,
      };
    }

    return {
      resolvedEntityIds: derivedEntityIds,
      resolvedAnswerItemId: resolvedAnswerItem?.id || null,
      confidence,
      reason,
      overrideMode,
      fallbackUsed: false,
    };
  } catch {
    return buildEmptyReferenceResolution();
  }
}

function resolveConversationEntityIds(params: {
  referenceResolution: BookChatReferenceResolutionDTO | null;
  turnState: BookChatTurnState;
}): string[] {
  const preferred =
    params.referenceResolution && !params.referenceResolution.fallbackUsed
      ? params.referenceResolution.resolvedEntityIds
      : params.turnState.activeEntityIds;
  return Array.from(new Set(preferred.map((item) => compactWhitespace(item)).filter(Boolean))).slice(0, 8);
}

async function runPlannerModel(params: {
  question: string;
  staticContext: StaticBookContext;
  plannerContext: PlannerContext;
}): Promise<BookChatPlan> {
  const prompts = buildPlannerPrompts(params);
  const body = {
    systemInstruction: {
      role: "system",
      parts: [{ text: prompts.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompts.userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
    },
  };

  const response = await generateVertexContent(body, resolvePlannerModel());
  const rawText = (response.candidates?.[0]?.content?.parts || []).map((part) => String(part.text || "")).join("");
  const parsed = extractJsonObject(rawText);
  const validated = BookChatPlanSchema.safeParse(parsed);
  if (validated.success) return validated.data;

  return BookChatPlanSchema.parse({
    intent: "analysis",
    targets: [],
    scope: "full_book",
    scopeMode: "book_only",
    timeRef: null,
    depth: "fast",
    needQuote: false,
    answerMode: "explain",
    lane: "fast",
    stateAction: "keep",
  });
}

function buildPlannerPrompts(params: {
  question: string;
  staticContext: StaticBookContext;
  plannerContext: PlannerContext;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    `Ты route/planner для чата по книге «${params.staticContext.title}».`,
    "Верни только JSON без пояснений.",
    "Нельзя использовать внутренние технические термины.",
    "Определи intent, targets, scope, scopeMode, timeRef, depth, needQuote, answerMode, lane, stateAction.",
    "social используй только если текущая реплика не просит ответа по книге: например благодарность, завершение разговора, короткое подтверждение, отказ от продолжения темы.",
    "scopeMode=book_only по умолчанию.",
    "scopeMode=book_plus_meta ставь только если пользователь явно просит контекст шире этой книги или прямо просит ответить вне рамок книги.",
    "targets не оставляй пустым, если пользователь спрашивает о конкретном персонаже, семье, существе, предмете, месте, событии или понятии.",
    "В targets клади короткие текстовые цели прямо из пользовательского запроса или из явно продолженного предыдущего ответа.",
    "Если вопрос общий о книге без конкретной цели, targets может быть пустым.",
    "Если пользователь просит выйти за рамки книги, все равно сохрани target, если вопрос о конкретном персонаже или объекте.",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      question: params.question,
      sectionKey: params.plannerContext.sectionKey,
      entryContext: params.plannerContext.entryContext,
      turnState: params.plannerContext.state,
      referenceResolution: params.plannerContext.referenceResolution,
      resolvedAnswerItem: params.plannerContext.resolvedAnswerItem,
      recentUserTurns: params.plannerContext.recentUserTurns,
      outputShape: {
        intent: "character | event | scene | chapter | compare | analysis | retelling | quote_proof | social",
        targets: ["short target from current user ask"],
        scope: "scene | chapter | full_book | unknown",
        scopeMode: "book_only | book_plus_meta",
        timeRef: "string | null",
        depth: "fast | deep",
        needQuote: false,
        answerMode: "factual | explain | compare | retell_scene | retell_chapter | deep_analysis | answer_with_proof",
        lane: "fast | deep",
        stateAction: "keep | narrow | reset",
      },
      examples: [
        {
          question: "Слушай, а Блек в этой книги встречается?",
          result: {
            intent: "character",
            targets: ["Блек"],
            scope: "full_book",
            scopeMode: "book_only",
            timeRef: null,
            depth: "fast",
            needQuote: false,
            answerMode: "factual",
            lane: "fast",
            stateAction: "keep",
          },
        },
        {
          question: "Ну а если исключить книгу, просто расскажи мне вне её?",
          result: {
            intent: "analysis",
            targets: [],
            scope: "unknown",
            scopeMode: "book_plus_meta",
            timeRef: null,
            depth: "fast",
            needQuote: false,
            answerMode: "explain",
            lane: "fast",
            stateAction: "keep",
          },
        },
        {
          question: "Слушай, а ты можешь хотя бы сказать когда появился Сириус Блек в книгах?",
          result: {
            intent: "character",
            targets: ["Сириус Блек"],
            scope: "full_book",
            scopeMode: "book_plus_meta",
            timeRef: null,
            depth: "fast",
            needQuote: false,
            answerMode: "factual",
            lane: "fast",
            stateAction: "keep",
          },
        },
        {
          question: "Но ты уже ответил на этот вопрос, больше не надо)",
          result: {
            intent: "social",
            targets: [],
            scope: "unknown",
            scopeMode: "book_only",
            timeRef: null,
            depth: "fast",
            needQuote: false,
            answerMode: "explain",
            lane: "fast",
            stateAction: "keep",
          },
        },
      ],
    },
    null,
    2
  );

  return { systemPrompt, userPrompt };
}

function mapEntityKindToEvidence(kind: ResolvedEntity["kind"]): "character" | "location" | "theme" {
  if (kind === "location") return "location";
  if (kind === "theme") return "theme";
  return "character";
}

async function resolveTargetEntities(params: {
  bookId: string;
  plan: BookChatPlan;
  turnState: BookChatTurnState;
  referenceResolution: BookChatReferenceResolutionDTO | null;
}): Promise<TargetResolutionResult> {
  const requestedTargets = Array.from(
    new Set(params.plan.targets.map((item) => compactWhitespace(item)).filter(Boolean))
  ).slice(0, 8);
  const activeEntityIds = resolveConversationEntityIds({
    referenceResolution: params.referenceResolution,
    turnState: params.turnState,
  });

  if (requestedTargets.length === 0) {
    const active = activeEntityIds;
    if (active.length === 0) {
      return {
        focusEntities: [],
        unresolvedTargets: [],
      };
    }
    const rows = await prisma.bookEntity.findMany({
      where: {
        bookId: params.bookId,
        id: { in: active },
      },
      orderBy: [{ mentionCount: "desc" }, { canonicalName: "asc" }],
    });
    return {
      focusEntities: rows.map((row) => ({
        id: row.id,
        kind: row.type,
        name: row.canonicalName,
        normalizedName: row.normalizedName,
        summary: row.summary,
        mentionCount: row.mentionCount,
      })),
      unresolvedTargets: [],
    };
  }

  const rows = await prisma.bookEntity.findMany({
    where: {
      bookId: params.bookId,
      OR: requestedTargets.flatMap((target) => {
        const normalized = normalizeEntityName(target);
        if (!normalized) return [];
        return [
          { normalizedName: { contains: normalized } },
          {
            aliases: {
              some: {
                normalizedAlias: { contains: normalized },
              },
            },
          },
        ];
      }),
    },
    include: {
      aliases: {
        select: {
          normalizedAlias: true,
        },
      },
    },
    orderBy: [{ mentionCount: "desc" }, { canonicalName: "asc" }],
    take: 8,
  });

  const out = rows.map((row) => ({
    id: row.id,
    kind: row.type,
    name: row.canonicalName,
    normalizedName: row.normalizedName,
    summary: row.summary,
    mentionCount: row.mentionCount,
  }));

  if (requestedTargets.length > 0 || out.length >= 4 || activeEntityIds.length === 0) {
    return {
      focusEntities: out,
      unresolvedTargets: requestedTargets.filter((target) => {
        const normalizedTarget = normalizeEntityName(target);
        if (!normalizedTarget) return false;
        return !rows.some((row) => {
          if (row.normalizedName.includes(normalizedTarget)) return true;
          return row.aliases.some((alias) => alias.normalizedAlias.includes(normalizedTarget));
        });
      }),
    };
  }

  const activeRows = await prisma.bookEntity.findMany({
    where: {
      bookId: params.bookId,
      id: { in: activeEntityIds },
    },
    orderBy: [{ mentionCount: "desc" }, { canonicalName: "asc" }],
    take: Math.max(0, 8 - out.length),
  });

  const seen = new Set(out.map((item) => item.id));
  for (const row of activeRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      kind: row.type,
      name: row.canonicalName,
      normalizedName: row.normalizedName,
      summary: row.summary,
      mentionCount: row.mentionCount,
    });
  }

  return {
    focusEntities: out,
    unresolvedTargets: requestedTargets.filter((target) => {
      const normalizedTarget = normalizeEntityName(target);
      if (!normalizedTarget) return false;
      return !rows.some((row) => {
        if (row.normalizedName.includes(normalizedTarget)) return true;
        return row.aliases.some((alias) => alias.normalizedAlias.includes(normalizedTarget));
      });
    }),
  };
}

async function searchChunks(params: {
  bookId: string;
  query: string;
  topK: number;
}): Promise<BookChunkCitationDTO[]> {
  const query = compactWhitespace(params.query);
  if (!query) return [];
  const vector = await embedTextViaVertex({
    text: query,
    taskType: "RETRIEVAL_QUERY",
  });
  const vectorLiteral = toVectorLiteral(vector);

  const rows = await prisma.$queryRaw<Array<{
    id: string;
    chapterOrderIndex: number;
    startChar: number;
    endChar: number;
    text: string;
    score: number | null;
  }>>`
    SELECT
      c."id" AS id,
      c."chapterOrderIndex" AS "chapterOrderIndex",
      c."startChar" AS "startChar",
      c."endChar" AS "endChar",
      c."text" AS text,
      (1 - (c."embedding" <=> ${vectorLiteral}::vector)) AS score
    FROM "BookChunk" c
    WHERE c."bookId" = ${params.bookId}
    ORDER BY c."embedding" <=> ${vectorLiteral}::vector ASC
    LIMIT ${params.topK}
  `;

  return rows
    .map((row) => ({
      chunkId: row.id,
      chapterOrderIndex: Math.max(1, Number(row.chapterOrderIndex || 1)),
      startChar: Math.max(0, Number(row.startChar || 0)),
      endChar: Math.max(0, Number(row.endChar || 0)),
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
      text: compactWhitespace(String(row.text || "")),
    }))
    .filter((item) => Boolean(item.chunkId && item.text));
}

function extractQuoteSearchTerms(params: {
  question: string;
  focusEntities: ResolvedEntity[];
}): string[] {
  const tokens = normalizeEntityName(params.question)
    .split(/\s+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && !QUOTE_SEARCH_STOPWORDS.has(item))
    .slice(0, 8);

  const entityTokens = params.focusEntities
    .flatMap((entity) => entity.normalizedName.split(/\s+/g))
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && !QUOTE_SEARCH_STOPWORDS.has(item))
    .slice(0, 8);

  return Array.from(new Set([...tokens, ...entityTokens])).slice(0, 8);
}

function scoreQuoteCandidate(params: {
  quote: BookQuoteListItemDTO;
  searchTerms: string[];
  focusEntities: ResolvedEntity[];
}): number {
  const corpus = normalizeLooseText(
    [params.quote.text, params.quote.commentary || "", ...params.quote.mentions.map((item) => item.normalizedValue)].join(" ")
  );
  const termHits = params.searchTerms.reduce((sum, term) => sum + (corpus.includes(term) ? 1 : 0), 0);
  const entityHits = params.focusEntities.reduce(
    (sum, entity) => sum + (corpus.includes(entity.normalizedName) ? 1 : 0),
    0
  );
  return params.quote.confidence + termHits * 0.15 + entityHits * 0.25;
}

async function searchRelevantQuotes(params: {
  bookId: string;
  question: string;
  focusEntities: ResolvedEntity[];
  maxItems: number;
}): Promise<BookQuoteListItemDTO[]> {
  const searchTerms = extractQuoteSearchTerms({
    question: params.question,
    focusEntities: params.focusEntities,
  });
  const normalizedEntityNames = Array.from(
    new Set(params.focusEntities.map((entity) => entity.normalizedName).filter(Boolean))
  ).slice(0, 8);

  const orClauses: Prisma.BookQuoteWhereInput[] = [];

  if (normalizedEntityNames.length > 0) {
    orClauses.push({
      mentions: {
        some: {
          normalizedValue: {
            in: normalizedEntityNames,
          },
        },
      },
    });
  }

  for (const term of searchTerms) {
    orClauses.push({ text: { contains: term, mode: "insensitive" } });
    orClauses.push({ commentary: { contains: term, mode: "insensitive" } });
  }

  if (orClauses.length === 0) return [];

  const rows = await prisma.bookQuote.findMany({
    where: {
      bookId: params.bookId,
      OR: orClauses,
    },
    include: {
      tags: {
        select: {
          tag: true,
        },
      },
      mentions: {
        orderBy: [{ confidence: "desc" }, { startChar: "asc" }],
      },
    },
    orderBy: [{ confidence: "desc" }, { chapterOrderIndex: "asc" }, { startChar: "asc" }],
    take: Math.max(params.maxItems * 4, 12),
  });

  return rows
    .map(toBookQuoteListItemDTO)
    .sort((left, right) => {
      const scoreDiff =
        scoreQuoteCandidate({ quote: right, searchTerms, focusEntities: params.focusEntities }) -
        scoreQuoteCandidate({ quote: left, searchTerms, focusEntities: params.focusEntities });
      if (scoreDiff !== 0) return scoreDiff;
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      return left.startChar - right.startChar;
    })
    .slice(0, params.maxItems);
}

function dedupeEvidence(evidence: BookChatEvidenceDTO[]): BookChatEvidenceDTO[] {
  const out: BookChatEvidenceDTO[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const key = `${item.kind}:${item.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runInlineQuoteAnnotationPass(params: {
  answer: string;
  quoteCards: BookQuoteListItemDTO[];
}): Promise<{
  annotatedAnswerMarkdown: string;
  inlineCitations: BookChatInlineCitationAnchorDTO[];
  promptTokens: number | null;
  completionTokens: number | null;
} | null> {
  const quoteCards = params.quoteCards.slice(0, 6);
  if (!params.answer.trim() || quoteCards.length === 0) return null;
  try {
    const model = resolveChatModel();
    const body = {
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: [
              "Ты annotator для литературного ответа.",
              "Верни только JSON без пояснений.",
              "Задача: аккуратно обернуть короткие фразы ответа в markdown-ссылки вида [фраза](cite:anchor-id).",
              "Используй только фразы, которые прямо поддержаны переданными цитатами.",
              "Режим: quotes only, sparse precise.",
              "Не переписывай ответ и не меняй его смысл.",
              "Если уверенных привязок мало, аннотируй только 1-3 фразы.",
              "Для каждого anchor укажи 1-3 quoteId только из переданного списка.",
            ].join("\n"),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify(
                {
                  answer: params.answer,
                  quotes: quoteCards.map((quote) => ({
                    quoteId: quote.id,
                    chapterOrderIndex: quote.chapterOrderIndex,
                    text: quote.text,
                    commentary: quote.commentary,
                    type: quote.type,
                  })),
                  outputShape: {
                    annotatedAnswerMarkdown: "string",
                    anchors: [{ anchorId: "a1", quoteIds: ["quote-id-1"] }],
                  },
                },
                null,
                2
              ),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: Math.min(1200, resolveChatMaxTokens()),
        responseMimeType: "application/json",
      },
    };

    const response = await generateVertexContent(body, model);
    const rawText = (response.candidates?.[0]?.content?.parts || []).map((part) => String(part.text || "")).join("");
    const parsed = extractJsonObject(rawText);
    const annotatedAnswerMarkdown =
      typeof parsed?.annotatedAnswerMarkdown === "string" ? parsed.annotatedAnswerMarkdown : "";
    const anchors = Array.isArray(parsed?.anchors)
      ? parsed.anchors
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const record = item as Record<string, unknown>;
            const anchorId = String(record.anchorId || record.id || "").trim();
            const quoteIds = Array.isArray(record.quoteIds)
              ? record.quoteIds.map((entry) => String(entry || "").trim()).filter(Boolean)
              : [];
            return anchorId ? { anchorId, quoteIds } : null;
          })
          .filter((item): item is InlineAnnotationCandidate => Boolean(item))
      : [];

    const validated = validateInlineCitationAnnotation({
      rawAnswer: params.answer,
      annotatedAnswerMarkdown,
      anchors,
      quoteCards,
    });

    if (!validated) return null;

    return {
      annotatedAnswerMarkdown: validated.annotatedAnswerMarkdown,
      inlineCitations: validated.inlineCitations,
      promptTokens: Number.isFinite(Number(response.usageMetadata?.promptTokenCount))
        ? Number(response.usageMetadata?.promptTokenCount)
        : null,
      completionTokens: Number.isFinite(Number(response.usageMetadata?.candidatesTokenCount))
        ? Number(response.usageMetadata?.candidatesTokenCount)
        : null,
    };
  } catch {
    return null;
  }
}

async function retrieveBundle(params: {
  bookId: string;
  question: string;
  plan: BookChatPlan;
  sectionKey: LiterarySectionKeyDTO | null;
  turnState: BookChatTurnState;
  focusEntities: ResolvedEntity[];
  referenceResolution: BookChatReferenceResolutionDTO | null;
  resolvedAnswerItem: BookChatAnswerItemDTO | null;
  topK: number;
}): Promise<RetrievalBundle> {
  if (params.plan.intent === "social") {
    return {
      directEvidence: [],
      contextEvidence: [],
      citations: [],
      quoteCards: [],
      usedSources: [],
      requiredFacts: [],
      focusEntities: params.focusEntities,
      activeSceneIds: [],
      activeEventIds: [],
      activeRelationIds: [],
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
    };
  }

  const focusEntityIds = params.focusEntities.map((entity) => entity.id);
  const referenceQuery = compactWhitespace(
    [
      params.question,
      params.referenceResolution && !params.referenceResolution.fallbackUsed ? params.resolvedAnswerItem?.summary || "" : "",
    ]
      .filter(Boolean)
      .join(" ")
  );
  const overviewTurn = isOverviewPlan({
    plan: params.plan,
    sectionKey: params.sectionKey,
    focusEntities: params.focusEntities,
  });
  const summaryWhereClauses: Prisma.BookSummaryArtifactWhereInput[] = [];
  if (params.sectionKey) {
    summaryWhereClauses.push({ key: params.sectionKey });
  }
  if (focusEntityIds.length > 0) {
    summaryWhereClauses.push({ entityId: { in: focusEntityIds } });
  }
  if (params.plan.intent === "analysis" && !overviewTurn) {
    summaryWhereClauses.push({ kind: "literary_section" });
  }
  if (params.plan.intent === "retelling") {
    summaryWhereClauses.push({ kind: "chapter_summary" });
  }
  if (overviewTurn) {
    summaryWhereClauses.push({ kind: "book_brief" }, { kind: "chapter_summary" });
  }

  const [entityEvents, lexicalScenes, relationEdges, summaryArtifacts, quoteCards] = await Promise.all([
    overviewTurn
      ? Promise.resolve([])
      : prisma.bookEvent.findMany({
          where: {
            bookId: params.bookId,
            OR:
              focusEntityIds.length > 0
                ? [
                    {
                      participants: {
                        some: {
                          entityId: { in: focusEntityIds },
                        },
                      },
                    },
                  ]
                : undefined,
          },
          include: {
            chapter: {
              select: { orderIndex: true },
            },
            participants: {
              include: {
                entity: {
                  select: { canonicalName: true, type: true },
                },
              },
            },
          },
          orderBy: [{ importance: "desc" }, { orderIndex: "asc" }],
          take: Math.max(4, Math.min(10, params.topK)),
        }),
    overviewTurn
      ? Promise.resolve<Array<{
          id: string;
          chapterOrderIndex: number;
          summary: string | null;
          text: string;
          score: number | null;
        }>>([])
      : prisma.$queryRaw<Array<{
          id: string;
          chapterOrderIndex: number;
          summary: string | null;
          text: string;
          score: number | null;
        }>>`
          SELECT
            s."id" AS id,
            c."orderIndex" AS "chapterOrderIndex",
            s."summary" AS summary,
            s."text" AS text,
            ts_rank_cd(
              to_tsvector('russian', COALESCE(s."title", '') || ' ' || COALESCE(s."summary", '') || ' ' || COALESCE(s."text", '')),
              websearch_to_tsquery('russian', ${compactWhitespace(referenceQuery || params.question)})
            ) AS score
          FROM "BookScene" s
          INNER JOIN "BookChapter" c ON c."id" = s."chapterId"
          WHERE s."bookId" = ${params.bookId}
          ORDER BY score DESC NULLS LAST, s."orderIndex" ASC
          LIMIT ${Math.max(4, Math.min(8, params.topK))}
        `,
    overviewTurn
      ? Promise.resolve([])
      : focusEntityIds.length >= 2
        ? prisma.bookRelationEdge.findMany({
            where: {
              bookId: params.bookId,
              OR: [
                {
                  fromEntityId: { in: focusEntityIds },
                  toEntityId: { in: focusEntityIds },
                },
              ],
            },
            include: {
              fromEntity: { select: { canonicalName: true } },
              toEntity: { select: { canonicalName: true } },
            },
            orderBy: [{ confidence: "desc" }],
            take: 6,
          })
        : prisma.bookRelationEdge.findMany({
            where: {
              bookId: params.bookId,
              OR:
                focusEntityIds.length > 0
                  ? [{ fromEntityId: { in: focusEntityIds } }, { toEntityId: { in: focusEntityIds } }]
                  : undefined,
            },
            include: {
              fromEntity: { select: { canonicalName: true } },
              toEntity: { select: { canonicalName: true } },
            },
            orderBy: [{ confidence: "desc" }],
            take: 4,
          }),
    prisma.bookSummaryArtifact.findMany({
      where: {
        bookId: params.bookId,
        OR: summaryWhereClauses.length > 0 ? summaryWhereClauses : undefined,
      },
      orderBy: [{ confidence: "desc" }, { title: "asc" }],
      take: 8,
    }),
    searchRelevantQuotes({
      bookId: params.bookId,
      question: referenceQuery || params.question,
      focusEntities: params.focusEntities,
      maxItems: params.plan.needQuote ? 6 : 4,
    }),
  ]);

  const rankedSummaryArtifacts = [...summaryArtifacts].sort((left, right) => {
    if (overviewTurn) {
      const rank = (kind: string) => {
        if (kind === "book_brief") return 0;
        if (kind === "chapter_summary") return 1;
        return 2;
      };
      const diff = rank(left.kind) - rank(right.kind);
      if (diff !== 0) return diff;
    }
    return right.confidence - left.confidence || left.title.localeCompare(right.title, "ru");
  });

  const activeSceneIds = Array.from(
    new Set(
      [
        ...entityEvents.map((event) => event.sceneId).filter((value): value is string => Boolean(value)),
        ...rankedSummaryArtifacts.map((item) => item.sceneId).filter((value): value is string => Boolean(value)),
        ...lexicalScenes.map((scene) => scene.id),
      ].slice(0, overviewTurn ? 0 : 8)
    )
  );
  const activeEventIds = overviewTurn ? [] : entityEvents.map((event) => event.id).slice(0, 8);
  const activeRelationIds = overviewTurn ? [] : relationEdges.map((relation) => relation.id).slice(0, 8);
  const preferredEvidenceIds = new Set(params.resolvedAnswerItem?.linkedEvidenceIds || []);
  const sortByPreferredEvidence = <T extends { sourceId: string; score?: number | null }>(items: T[]): T[] =>
    [...items].sort((left, right) => {
      const preferredDiff = Number(preferredEvidenceIds.has(right.sourceId)) - Number(preferredEvidenceIds.has(left.sourceId));
      if (preferredDiff !== 0) return preferredDiff;
      return Number(right.score || 0) - Number(left.score || 0);
    });

  const sceneEvidence = sortByPreferredEvidence(lexicalScenes.slice(0, 4).map((scene) => ({
    kind: "scene" as const,
    sourceId: scene.id,
    label: `Сцена · Глава ${scene.chapterOrderIndex}`,
    chapterOrderIndex: scene.chapterOrderIndex,
    snippet: clampText(scene.summary || scene.text, 320),
    score: Number(scene.score || 0),
  })));

  const eventEvidence = sortByPreferredEvidence(entityEvents.slice(0, 4).map((event) => ({
    kind: "event" as const,
    sourceId: event.id,
    label: event.title,
    chapterOrderIndex: event.chapter.orderIndex,
    snippet: clampText(event.summary, 320),
    score: event.importance,
  })));

  const relationEvidence = sortByPreferredEvidence(relationEdges.slice(0, 3).map((relation) => ({
    kind: "relation" as const,
    sourceId: relation.id,
    label: `${relation.fromEntity.canonicalName} ↔ ${relation.toEntity.canonicalName}`,
    chapterOrderIndex: null,
    snippet: clampText(relation.summary, 300),
    score: relation.confidence,
  })));

  const summaryEvidence = sortByPreferredEvidence(rankedSummaryArtifacts.slice(0, overviewTurn ? 5 : 4).map((artifact) => ({
    kind: "summary_artifact" as const,
    sourceId: artifact.id,
    label: artifact.title,
    chapterOrderIndex: null,
    snippet: clampText(artifact.summary, 320),
    score: artifact.confidence,
  })));

  const entityEvidence = params.focusEntities.slice(0, 3).map((entity) => ({
    kind: mapEntityKindToEvidence(entity.kind),
    sourceId: entity.id,
    label:
      entity.kind === "location"
        ? `Локация: ${entity.name}`
        : entity.kind === "theme"
          ? `Тема: ${entity.name}`
          : `Персонаж: ${entity.name}`,
    chapterOrderIndex: null,
    snippet: clampText(entity.summary || entity.name, 280),
    score: Math.min(1, entity.mentionCount / 20),
  }));

  const quoteEvidence = quoteCards.slice(0, params.plan.needQuote ? 4 : 2).map((quote) => ({
    kind: "quote" as const,
    sourceId: quote.id,
    label: `Глава ${quote.chapterOrderIndex}, цитата`,
    chapterOrderIndex: quote.chapterOrderIndex,
    snippet: clampText(quote.text, 320),
    score: quote.confidence,
  }));

  const fallbackCitations =
    sceneEvidence.length + eventEvidence.length + summaryEvidence.length > 0
      ? []
      : await searchChunks({
          bookId: params.bookId,
          query: params.question,
          topK: Math.max(3, Math.min(6, params.topK)),
        });

  const chunkEvidence = fallbackCitations.slice(0, 3).map((chunk) => ({
    kind: "chapter_span" as const,
    sourceId: chunk.chunkId,
    label: `Глава ${chunk.chapterOrderIndex}, фрагмент`,
    chapterOrderIndex: chunk.chapterOrderIndex,
    snippet: clampText(chunk.text, 320),
    score: chunk.score,
  }));

  const directEvidence = overviewTurn
    ? dedupeEvidence([...summaryEvidence]).slice(0, 4)
    : dedupeEvidence([
        ...eventEvidence,
        ...sceneEvidence,
        ...quoteEvidence,
        ...chunkEvidence,
      ]).slice(0, 8);

  const directKeySet = new Set(directEvidence.map((item) => `${item.kind}:${item.sourceId}`));
  const contextEvidence = dedupeEvidence(
    overviewTurn
      ? [...summaryEvidence.slice(1)]
      : [
          ...entityEvidence,
          ...summaryEvidence,
          ...relationEvidence,
        ]
  )
    .filter((item) => !directKeySet.has(`${item.kind}:${item.sourceId}`))
    .slice(0, 8);

  const requiredFacts = overviewTurn
    ? rankedSummaryArtifacts
        .filter((artifact) => artifact.kind === "book_brief" || artifact.kind === "chapter_summary")
        .slice(0, 2)
        .map((artifact) => ({ id: artifact.id, text: clampText(artifact.summary, 260) }))
    : [
        ...entityEvents.slice(0, 3).map((event) => ({ id: event.id, text: clampText(event.summary, 260) })),
        ...lexicalScenes.slice(0, 2).map((scene) => ({ id: scene.id, text: clampText(scene.summary || scene.text, 260) })),
      ].slice(0, 6);

  const usedSources = Array.from(new Set([...directEvidence, ...contextEvidence].map((item) => item.kind)));

  return {
    directEvidence,
    contextEvidence,
    citations: fallbackCitations.slice(0, 4),
    quoteCards,
    usedSources,
    requiredFacts,
    focusEntities: params.focusEntities,
    activeSceneIds,
    activeEventIds,
    activeRelationIds,
    bundleStats: {
      scenes: sceneEvidence.length,
      events: eventEvidence.length,
      relations: relationEvidence.length,
      summaries: summaryEvidence.length,
      quotes: quoteEvidence.length,
      rawSpans: chunkEvidence.length,
    },
  };
}

function buildAnswerPrompt(params: {
  question: string;
  staticContext: StaticBookContext;
  plan: BookChatPlan;
  plannerContext: PlannerContext;
  bundle: RetrievalBundle;
  targetResolution: TargetResolutionResult;
}): { systemPrompt: string; userPrompt: string } {
  const overviewTurn = isOverviewPlan({
    plan: params.plan,
    sectionKey: params.plannerContext.sectionKey,
    focusEntities: params.bundle.focusEntities,
  });
  const systemPrompt = [
    `Ты эксперт по книге «${params.staticContext.title}»${params.staticContext.author ? ` (${params.staticContext.author})` : ""}.`,
    "Отвечай по-русски, естественно и без технических терминов внутренней реализации.",
    "Не упоминай retrieval, embeddings, planner, graph, chunk, vector search и внутренние id.",
    "Отвечай только на основе материалов этой книги.",
    "Не добавляй сведения из других книг цикла, экранизаций, интервью, биографии автора или общего канона, если это явно не разрешено.",
    params.plan.scopeMode === "book_plus_meta"
      ? "Сначала дай ответ строго в рамках этой книги. Если нужен внешний контекст, вынеси его в отдельный блок с пометкой «Вне рамок этой книги»."
      : "Если в материалах этой книги нет нужного персонажа, факта или линии, прямо скажи, что в этой книге этого нет или это не подтверждается. Не компенсируй пробел знаниями извне.",
    params.targetResolution.unresolvedTargets.length > 0
      ? `Ненайденные цели в материалах этой книги: ${params.targetResolution.unresolvedTargets.join(", ")}.`
      : null,
    "Сначала ответь прямо на вопрос пользователя.",
    "Потом, если это действительно помогает, добавь короткий экспертный комментарий.",
    "Если перечисляешь этапы, причины или пункты, оформляй их как markdown-список: каждый пункт с новой строки.",
    "Не сливай список и экспертный комментарий в один абзац.",
    overviewTurn ? "Если вопрос общий о книге, начни с краткого общего синопсиса в 2-3 предложениях и не стартуй с одной сцены." : null,
    "Прямые факты и сцены важнее интерпретации.",
    "Если вопрос factual, не теряй последовательность событий.",
    "Если материалов для уверенного ответа мало, прямо разделяй: что точно видно и что остаётся предположением.",
    params.plan.answerMode === "answer_with_proof"
      ? "Если нужны доказательства, опирайся на переданные evidenceSpans и optionalQuotes, не придумывай новые цитаты."
      : "Цитаты используй только если они уже переданы как optionalQuotes.",
  ]
    .filter(Boolean)
    .join("\n");

  const summaryItems = dedupeEvidence([
    ...params.bundle.directEvidence.filter((item) => item.kind === "summary_artifact"),
    ...params.bundle.contextEvidence.filter((item) => item.kind === "summary_artifact"),
  ]);

  const userPrompt = JSON.stringify(
    {
      question: params.question,
      plan: params.plan,
      sessionState: params.plannerContext.state,
      referenceResolution: params.plannerContext.referenceResolution,
      resolvedAnswerItem: params.plannerContext.resolvedAnswerItem,
      scopeMode: params.plan.scopeMode,
      unresolvedTargets: params.targetResolution.unresolvedTargets,
      queryType: params.plan.answerMode,
      facts: params.bundle.requiredFacts,
      focusEntities: params.bundle.focusEntities.map((entity) => ({
        kind: entity.kind,
        name: entity.name,
        summary: clampText(entity.summary, 180),
      })),
      sceneSummaries: params.bundle.directEvidence.filter((item) => item.kind === "scene"),
      timeline: params.bundle.directEvidence.filter((item) => item.kind === "event"),
      relations: params.bundle.contextEvidence.filter((item) => item.kind === "relation"),
      summaries: summaryItems,
      evidenceSpans: [
        ...params.bundle.directEvidence.filter((item) => item.kind === "chapter_span"),
        ...params.bundle.directEvidence.filter((item) => item.kind === "quote"),
      ],
      optionalQuotes: params.bundle.quoteCards.slice(0, params.plan.needQuote ? 4 : 2).map((quote) => ({
        id: quote.id,
        chapterOrderIndex: quote.chapterOrderIndex,
        text: clampText(quote.text, 260),
        commentary: quote.commentary,
        type: quote.type,
      })),
      constraints: {
        keepRequiredFacts: params.bundle.requiredFacts.map((item) => item.id),
        brevity: params.plan.lane === "fast" ? "compact" : "balanced",
        allowMetaOutsideBook: params.plan.scopeMode === "book_plus_meta",
      },
    },
    null,
    2
  );

  return { systemPrompt, userPrompt };
}

function normalizeLooseText(value: string): string {
  return compactWhitespace(String(value || "").toLowerCase());
}

function tokenize(value: string): string[] {
  return normalizeEntityName(value).split(/\s+/g).map((item) => item.trim()).filter((item) => item.length >= 3);
}

function isFactCovered(answer: string, fact: string): boolean {
  const corpus = normalizeLooseText(answer);
  const tokens = tokenize(fact);
  if (tokens.length === 0) return corpus.includes(normalizeLooseText(fact));
  const hits = tokens.filter((token) => corpus.includes(token));
  return hits.length >= Math.min(2, tokens.length);
}

function verifyAnswer(params: {
  answer: string;
  requiredFacts: Array<{ id: string; text: string }>;
}): {
  answer: string;
  passed: boolean;
  missingFactIds: string[];
  strippedClaims: string[];
} {
  const missing = params.requiredFacts.filter((fact) => !isFactCovered(params.answer, fact.text));
  if (missing.length === 0) {
    return {
      answer: params.answer,
      passed: true,
      missingFactIds: [],
      strippedClaims: [],
    };
  }

  const currentAnswer = compactWhitespace(params.answer);
  const repaired =
    currentAnswer.length > 0
      ? params.answer
      : `Коротко по фактам: ${missing
          .slice(0, 2)
          .map((fact) => fact.text)
          .join(" ")}`;
  return {
    answer: repaired,
    passed: false,
    missingFactIds: missing.map((fact) => fact.id),
    strippedClaims: [],
  };
}

function resolveConfidence(params: {
  plan: BookChatPlan;
  bundle: RetrievalBundle;
  verifier: ReturnType<typeof verifyAnswer>;
}): BookChatConfidenceDTO {
  if (params.plan.intent === "social") return "high";
  if (!params.verifier.passed) return params.bundle.directEvidence.length >= 2 ? "medium" : "low";
  const directKinds = new Set(params.bundle.directEvidence.map((item) => item.kind));
  if ((directKinds.has("event") || directKinds.has("scene")) && (directKinds.has("quote") || directKinds.has("chapter_span"))) {
    return "high";
  }
  if (params.bundle.directEvidence.length > 0 || params.bundle.contextEvidence.length > 0) return "medium";
  return "low";
}

function stripAnswerItemMarkdown(value: string): string {
  return compactWhitespace(
    String(value || "")
      .replace(/\[([^\]]+)\]\(cite:[^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
  );
}

function extractStructuredAnswerItems(answer: string): Array<{ ordinal: number | null; text: string }> {
  const lines = String(answer || "").replace(/\r\n?/g, "\n").split("\n");
  const bulletPattern = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
  const bulletItems: string[] = [];
  let currentBullet: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const bulletMatch = line.match(bulletPattern);
    if (bulletMatch) {
      if (currentBullet && currentBullet.length > 0) {
        bulletItems.push(currentBullet.join(" ").trim());
      }
      currentBullet = [bulletMatch[1] || ""];
      continue;
    }

    if (currentBullet) {
      if (!line.trim()) {
        bulletItems.push(currentBullet.join(" ").trim());
        currentBullet = null;
        continue;
      }
      currentBullet.push(line.trim());
    }
  }

  if (currentBullet && currentBullet.length > 0) {
    bulletItems.push(currentBullet.join(" ").trim());
  }

  const normalizedBullets = bulletItems.map(stripAnswerItemMarkdown).filter(Boolean);
  if (normalizedBullets.length > 0) {
    return normalizedBullets.slice(0, 8).map((text, index) => ({
      ordinal: index + 1,
      text,
    }));
  }

  return String(answer || "")
    .split(/\n{2,}/)
    .map(stripAnswerItemMarkdown)
    .filter(Boolean)
    .slice(0, 8)
    .map((text, index) => ({
      ordinal: index + 1,
      text,
    }));
}

function deriveAnswerItemLabel(text: string): string {
  const clean = stripAnswerItemMarkdown(text);
  const firstSentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  return clampText(firstSentence, 180) || clampText(clean, 180);
}

function linkAnswerItemEntities(params: {
  itemText: string;
  focusEntities: ResolvedEntity[];
}): string[] {
  if (params.focusEntities.length === 1) {
    return [params.focusEntities[0].id];
  }

  const corpus = normalizeLooseText(params.itemText);
  const scored = params.focusEntities
    .map((entity) => {
      const direct = corpus.includes(entity.normalizedName) ? 3 : 0;
      const tokenHits = entity.normalizedName
        .split(/\s+/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 4)
        .reduce((sum, token) => sum + (corpus.includes(token) ? 1 : 0), 0);
      return {
        id: entity.id,
        score: direct + tokenHits,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored.slice(0, 3).map((item) => item.id);
}

function linkAnswerItemEvidence(params: {
  itemText: string;
  linkedEntityIds: string[];
  evidence: BookChatEvidenceDTO[];
}): string[] {
  const tokens = tokenize(params.itemText).filter((item) => !QUOTE_SEARCH_STOPWORDS.has(item)).slice(0, 12);
  const scored = params.evidence
    .map((evidence) => {
      const corpus = normalizeLooseText(`${evidence.label} ${evidence.snippet}`);
      const tokenHits = tokens.reduce((sum, token) => sum + (corpus.includes(token) ? 1 : 0), 0);
      const entityBoost = params.linkedEntityIds.includes(evidence.sourceId) ? 3 : 0;
      return {
        id: evidence.sourceId,
        score: tokenHits + entityBoost,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length > 0) {
    return Array.from(new Set(scored.slice(0, 4).map((item) => item.id)));
  }

  return params.evidence.slice(0, 2).map((item) => item.sourceId);
}

function buildAnswerItems(params: {
  answer: string;
  focusEntities: ResolvedEntity[];
  evidence: BookChatEvidenceDTO[];
}): BookChatAnswerItemDTO[] {
  return extractStructuredAnswerItems(params.answer).map((item, index) => {
    const linkedEntityIds = linkAnswerItemEntities({
      itemText: item.text,
      focusEntities: params.focusEntities,
    });
    const linkedEvidenceIds = linkAnswerItemEvidence({
      itemText: item.text,
      linkedEntityIds,
      evidence: params.evidence,
    });

    return {
      id: `item-${index + 1}`,
      ordinal: item.ordinal,
      label: deriveAnswerItemLabel(item.text),
      summary: clampText(item.text, 360),
      linkedEntityIds,
      linkedEvidenceIds,
    };
  });
}

function buildFollowupRefs(params: {
  focusEntities: ResolvedEntity[];
  answerItems: BookChatAnswerItemDTO[];
}): BookChatFollowupRefs | null {
  const activeEntityIds = params.focusEntities.map((entity) => entity.id).slice(0, 16);
  if (activeEntityIds.length === 0 && params.answerItems.length === 0) {
    return null;
  }

  return BookChatFollowupRefsSchema.parse({
    primaryEntityId: activeEntityIds[0] || null,
    activeEntityIds,
    lastAssistantMessageId: null,
    answerItems: params.answerItems,
  });
}

export function attachAssistantMessageIdToTurnState(state: BookChatTurnState, assistantMessageId: string): BookChatTurnState {
  if (!state.followupRefs) return state;
  return BookChatTurnStateSchema.parse({
    ...state,
    followupRefs: {
      ...state.followupRefs,
      lastAssistantMessageId: compactWhitespace(assistantMessageId) || null,
    },
  });
}

function buildNextTurnState(params: {
  previous: BookChatTurnState;
  plan: BookChatPlan;
  question: string;
  sectionKey: LiterarySectionKeyDTO | null;
  bundle: RetrievalBundle;
  followupRefs: BookChatFollowupRefs | null;
}): BookChatTurnState {
  const overviewTurn = isOverviewPlan({
    plan: params.plan,
    sectionKey: params.sectionKey,
    focusEntities: params.bundle.focusEntities,
  });
  const base =
    params.plan.stateAction === "reset"
      ? BookChatTurnStateSchema.parse({})
      : params.plan.stateAction === "narrow"
        ? {
            ...params.previous,
            activeRelationIds: [],
            activeSceneIds: [],
          }
        : params.previous;

  return BookChatTurnStateSchema.parse({
    ...base,
    activeEntityIds: params.bundle.focusEntities.map((entity) => entity.id).slice(0, 8),
    activeSceneIds: overviewTurn ? [] : params.bundle.activeSceneIds.slice(0, 8),
    activeEventIds: overviewTurn ? [] : params.bundle.activeEventIds.slice(0, 8),
    activeRelationIds: overviewTurn ? [] : params.bundle.activeRelationIds.slice(0, 8),
    lastIntent: params.plan.intent,
    lastScope: params.plan.scope,
    lastAnswerMode: params.plan.answerMode,
    lastCompareSet:
      params.plan.intent === "compare"
        ? params.bundle.focusEntities.map((entity) => entity.id).slice(0, 6)
        : base.lastCompareSet,
    followupRefs: params.followupRefs,
    sectionContext: params.sectionKey,
    lastUserQuestion: params.question,
  });
}

function buildStateDelta(previous: BookChatTurnState, next: BookChatTurnState): Record<string, unknown> {
  const diffList = (before: string[], after: string[]) => {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
      added: after.filter((item) => !beforeSet.has(item)),
      removed: before.filter((item) => !afterSet.has(item)),
    };
  };

  return {
    activeEntityIds: diffList(previous.activeEntityIds, next.activeEntityIds),
    activeSceneIds: diffList(previous.activeSceneIds, next.activeSceneIds),
    activeEventIds: diffList(previous.activeEventIds, next.activeEventIds),
    activeRelationIds: diffList(previous.activeRelationIds, next.activeRelationIds),
    lastIntent: { before: previous.lastIntent, after: next.lastIntent },
    lastScope: { before: previous.lastScope, after: next.lastScope },
    lastAnswerMode: { before: previous.lastAnswerMode, after: next.lastAnswerMode },
    followupRefs: {
      beforePrimaryEntityId: previous.followupRefs?.primaryEntityId || null,
      afterPrimaryEntityId: next.followupRefs?.primaryEntityId || null,
      beforeAnswerItemIds: previous.followupRefs?.answerItems.map((item) => item.id) || [],
      afterAnswerItemIds: next.followupRefs?.answerItems.map((item) => item.id) || [],
    },
    sectionContext: { before: previous.sectionContext, after: next.sectionContext },
  };
}

function sanitizeChatAnswer(answer: string): string {
  return String(answer || "")
    .replace(/\[c:[^\]]+\]/g, "")
    .replace(/\bchunks?\b/gi, "фрагменты")
    .replace(/\bчанк(?:и|ов|ам|ами)?\b/gi, "фрагменты")
    .replace(/\bvector search\b/gi, "по тексту книги")
    .replace(/\bretrieval\b/gi, "по материалам книги")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runManagedBookChatTurn(params: {
  sessionId: string;
  bookId: string;
  question: string;
  history: HistoryTurn[];
  topK: number;
  sectionKey?: LiterarySectionKeyDTO | null;
  entryContext?: BookChatEntryContextDTO;
  onToken?: (token: string) => void;
}): Promise<ManagedChatTurnResult> {
  const question = compactWhitespace(params.question);
  const entryContext = params.entryContext || "full_chat";
  const sectionKey = params.sectionKey || null;

  if (!question) {
    const emptyState = BookChatTurnStateSchema.parse({});
    return {
      answer: "",
      rawAnswer: "",
      evidence: [],
      citations: [],
      inlineCitations: [],
      answerItems: [],
      referenceResolution: null,
      usedSources: [],
      confidence: "low",
      mode: "fast",
      model: null,
      promptTokens: null,
      completionTokens: null,
      intent: "social",
      focusEntities: [],
      directEvidenceIds: [],
      contextEvidenceIds: [],
      activeIncidentIds: [],
      activeEntityIds: [],
      mustCarryFacts: [],
      turnKind: "social",
      turnState: emptyState,
      strategy: "default",
      planner: BookChatPlanSchema.parse({
        intent: "social",
        targets: [],
        scope: "unknown",
        scopeMode: "book_only",
        timeRef: null,
        depth: "fast",
        needQuote: false,
        answerMode: "factual",
        lane: "fast",
        stateAction: "keep",
      }),
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
      requiredFactIds: [],
      usedEvidenceIds: [],
      stateDelta: {},
      verifier: { passed: true, missingFactIds: [], strippedClaims: [] },
    };
  }

  const [{ context: staticContext, canChat }, previousState] = await Promise.all([
    getStaticBookContext(params.bookId),
    loadSessionState(params.sessionId),
  ]);

  if (!staticContext) {
    const emptyState = BookChatTurnStateSchema.parse({});
    return {
      answer: "Не удалось загрузить материалы книги для ответа. Попробуйте ещё раз.",
      rawAnswer: "Не удалось загрузить материалы книги для ответа. Попробуйте ещё раз.",
      evidence: [],
      citations: [],
      inlineCitations: [],
      answerItems: [],
      referenceResolution: null,
      usedSources: [],
      confidence: "low",
      mode: "degraded",
      model: null,
      promptTokens: null,
      completionTokens: null,
      intent: "analysis",
      focusEntities: [],
      directEvidenceIds: [],
      contextEvidenceIds: [],
      activeIncidentIds: [],
      activeEntityIds: [],
      mustCarryFacts: [],
      turnKind: "analysis",
      turnState: emptyState,
      strategy: "default",
      planner: BookChatPlanSchema.parse({
        intent: "analysis",
        targets: [],
        scope: "unknown",
        scopeMode: "book_only",
        timeRef: null,
        depth: "fast",
        needQuote: false,
        answerMode: "explain",
        lane: "fast",
        stateAction: "keep",
      }),
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
      requiredFactIds: [],
      usedEvidenceIds: [],
      stateDelta: {},
      verifier: { passed: false, missingFactIds: [], strippedClaims: [] },
    };
  }

  if (!canChat) {
    return {
      answer: staticContext.readinessSummary,
      rawAnswer: staticContext.readinessSummary,
      evidence: [],
      citations: [],
      inlineCitations: [],
      answerItems: [],
      referenceResolution: null,
      usedSources: [],
      confidence: "low",
      mode: "fast",
      model: null,
      promptTokens: null,
      completionTokens: null,
      intent: "social",
      focusEntities: [],
      directEvidenceIds: [],
      contextEvidenceIds: [],
      activeIncidentIds: [],
      activeEntityIds: [],
      mustCarryFacts: [],
      turnKind: "social",
      turnState: previousState,
      strategy: "default",
      planner: BookChatPlanSchema.parse({
        intent: "social",
        targets: [],
        scope: "unknown",
        scopeMode: "book_only",
        timeRef: null,
        depth: "fast",
        needQuote: false,
        answerMode: "factual",
        lane: "fast",
        stateAction: "keep",
      }),
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
      requiredFactIds: [],
      usedEvidenceIds: [],
      stateDelta: {},
      verifier: { passed: true, missingFactIds: [], strippedClaims: [] },
    };
  }

  const previousFollowupRefs = resolvePreviousFollowupRefs(previousState, params.history);
  const previousFocusEntities = extractPreviousFocusEntities(params.history);
  const basePlannerContext: PlannerContext = {
    sectionKey,
    entryContext,
    state: previousState,
    recentUserTurns: summarizeRecentUserTurns(params.history),
    referenceResolution: null,
    resolvedAnswerItem: null,
  };

  const referenceResolution = await runReferenceResolver({
    question,
    plannerContext: basePlannerContext,
    followupRefs: previousFollowupRefs,
    previousFocusEntities,
  });
  const resolvedAnswerItem = findAnswerItemById(previousFollowupRefs, referenceResolution.resolvedAnswerItemId);
  const plannerContext: PlannerContext = {
    ...basePlannerContext,
    referenceResolution,
    resolvedAnswerItem,
  };

  const planner = await runPlannerModel({
    question,
    staticContext,
    plannerContext,
  });

  const targetResolution = await resolveTargetEntities({
    bookId: params.bookId,
    plan: planner,
    turnState: previousState,
    referenceResolution,
  });
  const focusEntities = targetResolution.focusEntities;

  const bundle = await retrieveBundle({
    bookId: params.bookId,
    question,
    plan: planner,
    sectionKey,
    turnState: previousState,
    focusEntities,
    referenceResolution,
    resolvedAnswerItem,
    topK: params.topK,
  });

  const prompts = buildAnswerPrompt({
    question,
    staticContext,
    plan: planner,
    plannerContext,
    bundle,
    targetResolution,
  });

  const completion = await streamVertexChatAnswer({
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    onToken: params.onToken,
  });

  const rawAnswer = completion.answer || "По имеющимся материалам я не могу уверенно ответить без риска додумать лишнее.";
  const verifier = verifyAnswer({
    answer: sanitizeChatAnswer(rawAnswer),
    requiredFacts: bundle.requiredFacts,
  });
  const verifiedAnswer = sanitizeChatAnswer(verifier.answer);
  const confidence = resolveConfidence({
    plan: planner,
    bundle,
    verifier,
  });

  const evidence = dedupeEvidence([...bundle.directEvidence, ...bundle.contextEvidence]);
  const directEvidenceIds = bundle.directEvidence.map((item) => item.sourceId);
  const contextEvidenceIds = bundle.contextEvidence.map((item) => item.sourceId);
  const annotation = await runInlineQuoteAnnotationPass({
    answer: verifiedAnswer,
    quoteCards: bundle.quoteCards,
  });
  const finalAnswer = annotation?.annotatedAnswerMarkdown || verifiedAnswer;
  const inlineCitations = annotation?.inlineCitations || [];
  const answerItems = buildAnswerItems({
    answer: verifiedAnswer,
    focusEntities: bundle.focusEntities,
    evidence,
  });
  const followupRefs = buildFollowupRefs({
    focusEntities: bundle.focusEntities,
    answerItems,
  });
  const nextState = buildNextTurnState({
    previous: previousState,
    plan: planner,
    question,
    sectionKey,
    bundle,
    followupRefs,
  });
  const stateDelta = buildStateDelta(previousState, nextState);

  return {
    answer: finalAnswer,
    rawAnswer: verifiedAnswer,
    evidence,
    citations: bundle.citations,
    inlineCitations,
    answerItems,
    referenceResolution,
    usedSources: bundle.usedSources,
    confidence,
    mode: staticContext.chatMode,
    model: completion.model,
    promptTokens: sumTokenCounts(completion.promptTokens, annotation?.promptTokens ?? null),
    completionTokens: sumTokenCounts(completion.completionTokens, annotation?.completionTokens ?? null),
    intent: planner.intent,
    focusEntities: bundle.focusEntities.map((entity) => ({
      kind: entity.kind,
      id: entity.id,
      name: entity.name,
      normalizedName: entity.normalizedName,
    })),
    directEvidenceIds,
    contextEvidenceIds,
    activeIncidentIds: [],
    activeEntityIds: nextState.activeEntityIds,
    mustCarryFacts: bundle.requiredFacts.map((fact) => fact.text),
    turnKind: planner.intent === "social" ? "social" : planner.intent === "analysis" ? "analysis" : bundle.requiredFacts.length > 0 ? "factual" : "analysis",
    turnState: nextState,
    strategy: "default",
    planner,
    bundleStats: bundle.bundleStats,
    requiredFactIds: bundle.requiredFacts.map((fact) => fact.id),
    usedEvidenceIds: evidence.map((item) => item.sourceId),
    stateDelta,
    verifier: {
      passed: verifier.passed,
      missingFactIds: verifier.missingFactIds,
      strippedClaims: verifier.strippedClaims,
    },
  };
}

export const __chatRuntimeTestUtils = {
  buildAnswerItems,
  buildAnswerPrompt,
  buildPlannerPrompts,
  resolveConversationEntityIds,
};
