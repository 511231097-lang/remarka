import { createVertexClient } from "@remarka/ai";
import { createVertex } from "@ai-sdk/google-vertex";
import {
  createArtifactBlobStoreFromEnv,
  createNpzPrismaAdapter,
  putArtifactPayload,
  replaceBookChatToolRuns,
  resolveBookTextCorpus,
  resolvePricingVersion,
  upsertBookChatTurnMetric,
  prisma as basePrisma,
  type BlobStore,
} from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { generateText, stepCountIs, streamText, tool, type LanguageModelUsage } from "ai";
import { z } from "zod";
import {
  BOOK_CHAT_TOOL_META,
  BOOK_CHAT_TOOL_NAMES,
  DEFAULT_ENABLED_BOOK_CHAT_TOOLS,
  isBookChatToolName,
  type BookChatToolName,
} from "./bookChatTools";
import { convertUsd, readCurrencyRates, resolveTokenPricing } from "./modelPricing";

const prisma = createNpzPrismaAdapter(basePrisma);
const BOOK_CHAT_PROMPT_VARIANT = "thread-book-chat";
const BOOK_CHAT_SYSTEM_PROMPT_VERSION = "tool-aware-v1";
const BOOK_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION = "chat-tool-payload-v1";
let chatArtifactBlobStore: BlobStore | null = null;

function readBoolEnv(name: string, fallback: boolean) {
  const normalized = String(process.env[name] || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getChatArtifactBlobStore() {
  if (!chatArtifactBlobStore) {
    chatArtifactBlobStore = createArtifactBlobStoreFromEnv();
  }
  return chatArtifactBlobStore;
}

const bookTextCorpusLogger = {
  info(message: string, data?: Record<string, unknown>) {
    console.info(message, data || {});
  },
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(message, data || {});
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(message, data || {});
  },
};

export type ChatInputMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatCitation = {
  chapterOrderIndex: number;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  reason: string;
};

export type ChatToolRun = {
  tool: "search_scenes" | "search_paragraphs_hybrid" | "get_scene_context" | "get_paragraph_slice";
  args: Record<string, unknown>;
  resultMeta: Record<string, unknown>;
};

export type BookChatToolboxToolName =
  | "search_scenes"
  | "search_paragraphs_hybrid"
  | "get_scene_context"
  | "get_paragraph_slice"
  | "search_paragraphs_lexical";

export type BookChatToolboxRunResult = {
  tool: BookChatToolboxToolName;
  normalizedArgs: Record<string, unknown>;
  outputMeta: Record<string, unknown>;
  output: Record<string, unknown>;
};

function normalizeEnabledBookChatTools(value?: readonly string[] | null): BookChatToolName[] {
  if (value === undefined || value === null) {
    return [...DEFAULT_ENABLED_BOOK_CHAT_TOOLS];
  }

  const selected = new Set(value.filter((tool): tool is BookChatToolName => isBookChatToolName(tool)));
  return BOOK_CHAT_TOOL_NAMES.filter((tool) => selected.has(tool));
}

function buildToolConfigKey(tools: readonly BookChatToolName[]) {
  return tools.length ? [...tools].sort().join("|") : "none";
}

export type ChatMetrics = {
  chatModel: string;
  embeddingModel: string;
  pricingVersion: string;
  selectedTools: BookChatToolName[];
  toolConfigKey: string;
  promptVariant: string;
  systemPromptVersion: string;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
  embeddingInputTokens: number;
  chatCostUsd: number;
  embeddingCostUsd: number;
  totalCostUsd: number;
  totalCostEur: number;
  totalCostRub: number;
  totalLatencyMs: number;
  answerLengthChars: number;
  citationCount: number;
  fallbackUsed: boolean;
  fallbackKind: string | null;
  pricing: {
    chatInputPer1MUsd: number;
    chatOutputPer1MUsd: number;
    embeddingInputPer1MUsd: number;
    usdToEur: number;
    eurToRub: number;
  };
};

export type BookChatAnswer = {
  answer: string;
  citations: ChatCitation[];
  toolRuns: ChatToolRun[];
  metrics: ChatMetrics;
};

export type BookChatStreamToolCallEvent = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type BookChatStreamToolResultEvent = {
  toolCallId: string;
  toolName: string;
  outputMeta: Record<string, unknown>;
};

export class BookChatError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BookChatError";
    this.code = code;
    this.status = status;
  }
}

const MAX_HISTORY_MESSAGES = 14;
const MAX_SEARCH_RESULTS = 12;
const DEFAULT_SIMPLE_SEARCH_TOP_K = 8;
const DEFAULT_COMPLEX_SEARCH_TOP_K = 12;
const SEARCH_PROMPT_MIN_TOP_K = 8;
const SEARCH_PROMPT_MAX_TOP_K = 12;
const CONTEXT_SCENE_LIMIT = 20;
const NEIGHBOR_WINDOW = 1;
const MAX_EXCERPT_CHARS = 1200;
const MAX_SLICE_CHARS = 1200;
const MAX_TOOL_STEPS = 8;
const MAX_LEXICAL_SEARCH_RESULTS = 40;
const MAX_HYBRID_PARAGRAPH_RESULTS = 40;
const DEFAULT_HYBRID_PARAGRAPH_TOP_K = 10;
const HYBRID_PARAGRAPH_PROMPT_MIN_TOP_K = 6;
const HYBRID_PARAGRAPH_PROMPT_MAX_TOP_K = 12;
const SCENE_EMBEDDING_VERSION = Math.max(1, Number.parseInt(String(process.env.SCENE_EMBEDDING_VERSION || "1"), 10) || 1);
const PARAGRAPH_EMBEDDING_VERSION = Math.max(
  1,
  Number.parseInt(String(process.env.PARAGRAPH_EMBEDDING_VERSION || "1"), 10) || 1
);
const PGVECTOR_EMBEDDING_DIMENSIONS = 768;
const LEXICAL_BM25_K1 = 1.2;
const LEXICAL_BM25_B = 0.75;
const LEXICAL_CHAR_NGRAM_SIZE = 3;
const HYBRID_RRF_K = 12;
const HYBRID_LEXICAL_PROBE_FACTOR = 3;
const HYBRID_LEXICAL_PROBE_MIN_TOP_K = 12;
const HYBRID_PARAGRAPH_LEXICAL_PROBE_FACTOR = 3;
const HYBRID_PARAGRAPH_LEXICAL_PROBE_MIN_TOP_K = 12;
const BOOK_SEARCH_CACHE_TTL_MS = Math.max(
  30_000,
  Number.parseInt(String(process.env.BOOK_SEARCH_CACHE_TTL_MS || "600000"), 10) || 600_000
);
const BOOK_SEARCH_CACHE_MAX_BOOKS = Math.max(
  2,
  Number.parseInt(String(process.env.BOOK_SEARCH_CACHE_MAX_BOOKS || "12"), 10) || 12
);
const EMBEDDING_CALL_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.BOOK_CHAT_EMBEDDING_CONCURRENCY || "6"), 10) || 6
);
const CHAT_CALL_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.BOOK_CHAT_MODEL_CONCURRENCY || "4"), 10) || 4
);

type Semaphore = {
  limit: number;
  active: number;
  queue: Array<() => void>;
};

function createSemaphore(limit: number): Semaphore {
  return {
    limit: Math.max(1, Math.floor(limit)),
    active: 0,
    queue: [],
  };
}

async function withSemaphore<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T> {
  if (semaphore.active >= semaphore.limit) {
    await new Promise<void>((resolve) => {
      semaphore.queue.push(resolve);
    });
  }

  semaphore.active += 1;
  try {
    return await fn();
  } finally {
    semaphore.active = Math.max(0, semaphore.active - 1);
    const next = semaphore.queue.shift();
    if (next) next();
  }
}

const embeddingCallSemaphore = createSemaphore(EMBEDDING_CALL_CONCURRENCY);
const chatCallSemaphore = createSemaphore(CHAT_CALL_CONCURRENCY);

function normalizeVertexBaseUrlForAiSdk(baseUrl: string): string | undefined {
  const normalized = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");

  if (!normalized) return undefined;
  if (normalized.includes("/publishers/google")) return normalized;

  return `${normalized}/v1/publishers/google`;
}

function createVertexChatModelFromConfig(config: {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  proxySource: string;
}) {
  const provider = createVertex({
    apiKey: config.apiKey,
    baseURL: normalizeVertexBaseUrlForAiSdk(config.baseUrl),
    headers: config.proxySource
      ? {
          "x-proxy-source": config.proxySource,
        }
      : undefined,
  });

  return provider(config.chatModel);
}

function createVertexReasoningProviderOptions(chatModel: string) {
  const modelId = String(chatModel || "").toLowerCase();

  if (modelId.includes("gemini-3")) {
    return {
      vertex: {
        thinkingConfig: {
          thinkingLevel: "minimal",
          includeThoughts: true,
        },
      },
    };
  }

  // For non-Gemini 3 models fallback to a small thinking budget.
  return {
    vertex: {
      thinkingConfig: {
        thinkingBudget: 256,
        includeThoughts: true,
      },
    },
  };
}

type SceneEvidenceSpan = {
  label: string;
  paragraphStart: number;
  paragraphEnd: number;
};

type SceneRow = {
  sceneId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  sceneSummary: string;
  participants: string[];
  mentionedEntities: string[];
  locationHints: string[];
  timeHints: string[];
  eventLabels: string[];
  facts: string[];
  evidenceSpans: SceneEvidenceSpan[];
  excerptText: string;
};

type SearchSceneResult = SceneRow & {
  score: number;
  semanticRank: number | null;
  lexicalRank: number | null;
  matchedTerms: string[];
};

type ParagraphSliceResult = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphStart: number;
  paragraphEnd: number;
  text: string;
};

type LexicalParagraphSearchHit = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  sceneIndex: number | null;
  score: number;
  matchedTerms: string[];
  text: string;
};

type HybridParagraphSearchHit = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  sceneIndex: number | null;
  score: number;
  semanticRank: number | null;
  lexicalRank: number | null;
  matchedTerms: string[];
  text: string;
};

type BookSearchContext = {
  cacheKey: string;
};

type LexicalParagraphDoc = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  sceneIndex: number | null;
  text: string;
  normalized: string;
  termFrequency: Map<string, number>;
  uniqueTerms: string[];
  termCount: number;
};

type LexicalSearchCorpus = {
  paragraphDocs: LexicalParagraphDoc[];
  documentCount: number;
  averageDocumentLength: number;
  documentFrequencyByTerm: Map<string, number>;
  paragraphSceneIndexByRef: Map<string, number | null>;
};

type SemanticSceneQueryRow = {
  embeddingRows: number;
  sceneId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  sceneSummary: string;
  participantsJson: unknown;
  mentionedEntitiesJson: unknown;
  locationHintsJson: unknown;
  timeHintsJson: unknown;
  eventLabelsJson: unknown;
  factsJson: unknown;
  evidenceSpansJson: unknown;
  excerptText: string;
  semanticScore: number;
};

type SemanticParagraphQueryRow = {
  embeddingRows: number;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  sourceText: string;
  semanticScore: number;
};

type BookSearchCacheEntry<T> = {
  cacheKey: string;
  value?: T;
  loading?: Promise<T>;
  expiresAt: number;
  lastAccessAt: number;
};

const lexicalCorpusCacheByBook = new Map<string, BookSearchCacheEntry<LexicalSearchCorpus>>();

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function clampText(value: unknown, maxChars: number): string {
  const text = String(value || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringList(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) return [];

  const rows: string[] = [];
  for (const item of value) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    rows.push(normalized);
    if (rows.length >= maxItems) break;
  }
  return rows;
}

function asOptionalInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function asOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function roundMetric(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeSemanticScore(score: number): number {
  return clampUnit((Number(score || 0) + 1) / 2);
}

function makeSceneRefKey(chapterId: string, sceneIndex: number): string {
  return `${String(chapterId || "").trim()}:${Math.max(0, Number(sceneIndex || 0))}`;
}

function makeParagraphRefKey(chapterId: string, paragraphIndex: number): string {
  return `${String(chapterId || "").trim()}:${Math.max(0, Number(paragraphIndex || 0))}`;
}

function serializeVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) return "[]";

  return `[${vector
    .map((value) => {
      const normalized = Number(value || 0);
      if (!Number.isFinite(normalized)) return "0";
      return Number(normalized.toFixed(12)).toString();
    })
    .join(",")}]`;
}

function computeSemanticSearchConfidence(scores: number[]): number {
  const top = Number(scores[0] || 0);
  const third = Number(scores[Math.min(2, Math.max(0, scores.length - 1))] || top);
  const topSignal = clampUnit((top - 0.22) / 0.3);
  const separationSignal = clampUnit((top - third) / 0.12);
  return clampUnit(topSignal * 0.75 + separationSignal * 0.25);
}

function normalizeLanguageModelUsage(usage: LanguageModelUsage | null | undefined) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens || 0));
  const outputTokens = Math.max(0, Number(usage?.outputTokens || 0));
  const explicitTotal = Math.max(0, Number(usage?.totalTokens || 0));
  const totalTokens = explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function sumEmbeddingInputTokens(toolRuns: ChatToolRun[]): number {
  return toolRuns.reduce((total, run) => {
    const value = asOptionalNumber(run.resultMeta.embeddingInputTokens);
    if (!Number.isFinite(value) || !value || value <= 0) return total;
    return total + value;
  }, 0);
}

async function resolveUsageSafely(
  usagePromiseLike: PromiseLike<LanguageModelUsage> | LanguageModelUsage | undefined
): Promise<LanguageModelUsage | undefined> {
  if (!usagePromiseLike) return undefined;
  try {
    return await Promise.resolve(usagePromiseLike);
  } catch {
    return undefined;
  }
}

function buildChatMetrics(params: {
  chatModel: string;
  embeddingModel: string;
  selectedTools: readonly BookChatToolName[];
  usage?: LanguageModelUsage | null;
  toolRuns: ChatToolRun[];
  totalLatencyMs: number;
  answerLengthChars: number;
  citationCount: number;
  fallbackUsed: boolean;
  fallbackKind: string | null;
}): ChatMetrics {
  const usage = normalizeLanguageModelUsage(params.usage || undefined);
  const embeddingInputTokens = Math.max(0, sumEmbeddingInputTokens(params.toolRuns));
  const pricing = resolveTokenPricing({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
  });
  const selectedTools = normalizeEnabledBookChatTools(params.selectedTools);
  const currencyRates = readCurrencyRates();
  const pricingForMetrics = {
    ...pricing,
    usdToEur: currencyRates.usdToEur,
    eurToRub: currencyRates.eurToRub,
  };

  const chatCostUsd =
    (usage.inputTokens / 1_000_000) * pricing.chatInputPer1MUsd +
    (usage.outputTokens / 1_000_000) * pricing.chatOutputPer1MUsd;
  const embeddingCostUsd = (embeddingInputTokens / 1_000_000) * pricing.embeddingInputPer1MUsd;
  const totalCostUsd = chatCostUsd + embeddingCostUsd;
  const converted = convertUsd(totalCostUsd, currencyRates);

  return {
    chatModel: String(params.chatModel || "").trim(),
    embeddingModel: String(params.embeddingModel || "").trim(),
    pricingVersion: resolvePricingVersion(),
    selectedTools,
    toolConfigKey: buildToolConfigKey(selectedTools),
    promptVariant: BOOK_CHAT_PROMPT_VARIANT,
    systemPromptVersion: BOOK_CHAT_SYSTEM_PROMPT_VERSION,
    modelInputTokens: Math.round(usage.inputTokens),
    modelOutputTokens: Math.round(usage.outputTokens),
    modelTotalTokens: Math.round(usage.totalTokens),
    embeddingInputTokens: Math.round(embeddingInputTokens),
    chatCostUsd: roundMetric(chatCostUsd),
    embeddingCostUsd: roundMetric(embeddingCostUsd),
    totalCostUsd: roundMetric(totalCostUsd),
    totalCostEur: roundMetric(converted.eur),
    totalCostRub: roundMetric(converted.rub, 6),
    totalLatencyMs: Math.max(0, Math.round(Number(params.totalLatencyMs || 0))),
    answerLengthChars: Math.max(0, Math.round(Number(params.answerLengthChars || 0))),
    citationCount: Math.max(0, Math.round(Number(params.citationCount || 0))),
    fallbackUsed: Boolean(params.fallbackUsed),
    fallbackKind: params.fallbackKind ? String(params.fallbackKind).trim() : null,
    pricing: pricingForMetrics,
  };
}

function mergeLanguageModelUsage(
  ...usages: Array<LanguageModelUsage | null | undefined>
): LanguageModelUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let explicitTotalTokens = 0;
  let noCacheTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let textTokens = 0;
  let reasoningTokens = 0;
  let hasUsage = false;
  let hasExplicitTotal = false;

  for (const usage of usages) {
    if (!usage) continue;
    hasUsage = true;
    inputTokens += Math.max(0, Number(usage.inputTokens || 0));
    outputTokens += Math.max(0, Number(usage.outputTokens || 0));
    noCacheTokens += Math.max(0, Number(usage.inputTokenDetails?.noCacheTokens || 0));
    cacheReadTokens += Math.max(0, Number(usage.inputTokenDetails?.cacheReadTokens || 0));
    cacheWriteTokens += Math.max(0, Number(usage.inputTokenDetails?.cacheWriteTokens || 0));
    textTokens += Math.max(0, Number(usage.outputTokenDetails?.textTokens || 0));
    reasoningTokens += Math.max(0, Number(usage.outputTokenDetails?.reasoningTokens || usage.reasoningTokens || 0));
    const total = Math.max(0, Number(usage.totalTokens || 0));
    if (total > 0) {
      hasExplicitTotal = true;
      explicitTotalTokens += total;
    }
  }

  if (!hasUsage) return undefined;

  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens,
      reasoningTokens,
    },
    totalTokens: hasExplicitTotal ? explicitTotalTokens : inputTokens + outputTokens,
    reasoningTokens,
    cachedInputTokens: cacheReadTokens,
  };
}

async function persistNormalizedChatMetrics(params: {
  bookId: string;
  threadId: string;
  messageId: string;
  toolRuns: ChatToolRun[];
  metrics: ChatMetrics;
}) {
  const turnMetric = await upsertBookChatTurnMetric({
    client: prisma,
    bookId: params.bookId,
    threadId: params.threadId,
    messageId: params.messageId,
    chatModel: params.metrics.chatModel,
    embeddingModel: params.metrics.embeddingModel,
    selectedTools: params.metrics.selectedTools,
    toolConfigKey: params.metrics.toolConfigKey,
    promptVariant: params.metrics.promptVariant,
    systemPromptVersion: params.metrics.systemPromptVersion,
    pricingVersion: params.metrics.pricingVersion,
    modelInputTokens: params.metrics.modelInputTokens,
    modelOutputTokens: params.metrics.modelOutputTokens,
    modelTotalTokens: params.metrics.modelTotalTokens,
    embeddingInputTokens: params.metrics.embeddingInputTokens,
    chatCostUsd: params.metrics.chatCostUsd,
    embeddingCostUsd: params.metrics.embeddingCostUsd,
    totalCostUsd: params.metrics.totalCostUsd,
    totalLatencyMs: params.metrics.totalLatencyMs,
    answerLengthChars: params.metrics.answerLengthChars,
    citationCount: params.metrics.citationCount,
    fallbackUsed: params.metrics.fallbackUsed,
    fallbackKind: params.metrics.fallbackKind,
  });

  const persistRawPayloads = readBoolEnv("BOOK_CHAT_TOOL_DEBUG_PAYLOADS_ENABLED", false);
  const toolRows = [];
  for (const [index, run] of params.toolRuns.entries()) {
    let rawPayload:
      | {
          provider: string;
          storageKey: string;
          sizeBytes: number;
          sha256: string;
          compression: string;
        }
      | null = null;

    if (persistRawPayloads) {
      try {
        rawPayload = await putArtifactPayload({
          store: getChatArtifactBlobStore(),
          prefix: `chat-runs/${params.bookId}/${params.threadId}/${params.messageId}/${run.tool}`,
          fileName: `tool-run-${index + 1}.json.gz`,
          payload: {
            schemaVersion: BOOK_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION,
            tool: run.tool,
            args: run.args,
            resultMeta: run.resultMeta,
          },
        });
      } catch {
        rawPayload = null;
      }
    }

    toolRows.push({
      toolName: run.tool,
      orderIndex: index,
      latencyMs: Math.max(0, Math.round(Number(asOptionalNumber(run.resultMeta.totalMs) || 0))),
      argsSummaryJson: run.args,
      resultSummaryJson: run.resultMeta,
      errorCode: typeof run.resultMeta.error === "string" ? String(run.resultMeta.error) : null,
      errorMessage: typeof run.resultMeta.error === "string" ? String(run.resultMeta.error) : null,
      storageProvider: rawPayload?.provider || null,
      payloadKey: rawPayload?.storageKey || null,
      payloadSizeBytes: rawPayload?.sizeBytes || 0,
      payloadSha256: rawPayload?.sha256 || null,
      compression: rawPayload?.compression || null,
    });
  }

  await replaceBookChatToolRuns({
    client: prisma,
    turnMetricId: turnMetric.id,
    runs: toolRows,
  });
}

function isBroadCoverageQuery(query: string): boolean {
  const normalized = normalizeLexicalSearchText(query);
  if (!normalized) return false;
  const termCount = tokenizeLexicalSearchQuery(normalized).length;
  return termCount >= 8;
}

function defaultSearchTopK(query: string): number {
  return isBroadCoverageQuery(query) ? DEFAULT_COMPLEX_SEARCH_TOP_K : DEFAULT_SIMPLE_SEARCH_TOP_K;
}

function summarizeToolResultForStream(toolName: string, output: unknown): Record<string, unknown> {
  const row = asRecord(output);
  const normalizedTool = String(toolName || "").trim();

  if (normalizedTool === "search_scenes") {
    const hits = Array.isArray(row.hits) ? row.hits : [];
    const summary: Record<string, unknown> = {
      returned: hits.length,
      sceneIds: asStringList(row.sceneIds),
    };
    const hybridMode = String(row.hybridMode || "").trim();
    if (hybridMode) summary.hybridMode = hybridMode;
    const semanticConfidence = asOptionalNumber(row.semanticConfidence);
    if (semanticConfidence !== undefined) {
      summary.semanticConfidence = Number(semanticConfidence.toFixed(6));
    }
    const error = String(row.error || "").trim();
    if (error) summary.error = error;
    return summary;
  }

  if (normalizedTool === "search_paragraphs_hybrid") {
    const hits = Array.isArray(row.hits) ? row.hits : [];
    const paragraphRefs = hits
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const row = item as Record<string, unknown>;
        const chapterOrderIndex = asOptionalInt(row.chapterOrderIndex);
        const paragraphIndex = asOptionalInt(row.paragraphIndex);
        if (!chapterOrderIndex || !paragraphIndex) return "";
        return `${chapterOrderIndex}:${paragraphIndex}`;
      })
      .filter(Boolean)
      .slice(0, 8);
    const summary: Record<string, unknown> = {
      returned: hits.length,
      paragraphRefs,
    };
    const semanticConfidence = asOptionalNumber(row.semanticConfidence);
    if (semanticConfidence !== undefined) {
      summary.semanticConfidence = Number(semanticConfidence.toFixed(6));
    }
    const embeddingRows = asOptionalInt(row.embeddingRows);
    if (embeddingRows !== undefined) summary.embeddingRows = embeddingRows;
    const error = String(row.error || "").trim();
    if (error) summary.error = error;
    return summary;
  }

  if (normalizedTool === "get_scene_context") {
    const scenes = Array.isArray(row.scenes) ? row.scenes : [];
    const sceneIds = scenes
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return String((item as Record<string, unknown>).sceneId || "").trim();
      })
      .filter(Boolean)
      .slice(0, 6);
    const summary: Record<string, unknown> = {
      returned: scenes.length,
      sceneIds,
    };
    const error = String(row.error || "").trim();
    if (error) summary.error = error;
    return summary;
  }

  if (normalizedTool === "get_paragraph_slice") {
    const slice = asRecord(row.slice);
    const hasSlice = Object.keys(slice).length > 0;
    const summary: Record<string, unknown> = {
      returned: hasSlice ? 1 : 0,
    };

    if (hasSlice) {
      const chapterOrderIndex = asOptionalInt(slice.chapterOrderIndex);
      const paragraphStart = asOptionalInt(slice.paragraphStart);
      const paragraphEnd = asOptionalInt(slice.paragraphEnd);
      if (chapterOrderIndex !== undefined) summary.chapterOrderIndex = chapterOrderIndex;
      if (paragraphStart !== undefined) summary.paragraphStart = paragraphStart;
      if (paragraphEnd !== undefined) summary.paragraphEnd = paragraphEnd;
    }

    const error = String(row.error || "").trim();
    if (error) summary.error = error;
    return summary;
  }

  return {};
}

function parseStringArray(value: unknown, maxItems = 32): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of value) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function parseEvidenceSpans(value: unknown): SceneEvidenceSpan[] {
  if (!Array.isArray(value)) return [];

  const rows: SceneEvidenceSpan[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const label = String(row.label || "").trim();
    const paragraphStart = Number.parseInt(String(row.paragraphStart || ""), 10);
    const paragraphEnd = Number.parseInt(String(row.paragraphEnd || ""), 10);
    if (!label || !Number.isFinite(paragraphStart) || !Number.isFinite(paragraphEnd)) continue;
    if (paragraphStart <= 0 || paragraphEnd <= 0 || paragraphStart > paragraphEnd) continue;

    rows.push({
      label,
      paragraphStart,
      paragraphEnd,
    });

    if (rows.length >= 6) break;
  }

  return rows;
}

function splitChapterToParagraphs(rawText: string): string[] {
  return normalizeText(rawText)
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function normalizeLexicalSearchText(value: unknown): string {
  return normalizeText(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeLexicalSearchQuery(value: unknown): string {
  return normalizeLexicalSearchText(value);
}

function tokenizeLexicalSearchQuery(query: string): string[] {
  const terms = query
    .split(/\s+/gu)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  return Array.from(new Set(terms));
}

function buildTermFrequencyMap(terms: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const term of terms) {
    frequency.set(term, (frequency.get(term) || 0) + 1);
  }
  return frequency;
}

function buildCharNgramSet(value: string, n: number): Set<string> {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return new Set();
  if (compact.length <= n) return new Set([compact]);

  const grams = new Set<string>();
  for (let i = 0; i <= compact.length - n; i += 1) {
    grams.add(compact.slice(i, i + n));
  }
  return grams;
}

function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }
  return (2 * overlap) / (left.size + right.size);
}

function computeBm25Score(params: {
  queryTerms: string[];
  documentCount: number;
  averageDocumentLength: number;
  documentLength: number;
  documentTermFrequency: Map<string, number>;
  documentFrequencyByTerm: Map<string, number>;
}): number {
  const documentLength = Math.max(1, params.documentLength);
  const averageDocumentLength = Math.max(1, params.averageDocumentLength);
  const documentCount = Math.max(1, params.documentCount);

  let score = 0;
  for (const term of params.queryTerms) {
    const tf = Number(params.documentTermFrequency.get(term) || 0);
    if (tf <= 0) continue;

    const documentFrequency = Math.max(0, Number(params.documentFrequencyByTerm.get(term) || 0));
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const numerator = tf * (LEXICAL_BM25_K1 + 1);
    const denominator = tf + LEXICAL_BM25_K1 * (1 - LEXICAL_BM25_B + (LEXICAL_BM25_B * documentLength) / averageDocumentLength);
    if (denominator > 0) {
      score += idf * (numerator / denominator);
    }
  }

  return score;
}

function levenshteinDistanceLimited(left: string, right: string, maxDistance: number): number | null {
  if (left === right) return 0;

  const leftLength = left.length;
  const rightLength = right.length;
  if (!leftLength) return rightLength <= maxDistance ? rightLength : null;
  if (!rightLength) return leftLength <= maxDistance ? leftLength : null;
  if (Math.abs(leftLength - rightLength) > maxDistance) return null;

  let previous = new Array(rightLength + 1);
  let current = new Array(rightLength + 1);
  for (let column = 0; column <= rightLength; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= leftLength; row += 1) {
    current[0] = row;
    let rowBest = current[0];

    for (let column = 1; column <= rightLength; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const substitution = previous[column - 1] + cost;
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      const next = Math.min(substitution, insertion, deletion);
      current[column] = next;
      if (next < rowBest) rowBest = next;
    }

    if (rowBest > maxDistance) {
      return null;
    }
    [previous, current] = [current, previous];
  }

  const distance = Number(previous[rightLength] || 0);
  return distance <= maxDistance ? distance : null;
}

function findBestFuzzyTokenMatch(queryTerm: string, paragraphTerms: string[]): number {
  let best = 0;
  for (const paragraphTerm of paragraphTerms) {
    if (Math.abs(paragraphTerm.length - queryTerm.length) > 2) continue;
    const maxLength = Math.max(paragraphTerm.length, queryTerm.length);
    if (maxLength <= 2) continue;

    const distance = levenshteinDistanceLimited(queryTerm, paragraphTerm, 2);
    if (distance === null) continue;
    const similarity = 1 - distance / maxLength;
    if (similarity > best) best = similarity;
    if (best >= 0.95) break;
  }
  return best;
}

function detectSceneIndexForParagraph(
  scenes: Array<{ sceneIndex: number; paragraphStart: number; paragraphEnd: number }>,
  paragraphIndex: number
): number | null {
  for (const scene of scenes) {
    if (paragraphIndex >= scene.paragraphStart && paragraphIndex <= scene.paragraphEnd) {
      return scene.sceneIndex;
    }
  }
  return null;
}

function toSceneRow(scene: {
  id: string;
  chapterId: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  sceneSummary: string;
  participantsJson: unknown;
  mentionedEntitiesJson: unknown;
  locationHintsJson: unknown;
  timeHintsJson: unknown;
  eventLabelsJson: unknown;
  factsJson: unknown;
  evidenceSpansJson: unknown;
  excerptText: string;
  chapter: {
    orderIndex: number;
    title: string;
  };
}): SceneRow {
  return {
    sceneId: scene.id,
    chapterId: scene.chapterId,
    chapterOrderIndex: Number(scene.chapter.orderIndex || 0),
    chapterTitle: String(scene.chapter.title || "").trim(),
    sceneIndex: Number(scene.sceneIndex || 0),
    paragraphStart: Number(scene.paragraphStart || 0),
    paragraphEnd: Number(scene.paragraphEnd || 0),
    sceneCard: String(scene.sceneCard || "").trim(),
    sceneSummary: String(scene.sceneSummary || "").trim(),
    participants: parseStringArray(scene.participantsJson, 24),
    mentionedEntities: parseStringArray(scene.mentionedEntitiesJson, 24),
    locationHints: parseStringArray(scene.locationHintsJson, 12),
    timeHints: parseStringArray(scene.timeHintsJson, 12),
    eventLabels: parseStringArray(scene.eventLabelsJson, 10),
    facts: parseStringArray(scene.factsJson, 10),
    evidenceSpans: parseEvidenceSpans(scene.evidenceSpansJson),
    excerptText: normalizeText(scene.excerptText),
  };
}

function toSceneRowFromSemanticQueryRow(row: SemanticSceneQueryRow): SceneRow {
  return {
    sceneId: row.sceneId,
    chapterId: row.chapterId,
    chapterOrderIndex: Number(row.chapterOrderIndex || 0),
    chapterTitle: String(row.chapterTitle || "").trim(),
    sceneIndex: Number(row.sceneIndex || 0),
    paragraphStart: Number(row.paragraphStart || 0),
    paragraphEnd: Number(row.paragraphEnd || 0),
    sceneCard: String(row.sceneCard || "").trim(),
    sceneSummary: String(row.sceneSummary || "").trim(),
    participants: parseStringArray(row.participantsJson, 24),
    mentionedEntities: parseStringArray(row.mentionedEntitiesJson, 24),
    locationHints: parseStringArray(row.locationHintsJson, 12),
    timeHints: parseStringArray(row.timeHintsJson, 12),
    eventLabels: parseStringArray(row.eventLabelsJson, 10),
    facts: parseStringArray(row.factsJson, 10),
    evidenceSpans: parseEvidenceSpans(row.evidenceSpansJson),
    excerptText: normalizeText(row.excerptText),
  };
}

function nowMs(): number {
  return Date.now();
}

function pruneBookSearchCache<T>(cache: Map<string, BookSearchCacheEntry<T>>) {
  const now = nowMs();
  for (const [bookId, entry] of cache.entries()) {
    if (entry.loading) continue;
    if (entry.expiresAt > now) continue;
    cache.delete(bookId);
  }

  if (cache.size <= BOOK_SEARCH_CACHE_MAX_BOOKS) return;

  const sorted = Array.from(cache.entries()).sort((left, right) => {
    return (left[1].lastAccessAt || 0) - (right[1].lastAccessAt || 0);
  });
  for (const [bookId] of sorted) {
    if (cache.size <= BOOK_SEARCH_CACHE_MAX_BOOKS) break;
    cache.delete(bookId);
  }
}

async function getOrLoadBookSearchCache<T>(params: {
  cache: Map<string, BookSearchCacheEntry<T>>;
  bookId: string;
  cacheKey: string;
  loader: () => Promise<T>;
}): Promise<{ value: T; hit: boolean }> {
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
    loading,
    value: current?.value,
    expiresAt: now,
    lastAccessAt: now,
  });

  try {
    const value = await loading;
    const refreshedAt = nowMs();
    params.cache.set(params.bookId, {
      cacheKey: params.cacheKey,
      value,
      expiresAt: refreshedAt + BOOK_SEARCH_CACHE_TTL_MS,
      lastAccessAt: refreshedAt,
    });
    pruneBookSearchCache(params.cache);
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

async function resolveBookSearchContext(bookId: string): Promise<BookSearchContext> {
  const book = await prisma.book.findUnique({
    where: {
      id: bookId,
    },
    select: {
      id: true,
      analysisFinishedAt: true,
      updatedAt: true,
    },
  });
  if (!book) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const analysisStamp = book.analysisFinishedAt ? book.analysisFinishedAt.toISOString() : "analysis:none";
  const updatedStamp = book.updatedAt ? book.updatedAt.toISOString() : "updated:none";
  return {
    cacheKey: `${bookId}|${analysisStamp}|${updatedStamp}|sev:${SCENE_EMBEDDING_VERSION}|pev:${PARAGRAPH_EMBEDDING_VERSION}`,
  };
}

async function ensureBookSearchContext(bookId: string, context?: BookSearchContext): Promise<BookSearchContext> {
  if (context) return context;
  return resolveBookSearchContext(bookId);
}

async function getLexicalCorpusCache(params: {
  bookId: string;
  context?: BookSearchContext;
}): Promise<{ value: LexicalSearchCorpus; hit: boolean }> {
  const context = await ensureBookSearchContext(params.bookId, params.context);
  return getOrLoadBookSearchCache({
    cache: lexicalCorpusCacheByBook,
    bookId: params.bookId,
    cacheKey: `lexical:${context.cacheKey}`,
    loader: async () => {
      const [resolvedCorpus, scenes] = await Promise.all([
        resolveBookTextCorpus({
          client: prisma,
          bookId: params.bookId,
          logger: bookTextCorpusLogger,
          cacheTtlMs: BOOK_SEARCH_CACHE_TTL_MS,
          cacheMaxBooks: BOOK_SEARCH_CACHE_MAX_BOOKS,
        }),
        prisma.bookScene.findMany({
          where: {
            bookId: params.bookId,
          },
          orderBy: [{ chapter: { orderIndex: "asc" } }, { sceneIndex: "asc" }],
          select: {
            chapterId: true,
            sceneIndex: true,
            paragraphStart: true,
            paragraphEnd: true,
          },
        }),
      ]);
      const chapters = resolvedCorpus.chapters.map((chapter) => ({
        id: chapter.chapterId,
        orderIndex: chapter.orderIndex,
        title: chapter.title,
        rawText: chapter.rawText,
      }));

      const scenesByChapterId = new Map<
        string,
        Array<{
          sceneIndex: number;
          paragraphStart: number;
          paragraphEnd: number;
        }>
      >();
      for (const scene of scenes) {
        if (!scenesByChapterId.has(scene.chapterId)) {
          scenesByChapterId.set(scene.chapterId, []);
        }
        scenesByChapterId.get(scene.chapterId)!.push({
          sceneIndex: scene.sceneIndex,
          paragraphStart: scene.paragraphStart,
          paragraphEnd: scene.paragraphEnd,
        });
      }

      const paragraphDocs: LexicalParagraphDoc[] = [];
      const documentFrequencyByTerm = new Map<string, number>();
      const paragraphSceneIndexByRef = new Map<string, number | null>();
      let totalTerms = 0;

      for (const chapter of chapters) {
        const paragraphs = splitChapterToParagraphs(chapter.rawText);
        const chapterScenes = scenesByChapterId.get(chapter.id) || [];
        for (let index = 0; index < paragraphs.length; index += 1) {
          const paragraphText = String(paragraphs[index] || "").trim();
          if (!paragraphText) continue;

          const paragraphNormalized = normalizeLexicalSearchText(paragraphText);
          if (!paragraphNormalized) continue;

          const paragraphTerms = paragraphNormalized.split(/\s+/gu).filter((term) => term.length >= 2);
          if (!paragraphTerms.length) continue;

          const termFrequency = buildTermFrequencyMap(paragraphTerms);
          const uniqueTermSet = new Set(paragraphTerms);
          for (const term of uniqueTermSet) {
            documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) || 0) + 1);
          }

          const paragraphIndex = index + 1;
          const sceneIndex = detectSceneIndexForParagraph(chapterScenes, paragraphIndex);
          const refKey = makeParagraphRefKey(chapter.id, paragraphIndex);
          paragraphSceneIndexByRef.set(refKey, sceneIndex);
          totalTerms += paragraphTerms.length;
          paragraphDocs.push({
            chapterId: chapter.id,
            chapterOrderIndex: chapter.orderIndex,
            chapterTitle: chapter.title,
            paragraphIndex,
            sceneIndex,
            text: paragraphText,
            normalized: paragraphNormalized,
            termFrequency,
            uniqueTerms: Array.from(uniqueTermSet),
            termCount: paragraphTerms.length,
          });
        }
      }

      const documentCount = paragraphDocs.length;
      const averageDocumentLength = documentCount > 0 ? totalTerms / documentCount : 0;
      return {
        paragraphDocs,
        documentCount,
        averageDocumentLength,
        documentFrequencyByTerm,
        paragraphSceneIndexByRef,
      } satisfies LexicalSearchCorpus;
    },
  });
}

async function searchScenesSemanticSql(params: {
  bookId: string;
  queryVector: number[];
  topK: number;
}): Promise<{ rows: Array<{ scene: SceneRow; semanticScore: number }>; embeddingRows: number }> {
  if (params.queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) {
    return {
      rows: [],
      embeddingRows: 0,
    };
  }

  const vectorLiteral = serializeVectorLiteral(params.queryVector);
  const rows = await prisma.$queryRaw<SemanticSceneQueryRow[]>`
    SELECT
      COUNT(*) OVER ()::integer AS "embeddingRows",
      e."sceneId" AS "sceneId",
      s."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      s."sceneIndex" AS "sceneIndex",
      s."paragraphStart" AS "paragraphStart",
      s."paragraphEnd" AS "paragraphEnd",
      s."sceneCard" AS "sceneCard",
      s."sceneSummary" AS "sceneSummary",
      s."participantsJson" AS "participantsJson",
      s."mentionedEntitiesJson" AS "mentionedEntitiesJson",
      s."locationHintsJson" AS "locationHintsJson",
      s."timeHintsJson" AS "timeHintsJson",
      s."eventLabelsJson" AS "eventLabelsJson",
      s."factsJson" AS "factsJson",
      s."evidenceSpansJson" AS "evidenceSpansJson",
      s."excerptText" AS "excerptText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookSceneEmbedding" e
    INNER JOIN "BookAnalysisScene" s ON s."id" = e."sceneId"
    INNER JOIN "BookChapter" c ON c."id" = s."chapterId"
    WHERE e."bookId" = ${params.bookId}
      AND e."embeddingVersion" = ${SCENE_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${params.topK}
  `;

  return {
    rows: rows.map((row: SemanticSceneQueryRow) => ({
      scene: toSceneRowFromSemanticQueryRow(row),
      semanticScore: Number(row.semanticScore || 0),
    })),
    embeddingRows: Math.max(0, Number(rows[0]?.embeddingRows || 0)),
  };
}

async function searchParagraphsSemanticSql(params: {
  bookId: string;
  queryVector: number[];
  topK: number;
}): Promise<
  {
    rows: Array<{
      chapterId: string;
      chapterOrderIndex: number;
      chapterTitle: string;
      paragraphIndex: number;
      refKey: string;
      text: string;
      semanticScore: number;
    }>;
    embeddingRows: number;
  }
> {
  if (params.queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) {
    return {
      rows: [],
      embeddingRows: 0,
    };
  }

  const vectorLiteral = serializeVectorLiteral(params.queryVector);
  const rows = await prisma.$queryRaw<SemanticParagraphQueryRow[]>`
    SELECT
      COUNT(*) OVER ()::integer AS "embeddingRows",
      e."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      e."paragraphIndex" AS "paragraphIndex",
      e."sourceText" AS "sourceText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookParagraphEmbedding" e
    INNER JOIN "BookChapter" c ON c."id" = e."chapterId"
    WHERE e."bookId" = ${params.bookId}
      AND e."embeddingVersion" = ${PARAGRAPH_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${params.topK}
  `;

  return {
    rows: rows.map((row: SemanticParagraphQueryRow) => ({
      chapterId: row.chapterId,
      chapterOrderIndex: Number(row.chapterOrderIndex || 0),
      chapterTitle: String(row.chapterTitle || "").trim(),
      paragraphIndex: Number(row.paragraphIndex || 0),
      refKey: makeParagraphRefKey(row.chapterId, row.paragraphIndex),
      text: normalizeText(row.sourceText),
      semanticScore: Number(row.semanticScore || 0),
    })),
    embeddingRows: Math.max(0, Number(rows[0]?.embeddingRows || 0)),
  };
}

function normalizeCitationRows(value: unknown): ChatCitation[] {
  if (!Array.isArray(value)) return [];

  const rows: ChatCitation[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const chapterOrderIndex = Number.parseInt(String(row.chapterOrderIndex || ""), 10);
    const sceneIndex = Number.parseInt(String(row.sceneIndex || ""), 10);
    const paragraphStart = Number.parseInt(String(row.paragraphStart || ""), 10);
    const paragraphEnd = Number.parseInt(String(row.paragraphEnd || ""), 10);
    const reason = String(row.reason || "").trim();

    if (
      !Number.isFinite(chapterOrderIndex) ||
      !Number.isFinite(sceneIndex) ||
      !Number.isFinite(paragraphStart) ||
      !Number.isFinite(paragraphEnd)
    ) {
      continue;
    }

    if (chapterOrderIndex <= 0 || sceneIndex <= 0 || paragraphStart <= 0 || paragraphEnd < paragraphStart) {
      continue;
    }

    const key = `${chapterOrderIndex}:${sceneIndex}:${paragraphStart}:${paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      chapterOrderIndex,
      sceneIndex,
      paragraphStart,
      paragraphEnd,
      reason: reason || "scene evidence",
    });

    if (rows.length >= 12) break;
  }

  return rows;
}

function defaultCitationsFromScenes(scenes: SceneRow[]): ChatCitation[] {
  const citations: ChatCitation[] = [];
  for (const scene of scenes.slice(0, 6)) {
    citations.push({
      chapterOrderIndex: scene.chapterOrderIndex,
      sceneIndex: scene.sceneIndex,
      paragraphStart: scene.paragraphStart,
      paragraphEnd: scene.paragraphEnd,
      reason: scene.sceneCard || scene.sceneSummary || "scene context",
    });
  }
  return citations;
}

function sanitizeMessages(messages: ChatInputMessage[]): ChatInputMessage[] {
  const normalized = messages
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim(),
    }))
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.length > 0);

  return normalized.slice(-MAX_HISTORY_MESSAGES);
}

async function searchScenesTool(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  query: string;
  topK: number;
  context?: BookSearchContext;
}): Promise<{
  hits: SearchSceneResult[];
  embeddingInputTokens: number;
  embeddingRows: number;
  lexicalParagraphHits: number;
  lexicalSceneCandidates: number;
  semanticConfidence: number;
  hybridMode: "semantic_only" | "hybrid";
  sceneEmbeddingCacheHit: boolean;
  lexicalCacheHit: boolean;
  embeddingMs: number;
  semanticMs: number;
  lexicalMs: number;
  mergeMs: number;
  totalMs: number;
}> {
  const startedAt = nowMs();
  const context = await ensureBookSearchContext(params.bookId, params.context);
  const safeTopK = Math.max(1, Math.min(MAX_SEARCH_RESULTS, params.topK));
  const lexicalProbeTopK = Math.max(
    HYBRID_LEXICAL_PROBE_MIN_TOP_K,
    Math.min(MAX_LEXICAL_SEARCH_RESULTS, safeTopK * HYBRID_LEXICAL_PROBE_FACTOR)
  );

  const lexicalCorpusPromise = getLexicalCorpusCache({
    bookId: params.bookId,
    context,
  });
  const lexicalPromise = (async () => {
    const corpus = await lexicalCorpusPromise;
    const lexicalStartedAt = nowMs();
    const lexical = await searchParagraphsLexicalTool({
      bookId: params.bookId,
      query: params.query,
      topK: lexicalProbeTopK,
      context,
      corpus: corpus.value,
    });
    return {
      lexical,
      lexicalMs: nowMs() - lexicalStartedAt,
      lexicalCacheHit: corpus.hit,
    };
  })();

  const embeddingStartedAt = nowMs();
  const queryEmbedding = await withSemaphore(embeddingCallSemaphore, async () =>
    params.client.embeddings.create({
      text: params.query,
      taskType: "RETRIEVAL_QUERY",
      autoTruncate: true,
    })
  );
  const embeddingMs = nowMs() - embeddingStartedAt;

  const semanticStartedAt = nowMs();
  const queryVector = queryEmbedding.vector || [];
  let lexicalData!: {
    lexical: Awaited<ReturnType<typeof searchParagraphsLexicalTool>>;
    lexicalMs: number;
    lexicalCacheHit: boolean;
  };
  const [semanticSearch, nextLexicalData] = await Promise.all([
    searchScenesSemanticSql({
      bookId: params.bookId,
      queryVector,
      topK: safeTopK,
    }),
    lexicalPromise,
  ]);
  const semanticScored = semanticSearch.rows;
  const semanticEmbeddingRows = semanticSearch.embeddingRows;
  const sceneEmbeddingCacheHit = false;
  lexicalData = nextLexicalData;
  const semanticMs = nowMs() - semanticStartedAt;
  const semanticConfidence = computeSemanticSearchConfidence(semanticScored.map((item) => item.semanticScore));

  const sceneById = new Map<string, SceneRow>();
  const sceneIdByRefKey = new Map<string, string>();
  const semanticTop = semanticScored.slice(0, safeTopK);
  for (const item of semanticTop) {
    sceneById.set(item.scene.sceneId, item.scene);
    sceneIdByRefKey.set(makeSceneRefKey(item.scene.chapterId, item.scene.sceneIndex), item.scene.sceneId);
  }
  const semanticRankBySceneId = new Map<string, number>();
  for (let index = 0; index < semanticTop.length; index += 1) {
    semanticRankBySceneId.set(semanticTop[index]!.scene.sceneId, index + 1);
  }

  const lexical = lexicalData.lexical;
  const lexicalParagraphHits = lexical.hits.length;
  const lexicalScoreBySceneId = new Map<string, number>();
  const lexicalMatchedTermsBySceneId = new Map<string, Set<string>>();

  const unresolvedSceneRefs = new Map<string, { chapterId: string; sceneIndex: number }>();
  for (const hit of lexical.hits) {
    if (typeof hit.sceneIndex !== "number" || !Number.isFinite(hit.sceneIndex) || hit.sceneIndex <= 0) continue;
    const key = makeSceneRefKey(hit.chapterId, hit.sceneIndex);
    if (sceneIdByRefKey.has(key)) continue;
    unresolvedSceneRefs.set(key, {
      chapterId: hit.chapterId,
      sceneIndex: hit.sceneIndex,
    });
  }

  if (unresolvedSceneRefs.size) {
    const extraScenes = await prisma.bookScene.findMany({
      where: {
        bookId: params.bookId,
        OR: Array.from(unresolvedSceneRefs.values()).map((ref) => ({
          chapterId: ref.chapterId,
          sceneIndex: ref.sceneIndex,
        })),
      },
      select: {
        id: true,
        chapterId: true,
        sceneIndex: true,
        paragraphStart: true,
        paragraphEnd: true,
        sceneCard: true,
        sceneSummary: true,
        participantsJson: true,
        mentionedEntitiesJson: true,
        locationHintsJson: true,
        timeHintsJson: true,
        eventLabelsJson: true,
        factsJson: true,
        evidenceSpansJson: true,
        excerptText: true,
        chapter: {
          select: {
            orderIndex: true,
            title: true,
          },
        },
      },
    });

    for (const scene of extraScenes) {
      const row = toSceneRow(scene);
      sceneById.set(row.sceneId, row);
      sceneIdByRefKey.set(makeSceneRefKey(row.chapterId, row.sceneIndex), row.sceneId);
    }
  }

  for (const hit of lexical.hits) {
    if (typeof hit.sceneIndex !== "number" || !Number.isFinite(hit.sceneIndex) || hit.sceneIndex <= 0) continue;
    const sceneId = sceneIdByRefKey.get(makeSceneRefKey(hit.chapterId, hit.sceneIndex));
    if (!sceneId || !sceneById.has(sceneId)) continue;

    lexicalScoreBySceneId.set(sceneId, (lexicalScoreBySceneId.get(sceneId) || 0) + Math.max(0, hit.score));
    if (!lexicalMatchedTermsBySceneId.has(sceneId)) {
      lexicalMatchedTermsBySceneId.set(sceneId, new Set<string>());
    }
    const termSet = lexicalMatchedTermsBySceneId.get(sceneId)!;
    for (const term of hit.matchedTerms || []) {
      const normalized = String(term || "").trim();
      if (!normalized) continue;
      termSet.add(normalized);
    }
  }

  const lexicalSceneCandidates = lexicalScoreBySceneId.size;
  const lexicalRankedSceneIds = Array.from(lexicalScoreBySceneId.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([sceneId]) => sceneId)
    .slice(0, safeTopK);
  const lexicalRankBySceneId = new Map<string, number>();
  for (let index = 0; index < lexicalRankedSceneIds.length; index += 1) {
    lexicalRankBySceneId.set(lexicalRankedSceneIds[index]!, index + 1);
  }

  const candidateSceneIds = Array.from(
    new Set([
      ...semanticTop.map((item) => item.scene.sceneId),
      ...lexicalRankedSceneIds,
    ])
  );

  const mergeStartedAt = nowMs();
  const combined = candidateSceneIds
    .map((sceneId) => {
      const scene = sceneById.get(sceneId);
      if (!scene) return null;

      const semanticRank = semanticRankBySceneId.get(sceneId) ?? null;
      const lexicalRank = lexicalRankBySceneId.get(sceneId) ?? null;
      const semanticRrf = semanticRank ? 1 / (HYBRID_RRF_K + semanticRank) : 0;
      const lexicalRrf = lexicalRank ? 1 / (HYBRID_RRF_K + lexicalRank) : 0;
      const score = semanticRrf * 0.5 + lexicalRrf * 0.5;
      const matchedTerms = Array.from(lexicalMatchedTermsBySceneId.get(sceneId) || []).slice(0, 16);

      return {
        ...scene,
        score,
        semanticRank,
        lexicalRank,
        matchedTerms,
      } satisfies SearchSceneResult;
    })
    .filter((item): item is SearchSceneResult => Boolean(item))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      return left.sceneIndex - right.sceneIndex;
    })
    .slice(0, safeTopK);
  const mergeMs = nowMs() - mergeStartedAt;

  return {
    hits: combined,
    embeddingInputTokens: Number(queryEmbedding.usage.input_tokens || 0),
    embeddingRows: semanticEmbeddingRows,
    lexicalParagraphHits,
    lexicalSceneCandidates,
    semanticConfidence: Number(semanticConfidence.toFixed(6)),
    hybridMode: "hybrid",
    sceneEmbeddingCacheHit,
    lexicalCacheHit: lexicalData.lexicalCacheHit,
    embeddingMs,
    semanticMs,
    lexicalMs: lexicalData.lexicalMs,
    mergeMs,
    totalMs: nowMs() - startedAt,
  };
}

async function getSceneContextTool(params: {
  bookId: string;
  primarySceneIds: string[];
  neighborWindow: number;
  maxScenes: number;
}): Promise<SceneRow[]> {
  if (!params.primarySceneIds.length) return [];

  const primaryRows = await prisma.bookScene.findMany({
    where: {
      bookId: params.bookId,
      id: {
        in: params.primarySceneIds,
      },
    },
    select: {
      id: true,
      chapterId: true,
      sceneIndex: true,
    },
  });

  if (!primaryRows.length) return [];

  const chapterIds = Array.from(new Set(primaryRows.map((item: any) => item.chapterId)));
  const chapterScenes = await prisma.bookScene.findMany({
    where: {
      bookId: params.bookId,
      chapterId: {
        in: chapterIds,
      },
    },
    orderBy: [{ chapter: { orderIndex: "asc" } }, { sceneIndex: "asc" }],
    select: {
      id: true,
      chapterId: true,
      sceneIndex: true,
      paragraphStart: true,
      paragraphEnd: true,
      sceneCard: true,
      sceneSummary: true,
      participantsJson: true,
      mentionedEntitiesJson: true,
      locationHintsJson: true,
      timeHintsJson: true,
      eventLabelsJson: true,
      factsJson: true,
      evidenceSpansJson: true,
      excerptText: true,
      chapter: {
        select: {
          orderIndex: true,
          title: true,
        },
      },
    },
  });

  const indexByChapter = new Map<string, Map<number, string>>();
  for (const scene of chapterScenes) {
    if (!indexByChapter.has(scene.chapterId)) {
      indexByChapter.set(scene.chapterId, new Map());
    }
    indexByChapter.get(scene.chapterId)!.set(scene.sceneIndex, scene.id);
  }

  const selectedIds = new Set<string>();
  for (const primary of primaryRows) {
    const chapterIndexMap = indexByChapter.get(primary.chapterId);
    if (!chapterIndexMap) continue;

    const from = Math.max(1, primary.sceneIndex - params.neighborWindow);
    const to = primary.sceneIndex + params.neighborWindow;

    for (let sceneIndex = from; sceneIndex <= to; sceneIndex += 1) {
      const candidateId = chapterIndexMap.get(sceneIndex);
      if (candidateId) {
        selectedIds.add(candidateId);
      }
    }
  }

  return chapterScenes
    .filter((scene: any) => selectedIds.has(scene.id))
    .slice(0, params.maxScenes)
    .map((scene: any) => toSceneRow(scene));
}

async function getParagraphSliceTool(params: {
  bookId: string;
  chapterId: string;
  paragraphStart: number;
  paragraphEnd: number;
}): Promise<ParagraphSliceResult | null> {
  const corpus = await resolveBookTextCorpus({
    client: prisma,
    bookId: params.bookId,
    logger: bookTextCorpusLogger,
    cacheTtlMs: BOOK_SEARCH_CACHE_TTL_MS,
    cacheMaxBooks: BOOK_SEARCH_CACHE_MAX_BOOKS,
  });
  const chapter = corpus.chapters.find((item) => item.chapterId === params.chapterId);

  if (!chapter) return null;

  const paragraphs = splitChapterToParagraphs(chapter.rawText);
  const from = Math.max(1, Number(params.paragraphStart || 1));
  const to = Math.min(paragraphs.length, Math.max(from, Number(params.paragraphEnd || from)));

  const sliceText = paragraphs
    .slice(from - 1, to)
    .join("\n\n")
    .trim();

  if (!sliceText) return null;

  return {
    chapterId: chapter.chapterId,
    chapterOrderIndex: chapter.orderIndex,
    chapterTitle: chapter.title,
    paragraphStart: from,
    paragraphEnd: to,
    text: sliceText,
  };
}

async function searchParagraphsLexicalTool(params: {
  bookId: string;
  query: string;
  topK: number;
  context?: BookSearchContext;
  corpus?: LexicalSearchCorpus;
}): Promise<{
  hits: LexicalParagraphSearchHit[];
  queryNormalized: string;
  queryTerms: string[];
  cacheHit: boolean;
}> {
  const queryNormalized = normalizeLexicalSearchQuery(params.query);
  const queryTerms = tokenizeLexicalSearchQuery(queryNormalized);
  if (!queryNormalized || !queryTerms.length) {
    return {
      hits: [],
      queryNormalized,
      queryTerms,
      cacheHit: true,
    };
  }

  const corpusHit = Boolean(params.corpus);
  const corpusEntry = params.corpus
    ? {
        value: params.corpus,
        hit: corpusHit,
      }
    : await getLexicalCorpusCache({
        bookId: params.bookId,
        context: params.context,
      });
  const corpus = corpusEntry.value;
  const cacheHit = corpusEntry.hit;

  const queryNgrams = buildCharNgramSet(queryNormalized, LEXICAL_CHAR_NGRAM_SIZE);

  const rows: LexicalParagraphSearchHit[] = [];
  const documentCount = corpus.documentCount;
  const averageDocumentLength = corpus.averageDocumentLength;
  for (const paragraph of corpus.paragraphDocs) {
    const bm25Score = computeBm25Score({
      queryTerms,
      documentCount,
      averageDocumentLength,
      documentLength: paragraph.termCount,
      documentTermFrequency: paragraph.termFrequency,
      documentFrequencyByTerm: corpus.documentFrequencyByTerm,
    });
    const matchedTerms: string[] = [];
    let exactMatchCount = 0;
    let fuzzyMatchScore = 0;
    for (const term of queryTerms) {
      if ((paragraph.termFrequency.get(term) || 0) > 0) {
        matchedTerms.push(term);
        exactMatchCount += 1;
        continue;
      }

      const fuzzy = findBestFuzzyTokenMatch(term, paragraph.uniqueTerms);
      if (fuzzy >= 0.72) {
        matchedTerms.push(term);
        fuzzyMatchScore += fuzzy;
      }
    }
    const exactPhraseBoost = queryNormalized.length >= 6 && paragraph.normalized.includes(queryNormalized) ? 1 : 0;
    const ngramSimilarity = diceCoefficient(queryNgrams, buildCharNgramSet(paragraph.normalized, LEXICAL_CHAR_NGRAM_SIZE));
    const combinedTermSignal = exactMatchCount + fuzzyMatchScore * 0.9;
    const coverageScore = queryTerms.length > 0 ? combinedTermSignal / queryTerms.length : 0;
    const minimumSignal =
      queryTerms.length >= 6 ? 2.3 : queryTerms.length >= 4 ? 1.9 : queryTerms.length >= 3 ? 1.4 : 0.8;
    if (combinedTermSignal < minimumSignal && exactPhraseBoost <= 0) continue;

    const bm25Weighted = bm25Score * (0.4 + coverageScore);
    const score = bm25Weighted + exactPhraseBoost + coverageScore * 4 + fuzzyMatchScore * 1.2 + ngramSimilarity * 0.6;
    if (score <= 0) continue;

    rows.push({
      chapterId: paragraph.chapterId,
      chapterOrderIndex: paragraph.chapterOrderIndex,
      chapterTitle: paragraph.chapterTitle,
      paragraphIndex: paragraph.paragraphIndex,
      sceneIndex: paragraph.sceneIndex,
      score,
      matchedTerms,
      text: paragraph.text,
    });
  }

  const topK = Math.max(1, Math.min(MAX_LEXICAL_SEARCH_RESULTS, Number(params.topK || 8)));
  const hits = rows
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      return left.paragraphIndex - right.paragraphIndex;
    })
    .slice(0, topK)
    .map((row) => ({
      ...row,
      score: Number(row.score.toFixed(6)),
    }));

  return {
    hits,
    queryNormalized,
    queryTerms,
    cacheHit,
  };
}

async function searchParagraphsHybridTool(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  query: string;
  topK: number;
  context?: BookSearchContext;
}): Promise<{
  hits: HybridParagraphSearchHit[];
  embeddingRows: number;
  embeddingInputTokens: number;
  lexicalParagraphHits: number;
  semanticConfidence: number;
  queryNormalized: string;
  queryTerms: string[];
  paragraphEmbeddingCacheHit: boolean;
  lexicalCacheHit: boolean;
  embeddingMs: number;
  semanticMs: number;
  lexicalMs: number;
  textFetchMs: number;
  mergeMs: number;
  totalMs: number;
}> {
  const startedAt = nowMs();
  const context = await ensureBookSearchContext(params.bookId, params.context);
  const safeTopK = Math.max(1, Math.min(MAX_HYBRID_PARAGRAPH_RESULTS, Number(params.topK || DEFAULT_HYBRID_PARAGRAPH_TOP_K)));
  const lexicalProbeTopK = Math.max(
    HYBRID_PARAGRAPH_LEXICAL_PROBE_MIN_TOP_K,
    Math.min(MAX_LEXICAL_SEARCH_RESULTS, safeTopK * HYBRID_PARAGRAPH_LEXICAL_PROBE_FACTOR)
  );
  const lexicalCorpusPromise = getLexicalCorpusCache({
    bookId: params.bookId,
    context,
  });
  const lexicalPromise = (async () => {
    const corpus = await lexicalCorpusPromise;
    const lexicalStartedAt = nowMs();
    const lexical = await searchParagraphsLexicalTool({
      bookId: params.bookId,
      query: params.query,
      topK: lexicalProbeTopK,
      context,
      corpus: corpus.value,
    });
    return {
      lexical,
      lexicalMs: nowMs() - lexicalStartedAt,
      lexicalCorpus: corpus.value,
      lexicalCacheHit: corpus.hit,
    };
  })();

  const embeddingStartedAt = nowMs();
  const queryEmbedding = await withSemaphore(embeddingCallSemaphore, async () =>
    params.client.embeddings.create({
      text: params.query,
      taskType: "RETRIEVAL_QUERY",
      autoTruncate: true,
    })
  );
  const embeddingMs = nowMs() - embeddingStartedAt;

  const semanticStartedAt = nowMs();
  const queryVector = queryEmbedding.vector || [];
  let lexicalData!: {
    lexical: Awaited<ReturnType<typeof searchParagraphsLexicalTool>>;
    lexicalMs: number;
    lexicalCorpus: LexicalSearchCorpus;
    lexicalCacheHit: boolean;
  };
  let semanticScored: Array<{
    chapterId: string;
    chapterOrderIndex: number;
    chapterTitle: string;
    paragraphIndex: number;
    refKey: string;
    text: string;
    semanticScore: number;
  }> = [];
  let semanticEmbeddingRows = 0;
  const paragraphEmbeddingCacheHit = false;
  let textFetchMs = 0;

  const [semanticSearch, nextLexicalData] = await Promise.all([
    searchParagraphsSemanticSql({
      bookId: params.bookId,
      queryVector,
      topK: safeTopK,
    }),
    lexicalPromise,
  ]);
  lexicalData = nextLexicalData;
  semanticScored = semanticSearch.rows;
  semanticEmbeddingRows = semanticSearch.embeddingRows;
  const semanticMs = nowMs() - semanticStartedAt;

  const semanticConfidence = computeSemanticSearchConfidence(semanticScored.map((item) => item.semanticScore));
  const semanticTop = semanticScored.slice(0, safeTopK);
  const semanticRankByRef = new Map<string, number>();
  for (let index = 0; index < semanticTop.length; index += 1) {
    const row = semanticTop[index]!;
    semanticRankByRef.set(row.refKey, index + 1);
  }

  const lexical = lexicalData.lexical;
  const lexicalParagraphHits = lexical.hits.length;
  const lexicalTop = lexical.hits.slice(0, safeTopK);
  const lexicalRankByRef = new Map<string, number>();
  for (let index = 0; index < lexicalTop.length; index += 1) {
    const row = lexicalTop[index]!;
    lexicalRankByRef.set(makeParagraphRefKey(row.chapterId, row.paragraphIndex), index + 1);
  }

  const lexicalMatchedTermsByRef = new Map<string, Set<string>>();
  for (const row of lexical.hits) {
    const key = makeParagraphRefKey(row.chapterId, row.paragraphIndex);
    if (!lexicalMatchedTermsByRef.has(key)) {
      lexicalMatchedTermsByRef.set(key, new Set<string>());
    }
    const termSet = lexicalMatchedTermsByRef.get(key)!;
    for (const term of row.matchedTerms || []) {
      const normalized = String(term || "").trim();
      if (!normalized) continue;
      termSet.add(normalized);
    }
  }

  const paragraphByRef = new Map<
    string,
    {
      chapterId: string;
      chapterOrderIndex: number;
      chapterTitle: string;
      paragraphIndex: number;
      sceneIndex: number | null;
      text: string;
    }
  >();
  for (const row of semanticTop) {
    paragraphByRef.set(row.refKey, {
      chapterId: row.chapterId,
      chapterOrderIndex: row.chapterOrderIndex,
      chapterTitle: row.chapterTitle,
      paragraphIndex: row.paragraphIndex,
      sceneIndex: null,
      text: row.text,
    });
  }
  for (const row of lexical.hits) {
    const key = makeParagraphRefKey(row.chapterId, row.paragraphIndex);
    if (paragraphByRef.has(key)) continue;
    paragraphByRef.set(key, {
      chapterId: row.chapterId,
      chapterOrderIndex: row.chapterOrderIndex,
      chapterTitle: row.chapterTitle,
      paragraphIndex: row.paragraphIndex,
      sceneIndex: row.sceneIndex,
      text: normalizeText(row.text),
    });
  }

  const candidateRefs = Array.from(
    new Set([
      ...semanticTop.map((row) => row.refKey),
      ...lexicalTop.map((row) => makeParagraphRefKey(row.chapterId, row.paragraphIndex)),
    ])
  );

  const mergeStartedAt = nowMs();
  const hits = candidateRefs
    .map((ref) => {
      const base = paragraphByRef.get(ref);
      if (!base) return null;

      const semanticRank = semanticRankByRef.get(ref) ?? null;
      const lexicalRank = lexicalRankByRef.get(ref) ?? null;
      const semanticRrf = semanticRank ? 1 / (HYBRID_RRF_K + semanticRank) : 0;
      const lexicalRrf = lexicalRank ? 1 / (HYBRID_RRF_K + lexicalRank) : 0;
      const score = semanticRrf * 0.5 + lexicalRrf * 0.5;
      const matchedTerms = Array.from(lexicalMatchedTermsByRef.get(ref) || []).slice(0, 16);
      const sceneIndex =
        typeof base.sceneIndex === "number" && Number.isFinite(base.sceneIndex)
          ? base.sceneIndex
          : lexicalData.lexicalCorpus.paragraphSceneIndexByRef.get(ref) ?? null;

      return {
        chapterId: base.chapterId,
        chapterOrderIndex: base.chapterOrderIndex,
        chapterTitle: base.chapterTitle,
        paragraphIndex: base.paragraphIndex,
        sceneIndex,
        score: Number(score.toFixed(6)),
        semanticRank,
        lexicalRank,
        matchedTerms,
        text: base.text,
      } satisfies HybridParagraphSearchHit;
    })
    .filter((item): item is HybridParagraphSearchHit => Boolean(item))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      return left.paragraphIndex - right.paragraphIndex;
    })
    .slice(0, safeTopK);
  const mergeMs = nowMs() - mergeStartedAt;

  return {
    hits,
    embeddingRows: semanticEmbeddingRows,
    embeddingInputTokens: Number(queryEmbedding.usage.input_tokens || 0),
    lexicalParagraphHits,
    semanticConfidence: Number(semanticConfidence.toFixed(6)),
    queryNormalized: lexical.queryNormalized,
    queryTerms: lexical.queryTerms,
    paragraphEmbeddingCacheHit,
    lexicalCacheHit: lexicalData.lexicalCacheHit,
    embeddingMs,
    semanticMs,
    lexicalMs: lexicalData.lexicalMs,
    textFetchMs,
    mergeMs,
    totalMs: nowMs() - startedAt,
  };
}

function formatSearchHitsForPrompt(hits: SearchSceneResult[]) {
  return hits.map((hit) => ({
    sceneId: hit.sceneId,
    chapterId: hit.chapterId,
    chapterOrderIndex: hit.chapterOrderIndex,
    chapterTitle: hit.chapterTitle,
    sceneIndex: hit.sceneIndex,
    paragraphStart: hit.paragraphStart,
    paragraphEnd: hit.paragraphEnd,
    score: Number(hit.score.toFixed(6)),
    semanticRank: hit.semanticRank,
    lexicalRank: hit.lexicalRank,
    matchedTerms: hit.matchedTerms,
    sceneCard: hit.sceneCard || hit.sceneSummary,
    participants: hit.participants,
    eventLabels: hit.eventLabels,
    locationHints: hit.locationHints,
    timeHints: hit.timeHints,
  }));
}

function formatContextForPrompt(rows: SceneRow[]) {
  return rows.map((row) => ({
    sceneId: row.sceneId,
    chapterId: row.chapterId,
    chapterOrderIndex: row.chapterOrderIndex,
    chapterTitle: row.chapterTitle,
    sceneIndex: row.sceneIndex,
    paragraphStart: row.paragraphStart,
    paragraphEnd: row.paragraphEnd,
    sceneCard: row.sceneCard,
    sceneSummary: row.sceneSummary,
    participants: row.participants,
    mentionedEntities: row.mentionedEntities,
    locationHints: row.locationHints,
    timeHints: row.timeHints,
    eventLabels: row.eventLabels,
    facts: row.facts,
    evidenceSpans: row.evidenceSpans,
    excerptText: clampText(row.excerptText, MAX_EXCERPT_CHARS),
  }));
}

function formatSlicesForPrompt(rows: ParagraphSliceResult[]) {
  return rows.map((row) => ({
    chapterOrderIndex: row.chapterOrderIndex,
    chapterTitle: row.chapterTitle,
    paragraphStart: row.paragraphStart,
    paragraphEnd: row.paragraphEnd,
    text: clampText(row.text, MAX_SLICE_CHARS),
  }));
}

function formatParagraphHitsForPrompt(hits: HybridParagraphSearchHit[]) {
  return hits.map((hit) => ({
    chapterId: hit.chapterId,
    chapterOrderIndex: hit.chapterOrderIndex,
    chapterTitle: hit.chapterTitle,
    sceneIndex: hit.sceneIndex,
    paragraphIndex: hit.paragraphIndex,
    score: Number(hit.score.toFixed(6)),
    semanticRank: hit.semanticRank,
    lexicalRank: hit.lexicalRank,
    matchedTerms: hit.matchedTerms,
    text: clampText(hit.text, 900),
  }));
}

type BookChatToolCapture = {
  searchHits: SearchSceneResult[];
  paragraphHits: HybridParagraphSearchHit[];
  contextScenes: SceneRow[];
  paragraphSlices: ParagraphSliceResult[];
};

function createBookChatToolCapture(): BookChatToolCapture {
  return {
    searchHits: [],
    paragraphHits: [],
    contextScenes: [],
    paragraphSlices: [],
  };
}

function buildFallbackEvidenceSnapshot(capture: BookChatToolCapture) {
  const searchHits = formatSearchHitsForPrompt(capture.searchHits)
    .slice(0, 8)
    .map((row) => ({
      ...row,
      sceneCard: clampText(row.sceneCard, 260),
    }));

  const contextScenes = formatContextForPrompt(capture.contextScenes)
    .slice(0, 8)
    .map((row) => ({
      ...row,
      sceneCard: clampText(row.sceneCard, 260),
      sceneSummary: clampText(row.sceneSummary, 260),
      facts: row.facts.slice(0, 6),
      evidenceSpans: row.evidenceSpans.slice(0, 4),
      excerptText: clampText(row.excerptText, 420),
    }));

  const paragraphHits = formatParagraphHitsForPrompt(capture.paragraphHits)
    .slice(0, 8)
    .map((row) => ({
      ...row,
      text: clampText(row.text, 320),
    }));

  const paragraphSlices = formatSlicesForPrompt(capture.paragraphSlices)
    .slice(0, 4)
    .map((row) => ({
      ...row,
      text: clampText(row.text, 560),
    }));

  return {
    searchHits,
    paragraphHits,
    contextScenes,
    paragraphSlices,
  };
}

function buildDeterministicFallbackAnswer(capture: BookChatToolCapture): string | null {
  if (capture.paragraphSlices.length) {
    const slice = formatSlicesForPrompt([capture.paragraphSlices[0]!])[0]!;
    return `Нашёл релевантный фрагмент: глава ${slice.chapterOrderIndex}, абз. ${slice.paragraphStart}-${slice.paragraphEnd}. ${clampText(
      slice.text,
      320
    )}`;
  }

  if (capture.paragraphHits.length) {
    const hit = formatParagraphHitsForPrompt([capture.paragraphHits[0]!])[0]!;
    return `Нашёл релевантный абзац: глава ${hit.chapterOrderIndex}, абз. ${hit.paragraphIndex}. ${clampText(
      hit.text,
      320
    )}`;
  }

  const scenes = capture.searchHits.length ? capture.searchHits : capture.contextScenes;
  if (scenes.length) {
    const refs = scenes
      .slice(0, 3)
      .map((scene) => `глава ${scene.chapterOrderIndex}, сцена ${scene.sceneIndex}`)
      .join("; ");
    const sceneLead = clampText(scenes[0]!.sceneCard || scenes[0]!.sceneSummary, 260);
    if (sceneLead) {
      return `Нашёл релевантные эпизоды (${refs}). Ключевой фрагмент: ${sceneLead}`;
    }
    return `Нашёл релевантные эпизоды: ${refs}.`;
  }

  return null;
}

async function synthesizeFallbackAnswerFromCapture(params: {
  model: ReturnType<typeof createVertexChatModelFromConfig>;
  providerOptions: ReturnType<typeof createVertexReasoningProviderOptions>;
  bookTitle: string;
  userQuestion: string;
  capture: BookChatToolCapture;
}): Promise<{ answer: string | null; usage?: LanguageModelUsage }> {
  const evidence = buildFallbackEvidenceSnapshot(params.capture);
  const evidenceHasData =
    evidence.searchHits.length > 0 || evidence.contextScenes.length > 0 || evidence.paragraphSlices.length > 0;
  if (!evidenceHasData) {
    return { answer: null };
  }

  try {
    const completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: params.model,
        temperature: 0,
        system:
          "Ты отвечаешь строго по уже собранным данным книги. Не используй внешние знания. Если данных мало, прямо скажи, чего не хватает.",
        prompt: `Книга: ${params.bookTitle}
Вопрос пользователя: ${params.userQuestion}

Данные из инструментов (JSON):
${JSON.stringify(evidence)}

Дай короткий ответ на русском (2-5 предложений), опираясь только на эти данные.`,
        providerOptions: params.providerOptions,
      })
    );

    const answer = String(completion.text || "").trim();
    return {
      answer: answer || null,
      usage: completion.usage,
    };
  } catch {
    return { answer: null };
  }
}

function deriveCitationsFromToolCapture(capture: BookChatToolCapture): ChatCitation[] {
  if (capture.contextScenes.length) {
    return defaultCitationsFromScenes(capture.contextScenes);
  }
  if (capture.paragraphHits.length) {
    const citations: ChatCitation[] = [];
    for (const hit of capture.paragraphHits.slice(0, 8)) {
      if (!hit.sceneIndex || hit.sceneIndex <= 0) continue;
      citations.push({
        chapterOrderIndex: hit.chapterOrderIndex,
        sceneIndex: hit.sceneIndex,
        paragraphStart: hit.paragraphIndex,
        paragraphEnd: hit.paragraphIndex,
        reason: clampText(hit.text, 220) || "paragraph evidence",
      });
      if (citations.length >= 6) break;
    }
    if (citations.length) return citations;
  }
  if (capture.searchHits.length) {
    return defaultCitationsFromScenes(capture.searchHits);
  }
  return [];
}

function createBookChatSystemPrompt(bookTitle: string, enabledTools: readonly BookChatToolName[]): string {
  const normalizedTools = normalizeEnabledBookChatTools(enabledTools);
  const available = new Set(normalizedTools);
  const lines = [
    `Ты литературный ассистент по одной книге: "${bookTitle}".`,
    "",
    "Ты работаешь только по данным, полученным через инструменты.",
    "Не используй память, внешние знания, другие книги, фильмы, фанатские знания или догадки.",
  ];

  if (!normalizedTools.length) {
    lines.push("", "Инструменты отключены. Честно скажи, что без инструментов по книге ответить нельзя.");
    return lines.join("\n");
  }

  lines.push("", "Доступные инструменты:");
  for (const tool of normalizedTools) {
    lines.push(`- ${tool}: ${BOOK_CHAT_TOOL_META[tool].description}`);
  }

  lines.push(
    "",
    "Общие правила:",
    "- Не отвечай, пока не получишь достаточно данных из инструментов.",
    "- Отвечай только на основе результатов инструментов.",
    "- Не выдумывай факты, которых нет в книге.",
    "- Если данных не хватает, прямо скажи об этом.",
    "- Избегай бесконечных переформулировок одного и того же запроса; обычно достаточно 1-3 поисков.",
    "- После 6 инструментальных вызовов дай лучший возможный ответ по уже найденным данным.",
    "- Отвечай на русском, коротко и по делу."
  );

  lines.push("", "Правила маршрутизации:");
  if (available.has("search_paragraphs_hybrid")) {
    lines.push(
      '- Для факт-чека, вопросов "как именно", "почему", "правда ли", "когда именно", "чем подтверждается" сначала вызывай search_paragraphs_hybrid.',
      '- Для вопросов "впервые", "где появляется", "когда именно", "правда ли", "почему" проверяй несколько paragraph hits, а не один.'
    );
  }

  if (available.has("search_scenes")) {
    lines.push(
      '- Для вопросов о сценах и эпизодах (структура сюжета, локальный эпизод, список эпизодов) сначала вызывай search_scenes.',
      '- Для вопросов "впервые", "где появляется", "в каких сценах", "кто участвует" ищи несколько сцен и сравнивай их по порядку в книге.'
    );
    if (available.has("get_scene_context")) {
      lines.push(
        "- После поиска сцен добирай get_scene_context, когда нужен расширенный состав участников, соседние сцены или локальный контекст."
      );
    } else {
      lines.push("- Если get_scene_context недоступен, работай только по самим найденным сценам и не выдумывай соседний контекст.");
    }
  } else if (available.has("search_paragraphs_hybrid")) {
    lines.push(
      "- Поиск сцен отключен. Для вопросов о сценах и эпизодах отвечай по найденным абзацам и явно опирайся на paragraph evidence, а не на scene graph."
    );
  }

  if (available.has("get_scene_context") && !available.has("search_scenes")) {
    lines.push("- get_scene_context используй только если sceneIds уже даны явно; иначе не трать шаг на этот инструмент.");
  }

  if (available.has("get_paragraph_slice")) {
    lines.push(
      "- Для дословной цитаты, точной формулировки или проверки спорного места сначала найди релевантный фрагмент, затем вызови get_paragraph_slice."
    );
  } else {
    lines.push("- Если нужен дословный фрагмент, а get_paragraph_slice недоступен, честно скажи, что точную цитату ты не проверил.");
  }

  lines.push(
    "",
    "Дефолты инструментов:",
    ...(available.has("search_paragraphs_hybrid")
      ? ['- search_paragraphs_hybrid: topK=10 для факт-чека и вопросов "как именно/почему/правда ли/когда именно".']
      : []),
    ...(available.has("search_scenes")
      ? [
          "- search_scenes: topK=8 для простых локальных вопросов.",
          '- search_scenes: topK=12 для вопросов "впервые", "где появляется", "в каких сценах", "кто участвует", "почему", "когда именно", "правда ли".',
        ]
      : []),
    ...(available.has("get_scene_context") ? ["- get_scene_context: обычно neighborWindow=1..2."] : []),
    "",
    "Формат ответа:",
    "- коротко",
    "- по существу",
    "- без упоминания внутренних шагов, если пользователь этого не просил",
    "- если уверенность ограничена найденными данными, прямо скажи это"
  );

  return lines.join("\n");
}

function createBookChatTools(params: {
  bookId: string;
  client: ReturnType<typeof createVertexClient>;
  toolRuns: ChatToolRun[];
  capture: BookChatToolCapture;
  enabledTools?: readonly BookChatToolName[];
}) {
  const enabledTools = normalizeEnabledBookChatTools(params.enabledTools);
  const enabled = new Set(enabledTools);
  let searchContextPromise: Promise<BookSearchContext> | null = null;
  const getSearchContext = () => {
    if (!searchContextPromise) {
      searchContextPromise = resolveBookSearchContext(params.bookId);
    }
    return searchContextPromise;
  };

  return {
    ...(enabled.has("search_scenes")
      ? {
          search_scenes: tool({
      description:
        'Гибридный поиск релевантных сцен книги: семантика и лексика всегда используются вместе, затем объединяются одним ранжированием. Используй первым шагом. Важно: top results могут быть неполными, поздними или не самыми ранними. Для вопросов "впервые", "где появляется", "в каких сценах", "кто участвует" запрашивай несколько кандидатов.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(800),
        topK: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      }),
      execute: async ({ query, topK }) => {
        const safeQuery = String(query || "").trim();
        const requestedTopK = Number(topK);
        const fallbackTopK = defaultSearchTopK(safeQuery);
        const safeTopK = Math.max(
          SEARCH_PROMPT_MIN_TOP_K,
          Math.min(
            SEARCH_PROMPT_MAX_TOP_K,
            Number.isFinite(requestedTopK) && requestedTopK > 0 ? requestedTopK : fallbackTopK
          )
        );
        if (!safeQuery) {
          params.toolRuns.push({
            tool: "search_scenes",
            args: { query: safeQuery, topK: safeTopK },
            resultMeta: { returned: 0, error: "empty query" },
          });
          return {
            hits: [],
            sceneIds: [],
            error: "empty query",
          };
        }

        const search = await searchScenesTool({
          client: params.client,
          bookId: params.bookId,
          query: safeQuery,
          topK: safeTopK,
          context: await getSearchContext(),
        });

        params.capture.searchHits = search.hits;
        params.toolRuns.push({
          tool: "search_scenes",
          args: {
            query: safeQuery,
            topK: safeTopK,
          },
          resultMeta: {
            returned: search.hits.length,
            embeddingRows: search.embeddingRows,
            embeddingInputTokens: search.embeddingInputTokens,
            lexicalParagraphHits: search.lexicalParagraphHits,
            lexicalSceneCandidates: search.lexicalSceneCandidates,
            semanticConfidence: search.semanticConfidence,
            hybridMode: search.hybridMode,
            sceneEmbeddingCacheHit: search.sceneEmbeddingCacheHit,
            lexicalCacheHit: search.lexicalCacheHit,
            embeddingMs: search.embeddingMs,
            semanticMs: search.semanticMs,
            lexicalMs: search.lexicalMs,
            mergeMs: search.mergeMs,
            totalMs: search.totalMs,
          },
        });

        return {
          hits: formatSearchHitsForPrompt(search.hits.slice(0, safeTopK)),
          sceneIds: search.hits.map((item) => item.sceneId),
          hybridMode: search.hybridMode,
          semanticConfidence: search.semanticConfidence,
        };
      },
          }),
        }
      : {}),
    ...(enabled.has("search_paragraphs_hybrid")
      ? {
          search_paragraphs_hybrid: tool({
      description:
        'Гибридный поиск по абзацам (семантика + лексика). Используй первым шагом для факт-чека и вопросов "как именно", "почему", "правда ли", "когда именно". Возвращает точечные абзацы с рангами.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(800),
        topK: z.coerce.number().int().min(1).max(MAX_HYBRID_PARAGRAPH_RESULTS).optional(),
      }),
      execute: async ({ query, topK }) => {
        const safeQuery = String(query || "").trim();
        const requestedTopK = Number(topK);
        const safeTopK = Math.max(
          HYBRID_PARAGRAPH_PROMPT_MIN_TOP_K,
          Math.min(
            HYBRID_PARAGRAPH_PROMPT_MAX_TOP_K,
            Number.isFinite(requestedTopK) && requestedTopK > 0 ? requestedTopK : DEFAULT_HYBRID_PARAGRAPH_TOP_K
          )
        );
        if (!safeQuery) {
          params.toolRuns.push({
            tool: "search_paragraphs_hybrid",
            args: { query: safeQuery, topK: safeTopK },
            resultMeta: { returned: 0, error: "empty query" },
          });
          return {
            hits: [],
            error: "empty query",
          };
        }

        const search = await searchParagraphsHybridTool({
          client: params.client,
          bookId: params.bookId,
          query: safeQuery,
          topK: safeTopK,
          context: await getSearchContext(),
        });
        params.capture.paragraphHits = search.hits;
        params.toolRuns.push({
          tool: "search_paragraphs_hybrid",
          args: {
            query: safeQuery,
            topK: safeTopK,
          },
          resultMeta: {
            returned: search.hits.length,
            embeddingRows: search.embeddingRows,
            embeddingInputTokens: search.embeddingInputTokens,
            lexicalParagraphHits: search.lexicalParagraphHits,
            semanticConfidence: search.semanticConfidence,
            queryTerms: search.queryTerms,
            paragraphEmbeddingCacheHit: search.paragraphEmbeddingCacheHit,
            lexicalCacheHit: search.lexicalCacheHit,
            embeddingMs: search.embeddingMs,
            semanticMs: search.semanticMs,
            lexicalMs: search.lexicalMs,
            textFetchMs: search.textFetchMs,
            mergeMs: search.mergeMs,
            totalMs: search.totalMs,
          },
        });

        return {
          hits: formatParagraphHitsForPrompt(search.hits.slice(0, safeTopK)),
          semanticConfidence: search.semanticConfidence,
          queryTerms: search.queryTerms,
        };
      },
          }),
        }
      : {}),
    ...(enabled.has("get_scene_context")
      ? {
          get_scene_context: tool({
      description:
        "Возвращает расширенный контекст по найденным сценам и соседним сценам. Используй, когда нужен полный состав участников, связанный эпизод или проверка локального контекста.",
      inputSchema: z.object({
        sceneIds: z.array(z.string().trim().min(1)).min(1).max(24),
        neighborWindow: z.coerce.number().int().min(0).max(3).optional(),
        maxScenes: z.coerce.number().int().min(1).max(CONTEXT_SCENE_LIMIT).optional(),
      }),
      execute: async ({ sceneIds, neighborWindow, maxScenes }) => {
        const startedAt = Date.now();
        const safeSceneIds = Array.from(
          new Set(
            (sceneIds || [])
              .map((item) => String(item || "").trim())
              .filter(Boolean)
          )
        ).slice(0, 24);
        const safeNeighborWindow = Math.max(0, Math.min(3, Number(neighborWindow ?? NEIGHBOR_WINDOW)));
        const safeMaxScenes = Math.max(1, Math.min(CONTEXT_SCENE_LIMIT, Number(maxScenes ?? CONTEXT_SCENE_LIMIT)));

        if (!safeSceneIds.length) {
          params.toolRuns.push({
            tool: "get_scene_context",
            args: {
              sceneIds: [],
              neighborWindow: safeNeighborWindow,
              maxScenes: safeMaxScenes,
            },
            resultMeta: {
              returned: 0,
              error: "no sceneIds",
              totalMs: Date.now() - startedAt,
            },
          });
          return {
            scenes: [],
            error: "no sceneIds",
          };
        }

        const contextScenes = await getSceneContextTool({
          bookId: params.bookId,
          primarySceneIds: safeSceneIds,
          neighborWindow: safeNeighborWindow,
          maxScenes: safeMaxScenes,
        });

        params.capture.contextScenes = contextScenes;
        params.toolRuns.push({
          tool: "get_scene_context",
          args: {
            sceneIds: safeSceneIds,
            neighborWindow: safeNeighborWindow,
            maxScenes: safeMaxScenes,
          },
          resultMeta: {
            returned: contextScenes.length,
            totalMs: Date.now() - startedAt,
          },
        });

        return {
          scenes: formatContextForPrompt(contextScenes),
        };
      },
          }),
        }
      : {}),
    ...(enabled.has("get_paragraph_slice")
      ? {
          get_paragraph_slice: tool({
      description:
        "Возвращает точный текст абзацев. Используй для цитат, дословных формулировок и финальной проверки спорного места.",
      inputSchema: z.object({
        chapterId: z.string().trim().min(1),
        paragraphStart: z.coerce.number().int().min(1),
        paragraphEnd: z.coerce.number().int().min(1),
      }),
      execute: async ({ chapterId, paragraphStart, paragraphEnd }) => {
        const startedAt = Date.now();
        const safeChapterId = String(chapterId || "").trim();
        const safeStart = Math.max(1, Number(paragraphStart || 1));
        const safeEnd = Math.max(safeStart, Number(paragraphEnd || safeStart));

        const slice = await getParagraphSliceTool({
          bookId: params.bookId,
          chapterId: safeChapterId,
          paragraphStart: safeStart,
          paragraphEnd: safeEnd,
        });

        if (slice) {
          params.capture.paragraphSlices = [...params.capture.paragraphSlices, slice].slice(-8);
        }
        params.toolRuns.push({
          tool: "get_paragraph_slice",
          args: {
            chapterId: safeChapterId,
            paragraphStart: safeStart,
            paragraphEnd: safeEnd,
          },
          resultMeta: {
            returned: slice ? 1 : 0,
            totalMs: Date.now() - startedAt,
          },
        });

        return {
          slice: slice ? formatSlicesForPrompt([slice])[0] : null,
        };
      },
          }),
        }
      : {}),
  };
}

function parseSceneIdsArg(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 24);
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  return Array.from(
    new Set(
      raw
        .split(/[\n,\s]+/gu)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, 24);
}

export async function runBookChatToolboxTool(params: {
  bookId: string;
  tool: BookChatToolboxToolName;
  args?: Record<string, unknown>;
}): Promise<BookChatToolboxRunResult> {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const bookExists = await prisma.book.findUnique({
    where: {
      id: bookId,
    },
    select: {
      id: true,
    },
  });
  if (!bookExists) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const args = asRecord(params.args);
  let searchContextPromise: Promise<BookSearchContext> | null = null;
  const getSearchContext = () => {
    if (!searchContextPromise) {
      searchContextPromise = resolveBookSearchContext(bookId);
    }
    return searchContextPromise;
  };

  if (params.tool === "search_scenes") {
    const query = String(args.query || "").trim();
    const topKRaw = Number.parseInt(String(args.topK ?? ""), 10);
    const topK = Math.max(
      1,
      Math.min(
        MAX_SEARCH_RESULTS,
        Number.isFinite(topKRaw) && topKRaw > 0 ? topKRaw : defaultSearchTopK(query)
      )
    );
    if (!query) {
      throw new BookChatError("INVALID_TOOL_ARGS", 400, "query is required");
    }

    const client = createVertexClient();
    if (!client.config.apiKey) {
      throw new BookChatError("VERTEX_NOT_CONFIGURED", 409, "VERTEX_API_KEY is not configured");
    }

    const search = await searchScenesTool({
      client,
      bookId,
      query,
      topK,
      context: await getSearchContext(),
    });

    return {
      tool: params.tool,
      normalizedArgs: {
        query,
        topK,
      },
      outputMeta: {
        returned: search.hits.length,
        embeddingRows: search.embeddingRows,
        embeddingInputTokens: search.embeddingInputTokens,
        lexicalParagraphHits: search.lexicalParagraphHits,
        lexicalSceneCandidates: search.lexicalSceneCandidates,
        semanticConfidence: search.semanticConfidence,
        hybridMode: search.hybridMode,
        sceneEmbeddingCacheHit: search.sceneEmbeddingCacheHit,
        lexicalCacheHit: search.lexicalCacheHit,
        embeddingMs: search.embeddingMs,
        semanticMs: search.semanticMs,
        lexicalMs: search.lexicalMs,
        mergeMs: search.mergeMs,
        totalMs: search.totalMs,
      },
      output: {
        hits: formatSearchHitsForPrompt(search.hits),
      },
    };
  }

  if (params.tool === "search_paragraphs_hybrid") {
    const query = String(args.query || "").trim();
    const topKRaw = Number.parseInt(String(args.topK ?? ""), 10);
    const topK = Math.max(
      1,
      Math.min(
        MAX_HYBRID_PARAGRAPH_RESULTS,
        Number.isFinite(topKRaw) && topKRaw > 0 ? topKRaw : DEFAULT_HYBRID_PARAGRAPH_TOP_K
      )
    );
    if (!query) {
      throw new BookChatError("INVALID_TOOL_ARGS", 400, "query is required");
    }

    const client = createVertexClient();
    if (!client.config.apiKey) {
      throw new BookChatError("VERTEX_NOT_CONFIGURED", 409, "VERTEX_API_KEY is not configured");
    }

    const search = await searchParagraphsHybridTool({
      client,
      bookId,
      query,
      topK,
      context: await getSearchContext(),
    });

    return {
      tool: params.tool,
      normalizedArgs: {
        query,
        topK,
      },
      outputMeta: {
        returned: search.hits.length,
        embeddingRows: search.embeddingRows,
        embeddingInputTokens: search.embeddingInputTokens,
        lexicalParagraphHits: search.lexicalParagraphHits,
        semanticConfidence: search.semanticConfidence,
        queryNormalized: search.queryNormalized,
        queryTerms: search.queryTerms,
        paragraphEmbeddingCacheHit: search.paragraphEmbeddingCacheHit,
        lexicalCacheHit: search.lexicalCacheHit,
        embeddingMs: search.embeddingMs,
        semanticMs: search.semanticMs,
        lexicalMs: search.lexicalMs,
        textFetchMs: search.textFetchMs,
        mergeMs: search.mergeMs,
        totalMs: search.totalMs,
      },
      output: {
        hits: formatParagraphHitsForPrompt(search.hits),
      },
    };
  }

  if (params.tool === "get_scene_context") {
    const sceneIds = parseSceneIdsArg(args.sceneIds);
    const neighborWindowRaw = Number.parseInt(String(args.neighborWindow ?? ""), 10);
    const maxScenesRaw = Number.parseInt(String(args.maxScenes ?? ""), 10);
    const neighborWindow = Math.max(0, Math.min(3, Number.isFinite(neighborWindowRaw) ? neighborWindowRaw : 1));
    const maxScenes = Math.max(
      1,
      Math.min(CONTEXT_SCENE_LIMIT, Number.isFinite(maxScenesRaw) ? maxScenesRaw : CONTEXT_SCENE_LIMIT)
    );
    if (!sceneIds.length) {
      throw new BookChatError("INVALID_TOOL_ARGS", 400, "sceneIds are required");
    }

    const scenes = await getSceneContextTool({
      bookId,
      primarySceneIds: sceneIds,
      neighborWindow,
      maxScenes,
    });

    return {
      tool: params.tool,
      normalizedArgs: {
        sceneIds,
        neighborWindow,
        maxScenes,
      },
      outputMeta: {
        returned: scenes.length,
      },
      output: {
        scenes: formatContextForPrompt(scenes),
      },
    };
  }

  if (params.tool === "get_paragraph_slice") {
    const chapterId = String(args.chapterId || "").trim();
    const paragraphStartRaw = Number.parseInt(String(args.paragraphStart ?? ""), 10);
    const paragraphEndRaw = Number.parseInt(String(args.paragraphEnd ?? ""), 10);
    const paragraphStart = Number.isFinite(paragraphStartRaw) && paragraphStartRaw > 0 ? paragraphStartRaw : 1;
    const paragraphEnd =
      Number.isFinite(paragraphEndRaw) && paragraphEndRaw > 0 ? Math.max(paragraphStart, paragraphEndRaw) : paragraphStart;

    if (!chapterId) {
      throw new BookChatError("INVALID_TOOL_ARGS", 400, "chapterId is required");
    }

    const slice = await getParagraphSliceTool({
      bookId,
      chapterId,
      paragraphStart,
      paragraphEnd,
    });

    return {
      tool: params.tool,
      normalizedArgs: {
        chapterId,
        paragraphStart,
        paragraphEnd,
      },
      outputMeta: {
        returned: slice ? 1 : 0,
      },
      output: {
        slice: slice ? formatSlicesForPrompt([slice])[0] : null,
      },
    };
  }

  if (params.tool === "search_paragraphs_lexical") {
    const query = String(args.query || "").trim();
    const topKRaw = Number.parseInt(String(args.topK ?? ""), 10);
    const topK = Math.max(
      1,
      Math.min(MAX_LEXICAL_SEARCH_RESULTS, Number.isFinite(topKRaw) && topKRaw > 0 ? topKRaw : 12)
    );

    if (!query) {
      throw new BookChatError("INVALID_TOOL_ARGS", 400, "query is required");
    }

    const lexical = await searchParagraphsLexicalTool({
      bookId,
      query,
      topK,
      context: await getSearchContext(),
    });

    return {
      tool: params.tool,
      normalizedArgs: {
        query,
        topK,
      },
      outputMeta: {
        returned: lexical.hits.length,
        queryNormalized: lexical.queryNormalized,
        queryTerms: lexical.queryTerms,
        lexicalCacheHit: lexical.cacheHit,
      },
      output: {
        hits: lexical.hits.map((row) => ({
          chapterId: row.chapterId,
          chapterOrderIndex: row.chapterOrderIndex,
          chapterTitle: row.chapterTitle,
          sceneIndex: row.sceneIndex,
          paragraphIndex: row.paragraphIndex,
          score: row.score,
          matchedTerms: row.matchedTerms,
          text: clampText(row.text, 900),
        })),
      },
    };
  }

  throw new BookChatError("UNKNOWN_TOOL", 400, "Unknown tool");
}

export async function answerBookChatQuestion(params: {
  bookId: string;
  messages: ChatInputMessage[];
  enabledTools?: readonly BookChatToolName[];
}): Promise<BookChatAnswer> {
  const startedAt = Date.now();
  const preparedMessages = sanitizeMessages(params.messages || []);
  if (!preparedMessages.length) {
    throw new BookChatError("INVALID_MESSAGES", 400, "messages are required");
  }

  const latestUserMessage = [...preparedMessages].reverse().find((message) => message.role === "user");
  if (!latestUserMessage) {
    throw new BookChatError("NO_USER_MESSAGE", 400, "At least one user message is required");
  }

  const book = await prisma.book.findUnique({
    where: {
      id: params.bookId,
    },
    select: {
      id: true,
      title: true,
      analysisStatus: true,
      chapterCount: true,
    },
  });

  if (!book) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const client = createVertexClient();
  if (!client.config.apiKey) {
    throw new BookChatError("VERTEX_NOT_CONFIGURED", 409, "VERTEX_API_KEY is not configured");
  }

  const toolRuns: ChatToolRun[] = [];
  const capture = createBookChatToolCapture();
  const chatModel = createVertexChatModelFromConfig(client.config);
  const providerOptions = createVertexReasoningProviderOptions(client.config.chatModel);
  const tools = createBookChatTools({
    bookId: book.id,
    client,
    toolRuns,
    capture,
    enabledTools: params.enabledTools,
  });
  const enabledTools = normalizeEnabledBookChatTools(params.enabledTools);

  const completion = await withSemaphore(chatCallSemaphore, async () =>
    generateText({
      model: chatModel,
      temperature: 0.2,
      system: createBookChatSystemPrompt(book.title, enabledTools),
      messages: preparedMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      providerOptions,
      tools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
    })
  );

  let answerText = String(completion.text || "").trim();
  let usageForMetrics: LanguageModelUsage | undefined = completion.usage;
  let fallbackKind: string | null = null;
  if (!answerText) {
    const synthesized = await synthesizeFallbackAnswerFromCapture({
      model: chatModel,
      providerOptions,
      bookTitle: book.title,
      userQuestion: latestUserMessage.content,
      capture,
    });
    usageForMetrics = mergeLanguageModelUsage(usageForMetrics, synthesized.usage);
    if (synthesized.answer) {
      answerText = synthesized.answer;
      fallbackKind = "synthesized";
    } else if (buildDeterministicFallbackAnswer(capture)) {
      answerText = buildDeterministicFallbackAnswer(capture) || "Не удалось сформировать ответ по книге.";
      fallbackKind = "deterministic";
    } else {
      answerText = "Не удалось сформировать ответ по книге.";
      fallbackKind = "empty";
    }
  }
  const citations = deriveCitationsFromToolCapture(capture);

  return {
    answer: answerText,
    citations,
    toolRuns,
    metrics: buildChatMetrics({
      chatModel: client.config.chatModel,
      embeddingModel: client.config.embeddingModel,
      selectedTools: enabledTools,
      usage: usageForMetrics,
      toolRuns,
      totalLatencyMs: Date.now() - startedAt,
      answerLengthChars: answerText.length,
      citationCount: citations.length,
      fallbackUsed: Boolean(fallbackKind),
      fallbackKind,
    }),
  };
}

export interface BookChatThreadDTO {
  id: string;
  bookId: string;
  title: string;
  messageCount: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookChatMessageDTO {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  toolRuns: ChatToolRun[];
  metrics: ChatMetrics | null;
  createdAt: string;
  updatedAt: string;
}

function clampThreadTitle(value: string): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "Новый чат";
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 61)}...`;
}

function toThreadDTO(row: {
  id: string;
  bookId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages?: Array<{ content: string }>;
  _count?: {
    messages: number;
  };
}): BookChatThreadDTO {
  const previewRaw = String(row.messages?.[0]?.content || "").replace(/\s+/g, " ").trim();
  return {
    id: row.id,
    bookId: row.bookId,
    title: clampThreadTitle(String(row.title || "")),
    messageCount: Number(row._count?.messages || 0),
    lastMessagePreview: previewRaw ? previewRaw.slice(0, 240) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseStoredToolRuns(value: unknown): ChatToolRun[] {
  if (!Array.isArray(value)) return [];

  const rows: ChatToolRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const tool = String(row.tool || "").trim();
    if (
      tool !== "search_scenes" &&
      tool !== "search_paragraphs_hybrid" &&
      tool !== "get_scene_context" &&
      tool !== "get_paragraph_slice"
    ) {
      continue;
    }

    rows.push({
      tool,
      args: row.args && typeof row.args === "object" ? (row.args as Record<string, unknown>) : {},
      resultMeta:
        row.resultMeta && typeof row.resultMeta === "object"
          ? (row.resultMeta as Record<string, unknown>)
          : {},
    });
  }

  return rows;
}

function parseStoredChatMetrics(value: unknown): ChatMetrics | null {
  const row = asRecord(value);
  if (!Object.keys(row).length) return null;

  const pricingRow = asRecord(row.pricing);
  const readNumber = (input: unknown, fallback = 0) => {
    const parsed = asOptionalNumber(input);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed || 0;
  };
  const pricing = {
    chatInputPer1MUsd: Math.max(0, readNumber(pricingRow.chatInputPer1MUsd)),
    chatOutputPer1MUsd: Math.max(0, readNumber(pricingRow.chatOutputPer1MUsd)),
    embeddingInputPer1MUsd: Math.max(0, readNumber(pricingRow.embeddingInputPer1MUsd)),
    usdToEur: Math.max(0, readNumber(pricingRow.usdToEur)),
    eurToRub: Math.max(0, readNumber(pricingRow.eurToRub)),
  };

  return {
    chatModel: String(row.chatModel || "").trim(),
    embeddingModel: String(row.embeddingModel || "").trim(),
    pricingVersion: String(row.pricingVersion || "").trim(),
    selectedTools: normalizeEnabledBookChatTools(asStringList(row.selectedTools)),
    toolConfigKey: String(row.toolConfigKey || "").trim(),
    promptVariant: String(row.promptVariant || "").trim(),
    systemPromptVersion: String(row.systemPromptVersion || "").trim(),
    modelInputTokens: Math.max(0, Math.round(readNumber(row.modelInputTokens))),
    modelOutputTokens: Math.max(0, Math.round(readNumber(row.modelOutputTokens))),
    modelTotalTokens: Math.max(0, Math.round(readNumber(row.modelTotalTokens))),
    embeddingInputTokens: Math.max(0, Math.round(readNumber(row.embeddingInputTokens))),
    chatCostUsd: Math.max(0, readNumber(row.chatCostUsd)),
    embeddingCostUsd: Math.max(0, readNumber(row.embeddingCostUsd)),
    totalCostUsd: Math.max(0, readNumber(row.totalCostUsd)),
    totalCostEur: Math.max(0, readNumber(row.totalCostEur)),
    totalCostRub: Math.max(0, readNumber(row.totalCostRub)),
    totalLatencyMs: Math.max(0, Math.round(readNumber(row.totalLatencyMs))),
    answerLengthChars: Math.max(0, Math.round(readNumber(row.answerLengthChars))),
    citationCount: Math.max(0, Math.round(readNumber(row.citationCount))),
    fallbackUsed: Boolean(row.fallbackUsed),
    fallbackKind: row.fallbackKind ? String(row.fallbackKind).trim() : null,
    pricing,
  };
}

function parseNormalizedToolRuns(
  value:
    | Array<{
        toolName: string;
        argsSummaryJson: unknown;
        resultSummaryJson: unknown;
      }>
    | null
    | undefined
): ChatToolRun[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const tool = String(item.toolName || "").trim();
      if (
        tool !== "search_scenes" &&
        tool !== "search_paragraphs_hybrid" &&
        tool !== "get_scene_context" &&
        tool !== "get_paragraph_slice"
      ) {
        return null;
      }

      return {
        tool,
        args: asRecord(item.argsSummaryJson),
        resultMeta: asRecord(item.resultSummaryJson),
      } satisfies ChatToolRun;
    })
    .filter((item): item is ChatToolRun => Boolean(item));
}

function parseNormalizedTurnMetric(
  value:
    | {
        chatModel: string;
        embeddingModel: string;
        pricingVersion: string;
        selectedToolsJson: unknown;
        toolConfigKey: string;
        promptVariant: string;
        systemPromptVersion: string;
        modelInputTokens: number;
        modelOutputTokens: number;
        modelTotalTokens: number;
        embeddingInputTokens: number;
        chatCostUsd: number;
        embeddingCostUsd: number;
        totalCostUsd: number;
        totalLatencyMs: number;
        answerLengthChars: number;
        citationCount: number;
        fallbackUsed: boolean;
        fallbackKind: string | null;
      }
    | null
    | undefined
): ChatMetrics | null {
  if (!value) return null;

  const pricing = resolveTokenPricing({
    chatModel: value.chatModel,
    embeddingModel: value.embeddingModel,
  });
  const currencyRates = readCurrencyRates();
  const converted = convertUsd(Math.max(0, Number(value.totalCostUsd || 0)), currencyRates);

  return parseStoredChatMetrics({
    chatModel: value.chatModel,
    embeddingModel: value.embeddingModel,
    pricingVersion: value.pricingVersion,
    selectedTools: value.selectedToolsJson,
    toolConfigKey: value.toolConfigKey,
    promptVariant: value.promptVariant,
    systemPromptVersion: value.systemPromptVersion,
    modelInputTokens: value.modelInputTokens,
    modelOutputTokens: value.modelOutputTokens,
    modelTotalTokens: value.modelTotalTokens,
    embeddingInputTokens: value.embeddingInputTokens,
    chatCostUsd: value.chatCostUsd,
    embeddingCostUsd: value.embeddingCostUsd,
    totalCostUsd: value.totalCostUsd,
    totalCostEur: converted.eur,
    totalCostRub: converted.rub,
    totalLatencyMs: value.totalLatencyMs,
    answerLengthChars: value.answerLengthChars,
    citationCount: value.citationCount,
    fallbackUsed: value.fallbackUsed,
    fallbackKind: value.fallbackKind,
    pricing: {
      ...pricing,
      usdToEur: currencyRates.usdToEur,
      eurToRub: currencyRates.eurToRub,
    },
  });
}

function toMessageDTO(row: {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  citationsJson: unknown;
  toolRunsJson: unknown;
  metricsJson: unknown;
  turnMetric?:
    | {
        chatModel: string;
        embeddingModel: string;
        pricingVersion: string;
        selectedToolsJson: unknown;
        toolConfigKey: string;
        promptVariant: string;
        systemPromptVersion: string;
        modelInputTokens: number;
        modelOutputTokens: number;
        modelTotalTokens: number;
        embeddingInputTokens: number;
        chatCostUsd: number;
        embeddingCostUsd: number;
        totalCostUsd: number;
        totalLatencyMs: number;
        answerLengthChars: number;
        citationCount: number;
        fallbackUsed: boolean;
        fallbackKind: string | null;
        toolRuns?: Array<{
          toolName: string;
          argsSummaryJson: unknown;
          resultSummaryJson: unknown;
        }>;
      }
    | null;
  createdAt: Date;
  updatedAt: Date;
}): BookChatMessageDTO {
  const normalizedToolRuns = parseNormalizedToolRuns(row.turnMetric?.toolRuns);
  const normalizedMetrics = parseNormalizedTurnMetric(row.turnMetric);
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: String(row.content || ""),
    citations: normalizeCitationRows(row.citationsJson),
    toolRuns: normalizedToolRuns.length ? normalizedToolRuns : parseStoredToolRuns(row.toolRunsJson),
    metrics: normalizedMetrics || parseStoredChatMetrics(row.metricsJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertBookExists(bookId: string) {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
    },
  });
  if (!book) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }
}

async function assertThreadBelongsToBook(params: { bookId: string; threadId: string; ownerUserId?: string }) {
  const thread = await prisma.bookChatThread.findFirst({
    where: {
      id: params.threadId,
      bookId: params.bookId,
      ...(params.ownerUserId ? { ownerUserId: params.ownerUserId } : {}),
    },
    select: {
      id: true,
      bookId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true,
        },
      },
      messages: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
        select: {
          content: true,
        },
      },
    },
  });

  if (!thread) {
    throw new BookChatError("THREAD_NOT_FOUND", 404, "Chat thread not found");
  }

  return thread;
}

export async function listBookChatThreads(params: {
  bookId: string;
  ownerUserId?: string;
}): Promise<BookChatThreadDTO[]> {
  await assertBookExists(params.bookId);
  const rows = await prisma.bookChatThread.findMany({
    where: {
      bookId: params.bookId,
      ...(params.ownerUserId ? { ownerUserId: params.ownerUserId } : {}),
    },
    orderBy: [
      {
        updatedAt: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
    select: {
      id: true,
      bookId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true,
        },
      },
      messages: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
        select: {
          content: true,
        },
      },
    },
  });

  return rows.map((row: any) => toThreadDTO(row));
}

export async function createBookChatThread(params: {
  bookId: string;
  ownerUserId: string;
  title?: string;
}): Promise<BookChatThreadDTO> {
  await assertBookExists(params.bookId);
  const created = await prisma.bookChatThread.create({
    data: {
      bookId: params.bookId,
      ownerUserId: params.ownerUserId,
      title: clampThreadTitle(String(params.title || "").trim() || "Новый чат"),
    },
    select: {
      id: true,
      bookId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true,
        },
      },
      messages: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
        select: {
          content: true,
        },
      },
    },
  });

  return toThreadDTO(created);
}

export async function deleteBookChatThread(params: {
  bookId: string;
  threadId: string;
  ownerUserId?: string;
}) {
  await assertBookExists(params.bookId);
  const removed = await prisma.bookChatThread.deleteMany({
    where: {
      id: params.threadId,
      bookId: params.bookId,
      ...(params.ownerUserId ? { ownerUserId: params.ownerUserId } : {}),
    },
  });
  if (removed.count === 0) {
    throw new BookChatError("THREAD_NOT_FOUND", 404, "Chat thread not found");
  }
}

export async function listBookChatMessages(params: {
  bookId: string;
  threadId: string;
  ownerUserId?: string;
}): Promise<BookChatMessageDTO[]> {
  await assertThreadBelongsToBook(params);

  const rows = await prisma.bookChatMessage.findMany({
    where: {
      threadId: params.threadId,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      threadId: true,
      role: true,
      content: true,
      citationsJson: true,
      toolRunsJson: true,
      metricsJson: true,
      turnMetric: {
        select: {
          chatModel: true,
          embeddingModel: true,
          pricingVersion: true,
          selectedToolsJson: true,
          toolConfigKey: true,
          promptVariant: true,
          systemPromptVersion: true,
          modelInputTokens: true,
          modelOutputTokens: true,
          modelTotalTokens: true,
          embeddingInputTokens: true,
          chatCostUsd: true,
          embeddingCostUsd: true,
          totalCostUsd: true,
          totalLatencyMs: true,
          answerLengthChars: true,
          citationCount: true,
          fallbackUsed: true,
          fallbackKind: true,
          toolRuns: {
            orderBy: {
              orderIndex: "asc",
            },
            select: {
              toolName: true,
              argsSummaryJson: true,
              resultSummaryJson: true,
            },
          },
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row: any) =>
    toMessageDTO({
      ...row,
      role: row.role === "assistant" ? "assistant" : "user",
    })
  );
}

async function streamBookChatAnswer(params: {
  bookId: string;
  messages: ChatInputMessage[];
  enabledTools?: readonly BookChatToolName[];
  onDelta: (delta: string) => void | Promise<void>;
  onReasoning?: (delta: string) => void | Promise<void>;
  onToolCall?: (event: BookChatStreamToolCallEvent) => void | Promise<void>;
  onToolResult?: (event: BookChatStreamToolResultEvent) => void | Promise<void>;
}): Promise<BookChatAnswer> {
  const startedAt = Date.now();
  const preparedMessages = sanitizeMessages(params.messages || []);
  if (!preparedMessages.length) {
    throw new BookChatError("INVALID_MESSAGES", 400, "messages are required");
  }

  const latestUserMessage = [...preparedMessages].reverse().find((message) => message.role === "user");
  if (!latestUserMessage) {
    throw new BookChatError("NO_USER_MESSAGE", 400, "At least one user message is required");
  }

  const book = await prisma.book.findUnique({
    where: {
      id: params.bookId,
    },
    select: {
      id: true,
      title: true,
    },
  });
  if (!book) {
    throw new BookChatError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const client = createVertexClient();
  if (!client.config.apiKey) {
    throw new BookChatError("VERTEX_NOT_CONFIGURED", 409, "VERTEX_API_KEY is not configured");
  }

  const toolRuns: ChatToolRun[] = [];
  const capture = createBookChatToolCapture();
  const chatModel = createVertexChatModelFromConfig(client.config);
  const providerOptions = createVertexReasoningProviderOptions(client.config.chatModel);
  const tools = createBookChatTools({
    bookId: book.id,
    client,
    toolRuns,
    capture,
    enabledTools: params.enabledTools,
  });
  const enabledTools = normalizeEnabledBookChatTools(params.enabledTools);

  let streamedAnswer = "";
  try {
    let normalizedAnswer = "";
    let usageForMetrics: LanguageModelUsage | undefined;
    let fallbackKind: string | null = null;
    await withSemaphore(chatCallSemaphore, async () => {
      const streamResult = streamText({
        model: chatModel,
        temperature: 0.2,
        system: createBookChatSystemPrompt(book.title, enabledTools),
        messages: preparedMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        providerOptions,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        onChunk: async ({ chunk }) => {
          if (chunk.type === "reasoning-delta") {
            if (!chunk.text) return;
            await params.onReasoning?.(chunk.text);
            return;
          }

          if (chunk.type === "tool-call") {
            await params.onToolCall?.({
              toolCallId: String(chunk.toolCallId || ""),
              toolName: String(chunk.toolName || ""),
              input: asRecord(chunk.input),
            });
            return;
          }

          if (chunk.type === "tool-result") {
            const toolName = String(chunk.toolName || "");
            await params.onToolResult?.({
              toolCallId: String(chunk.toolCallId || ""),
              toolName,
              outputMeta: summarizeToolResultForStream(toolName, chunk.output),
            });
            return;
          }

          if (chunk.type !== "text-delta") return;
          if (!chunk.text) return;
          streamedAnswer += chunk.text;
          await params.onDelta(chunk.text);
        },
      });

      normalizedAnswer = String((await streamResult.text) || streamedAnswer).trim();
      usageForMetrics =
        (await resolveUsageSafely(streamResult.totalUsage)) || (await resolveUsageSafely(streamResult.usage));
    });

    let finalAnswer = normalizedAnswer;
    if (!finalAnswer) {
      const synthesized = await synthesizeFallbackAnswerFromCapture({
        model: chatModel,
        providerOptions,
        bookTitle: book.title,
        userQuestion: latestUserMessage.content,
        capture,
      });
      usageForMetrics = mergeLanguageModelUsage(usageForMetrics, synthesized.usage);
      if (synthesized.answer) {
        finalAnswer = synthesized.answer;
        fallbackKind = "synthesized";
      } else {
        const deterministic = buildDeterministicFallbackAnswer(capture);
        if (deterministic) {
          finalAnswer = deterministic;
          fallbackKind = "deterministic";
        } else {
          finalAnswer = "Не удалось сформировать ответ по книге.";
          fallbackKind = "empty";
        }
      }
      if (!streamedAnswer.trim()) {
        await params.onDelta(finalAnswer);
      }
    }

    const citations = deriveCitationsFromToolCapture(capture);

    return {
      answer: finalAnswer,
      citations,
      toolRuns,
      metrics: buildChatMetrics({
        chatModel: client.config.chatModel,
        embeddingModel: client.config.embeddingModel,
        selectedTools: enabledTools,
        usage: usageForMetrics,
        toolRuns,
        totalLatencyMs: Date.now() - startedAt,
        answerLengthChars: finalAnswer.length,
        citationCount: citations.length,
        fallbackUsed: Boolean(fallbackKind),
        fallbackKind,
      }),
    };
  } catch {
    if (streamedAnswer.trim()) {
      const citations = deriveCitationsFromToolCapture(capture);
      return {
        answer: streamedAnswer.trim(),
        citations,
        toolRuns,
        metrics: buildChatMetrics({
          chatModel: client.config.chatModel,
          embeddingModel: client.config.embeddingModel,
          selectedTools: enabledTools,
          usage: undefined,
          toolRuns,
          totalLatencyMs: Date.now() - startedAt,
          answerLengthChars: streamedAnswer.trim().length,
          citationCount: citations.length,
          fallbackUsed: true,
          fallbackKind: "stream_partial",
        }),
      };
    }

    const completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: chatModel,
        temperature: 0.2,
        system: createBookChatSystemPrompt(book.title, enabledTools),
        messages: preparedMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        providerOptions,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
      })
    );
    let fallback = String(completion.text || "").trim();
    let usageForMetrics: LanguageModelUsage | undefined = completion.usage;
    let fallbackKind: string | null = null;
    if (!fallback) {
      const synthesized = await synthesizeFallbackAnswerFromCapture({
        model: chatModel,
        providerOptions,
        bookTitle: book.title,
        userQuestion: latestUserMessage.content,
        capture,
      });
      usageForMetrics = mergeLanguageModelUsage(usageForMetrics, synthesized.usage);
      if (synthesized.answer) {
        fallback = synthesized.answer;
        fallbackKind = "synthesized";
      } else {
        const deterministic = buildDeterministicFallbackAnswer(capture);
        if (deterministic) {
          fallback = deterministic;
          fallbackKind = "deterministic";
        } else {
          fallback = "Не удалось сформировать ответ по книге.";
          fallbackKind = "empty";
        }
      }
    }
    await params.onDelta(fallback);
    const citations = deriveCitationsFromToolCapture(capture);
    return {
      answer: fallback,
      citations,
      toolRuns,
      metrics: buildChatMetrics({
        chatModel: client.config.chatModel,
        embeddingModel: client.config.embeddingModel,
        selectedTools: enabledTools,
        usage: usageForMetrics,
        toolRuns,
        totalLatencyMs: Date.now() - startedAt,
        answerLengthChars: fallback.length,
        citationCount: citations.length,
        fallbackUsed: true,
        fallbackKind: fallbackKind || "generate_fallback",
      }),
    };
  }
}

export async function streamBookChatThreadReply(params: {
  bookId: string;
  threadId: string;
  ownerUserId?: string;
  userText: string;
  selectedTools?: readonly BookChatToolName[];
  onDelta: (delta: string) => void | Promise<void>;
  onReasoning?: (delta: string) => void | Promise<void>;
  onToolCall?: (event: BookChatStreamToolCallEvent) => void | Promise<void>;
  onToolResult?: (event: BookChatStreamToolResultEvent) => void | Promise<void>;
}): Promise<{
  thread: BookChatThreadDTO;
  userMessage: BookChatMessageDTO;
  assistantMessage: BookChatMessageDTO;
}> {
  const userText = String(params.userText || "").trim();
  if (!userText) {
    throw new BookChatError("INVALID_MESSAGE", 400, "Message text is required");
  }

  const threadBefore = await assertThreadBelongsToBook({
    bookId: params.bookId,
    threadId: params.threadId,
    ownerUserId: params.ownerUserId,
  });

  const userMessageRow = await prisma.bookChatMessage.create({
    data: {
      threadId: params.threadId,
      role: "user",
      content: userText,
      citationsJson: [],
      toolRunsJson: [],
      metricsJson: {},
    },
    select: {
      id: true,
      threadId: true,
      role: true,
      content: true,
      citationsJson: true,
      toolRunsJson: true,
      metricsJson: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (threadBefore._count.messages === 0 && clampThreadTitle(threadBefore.title) === "Новый чат") {
    await prisma.bookChatThread.update({
      where: {
        id: params.threadId,
      },
      data: {
        title: clampThreadTitle(userText),
      },
    });
  }

  await prisma.bookChatThread.update({
    where: {
      id: params.threadId,
    },
    data: {
      updatedAt: new Date(),
    },
  });

  const recentModelMessagesRows = await prisma.bookChatMessage.findMany({
    where: {
      threadId: params.threadId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20,
    select: {
      role: true,
      content: true,
    },
  });

  const modelMessagesRows = [...recentModelMessagesRows].reverse();

  const modelMessages = modelMessagesRows.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content || ""),
  })) as ChatInputMessage[];

  const answer = await streamBookChatAnswer({
    bookId: params.bookId,
    messages: modelMessages,
    enabledTools: params.selectedTools,
    onDelta: params.onDelta,
    onReasoning: params.onReasoning,
    onToolCall: params.onToolCall,
    onToolResult: params.onToolResult,
  });

  const assistantMessageRow = await prisma.bookChatMessage.create({
    data: {
      threadId: params.threadId,
      role: "assistant",
      content: answer.answer,
      citationsJson: answer.citations as unknown as Prisma.InputJsonValue,
      toolRunsJson: answer.toolRuns as unknown as Prisma.InputJsonValue,
      metricsJson: answer.metrics as unknown as Prisma.InputJsonValue,
    },
    select: {
      id: true,
      threadId: true,
      role: true,
      content: true,
      citationsJson: true,
      toolRunsJson: true,
      metricsJson: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  try {
    await persistNormalizedChatMetrics({
      bookId: params.bookId,
      threadId: params.threadId,
      messageId: assistantMessageRow.id,
      toolRuns: answer.toolRuns,
      metrics: answer.metrics,
    });
  } catch {
    // Metrics persistence must not fail the user-visible chat turn.
  }

  await prisma.bookChatThread.update({
    where: {
      id: params.threadId,
    },
    data: {
      updatedAt: new Date(),
    },
  });

  const threadAfter = await assertThreadBelongsToBook({
    bookId: params.bookId,
    threadId: params.threadId,
    ownerUserId: params.ownerUserId,
  });

  return {
    thread: toThreadDTO(threadAfter),
    userMessage: toMessageDTO({
      ...userMessageRow,
      role: userMessageRow.role === "assistant" ? "assistant" : "user",
    }),
    assistantMessage: toMessageDTO({
      ...assistantMessageRow,
      role: assistantMessageRow.role === "assistant" ? "assistant" : "user",
    }),
  };
}
