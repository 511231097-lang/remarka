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
  BOOK_CHAT_SCENE_TOOLS_ENABLED,
  DEFAULT_ENABLED_BOOK_CHAT_TOOLS,
  isBookChatToolName,
  type BookChatToolName,
} from "./bookChatTools";
import { convertUsd, readCurrencyRates, resolveTokenPricing } from "./modelPricing";

const prisma = createNpzPrismaAdapter(basePrisma);
const BOOK_CHAT_PROMPT_VARIANT = "thread-book-chat";
const BOOK_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION = "chat-tool-payload-v1";
let chatArtifactBlobStore: BlobStore | null = null;

type BookChatSystemPromptVersion = "tool-aware-v1" | "tool-aware-v2" | "tool-aware-v3";

function readBoolEnv(name: string, fallback: boolean) {
  const normalized = String(process.env[name] || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveBookChatSystemPromptVersion(raw: string | undefined): BookChatSystemPromptVersion {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (normalized === "tool-aware-v1" || normalized === "v1") return "tool-aware-v1";
  if (normalized === "tool-aware-v2" || normalized === "v2") return "tool-aware-v2";
  if (normalized === "tool-aware-v3" || normalized === "v3") return "tool-aware-v3";
  return "tool-aware-v3";
}

const BOOK_CHAT_SYSTEM_PROMPT_VERSION = resolveBookChatSystemPromptVersion(
  process.env.BOOK_CHAT_SYSTEM_PROMPT_VERSION
);

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
  tool: string;
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
  const normalizeSceneFlag = (tool: BookChatToolName) =>
    BOOK_CHAT_SCENE_TOOLS_ENABLED || (tool !== "search_scenes" && tool !== "get_scene_context");
  if (value === undefined || value === null) {
    return [...DEFAULT_ENABLED_BOOK_CHAT_TOOLS].filter(normalizeSceneFlag);
  }

  const selected = new Set(value.filter((tool): tool is BookChatToolName => isBookChatToolName(tool)));
  return BOOK_CHAT_TOOL_NAMES.filter((tool) => selected.has(tool)).filter(normalizeSceneFlag);
}

function buildToolConfigKey(tools: readonly BookChatToolName[]) {
  return tools.length ? [...tools].sort().join("|") : "none";
}

function normalizeRuntimeToolNames(value?: readonly string[] | null): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
  }
  return names;
}

function buildRuntimeToolConfigKey(tools: readonly string[]) {
  const normalized = normalizeRuntimeToolNames(tools);
  return normalized.length ? normalized.sort().join("|") : "none";
}

const TRACE_EVENT_CHAIN_TOOL_ENABLED = false;
const EVIDENCE_TOOL_CHAT_TOOL_NAMES = ["search_scenes", "search_paragraphs", "read_passages"] as const;

export type ChatMetrics = {
  chatModel: string;
  embeddingModel: string;
  pricingVersion: string;
  selectedTools: string[];
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
  llmStepRuns?: ChatLlmStepRun[];
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
const MAX_AUTO_EXPANDED_SLICE_CHARS = 18_000;
const MAX_PRIMARY_EVIDENCE_PARAGRAPH_CHARS = 1400;
const MAX_TOOL_STEPS = 8;
const MAX_AUTONOMOUS_TOOL_STEPS = 8;
const MAX_LEXICAL_SEARCH_RESULTS = 40;
const MAX_HYBRID_PARAGRAPH_RESULTS = 40;
const DEFAULT_HYBRID_PARAGRAPH_TOP_K = 10;
const HYBRID_PARAGRAPH_PROMPT_MIN_TOP_K = 6;
const HYBRID_PARAGRAPH_PROMPT_MAX_TOP_K = 12;
const AUTO_CONTEXT_CLUSTER_MAX_SPAN_PARAGRAPHS = 32;
const AUTO_CONTEXT_MARGIN_PARAGRAPHS = 6;
const AUTO_CONTEXT_MAX_SLICE_PARAGRAPHS = 48;
const AUTO_CONTEXT_MAX_SLICES_PER_SEARCH = 2;
const AUTO_CONTEXT_MAX_CAPTURED_SLICES = 8;
const COMPILED_EVIDENCE_TOOL_CONFIG_KEY = "compiled-evidence-v1";
const COMPILED_EVIDENCE_SELECTED_TOOLS = ["preplan", "search_evidence", "answer_with_evidence"] as const;
const COMPILED_EVIDENCE_REPAIR_TOOL_CONFIG_KEY = "compiled-evidence-repair-v1";
const COMPILED_EVIDENCE_REPAIR_TOOL_NAMES = ["search_evidence", "read_passages"] as const;
const EVIDENCE_GROUP_MAX_PARAGRAPHS = 4;
const EVIDENCE_GROUP_EXPAND_BEFORE = 1;
const EVIDENCE_GROUP_EXPAND_AFTER = 1;
const EVIDENCE_FRAGMENT_WINDOW_PARAGRAPHS = 5;
const EVIDENCE_FRAGMENT_OVERLAP_PARAGRAPHS = 2;
const EVIDENCE_FRAGMENT_EMBEDDING_VERSION = Math.max(
  1,
  Number.parseInt(String(process.env.EVIDENCE_FRAGMENT_EMBEDDING_VERSION || "1"), 10) || 1
);
const BOOK_EVIDENCE_FRAGMENTS_ENABLED = readBoolEnv("BOOK_EVIDENCE_FRAGMENTS_ENABLED", false);
const EVIDENCE_FRAGMENT_MAX_RESULTS = 32;
const EVIDENCE_FRAGMENT_BOOST = 0.06;
const SLOT_REPAIR_LOCAL_WINDOW_PARAGRAPHS = 12;
const SLOT_REPAIR_MAX_SLICE_PARAGRAPHS = 12;
const SLOT_DEFAULT_MAX_GROUPS = 2;
const SEMANTIC_ANCHOR_REPAIR_STOP_WORDS = [
  "версия",
  "вероятность",
  "вывод",
  "героизм",
  "доверие",
  "доказательство",
  "допрос",
  "защита",
  "изменение",
  "контроль",
  "ложь",
  "логика",
  "манипуляция",
  "мотив",
  "невиновность",
  "незнание",
  "несостыковка",
  "обвинение",
  "объяснение",
  "одержимость",
  "опасность",
  "подготовка",
  "подозрение",
  "помощь",
  "признание",
  "провал",
  "самореклама",
  "связь",
  "смысл",
  "сочувствие",
  "страх",
  "трусость",
  "хвастовство",
] as const;
const EVIDENCE_RERANK_CANDIDATE_FACTOR = 3;
const EVIDENCE_SCENE_BOOST = 0.08;
const EVIDENCE_BUDGET_MAX_GROUPS = {
  small: 6,
  medium: 10,
  large: 16,
} as const;
const EVIDENCE_BUDGET_MAX_CHARS = {
  small: 20_000,
  medium: 40_000,
  large: 80_000,
} as const;
const BOOK_CHAT_PLANNER_ENABLED = readBoolEnv("BOOK_CHAT_PLANNER_ENABLED", true);
const BOOK_CHAT_LLM_STEP_METRICS_ENABLED = readBoolEnv("BOOK_CHAT_LLM_STEP_METRICS_ENABLED", false);
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
const VERTEX_RANKING_CANDIDATE_FACTOR = Math.max(
  1,
  Number.parseInt(String(process.env.VERTEX_RANKING_CANDIDATE_FACTOR || "5"), 10) || 5
);
const VERTEX_RANKING_MAX_CANDIDATES = Math.max(
  1,
  Math.min(200, Number.parseInt(String(process.env.VERTEX_RANKING_MAX_CANDIDATES || "80"), 10) || 80)
);
const VERTEX_RANKING_CONTENT_MAX_CHARS = Math.max(
  200,
  Number.parseInt(String(process.env.VERTEX_RANKING_CONTENT_MAX_CHARS || "3200"), 10) || 3200
);
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
    const isProFamily = modelId.includes("pro");
    // Keep minimal for Gemini 3 Flash/Flash-Lite; use low for Pro family.
    const thinkingLevel = isProFamily ? "low" : "minimal";

    return {
      vertex: {
        thinkingConfig: {
          thinkingLevel,
          includeThoughts: false,
        },
      },
    };
  }

  // For non-Gemini 3 models fallback to a small thinking budget.
  return {
    vertex: {
      thinkingConfig: {
        thinkingBudget: 256,
        includeThoughts: false,
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
  rerankScore?: number;
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
  rerankScore?: number;
  semanticRank: number | null;
  lexicalRank: number | null;
  matchedTerms: string[];
  text: string;
};

export type AutoExpandableParagraphHit = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  sceneIndex: number | null;
  score: number;
};

export type AutoContextSceneBounds = {
  sceneId?: string;
  chapterId: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  title?: string;
};

export type AutoExpandedParagraphSlicePlan = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  paragraphStart: number;
  paragraphEnd: number;
  hitCount: number;
  hitParagraphStart: number;
  hitParagraphEnd: number;
  reason: "clustered_hits" | "scene_continuation";
};

type BookSearchContext = {
  cacheKey: string;
};

type ChatToolPolicy = "auto" | "required";
type ChatModelTier = "lite" | "pro";
type ChatModelByTier = {
  lite: string;
  pro: string;
};
type BookChatPlannerDecision = {
  toolPolicy: ChatToolPolicy;
  modelTier: ChatModelTier;
  searchPlan?: BookChatPlannerSearchPlan;
};
type BookChatPlannerSearchPlan = {
  normalizedQuestion: string;
  entityHints: string[];
  searchQueries: string[];
  broadQueries: string[];
  focusedQueries: string[];
  queryGroups: BookChatPlannerQueryGroup[];
  notes: string[];
};
type BookChatPlannerQueryGroup = {
  part: string;
  searchQueries: string[];
  broadQueries: string[];
  focusedQueries: string[];
};
type ChatLlmStep = "planner" | "main" | "fallback";
type ChatLlmStepRun = {
  step: ChatLlmStep;
  model: string;
  usage?: LanguageModelUsage;
  latencyMs: number;
  metadata?: Record<string, unknown>;
};
type BookChatExecutionPlan = {
  decision: BookChatPlannerDecision;
  selectedChatModelId: string;
  usage?: LanguageModelUsage;
  plannerStepRun?: ChatLlmStepRun;
};

type ChatPreplanRoute = "grounded_answer" | "structure_answer" | "meta_answer";
type ChatPreplanComplexity = "simple" | "medium" | "hard";
type ChatAnswerMode =
  | "fact"
  | "explanation"
  | "comparison"
  | "chronology"
  | "summary"
  | "table_sequence"
  | "clue_synthesis"
  | "progressive_reveal";
type ChatEvidenceBudget = "small" | "medium" | "large";
type ChatEvidenceOrder = "relevance" | "chronological";
type SearchEvidenceStrategy = "default" | "scene_first";
type EvidenceSlotExpansion = "normal" | "wide_local" | "minimal_covering_range";

export type EvidenceSlot = {
  id: string;
  title: string;
  required: boolean;
  queries: string[];
  mustCover: string[];
  minGroups: number;
  maxGroups: number;
  expansion: EvidenceSlotExpansion;
  role?: "preparation" | "decisive" | "row" | "clue" | "context";
};

export type ChatPreplan = {
  route: ChatPreplanRoute;
  model: ChatModelTier;
  complexity: ChatPreplanComplexity;
  answerMode: ChatAnswerMode;
  retrieval: {
    query: string;
    subqueries: string[];
    order: ChatEvidenceOrder;
    topK: number;
    useScenes: boolean;
    evidenceBudget: ChatEvidenceBudget;
  };
  slots: EvidenceSlot[];
};

type ChatPreplanResult = {
  preplan: ChatPreplan;
  selectedChatModelId: string;
  usage?: LanguageModelUsage;
  plannerStepRun?: ChatLlmStepRun;
  toolRun: ChatToolRun;
};

type EvidenceMatchedBy = "semantic" | "lexical" | "fragment" | "scene" | "rerank";
type EvidenceConfidence = "high" | "medium" | "low";
type CompiledAnswerRepairToolName = (typeof COMPILED_EVIDENCE_REPAIR_TOOL_NAMES)[number];

type EvidenceParagraph = {
  paragraphIndex: number;
  text: string;
};

export type EvidenceGroup = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneId?: string;
  sceneIndex?: number;
  sceneTitle?: string;
  paragraphStart: number;
  paragraphEnd: number;
  paragraphs: EvidenceParagraph[];
  text: string;
  score: number;
  confidence: EvidenceConfidence;
  matchedBy: EvidenceMatchedBy[];
  matchedSubquery?: string;
  slotId?: string;
};

export type SlotEvidence = {
  slotId: string;
  title: string;
  required: boolean;
  role?: EvidenceSlot["role"];
  coverage: "high" | "medium" | "low" | "missing";
  missingAnchors: string[];
  groups: EvidenceGroup[];
};

export type EvidencePack = {
  schemaVersion: "compiled-evidence-v1";
  route: ChatPreplanRoute;
  complexity: ChatPreplanComplexity;
  answerMode: ChatAnswerMode;
  order: ChatEvidenceOrder;
  budget: ChatEvidenceBudget;
  query: string;
  subqueries: string[];
  groups: EvidenceGroup[];
  slots: SlotEvidence[];
  blocks: Array<{
    label: string;
    groups: EvidenceGroup[];
  }>;
  metrics: {
    groupCount: number;
    evidenceChars: number;
    sceneBoostUsed: boolean;
    rerank: VertexRerankMeta;
    chapterDistribution: Record<string, number>;
    sceneDistribution: Record<string, number>;
  };
};

type BookStructureContext = {
  chapters: Array<{
    chapterId: string;
    title: string;
    orderIndex: number;
    paragraphStart: number;
    paragraphEnd: number;
    scenes: Array<{
      sceneId: string;
      title: string;
      summary: string;
      paragraphStart: number;
      paragraphEnd: number;
    }>;
  }>;
};

type CompiledChatContext = {
  preplanResult: ChatPreplanResult;
  evidencePack: EvidencePack;
  structureContext?: BookStructureContext;
  toolRuns: ChatToolRun[];
  llmStepRuns: ChatLlmStepRun[];
};

type CompiledAnswerRuntime = {
  model: ChatModelTier;
  selectedChatModelId: string;
  repairTools: CompiledAnswerRepairToolName[];
  maxToolCalls: number;
  reasons: string[];
  toolConfigKey: string;
  selectedTools: string[];
};

type CompiledAnswerRepairCapture = {
  evidenceGroups: EvidenceGroup[];
  paragraphSlices: ParagraphSliceResult[];
};

type EvidenceToolChatCapture = {
  evidenceGroups: EvidenceGroup[];
  paragraphSlices: ParagraphSliceResult[];
};

type TraceEventChainEvent = {
  order: number;
  actor: string;
  action: string;
  object: string;
  target?: string;
  place?: string;
  timeHint?: string;
  evidenceGroupIds: string[];
  paragraphRefs: string[];
  confidence: "high" | "medium" | "low";
};

type TraceEventChainPlan = {
  focus: string;
  subjects: string[];
  anchors: string[];
  searchQueries: string[];
  transitionsToCheck: string[];
};

type TraceEventChainLedger = {
  focus: string;
  chain: TraceEventChainEvent[];
  unknowns: string[];
  warnings: string[];
  unsupportedClaims: string[];
};

type ChainInvestigationSupport = "explicit" | "inferred" | "gap";

type ChainInvestigationEvidence = {
  evidenceGroupId?: string;
  ref: string;
  proves: string;
  quote?: string;
};

type ChainInvestigationStep = {
  order: number;
  claim: string;
  support: ChainInvestigationSupport;
  evidence: ChainInvestigationEvidence[];
  caveat?: string;
  confidence: "high" | "medium" | "low";
};

type ChainInvestigationReport = {
  focus: string;
  answerSkeleton: ChainInvestigationStep[];
  gaps: string[];
  rejectedClaims: string[];
  warnings: string[];
  boundary?: string;
};

type ChainInvestigationBoundary = {
  description: string;
  query: string;
  sceneId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
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

type EvidenceFragmentDoc = {
  id: string;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneId?: string;
  sceneIndex: number | null;
  paragraphStart: number;
  paragraphEnd: number;
  source: "scene_window";
  orderIndex: number;
  text: string;
  normalized: string;
  termFrequency: Map<string, number>;
  uniqueTerms: string[];
  termCount: number;
};

type LexicalSearchCorpus = {
  paragraphDocs: LexicalParagraphDoc[];
  evidenceFragments: EvidenceFragmentDoc[];
  documentCount: number;
  averageDocumentLength: number;
  documentFrequencyByTerm: Map<string, number>;
  paragraphSceneIndexByRef: Map<string, number | null>;
  sceneBoundsByRef: Map<string, AutoContextSceneBounds>;
};

type EvidenceFragmentSearchHit = {
  id: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  fragmentType?: "small" | "medium";
  sceneId?: string;
  sceneIndex: number | null;
  paragraphStart: number;
  paragraphEnd: number;
  score: number;
  semanticRank: number | null;
  lexicalRank: number | null;
  matchedTerms: string[];
  text: string;
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

type SemanticEvidenceFragmentQueryRow = {
  embeddingRows: number;
  fragmentId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  fragmentType: string | null;
  sceneId: string | null;
  sceneIndex: number | null;
  paragraphStart: number;
  paragraphEnd: number;
  sourceText: string;
  semanticScore: number;
};

type PersistedFragmentLexicalRow = {
  id: string;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneId: string | null;
  sceneIndex: number | null;
  paragraphStart: number;
  paragraphEnd: number;
  orderIndex: number;
  text: string;
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

type VertexRerankMeta = {
  enabled: boolean;
  used: boolean;
  candidateCount: number;
  returned: number;
  model: string | null;
  latencyMs: number;
  error?: string;
};

function createSkippedRerankMeta(candidateCount = 0): VertexRerankMeta {
  return {
    enabled: false,
    used: false,
    candidateCount,
    returned: 0,
    model: null,
    latencyMs: 0,
  };
}

function computeRerankCandidateTopK(topK: number, maxCandidates: number) {
  return Math.max(
    topK,
    Math.min(maxCandidates, VERTEX_RANKING_MAX_CANDIDATES, topK * VERTEX_RANKING_CANDIDATE_FACTOR)
  );
}

export function uniquifyRerankRecordIds(ids: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return ids.map((rawId, index) => {
    const baseId = String(rawId || "").trim() || `record_${index}`;
    const duplicateIndex = seen.get(baseId) || 0;
    seen.set(baseId, duplicateIndex + 1);
    if (duplicateIndex === 0) return baseId;
    return `${baseId}__dup_${duplicateIndex}_${index}`;
  });
}

async function rerankSearchCandidates<T>(params: {
  client: ReturnType<typeof createVertexClient>;
  query: string;
  candidates: T[];
  topK: number;
  toRecord: (candidate: T, index: number) => { id: string; title?: string; content: string };
  applyScore: (candidate: T, score: number) => T;
}): Promise<{ hits: T[]; meta: VertexRerankMeta }> {
  if (!params.client.config.rankingEnabled) {
    return {
      hits: params.candidates.slice(0, params.topK),
      meta: createSkippedRerankMeta(params.candidates.length),
    };
  }

  const startedAt = nowMs();
  const rawRecordPairs = params.candidates
    .slice(0, VERTEX_RANKING_MAX_CANDIDATES)
    .map((candidate, index) => {
      const record = params.toRecord(candidate, index);
      return {
        candidate,
        record: {
          id: record.id,
          title: record.title,
          content: clampText(record.content, VERTEX_RANKING_CONTENT_MAX_CHARS),
        },
      };
    })
    .filter((pair) => pair.record.id && (pair.record.title || pair.record.content));
  const uniqueRecordIds = uniquifyRerankRecordIds(rawRecordPairs.map((pair) => pair.record.id));
  const recordPairs = rawRecordPairs.map((pair, index) => ({
    ...pair,
    record: {
      ...pair.record,
      id: uniqueRecordIds[index]!,
    },
  }));
  const records = recordPairs.map((pair) => pair.record);

  if (!records.length) {
    return {
      hits: params.candidates.slice(0, params.topK),
      meta: {
        enabled: true,
        used: false,
        candidateCount: 0,
        returned: 0,
        model: params.client.config.rankingModel,
        latencyMs: nowMs() - startedAt,
      },
    };
  }

  try {
    const ranked = await params.client.ranking.rank({
      query: params.query,
      records,
      topN: params.topK,
      ignoreRecordDetailsInResponse: true,
    });
    const candidateById = new Map<string, T>();
    for (const pair of recordPairs) {
      candidateById.set(pair.record.id, pair.candidate);
    }

    const hits: T[] = [];
    const usedIds = new Set<string>();
    for (const record of ranked.records) {
      const candidate = candidateById.get(record.id);
      if (!candidate) continue;
      usedIds.add(record.id);
      hits.push(params.applyScore(candidate, record.score));
      if (hits.length >= params.topK) break;
    }

    if (!hits.length) {
      return {
        hits: params.candidates.slice(0, params.topK),
        meta: {
          enabled: true,
          used: false,
          candidateCount: records.length,
          returned: ranked.records.length,
          model: ranked.model,
          latencyMs: nowMs() - startedAt,
          error: "empty rerank result",
        },
      };
    }

    for (const pair of recordPairs) {
      if (hits.length >= params.topK) break;
      if (usedIds.has(pair.record.id)) continue;
      hits.push(pair.candidate);
    }

    return {
      hits,
      meta: {
        enabled: true,
        used: true,
        candidateCount: records.length,
        returned: ranked.records.length,
        model: ranked.model,
        latencyMs: nowMs() - startedAt,
      },
    };
  } catch (error) {
    return {
      hits: params.candidates.slice(0, params.topK),
      meta: {
        enabled: true,
        used: false,
        candidateCount: records.length,
        returned: 0,
        model: params.client.config.rankingModel,
        latencyMs: nowMs() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
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

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function enforceMaxSliceWidth(params: {
  start: number;
  end: number;
  hitStart: number;
  hitEnd: number;
  maxParagraphs: number;
}): { start: number; end: number } {
  const maxParagraphs = Math.max(1, Math.floor(params.maxParagraphs));
  let start = Math.max(1, Math.floor(params.start));
  let end = Math.max(start, Math.floor(params.end));
  if (end - start + 1 <= maxParagraphs) {
    return { start, end };
  }

  const hitStart = Math.max(1, Math.floor(params.hitStart));
  const hitEnd = Math.max(hitStart, Math.floor(params.hitEnd));
  const hitSpan = hitEnd - hitStart + 1;
  if (hitSpan >= maxParagraphs) {
    start = hitStart;
    end = hitStart + maxParagraphs - 1;
    return { start, end };
  }

  const extra = maxParagraphs - hitSpan;
  start = Math.max(1, hitStart - Math.floor(extra / 2));
  end = start + maxParagraphs - 1;
  if (end < hitEnd) {
    end = hitEnd;
    start = Math.max(1, end - maxParagraphs + 1);
  }
  return { start, end };
}

export function buildAutoExpandedParagraphSlicePlans(params: {
  hits: AutoExpandableParagraphHit[];
  sceneBoundsByRef?: Map<string, AutoContextSceneBounds>;
  maxSlices?: number;
  clusterMaxSpan?: number;
  margin?: number;
  maxSliceParagraphs?: number;
}): AutoExpandedParagraphSlicePlan[] {
  const maxSlices = normalizePositiveInt(params.maxSlices, AUTO_CONTEXT_MAX_SLICES_PER_SEARCH);
  const clusterMaxSpan = normalizePositiveInt(params.clusterMaxSpan, AUTO_CONTEXT_CLUSTER_MAX_SPAN_PARAGRAPHS);
  const margin = Math.max(0, Math.floor(Number(params.margin ?? AUTO_CONTEXT_MARGIN_PARAGRAPHS)));
  const maxSliceParagraphs = normalizePositiveInt(
    params.maxSliceParagraphs,
    AUTO_CONTEXT_MAX_SLICE_PARAGRAPHS
  );
  if (!params.hits.length || maxSlices <= 0) return [];

  const hitsByChapterId = new Map<string, AutoExpandableParagraphHit[]>();
  for (const hit of params.hits) {
    const chapterId = String(hit.chapterId || "").trim();
    const paragraphIndex = Number(hit.paragraphIndex);
    if (!chapterId || !Number.isFinite(paragraphIndex) || paragraphIndex <= 0) continue;
    if (!hitsByChapterId.has(chapterId)) hitsByChapterId.set(chapterId, []);
    hitsByChapterId.get(chapterId)!.push({
      ...hit,
      paragraphIndex: Math.floor(paragraphIndex),
      score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : 0,
    });
  }

  const candidates: Array<{
    chapterId: string;
    chapterOrderIndex: number;
    chapterTitle: string;
    hitStart: number;
    hitEnd: number;
    hitCount: number;
    scoreSum: number;
    span: number;
    sceneIndex: number | null;
  }> = [];

  for (const [chapterId, chapterHits] of hitsByChapterId.entries()) {
    const bestHitByParagraph = new Map<number, AutoExpandableParagraphHit>();
    for (const hit of chapterHits) {
      const previous = bestHitByParagraph.get(hit.paragraphIndex);
      if (!previous || Number(hit.score || 0) > Number(previous.score || 0)) {
        bestHitByParagraph.set(hit.paragraphIndex, hit);
      }
    }

    const ordered = Array.from(bestHitByParagraph.values()).sort(
      (left, right) => left.paragraphIndex - right.paragraphIndex
    );
    if (ordered.length < 3) continue;

    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 2; right < ordered.length; right += 1) {
        const hitStart = ordered[left]!.paragraphIndex;
        const hitEnd = ordered[right]!.paragraphIndex;
        const span = hitEnd - hitStart + 1;
        if (span > clusterMaxSpan) break;

        const windowHits = ordered.slice(left, right + 1);
        const sceneIndex = windowHits[0]!.sceneIndex;
        const allInSameScene =
          typeof sceneIndex === "number" &&
          Number.isFinite(sceneIndex) &&
          sceneIndex > 0 &&
          windowHits.every((hit) => hit.sceneIndex === sceneIndex);
        candidates.push({
          chapterId,
          chapterOrderIndex: windowHits[0]!.chapterOrderIndex,
          chapterTitle: windowHits[0]!.chapterTitle,
          hitStart,
          hitEnd,
          hitCount: windowHits.length,
          scoreSum: windowHits.reduce((sum, hit) => sum + Number(hit.score || 0), 0),
          span,
          sceneIndex: allInSameScene ? sceneIndex : null,
        });
      }
    }
  }

  const selected: AutoExpandedParagraphSlicePlan[] = [];
  const sortedCandidates = candidates.sort((left, right) => {
    if (right.hitCount !== left.hitCount) return right.hitCount - left.hitCount;
    if (right.scoreSum !== left.scoreSum) return right.scoreSum - left.scoreSum;
    if (left.span !== right.span) return left.span - right.span;
    if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
    return left.hitStart - right.hitStart;
  });

  for (const candidate of sortedCandidates) {
    if (selected.length >= maxSlices) break;
    const overlapsExisting = selected.some(
      (plan) =>
        plan.chapterId === candidate.chapterId &&
        Math.max(plan.hitParagraphStart, candidate.hitStart) <= Math.min(plan.hitParagraphEnd, candidate.hitEnd)
    );
    if (overlapsExisting) continue;

    let paragraphStart = Math.max(1, candidate.hitStart - margin);
    let paragraphEnd = candidate.hitEnd + margin;
    let sceneBounds: AutoContextSceneBounds | undefined;
    if (candidate.sceneIndex !== null) {
      sceneBounds = params.sceneBoundsByRef?.get(makeSceneRefKey(candidate.chapterId, candidate.sceneIndex));
      if (sceneBounds && sceneBounds.paragraphEnd >= sceneBounds.paragraphStart) {
        const sceneSpan = sceneBounds.paragraphEnd - sceneBounds.paragraphStart + 1;
        if (sceneSpan <= maxSliceParagraphs) {
          paragraphStart = Math.max(sceneBounds.paragraphStart, paragraphStart);
          paragraphEnd = Math.min(sceneBounds.paragraphEnd, paragraphEnd);
        }
      }
    }

    const limited = enforceMaxSliceWidth({
      start: paragraphStart,
      end: paragraphEnd,
      hitStart: candidate.hitStart,
      hitEnd: candidate.hitEnd,
      maxParagraphs: maxSliceParagraphs,
    });
    if (limited.end <= limited.start && candidate.hitCount <= 1) continue;

    selected.push({
      chapterId: candidate.chapterId,
      chapterOrderIndex: candidate.chapterOrderIndex,
      chapterTitle: candidate.chapterTitle,
      paragraphStart: limited.start,
      paragraphEnd: limited.end,
      hitCount: candidate.hitCount,
      hitParagraphStart: candidate.hitStart,
      hitParagraphEnd: candidate.hitEnd,
      reason: "clustered_hits",
    });

    if (
      selected.length < maxSlices &&
      sceneBounds &&
      sceneBounds.paragraphEnd > limited.end &&
      sceneBounds.paragraphEnd >= sceneBounds.paragraphStart
    ) {
      const continuationStart = Math.max(limited.end + 1, sceneBounds.paragraphStart);
      const continuationEnd = Math.min(sceneBounds.paragraphEnd, continuationStart + maxSliceParagraphs - 1);
      if (continuationEnd > continuationStart) {
        selected.push({
          chapterId: candidate.chapterId,
          chapterOrderIndex: candidate.chapterOrderIndex,
          chapterTitle: candidate.chapterTitle,
          paragraphStart: continuationStart,
          paragraphEnd: continuationEnd,
          hitCount: 0,
          hitParagraphStart: candidate.hitStart,
          hitParagraphEnd: candidate.hitEnd,
          reason: "scene_continuation",
        });
      }
    }
  }

  return selected;
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

function sumInternalChatCostUsd(toolRuns: ChatToolRun[]): number {
  return toolRuns.reduce((total, run) => {
    const value = asOptionalNumber(run.resultMeta.chatCostUsd);
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
  selectedTools: readonly string[];
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
  const internalChatCostUsd = Math.max(0, sumInternalChatCostUsd(params.toolRuns));
  const pricing = resolveTokenPricing({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
  });
  const selectedTools = normalizeRuntimeToolNames(params.selectedTools);
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
  const totalCostUsd = chatCostUsd + embeddingCostUsd + internalChatCostUsd;
  const converted = convertUsd(totalCostUsd, currencyRates);

  return {
    chatModel: String(params.chatModel || "").trim(),
    embeddingModel: String(params.embeddingModel || "").trim(),
    pricingVersion: resolvePricingVersion(),
    selectedTools,
    toolConfigKey:
      selectedTools.join("|") === COMPILED_EVIDENCE_SELECTED_TOOLS.join("|")
        ? COMPILED_EVIDENCE_TOOL_CONFIG_KEY
        : buildRuntimeToolConfigKey(selectedTools),
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

function buildLlmStepResultSummary(stepRun: ChatLlmStepRun): Record<string, unknown> {
  const model = String(stepRun.model || "").trim();
  const usage = normalizeLanguageModelUsage(stepRun.usage);
  const pricing = resolveTokenPricing({
    chatModel: model,
    embeddingModel: "gemini-embedding-001",
  });
  const chatCostUsd =
    (usage.inputTokens / 1_000_000) * pricing.chatInputPer1MUsd +
    (usage.outputTokens / 1_000_000) * pricing.chatOutputPer1MUsd;
  const rates = readCurrencyRates();
  const converted = convertUsd(chatCostUsd, rates);

  return {
    ...asRecord(stepRun.metadata),
    kind: "llm_step",
    step: stepRun.step,
    model,
    latencyMs: Math.max(0, Math.round(Number(stepRun.latencyMs || 0))),
    inputTokens: Math.max(0, Math.round(usage.inputTokens)),
    outputTokens: Math.max(0, Math.round(usage.outputTokens)),
    totalTokens: Math.max(0, Math.round(usage.totalTokens)),
    chatCostUsd: roundMetric(chatCostUsd),
    chatCostEur: roundMetric(converted.eur),
    chatCostRub: roundMetric(converted.rub, 6),
    pricingVersion: resolvePricingVersion(),
    pricing: {
      chatInputPer1MUsd: pricing.chatInputPer1MUsd,
      chatOutputPer1MUsd: pricing.chatOutputPer1MUsd,
      usdToEur: rates.usdToEur,
      eurToRub: rates.eurToRub,
    },
  };
}

async function persistNormalizedChatMetrics(params: {
  bookId: string;
  threadId: string;
  messageId: string;
  toolRuns: ChatToolRun[];
  llmStepRuns?: ChatLlmStepRun[];
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
  const toolRows: Array<{
    toolName: string;
    orderIndex: number;
    latencyMs: number;
    argsSummaryJson: Record<string, unknown>;
    resultSummaryJson: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    storageProvider: string | null;
    payloadKey: string | null;
    payloadSizeBytes: number;
    payloadSha256: string | null;
    compression: string | null;
  }> = [];
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

  if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED) {
    const llmStepRows = Array.isArray(params.llmStepRuns) ? params.llmStepRuns : [];
    for (const [index, run] of llmStepRows.entries()) {
      const step = String(run.step || "").trim();
      const toolName =
        step === "planner" ? "llm_planner" : step === "fallback" ? "llm_fallback" : "llm_main";
      const orderIndex: number = toolRows.length + index;
      toolRows.push({
        toolName,
        orderIndex,
        latencyMs: Math.max(0, Math.round(Number(run.latencyMs || 0))),
        argsSummaryJson: {
          kind: "llm_step",
          step,
          model: String(run.model || "").trim(),
        },
        resultSummaryJson: buildLlmStepResultSummary(run),
        errorCode: null,
        errorMessage: null,
        storageProvider: null,
        payloadKey: null,
        payloadSizeBytes: 0,
        payloadSha256: null,
        compression: null,
      });
    }
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

  if (normalizedTool === "search_paragraphs" || normalizedTool === "search_paragraphs_hybrid") {
    const hits = Array.isArray(row.hits) ? row.hits : [];
    const primaryEvidenceSlices = Array.isArray(row.primaryEvidenceSlices)
      ? row.primaryEvidenceSlices
      : Array.isArray(row.expandedSlices)
        ? row.expandedSlices
        : [];
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
      primaryEvidenceSliceCount: primaryEvidenceSlices.length,
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

  if (normalizedTool === "read_passages") {
    const passages = Array.isArray(row.passages) ? row.passages : [];
    const summary: Record<string, unknown> = {
      returned: passages.length,
    };
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
    cacheKey: `${bookId}|${analysisStamp}|${updatedStamp}|sev:${SCENE_EMBEDDING_VERSION}|pev:${PARAGRAPH_EMBEDDING_VERSION}|fev:${EVIDENCE_FRAGMENT_EMBEDDING_VERSION}`,
  };
}

async function ensureBookSearchContext(bookId: string, context?: BookSearchContext): Promise<BookSearchContext> {
  if (context) return context;
  return resolveBookSearchContext(bookId);
}

export function buildEvidenceFragmentsFromSceneBounds(params: {
  bookId: string;
  paragraphDocs: readonly LexicalParagraphDoc[];
  sceneBoundsByRef: Map<string, AutoContextSceneBounds>;
  windowParagraphs?: number;
  overlapParagraphs?: number;
}): EvidenceFragmentDoc[] {
  const windowParagraphs = Math.max(1, Math.floor(params.windowParagraphs ?? EVIDENCE_FRAGMENT_WINDOW_PARAGRAPHS));
  const overlapParagraphs = Math.max(0, Math.min(windowParagraphs - 1, Math.floor(params.overlapParagraphs ?? EVIDENCE_FRAGMENT_OVERLAP_PARAGRAPHS)));
  const step = Math.max(1, windowParagraphs - overlapParagraphs);
  const docsByChapter = new Map<string, Map<number, LexicalParagraphDoc>>();
  for (const doc of params.paragraphDocs) {
    if (!docsByChapter.has(doc.chapterId)) docsByChapter.set(doc.chapterId, new Map());
    docsByChapter.get(doc.chapterId)!.set(doc.paragraphIndex, doc);
  }

  const rows: EvidenceFragmentDoc[] = [];
  const sortedScenes = Array.from(params.sceneBoundsByRef.values()).sort((left, right) => {
    const leftChapter = params.paragraphDocs.find((doc) => doc.chapterId === left.chapterId)?.chapterOrderIndex ?? 0;
    const rightChapter = params.paragraphDocs.find((doc) => doc.chapterId === right.chapterId)?.chapterOrderIndex ?? 0;
    if (leftChapter !== rightChapter) return leftChapter - rightChapter;
    return left.sceneIndex - right.sceneIndex;
  });

  let orderIndex = 0;
  for (const scene of sortedScenes) {
    const docsByParagraph = docsByChapter.get(scene.chapterId);
    if (!docsByParagraph) continue;
    const sceneWidth = Math.max(0, scene.paragraphEnd - scene.paragraphStart + 1);
    if (!sceneWidth) continue;
    const starts =
      sceneWidth <= windowParagraphs
        ? [scene.paragraphStart]
        : Array.from({ length: Math.floor((sceneWidth - windowParagraphs) / step) + 1 }, (_, index) => scene.paragraphStart + index * step);
    const lastStart = Math.max(scene.paragraphStart, scene.paragraphEnd - windowParagraphs + 1);
    if (!starts.includes(lastStart)) starts.push(lastStart);

    for (const start of starts.sort((left, right) => left - right)) {
      const end = Math.min(scene.paragraphEnd, start + windowParagraphs - 1);
      const paragraphs: LexicalParagraphDoc[] = [];
      for (let paragraphIndex = start; paragraphIndex <= end; paragraphIndex += 1) {
        const doc = docsByParagraph.get(paragraphIndex);
        if (doc) paragraphs.push(doc);
      }
      if (!paragraphs.length) continue;
      const text = paragraphs.map((paragraph) => paragraph.text).join("\n\n").trim();
      const normalized = normalizeLexicalSearchText(text);
      if (!normalized) continue;
      const terms = normalized.split(/\s+/gu).filter((term) => term.length >= 2);
      if (!terms.length) continue;
      const uniqueTermSet = new Set(terms);
      orderIndex += 1;
      rows.push({
        id: `frag:${scene.chapterId}:${scene.sceneIndex}:${start}:${end}`,
        bookId: params.bookId,
        chapterId: scene.chapterId,
        chapterOrderIndex: paragraphs[0]!.chapterOrderIndex,
        chapterTitle: paragraphs[0]!.chapterTitle,
        sceneId: scene.sceneId,
        sceneIndex: scene.sceneIndex,
        paragraphStart: start,
        paragraphEnd: end,
        source: "scene_window",
        orderIndex,
        text,
        normalized,
        termFrequency: buildTermFrequencyMap(terms),
        uniqueTerms: Array.from(uniqueTermSet),
        termCount: terms.length,
      });
    }
  }

  return rows;
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
      const [resolvedCorpus, scenes, persistedParagraphRows, persistedFragmentRows] = await Promise.all([
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
            id: true,
            chapterId: true,
            sceneIndex: true,
            paragraphStart: true,
            paragraphEnd: true,
            sceneCard: true,
            sceneSummary: true,
          },
        }),
        prisma.$queryRaw<
          Array<{
            chapterId: string;
            chapterOrderIndex: number;
            chapterTitle: string;
            paragraphIndex: number;
            text: string;
          }>
        >`
          SELECT
            p."chapterId" AS "chapterId",
            c."orderIndex" AS "chapterOrderIndex",
            c."title" AS "chapterTitle",
            p."paragraphIndex" AS "paragraphIndex",
            p."text" AS "text"
          FROM "BookParagraph" p
          INNER JOIN "BookChapter" c ON c."id" = p."chapterId"
          WHERE p."bookId" = ${params.bookId}
          ORDER BY c."orderIndex" ASC, p."paragraphIndex" ASC
        `,
        BOOK_EVIDENCE_FRAGMENTS_ENABLED
          ? prisma.$queryRaw<PersistedFragmentLexicalRow[]>`
              SELECT
                f."id" AS "id",
                f."bookId" AS "bookId",
                f."chapterId" AS "chapterId",
                c."orderIndex" AS "chapterOrderIndex",
                c."title" AS "chapterTitle",
                f."primarySceneId" AS "sceneId",
                s."sceneIndex" AS "sceneIndex",
                f."paragraphStart" AS "paragraphStart",
                f."paragraphEnd" AS "paragraphEnd",
                f."orderIndex" AS "orderIndex",
                f."text" AS "text"
              FROM "BookEvidenceFragment" f
              INNER JOIN "BookChapter" c ON c."id" = f."chapterId"
              LEFT JOIN "BookAnalysisScene" s ON s."id" = f."primarySceneId"
              WHERE f."bookId" = ${params.bookId}
                AND f."embeddingVersion" = ${EVIDENCE_FRAGMENT_EMBEDDING_VERSION}
              ORDER BY c."orderIndex" ASC, f."orderIndex" ASC
            `
          : Promise.resolve([] as PersistedFragmentLexicalRow[]),
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
	          sceneId: string;
	          sceneIndex: number;
	          paragraphStart: number;
	          paragraphEnd: number;
	          title?: string;
	        }>
	      >();
	      for (const scene of scenes) {
	        if (!scenesByChapterId.has(scene.chapterId)) {
	          scenesByChapterId.set(scene.chapterId, []);
	        }
	        scenesByChapterId.get(scene.chapterId)!.push({
	          sceneId: scene.id,
	          sceneIndex: scene.sceneIndex,
	          paragraphStart: scene.paragraphStart,
	          paragraphEnd: scene.paragraphEnd,
	          title: clampText(String(scene.sceneCard || scene.sceneSummary || "").trim(), 120) || undefined,
	        });
	      }

	      const paragraphDocs: LexicalParagraphDoc[] = [];
	      const documentFrequencyByTerm = new Map<string, number>();
	      const paragraphSceneIndexByRef = new Map<string, number | null>();
	      const sceneBoundsByRef = new Map<string, AutoContextSceneBounds>();
	      for (const scene of scenes) {
	        sceneBoundsByRef.set(makeSceneRefKey(scene.chapterId, scene.sceneIndex), {
	          sceneId: scene.id,
	          chapterId: scene.chapterId,
	          sceneIndex: scene.sceneIndex,
	          paragraphStart: scene.paragraphStart,
	          paragraphEnd: scene.paragraphEnd,
	          title: clampText(String(scene.sceneCard || scene.sceneSummary || "").trim(), 120) || undefined,
	        });
	      }
      let totalTerms = 0;

      const paragraphSourceRows = persistedParagraphRows.length
        ? persistedParagraphRows
        : chapters.flatMap((chapter) =>
            splitChapterToParagraphs(chapter.rawText).map((text, index) => ({
              chapterId: chapter.id,
              chapterOrderIndex: chapter.orderIndex,
              chapterTitle: chapter.title,
              paragraphIndex: index + 1,
              text,
            }))
          );

      for (const row of paragraphSourceRows) {
          const paragraphText = String(row.text || "").trim();
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

          const paragraphIndex = Number(row.paragraphIndex || 0);
          const chapterScenes = scenesByChapterId.get(row.chapterId) || [];
          const sceneIndex = detectSceneIndexForParagraph(chapterScenes, paragraphIndex);
          const refKey = makeParagraphRefKey(row.chapterId, paragraphIndex);
          paragraphSceneIndexByRef.set(refKey, sceneIndex);
          totalTerms += paragraphTerms.length;
          paragraphDocs.push({
            chapterId: row.chapterId,
            chapterOrderIndex: Number(row.chapterOrderIndex || 0),
            chapterTitle: String(row.chapterTitle || "").trim(),
            paragraphIndex,
            sceneIndex,
            text: paragraphText,
            normalized: paragraphNormalized,
            termFrequency,
            uniqueTerms: Array.from(uniqueTermSet),
            termCount: paragraphTerms.length,
          });
      }

      const persistedEvidenceFragments: EvidenceFragmentDoc[] = persistedFragmentRows
        .map((fragment: PersistedFragmentLexicalRow): EvidenceFragmentDoc | null => {
          const text = String(fragment.text || "").trim();
          const normalized = normalizeLexicalSearchText(text);
          if (!text || !normalized) return null;
          const terms = normalized.split(/\s+/gu).filter((term) => term.length >= 2);
          if (!terms.length) return null;
          const uniqueTerms = Array.from(new Set(terms));
          return {
            id: String(fragment.id || ""),
            bookId: String(fragment.bookId || params.bookId),
            chapterId: String(fragment.chapterId || ""),
            chapterOrderIndex: Number(fragment.chapterOrderIndex || 0),
            chapterTitle: String(fragment.chapterTitle || "").trim(),
            sceneId: fragment.sceneId || undefined,
            sceneIndex:
              typeof fragment.sceneIndex === "number" && Number.isFinite(fragment.sceneIndex)
                ? Number(fragment.sceneIndex)
                : fragment.sceneIndex
                  ? Number(fragment.sceneIndex)
                  : null,
            paragraphStart: Number(fragment.paragraphStart || 0),
            paragraphEnd: Number(fragment.paragraphEnd || 0),
            source: "scene_window" as const,
            orderIndex: Number(fragment.orderIndex || 0),
            text,
            normalized,
            termFrequency: buildTermFrequencyMap(terms),
            uniqueTerms,
            termCount: terms.length,
          } satisfies EvidenceFragmentDoc;
        })
        .filter((fragment: EvidenceFragmentDoc | null): fragment is EvidenceFragmentDoc => Boolean(fragment));

      const evidenceFragments = BOOK_EVIDENCE_FRAGMENTS_ENABLED
        ? persistedEvidenceFragments.length
          ? persistedEvidenceFragments
          : buildEvidenceFragmentsFromSceneBounds({
              bookId: params.bookId,
              paragraphDocs,
              sceneBoundsByRef,
            })
        : [];
	      const documentCount = paragraphDocs.length;
	      const averageDocumentLength = documentCount > 0 ? totalTerms / documentCount : 0;
	      return {
	        paragraphDocs,
	        evidenceFragments,
	        documentCount,
        averageDocumentLength,
        documentFrequencyByTerm,
        paragraphSceneIndexByRef,
        sceneBoundsByRef,
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
      COALESCE(p."text", e."sourceText") AS "sourceText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookParagraphEmbedding" e
    INNER JOIN "BookChapter" c ON c."id" = e."chapterId"
    LEFT JOIN "BookParagraph" p
      ON p."id" = e."paragraphId"
       OR (
        p."bookId" = e."bookId"
        AND p."chapterId" = e."chapterId"
        AND p."paragraphIndex" = e."paragraphIndex"
       )
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

async function searchEvidenceFragmentsSemanticSql(params: {
  bookId: string;
  queryVector: number[];
  topK: number;
}): Promise<{ rows: EvidenceFragmentSearchHit[]; embeddingRows: number }> {
  if (params.queryVector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) {
    return {
      rows: [],
      embeddingRows: 0,
    };
  }

  const vectorLiteral = serializeVectorLiteral(params.queryVector);
  const persistedRows = await prisma.$queryRaw<SemanticEvidenceFragmentQueryRow[]>`
    SELECT
      COUNT(*) OVER ()::integer AS "embeddingRows",
      f."id" AS "fragmentId",
      f."chapterId" AS "chapterId",
      c."orderIndex" AS "chapterOrderIndex",
      c."title" AS "chapterTitle",
      f."fragmentType" AS "fragmentType",
      f."primarySceneId" AS "sceneId",
      s."sceneIndex" AS "sceneIndex",
      f."paragraphStart" AS "paragraphStart",
      f."paragraphEnd" AS "paragraphEnd",
      f."text" AS "sourceText",
      1 - (e."vector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM "BookEvidenceFragmentEmbedding" e
    INNER JOIN "BookEvidenceFragment" f ON f."id" = e."fragmentId"
    INNER JOIN "BookChapter" c ON c."id" = f."chapterId"
    LEFT JOIN "BookAnalysisScene" s ON s."id" = f."primarySceneId"
    WHERE e."bookId" = ${params.bookId}
      AND e."embeddingVersion" = ${EVIDENCE_FRAGMENT_EMBEDDING_VERSION}
      AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
      AND e."vector" IS NOT NULL
    ORDER BY e."vector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${params.topK}
  `;
  if (persistedRows.length) {
    return {
      rows: persistedRows.map((row: SemanticEvidenceFragmentQueryRow) => ({
        id: String(row.fragmentId || ""),
        chapterId: row.chapterId,
        chapterOrderIndex: Number(row.chapterOrderIndex || 0),
        chapterTitle: String(row.chapterTitle || "").trim(),
        fragmentType: row.fragmentType === "medium" ? "medium" : "small",
        sceneId: row.sceneId || undefined,
        sceneIndex:
          typeof row.sceneIndex === "number" && Number.isFinite(row.sceneIndex) ? Number(row.sceneIndex) : row.sceneIndex ? Number(row.sceneIndex) : null,
        paragraphStart: Number(row.paragraphStart || 0),
        paragraphEnd: Number(row.paragraphEnd || 0),
        score: Number(row.semanticScore || 0),
        semanticRank: null,
        lexicalRank: null,
        matchedTerms: [],
        text: normalizeText(row.sourceText),
      })),
      embeddingRows: Math.max(0, Number(persistedRows[0]?.embeddingRows || 0)),
    };
  }

  const windowParagraphs = EVIDENCE_FRAGMENT_WINDOW_PARAGRAPHS;
  const step = Math.max(1, EVIDENCE_FRAGMENT_WINDOW_PARAGRAPHS - EVIDENCE_FRAGMENT_OVERLAP_PARAGRAPHS);
  const rows = await prisma.$queryRaw<SemanticEvidenceFragmentQueryRow[]>`
    WITH fragment_candidates AS (
      SELECT
        s."id" AS "sceneId",
        s."chapterId" AS "chapterId",
        c."orderIndex" AS "chapterOrderIndex",
        c."title" AS "chapterTitle",
        s."sceneIndex" AS "sceneIndex",
        starts."startIndex"::integer AS "paragraphStart",
        LEAST(s."paragraphEnd", starts."startIndex" + ${windowParagraphs} - 1)::integer AS "paragraphEnd",
        AVG(e."vector") AS "fragmentVector",
        STRING_AGG(COALESCE(p."text", e."sourceText"), E'\n\n' ORDER BY e."paragraphIndex") AS "sourceText"
      FROM "BookAnalysisScene" s
      INNER JOIN "BookChapter" c ON c."id" = s."chapterId"
      CROSS JOIN LATERAL (
        SELECT DISTINCT "startIndex"
        FROM (
          SELECT generate_series(
            s."paragraphStart",
            GREATEST(s."paragraphStart", s."paragraphEnd" - ${windowParagraphs} + 1),
            ${step}
          ) AS "startIndex"
          UNION
          SELECT GREATEST(s."paragraphStart", s."paragraphEnd" - ${windowParagraphs} + 1) AS "startIndex"
        ) raw_starts
      ) starts
      INNER JOIN "BookParagraphEmbedding" e
        ON e."bookId" = s."bookId"
       AND e."chapterId" = s."chapterId"
       AND e."paragraphIndex" BETWEEN starts."startIndex" AND LEAST(s."paragraphEnd", starts."startIndex" + ${windowParagraphs} - 1)
       AND e."embeddingVersion" = ${PARAGRAPH_EMBEDDING_VERSION}
       AND e."dimensions" = ${PGVECTOR_EMBEDDING_DIMENSIONS}
       AND e."vector" IS NOT NULL
      LEFT JOIN "BookParagraph" p
        ON p."id" = e."paragraphId"
         OR (
          p."bookId" = e."bookId"
          AND p."chapterId" = e."chapterId"
          AND p."paragraphIndex" = e."paragraphIndex"
         )
      WHERE s."bookId" = ${params.bookId}
      GROUP BY
        s."id",
        s."chapterId",
        c."orderIndex",
        c."title",
        s."sceneIndex",
        starts."startIndex",
        s."paragraphEnd"
    )
    SELECT
      COUNT(*) OVER ()::integer AS "embeddingRows",
      CONCAT('frag:', "chapterId", ':', "sceneIndex", ':', "paragraphStart", ':', "paragraphEnd") AS "fragmentId",
      "chapterId",
      "chapterOrderIndex",
      "chapterTitle",
      "sceneId",
      "sceneIndex",
      "paragraphStart",
      "paragraphEnd",
      "sourceText",
      1 - ("fragmentVector" <=> CAST(${vectorLiteral} AS vector(768))) AS "semanticScore"
    FROM fragment_candidates
    ORDER BY "fragmentVector" <=> CAST(${vectorLiteral} AS vector(768))
    LIMIT ${params.topK}
  `;

  return {
    rows: rows.map((row: SemanticEvidenceFragmentQueryRow) => ({
      id: String(row.fragmentId || ""),
      chapterId: row.chapterId,
      chapterOrderIndex: Number(row.chapterOrderIndex || 0),
      chapterTitle: String(row.chapterTitle || "").trim(),
      fragmentType: "small",
      sceneId: row.sceneId || undefined,
      sceneIndex:
        typeof row.sceneIndex === "number" && Number.isFinite(row.sceneIndex) ? Number(row.sceneIndex) : row.sceneIndex ? Number(row.sceneIndex) : null,
      paragraphStart: Number(row.paragraphStart || 0),
      paragraphEnd: Number(row.paragraphEnd || 0),
      score: Number(row.semanticScore || 0),
      semanticRank: null,
      lexicalRank: null,
      matchedTerms: [],
      text: normalizeText(row.sourceText),
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

function extractJsonObjectFromText(value: string): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("{") && text.endsWith("}")) return text;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) return fenced;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = text.slice(start, end + 1).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }

  return null;
}

function resolveBookChatModelByTier(defaultChatModel: string): ChatModelByTier {
  const fallback = String(defaultChatModel || "").trim();
  const lite = String(
    process.env.BOOK_CHAT_MODEL_LITE || process.env.VERTEX_MODEL_LITE || process.env.VERTEX_CHAT_MODEL || fallback
  ).trim() || fallback;
  const pro = String(
    process.env.BOOK_CHAT_MODEL_PRO || process.env.VERTEX_MODEL_PRO || process.env.VERTEX_CHAT_MODEL || lite
  ).trim() || lite;
  return {
    lite,
    pro,
  };
}

function classifyBookChatQuestion(userQuestion: string): {
  isLikelySmallTalk: boolean;
  isBookQuestion: boolean;
  isSimpleBookQuestion: boolean;
  isComplexBookQuestion: boolean;
} {
  const question = String(userQuestion || "").trim().toLowerCase();
  const isLikelySmallTalk =
    question.length <= 60 && /(привет|здравствуй|как дела|как ты|спасибо|ок|понял|ясно|добрый день|hello|hi)/i.test(question);

  const hasBookSignals =
    /(в книге|книга|глава|сцена|эпизод|персонаж|герой|сюжет|цитат|тайная комната|гарри|рон|гермион|хогвартс|слизерин|малфо|реддл|василиск|дневник|добби|локхарт|хагрид)/i.test(
      question
    ) || (!isLikelySmallTalk && question.length > 85);

  const hasSimpleFactSignals =
    /(кто такой|кто такая|кто это|что такое|как зовут|где находится|когда|друг|враг|является ли|это кто)/i.test(question);
  const hasComplexSignals =
    /(почему|каким образом|разрознен|в разных главах|восстанови|последовательност|сравни|докажи|несостыковк|какие именно|шаг за шагом|на нескольких уровнях|цепоч|причинно-следствен)/i.test(
      question
    ) || question.length >= 140;

  const isSimpleBookQuestion = hasBookSignals && !hasComplexSignals && (hasSimpleFactSignals || question.length <= 80);
  const isComplexBookQuestion = hasBookSignals && (hasComplexSignals || question.length >= 140);

  return {
    isLikelySmallTalk,
    isBookQuestion: hasBookSignals,
    isSimpleBookQuestion,
    isComplexBookQuestion,
  };
}

function normalizePlannerSearchPlan(value: unknown): BookChatPlannerSearchPlan | undefined {
  const row = asRecord(value);
  const normalizedQuestion = String(row.normalizedQuestion || "").replace(/\s+/g, " ").trim();
  const entityHints = asStringList(row.entityHints, 12)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
  const broadQueries = asStringList(row.broadQueries, 8)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  const focusedQueries = asStringList(row.focusedQueries, 10)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 10);
  const explicitSearchQueries = asStringList(row.searchQueries, 14)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 14);
  const notes = asStringList(row.notes, 6)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  const queryGroups = Array.isArray(row.queryGroups)
    ? row.queryGroups
        .map((item): BookChatPlannerQueryGroup | null => {
          const group = asRecord(item);
          const part = String(group.part || "").replace(/\s+/g, " ").trim();
          const groupBroadQueries = asStringList(group.broadQueries, 4)
            .map((query) => query.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 4);
          const groupFocusedQueries = asStringList(group.focusedQueries, 6)
            .map((query) => query.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 6);
          const groupExplicitSearchQueries = asStringList(group.searchQueries, 8)
            .map((query) => query.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 8);
          const groupSearchQueries = Array.from(
            new Set([...groupExplicitSearchQueries, ...groupBroadQueries, ...groupFocusedQueries])
          ).slice(0, 8);
          if (!part && !groupSearchQueries.length) return null;
          return {
            part,
            searchQueries: groupSearchQueries,
            broadQueries: groupBroadQueries,
            focusedQueries: groupFocusedQueries,
          };
        })
        .filter((item): item is BookChatPlannerQueryGroup => Boolean(item))
        .slice(0, 6)
    : [];
  const searchQueries = Array.from(new Set([...explicitSearchQueries, ...broadQueries, ...focusedQueries])).slice(0, 14);
  if (!normalizedQuestion && !entityHints.length && !searchQueries.length && !queryGroups.length) return undefined;

  return {
    normalizedQuestion,
    entityHints,
    searchQueries,
    broadQueries,
    focusedQueries,
    queryGroups,
    notes,
  };
}

async function getPlannerBookMetadata(bookId: string): Promise<{
  title: string;
  author: string | null;
  fileName: string;
  mimeType: string;
  chapterCount: number;
  chapters: Array<{ orderIndex: number; title: string }>;
  topAnchors: string[];
}> {
  const [book, topAnchorsRows] = await Promise.all([
    prisma.book.findUnique({
      where: {
        id: bookId,
      },
      select: {
        title: true,
        author: true,
        fileName: true,
        mimeType: true,
        chapterCount: true,
        chapters: {
          orderBy: {
            orderIndex: "asc",
          },
          select: {
            orderIndex: true,
            title: true,
          },
        },
      },
    }),
    prisma.$queryRaw<Array<{ anchor: string; n: number }>>`
      WITH anchors AS (
        SELECT value AS anchor
        FROM "BookAnalysisScene" s,
             jsonb_array_elements_text(s."mentionedEntitiesJson"::jsonb) AS value
        WHERE s."bookId" = ${bookId}
        UNION ALL
        SELECT value AS anchor
        FROM "BookAnalysisScene" s,
             jsonb_array_elements_text(s."eventLabelsJson"::jsonb) AS value
        WHERE s."bookId" = ${bookId}
      )
      SELECT trim(both ' .,!?:;«»"' from anchor) AS anchor, count(*)::int AS n
      FROM anchors
      WHERE length(trim(both ' .,!?:;«»"' from anchor)) >= 3
      GROUP BY 1
      ORDER BY n DESC, anchor ASC
      LIMIT 80
    `.catch((): Array<{ anchor: string; n: number }> => []),
  ]);
  const chapters: Array<{ orderIndex: number; title: string }> = book?.chapters || [];
  const topAnchors = topAnchorsRows
    .map((row: { anchor: string; n: number }) => String(row.anchor || "").replace(/\s+/g, " ").trim())
    .filter((value: string) => Boolean(value));

  return {
    title: book?.title || "",
    author: book?.author || null,
    fileName: book?.fileName || "",
    mimeType: book?.mimeType || "",
    chapterCount: Number(book?.chapterCount || chapters.length || 0),
    chapters: chapters.map((chapter: { orderIndex: number; title: string }) => ({
      orderIndex: chapter.orderIndex,
      title: chapter.title,
    })),
    topAnchors: Array.from(new Set<string>(topAnchors)).slice(0, 80),
  };
}

function buildHeuristicBookChatPlannerDecision(params: {
  userQuestion: string;
  enabledTools: readonly BookChatToolName[];
}): BookChatPlannerDecision {
  if (!params.enabledTools.length) {
    return {
      toolPolicy: "auto",
      modelTier: "lite",
    };
  }

  const profile = classifyBookChatQuestion(params.userQuestion);
  if (profile.isLikelySmallTalk || !profile.isBookQuestion) {
    return {
      toolPolicy: "auto",
      modelTier: "lite",
    };
  }

  if (profile.isSimpleBookQuestion && !profile.isComplexBookQuestion) {
    return {
      toolPolicy: "required",
      modelTier: "lite",
    };
  }

  return {
    toolPolicy: "required",
    modelTier: "pro",
  };
}

function normalizeBookChatPlannerDecision(
  decision: BookChatPlannerDecision,
  enabledTools: readonly BookChatToolName[]
): BookChatPlannerDecision {
  if (enabledTools.length) return decision;
  return {
    ...decision,
    toolPolicy: "auto",
  };
}

async function planBookChatExecution(params: {
  clientConfig: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
    proxySource: string;
  };
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  enabledTools: readonly BookChatToolName[];
}): Promise<BookChatExecutionPlan> {
  const modelByTier = resolveBookChatModelByTier(params.clientConfig.chatModel);
  const questionProfile = classifyBookChatQuestion(params.userQuestion);
  const heuristicDecision = buildHeuristicBookChatPlannerDecision({
    userQuestion: params.userQuestion,
    enabledTools: params.enabledTools,
  });
  let decision = normalizeBookChatPlannerDecision(heuristicDecision, params.enabledTools);
  let usage: LanguageModelUsage | undefined;
  let plannerStepRun: ChatLlmStepRun | undefined;
  const plannerBookMetadata = await getPlannerBookMetadata(params.bookId);

  if (BOOK_CHAT_PLANNER_ENABLED) {
    const plannerModelId =
      String(process.env.BOOK_CHAT_PLANNER_MODEL || modelByTier.lite || params.clientConfig.chatModel).trim() ||
      params.clientConfig.chatModel;
    const plannerModel = createVertexChatModelFromConfig({
      ...params.clientConfig,
      chatModel: plannerModelId,
    });
    const plannerProviderOptions = createVertexReasoningProviderOptions(plannerModelId);

    const plannerSchema = z.object({
      toolPolicy: z.enum(["auto", "required"]),
      modelTier: z.enum(["lite", "pro"]),
      searchPlan: z
        .object({
          normalizedQuestion: z.string().default(""),
          entityHints: z.array(z.string()).default([]),
          searchQueries: z.array(z.string()).default([]),
          broadQueries: z.array(z.string()).default([]),
          focusedQueries: z.array(z.string()).default([]),
          queryGroups: z
            .array(
              z.object({
                part: z.string().default(""),
                searchQueries: z.array(z.string()).default([]),
                broadQueries: z.array(z.string()).default([]),
                focusedQueries: z.array(z.string()).default([]),
              })
            )
            .default([]),
          notes: z.array(z.string()).default([]),
        })
        .optional(),
    });

    try {
      const plannerStartedAt = Date.now();
      const completion = await withSemaphore(chatCallSemaphore, async () =>
        generateText({
          model: plannerModel,
          temperature: 0,
          system:
            "Ты планировщик retrieval для чата по одной книге. Не отвечай на вопрос пользователя. " +
            "Твоя задача: выбрать режим tools/model и превратить пользовательский вопрос в качественные поисковые формулировки. " +
            "Search plan - это только гипотезы для поиска, не доказательство. " +
            "Ответь строго одним JSON-объектом без markdown, комментариев и лишнего текста.",
          prompt: `Книга: ${params.bookTitle}
Вопрос пользователя: ${params.userQuestion}
Доступные инструменты: ${params.enabledTools.join(", ") || "none"}

Мета книги из файла и анализа:
${JSON.stringify(
  {
    title: plannerBookMetadata.title || params.bookTitle,
    author: plannerBookMetadata.author,
    fileName: plannerBookMetadata.fileName,
    mimeType: plannerBookMetadata.mimeType,
    chapterCount: plannerBookMetadata.chapterCount,
    chapters: plannerBookMetadata.chapters.map((chapter) => ({
      index: chapter.orderIndex,
      title: chapter.title,
    })),
    topAnchors: plannerBookMetadata.topAnchors,
  },
  null,
  2
)}

Правила:
- toolPolicy = "required", если это вопрос по содержанию книги, фактам, причинно-следственным связям, цитатам или проверке утверждений.
- toolPolicy = "auto", если это small-talk, мета-вопрос о чате или явно не-книжный вопрос.
- modelTier = "pro" только для сложных книжных вопросов: многосоставных, с причинно-следственными цепочками, сравнением, реконструкцией последовательности, сопоставлением разных сцен.
- modelTier = "lite" для простых книжных вопросов одного факта (кто/что/когда/где, короткое уточнение персонажа/события), small-talk и мета-вопросов.
- searchPlan обязателен для toolPolicy="required".
- searchPlan.normalizedQuestion: переформулируй вопрос языком этой книги, используя title/chapters/topAnchors для канонических имён и терминов.
- searchPlan.entityHints: имена, предметы, места и термины, которые стоит использовать в retrieval.
- searchPlan.searchQueries: 5-10 лучших поисковых запросов для search_scenes/search_paragraphs. Делай их предметными: имена + действия/улики/конфликт/результат.
- broadQueries: широкие запросы для поиска карты сцен.
- focusedQueries: точные запросы для поиска paragraph evidence.
- queryGroups: разбей вопрос на независимые смысловые части и дай для каждой части свои broadQueries/focusedQueries/searchQueries.
- queryGroups[].part - только нейтральное название части вопроса, без ответа и без утверждений, которых нет в вопросе.
- Можешь использовать своё знание книги только как генератор поисковых гипотез. Не формулируй это как доказанный факт.
- Не добавляй в searchPlan готовые выводы, пересказ ответа или "что произошло на самом деле". Только формулировки для поиска.
- Не отдавай абстрактные query вроде "образ расходится с реальностью", если можно сделать query ближе к тексту: персонаж + действие + предмет/место/результат.
- Если вопрос многосоставный, searchQueries должны покрывать каждую часть.

Верни JSON:
{"toolPolicy":"required|auto","modelTier":"lite|pro","searchPlan":{"normalizedQuestion":"...","entityHints":["..."],"searchQueries":["..."],"broadQueries":["..."],"focusedQueries":["..."],"queryGroups":[{"part":"...","searchQueries":["..."],"broadQueries":["..."],"focusedQueries":["..."]}],"notes":[]}}`,
          providerOptions: plannerProviderOptions,
        })
      );
      const plannerLatencyMs = Date.now() - plannerStartedAt;

      usage = completion.usage;
      const rawJson = extractJsonObjectFromText(String(completion.text || ""));
      if (rawJson) {
        const parsed = plannerSchema.safeParse(JSON.parse(rawJson));
        if (parsed.success) {
          decision = normalizeBookChatPlannerDecision(
            {
              toolPolicy: parsed.data.toolPolicy,
              modelTier: parsed.data.modelTier,
              searchPlan: normalizePlannerSearchPlan(parsed.data.searchPlan),
            },
            params.enabledTools
          );
          if (questionProfile.isSimpleBookQuestion && !questionProfile.isComplexBookQuestion) {
            decision = {
              ...decision,
              toolPolicy: params.enabledTools.length ? "required" : "auto",
              modelTier: "lite",
            };
          } else if (questionProfile.isLikelySmallTalk || !questionProfile.isBookQuestion) {
            decision = {
              ...decision,
              toolPolicy: "auto",
              modelTier: "lite",
            };
          }
        }
      }
      if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED) {
        plannerStepRun = {
          step: "planner",
          model: plannerModelId,
          usage,
          latencyMs: plannerLatencyMs,
          metadata: {
            toolPolicy: decision.toolPolicy,
            modelTier: decision.modelTier,
            normalizedQuestion: decision.searchPlan?.normalizedQuestion || null,
            searchQueryCount: decision.searchPlan?.searchQueries.length || 0,
            entityHintCount: decision.searchPlan?.entityHints.length || 0,
          },
        };
      }
    } catch {
      // Fall back to deterministic heuristic routing.
    }
  }

  const selectedChatModelId =
    decision.modelTier === "pro" ? modelByTier.pro || params.clientConfig.chatModel : modelByTier.lite || params.clientConfig.chatModel;

  return {
    decision,
    selectedChatModelId,
    usage,
    plannerStepRun,
  };
}

function normalizeAnswerMode(value: unknown, fallback: ChatAnswerMode): ChatAnswerMode {
  const normalized = String(value || "").trim();
  if (
    normalized === "fact" ||
    normalized === "explanation" ||
    normalized === "comparison" ||
    normalized === "chronology" ||
    normalized === "summary" ||
    normalized === "table_sequence" ||
    normalized === "clue_synthesis" ||
    normalized === "progressive_reveal"
  ) {
    return normalized;
  }
  return fallback;
}

function normalizeEvidenceBudget(value: unknown, fallback: ChatEvidenceBudget): ChatEvidenceBudget {
  const normalized = String(value || "").trim();
  if (normalized === "small" || normalized === "medium" || normalized === "large") return normalized;
  return fallback;
}

function normalizeEvidenceOrder(value: unknown, fallback: ChatEvidenceOrder): ChatEvidenceOrder {
  const normalized = String(value || "").trim();
  if (normalized === "relevance" || normalized === "chronological") return normalized;
  return fallback;
}

function normalizePreplanRoute(value: unknown, fallback: ChatPreplanRoute): ChatPreplanRoute {
  const normalized = String(value || "").trim();
  if (normalized === "grounded_answer" || normalized === "structure_answer" || normalized === "meta_answer") {
    return normalized;
  }
  return fallback;
}

function normalizePreplanComplexity(value: unknown, fallback: ChatPreplanComplexity): ChatPreplanComplexity {
  const normalized = String(value || "").trim();
  if (normalized === "simple" || normalized === "medium" || normalized === "hard") return normalized;
  return fallback;
}

function normalizePreplanModel(value: unknown, fallback: ChatModelTier): ChatModelTier {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pro") return "pro";
  if (normalized === "light" || normalized === "lite") return "lite";
  return fallback;
}

function normalizeSubqueries(value: unknown, mainQuery: string): string[] {
  const rows = asStringList(value, 8)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item && item.toLowerCase() !== mainQuery.toLowerCase());
  return Array.from(new Set(rows)).slice(0, 6);
}

function normalizeSlotId(value: unknown, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeEvidenceSlotExpansion(value: unknown, fallback: EvidenceSlotExpansion): EvidenceSlotExpansion {
  const normalized = String(value || "").trim();
  if (normalized === "normal" || normalized === "wide_local" || normalized === "minimal_covering_range") return normalized;
  return fallback;
}

function normalizeEvidenceSlots(value: unknown): EvidenceSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: EvidenceSlot[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = asRecord(item);
    const id = normalizeSlotId(row.id, `slot_${index + 1}`);
    if (seen.has(id)) continue;
    const title = String(row.title || id).replace(/\s+/g, " ").trim();
    const queries = asStringList(row.queries, 6);
    const mustCover = asStringList(row.mustCover, 8);
    if (!title || (!queries.length && !mustCover.length)) continue;
    seen.add(id);
    slots.push({
      id,
      title,
      required: row.required === undefined ? true : Boolean(row.required),
      queries: queries.length ? queries : [title],
      mustCover,
      minGroups: Math.max(0, Math.min(4, asOptionalInt(row.minGroups) ?? 1)),
      maxGroups: Math.max(1, Math.min(4, asOptionalInt(row.maxGroups) ?? SLOT_DEFAULT_MAX_GROUPS)),
      expansion: normalizeEvidenceSlotExpansion(row.expansion, mustCover.length >= 2 ? "minimal_covering_range" : "normal"),
      role:
        row.role === "preparation" ||
        row.role === "decisive" ||
        row.role === "row" ||
        row.role === "clue" ||
        row.role === "context"
          ? row.role
          : undefined,
    });
    if (slots.length >= 12) break;
  }
  return slots;
}

function createEvidenceSlot(params: {
  id: string;
  title: string;
  queries: string[];
  mustCover: string[];
  required?: boolean;
  minGroups?: number;
  maxGroups?: number;
  expansion?: EvidenceSlotExpansion;
  role?: EvidenceSlot["role"];
}): EvidenceSlot {
  return {
    id: params.id,
    title: params.title,
    required: params.required ?? true,
    queries: params.queries,
    mustCover: params.mustCover,
    minGroups: params.minGroups ?? 1,
    maxGroups: params.maxGroups ?? SLOT_DEFAULT_MAX_GROUPS,
    expansion: params.expansion ?? (params.mustCover.length >= 2 ? "minimal_covering_range" : "normal"),
    role: params.role,
  };
}

function inferAnswerMode(question: string): ChatAnswerMode {
  const normalized = String(question || "").trim().toLowerCase();
  if (/(кто пострадал|пострадавш|последовательность нападен|восстанови точную последовательность нападен|при каких обстоятельствах)/i.test(normalized)) {
    return "table_sequence";
  }
  if (/(разрозненн.*признак|улики.*указыва|пауки.*труб.*петух|труб.*петух.*окамен)/i.test(normalized)) {
    return "clue_synthesis";
  }
  if (/(подводит к выводу|разоблачен|разоблачени|героическ.*истори.*лож|образ.*расходит.*реальн)/i.test(normalized)) {
    return "progressive_reveal";
  }
  if (/(сравни|отлича|что общего|с одной стороны|с другой стороны)/i.test(normalized)) return "comparison";
  if (/(цепоч|последовательност|хронолог|как.*приводит|шаг за шагом|постепенно)/i.test(normalized)) {
    return "chronology";
  }
  if (/(почему|зачем|каким образом|как работает|на каких уровнях|раскрой|объясни)/i.test(normalized)) {
    return "explanation";
  }
  if (/(перескажи|кратко|summary|резюме|о чем)/i.test(normalized)) return "summary";
  return "fact";
}

function buildHeuristicEvidenceSlots(params: {
  userQuestion: string;
  answerMode: ChatAnswerMode;
  subqueries?: readonly string[];
}): EvidenceSlot[] {
  const question = String(params.userQuestion || "").toLowerCase();

  if (params.answerMode === "progressive_reveal" && /(локонс|локхарт|гильдер|златопуст)/i.test(question)) {
    return [
      createEvidenceSlot({
        id: "public_image",
        title: "Публичный героический образ и самореклама",
        queries: ["Локхарт знаменитый автор книг самореклама хвастается подвигами"],
        mustCover: ["Локонс", "книг"],
        role: "preparation",
      }),
      createEvidenceSlot({
        id: "early_showmanship",
        title: "Ранняя показуха и урок, построенный вокруг самого себя",
        queries: ["Локхарт тест вопросы про себя урок защиты от темных искусств"],
        mustCover: ["вопрос", "Локонса"],
        role: "preparation",
      }),
      createEvidenceSlot({
        id: "pixies_failure",
        title: "Провал с корнуэльскими пикси",
        queries: ["Локхарт корнуэльские пикси не справился урок"],
        mustCover: ["пикси", "Локонс"],
        role: "preparation",
        expansion: "wide_local",
      }),
      createEvidenceSlot({
        id: "medical_failure",
        title: "Провал с рукой Гарри",
        queries: ["Локхарт рука Гарри убрал кости больничное крыло"],
        mustCover: ["рук", "кости"],
        required: false,
        role: "preparation",
      }),
      createEvidenceSlot({
        id: "cowardice_before_chamber",
        title: "Трусость перед Тайной комнатой",
        queries: ["Локхарт собирает чемоданы убегает Тайная комната"],
        mustCover: ["чемодан", "уехать"],
        role: "preparation",
        expansion: "minimal_covering_range",
      }),
      createEvidenceSlot({
        id: "confession",
        title: "Решающее признание о чужих подвигах и Забвении",
        queries: ["Локхарт признался присваивал чужие подвиги заклинание Забвения стереть память"],
        mustCover: ["подвиги", "Забвения", "память"],
        maxGroups: 3,
        role: "decisive",
        expansion: "minimal_covering_range",
      }),
    ];
  }

  if (params.answerMode === "clue_synthesis") {
    return [
      createEvidenceSlot({
        id: "spiders",
        title: "Пауки",
        queries: ["пауки боятся василиска чудовище Тайной комнаты"],
        mustCover: ["пауки", "василиск"],
        role: "clue",
      }),
      createEvidenceSlot({
        id: "pipes",
        title: "Трубы",
        queries: ["трубы голос стены василиск Тайная комната"],
        mustCover: ["трубы", "голос"],
        role: "clue",
      }),
      createEvidenceSlot({
        id: "roosters",
        title: "Петухи",
        queries: ["петушиное пение гибельно для василиска петухи перебиты"],
        mustCover: ["петуш", "василиск", "гибель"],
        maxGroups: 3,
        role: "clue",
        expansion: "minimal_covering_range",
      }),
      createEvidenceSlot({
        id: "petrification",
        title: "Окаменение вместо смерти",
        queries: ["василиск прямой взгляд отражение не умер окаменел"],
        mustCover: ["взгляд", "отражение"],
        maxGroups: 3,
        role: "clue",
        expansion: "minimal_covering_range",
      }),
    ];
  }

  if (params.answerMode === "table_sequence") {
    return [
      createEvidenceSlot({
        id: "mrs_norris",
        title: "Миссис Норрис",
        queries: ["Миссис Норрис лужа вода отражение василиск"],
        mustCover: ["Норрис", "вода", "отражение"],
        maxGroups: 3,
        role: "row",
        expansion: "minimal_covering_range",
      }),
      createEvidenceSlot({
        id: "colin",
        title: "Колин Криви",
        queries: ["Колин Криви фотоаппарат пленка василиск окаменел"],
        mustCover: ["Колин", "фото", "плен"],
        role: "row",
      }),
      createEvidenceSlot({
        id: "justin_nick",
        title: "Джастин и Почти Безголовый Ник",
        queries: ["Джастин Почти Безголовый Ник василиск сквозь привидение"],
        mustCover: ["Джастин", "Ник", "сквозь"],
        role: "row",
      }),
      createEvidenceSlot({
        id: "hermione_penelope",
        title: "Гермиона и Пенелопа",
        queries: ["Гермиона Пенелопа зеркало отражение василиск"],
        mustCover: ["Гермион", "зеркал", "отраж"],
        role: "row",
      }),
    ];
  }

  const subqueries = (params.subqueries || []).slice(0, 6);
  if (subqueries.length) {
    return subqueries.map((query, index) =>
      createEvidenceSlot({
        id: `subquery_${index + 1}`,
        title: query,
        queries: [query],
        mustCover: [],
        required: index === 0,
        role: "context",
      })
    );
  }

  return [
    createEvidenceSlot({
      id: "main_evidence",
      title: "Основные доказательства для ответа",
      queries: [params.userQuestion],
      mustCover: [],
      required: true,
      minGroups: 2,
      maxGroups: params.answerMode === "fact" ? 2 : 4,
      role: "context",
    }),
  ];
}

export function buildHeuristicChatPreplan(params: {
  userQuestion: string;
  scenesReady: boolean;
}): ChatPreplan {
  const question = String(params.userQuestion || "").replace(/\s+/g, " ").trim();
  const profile = classifyBookChatQuestion(question);
  const answerMode = inferAnswerMode(question);
  if (profile.isLikelySmallTalk || !profile.isBookQuestion) {
    return {
      route: "meta_answer",
      model: "lite",
      complexity: "simple",
      answerMode: "summary",
      retrieval: {
        query: question,
        subqueries: [],
        order: "relevance",
        topK: 0,
        useScenes: false,
        evidenceBudget: "small",
      },
      slots: [],
    };
  }

  const complexity: ChatPreplanComplexity = profile.isComplexBookQuestion
    ? "hard"
    : profile.isSimpleBookQuestion
      ? "simple"
      : "medium";
  const model: ChatModelTier =
    complexity === "hard" ||
    answerMode === "comparison" ||
    answerMode === "chronology" ||
    answerMode === "table_sequence" ||
    answerMode === "clue_synthesis" ||
    answerMode === "progressive_reveal"
      ? "pro"
      : "lite";
  const evidenceBudget: ChatEvidenceBudget = complexity === "hard" ? "large" : complexity === "simple" ? "small" : "medium";
  const order: ChatEvidenceOrder =
    answerMode === "chronology" || answerMode === "table_sequence" || answerMode === "progressive_reveal" ? "chronological" : "relevance";

  const preplan: ChatPreplan = {
    route: "grounded_answer",
    model,
    complexity,
    answerMode,
    retrieval: {
      query: question,
      subqueries: [],
      order,
      topK: complexity === "hard" ? 14 : complexity === "simple" ? 6 : 10,
      useScenes: params.scenesReady,
      evidenceBudget,
    },
    slots: [],
  };
  return {
    ...preplan,
    slots: buildHeuristicEvidenceSlots({
      userQuestion: question,
      answerMode,
      subqueries: preplan.retrieval.subqueries,
    }),
  };
}

function normalizeChatPreplan(value: unknown, fallback: ChatPreplan, scenesReady: boolean): ChatPreplan {
  const row = asRecord(value);
  const retrieval = asRecord(row.retrieval);
  const route = normalizePreplanRoute(row.route, fallback.route);
  const complexity = normalizePreplanComplexity(row.complexity, fallback.complexity);
  const answerMode = normalizeAnswerMode(row.answerMode, fallback.answerMode);
  const budget = normalizeEvidenceBudget(retrieval.evidenceBudget, fallback.retrieval.evidenceBudget);
  const topK = Math.max(0, Math.min(20, asOptionalInt(retrieval.topK) ?? fallback.retrieval.topK));
  const query = String(retrieval.query || fallback.retrieval.query || "").replace(/\s+/g, " ").trim();
  const subqueries = normalizeSubqueries(retrieval.subqueries, query);
  const slotsFromPlanner = normalizeEvidenceSlots(row.slots);
  let model = normalizePreplanModel(row.model, fallback.model);
  if (
    complexity === "hard" ||
    answerMode === "comparison" ||
    answerMode === "chronology" ||
    answerMode === "table_sequence" ||
    answerMode === "clue_synthesis" ||
    answerMode === "progressive_reveal" ||
    subqueries.length >= 3
  ) {
    model = "pro";
  }
  const finalRetrieval = {
    query: query || fallback.retrieval.query,
    subqueries,
    order: normalizeEvidenceOrder(retrieval.order, fallback.retrieval.order),
    topK: topK || fallback.retrieval.topK,
    useScenes: Boolean(retrieval.useScenes) && scenesReady,
    evidenceBudget: budget,
  };
  const slots = slotsFromPlanner.length
    ? slotsFromPlanner
    : buildHeuristicEvidenceSlots({
        userQuestion: finalRetrieval.query || fallback.retrieval.query,
        answerMode,
        subqueries,
      });

  return {
    route,
    model,
    complexity,
    answerMode,
    retrieval: finalRetrieval,
    slots,
  };
}

async function getBookRetrievalState(bookId: string): Promise<{
  paragraphEmbeddingsReady: boolean;
  evidenceFragmentsReady: boolean;
  fragmentEmbeddingsReady: boolean;
  scenesReady: boolean;
  sceneEmbeddingsReady: boolean;
  paragraphEmbeddingRows: number;
  evidenceFragmentRows: number;
  fragmentEmbeddingRows: number;
  sceneRows: number;
  sceneEmbeddingRows: number;
}> {
  const [paragraphEmbeddingRows, evidenceFragmentRows, fragmentEmbeddingRows, sceneRows, sceneEmbeddingRows] = await Promise.all([
    prisma.bookParagraphEmbedding.count({
      where: {
        bookId,
        embeddingVersion: PARAGRAPH_EMBEDDING_VERSION,
      },
    }),
    BOOK_EVIDENCE_FRAGMENTS_ENABLED
      ? prisma.bookEvidenceFragment.count({
          where: {
            bookId,
            embeddingVersion: EVIDENCE_FRAGMENT_EMBEDDING_VERSION,
          },
        })
      : Promise.resolve(0),
    BOOK_EVIDENCE_FRAGMENTS_ENABLED
      ? prisma.bookEvidenceFragmentEmbedding.count({
          where: {
            bookId,
            embeddingVersion: EVIDENCE_FRAGMENT_EMBEDDING_VERSION,
          },
        })
      : Promise.resolve(0),
    prisma.bookScene.count({
      where: {
        bookId,
      },
    }),
    prisma.bookSceneEmbedding.count({
      where: {
        bookId,
        embeddingVersion: SCENE_EMBEDDING_VERSION,
      },
    }),
  ]);

  return {
    paragraphEmbeddingsReady: paragraphEmbeddingRows > 0,
    evidenceFragmentsReady: evidenceFragmentRows > 0,
    fragmentEmbeddingsReady: fragmentEmbeddingRows > 0,
    scenesReady: sceneRows > 0,
    sceneEmbeddingsReady: sceneEmbeddingRows > 0,
    paragraphEmbeddingRows,
    evidenceFragmentRows,
    fragmentEmbeddingRows,
    sceneRows,
    sceneEmbeddingRows,
  };
}

async function buildChatPreplan(params: {
  clientConfig: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
    proxySource: string;
  };
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  recentMessages: ChatInputMessage[];
}): Promise<ChatPreplanResult> {
  const startedAt = nowMs();
  const modelByTier = resolveBookChatModelByTier(params.clientConfig.chatModel);
  const retrievalState = await getBookRetrievalState(params.bookId);
  const fallback = buildHeuristicChatPreplan({
    userQuestion: params.userQuestion,
    scenesReady: retrievalState.scenesReady && retrievalState.sceneEmbeddingsReady,
  });

  let preplan = fallback;
  let usage: LanguageModelUsage | undefined;
  let plannerStepRun: ChatLlmStepRun | undefined;

  if (BOOK_CHAT_PLANNER_ENABLED && fallback.route === "grounded_answer" && fallback.complexity !== "simple") {
    const plannerModelId =
      String(process.env.BOOK_CHAT_PLANNER_MODEL || modelByTier.lite || params.clientConfig.chatModel).trim() ||
      params.clientConfig.chatModel;
    const plannerModel = createVertexChatModelFromConfig({
      ...params.clientConfig,
      chatModel: plannerModelId,
    });
    const plannerProviderOptions = createVertexReasoningProviderOptions(plannerModelId);
    const plannerSchema = z.object({
      route: z.enum(["grounded_answer", "structure_answer", "meta_answer"]),
      model: z.enum(["light", "lite", "pro"]),
      complexity: z.enum(["simple", "medium", "hard"]),
      answerMode: z.enum([
        "fact",
        "explanation",
        "comparison",
        "chronology",
        "summary",
        "table_sequence",
        "clue_synthesis",
        "progressive_reveal",
      ]),
      retrieval: z.object({
        query: z.string(),
        subqueries: z.array(z.string()).default([]),
        order: z.enum(["relevance", "chronological"]),
        topK: z.number(),
        useScenes: z.boolean(),
        evidenceBudget: z.enum(["small", "medium", "large"]),
      }),
      slots: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            required: z.boolean().default(true),
            queries: z.array(z.string()).default([]),
            mustCover: z.array(z.string()).default([]),
            minGroups: z.number().default(1),
            maxGroups: z.number().default(2),
            expansion: z.enum(["normal", "wide_local", "minimal_covering_range"]).default("normal"),
            role: z.enum(["preparation", "decisive", "row", "clue", "context"]).optional(),
          })
        )
        .default([]),
    });

    try {
      const plannerStartedAt = nowMs();
      const completion = await withSemaphore(chatCallSemaphore, async () =>
        generateText({
          model: plannerModel,
          temperature: 0,
          system:
            "Ты backend preplan-модуль чата по одной книге. Не отвечай на вопрос. " +
            "Верни только JSON маршрута retrieval и модели ответа. Не используй markdown.",
          prompt: `Книга: ${params.bookTitle}
Вопрос пользователя: ${params.userQuestion}
Последние сообщения:
${params.recentMessages
  .slice(-6)
  .map((message) => `${message.role}: ${clampText(message.content, 500)}`)
  .join("\n")}

Состояние книги:
${JSON.stringify(
  {
    paragraphsReady: true,
    paragraphEmbeddingsReady: retrievalState.paragraphEmbeddingsReady,
    hybridSearchReady: retrievalState.paragraphEmbeddingsReady,
    evidenceFragmentsReady: retrievalState.evidenceFragmentsReady,
    fragmentEmbeddingsReady: retrievalState.fragmentEmbeddingsReady,
    fragmentLexicalIndexReady: retrievalState.evidenceFragmentsReady,
    rerankReady: true,
    scenesReady: retrievalState.scenesReady,
    sceneCardsReady: retrievalState.scenesReady,
    sceneEmbeddingsReady: retrievalState.sceneEmbeddingsReady,
  },
  null,
  2
)}

Правила:
- route="grounded_answer" для вопросов по содержанию книги.
- route="structure_answer" только если пользователь спрашивает карту глав/сцен, до/после, расположение эпизода.
- route="meta_answer" для small-talk или вопросов о самом чате.
- model="pro" для причин, цепочек, сравнений, улик, изменения во времени и вопросов по нескольким сценам.
- model="light" для одного факта или короткого пересказа одного найденного места.
- answerMode="table_sequence", если вопрос просит последовательность пострадавших/событий с полями по каждому.
- answerMode="clue_synthesis", если вопрос просит собрать разрозненные признаки/улики в вывод.
- answerMode="progressive_reveal", если вопрос просит "шаг за шагом" показать, как книга подводит к разоблачению/пониманию.
- subqueries нужны только для medium/hard; делай 2-6 коротких поисковых формулировок.
- slots обязательны для table_sequence, clue_synthesis и progressive_reveal. Slot описывает не запрос, а обязательный смысловой пункт ответа.
- В slot.mustCover укажи только 1-4 конкретных literal anchors: имена, предметы, места, числа, явно названные элементы из вопроса. Не клади туда абстрактные идеи вроде "невиновность", "трусость", "хвастовство", "защита", "логика"; такие идеи оставляй в title/queries.
- Если вопрос просит причинную цепочку появления/передачи объекта, информации или подозрения, добавь отдельный slot про origin/transfer. Если evidence не найдёт origin/transfer, answer model должна формулировать нейтрально.
- Для решающего доказательства ставь role="decisive"; для строк таблицы role="row"; для улик role="clue"; для подготовительных этапов role="preparation".
- expansion="minimal_covering_range", если соседние абзацы могут содержать недостающую связку.
- order="chronological" для цепочек и последовательностей.
- useScenes=true только если scenesReady и sceneEmbeddingsReady.
- topK: simple 4-6, medium 8-10, hard 12-16.
- evidenceBudget: simple small, medium medium, hard large.

Верни JSON строго такого вида:
{"route":"grounded_answer","model":"pro","complexity":"hard","answerMode":"clue_synthesis","retrieval":{"query":"...","subqueries":["..."],"order":"chronological","topK":14,"useScenes":true,"evidenceBudget":"large"},"slots":[{"id":"slot_id","title":"Что нужно закрыть","required":true,"queries":["..."],"mustCover":["anchor1","anchor2"],"minGroups":1,"maxGroups":2,"expansion":"minimal_covering_range","role":"clue"}]}`,
          providerOptions: plannerProviderOptions,
        })
      );
      usage = completion.usage;
      const rawJson = extractJsonObjectFromText(String(completion.text || ""));
      if (rawJson) {
        const parsed = plannerSchema.safeParse(JSON.parse(rawJson));
        if (parsed.success) {
          preplan = normalizeChatPreplan(parsed.data, fallback, retrievalState.scenesReady && retrievalState.sceneEmbeddingsReady);
        }
      }
      if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED) {
        plannerStepRun = {
          step: "planner",
          model: plannerModelId,
          usage,
          latencyMs: nowMs() - plannerStartedAt,
          metadata: {
            route: preplan.route,
            model: preplan.model,
            complexity: preplan.complexity,
            answerMode: preplan.answerMode,
            subqueryCount: preplan.retrieval.subqueries.length,
          },
        };
      }
    } catch {
      preplan = fallback;
    }
  }

  const selectedChatModelId =
    preplan.model === "pro" ? modelByTier.pro || params.clientConfig.chatModel : modelByTier.lite || params.clientConfig.chatModel;

  return {
    preplan,
    selectedChatModelId,
    usage,
    plannerStepRun,
    toolRun: {
      tool: "preplan",
      args: {
        bookId: params.bookId,
        questionLengthChars: params.userQuestion.length,
      },
      resultMeta: {
        totalMs: Math.round(nowMs() - startedAt),
        route: preplan.route,
        model: preplan.model,
        selectedChatModelId,
        complexity: preplan.complexity,
        answerMode: preplan.answerMode,
        subqueryCount: preplan.retrieval.subqueries.length,
        slotCount: preplan.slots.length,
        retrieval: preplan.retrieval,
        slots: preplan.slots,
        retrievalState,
      },
    },
  };
}

function resolveChatModelIdForTier(fallbackChatModel: string, tier: ChatModelTier): string {
  const modelByTier = resolveBookChatModelByTier(fallbackChatModel);
  return tier === "pro" ? modelByTier.pro || fallbackChatModel : modelByTier.lite || fallbackChatModel;
}

export function decideCompiledAnswerRuntime(params: {
  fallbackChatModel: string;
  preplan: ChatPreplan;
  evidencePack: EvidencePack;
}): CompiledAnswerRuntime {
  const blockingRequiredSlots = params.evidencePack.slots.filter(
    (slot) => slot.required && (slot.coverage === "low" || slot.coverage === "missing")
  );
  const missingLiteralRequiredSlots = params.evidencePack.slots.filter(
    (slot) => slot.required && slot.missingAnchors.some(isRepairWorthyAnchor)
  );
  const slotsNeedingRepair = Array.from(new Set([...blockingRequiredSlots, ...missingLiteralRequiredSlots]));
  const slotsWithoutGroups = slotsNeedingRepair.filter((slot) => !slot.groups.length || slot.coverage === "missing");
  const hardQuestion = params.preplan.complexity === "hard";
  const multiPart = [
    "table_sequence",
    "clue_synthesis",
    "progressive_reveal",
    "comparison",
    "chronology",
  ].includes(params.preplan.answerMode);
  const reasons: string[] = [];
  if (blockingRequiredSlots.length) reasons.push("low_or_missing_required_evidence");
  if (missingLiteralRequiredSlots.length) reasons.push("missing_literal_anchor");
  if (hardQuestion) reasons.push("hard_question");
  if (multiPart) reasons.push("multipart_answer_mode");

  const shouldRepair =
    params.preplan.route === "grounded_answer" &&
    params.preplan.complexity !== "simple" &&
    slotsNeedingRepair.length > 0;
  const complexAnswerNeedsSearchRepair =
    params.preplan.answerMode === "chronology" ||
    params.preplan.answerMode === "progressive_reveal" ||
    params.preplan.answerMode === "comparison" ||
    params.preplan.answerMode === "clue_synthesis";
  const decisiveSlotNeedsSearchRepair = slotsNeedingRepair.some((slot) => slot.role === "decisive");
  const lowCoverageNeedsSearchRepair = blockingRequiredSlots.length > 0;
  const needsSearchRepair =
    shouldRepair &&
    (slotsWithoutGroups.length > 0 ||
      lowCoverageNeedsSearchRepair ||
      decisiveSlotNeedsSearchRepair ||
      complexAnswerNeedsSearchRepair);
  const repairTools: CompiledAnswerRepairToolName[] = shouldRepair
    ? needsSearchRepair
      ? ["search_evidence", "read_passages"]
      : ["read_passages"]
    : [];
  const hardModeNeedsPro =
    params.preplan.answerMode === "comparison" ||
    params.preplan.answerMode === "progressive_reveal" ||
    params.preplan.answerMode === "chronology";
  const model: ChatModelTier =
    params.preplan.route !== "grounded_answer" || params.preplan.complexity === "simple"
      ? "lite"
      : needsSearchRepair
        ? "pro"
        : hardQuestion && hardModeNeedsPro
          ? "pro"
          : params.preplan.complexity === "medium"
            ? "lite"
            : params.preplan.model === "pro" && !shouldRepair
              ? "lite"
              : params.preplan.model;
  const maxToolCalls = shouldRepair ? (needsSearchRepair ? (hardQuestion ? 2 : 1) : 1) : 0;
  const selectedTools = [
    ...COMPILED_EVIDENCE_SELECTED_TOOLS,
    ...repairTools.map((name) => `repair_${name}`),
  ];

  return {
    model,
    selectedChatModelId: resolveChatModelIdForTier(params.fallbackChatModel, model),
    repairTools,
    maxToolCalls,
    reasons: shouldRepair ? reasons : ["pack_only"],
    toolConfigKey: shouldRepair ? COMPILED_EVIDENCE_REPAIR_TOOL_CONFIG_KEY : COMPILED_EVIDENCE_TOOL_CONFIG_KEY,
    selectedTools,
  };
}

function createPlannerToolPolicy(enabledTools: readonly BookChatToolName[], toolPolicy: ChatToolPolicy) {
  if (!enabledTools.length) return undefined;

  return ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber >= MAX_AUTONOMOUS_TOOL_STEPS) {
      return {
        toolChoice: "none" as const,
      };
    }

    return {
      toolChoice: stepNumber === 0 && toolPolicy === "required" ? ("required" as const) : ("auto" as const),
    };
  };
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
  rerank: VertexRerankMeta;
  embeddingMs: number;
  semanticMs: number;
  lexicalMs: number;
  rerankMs: number;
  mergeMs: number;
  totalMs: number;
}> {
  const startedAt = nowMs();
  const context = await ensureBookSearchContext(params.bookId, params.context);
  const safeTopK = Math.max(1, Math.min(MAX_SEARCH_RESULTS, params.topK));
  const candidateTopK = computeRerankCandidateTopK(safeTopK, MAX_LEXICAL_SEARCH_RESULTS);
  const lexicalProbeTopK = Math.max(
    HYBRID_LEXICAL_PROBE_MIN_TOP_K,
    Math.min(MAX_LEXICAL_SEARCH_RESULTS, candidateTopK * HYBRID_LEXICAL_PROBE_FACTOR)
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
      topK: candidateTopK,
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
  const semanticTop = semanticScored.slice(0, candidateTopK);
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
    .slice(0, candidateTopK);
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
  const combinedCandidates = candidateSceneIds
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
    });
  const reranked = await rerankSearchCandidates({
    client: params.client,
    query: params.query,
    candidates: combinedCandidates,
    topK: safeTopK,
    toRecord: (scene) => ({
      id: scene.sceneId,
      title: `Глава ${scene.chapterOrderIndex}: ${scene.chapterTitle}. Сцена ${scene.sceneIndex}`,
      content: [
        scene.sceneCard,
        scene.sceneSummary,
        scene.excerptText,
        scene.participants.length ? `Участники: ${scene.participants.join(", ")}` : "",
        scene.eventLabels.length ? `События: ${scene.eventLabels.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
    applyScore: (scene, score) => ({
      ...scene,
      score: Number(score.toFixed(6)),
      rerankScore: Number(score.toFixed(6)),
    }),
  });
  const mergeMs = nowMs() - mergeStartedAt;

  return {
    hits: reranked.hits,
    embeddingInputTokens: Number(queryEmbedding.usage.input_tokens || 0),
    embeddingRows: semanticEmbeddingRows,
    lexicalParagraphHits,
    lexicalSceneCandidates,
    semanticConfidence: Number(semanticConfidence.toFixed(6)),
    hybridMode: "hybrid",
    sceneEmbeddingCacheHit,
    lexicalCacheHit: lexicalData.lexicalCacheHit,
    rerank: reranked.meta,
    embeddingMs,
    semanticMs,
    lexicalMs: lexicalData.lexicalMs,
    rerankMs: reranked.meta.latencyMs,
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

async function getAutoExpandedParagraphSlices(params: {
  bookId: string;
  plans: AutoExpandedParagraphSlicePlan[];
}): Promise<ParagraphSliceResult[]> {
  const slices: ParagraphSliceResult[] = [];
  for (const plan of params.plans.slice(0, AUTO_CONTEXT_MAX_SLICES_PER_SEARCH)) {
    const slice = await getParagraphSliceTool({
      bookId: params.bookId,
      chapterId: plan.chapterId,
      paragraphStart: plan.paragraphStart,
      paragraphEnd: plan.paragraphEnd,
    });
    if (!slice) continue;
    if (slice.paragraphStart === slice.paragraphEnd) continue;
    slices.push(slice);
  }
  return slices;
}

function buildAutoExpandedToolMeta(params: {
  plans: AutoExpandedParagraphSlicePlan[];
  slices: ParagraphSliceResult[];
}) {
  const firstSlice = params.slices[0] ?? null;
  return {
    autoExpandedSliceCount: params.slices.length,
    autoExpandedParagraphCount: params.slices.reduce(
      (sum, slice) => sum + Math.max(0, slice.paragraphEnd - slice.paragraphStart + 1),
      0
    ),
    autoExpandedReason: params.slices.length > 0 ? "clustered_hits" : "none",
    autoExpandedChapterOrderIndex: firstSlice?.chapterOrderIndex ?? params.plans[0]?.chapterOrderIndex ?? null,
    autoExpandedParagraphStart: firstSlice?.paragraphStart ?? params.plans[0]?.paragraphStart ?? null,
    autoExpandedParagraphEnd: firstSlice?.paragraphEnd ?? params.plans[0]?.paragraphEnd ?? null,
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

async function searchEvidenceFragmentsLexical(params: {
  query: string;
  topK: number;
  corpus: LexicalSearchCorpus;
}): Promise<{
  hits: EvidenceFragmentSearchHit[];
  queryTerms: string[];
}> {
  const queryNormalized = normalizeLexicalSearchQuery(params.query);
  const queryTerms = tokenizeLexicalSearchQuery(queryNormalized);
  if (!queryNormalized || !queryTerms.length || !params.corpus.evidenceFragments.length) {
    return {
      hits: [],
      queryTerms,
    };
  }

  const queryNgrams = buildCharNgramSet(queryNormalized, LEXICAL_CHAR_NGRAM_SIZE);
  const documentCount = params.corpus.evidenceFragments.length;
  const averageDocumentLength =
    documentCount > 0
      ? params.corpus.evidenceFragments.reduce((sum, fragment) => sum + fragment.termCount, 0) / documentCount
      : 0;
  const documentFrequencyByTerm = new Map<string, number>();
  for (const fragment of params.corpus.evidenceFragments) {
    for (const term of fragment.uniqueTerms) {
      documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) || 0) + 1);
    }
  }

  const rows: EvidenceFragmentSearchHit[] = [];
  for (const fragment of params.corpus.evidenceFragments) {
    const bm25Score = computeBm25Score({
      queryTerms,
      documentCount,
      averageDocumentLength,
      documentLength: fragment.termCount,
      documentTermFrequency: fragment.termFrequency,
      documentFrequencyByTerm,
    });
    const matchedTerms: string[] = [];
    let exactMatchCount = 0;
    let fuzzyMatchScore = 0;
    for (const term of queryTerms) {
      if ((fragment.termFrequency.get(term) || 0) > 0) {
        matchedTerms.push(term);
        exactMatchCount += 1;
        continue;
      }

      const fuzzy = findBestFuzzyTokenMatch(term, fragment.uniqueTerms);
      if (fuzzy >= 0.72) {
        matchedTerms.push(term);
        fuzzyMatchScore += fuzzy;
      }
    }
    const exactPhraseBoost = queryNormalized.length >= 6 && fragment.normalized.includes(queryNormalized) ? 1 : 0;
    const ngramSimilarity = diceCoefficient(queryNgrams, buildCharNgramSet(fragment.normalized, LEXICAL_CHAR_NGRAM_SIZE));
    const combinedTermSignal = exactMatchCount + fuzzyMatchScore * 0.9;
    const coverageScore = queryTerms.length > 0 ? combinedTermSignal / queryTerms.length : 0;
    const minimumSignal =
      queryTerms.length >= 6 ? 2.3 : queryTerms.length >= 4 ? 1.9 : queryTerms.length >= 3 ? 1.4 : 0.8;
    if (combinedTermSignal < minimumSignal && exactPhraseBoost <= 0) continue;
    const score =
      bm25Score * (0.4 + coverageScore) + exactPhraseBoost + coverageScore * 4 + fuzzyMatchScore * 1.2 + ngramSimilarity * 0.6;
    if (score <= 0) continue;
    rows.push({
      id: fragment.id,
      chapterId: fragment.chapterId,
      chapterOrderIndex: fragment.chapterOrderIndex,
      chapterTitle: fragment.chapterTitle,
      sceneId: fragment.sceneId,
      sceneIndex: fragment.sceneIndex,
      paragraphStart: fragment.paragraphStart,
      paragraphEnd: fragment.paragraphEnd,
      score: Number(score.toFixed(6)),
      semanticRank: null,
      lexicalRank: null,
      matchedTerms,
      text: fragment.text,
    });
  }

  return {
    hits: rows
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
        return left.paragraphStart - right.paragraphStart;
      })
      .slice(0, Math.max(1, Math.min(EVIDENCE_FRAGMENT_MAX_RESULTS, params.topK))),
    queryTerms,
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
	  evidenceFragmentHits: EvidenceFragmentSearchHit[];
	  embeddingRows: number;
	  fragmentEmbeddingRows: number;
	  embeddingInputTokens: number;
	  lexicalParagraphHits: number;
	  lexicalFragmentHits: number;
	  semanticConfidence: number;
  queryNormalized: string;
  queryTerms: string[];
  autoExpandedSlicePlans: AutoExpandedParagraphSlicePlan[];
  paragraphEmbeddingCacheHit: boolean;
  lexicalCacheHit: boolean;
  rerank: VertexRerankMeta;
  embeddingMs: number;
  semanticMs: number;
  lexicalMs: number;
  textFetchMs: number;
  rerankMs: number;
  mergeMs: number;
  totalMs: number;
}> {
  const startedAt = nowMs();
  const context = await ensureBookSearchContext(params.bookId, params.context);
  const safeTopK = Math.max(1, Math.min(MAX_HYBRID_PARAGRAPH_RESULTS, Number(params.topK || DEFAULT_HYBRID_PARAGRAPH_TOP_K)));
  const candidateTopK = computeRerankCandidateTopK(safeTopK, MAX_HYBRID_PARAGRAPH_RESULTS);
  const lexicalProbeTopK = Math.max(
    HYBRID_PARAGRAPH_LEXICAL_PROBE_MIN_TOP_K,
    Math.min(MAX_LEXICAL_SEARCH_RESULTS, candidateTopK * HYBRID_PARAGRAPH_LEXICAL_PROBE_FACTOR)
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

	  const [semanticSearch, fragmentSemanticSearch, nextLexicalData] = await Promise.all([
	    searchParagraphsSemanticSql({
	      bookId: params.bookId,
	      queryVector,
	      topK: candidateTopK,
	    }),
	    BOOK_EVIDENCE_FRAGMENTS_ENABLED
	      ? searchEvidenceFragmentsSemanticSql({
	          bookId: params.bookId,
	          queryVector,
	          topK: Math.min(EVIDENCE_FRAGMENT_MAX_RESULTS, candidateTopK),
	        })
	      : Promise.resolve({ rows: [], embeddingRows: 0 } satisfies Awaited<ReturnType<typeof searchEvidenceFragmentsSemanticSql>>),
	    lexicalPromise,
	  ]);
  lexicalData = nextLexicalData;
  semanticScored = semanticSearch.rows;
  semanticEmbeddingRows = semanticSearch.embeddingRows;
  const semanticMs = nowMs() - semanticStartedAt;

  const semanticConfidence = computeSemanticSearchConfidence(semanticScored.map((item) => item.semanticScore));
  const semanticTop = semanticScored.slice(0, candidateTopK);
  const semanticRankByRef = new Map<string, number>();
  for (let index = 0; index < semanticTop.length; index += 1) {
    const row = semanticTop[index]!;
    semanticRankByRef.set(row.refKey, index + 1);
  }

	  const lexical = lexicalData.lexical;
	  const lexicalParagraphHits = lexical.hits.length;
	  const lexicalFragments = BOOK_EVIDENCE_FRAGMENTS_ENABLED
	    ? await searchEvidenceFragmentsLexical({
	        query: params.query,
	        topK: Math.min(EVIDENCE_FRAGMENT_MAX_RESULTS, lexicalProbeTopK),
	        corpus: lexicalData.lexicalCorpus,
	      })
	    : { hits: [], queryTerms: lexical.queryTerms };
	  const lexicalFragmentHits = lexicalFragments.hits.length;
	  const lexicalTop = lexical.hits.slice(0, candidateTopK);
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
  const combinedCandidates = candidateRefs
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
    });
	  const reranked = await rerankSearchCandidates({
    client: params.client,
    query: params.query,
    candidates: combinedCandidates,
    topK: safeTopK,
    toRecord: (hit) => ({
      id: makeParagraphRefKey(hit.chapterId, hit.paragraphIndex),
      title: `Глава ${hit.chapterOrderIndex}: ${hit.chapterTitle}. Абзац ${hit.paragraphIndex}`,
      content: hit.text,
    }),
    applyScore: (hit, score) => ({
      ...hit,
      score: Number(score.toFixed(6)),
      rerankScore: Number(score.toFixed(6)),
    }),
  });
	  const mergeMs = nowMs() - mergeStartedAt;
	  const semanticFragmentTop = fragmentSemanticSearch.rows.slice(0, EVIDENCE_FRAGMENT_MAX_RESULTS);
	  const semanticFragmentRankById = new Map<string, number>();
	  for (let index = 0; index < semanticFragmentTop.length; index += 1) {
	    semanticFragmentRankById.set(semanticFragmentTop[index]!.id, index + 1);
	  }
	  const lexicalFragmentTop = lexicalFragments.hits.slice(0, EVIDENCE_FRAGMENT_MAX_RESULTS);
	  const lexicalFragmentRankById = new Map<string, number>();
	  for (let index = 0; index < lexicalFragmentTop.length; index += 1) {
	    lexicalFragmentRankById.set(lexicalFragmentTop[index]!.id, index + 1);
	  }
	  const fragmentById = new Map<string, EvidenceFragmentSearchHit>();
	  for (const fragment of semanticFragmentTop) fragmentById.set(fragment.id, fragment);
	  for (const fragment of lexicalFragmentTop) {
	    const existing = fragmentById.get(fragment.id);
	    fragmentById.set(fragment.id, existing ? { ...existing, matchedTerms: fragment.matchedTerms, text: existing.text || fragment.text } : fragment);
	  }
	  const evidenceFragmentHits = Array.from(new Set([...semanticFragmentTop.map((item) => item.id), ...lexicalFragmentTop.map((item) => item.id)]))
	    .map((id) => {
	      const fragment = fragmentById.get(id);
	      if (!fragment) return null;
	      const semanticRank = semanticFragmentRankById.get(id) ?? null;
	      const lexicalRank = lexicalFragmentRankById.get(id) ?? null;
	      const semanticRrf = semanticRank ? 1 / (HYBRID_RRF_K + semanticRank) : 0;
	      const lexicalRrf = lexicalRank ? 1 / (HYBRID_RRF_K + lexicalRank) : 0;
	      return {
	        ...fragment,
	        score: Number((semanticRrf * 0.55 + lexicalRrf * 0.45).toFixed(6)),
	        semanticRank,
	        lexicalRank,
	      } satisfies EvidenceFragmentSearchHit;
	    })
	    .filter((item): item is EvidenceFragmentSearchHit => Boolean(item))
	    .sort((left, right) => {
	      if (right.score !== left.score) return right.score - left.score;
	      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
	      return left.paragraphStart - right.paragraphStart;
	    })
	    .slice(0, EVIDENCE_FRAGMENT_MAX_RESULTS);
	  const autoExpandedSlicePlans = buildAutoExpandedParagraphSlicePlans({
	    hits: reranked.hits.slice(0, safeTopK),
	    sceneBoundsByRef: lexicalData.lexicalCorpus.sceneBoundsByRef,
  });

	  return {
	    hits: reranked.hits,
	    evidenceFragmentHits,
	    embeddingRows: semanticEmbeddingRows,
	    fragmentEmbeddingRows: fragmentSemanticSearch.embeddingRows,
	    embeddingInputTokens: Number(queryEmbedding.usage.input_tokens || 0),
	    lexicalParagraphHits,
	    lexicalFragmentHits,
    semanticConfidence: Number(semanticConfidence.toFixed(6)),
    queryNormalized: lexical.queryNormalized,
    queryTerms: lexical.queryTerms,
    autoExpandedSlicePlans,
    paragraphEmbeddingCacheHit,
    lexicalCacheHit: lexicalData.lexicalCacheHit,
    rerank: reranked.meta,
    embeddingMs,
    semanticMs,
    lexicalMs: lexicalData.lexicalMs,
    textFetchMs,
    rerankMs: reranked.meta.latencyMs,
    mergeMs,
    totalMs: nowMs() - startedAt,
  };
}

function makeEvidenceGroupId(group: Pick<EvidenceGroup, "chapterOrderIndex" | "paragraphStart" | "paragraphEnd">) {
  return `ev_ch${Math.max(0, group.chapterOrderIndex)}_p${Math.max(0, group.paragraphStart)}_${Math.max(
    0,
    group.paragraphEnd
  )}`;
}

function computeEvidenceConfidence(score: number, matchedBy: readonly EvidenceMatchedBy[]): EvidenceConfidence {
  if (matchedBy.includes("rerank") && score >= 0.75) return "high";
  if (matchedBy.includes("semantic") && matchedBy.includes("lexical")) return "high";
  if (score >= 0.55 || matchedBy.length >= 2) return "medium";
  return "low";
}

function normalizeAnchorText(value: unknown): string {
  return normalizeLexicalSearchText(String(value || ""));
}

function textCoversAnchor(text: string, anchor: string): boolean {
  const normalizedText = normalizeAnchorText(text);
  const normalizedAnchor = normalizeAnchorText(anchor);
  if (!normalizedAnchor) return true;
  if (normalizedText.includes(normalizedAnchor)) return true;
  const terms = tokenizeLexicalSearchQuery(normalizedAnchor).filter((term) => term.length >= 3);
  if (!terms.length) return true;
  return terms.every((term) => normalizedText.includes(term));
}

function isLikelySemanticAnchor(anchor: string): boolean {
  const normalizedAnchor = normalizeAnchorText(anchor);
  if (!normalizedAnchor) return true;
  const terms = tokenizeLexicalSearchQuery(normalizedAnchor).filter((term) => term.length >= 3);
  if (!terms.length) return true;

  const raw = String(anchor || "").trim();
  const hasDigit = /\d/u.test(raw);
  const hasProperNameSignal = /(?:^|\s|["'«„])\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?/u.test(raw);
  if (hasDigit || hasProperNameSignal) return false;

  if (
    terms.some((term) =>
      SEMANTIC_ANCHOR_REPAIR_STOP_WORDS.some((stopWord) => term.includes(stopWord) || stopWord.includes(term))
    )
  ) {
    return true;
  }

  // Multi-word lowercase anchors are usually planner abstractions ("смертельная опасность"),
  // while one-token anchors more often name a concrete object/place from the question/evidence.
  return terms.length > 2;
}

function isRepairWorthyAnchor(anchor: string): boolean {
  return !isLikelySemanticAnchor(anchor);
}

function computeMissingSlotAnchors(slot: EvidenceSlot, groups: readonly EvidenceGroup[]): string[] {
  if (!slot.mustCover.length) return [];
  const text = groups.map((group) => group.text).join("\n\n");
  return slot.mustCover.filter((anchor) => isRepairWorthyAnchor(anchor) && !textCoversAnchor(text, anchor));
}

function computeSlotCoverage(slot: EvidenceSlot, groups: readonly EvidenceGroup[]): SlotEvidence["coverage"] {
  if (!groups.length) return "missing";
  const missing = computeMissingSlotAnchors(slot, groups);
  if (!missing.length && groups.length >= Math.max(1, slot.minGroups)) return "high";
  if (missing.length < slot.mustCover.length) return "medium";
  return slot.required ? "low" : "medium";
}

function clampEvidenceRange(params: {
  paragraphIndex: number;
  sceneBounds?: AutoContextSceneBounds;
}): { start: number; end: number } {
  let start = Math.max(1, params.paragraphIndex - EVIDENCE_GROUP_EXPAND_BEFORE);
  let end = Math.max(start, params.paragraphIndex + EVIDENCE_GROUP_EXPAND_AFTER);

  if (params.sceneBounds) {
    start = Math.max(start, params.sceneBounds.paragraphStart);
    end = Math.min(end, params.sceneBounds.paragraphEnd);
  }

  if (end - start + 1 > EVIDENCE_GROUP_MAX_PARAGRAPHS) {
    const half = Math.floor(EVIDENCE_GROUP_MAX_PARAGRAPHS / 2);
    start = Math.max(1, params.paragraphIndex - half);
    end = start + EVIDENCE_GROUP_MAX_PARAGRAPHS - 1;
    if (params.sceneBounds) {
      start = Math.max(start, params.sceneBounds.paragraphStart);
      end = Math.min(end, params.sceneBounds.paragraphEnd);
    }
  }

  return {
    start,
    end: Math.max(start, end),
  };
}

function splitEvidenceGroupIfNeeded(group: EvidenceGroup): EvidenceGroup[] {
  const width = group.paragraphEnd - group.paragraphStart + 1;
  if (width <= EVIDENCE_GROUP_MAX_PARAGRAPHS) return [group];

  const rows: EvidenceGroup[] = [];
  for (let start = group.paragraphStart; start <= group.paragraphEnd; start += EVIDENCE_GROUP_MAX_PARAGRAPHS) {
    const end = Math.min(group.paragraphEnd, start + EVIDENCE_GROUP_MAX_PARAGRAPHS - 1);
    const paragraphs = group.paragraphs.filter(
      (paragraph) => paragraph.paragraphIndex >= start && paragraph.paragraphIndex <= end
    );
    if (!paragraphs.length) continue;
    rows.push({
      ...group,
      id: makeEvidenceGroupId({
        chapterOrderIndex: group.chapterOrderIndex,
        paragraphStart: start,
        paragraphEnd: end,
      }),
      paragraphStart: start,
      paragraphEnd: end,
      paragraphs,
      text: paragraphs.map((paragraph) => `[p.${paragraph.paragraphIndex}] ${paragraph.text}`).join("\n\n"),
    });
  }
  return rows;
}

function mergeEvidenceCandidateGroups(groups: EvidenceGroup[]): EvidenceGroup[] {
  const sorted = [...groups].sort((left, right) => {
    if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
    if (left.paragraphStart !== right.paragraphStart) return left.paragraphStart - right.paragraphStart;
    return right.score - left.score;
  });

  const merged: EvidenceGroup[] = [];
  for (const group of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.chapterId === group.chapterId &&
      previous.paragraphEnd + 1 >= group.paragraphStart &&
      previous.paragraphEnd - previous.paragraphStart + 1 < EVIDENCE_GROUP_MAX_PARAGRAPHS
    ) {
      const paragraphByIndex = new Map<number, EvidenceParagraph>();
      for (const paragraph of previous.paragraphs) paragraphByIndex.set(paragraph.paragraphIndex, paragraph);
      for (const paragraph of group.paragraphs) paragraphByIndex.set(paragraph.paragraphIndex, paragraph);
      const paragraphs = Array.from(paragraphByIndex.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
      const start = Math.min(previous.paragraphStart, group.paragraphStart);
      const end = Math.max(previous.paragraphEnd, group.paragraphEnd);
      if (end - start + 1 <= EVIDENCE_GROUP_MAX_PARAGRAPHS) {
        previous.paragraphStart = start;
        previous.paragraphEnd = end;
        previous.paragraphs = paragraphs;
        previous.text = paragraphs.map((paragraph) => `[p.${paragraph.paragraphIndex}] ${paragraph.text}`).join("\n\n");
        previous.score = Math.max(previous.score, group.score);
        previous.matchedBy = Array.from(new Set([...previous.matchedBy, ...group.matchedBy]));
        previous.confidence = computeEvidenceConfidence(previous.score, previous.matchedBy);
        if (!previous.matchedSubquery && group.matchedSubquery) previous.matchedSubquery = group.matchedSubquery;
        continue;
      }
    }
    merged.push({ ...group, paragraphs: [...group.paragraphs], matchedBy: [...group.matchedBy] });
  }

  return merged.flatMap(splitEvidenceGroupIfNeeded);
}

function buildEvidenceGroupsFromFragments(params: {
  fragments: EvidenceFragmentSearchHit[];
  matchedSubquery: string;
  slotId?: string;
  lexicalCorpus: LexicalSearchCorpus;
}): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const seen = new Set<string>();
  for (const fragment of params.fragments) {
    const paragraphs = fragment.text
      .split(/\n{2,}/gu)
      .map((text, index) => ({
        paragraphIndex: fragment.paragraphStart + index,
        text: normalizeText(text),
      }))
      .filter((paragraph) => paragraph.text && paragraph.paragraphIndex <= fragment.paragraphEnd);
    if (!paragraphs.length) continue;
    const key = `${fragment.chapterId}:${fragment.paragraphStart}:${fragment.paragraphEnd}:${params.matchedSubquery}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sceneBounds =
      typeof fragment.sceneIndex === "number" && fragment.sceneIndex > 0
        ? params.lexicalCorpus.sceneBoundsByRef.get(makeSceneRefKey(fragment.chapterId, fragment.sceneIndex))
        : undefined;
    const matchedBy = new Set<EvidenceMatchedBy>(["fragment"]);
    if (fragment.semanticRank) matchedBy.add("semantic");
    if (fragment.lexicalRank) matchedBy.add("lexical");
    if (fragment.sceneId || sceneBounds?.sceneId) matchedBy.add("scene");
    const score = Number((fragment.score + EVIDENCE_FRAGMENT_BOOST).toFixed(6));
    groups.push({
      id: makeEvidenceGroupId({
        chapterOrderIndex: fragment.chapterOrderIndex,
        paragraphStart: fragment.paragraphStart,
        paragraphEnd: fragment.paragraphEnd,
      }),
      chapterId: fragment.chapterId,
      chapterOrderIndex: fragment.chapterOrderIndex,
      chapterTitle: fragment.chapterTitle,
      sceneId: fragment.sceneId || sceneBounds?.sceneId,
      sceneIndex: fragment.sceneIndex || sceneBounds?.sceneIndex || undefined,
      sceneTitle: sceneBounds?.title,
      paragraphStart: fragment.paragraphStart,
      paragraphEnd: fragment.paragraphEnd,
      paragraphs,
      text: paragraphs.map((paragraph) => `[p.${paragraph.paragraphIndex}] ${paragraph.text}`).join("\n\n"),
      score,
      confidence: computeEvidenceConfidence(score, Array.from(matchedBy)),
      matchedBy: Array.from(matchedBy),
      matchedSubquery: params.matchedSubquery,
      slotId: params.slotId,
    });
  }

  return groups;
}

async function buildEvidenceGroupsFromHits(params: {
  bookId: string;
  hits: HybridParagraphSearchHit[];
  matchedSubquery: string;
  lexicalCorpus: LexicalSearchCorpus;
  sceneByRef: Map<string, SearchSceneResult>;
  slotId?: string;
}): Promise<EvidenceGroup[]> {
  const rows: EvidenceGroup[] = [];
  const seen = new Set<string>();

  for (const hit of params.hits) {
    const sceneBounds =
      typeof hit.sceneIndex === "number" && hit.sceneIndex > 0
        ? params.lexicalCorpus.sceneBoundsByRef.get(makeSceneRefKey(hit.chapterId, hit.sceneIndex))
        : undefined;
    const range = clampEvidenceRange({
      paragraphIndex: hit.paragraphIndex,
      sceneBounds,
    });
    const slice = await getParagraphSliceTool({
      bookId: params.bookId,
      chapterId: hit.chapterId,
      paragraphStart: range.start,
      paragraphEnd: range.end,
    });
    if (!slice) continue;

    const sceneHit =
      typeof hit.sceneIndex === "number" && hit.sceneIndex > 0
        ? params.sceneByRef.get(makeSceneRefKey(hit.chapterId, hit.sceneIndex))
        : undefined;
    const matchedBy = new Set<EvidenceMatchedBy>();
    if (hit.semanticRank) matchedBy.add("semantic");
    if (hit.lexicalRank) matchedBy.add("lexical");
    if (sceneHit) matchedBy.add("scene");
    const score = Number((hit.score + (sceneHit ? EVIDENCE_SCENE_BOOST : 0)).toFixed(6));
    const paragraphs = slice.text
      .split(/\n{2,}/gu)
      .map((text, index) => ({
        paragraphIndex: slice.paragraphStart + index,
        text: normalizeText(text),
      }))
      .filter((paragraph) => paragraph.text && paragraph.paragraphIndex <= slice.paragraphEnd);
    if (!paragraphs.length) continue;

    const key = `${slice.chapterId}:${slice.paragraphStart}:${slice.paragraphEnd}:${params.matchedSubquery}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const group: EvidenceGroup = {
      id: makeEvidenceGroupId({
        chapterOrderIndex: slice.chapterOrderIndex,
        paragraphStart: slice.paragraphStart,
        paragraphEnd: slice.paragraphEnd,
      }),
      chapterId: slice.chapterId,
      chapterOrderIndex: slice.chapterOrderIndex,
      chapterTitle: slice.chapterTitle,
      sceneId: sceneHit?.sceneId,
      sceneIndex: hit.sceneIndex || sceneHit?.sceneIndex || undefined,
      sceneTitle: sceneHit?.sceneCard ? clampText(sceneHit.sceneCard, 120) : undefined,
      paragraphStart: slice.paragraphStart,
      paragraphEnd: slice.paragraphEnd,
      paragraphs,
      text: paragraphs.map((paragraph) => `[p.${paragraph.paragraphIndex}] ${paragraph.text}`).join("\n\n"),
      score,
      confidence: computeEvidenceConfidence(score, Array.from(matchedBy)),
      matchedBy: Array.from(matchedBy),
      matchedSubquery: params.matchedSubquery,
      slotId: params.slotId,
    };
    rows.push(group);
  }

  return rows;
}

function createEvidenceGroupFromSlice(params: {
  slice: ParagraphSliceResult;
  matchedSubquery: string;
  slotId?: string;
  score?: number;
  matchedBy?: EvidenceMatchedBy[];
}): EvidenceGroup | null {
  const paragraphs = params.slice.text
    .split(/\n{2,}/gu)
    .map((text, index) => ({
      paragraphIndex: params.slice.paragraphStart + index,
      text: normalizeText(text),
    }))
    .filter((paragraph) => paragraph.text && paragraph.paragraphIndex <= params.slice.paragraphEnd);
  if (!paragraphs.length) return null;
  const matchedBy = params.matchedBy || ["lexical"];
  const score = params.score ?? 0.5;
  return {
    id: makeEvidenceGroupId({
      chapterOrderIndex: params.slice.chapterOrderIndex,
      paragraphStart: params.slice.paragraphStart,
      paragraphEnd: params.slice.paragraphEnd,
    }),
    chapterId: params.slice.chapterId,
    chapterOrderIndex: params.slice.chapterOrderIndex,
    chapterTitle: params.slice.chapterTitle,
    paragraphStart: params.slice.paragraphStart,
    paragraphEnd: params.slice.paragraphEnd,
    paragraphs,
    text: paragraphs.map((paragraph) => `[p.${paragraph.paragraphIndex}] ${paragraph.text}`).join("\n\n"),
    score,
    confidence: computeEvidenceConfidence(score, matchedBy),
    matchedBy,
    matchedSubquery: params.matchedSubquery,
    slotId: params.slotId,
  };
}

async function buildEvidenceGroupsFromSceneWindows(params: {
  bookId: string;
  scenes: SearchSceneResult[];
  matchedSubquery: string;
}): Promise<EvidenceGroup[]> {
  const rows: EvidenceGroup[] = [];
  const seen = new Set<string>();
  const windowSize = EVIDENCE_GROUP_MAX_PARAGRAPHS;
  const step = Math.max(1, windowSize - 1);
  const maxWindowsPerScene = 4;

  for (const scene of params.scenes) {
    const start = Math.max(1, Number(scene.paragraphStart || 1));
    const end = Math.max(start, Number(scene.paragraphEnd || start));
    const starts = new Set<number>();
    if (end - start + 1 <= windowSize) {
      starts.add(start);
    } else {
      for (let cursor = start; cursor <= end; cursor += step) {
        starts.add(cursor);
        if (starts.size >= maxWindowsPerScene) break;
      }
      starts.add(Math.max(start, end - windowSize + 1));
    }

    const orderedStarts = Array.from(starts)
      .filter((paragraphStart) => paragraphStart <= end)
      .sort((left, right) => left - right)
      .slice(0, maxWindowsPerScene);

    for (const paragraphStart of orderedStarts) {
      const paragraphEnd = Math.min(end, paragraphStart + windowSize - 1);
      const key = `${scene.sceneId}:${paragraphStart}:${paragraphEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const slice = await getParagraphSliceTool({
        bookId: params.bookId,
        chapterId: scene.chapterId,
        paragraphStart,
        paragraphEnd,
      });
      if (!slice) continue;

      const group = createEvidenceGroupFromSlice({
        slice,
        matchedSubquery: params.matchedSubquery,
        score: scene.score,
        matchedBy: ["scene"],
      });
      if (!group) continue;

      rows.push({
        ...group,
        sceneId: scene.sceneId,
        sceneIndex: scene.sceneIndex,
        sceneTitle: scene.sceneCard ? clampText(scene.sceneCard, 120) : undefined,
        matchedBy: Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "scene"])),
      });
    }
  }

  return rows;
}

function pickSceneFirstEvidenceGroups(params: {
  groups: EvidenceGroup[];
  topK: number;
  order: ChatEvidenceOrder;
}): EvidenceGroup[] {
  const topK = Math.max(1, Math.min(12, Math.floor(params.topK)));
  const selected: EvidenceGroup[] = [];
  const selectedIds = new Set<string>();
  const perScene = new Map<string, number>();
  const perChapter = new Map<string, number>();
  const sceneLimit = 2;
  const chapterLimit = params.order === "chronological" ? 4 : 3;

  const tryAdd = (group: EvidenceGroup, enforceCaps: boolean) => {
    if (selected.length >= topK || selectedIds.has(group.id)) return;
    const sceneKey = group.sceneId || `${group.chapterId}:${group.sceneIndex || group.paragraphStart}`;
    const chapterKey = group.chapterId;
    if (enforceCaps) {
      if ((perScene.get(sceneKey) || 0) >= sceneLimit) return;
      if ((perChapter.get(chapterKey) || 0) >= chapterLimit) return;
    }
    selected.push(group);
    selectedIds.add(group.id);
    perScene.set(sceneKey, (perScene.get(sceneKey) || 0) + 1);
    perChapter.set(chapterKey, (perChapter.get(chapterKey) || 0) + 1);
  };

  for (const group of params.groups) tryAdd(group, true);
  for (const group of params.groups) tryAdd(group, false);

  if (params.order === "chronological") {
    selected.sort((left, right) =>
      left.chapterOrderIndex === right.chapterOrderIndex
        ? left.paragraphStart - right.paragraphStart
        : left.chapterOrderIndex - right.chapterOrderIndex
    );
  }

  return selected;
}

function findBestSlotCoveringRange(params: {
  slot: EvidenceSlot;
  lexicalCorpus: LexicalSearchCorpus;
  baseGroups: readonly EvidenceGroup[];
}): { chapterId: string; paragraphStart: number; paragraphEnd: number; coveredAnchors: string[] } | null {
  if (!params.slot.mustCover.length) return null;
  const anchors = params.slot.mustCover;
  const maxWidth = params.slot.expansion === "wide_local" ? 8 : SLOT_REPAIR_MAX_SLICE_PARAGRAPHS;
  const docsByChapter = new Map<string, LexicalParagraphDoc[]>();
  for (const doc of params.lexicalCorpus.paragraphDocs) {
    if (!docsByChapter.has(doc.chapterId)) docsByChapter.set(doc.chapterId, []);
    docsByChapter.get(doc.chapterId)!.push(doc);
  }

  const candidateChapterIds = new Set<string>();
  for (const group of params.baseGroups) candidateChapterIds.add(group.chapterId);
  for (const doc of params.lexicalCorpus.paragraphDocs) {
    if (anchors.some((anchor) => textCoversAnchor(doc.text, anchor))) {
      candidateChapterIds.add(doc.chapterId);
    }
  }

  let best:
    | {
        chapterId: string;
        paragraphStart: number;
        paragraphEnd: number;
        coveredAnchors: string[];
        score: number;
        width: number;
      }
    | null = null;

  for (const chapterId of candidateChapterIds) {
    const docs = (docsByChapter.get(chapterId) || []).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
    if (!docs.length) continue;
    const docsByParagraph = new Map(docs.map((doc) => [doc.paragraphIndex, doc]));
    const anchorParagraphs = docs
      .filter((doc) => anchors.some((anchor) => textCoversAnchor(doc.text, anchor)))
      .map((doc) => doc.paragraphIndex);

    for (const anchorParagraph of anchorParagraphs) {
      const minStart = Math.max(1, anchorParagraph - SLOT_REPAIR_LOCAL_WINDOW_PARAGRAPHS);
      const maxEnd = anchorParagraph + SLOT_REPAIR_LOCAL_WINDOW_PARAGRAPHS;
      for (let start = minStart; start <= anchorParagraph; start += 1) {
        const endMax = Math.min(maxEnd, start + maxWidth - 1);
        for (let end = Math.max(anchorParagraph, start); end <= endMax; end += 1) {
          const texts: string[] = [];
          for (let index = start; index <= end; index += 1) {
            const doc = docsByParagraph.get(index);
            if (doc) texts.push(doc.text);
          }
          if (!texts.length) continue;
          const joined = texts.join("\n\n");
          const coveredAnchors = anchors.filter((anchor) => textCoversAnchor(joined, anchor));
          if (!coveredAnchors.length) continue;
          const score = coveredAnchors.length / anchors.length;
          const width = end - start + 1;
          if (
            !best ||
            score > best.score ||
            (score === best.score && width < best.width) ||
            (score === best.score && width === best.width && start < best.paragraphStart)
          ) {
            best = {
              chapterId,
              paragraphStart: start,
              paragraphEnd: end,
              coveredAnchors,
              score,
              width,
            };
          }
        }
      }
    }
  }

  return best;
}

function evidenceGroupDistribution(groups: EvidenceGroup[]) {
  const chapterDistribution: Record<string, number> = {};
  const sceneDistribution: Record<string, number> = {};
  for (const group of groups) {
    const chapterKey = `ch${group.chapterOrderIndex}`;
    chapterDistribution[chapterKey] = (chapterDistribution[chapterKey] || 0) + 1;
    const sceneKey =
      typeof group.sceneIndex === "number" && group.sceneIndex > 0
        ? `ch${group.chapterOrderIndex}:sc${group.sceneIndex}`
        : `ch${group.chapterOrderIndex}:none`;
    sceneDistribution[sceneKey] = (sceneDistribution[sceneKey] || 0) + 1;
  }
  return {
    chapterDistribution,
    sceneDistribution,
  };
}

export function pickEvidenceCoverage(params: {
  groups: EvidenceGroup[];
  preplan: ChatPreplan;
}): EvidenceGroup[] {
  const maxGroups = EVIDENCE_BUDGET_MAX_GROUPS[params.preplan.retrieval.evidenceBudget];
  const maxChars = EVIDENCE_BUDGET_MAX_CHARS[params.preplan.retrieval.evidenceBudget];
  const sceneCap = params.preplan.complexity === "hard" ? 3 : 2;
  const chapterCap = params.preplan.complexity === "hard" ? 4 : 3;
  const broadQuestion = params.preplan.complexity !== "simple";
  const selected: EvidenceGroup[] = [];
  const selectedIds = new Set<string>();
  const chapterCounts = new Map<string, number>();
  const sceneCounts = new Map<string, number>();
  let totalChars = 0;

  const canAdd = (group: EvidenceGroup) => {
    if (selectedIds.has(group.id)) return false;
    if (selected.length >= maxGroups) return false;
    if (totalChars + group.text.length > maxChars && selected.length > 0) return false;
    const chapterKey = group.chapterId;
    const sceneKey = group.sceneId || `${group.chapterId}:${group.sceneIndex || "none"}`;
    if (broadQuestion && (chapterCounts.get(chapterKey) || 0) >= chapterCap) return false;
    if ((sceneCounts.get(sceneKey) || 0) >= sceneCap) return false;
    return true;
  };

  const add = (group: EvidenceGroup) => {
    if (!canAdd(group)) return false;
    selected.push(group);
    selectedIds.add(group.id);
    chapterCounts.set(group.chapterId, (chapterCounts.get(group.chapterId) || 0) + 1);
    const sceneKey = group.sceneId || `${group.chapterId}:${group.sceneIndex || "none"}`;
    sceneCounts.set(sceneKey, (sceneCounts.get(sceneKey) || 0) + 1);
    totalChars += group.text.length;
    return true;
  };

  for (const subquery of params.preplan.retrieval.subqueries) {
    const best = params.groups.find((group) => group.matchedSubquery === subquery);
    if (best) add(best);
  }

  for (const group of params.groups) {
    add(group);
  }

  if (params.preplan.retrieval.order === "chronological") {
    selected.sort((left, right) => {
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      return left.paragraphStart - right.paragraphStart;
    });
  }

  return selected;
}

function buildEvidenceBlocks(preplan: ChatPreplan, groups: EvidenceGroup[]): EvidencePack["blocks"] {
  if (!groups.length) return [];
  if (preplan.answerMode !== "comparison" && preplan.retrieval.subqueries.length < 2) {
    return [
      {
        label: "Основные фрагменты",
        groups,
      },
    ];
  }

  const blocks: EvidencePack["blocks"] = [];
  const used = new Set<string>();
  for (const subquery of preplan.retrieval.subqueries) {
    const blockGroups = groups.filter((group) => group.matchedSubquery === subquery);
    for (const group of blockGroups) used.add(group.id);
    if (blockGroups.length) {
      blocks.push({
        label: subquery,
        groups: blockGroups,
      });
    }
  }
  const rest = groups.filter((group) => !used.has(group.id));
  if (rest.length) {
    blocks.push({
      label: "Дополнительные фрагменты",
      groups: rest,
    });
  }
  return blocks;
}

async function retrieveEvidenceForSlot(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  preplan: ChatPreplan;
  slot: EvidenceSlot;
  context: BookSearchContext;
  lexicalCorpus: LexicalSearchCorpus;
}): Promise<{
  slotEvidence: SlotEvidence;
	  toolMeta: {
	    embeddingInputTokens: number;
	    paragraphHitCount: number;
	    fragmentHitCount: number;
	    sceneHitCount: number;
    candidateGroupCount: number;
    paragraphSearchMs: number;
    sceneSearchMs: number;
    rerank: VertexRerankMeta;
    repaired: boolean;
  };
}> {
  const queries = Array.from(new Set([params.slot.title, ...params.slot.queries].map((query) => query.trim()).filter(Boolean))).slice(
    0,
    6
  );
  const sceneByRef = new Map<string, SearchSceneResult>();
	  let embeddingInputTokens = 0;
	  let paragraphHitCount = 0;
	  let fragmentHitCount = 0;
	  let sceneHitCount = 0;
  let paragraphSearchMs = 0;
  let sceneSearchMs = 0;
  const candidateGroups: EvidenceGroup[] = [];
  const perQueryTopK = Math.max(6, Math.min(MAX_HYBRID_PARAGRAPH_RESULTS, params.preplan.retrieval.topK));
  const sceneTopK = Math.max(4, Math.min(MAX_SEARCH_RESULTS, Math.ceil(perQueryTopK / 2)));

  for (const query of queries) {
    const [paragraphSearch, sceneSearch] = await Promise.all([
      searchParagraphsHybridTool({
        client: params.client,
        bookId: params.bookId,
        query,
        topK: perQueryTopK,
        context: params.context,
      }),
      params.preplan.retrieval.useScenes
        ? searchScenesTool({
            client: params.client,
            bookId: params.bookId,
            query,
            topK: sceneTopK,
            context: params.context,
          })
        : Promise.resolve(null),
    ]);

	    embeddingInputTokens += paragraphSearch.embeddingInputTokens;
	    paragraphHitCount += paragraphSearch.hits.length;
	    fragmentHitCount += paragraphSearch.evidenceFragmentHits.length;
	    paragraphSearchMs += paragraphSearch.totalMs;
    if (sceneSearch) {
      embeddingInputTokens += sceneSearch.embeddingInputTokens;
      sceneHitCount += sceneSearch.hits.length;
      sceneSearchMs += sceneSearch.totalMs;
      for (const scene of sceneSearch.hits) {
        sceneByRef.set(makeSceneRefKey(scene.chapterId, scene.sceneIndex), scene);
      }
    }

	    candidateGroups.push(
	      ...(await buildEvidenceGroupsFromHits({
        bookId: params.bookId,
        hits: paragraphSearch.hits,
        matchedSubquery: query,
        lexicalCorpus: params.lexicalCorpus,
        sceneByRef,
        slotId: params.slot.id,
	      }))
	    );
	    candidateGroups.push(
	      ...buildEvidenceGroupsFromFragments({
	        fragments: paragraphSearch.evidenceFragmentHits,
	        matchedSubquery: query,
	        lexicalCorpus: params.lexicalCorpus,
	        slotId: params.slot.id,
	      })
	    );
	  }

  const mergedCandidates = mergeEvidenceCandidateGroups(candidateGroups)
    .map((group) => ({
      ...group,
      slotId: params.slot.id,
    }))
    .sort((left, right) => right.score - left.score);
  const reranked = await rerankSearchCandidates({
    client: params.client,
    query: `${params.slot.title}\n${params.slot.queries.join("\n")}\n${params.slot.mustCover.join(" ")}`,
    candidates: mergedCandidates,
    topK: Math.max(params.slot.maxGroups * 4, params.slot.maxGroups),
    toRecord: (group) => ({
      id: `${group.id}:${params.slot.id}`,
      title: `${params.slot.title}. Глава ${group.chapterOrderIndex}: ${group.chapterTitle}. Абзацы ${group.paragraphStart}-${group.paragraphEnd}`,
      content: group.text,
    }),
    applyScore: (group, score) => ({
      ...group,
      score: Number(score.toFixed(6)),
      confidence: computeEvidenceConfidence(score, Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"]))),
      matchedBy: Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"])),
      slotId: params.slot.id,
    }),
  });

  let selectedGroups: EvidenceGroup[] = reranked.hits.slice(0, params.slot.maxGroups);
  let repaired = false;
  let missingAnchors = computeMissingSlotAnchors(params.slot, selectedGroups);
  if (missingAnchors.length && params.slot.expansion !== "normal") {
    const repairRange = findBestSlotCoveringRange({
      slot: params.slot,
      lexicalCorpus: params.lexicalCorpus,
      baseGroups: reranked.hits.length ? reranked.hits : mergedCandidates,
    });
    if (repairRange) {
      const slice = await getParagraphSliceTool({
        bookId: params.bookId,
        chapterId: repairRange.chapterId,
        paragraphStart: repairRange.paragraphStart,
        paragraphEnd: repairRange.paragraphEnd,
      });
      if (slice) {
        const repairGroup = createEvidenceGroupFromSlice({
          slice,
          matchedSubquery: params.slot.title,
          slotId: params.slot.id,
          score: 0.72,
          matchedBy: ["lexical"],
        });
        if (repairGroup) {
          const byKey = new Map<string, EvidenceGroup>();
          for (const group of [repairGroup, ...selectedGroups]) {
            byKey.set(`${group.chapterId}:${group.paragraphStart}:${group.paragraphEnd}`, group);
          }
          selectedGroups = Array.from(byKey.values()).slice(0, params.slot.maxGroups);
          repaired = true;
          missingAnchors = computeMissingSlotAnchors(params.slot, selectedGroups);
        }
      }
    }
  }

  return {
    slotEvidence: {
      slotId: params.slot.id,
      title: params.slot.title,
      required: params.slot.required,
      role: params.slot.role,
      coverage: computeSlotCoverage(params.slot, selectedGroups),
      missingAnchors,
      groups: selectedGroups,
    },
    toolMeta: {
	      embeddingInputTokens,
	      paragraphHitCount,
	      fragmentHitCount,
	      sceneHitCount,
      candidateGroupCount: mergedCandidates.length,
      paragraphSearchMs,
      sceneSearchMs,
      rerank: reranked.meta,
      repaired,
    },
  };
}

async function compileEvidencePack(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  preplan: ChatPreplan;
}): Promise<{
  evidencePack: EvidencePack;
  toolRuns: ChatToolRun[];
}> {
  const startedAt = nowMs();
  const toolRuns: ChatToolRun[] = [];
  const emptyRerank = createSkippedRerankMeta(0);
  if (params.preplan.route === "meta_answer" || params.preplan.retrieval.topK <= 0) {
    const evidencePack: EvidencePack = {
      schemaVersion: "compiled-evidence-v1",
      route: params.preplan.route,
      complexity: params.preplan.complexity,
      answerMode: params.preplan.answerMode,
      order: params.preplan.retrieval.order,
      budget: params.preplan.retrieval.evidenceBudget,
      query: params.preplan.retrieval.query,
      subqueries: params.preplan.retrieval.subqueries,
      groups: [],
      slots: [],
      blocks: [],
      metrics: {
        groupCount: 0,
        evidenceChars: 0,
        sceneBoostUsed: false,
        rerank: emptyRerank,
        chapterDistribution: {},
        sceneDistribution: {},
      },
    };
    toolRuns.push({
      tool: "search_evidence",
      args: {
        route: params.preplan.route,
      },
      resultMeta: {
        totalMs: Math.round(nowMs() - startedAt),
        skipped: true,
        reason: "meta_or_zero_top_k",
        embeddingInputTokens: 0,
      },
    });
    return {
      evidencePack,
      toolRuns,
    };
  }

  const context = await ensureBookSearchContext(params.bookId);
  const lexicalCorpusEntry = await getLexicalCorpusCache({
    bookId: params.bookId,
    context,
  });
  const lexicalCorpus = lexicalCorpusEntry.value;

  if (params.preplan.slots.length) {
	    let embeddingInputTokens = 0;
	    let paragraphHitCount = 0;
	    let fragmentHitCount = 0;
	    let sceneHitCount = 0;
    let paragraphSearchMs = 0;
    let sceneSearchMs = 0;
    let candidateGroupCount = 0;
    let repairedSlotCount = 0;
    const slotEvidenceRows: SlotEvidence[] = [];
    const rerankMetas: VertexRerankMeta[] = [];

    for (const slot of params.preplan.slots) {
      const slotResult = await retrieveEvidenceForSlot({
        client: params.client,
        bookId: params.bookId,
        preplan: params.preplan,
        slot,
        context,
        lexicalCorpus,
      });
      slotEvidenceRows.push(slotResult.slotEvidence);
      embeddingInputTokens += slotResult.toolMeta.embeddingInputTokens;
	      paragraphHitCount += slotResult.toolMeta.paragraphHitCount;
	      fragmentHitCount += slotResult.toolMeta.fragmentHitCount;
	      sceneHitCount += slotResult.toolMeta.sceneHitCount;
      paragraphSearchMs += slotResult.toolMeta.paragraphSearchMs;
      sceneSearchMs += slotResult.toolMeta.sceneSearchMs;
      candidateGroupCount += slotResult.toolMeta.candidateGroupCount;
      if (slotResult.toolMeta.repaired) repairedSlotCount += 1;
      rerankMetas.push(slotResult.toolMeta.rerank);
    }

    const selectedGroups = slotEvidenceRows.flatMap((slot) => slot.groups);
    const distribution = evidenceGroupDistribution(selectedGroups);
    const evidenceChars = selectedGroups.reduce((sum, group) => sum + group.text.length, 0);
    const sceneBoostUsed = selectedGroups.some((group) => group.matchedBy.includes("scene"));
    const syntheticRerank: VertexRerankMeta = {
      enabled: rerankMetas.some((meta) => meta.enabled),
      used: rerankMetas.some((meta) => meta.used),
      candidateCount: rerankMetas.reduce((sum, meta) => sum + meta.candidateCount, 0),
      returned: rerankMetas.reduce((sum, meta) => sum + meta.returned, 0),
      model: rerankMetas.find((meta) => meta.model)?.model || null,
      latencyMs: rerankMetas.reduce((sum, meta) => sum + meta.latencyMs, 0),
    };
    const evidencePack: EvidencePack = {
      schemaVersion: "compiled-evidence-v1",
      route: params.preplan.route,
      complexity: params.preplan.complexity,
      answerMode: params.preplan.answerMode,
      order: params.preplan.retrieval.order,
      budget: params.preplan.retrieval.evidenceBudget,
      query: params.preplan.retrieval.query,
      subqueries: params.preplan.retrieval.subqueries,
      groups: selectedGroups,
      slots: slotEvidenceRows,
      blocks: slotEvidenceRows.map((slot) => ({
        label: slot.title,
        groups: slot.groups,
      })),
      metrics: {
        groupCount: selectedGroups.length,
        evidenceChars,
        sceneBoostUsed,
        rerank: syntheticRerank,
        ...distribution,
      },
    };

    toolRuns.push({
      tool: "search_evidence",
      args: {
        query: params.preplan.retrieval.query,
        slots: params.preplan.slots.map((slot) => ({
          id: slot.id,
          title: slot.title,
          required: slot.required,
          queries: slot.queries,
          mustCover: slot.mustCover,
        })),
        order: params.preplan.retrieval.order,
        useScenes: params.preplan.retrieval.useScenes,
        maxGroupParagraphs: EVIDENCE_GROUP_MAX_PARAGRAPHS,
      },
      resultMeta: {
        totalMs: Math.round(nowMs() - startedAt),
        mode: "slot_aware",
        embeddingInputTokens,
        slotCount: slotEvidenceRows.length,
        repairedSlotCount,
        missingRequiredSlotCount: slotEvidenceRows.filter((slot) => slot.required && slot.coverage === "missing").length,
        lowRequiredSlotCount: slotEvidenceRows.filter((slot) => slot.required && slot.coverage === "low").length,
	        paragraphHitCount,
	        fragmentHitCount,
	        sceneHitCount,
        candidateGroupCount,
        evidenceGroupCount: selectedGroups.length,
        evidenceChars,
        sceneBoostUsed,
        paragraphSearchMs: Math.round(paragraphSearchMs),
        sceneSearchMs: Math.round(sceneSearchMs),
        lexicalCacheHit: lexicalCorpusEntry.hit,
        slotCoverage: slotEvidenceRows.map((slot) => ({
          slotId: slot.slotId,
          title: slot.title,
          coverage: slot.coverage,
          missingAnchors: slot.missingAnchors,
          groupCount: slot.groups.length,
        })),
        rerankSteps: rerankMetas.map((meta) => ({
          enabled: meta.enabled,
          used: meta.used,
          candidateCount: meta.candidateCount,
          returned: meta.returned,
          model: meta.model,
          latencyMs: meta.latencyMs,
          error: meta.error,
        })),
      },
    });
    toolRuns.push({
      tool: "coverage_picker",
      args: {
        mode: "slot_aware",
        requiredSlots: params.preplan.slots.filter((slot) => slot.required).length,
      },
      resultMeta: {
        totalMs: 0,
        evidenceGroupCount: selectedGroups.length,
        evidenceChars,
        slotCoverage: slotEvidenceRows.map((slot) => ({
          slotId: slot.slotId,
          coverage: slot.coverage,
          missingAnchors: slot.missingAnchors,
        })),
        chapterDistribution: distribution.chapterDistribution,
        sceneDistribution: distribution.sceneDistribution,
      },
    });

    return {
      evidencePack,
      toolRuns,
    };
  }

  const queries = Array.from(
    new Set([params.preplan.retrieval.query, ...params.preplan.retrieval.subqueries].map((query) => query.trim()).filter(Boolean))
  );
  const perQueryTopK = Math.max(
    4,
    Math.min(MAX_HYBRID_PARAGRAPH_RESULTS, Math.ceil(params.preplan.retrieval.topK * 1.5))
  );
  const sceneTopK = Math.max(4, Math.min(MAX_SEARCH_RESULTS, Math.ceil(params.preplan.retrieval.topK / 2)));
	  let embeddingInputTokens = 0;
	  let paragraphHitCount = 0;
	  let fragmentHitCount = 0;
	  let sceneHitCount = 0;
  let paragraphSearchMs = 0;
  let sceneSearchMs = 0;
  let sceneBoostUsed = false;
  const sceneByRef = new Map<string, SearchSceneResult>();
  const candidateGroups: EvidenceGroup[] = [];
  const rerankMetas: VertexRerankMeta[] = [];

  for (const query of queries) {
    const [paragraphSearch, sceneSearch] = await Promise.all([
      searchParagraphsHybridTool({
        client: params.client,
        bookId: params.bookId,
        query,
        topK: perQueryTopK,
        context,
      }),
      params.preplan.retrieval.useScenes
        ? searchScenesTool({
            client: params.client,
            bookId: params.bookId,
            query,
            topK: sceneTopK,
            context,
          })
        : Promise.resolve(null),
    ]);

	    embeddingInputTokens += paragraphSearch.embeddingInputTokens;
	    paragraphHitCount += paragraphSearch.hits.length;
	    fragmentHitCount += paragraphSearch.evidenceFragmentHits.length;
	    paragraphSearchMs += paragraphSearch.totalMs;
    rerankMetas.push(paragraphSearch.rerank);
    if (sceneSearch) {
      embeddingInputTokens += sceneSearch.embeddingInputTokens;
      sceneHitCount += sceneSearch.hits.length;
      sceneSearchMs += sceneSearch.totalMs;
      rerankMetas.push(sceneSearch.rerank);
      for (const scene of sceneSearch.hits) {
        sceneByRef.set(makeSceneRefKey(scene.chapterId, scene.sceneIndex), scene);
      }
    }

    const groups = await buildEvidenceGroupsFromHits({
      bookId: params.bookId,
      hits: paragraphSearch.hits,
      matchedSubquery: query,
      lexicalCorpus,
      sceneByRef,
    });
	    candidateGroups.push(...groups);
	    candidateGroups.push(
	      ...buildEvidenceGroupsFromFragments({
	        fragments: paragraphSearch.evidenceFragmentHits,
	        matchedSubquery: query,
	        lexicalCorpus,
	      })
	    );
	  }

  const mergedCandidates = mergeEvidenceCandidateGroups(candidateGroups).sort((left, right) => right.score - left.score);
  sceneBoostUsed = mergedCandidates.some((group) => group.matchedBy.includes("scene"));
  const rerankTopK = Math.min(
    Math.max(EVIDENCE_BUDGET_MAX_GROUPS[params.preplan.retrieval.evidenceBudget] * EVIDENCE_RERANK_CANDIDATE_FACTOR, 8),
    Math.max(mergedCandidates.length, 1)
  );
  const reranked = await rerankSearchCandidates({
    client: params.client,
    query: queries.join("\n"),
    candidates: mergedCandidates,
    topK: rerankTopK,
    toRecord: (group) => ({
      id: group.id,
      title: `Глава ${group.chapterOrderIndex}: ${group.chapterTitle}. Абзацы ${group.paragraphStart}-${group.paragraphEnd}`,
      content: group.text,
    }),
    applyScore: (group, score) => ({
      ...group,
      score: Number(score.toFixed(6)),
      confidence: computeEvidenceConfidence(score, Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"]))),
      matchedBy: Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"])),
    }),
  });
  const selectedGroups = pickEvidenceCoverage({
    groups: reranked.hits,
    preplan: params.preplan,
  });
  const distribution = evidenceGroupDistribution(selectedGroups);
  const evidenceChars = selectedGroups.reduce((sum, group) => sum + group.text.length, 0);
  const evidencePack: EvidencePack = {
    schemaVersion: "compiled-evidence-v1",
    route: params.preplan.route,
    complexity: params.preplan.complexity,
    answerMode: params.preplan.answerMode,
    order: params.preplan.retrieval.order,
    budget: params.preplan.retrieval.evidenceBudget,
    query: params.preplan.retrieval.query,
    subqueries: params.preplan.retrieval.subqueries,
    groups: selectedGroups,
    slots: [],
    blocks: buildEvidenceBlocks(params.preplan, selectedGroups),
    metrics: {
      groupCount: selectedGroups.length,
      evidenceChars,
      sceneBoostUsed,
      rerank: reranked.meta,
      ...distribution,
    },
  };

  toolRuns.push({
    tool: "search_evidence",
    args: {
      query: params.preplan.retrieval.query,
      subqueries: params.preplan.retrieval.subqueries,
      topK: params.preplan.retrieval.topK,
      order: params.preplan.retrieval.order,
      useScenes: params.preplan.retrieval.useScenes,
      maxGroupParagraphs: EVIDENCE_GROUP_MAX_PARAGRAPHS,
    },
    resultMeta: {
      totalMs: Math.round(nowMs() - startedAt),
      embeddingInputTokens,
      queryCount: queries.length,
	      paragraphHitCount,
	      fragmentHitCount,
	      sceneHitCount,
      candidateGroupCount: mergedCandidates.length,
      evidenceGroupCount: selectedGroups.length,
      evidenceChars,
      sceneBoostUsed,
      paragraphSearchMs: Math.round(paragraphSearchMs),
      sceneSearchMs: Math.round(sceneSearchMs),
      lexicalCacheHit: lexicalCorpusEntry.hit,
      rerankSteps: rerankMetas.map((meta) => ({
        enabled: meta.enabled,
        used: meta.used,
        candidateCount: meta.candidateCount,
        returned: meta.returned,
        model: meta.model,
        latencyMs: meta.latencyMs,
        error: meta.error,
      })),
    },
  });
  toolRuns.push({
    tool: "rerank_evidence_groups",
    args: {
      candidateGroupCount: mergedCandidates.length,
      topK: rerankTopK,
    },
    resultMeta: {
      totalMs: reranked.meta.latencyMs,
      ...reranked.meta,
    },
  });
  toolRuns.push({
    tool: "coverage_picker",
    args: {
      budget: params.preplan.retrieval.evidenceBudget,
      order: params.preplan.retrieval.order,
      maxGroups: EVIDENCE_BUDGET_MAX_GROUPS[params.preplan.retrieval.evidenceBudget],
      maxChars: EVIDENCE_BUDGET_MAX_CHARS[params.preplan.retrieval.evidenceBudget],
    },
    resultMeta: {
      totalMs: 0,
      evidenceGroupCount: selectedGroups.length,
      evidenceChars,
      chapterDistribution: distribution.chapterDistribution,
      sceneDistribution: distribution.sceneDistribution,
    },
  });

  return {
    evidencePack,
    toolRuns,
  };
}

async function getBookStructureContext(bookId: string): Promise<BookStructureContext> {
  const chapters = await prisma.bookChapter.findMany({
    where: {
      bookId,
    },
    orderBy: {
      orderIndex: "asc",
    },
    select: {
      id: true,
      orderIndex: true,
      title: true,
      rawText: true,
      scenes: {
        orderBy: {
          sceneIndex: "asc",
        },
        select: {
          id: true,
          sceneIndex: true,
          paragraphStart: true,
          paragraphEnd: true,
          sceneCard: true,
          sceneSummary: true,
        },
      },
    },
  });

  return {
    chapters: chapters.map((chapter: any) => {
      const paragraphs = splitChapterToParagraphs(String(chapter.rawText || ""));
      return {
        chapterId: chapter.id,
        title: String(chapter.title || "").trim(),
        orderIndex: Number(chapter.orderIndex || 0),
        paragraphStart: paragraphs.length ? 1 : 0,
        paragraphEnd: paragraphs.length,
        scenes: (chapter.scenes || []).map((scene: any) => ({
          sceneId: scene.id,
          title: clampText(scene.sceneCard || `Сцена ${scene.sceneIndex}`, 120),
          summary: clampText(scene.sceneSummary || "", 400),
          paragraphStart: Number(scene.paragraphStart || 0),
          paragraphEnd: Number(scene.paragraphEnd || 0),
        })),
      };
    }),
  };
}

export function deriveCitationsFromEvidencePack(evidencePack: EvidencePack): ChatCitation[] {
  const citations: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const group of evidencePack.groups) {
    const key = `${group.chapterOrderIndex}:${group.sceneIndex || 0}:${group.paragraphStart}:${group.paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      chapterOrderIndex: group.chapterOrderIndex,
      sceneIndex: group.sceneIndex || 0,
      paragraphStart: group.paragraphStart,
      paragraphEnd: group.paragraphEnd,
      reason: group.matchedSubquery
        ? `Evidence for: ${group.matchedSubquery}`
        : `Evidence group ${group.id}`,
    });
  }
  return citations;
}

function deriveCitationsFromCompiledEvidence(params: {
  evidencePack: EvidencePack;
  repairCapture?: CompiledAnswerRepairCapture;
}): ChatCitation[] {
  const citations = deriveCitationsFromEvidencePack(params.evidencePack);
  const seen = new Set(
    citations.map((citation) => `${citation.chapterOrderIndex}:${citation.sceneIndex}:${citation.paragraphStart}:${citation.paragraphEnd}`)
  );

  for (const group of params.repairCapture?.evidenceGroups || []) {
    const key = `${group.chapterOrderIndex}:${group.sceneIndex || 0}:${group.paragraphStart}:${group.paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      chapterOrderIndex: group.chapterOrderIndex,
      sceneIndex: group.sceneIndex || 0,
      paragraphStart: group.paragraphStart,
      paragraphEnd: group.paragraphEnd,
      reason: group.matchedSubquery ? `Repair evidence for: ${group.matchedSubquery}` : `Repair evidence group ${group.id}`,
    });
  }

  for (const slice of params.repairCapture?.paragraphSlices || []) {
    const key = `${slice.chapterOrderIndex}:0:${slice.paragraphStart}:${slice.paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      chapterOrderIndex: slice.chapterOrderIndex,
      sceneIndex: 0,
      paragraphStart: slice.paragraphStart,
      paragraphEnd: slice.paragraphEnd,
      reason: "Repair passage",
    });
  }

  return citations;
}

function formatEvidenceGroupForPrompt(group: EvidenceGroup) {
  return {
    id: group.id,
    chapterId: group.chapterId,
    chapterOrderIndex: group.chapterOrderIndex,
    chapterTitle: group.chapterTitle,
    sceneId: group.sceneId,
    sceneIndex: group.sceneIndex,
    sceneTitle: group.sceneTitle,
    paragraphStart: group.paragraphStart,
    paragraphEnd: group.paragraphEnd,
    confidence: group.confidence,
    matchedBy: group.matchedBy,
    matchedSubquery: group.matchedSubquery,
    slotId: group.slotId,
    paragraphs: group.paragraphs.map((paragraph) => ({
      paragraphIndex: paragraph.paragraphIndex,
      text: clampText(paragraph.text, MAX_PRIMARY_EVIDENCE_PARAGRAPH_CHARS),
    })),
  };
}

function formatEvidencePackForPrompt(evidencePack: EvidencePack) {
  return {
    schemaVersion: evidencePack.schemaVersion,
    route: evidencePack.route,
    complexity: evidencePack.complexity,
    answerMode: evidencePack.answerMode,
    order: evidencePack.order,
    budget: evidencePack.budget,
    query: evidencePack.query,
    subqueries: evidencePack.subqueries,
    slots: evidencePack.slots.map((slot) => ({
      slotId: slot.slotId,
      title: slot.title,
      required: slot.required,
      role: slot.role,
      coverage: slot.coverage,
      missingAnchors: slot.missingAnchors,
      groups: slot.groups.map(formatEvidenceGroupForPrompt),
    })),
    blocks: evidencePack.blocks.map((block) => ({
      label: block.label,
      groups: block.groups.map(formatEvidenceGroupForPrompt),
    })),
    metrics: evidencePack.metrics,
  };
}

function createCompiledEvidenceAnswerSystemPrompt(bookTitle: string, runtime: CompiledAnswerRuntime): string {
  const repairEnabled = runtime.repairTools.length > 0;
  return `Ты отвечаешь на вопросы пользователя строго по evidence pack одной книги.

Книга: ${bookTitle}

Правила:
- Ты получил initial evidence pack от backend-а.
- ${
    repairEnabled
      ? "Если required slot имеет coverage low/missing или не хватает конкретного literal anchor из missingAnchors, сделай точечный repair-вызов. Если coverage medium и есть группы evidence, сначала отвечай по pack; для соседнего контекста предпочитай read_passages."
      : "Не вызывай инструменты: этот ответ должен быть pack-only."
  }
- ${
    repairEnabled
      ? "Перед тем как сказать пользователю, что найденные фрагменты чего-то не подтверждают, обязан использовать repair tool, если лимит tool calls ещё не исчерпан."
      : "Если evidence недостаточно, прямо скажи, что найденные фрагменты не подтверждают вывод."
  }
- Не начинай поиск заново с нуля; repair tools нужны только для закрытия дыр в evidence.
- Не запрашивай полные сцены и не делай tools для улучшения стиля.
- Если делаешь read_passages, расширяй один диапазон, а не несколько перекрывающихся запросов.
- Если вызвал repair tool, после результата обязательно дай финальный ответ пользователю; не завершай ответ только вызовом инструмента.
- Не используй память о книге, экранизации, wiki или общее знание.
- Не используй термины, объяснения и классификации из поздних частей серии или внешнего канона, если они прямо не названы в evidence. Если evidence говорит только "дневник", "воспоминание" или "предмет", не называй это другим типом артефакта.
- Отвечай только по evidencePack и structureContext.
- Если route="meta_answer", можно ответить без evidence, но не делай утверждений о содержании книги.
- Scene summary или название сцены можно использовать только как навигационный контекст, не как единственное доказательство.
- Для каждого важного утверждения должна быть опора в evidence group.
- Если evidencePack.slots есть, используй их как checklist для ответа и repair-а, а не как окончательный приговор.
- Required slot должен быть отражён в ответе; если после repair coverage всё ещё low/missing, только тогда прямо скажи, что этот пункт найденными фрагментами не закрыт.
- Origin/transfer guard: если утверждаешь, как объект, письмо, дневник, улика, информация, подозрение или персонаж впервые появился у кого-то, был найден, передан, подложен или получен, это должно быть прямо подтверждено evidence. Если evidence показывает только владение/использование, пиши нейтрально: "оказался у", "к этому моменту был у", "в найденных фрагментах не видно, как именно".
- Source attribution guard: если утверждение исходит из речи персонажа, дневника, письма, статьи, слуха, легенды, воспоминания или обвинения, сохраняй источник: "по словам X", "в версии X", "дневник утверждает", "в воспоминании показано". Не превращай "X сказал, что Y" в объективное "Y было так".
- Для вопросов о ложной версии, подозрениях, уликах, обвинениях или ненадёжном рассказчике явно разделяй: что утверждает источник, что наблюдают герои, что подтверждает повествование и что позже опровергается.
- Если персонаж выдвигает версию, которая позже прямо опровергается evidence, называй её ошибочной догадкой/ложным следом и сразу указывай контрфрагмент. Не пиши её как "факт", "семейную историю" или объективное объяснение.
- Не делай optional/preparation slot центральным доказательством, если есть decisive slot.
- Не используй evidence одного slot как доказательство другого slot.
- Для table_sequence отвечай строками/пунктами по slot.role="row"; для clue_synthesis отвечай по slot.role="clue"; для progressive_reveal отделяй preparation от decisive proof.
- Для chronology/progressive_reveal не пропускай промежуточные передачи и возвраты объекта/информации, если они есть в evidence: попытка избавиться -> находка другим персонажем -> кража/возврат -> финальное действие.
- Если evidence недостаточно, прямо скажи, что найденные фрагменты не подтверждают вывод.
- Для chronology и explanation сначала восстанови цепочку по фрагментам, потом дай вывод.
- Не добавляй персонажей, события, факультеты, мотивы и причины, которых нет в evidence.
- Пиши по-русски, содержательно, без markdown-таблиц.`;
}

function createCompiledEvidenceAnswerPrompt(params: {
  question: string;
  recentMessages: ChatInputMessage[];
  preplan: ChatPreplan;
  evidencePack: EvidencePack;
  runtime: CompiledAnswerRuntime;
  structureContext?: BookStructureContext;
}) {
  return JSON.stringify(
    {
      question: params.question,
      recentMessages: params.recentMessages.slice(-8),
      answerMode: params.preplan.answerMode,
      route: params.preplan.route,
      retrievalPlan: params.preplan.retrieval,
      answerRuntime: {
        model: params.runtime.model,
        repairTools: params.runtime.repairTools,
        maxToolCalls: params.runtime.maxToolCalls,
        reasons: params.runtime.reasons,
      },
      evidencePack: formatEvidencePackForPrompt(params.evidencePack),
      structureContext: params.structureContext
        ? {
            chapters: params.structureContext.chapters.slice(0, 80),
          }
        : undefined,
      rules: [
        "answer_only_from_evidence_pack",
        ...(params.runtime.repairTools.length ? ["repair_missing_evidence_before_saying_missing"] : ["pack_only_no_tools"]),
        "if_evidence_slots_exist_answer_by_slots",
        "cover_each_required_slot_or_state_missing",
        "do_not_make_preparation_slot_the_decisive_proof",
        "do_not_reuse_one_slot_as_proof_for_another_slot",
        "origin_or_transfer_claims_must_be_directly_supported",
        "preserve_source_attribution_for_dialogue_documents_memories_rumors",
        "separate_claim_source_from_objective_narration",
        "cite_important_claims_by_group_id_or_chapter_paragraph_range_in_text_when_useful",
        "say_insufficient_evidence_when_needed",
        "do_not_invent_missing_links",
      ],
    },
    null,
    2
  );
}

function buildDeterministicFallbackAnswerFromEvidence(evidencePack: EvidencePack): string {
  if (!evidencePack.groups.length) {
    return "В найденных фрагментах нет достаточной опоры для ответа на этот вопрос.";
  }
  const rows = evidencePack.groups.slice(0, 5).map((group) => {
    const firstParagraph = group.paragraphs[0]?.text || group.text;
    return `- Глава ${group.chapterOrderIndex}, абз. ${group.paragraphStart}-${group.paragraphEnd}: ${clampText(
      firstParagraph,
      320
    )}`;
  });
  return `Я не смог собрать полноценный ответ, но найденные фрагменты подтверждают следующее:\n${rows.join("\n")}`;
}

function formatRepairCaptureForPrompt(capture: CompiledAnswerRepairCapture) {
  return {
    evidenceGroups: capture.evidenceGroups.map(formatEvidenceGroupForPrompt),
    paragraphSlices: capture.paragraphSlices.map((slice) => ({
      chapterId: slice.chapterId,
      chapterOrderIndex: slice.chapterOrderIndex,
      chapterTitle: slice.chapterTitle,
      paragraphStart: slice.paragraphStart,
      paragraphEnd: slice.paragraphEnd,
      text: clampText(slice.text, 12_000),
    })),
  };
}

async function synthesizeCompiledFallbackAnswer(params: {
  model: ReturnType<typeof createVertexChatModelFromConfig>;
  providerOptions: ReturnType<typeof createVertexReasoningProviderOptions>;
  bookTitle: string;
  question: string;
  preplan: ChatPreplan;
  evidencePack: EvidencePack;
  repairCapture: CompiledAnswerRepairCapture;
}): Promise<{ answer: string | null; usage?: LanguageModelUsage; latencyMs?: number }> {
  const hasRepairEvidence = params.repairCapture.evidenceGroups.length > 0 || params.repairCapture.paragraphSlices.length > 0;
  if (!params.evidencePack.groups.length && !hasRepairEvidence) return { answer: null };

  try {
    const startedAt = Date.now();
    const completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: params.model,
        temperature: 0,
        system: `Ты формируешь финальный ответ по уже собранным фрагментам одной книги.

Книга: ${params.bookTitle}

Правила:
- Не вызывай инструменты.
- Не используй память о книге, экранизации, wiki, поздние части серии или внешний канон.
- Отвечай только по initial evidence и repair evidence.
- Если repair evidence закрывает вопрос лучше initial evidence, используй repair evidence как primary.
- Не выводи сырой список фрагментов; дай нормальный пользовательский ответ по-русски.
- Если данных всё ещё не хватает, назови только недостающую часть.`,
        prompt: JSON.stringify(
          {
            question: params.question,
            answerMode: params.preplan.answerMode,
            initialEvidencePack: formatEvidencePackForPrompt(params.evidencePack),
            repairEvidence: formatRepairCaptureForPrompt(params.repairCapture),
          },
          null,
          2
        ),
        providerOptions: params.providerOptions,
      })
    );
    const answer = String(completion.text || "").trim();
    return {
      answer: answer || null,
      usage: completion.usage,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return { answer: null };
  }
}

function hasCompiledRepairEvidence(capture: CompiledAnswerRepairCapture) {
  return capture.evidenceGroups.length > 0 || capture.paragraphSlices.length > 0;
}

async function finalizeCompiledAnswerAfterRepair(params: {
  model: ReturnType<typeof createVertexChatModelFromConfig>;
  providerOptions: ReturnType<typeof createVertexReasoningProviderOptions>;
  bookTitle: string;
  question: string;
  preplan: ChatPreplan;
  evidencePack: EvidencePack;
  repairCapture: CompiledAnswerRepairCapture;
  toolRuns: ChatToolRun[];
}): Promise<{ answer: string | null; usage?: LanguageModelUsage; latencyMs?: number }> {
  if (!hasCompiledRepairEvidence(params.repairCapture)) return { answer: null };
  const finalized = await synthesizeCompiledFallbackAnswer({
    model: params.model,
    providerOptions: params.providerOptions,
    bookTitle: params.bookTitle,
    question: params.question,
    preplan: params.preplan,
    evidencePack: params.evidencePack,
    repairCapture: params.repairCapture,
  });
  params.toolRuns.push({
    tool: "llm_finalizer",
    args: {
      route: params.preplan.route,
      answerMode: params.preplan.answerMode,
      evidenceGroupCount: params.evidencePack.groups.length,
      repairEvidenceGroupCount: params.repairCapture.evidenceGroups.length,
      repairSliceCount: params.repairCapture.paragraphSlices.length,
    },
    resultMeta: {
      totalMs: finalized.latencyMs || 0,
      mode: "compiled_evidence_no_tools_finalizer",
      used: Boolean(finalized.answer),
    },
  });
  return finalized;
}

async function buildCompiledChatContext(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  messages: ChatInputMessage[];
}): Promise<CompiledChatContext> {
  const preplanResult = await buildChatPreplan({
    clientConfig: {
      apiKey: params.client.config.apiKey,
      baseUrl: params.client.config.baseUrl,
      chatModel: params.client.config.chatModel,
      proxySource: params.client.config.proxySource,
    },
    bookId: params.bookId,
    bookTitle: params.bookTitle,
    userQuestion: params.userQuestion,
    recentMessages: params.messages,
  });
  const llmStepRuns: ChatLlmStepRun[] = [];
  if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED && preplanResult.plannerStepRun) {
    llmStepRuns.push(preplanResult.plannerStepRun);
  }

  const compiled = await compileEvidencePack({
    client: params.client,
    bookId: params.bookId,
    preplan: preplanResult.preplan,
  });
  const structureContext =
    preplanResult.preplan.route === "structure_answer" ? await getBookStructureContext(params.bookId) : undefined;

  return {
    preplanResult,
    evidencePack: compiled.evidencePack,
    structureContext,
    toolRuns: [preplanResult.toolRun, ...compiled.toolRuns],
    llmStepRuns,
  };
}

async function searchCompiledRepairEvidence(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  query: string;
  requiredAnchors?: string[];
  scope?: {
    chapterIds?: string[];
    sceneIds?: string[];
  };
  order?: ChatEvidenceOrder;
  strategy?: SearchEvidenceStrategy;
  topK?: number;
}): Promise<{
  groups: EvidenceGroup[];
  meta: Record<string, unknown>;
}> {
  const startedAt = nowMs();
  const safeQuery = String(params.query || "").replace(/\s+/g, " ").trim();
  const requiredAnchors = (params.requiredAnchors || [])
    .map((anchor) => String(anchor || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!safeQuery) {
    return {
      groups: [],
      meta: {
        totalMs: Math.round(nowMs() - startedAt),
        error: "empty query",
        embeddingInputTokens: 0,
      },
    };
  }

  const topK = Math.max(1, Math.min(12, Number(params.topK || 6)));
  const strategy: SearchEvidenceStrategy = params.strategy === "scene_first" ? "scene_first" : "default";
  const searchQuery = requiredAnchors.length ? `${safeQuery}\n${requiredAnchors.join(" ")}` : safeQuery;
  const context = await ensureBookSearchContext(params.bookId);
  const lexicalCorpusEntry = await getLexicalCorpusCache({
    bookId: params.bookId,
    context,
  });
  const lexicalCorpus = lexicalCorpusEntry.value;
  const sceneByRef = new Map<string, SearchSceneResult>();
  const [paragraphSearch, sceneSearch] = await Promise.all([
    searchParagraphsHybridTool({
      client: params.client,
      bookId: params.bookId,
      query: searchQuery,
      topK: Math.max(topK, 8),
      context,
    }),
    searchScenesTool({
      client: params.client,
      bookId: params.bookId,
      query: searchQuery,
      topK: Math.max(4, Math.min(MAX_SEARCH_RESULTS, Math.ceil(topK / 2))),
      context,
    }).catch(() => null),
  ]);
  if (sceneSearch) {
    for (const scene of sceneSearch.hits) {
      sceneByRef.set(makeSceneRefKey(scene.chapterId, scene.sceneIndex), scene);
    }
  }

  const paragraphCandidateGroups = [
    ...(await buildEvidenceGroupsFromHits({
      bookId: params.bookId,
      hits: paragraphSearch.hits,
      matchedSubquery: safeQuery,
      lexicalCorpus,
      sceneByRef,
    })),
    ...buildEvidenceGroupsFromFragments({
      fragments: paragraphSearch.evidenceFragmentHits,
      matchedSubquery: safeQuery,
      lexicalCorpus,
    }),
  ];
  const sceneWindowGroups =
    strategy === "scene_first" && sceneSearch?.hits.length
      ? await buildEvidenceGroupsFromSceneWindows({
          bookId: params.bookId,
          scenes: sceneSearch.hits,
          matchedSubquery: safeQuery,
        })
      : [];
  const candidateGroups = mergeEvidenceCandidateGroups([...sceneWindowGroups, ...paragraphCandidateGroups]);
  const chapterScope = new Set((params.scope?.chapterIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const sceneScope = new Set((params.scope?.sceneIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const scopedGroups =
    chapterScope.size || sceneScope.size
      ? candidateGroups.filter((group) => {
          const chapterOk = !chapterScope.size || chapterScope.has(group.chapterId);
          const sceneOk = !sceneScope.size || (group.sceneId && sceneScope.has(group.sceneId));
          return chapterOk && sceneOk;
        })
      : candidateGroups;
  const groupsForRerank = scopedGroups.length ? scopedGroups : candidateGroups;
  const reranked = await rerankSearchCandidates({
    client: params.client,
    query: searchQuery,
    candidates: groupsForRerank,
    topK: Math.max(topK * 2, topK),
    toRecord: (group) => ({
      id: group.id,
      title: `Глава ${group.chapterOrderIndex}: ${group.chapterTitle}. Абзацы ${group.paragraphStart}-${group.paragraphEnd}`,
      content: group.text,
    }),
    applyScore: (group, score) => ({
      ...group,
      score: Number(score.toFixed(6)),
      confidence: computeEvidenceConfidence(score, Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"]))),
      matchedBy: Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "rerank"])),
    }),
  });
  const selectedGroups = (strategy === "scene_first"
    ? pickSceneFirstEvidenceGroups({
        groups: reranked.hits,
        topK,
        order: params.order || "relevance",
      })
    : params.order === "chronological"
      ? reranked.hits
          .slice(0, topK)
          .sort((left, right) =>
            left.chapterOrderIndex === right.chapterOrderIndex
              ? left.paragraphStart - right.paragraphStart
              : left.chapterOrderIndex - right.chapterOrderIndex
          )
      : reranked.hits.slice(0, topK)
  ).map((group) => ({
    ...group,
    matchedSubquery: safeQuery,
  }));

  return {
    groups: selectedGroups,
    meta: {
      totalMs: Math.round(nowMs() - startedAt),
      mode: "repair_search",
      strategy,
      returned: selectedGroups.length,
      query: safeQuery,
      requiredAnchors,
      scoped: chapterScope.size > 0 || sceneScope.size > 0,
      candidateGroupCount: candidateGroups.length,
      scopedGroupCount: scopedGroups.length,
      paragraphHitCount: paragraphSearch.hits.length,
      fragmentHitCount: paragraphSearch.evidenceFragmentHits.length,
      sceneHitCount: sceneSearch?.hits.length || 0,
      embeddingInputTokens: paragraphSearch.embeddingInputTokens + (sceneSearch?.embeddingInputTokens || 0),
      lexicalCacheHit: lexicalCorpusEntry.hit,
      rerank: reranked.meta,
    },
  };
}

function normalizeTraceAnchors(anchors: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const anchor of anchors || []) {
    const value = String(anchor || "").replace(/\s+/g, " ").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    normalized.push(value);
    if (normalized.length >= 8) break;
  }
  return normalized;
}

function buildTraceLineQueries(anchors: readonly string[]): string[] {
  const normalized = normalizeTraceAnchors(anchors);
  const queries: string[] = [];
  const add = (value: string) => {
    const query = value.replace(/\s+/g, " ").trim();
    if (!query) return;
    if (queries.some((existing) => existing.toLowerCase() === query.toLowerCase())) return;
    queries.push(query);
  };

  add(normalized.join(" "));
  for (let index = 0; index < normalized.length - 1 && queries.length < 4; index += 1) {
    add(`${normalized[index]} ${normalized[index + 1]}`);
  }
  if (normalized.length > 2 && queries.length < 4) {
    add(`${normalized[0]} ${normalized[normalized.length - 1]}`);
  }

  return queries.slice(0, 4);
}

function normalizeTraceEventChainPlan(value: unknown, fallback: {
  question: string;
  focus: string;
  anchors: string[];
}): TraceEventChainPlan {
  const row = asRecord(value);
  const focus = String(row.focus || fallback.focus || fallback.question || "").replace(/\s+/g, " ").trim();
  const subjects = asStringList(row.subjects, 8);
  const anchors = normalizeTraceAnchors([...fallback.anchors, ...asStringList(row.anchors, 8), ...subjects]);
  const rawQueries = [
    ...asStringList(row.searchQueries, 12),
    fallback.focus,
    fallback.question,
    anchors.join(" "),
  ];
  const seen = new Set<string>();
  const searchQueries: string[] = [];
  for (const rawQuery of rawQueries) {
    const query = String(rawQuery || "").replace(/\s+/g, " ").trim();
    if (!query || query.length < 2) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    searchQueries.push(query);
    if (searchQueries.length >= 10) break;
  }

  return {
    focus,
    subjects,
    anchors,
    searchQueries,
    transitionsToCheck: asStringList(row.transitionsToCheck, 10),
  };
}

async function traceLineEvidence(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  anchors: string[];
  topK?: number;
}): Promise<{
  groups: EvidenceGroup[];
  meta: Record<string, unknown>;
}> {
  const startedAt = nowMs();
  const anchors = normalizeTraceAnchors(params.anchors);
  if (anchors.length < 2) {
    return {
      groups: [],
      meta: {
        totalMs: Math.round(nowMs() - startedAt),
        mode: "trace_line",
        returned: 0,
        error: "trace_line requires at least two anchors",
      },
    };
  }

  const topK = Math.max(4, Math.min(12, Number(params.topK || 10)));
  const queries = buildTraceLineQueries(anchors);
  const perQueryTopK = Math.max(4, Math.min(8, Math.ceil(topK / Math.max(1, Math.min(2, queries.length))) + 2));
  const results = await Promise.all(
    queries.map((query) =>
      searchCompiledRepairEvidence({
        client: params.client,
        bookId: params.bookId,
        query,
        requiredAnchors: anchors,
        order: "chronological",
        strategy: "scene_first",
        topK: perQueryTopK,
      })
    )
  );

  const merged = mergeEvidenceCandidateGroups(results.flatMap((result) => result.groups)).sort((left, right) => right.score - left.score);
  const selected = pickSceneFirstEvidenceGroups({
    groups: merged,
    topK,
    order: "chronological",
  });

  return {
    groups: selected,
    meta: {
      totalMs: Math.round(nowMs() - startedAt),
      mode: "trace_line",
      strategy: "scene_first",
      returned: selected.length,
      anchors,
      queryCount: queries.length,
      queries,
      candidateGroupCount: merged.length,
      embeddingInputTokens: results.reduce((sum, result) => sum + Math.max(0, Number(result.meta.embeddingInputTokens || 0)), 0),
      paragraphHitCount: results.reduce((sum, result) => sum + Math.max(0, Number(result.meta.paragraphHitCount || 0)), 0),
      fragmentHitCount: results.reduce((sum, result) => sum + Math.max(0, Number(result.meta.fragmentHitCount || 0)), 0),
      sceneHitCount: results.reduce((sum, result) => sum + Math.max(0, Number(result.meta.sceneHitCount || 0)), 0),
      internalSearches: results.map((result) => ({
        query: result.meta.query,
        returned: result.meta.returned,
        candidateGroupCount: result.meta.candidateGroupCount,
        sceneHitCount: result.meta.sceneHitCount,
        paragraphHitCount: result.meta.paragraphHitCount,
        rerank: result.meta.rerank,
      })),
    },
  };
}

function normalizeTraceEventChainLedger(value: unknown, fallbackFocus: string): TraceEventChainLedger {
  const row = asRecord(value);
  const chain = normalizeTraceEventArray(row.chain, fallbackFocus).slice(0, 24);

  return {
    focus: String(row.focus || fallbackFocus || "").replace(/\s+/g, " ").trim(),
    chain,
    unknowns: asStringList(row.unknowns, 8),
    warnings: asStringList(row.warnings, 6),
    unsupportedClaims: asStringList(row.unsupportedClaims, 8),
  };
}

function normalizeChainInvestigationReport(value: unknown, fallbackFocus: string): ChainInvestigationReport {
  const row = asRecord(value);
  const evidenceSchema = z.object({
    evidenceGroupId: z.string().trim().max(120).optional(),
    ref: z.string().trim().max(120).default(""),
    proves: z.string().trim().max(400).default(""),
    quote: z.string().trim().max(500).optional(),
  });
  const stepSchema = z.object({
    order: z.coerce.number().int().min(1).max(80).default(1),
    claim: z.string().trim().max(600).default(""),
    support: z.enum(["explicit", "inferred", "gap"]).default("explicit"),
    evidence: z.array(evidenceSchema).max(8).default([]),
    caveat: z.string().trim().max(500).optional(),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  });
  const parsedSteps = z.array(stepSchema).max(40).safeParse(row.answerSkeleton);
  const answerSkeleton = (parsedSteps.success ? parsedSteps.data : [])
    .filter((step) => step.claim)
    .sort((left, right) => left.order - right.order)
    .map((step, index) => ({
      ...step,
      order: index + 1,
      evidence: step.evidence.filter((item) => item.ref || item.proves || item.quote),
    }));

  return {
    focus: String(row.focus || fallbackFocus || "").replace(/\s+/g, " ").trim(),
    answerSkeleton,
    gaps: asStringList(row.gaps, 10),
    rejectedClaims: asStringList(row.rejectedClaims, 10),
    warnings: asStringList(row.warnings, 8),
    boundary: String(row.boundary || "").replace(/\s+/g, " ").trim() || undefined,
  };
}

function parseParagraphRef(ref: string): { chapterOrderIndex: number; paragraphIndex: number } | null {
  const match = String(ref || "").match(/ch(\d+):p(\d+)/i);
  if (!match) return null;
  return {
    chapterOrderIndex: Number(match[1] || 0),
    paragraphIndex: Number(match[2] || 0),
  };
}

function evidenceGroupIsBeforeBoundary(group: EvidenceGroup, boundary: ChainInvestigationBoundary) {
  if (group.chapterOrderIndex < boundary.chapterOrderIndex) return true;
  if (group.chapterOrderIndex > boundary.chapterOrderIndex) return false;
  return group.paragraphStart < boundary.paragraphStart;
}

function traceEventIsBeforeBoundary(event: TraceEventChainEvent, boundary: ChainInvestigationBoundary) {
  const refs = event.paragraphRefs.map(parseParagraphRef).filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
  if (!refs.length) return true;
  return refs.some(
    (ref) =>
      ref.chapterOrderIndex < boundary.chapterOrderIndex ||
      (ref.chapterOrderIndex === boundary.chapterOrderIndex && ref.paragraphIndex < boundary.paragraphStart)
  );
}

function formatTraceEvidenceForPrompt(groups: EvidenceGroup[], maxChars = 3600) {
  return groups.map((group) => ({
    id: group.id,
    chapterOrderIndex: group.chapterOrderIndex,
    chapterTitle: group.chapterTitle,
    paragraphStart: group.paragraphStart,
    paragraphEnd: group.paragraphEnd,
    confidence: group.confidence,
    matchedBy: group.matchedBy,
    text: clampText(group.text, maxChars),
  }));
}

function mergeTraceSceneHits(sceneResults: Array<Awaited<ReturnType<typeof searchScenesTool>> | null | undefined>): SearchSceneResult[] {
  const byId = new Map<string, SearchSceneResult>();
  for (const result of sceneResults) {
    for (const scene of result?.hits || []) {
      const previous = byId.get(scene.sceneId);
      if (!previous || Number(scene.score || 0) > Number(previous.score || 0)) {
        byId.set(scene.sceneId, scene);
      }
    }
  }

  return Array.from(byId.values());
}

function dedupeTraceScenes(scenes: readonly SearchSceneResult[]): SearchSceneResult[] {
  const byId = new Map<string, SearchSceneResult>();
  for (const scene of scenes) {
    const previous = byId.get(scene.sceneId);
    if (!previous || Number(scene.score || 0) > Number(previous.score || 0)) {
      byId.set(scene.sceneId, scene);
    }
  }
  return Array.from(byId.values());
}

async function buildTraceSceneTimelineEvidence(params: {
  bookId: string;
  scenes: SearchSceneResult[];
  maxGroups: number;
}): Promise<EvidenceGroup[]> {
  const maxGroups = Math.max(8, Math.min(64, Math.floor(params.maxGroups || 36)));
  const windowSize = 6;
  const rows: EvidenceGroup[] = [];
  const seen = new Set<string>();
  const orderedScenes = [...params.scenes].sort((left, right) =>
    left.chapterOrderIndex === right.chapterOrderIndex
      ? left.paragraphStart - right.paragraphStart
      : left.chapterOrderIndex - right.chapterOrderIndex
  );

  const sceneStarts = orderedScenes.map((scene) => {
    const sceneStart = Math.max(1, Number(scene.paragraphStart || 1));
    const sceneEnd = Math.max(sceneStart, Number(scene.paragraphEnd || sceneStart));
    const starts = new Set<number>();

    if (sceneEnd - sceneStart + 1 <= windowSize) {
      starts.add(sceneStart);
    } else {
      starts.add(sceneStart);
      starts.add(Math.max(sceneStart, Math.floor((sceneStart + sceneEnd - windowSize + 1) / 2)));
      starts.add(Math.max(sceneStart, sceneEnd - windowSize + 1));
    }

    return {
      scene,
      sceneEnd,
      starts: Array.from(starts)
        .filter((paragraphStart) => paragraphStart <= sceneEnd)
        .sort((left, right) => left - right),
    };
  });

  const maxStarts = Math.max(0, ...sceneStarts.map((item) => item.starts.length));
  for (let startIndex = 0; startIndex < maxStarts; startIndex += 1) {
    for (const item of sceneStarts) {
      if (rows.length >= maxGroups) break;
      const paragraphStart = item.starts[startIndex];
      if (!paragraphStart) continue;
      const scene = item.scene;
      const sceneEnd = item.sceneEnd;
      const paragraphEnd = Math.min(sceneEnd, paragraphStart + windowSize - 1);
      const key = `${scene.sceneId}:${paragraphStart}:${paragraphEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const slice = await getParagraphSliceTool({
        bookId: params.bookId,
        chapterId: scene.chapterId,
        paragraphStart,
        paragraphEnd,
      });
      if (!slice) continue;

      const group = createEvidenceGroupFromSlice({
        slice,
        matchedSubquery: "trace_scene_timeline",
        score: Math.max(0.55, Number(scene.score || 0.55)),
        matchedBy: ["scene"],
      });
      if (!group) continue;

      rows.push({
        ...group,
        sceneId: scene.sceneId,
        sceneIndex: scene.sceneIndex,
        sceneTitle: scene.sceneCard ? clampText(scene.sceneCard, 120) : undefined,
        matchedBy: Array.from(new Set<EvidenceMatchedBy>([...group.matchedBy, "scene"])),
      });
    }
  }

  return rows;
}

function normalizeTraceEventArray(value: unknown, fallbackFocus: string): TraceEventChainEvent[] {
  const eventSchema = z.object({
    order: z.coerce.number().int().min(1).max(120).default(1),
    actor: z.string().trim().max(160).default(""),
    action: z.string().trim().max(260).default(""),
    object: z.string().trim().max(180).default(""),
    target: z.string().trim().max(180).optional(),
    place: z.string().trim().max(180).optional(),
    timeHint: z.string().trim().max(180).optional(),
    evidenceGroupIds: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
    paragraphRefs: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
  });
  const parsed = z.array(eventSchema).max(120).safeParse(value);
  return (parsed.success ? parsed.data : [])
    .filter((event) => event.actor || event.action || event.object)
    .sort((left, right) => left.order - right.order)
    .map((event, index) => ({
      ...event,
      order: index + 1,
      actor: event.actor || "не указано",
      action: event.action || "событие",
      object: event.object || fallbackFocus || "объект",
      evidenceGroupIds: event.evidenceGroupIds || [],
      paragraphRefs: event.paragraphRefs || [],
    }));
}

async function buildTraceEventChain(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  bookTitle: string;
  question: string;
  focus?: string;
  anchors?: string[];
  maxEvents?: number;
}): Promise<{
  ledger: TraceEventChainLedger;
  groups: EvidenceGroup[];
  usage?: LanguageModelUsage;
  meta: Record<string, unknown>;
}> {
  const startedAt = nowMs();
  const question = String(params.question || "").replace(/\s+/g, " ").trim();
  const focus = String(params.focus || "").replace(/\s+/g, " ").trim();
  const anchors = normalizeTraceAnchors([focus, ...(params.anchors || [])].filter(Boolean));
  const topK = Math.max(8, Math.min(20, Number(params.maxEvents || 12) + 6));
  const liteModelId = resolveChatModelIdForTier(params.client.config.chatModel, "lite");
  const liteModel = createVertexChatModelFromConfig({
    apiKey: params.client.config.apiKey,
    baseUrl: params.client.config.baseUrl,
    chatModel: liteModelId,
    proxySource: params.client.config.proxySource,
  });
  const providerOptions = createVertexReasoningProviderOptions(liteModelId);

  const planStartedAt = nowMs();
  let planMs = 0;
  let planCompletion: Awaited<ReturnType<typeof generateText>> | null = null;
  let tracePlan = normalizeTraceEventChainPlan(
    {},
    {
      question,
      focus,
      anchors,
    }
  );
  try {
    planCompletion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: liteModel,
        temperature: 0,
        system:
          "Ты backend-модуль trace_event_chain_planner. Не отвечай пользователю. " +
          "Твоя задача - спланировать расследование цепочки событий в одной книге по формулировке вопроса. " +
          "Не используй память о конкретной книге, фильмы, wiki или внешний канон. " +
          "Не добавляй персонажей, места и события, которых нет в вопросе/focus/anchors. " +
          "Строй широкие поисковые запросы по объектам, участникам, действиям и переходам, а не готовый ответ. Верни только JSON без markdown.",
        prompt: JSON.stringify(
          {
            question,
            focus,
            anchors,
            outputSchema: {
              focus: "string",
              subjects: ["main object/person/theme to track"],
              anchors: ["short neutral search anchors from the input only"],
              searchQueries: ["broad retrieval query; not an answer claim"],
              transitionsToCheck: ["gap or transition that must be checked by evidence"],
            },
            rules: [
              "Сначала выдели, что именно надо отслеживать по книге: объект, персонажа, подозрение, тему или причинную линию.",
              "Для цепочки нужны широкие запросы: главный объект отдельно, участники отдельно, объект+участник, объект+ключевое действие из вопроса.",
              "Если отслеживается предмет или источник влияния, добавь broad queries про все появления этого объекта и изменения его состояния, владельца, места, контроля и последствий. Не подставляй конкретный переход, если его нет в вопросе.",
              "Для object-chain queries должны помогать найти начало, промежуточные появления и результат линии, но не должны заранее утверждать, кто что нашел, забрал, украл или сделал.",
              "Если вопрос просит 'как X привело к Y', добавь запросы для начала, середины и финального перехода, но не выдумывай конкретные факты.",
              "Не пиши в searchQueries готовые выводы, если они не названы пользователем.",
              "Дай 8-10 запросов. Они должны помогать найти все появления темы и переходы между ними, а не только самый релевантный фрагмент.",
            ],
          },
          null,
          2
        ),
        providerOptions,
      })
    );
    const rawPlanJson = extractJsonObjectFromText(String(planCompletion.text || ""));
    if (rawPlanJson) {
      tracePlan = normalizeTraceEventChainPlan(JSON.parse(rawPlanJson), {
        question,
        focus,
        anchors,
      });
    }
  } catch {
    tracePlan = normalizeTraceEventChainPlan(
      {},
      {
        question,
        focus,
        anchors,
      }
    );
  } finally {
    planMs = Math.round(nowMs() - planStartedAt);
  }

  const planUsage = normalizeLanguageModelUsage(planCompletion?.usage);
  const searchQueries: string[] = [];
  const seenSearchQueries = new Set<string>();
  for (const rawQuery of [
    ...(tracePlan.searchQueries.length ? tracePlan.searchQueries : [question, focus, anchors.join(" ")].filter(Boolean)),
  ]) {
    const query = String(rawQuery || "").replace(/\s+/g, " ").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seenSearchQueries.has(key)) continue;
    seenSearchQueries.add(key);
    searchQueries.push(query);
    if (searchQueries.length >= 12) break;
  }
  const perQueryTopK = Math.max(5, Math.min(10, Math.ceil(topK / Math.max(1, Math.min(3, searchQueries.length))) + 4));
  const sceneSearchTopK = Math.max(6, Math.min(12, perQueryTopK + 2));
  const [sceneSearchResults, searchResults, traceSearch] = await Promise.all([
    Promise.all(
      searchQueries.slice(0, 12).map((query) =>
        searchScenesTool({
          client: params.client,
          bookId: params.bookId,
          query,
          topK: sceneSearchTopK,
        }).catch(() => null)
      )
    ),
    Promise.all(
      searchQueries.slice(0, 12).map((query) =>
        searchCompiledRepairEvidence({
          client: params.client,
          bookId: params.bookId,
          query,
          requiredAnchors: tracePlan.anchors,
          order: "chronological",
          strategy: "default",
          topK: Math.max(4, Math.min(6, perQueryTopK)),
        }).catch((error) => ({
          groups: [],
          meta: {
            query,
            error: error instanceof Error ? error.message : String(error),
          },
        }))
      )
    ),
    tracePlan.anchors.length >= 2
      ? traceLineEvidence({
          client: params.client,
          bookId: params.bookId,
          anchors: tracePlan.anchors,
          topK: Math.max(8, Math.min(14, topK)),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const mergedSceneHitsByScore = mergeTraceSceneHits(sceneSearchResults).sort((left, right) => right.score - left.score);
  const perQuerySceneCoverage = sceneSearchResults.flatMap((result) => (result?.hits || []).slice(0, 4));
  const selectedScenes = dedupeTraceScenes([
    ...perQuerySceneCoverage,
    ...mergedSceneHitsByScore.slice(0, Math.max(12, Math.min(24, topK + 8))),
  ])
    .sort((left, right) =>
      left.chapterOrderIndex === right.chapterOrderIndex
        ? left.paragraphStart - right.paragraphStart
        : left.chapterOrderIndex - right.chapterOrderIndex
    )
    .slice(0, 40);
  const sceneTimelineGroups = await buildTraceSceneTimelineEvidence({
    bookId: params.bookId,
    scenes: selectedScenes,
    maxGroups: Math.max(36, Math.min(72, topK * 4)),
  });
  const perQueryCoverageGroups = searchResults.flatMap((result) => (result.groups || []).slice(0, 2));
  const paragraphSafetyGroups = mergeEvidenceCandidateGroups([
    ...perQueryCoverageGroups,
    ...searchResults.flatMap((result) => result.groups || []),
    ...(traceSearch?.groups || []),
  ])
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(topK, Math.min(32, searchQueries.length * 2 + 10)));
  let groups = mergeEvidenceCandidateGroups([...sceneTimelineGroups, ...paragraphSafetyGroups]).sort((left, right) =>
    left.chapterOrderIndex === right.chapterOrderIndex
      ? left.paragraphStart - right.paragraphStart
      : left.chapterOrderIndex - right.chapterOrderIndex
  );

  if (!groups.length) {
    return {
      ledger: {
        focus,
        chain: [],
        unknowns: ["Не удалось найти paragraph evidence для построения цепочки событий."],
        warnings: [],
        unsupportedClaims: [],
      },
      groups: [],
      meta: {
        totalMs: Math.round(nowMs() - startedAt),
        mode: "trace_event_chain",
        returned: 0,
        evidenceGroupCount: 0,
        search: searchResults[0]?.meta || null,
        searches: searchResults.map((result) => result.meta),
        sceneSearches: sceneSearchResults.map((result) =>
          result
            ? {
                returned: result.hits.length,
                totalMs: Math.round(result.totalMs),
                embeddingInputTokens: result.embeddingInputTokens,
                rerank: result.rerank,
              }
            : null
        ),
        selectedSceneCount: selectedScenes.length,
        sceneTimelineEvidenceCount: sceneTimelineGroups.length,
        traceSearch: traceSearch?.meta || null,
        tracePlan,
      },
    };
  }

  const maxEvents = Math.max(3, Math.min(24, Number(params.maxEvents || 12)));
  const localExtractionStartedAt = nowMs();
  const localExtractionUsages: LanguageModelUsage[] = [];
  const localEvents: TraceEventChainEvent[] = [];
  const localBatches: EvidenceGroup[][] = [];
  for (let index = 0; index < groups.length; index += 6) {
    localBatches.push(groups.slice(index, index + 6));
  }
  for (const [batchIndex, batch] of localBatches.entries()) {
    try {
      const localCompletion = await withSemaphore(chatCallSemaphore, async () =>
        generateText({
          model: liteModel,
          temperature: 0,
          system:
            "Ты backend-модуль trace_event_chain_local_extractor. Не отвечай пользователю. " +
            "Твоя задача - извлечь все локальные события из нескольких raw paragraph evidence groups. " +
            "Не делай итоговый ответ и не склеивай события между группами. Не используй память о книге или внешний канон. Верни только JSON без markdown.",
          prompt: JSON.stringify(
            {
              question,
              focus: tracePlan.focus || focus,
              subjects: tracePlan.subjects,
              batchIndex: batchIndex + 1,
              evidenceGroups: formatTraceEvidenceForPrompt(batch, 2400),
              outputSchema: {
                events: [
                  {
                    order: "number",
                    actor: "string",
                    action: "string",
                    object: "string",
                    target: "string optional",
                    place: "string optional",
                    timeHint: "string optional",
                    evidenceGroupIds: ["group id"],
                    paragraphRefs: ["ch17:p49"],
                    confidence: "high|medium|low",
                  },
                ],
              },
              rules: [
                "Пройди каждый evidenceGroup отдельно.",
                "Извлекай каждое явно написанное событие, которое относится к focus/subjects или меняет состояние, владельца, место, контроль, причину или результат.",
                "Если один абзац содержит несколько событий, верни несколько events с одним evidenceGroupId.",
                "Не обобщай два события в одно.",
                "Не превращай пассивное 'объект был/оказался в X' в активное 'персонаж нашел/получил'.",
                "Не добавляй place/target, если его нет в тексте события.",
              ],
            },
            null,
            2
          ),
          providerOptions,
        })
      );
      localExtractionUsages.push(localCompletion.usage);
      const rawLocalJson = extractJsonObjectFromText(String(localCompletion.text || ""));
      if (!rawLocalJson) continue;
      const parsedLocal = JSON.parse(rawLocalJson);
      const events = normalizeTraceEventArray(asRecord(parsedLocal).events, tracePlan.focus || focus || anchors[0] || "");
      localEvents.push(...events);
    } catch {
      // Local extraction is best-effort; the final investigator still sees raw evidence.
    }
  }
  const normalizedLocalEvents = localEvents.map((event, index) => ({
    ...event,
    order: index + 1,
  }));
  const completionStartedAt = nowMs();
  const runExtraction = async (retryHint?: string) =>
    withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: liteModel,
        temperature: 0,
        system:
          "Ты backend-модуль trace_event_chain_investigator. Не отвечай пользователю. " +
          "Твоя задача - расследовать цепочку событий внутри одной книги по raw paragraph evidence. " +
          "Работай как следователь: сначала восстанови карту найденных появлений в порядке книги, затем выдели события и переходы. " +
          "Не используй память о книге, scene summaries, фильмы, wiki, внешний канон или догадки. " +
          "Если evidence не показывает переход между двумя событиями, не склеивай их. Верни только JSON без markdown.",
        prompt: JSON.stringify(
          {
            bookTitle: params.bookTitle,
            question,
            investigationPlan: tracePlan,
            maxEvents,
            retryHint,
            localEvents: normalizedLocalEvents.slice(0, 80),
            evidenceGroups: formatTraceEvidenceForPrompt(groups, 3200),
            outputSchema: {
              focus: "string",
              evidenceMap: [
                {
                  evidenceGroupId: "group id",
                  extractedEvents: ["short event explicitly present in this group"],
                },
              ],
              chain: [
                {
                  order: "number",
                  actor: "string",
                  action: "string",
                  object: "string",
                  target: "string optional",
                  place: "string optional",
                  timeHint: "string optional",
                  evidenceGroupIds: ["group id"],
                  paragraphRefs: ["ch17:p39-p41"],
                  confidence: "high|medium|low",
                },
              ],
              unknowns: ["important transition or detail not found in evidence"],
              unsupportedClaims: ["claim that would be tempting but is not supported by paragraph evidence"],
              warnings: ["short diagnostic note"],
            },
            investigationAlgorithm: [
              "Не начинай с ответа. Сначала мысленно собери все найденные появления focus/subjects из evidenceGroups.",
              "localEvents - это предварительно извлеченные события из маленьких батчей. Используй их как главный черновик цепочки.",
              "Chain должен включать все localEvents, которые меняют состояние/владельца/контроль/причину/результат focus, если они не являются явным дублем.",
              "В поле evidenceMap пройди каждый evidenceGroup по отдельности и перечисли все явно написанные события внутри него. Если группа содержит два события, extractedEvents должен содержать оба.",
              "Сортируй события по chapterOrderIndex и paragraphStart, а не по релевантности.",
              "Из каждого evidenceGroup извлекай только событие, которое реально написано в тексте группы.",
              "Один evidenceGroup может содержать несколько событий. Если внутри одного фрагмента есть несколько глаголов изменения состояния/владения/причины (например: A избавился от объекта; B нашел объект; C забрал объект обратно), верни несколько событий с одним и тем же evidenceGroupIds.",
              "Chain строится из evidenceMap. Не разрешается пропускать explicit event из evidenceMap, если он меняет состояние, владельца, место, контроль, причину или финальный результат focus.",
              "Проверяй переходы: если объект/персонаж меняет владельца, место, состояние, мотив или роль, в цепочке нужен отдельный подтвержденный шаг.",
              "Если между двумя событиями есть скачок, занеси его в unknowns, а не заполняй догадкой.",
              "Если evidence говорит только 'объект был/оказался в X' и не называет активного действия персонажа, не превращай это в 'персонаж нашел/получил'. Запиши пассивное событие с actor='не указан' или занеси источник в unknowns.",
              "Запрещено использовать action='нашел/нашла/обнаружил/обнаружила/получил/получила', если в тексте evidence нет прямого глагола находки/обнаружения/получения для этого actor. Формулировка 'объект был в контейнере/вещах/книге/комнате' означает только 'объект был/оказался там'.",
              "Если событие говорит об избавлении/перемещении/передаче, но evidence не называет место или способ, не добавляй place/target и добавь недостающую деталь в unknowns, если она важна для ответа.",
              "Если в одном событии персонаж избавился от объекта, а в тексте той же или следующей группы сказано, что другое лицо его нашло, оба события обязательны в chain.",
              "Если в одном событии персонаж избавился от объекта, а в следующем кто-то выкрал объект у другого лица, между ними обязательно должно быть событие 'объект оказался у другого лица' или 'другое лицо нашло объект' с evidence. Если такого evidence нет в группах, добавь gap в unknowns.",
              "Для передач, находок, краж, подбрасывания, избавления, раскрытий и причин обязательно указывай actor и target/place только если они есть в paragraph evidence.",
              "Если вопрос про развитие/постепенность, верни начало, промежуточные шаги и финальный результат, если они есть в evidence.",
              "Если tempting claim можно вывести только из мета-знания или scene title, а в paragraph evidence его нет, добавь его в unsupportedClaims.",
              "Не делай события из пересказа вопроса. Событие должно ссылаться на evidenceGroupIds или paragraphRefs.",
            ],
          },
          null,
          2
        ),
        providerOptions,
      })
    );
  let completion = await runExtraction();
  const firstCompletion = completion;
  const rawJson = extractJsonObjectFromText(String(completion.text || ""));
  let parsedJson: unknown = {};
  if (rawJson) {
    try {
      parsedJson = JSON.parse(rawJson);
    } catch {
      parsedJson = {};
    }
  }
  const ledger = normalizeTraceEventChainLedger(parsedJson, focus || anchors[0] || "");
  let finalLedger = ledger;
  let retryCompletion: Awaited<ReturnType<typeof generateText>> | null = null;
  if (ledger.chain.length < Math.min(3, maxEvents) && groups.length >= 4) {
    retryCompletion = await runExtraction(
      "Первый результат слишком короткий для найденного evidence. Повтори расследование: пройди evidenceGroups по порядку книги и извлеки все подтвержденные переходы, не добавляя догадок."
    );
    const retryRawJson = extractJsonObjectFromText(String(retryCompletion.text || ""));
    if (retryRawJson) {
      try {
        const retryLedger = normalizeTraceEventChainLedger(JSON.parse(retryRawJson), focus || anchors[0] || "");
        if (retryLedger.chain.length > finalLedger.chain.length) {
          finalLedger = retryLedger;
          completion = retryCompletion;
        }
      } catch {
        // Keep first extraction.
      }
    }
  }
  const extractionUsage = normalizeLanguageModelUsage(firstCompletion.usage);
  const retryUsage = retryCompletion ? normalizeLanguageModelUsage(retryCompletion.usage) : undefined;
  const usage = mergeLanguageModelUsage(
    planCompletion?.usage,
    ...localExtractionUsages,
    firstCompletion.usage,
    retryCompletion?.usage
  );
  const pricing = resolveTokenPricing({
    chatModel: liteModelId,
    embeddingModel: params.client.config.embeddingModel,
  });
  const normalizedUsage = normalizeLanguageModelUsage(usage);
  const chatCostUsd =
    (normalizedUsage.inputTokens / 1_000_000) * pricing.chatInputPer1MUsd +
    (normalizedUsage.outputTokens / 1_000_000) * pricing.chatOutputPer1MUsd;

  return {
    ledger: {
      ...finalLedger,
      chain: finalLedger.chain.slice(0, maxEvents),
    },
    groups,
    usage,
    meta: {
      totalMs: Math.round(nowMs() - startedAt),
      mode: "trace_event_chain",
      returned: finalLedger.chain.length,
      evidenceGroupCount: groups.length,
      unknownCount: finalLedger.unknowns.length,
      unsupportedClaimCount: finalLedger.unsupportedClaims.length,
      model: liteModelId,
      planModel: liteModelId,
      extractionModel: liteModelId,
      planMs,
      localExtractionMs: Math.round(completionStartedAt - localExtractionStartedAt),
      localEventCount: normalizedLocalEvents.length,
      llmMs: Math.round(nowMs() - completionStartedAt),
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      chatCostUsd: roundMetric(chatCostUsd),
      tracePlan,
      searchQueryCount: searchQueries.length,
      search: searchResults[0]?.meta || null,
      searches: searchResults.map((result) => result.meta),
      sceneSearches: sceneSearchResults.map((result) =>
        result
          ? {
              returned: result.hits.length,
              totalMs: Math.round(result.totalMs),
              embeddingInputTokens: result.embeddingInputTokens,
              rerank: result.rerank,
            }
          : null
      ),
      selectedSceneCount: selectedScenes.length,
      selectedScenes: selectedScenes.slice(0, 24).map((scene) => ({
        sceneId: scene.sceneId,
        chapterOrderIndex: scene.chapterOrderIndex,
        chapterTitle: scene.chapterTitle,
        sceneIndex: scene.sceneIndex,
        paragraphStart: scene.paragraphStart,
        paragraphEnd: scene.paragraphEnd,
        score: scene.score,
        sceneCard: clampText(scene.sceneCard, 220),
      })),
      sceneTimelineEvidenceCount: sceneTimelineGroups.length,
      traceSearch: traceSearch?.meta || null,
      planInputTokens: planUsage.inputTokens,
      planOutputTokens: planUsage.outputTokens,
      extractionInputTokens: extractionUsage.inputTokens,
      extractionOutputTokens: extractionUsage.outputTokens,
      localExtractionInputTokens: localExtractionUsages.reduce(
        (sum, item) => sum + normalizeLanguageModelUsage(item).inputTokens,
        0
      ),
      localExtractionOutputTokens: localExtractionUsages.reduce(
        (sum, item) => sum + normalizeLanguageModelUsage(item).outputTokens,
        0
      ),
      retried: Boolean(retryCompletion && retryCompletion !== completion),
    },
  };
}

async function resolveChainInvestigationBoundary(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  question: string;
  modelId: string;
}): Promise<{ boundary: ChainInvestigationBoundary | null; usage?: LanguageModelUsage; meta: Record<string, unknown> }> {
  const startedAt = nowMs();
  const model = createVertexChatModelFromConfig({
    apiKey: params.client.config.apiKey,
    baseUrl: params.client.config.baseUrl,
    chatModel: params.modelId,
    proxySource: params.client.config.proxySource,
  });
  const providerOptions = createVertexReasoningProviderOptions(params.modelId);
  let completion: Awaited<ReturnType<typeof generateText>> | null = null;
  let parsed: Record<string, unknown> = {};
  try {
    completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model,
        temperature: 0,
        system:
          "Ты backend-модуль boundary_extractor. Не отвечай пользователю. " +
          "Определи, есть ли в вопросе ограничение по моменту книги: до/перед/к моменту/после/начиная с. " +
          "Не используй знания о книге. Верни только JSON без markdown.",
        prompt: JSON.stringify(
          {
            question: params.question,
            outputSchema: {
              hasBoundary: "boolean",
              boundaryType: "before|after|at|none",
              boundaryDescription: "string",
              boundarySearchQuery: "short search query for finding the boundary scene in this book",
            },
            rules: [
              "hasBoundary=true только если вопрос явно ограничивает ответ моментом книги.",
              "Если вопрос спрашивает 'до X' или 'ещё до X', boundaryType='before'.",
              "boundarySearchQuery должен искать сам момент X, а не ответ на вопрос.",
              "Не добавляй персонажей или события, которых нет в формулировке вопроса.",
            ],
          },
          null,
          2
        ),
        providerOptions,
      })
    );
    const rawJson = extractJsonObjectFromText(String(completion.text || ""));
    parsed = rawJson ? asRecord(JSON.parse(rawJson)) : {};
  } catch {
    parsed = {};
  }

  const hasBoundary = Boolean(parsed.hasBoundary);
  const boundaryType = String(parsed.boundaryType || "").trim();
  const query = String(parsed.boundarySearchQuery || "").replace(/\s+/g, " ").trim();
  if (!hasBoundary || boundaryType !== "before" || !query) {
    return {
      boundary: null,
      usage: completion?.usage,
      meta: {
        totalMs: Math.round(nowMs() - startedAt),
        hasBoundary,
        boundaryType: boundaryType || "none",
      },
    };
  }

  const sceneSearch = await searchScenesTool({
    client: params.client,
    bookId: params.bookId,
    query,
    topK: 6,
  }).catch(() => null);
  const scene = sceneSearch?.hits[0] || null;
  if (!scene) {
    return {
      boundary: null,
      usage: completion?.usage,
      meta: {
        totalMs: Math.round(nowMs() - startedAt),
        hasBoundary,
        boundaryType,
        boundarySearchQuery: query,
        boundarySceneFound: false,
      },
    };
  }

  return {
    boundary: {
      description: String(parsed.boundaryDescription || query).replace(/\s+/g, " ").trim(),
      query,
      sceneId: scene.sceneId,
      chapterOrderIndex: scene.chapterOrderIndex,
      chapterTitle: scene.chapterTitle,
      sceneIndex: scene.sceneIndex,
      paragraphStart: scene.paragraphStart,
      paragraphEnd: scene.paragraphEnd,
    },
    usage: completion?.usage,
    meta: {
      totalMs: Math.round(nowMs() - startedAt),
      hasBoundary,
      boundaryType,
      boundarySearchQuery: query,
      boundarySceneFound: true,
      boundaryScene: {
        sceneId: scene.sceneId,
        chapterOrderIndex: scene.chapterOrderIndex,
        chapterTitle: scene.chapterTitle,
        sceneIndex: scene.sceneIndex,
        paragraphStart: scene.paragraphStart,
        paragraphEnd: scene.paragraphEnd,
        sceneCard: clampText(scene.sceneCard, 220),
      },
      sceneSearch: sceneSearch
        ? {
            returned: sceneSearch.hits.length,
            embeddingInputTokens: sceneSearch.embeddingInputTokens,
            totalMs: Math.round(sceneSearch.totalMs),
          }
        : null,
    },
  };
}

async function buildChainInvestigationReport(params: {
  client: ReturnType<typeof createVertexClient>;
  bookId: string;
  bookTitle: string;
  question: string;
  focus?: string;
  anchors?: string[];
  maxSteps?: number;
}): Promise<{
  report: ChainInvestigationReport;
  ledger: TraceEventChainLedger;
  groups: EvidenceGroup[];
  usage?: LanguageModelUsage;
  meta: Record<string, unknown>;
}> {
  const startedAt = nowMs();
  const trace = await buildTraceEventChain({
    client: params.client,
    bookId: params.bookId,
    bookTitle: params.bookTitle,
    question: params.question,
    focus: params.focus,
    anchors: params.anchors,
    maxEvents: Math.max(8, Math.min(24, Number(params.maxSteps || 14))),
  });
  const liteModelId = resolveChatModelIdForTier(params.client.config.chatModel, "lite");
  const liteModel = createVertexChatModelFromConfig({
    apiKey: params.client.config.apiKey,
    baseUrl: params.client.config.baseUrl,
    chatModel: liteModelId,
    proxySource: params.client.config.proxySource,
  });
  const providerOptions = createVertexReasoningProviderOptions(liteModelId);
  const boundaryResult = await resolveChainInvestigationBoundary({
    client: params.client,
    bookId: params.bookId,
    question: params.question,
    modelId: liteModelId,
  });
  const boundary = boundaryResult.boundary;
  const skeletonGroups = boundary ? trace.groups.filter((group) => evidenceGroupIsBeforeBoundary(group, boundary)) : trace.groups;
  const skeletonLedger = boundary
    ? {
        ...trace.ledger,
        chain: trace.ledger.chain.filter((event) => traceEventIsBeforeBoundary(event, boundary)),
        warnings: [
          ...trace.ledger.warnings,
          `Boundary applied: only evidence before ${boundary.chapterTitle}, scene ${boundary.sceneIndex}, paragraph ${boundary.paragraphStart} is primary.`,
        ],
      }
    : trace.ledger;
  const skeletonStartedAt = nowMs();
  const completion = await withSemaphore(chatCallSemaphore, async () =>
    generateText({
      model: liteModel,
      temperature: 0,
      system:
        "Ты backend sub-agent chain_investigator. Не отвечай пользователю красивым текстом. " +
        "Твоя задача - превратить расследование цепочки в готовый answerSkeleton: причинно-событийные claim-шаги с доказательствами. " +
        "Не используй память о книге, фильмы, wiki, scene title как доказательство или внешний канон. " +
        "Каждый шаг должен быть либо explicit, либо inferred, либо gap. Верни только JSON без markdown.",
      prompt: JSON.stringify(
        {
          bookTitle: params.bookTitle,
          question: params.question,
          boundary,
          traceLedger: skeletonLedger,
          traceMeta: {
            tracePlan: trace.meta.tracePlan,
            selectedScenes: trace.meta.selectedScenes,
          },
          evidenceGroups: formatTraceEvidenceForPrompt(skeletonGroups, 2600),
          outputSchema: {
            focus: "string",
            boundary: "optional boundary/cutoff from the question, if any",
            answerSkeleton: [
              {
                order: "number",
                claim: "human-readable causal/event step, e.g. 'Люциус подбрасывает дневник Джинни через учебники'",
                support: "explicit|inferred|gap",
                evidence: [
                  {
                    evidenceGroupId: "group id optional",
                    ref: "ch17:p39-p41",
                    proves: "what this exact paragraph evidence proves",
                    quote: "short exact fragment optional",
                  },
                ],
                caveat: "optional limitation, especially for inferred/gap",
                confidence: "high|medium|low",
              },
            ],
            gaps: ["missing bridge or unavailable proof"],
            rejectedClaims: ["tempting claim rejected because evidence does not prove it"],
            warnings: ["diagnostic notes"],
          },
          rules: [
            "answerSkeleton должен быть готовой цепочкой для main chat. Main chat не должен пересобирать причинность сам.",
            "Если boundary передан, answerSkeleton и evidence должны использовать только evidenceGroups до boundary. Не используй поздние главы/сцены как основные claim-шаги.",
            "Если question содержит несколько явно названных частей/примеров, answerSkeleton должен закрыть каждую часть отдельным claim или gap.",
            "Если question спрашивает 'в каких сценах' или 'сильнее всего', не прячь конкретные сцены в общий claim: отдельные провалы/эпизоды должны быть отдельными claim-шагами, если они есть в evidence.",
            "Если question спрашивает 'по каким признакам', claim должен быть реальным признаком расследования в книге, а не случайным совпадением слова в нерелевантной сцене.",
            "Не превращай generic mention существительного в clue. Например, упоминание трубы в бытовой сцене не является clue, если evidence не связывает её с расследованием, чудовищем, школой, жертвами или последующим выводом персонажей.",
            "Для clue/synthesis questions rejectedClaims должен включать нерелевантные совпадения слов, если они были найдены в evidence, но не доказывают признак.",
            "Пиши claim человечески и полно: кто что сделал, с чем, кому, к чему это привело.",
            "Не делай сухие поля actor/action/object в claim. Claim должен читаться как шаг ответа.",
            "support='explicit' только если evidence прямо говорит этот шаг.",
            "support='inferred' только если шаг надежно следует из нескольких paragraph evidence. Обязательно объясни в evidence.proves, что именно доказывает каждый ref.",
            "support='gap' только если шаг нужен для полной цепочки, но evidence не найден. Для gap не выдумывай ref.",
            "Если вопрос содержит ограничение вида 'до/после/к моменту/пока еще не', выдели boundary. Evidence после boundary нельзя использовать в answerSkeleton для вопроса о том, что было заметно до boundary.",
            "Если traceLedger содержит unsupportedClaims, перенеси релевантные пункты в rejectedClaims, если evidence их всё еще не подтверждает.",
            "Если traceLedger содержит событие, но оно сформулировано слишком узко или технически, перепиши его в claim без потери evidence.",
            "Не добавляй мосты из общих знаний. Если bridge нужен, но не доказан, делай gap.",
            "Запрещено писать 'подбросил/подбросила X кому-то', 'передал/передала X кому-то', 'оставил/оставила X для кого-то', если paragraph evidence прямо не называет и действие, и получателя.",
            "Если evidence говорит только 'персонаж попытался избавиться от объекта', а позже другой персонаж его нашел, делай два отдельных шага: 'попытался избавиться' и 'другой персонаж нашел/у него оказался объект'. Не склеивай это в намеренную передачу.",
            "Если между 'избавился от объекта' и 'другой персонаж нашел объект' не найдено прямого механизма, добавь gap о неизвестном способе перехода.",
            "Не объединяй события с разными actor в один claim, если между ними меняется владелец, место, контроль или причинная роль объекта.",
            "Сохраняй важные промежуточные переходы из traceLedger: находка, потеря, кража, возврат, новое использование объекта должны быть отдельными claim-шагами.",
            "Сортируй answerSkeleton по порядку книги или по причинной последовательности, если причинный порядок явно отличается.",
          ],
        },
        null,
        2
      ),
      providerOptions,
    })
  );
  const rawJson = extractJsonObjectFromText(String(completion.text || ""));
  let report = normalizeChainInvestigationReport(rawJson ? JSON.parse(rawJson) : {}, trace.ledger.focus);
  const reviewStartedAt = nowMs();
  let reviewCompletion: Awaited<ReturnType<typeof generateText>> | null = null;
  try {
    reviewCompletion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: liteModel,
        temperature: 0,
        system:
          "Ты backend quality reviewer для chain_investigator. Не отвечай пользователю. " +
          "Проверь answerSkeleton на фактическую поддержку, покрытие вопроса и нерелевантные совпадения слов. " +
          "Если есть ошибки, верни исправленный ChainInvestigationReport. Если ошибок нет, верни тот же report. Только JSON без markdown.",
        prompt: JSON.stringify(
          {
            question: params.question,
            boundary,
            draftReport: report,
            evidenceGroups: formatTraceEvidenceForPrompt(skeletonGroups, 2200),
            outputSchema: {
              focus: "string",
              boundary: "optional string",
              answerSkeleton: [
                {
                  order: "number",
                  claim: "corrected human-readable claim",
                  support: "explicit|inferred|gap",
                  evidence: [
                    {
                      evidenceGroupId: "group id optional",
                      ref: "ch17:p39-p41",
                      proves: "what this exact evidence proves",
                      quote: "short exact fragment optional",
                    },
                  ],
                  caveat: "optional string",
                  confidence: "high|medium|low",
                },
              ],
              gaps: ["string"],
              rejectedClaims: ["string"],
              warnings: ["string"],
            },
            reviewRules: [
              "Удаляй claim, если его ref доказывает только совпадение слова, но не является признаком/событием для вопроса.",
              "Не допускай бытовые/случайные упоминания как clues, если evidence не связывает их с расследованием, фокусом вопроса или последующим выводом персонажей.",
              "Если question перечисляет элементы через запятые или союз 'и', каждый элемент должен быть закрыт claim/gap/rejectedClaim.",
              "Если question просит конкретные сцены, проверь, что draft не заменил несколько разных сцен одним общим claim.",
              "Проверяй, что evidence.proves действительно доказывает claim, а не просто находится рядом по теме.",
              "Если claim склеивает разные события с разными actor без прямого bridge в evidence, раздели claim или добавь gap.",
              "Не добавляй новые факты вне evidenceGroups. Можно добавлять только claim-и, которые прямо поддержаны evidenceGroups.",
              "Сохраняй boundary: поздние факты после boundary не должны попадать в answerSkeleton.",
            ],
          },
          null,
          2
        ),
        providerOptions,
      })
    );
    const reviewRawJson = extractJsonObjectFromText(String(reviewCompletion.text || ""));
    if (reviewRawJson) {
      const reviewedReport = normalizeChainInvestigationReport(JSON.parse(reviewRawJson), report.focus);
      if (reviewedReport.answerSkeleton.length) {
        report = reviewedReport;
      }
    }
  } catch {
    // Keep first skeleton when review fails.
  }
  const usage = mergeLanguageModelUsage(trace.usage, boundaryResult.usage, completion.usage, reviewCompletion?.usage);
  const normalizedUsage = normalizeLanguageModelUsage(usage);
  const pricing = resolveTokenPricing({
    chatModel: liteModelId,
    embeddingModel: params.client.config.embeddingModel,
  });
  const chatCostUsd =
    (normalizedUsage.inputTokens / 1_000_000) * pricing.chatInputPer1MUsd +
    (normalizedUsage.outputTokens / 1_000_000) * pricing.chatOutputPer1MUsd;

  return {
    report,
    ledger: trace.ledger,
    groups: trace.groups,
    usage,
    meta: {
      ...trace.meta,
      mode: "chain_investigator",
      traceMode: trace.meta.mode,
      skeletonModel: liteModelId,
      boundary: boundary
        ? {
            description: boundary.description,
            query: boundary.query,
            chapterOrderIndex: boundary.chapterOrderIndex,
            chapterTitle: boundary.chapterTitle,
            sceneIndex: boundary.sceneIndex,
            paragraphStart: boundary.paragraphStart,
            paragraphEnd: boundary.paragraphEnd,
          }
        : null,
      boundaryMeta: boundaryResult.meta,
      skeletonEvidenceGroupCount: skeletonGroups.length,
      skeletonMs: Math.round(nowMs() - skeletonStartedAt),
      reviewMs: Math.round(nowMs() - reviewStartedAt),
      reviewed: Boolean(reviewCompletion),
      totalMs: Math.round(nowMs() - startedAt),
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      chatCostUsd: roundMetric(chatCostUsd),
      answerSkeletonCount: report.answerSkeleton.length,
      gapCount: report.gaps.length,
      rejectedClaimCount: report.rejectedClaims.length,
    },
  };
}

export async function debugTraceEventChainForBook(params: {
  bookId: string;
  question: string;
  focus?: string;
  anchors?: string[];
  maxEvents?: number;
}) {
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

  const result = await buildTraceEventChain({
    client,
    bookId: book.id,
    bookTitle: book.title,
    question: params.question,
    focus: params.focus,
    anchors: params.anchors,
    maxEvents: params.maxEvents,
  });

  return {
    ledger: result.ledger,
    groups: result.groups.map(formatEvidenceGroupForPrompt),
    meta: result.meta,
  };
}

export async function debugChainInvestigatorForBook(params: {
  bookId: string;
  question: string;
  focus?: string;
  anchors?: string[];
  maxSteps?: number;
}) {
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

  const result = await buildChainInvestigationReport({
    client,
    bookId: book.id,
    bookTitle: book.title,
    question: params.question,
    focus: params.focus,
    anchors: params.anchors,
    maxSteps: params.maxSteps,
  });

  return {
    report: result.report,
    ledger: result.ledger,
    groups: result.groups.map(formatEvidenceGroupForPrompt),
    meta: result.meta,
  };
}

function createCompiledAnswerRepairTools(params: {
  bookId: string;
  client: ReturnType<typeof createVertexClient>;
  toolRuns: ChatToolRun[];
  capture: CompiledAnswerRepairCapture;
  enabledTools: readonly CompiledAnswerRepairToolName[];
  maxToolExecutions?: number;
}) {
  const enabled = new Set(params.enabledTools);
  const maxToolExecutions = Math.max(0, Math.floor(Number(params.maxToolExecutions ?? params.enabledTools.length)));
  let executedToolCount = 0;
  const reserveToolExecution = (toolName: string) => {
    if (executedToolCount >= maxToolExecutions) {
      params.toolRuns.push({
        tool: `repair_${toolName}`,
        args: {},
        resultMeta: {
          skipped: true,
          reason: "repair_tool_budget_exhausted",
          maxToolExecutions,
        },
      });
      return false;
    }
    executedToolCount += 1;
    return true;
  };

  return {
    ...(enabled.has("search_evidence")
      ? {
          search_evidence: tool({
            description:
              "Точечный repair-поиск маленьких evidence groups по абзацам и deterministic fragments. Используй только чтобы закрыть дыру в initial evidence pack, missingAnchors или важную часть вопроса.",
            inputSchema: z.object({
              query: z.string().trim().min(1).max(800),
              requiredAnchors: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
              scope: z
                .object({
                  chapterIds: z.array(z.string().trim().min(1)).max(8).optional(),
                  sceneIds: z.array(z.string().trim().min(1)).max(8).optional(),
                })
                .optional(),
              order: z.enum(["relevance", "chronological"]).optional(),
              strategy: z.enum(["default", "scene_first"]).optional(),
              topK: z.coerce.number().int().min(1).max(12).optional(),
            }),
            execute: async ({ query, requiredAnchors, scope, order, strategy, topK }) => {
              if (!reserveToolExecution("search_evidence")) {
                return {
                  evidenceGroups: [],
                  meta: {
                    mode: "repair_search",
                    returned: 0,
                    skipped: true,
                    reason: "repair_tool_budget_exhausted",
                  },
                };
              }
              const result = await searchCompiledRepairEvidence({
                client: params.client,
                bookId: params.bookId,
                query,
                requiredAnchors,
                scope,
                order,
                strategy,
                topK,
              });
              params.capture.evidenceGroups = [...params.capture.evidenceGroups, ...result.groups].slice(-24);
              params.toolRuns.push({
                tool: "repair_search_evidence",
                args: {
                  query,
                  requiredAnchors: requiredAnchors || [],
                  scope: scope || {},
                  order: order || "relevance",
                  strategy: strategy || "default",
                  topK: topK || 6,
                },
                resultMeta: result.meta,
              });

              return {
                evidenceGroups: result.groups.map(formatEvidenceGroupForPrompt),
                meta: result.meta,
              };
            },
          }),
        }
      : {}),
    ...(enabled.has("read_passages")
      ? {
          read_passages: tool({
            description:
              "Дочитывает соседние абзацы вокруг уже найденного места. Не используй для полного чтения сцены; расширяй один диапазон вместо нескольких перекрывающихся вызовов.",
            inputSchema: z.object({
              ranges: z
                .array(
                  z.object({
                    chapterId: z.string().trim().min(1),
                    paragraphStart: z.coerce.number().int().min(1),
                    paragraphEnd: z.coerce.number().int().min(1),
                  })
                )
                .min(1)
                .max(3),
              expandBefore: z.coerce.number().int().min(0).max(8).optional(),
              expandAfter: z.coerce.number().int().min(0).max(8).optional(),
              maxChars: z.coerce.number().int().min(1000).max(12000).optional(),
            }),
            execute: async ({ ranges, expandBefore, expandAfter, maxChars }) => {
              if (!reserveToolExecution("read_passages")) {
                return {
                  passages: [],
                  meta: {
                    skipped: true,
                    reason: "repair_tool_budget_exhausted",
                  },
                };
              }
              const startedAt = nowMs();
              const before = Math.max(0, Math.min(8, Number(expandBefore || 0)));
              const after = Math.max(0, Math.min(8, Number(expandAfter || 0)));
              const charLimit = Math.max(1000, Math.min(12000, Number(maxChars || 6000)));
              const slices: ParagraphSliceResult[] = [];
              for (const range of ranges || []) {
                const start = Math.max(1, Number(range.paragraphStart || 1) - before);
                const end = Math.max(start, Number(range.paragraphEnd || range.paragraphStart || 1) + after);
                const slice = await getParagraphSliceTool({
                  bookId: params.bookId,
                  chapterId: String(range.chapterId || "").trim(),
                  paragraphStart: start,
                  paragraphEnd: end,
                });
                if (slice) slices.push(slice);
              }
              params.capture.paragraphSlices = [...params.capture.paragraphSlices, ...slices].slice(-12);
              params.toolRuns.push({
                tool: "repair_read_passages",
                args: {
                  ranges,
                  expandBefore: before,
                  expandAfter: after,
                  maxChars: charLimit,
                },
                resultMeta: {
                  totalMs: Math.round(nowMs() - startedAt),
                  returned: slices.length,
                  paragraphCount: slices.reduce((sum, slice) => sum + Math.max(0, slice.paragraphEnd - slice.paragraphStart + 1), 0),
                },
              });

              let remainingChars = charLimit;
              return {
                passages: slices.map((slice) => {
                  const text = clampText(slice.text, remainingChars);
                  remainingChars = Math.max(0, remainingChars - text.length);
                  return {
                    chapterId: slice.chapterId,
                    chapterOrderIndex: slice.chapterOrderIndex,
                    chapterTitle: slice.chapterTitle,
                    paragraphStart: slice.paragraphStart,
                    paragraphEnd: slice.paragraphEnd,
                    text,
                  };
                }),
              };
            },
          }),
        }
      : {}),
  };
}

function createEvidenceToolChatSystemPrompt(params: {
  bookTitle: string;
  toolsEnabled: boolean;
  toolPolicy: ChatToolPolicy;
  searchPlan?: BookChatPlannerSearchPlan;
}) {
  const lines = [
    `Ты литературный ассистент по одной книге: "${params.bookTitle}".`,
    "КРИТИЧНО: внутренние рассуждения (reasoning/thoughts) веди только на русском языке.",
    "",
    "Не используй память, внешние знания, другие книги, фильмы, фанатские знания или догадки.",
    "Источником фактов являются только результаты инструментов по этой книге.",
  ];

  if (!params.toolsEnabled) {
    lines.push(
      "",
      "Инструменты недоступны. На small-talk и мета-вопросы отвечай обычно. Если пользователь спрашивает содержание книги, честно скажи, что без поиска по книге не можешь надежно ответить."
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "Доступные инструменты:",
    "- search_scenes: навигационный поиск по сценам/search units. Используй как карту книги.",
    "- search_paragraphs: поиск доказательных абзацев по semantic+lexical. Кроме отдельных hits может вернуть primaryEvidenceSlices/expandedSlices: backend сам расширяет плотный кластер найденных абзацев в непрерывный диапазон соседних параграфов.",
    "- read_passages: ручное чтение непрерывного диапазона абзацев вокруг уже найденного места. Используй только когда search_paragraphs не дал достаточно полного slice или нужен соседний контекст.",
    "",
    "Маршрутизация:",
    params.toolPolicy === "required"
      ? "- Это книжный вопрос: перед ответом обязательно вызови search_scenes или search_paragraphs."
      : "- Если это small-talk или мета-вопрос о чате, отвечай без инструментов. Если вопрос касается содержания книги, вызови search_scenes или search_paragraphs.",
    "- Для простого факта обычно начинай с search_paragraphs.",
    "- Для цепочек, улик, развития темы, сравнений и последовательностей сначала вызови search_scenes широким запросом, затем search_paragraphs по 1-3 уточняющим запросам.",
    "- Сцены используй только как карту: они помогают понять, где искать, но не являются окончательным доказательством точных деталей.",
    "- Доказательства бери из search_paragraphs и read_passages.",
    "- Если search_paragraphs вернул primaryEvidenceSlices или expandedSlices, сначала прочитай каждый такой непрерывный фрагмент целиком: начало, середину и конец. Для цепочек эти slices важнее отдельных top hits.",
    "- Для цепочек предпочитай широкий search_paragraphs, потому что он может автоматически вернуть диапазон вроде 5-30 вокруг hits 10/15/20. Не заменяй это короткими read_passages по маленьким кускам.",
    "- Если search_paragraphs нашёл нужную область, но expandedSlices нет или цепочка всё ещё неполная, вызови read_passages один раз на более широкий диапазон.",
    "- Не вызывай несколько перекрывающихся read_passages; расширяй диапазон одним запросом.",
    "- Не ищи ради стиля. Инструменты нужны только для фактов и доказательств.",
    "",
    "Правила фактической точности:",
    "- Твоя задача - точно восстановить ответ, а не красиво угадать.",
    "- Сначала разбей вопрос на все смысловые части и закрой каждую.",
    "- Paragraph evidence и passages - главное доказательство. Scene cards/summaries/facts - только карта, где искать; не используй их как единственное доказательство для фактов о передаче предметов, факультетах, происхождении, мотивах и причинных связях.",
    "- Не добавляй мосты между событиями, если их нет в paragraph evidence/passages. Особенно осторожно с тем, кто кому дал/подсунул/нашел/украл предмет, кто где учился, кто к какой группе относится, кто что знал или хотел.",
    '- Не усиливай формулировку evidence: "говорит на языке со времён X" не значит "наследник X"; "похож" не значит "одинаковый"; "подозревает" не значит "доказано".',
    '- Если утверждение говорит персонаж, формулируй как "персонаж говорит/утверждает", пока paragraph evidence/passages не подтверждают это независимо.',
    "- Для цепочек событий перечисляй только подтвержденные звенья по порядку. Если важное звено не найдено, скажи, что в данных оно не показано.",
    "- Если после поиска данных мало, скажи, что найденные фрагменты не позволяют надежно подтвердить деталь.",
    "- Отвечай на русском, по делу, без описания внутренних шагов."
  );

  const searchPlan = params.searchPlan;
  const plannerQueryGroups =
    searchPlan && searchPlan.queryGroups.length
      ? searchPlan.queryGroups
      : searchPlan && searchPlan.searchQueries.length
        ? [
            {
              part: "Основной вопрос",
              searchQueries: searchPlan.searchQueries,
              broadQueries: searchPlan.broadQueries,
              focusedQueries: searchPlan.focusedQueries,
            },
          ]
        : [];
  if (plannerQueryGroups.length) {
    lines.push(
      "",
      "Planner search queries (not evidence):",
      ...plannerQueryGroups.flatMap((group, groupIndex) => [
        `Group ${groupIndex + 1}: ${group.part || "часть вопроса"}`,
        group.broadQueries.length
          ? `- broadQueries: ${group.broadQueries.map((query, index) => `${index + 1}. ${query}`).join(" | ")}`
          : "",
        group.focusedQueries.length
          ? `- focusedQueries: ${group.focusedQueries.map((query, index) => `${index + 1}. ${query}`).join(" | ")}`
          : "",
        group.searchQueries.length
          ? `- recommendedSearchQueries: ${group.searchQueries.map((query, index) => `${index + 1}. ${query}`).join(" | ")}`
          : "",
      ]),
      "",
      "Как использовать Planner search queries:",
      "- Это не доказательства, не факты и не готовый ответ. Это только варианты запросов к инструментам.",
      "- Не используй названия групп и текст query как evidence. Любое утверждение в ответе должно подтверждаться paragraph evidence/passages.",
      "- Для каждого Group, который соответствует отдельной части вопроса, сделай отдельный поиск: search_scenes для карты при необходимости и обязательно search_paragraphs для доказательств.",
      "- Не закрывай многосоставный вопрос одним search_paragraphs, если он не дал evidence по всем группам.",
      "- Если query из группы ничего не нашёл, переформулируй его сам, но не заменяй эту часть ответа догадкой."
    );
  }

  return lines.join("\n");
}

function createEvidenceToolChatPrepareStep(params: {
  toolsEnabled: boolean;
  toolPolicy: ChatToolPolicy;
  maxSteps: number;
}) {
  if (!params.toolsEnabled) return undefined;

  return ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber >= params.maxSteps - 1) {
      return {
        toolChoice: "none" as const,
      };
    }

    return {
      toolChoice: stepNumber === 0 && params.toolPolicy === "required" ? ("required" as const) : ("auto" as const),
    };
  };
}

function inferSearchEvidenceStrategy(params: {
  userQuestion: string;
  query: string;
  order?: ChatEvidenceOrder;
  requestedStrategy?: SearchEvidenceStrategy;
}): SearchEvidenceStrategy {
  if (params.requestedStrategy === "scene_first") return "scene_first";

  const profile = classifyBookChatQuestion(params.userQuestion);
  if (!profile.isBookQuestion || profile.isLikelySmallTalk || profile.isSimpleBookQuestion) return "default";

  const combined = `${params.userQuestion}\n${params.query}`.toLowerCase();
  const needsSceneMap =
    params.order === "chronological" ||
    profile.isComplexBookQuestion ||
    /(цепоч|последовательност|шаг за шагом|улики|разрознен|в разных главах|как меняется|подводит|в каких сценах|по ходу|постепенно|сравни|доказывают|почему)/iu.test(
      combined
    );

  return needsSceneMap ? "scene_first" : "default";
}

function createEvidenceToolChatTools(params: {
  bookId: string;
  bookTitle: string;
  userQuestion: string;
  client: ReturnType<typeof createVertexClient>;
  toolRuns: ChatToolRun[];
  capture: EvidenceToolChatCapture;
  maxToolExecutions: number;
}) {
  let executedToolCount = 0;
  const maxToolExecutions = Math.max(0, Math.floor(Number(params.maxToolExecutions || 0)));
  const reserveToolExecution = (toolName: string) => {
    if (executedToolCount >= maxToolExecutions) {
      params.toolRuns.push({
        tool: toolName,
        args: {},
        resultMeta: {
          skipped: true,
          reason: "tool_budget_exhausted",
          maxToolExecutions,
        },
      });
      return false;
    }
    executedToolCount += 1;
    return true;
  };

  return {
    search_scenes: tool({
      description:
        "Навигационный поиск по сценам/search units. Используй для сложных вопросов как карту книги; точные факты потом проверяй через search_paragraphs/read_passages.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(800),
        topK: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      }),
      execute: async ({ query, topK }) => {
        if (!reserveToolExecution("search_scenes")) {
          return {
            hits: [],
            sceneIds: [],
            meta: {
              returned: 0,
              skipped: true,
              reason: "tool_budget_exhausted",
            },
          };
        }

        const safeQuery = String(query || "").trim();
        const safeTopK = Math.max(
          SEARCH_PROMPT_MIN_TOP_K,
          Math.min(SEARCH_PROMPT_MAX_TOP_K, Number(topK || defaultSearchTopK(safeQuery)))
        );
        const search = await searchScenesTool({
          client: params.client,
          bookId: params.bookId,
          query: safeQuery,
          topK: safeTopK,
          context: await ensureBookSearchContext(params.bookId),
        });
        params.toolRuns.push({
          tool: "search_scenes",
          args: {
            query: safeQuery,
            topK: safeTopK,
          },
          resultMeta: {
            mode: "scene_map",
            returned: search.hits.length,
            embeddingRows: search.embeddingRows,
            embeddingInputTokens: search.embeddingInputTokens,
            lexicalParagraphHits: search.lexicalParagraphHits,
            lexicalSceneCandidates: search.lexicalSceneCandidates,
            semanticConfidence: search.semanticConfidence,
            hybridMode: search.hybridMode,
            rerank: search.rerank,
            totalMs: search.totalMs,
          },
        });

        return {
          hits: formatSearchHitsForPrompt(search.hits.slice(0, safeTopK)),
          sceneIds: search.hits.map((item) => item.sceneId),
          meta: {
            returned: search.hits.length,
            mode: "scene_map",
            hybridMode: search.hybridMode,
            semanticConfidence: search.semanticConfidence,
          },
        };
      },
    }),
    ...(TRACE_EVENT_CHAIN_TOOL_ENABLED
      ? {
          trace_event_chain: tool({
            description:
              "Расследует ledger цепочки событий по raw paragraph evidence. Используй для вопросов про постепенную цепочку, передачу/нахождение/кражу предмета, причинность, кто кому что сделал и как одно событие привело к другому. Возвращает chain + unknowns + unsupportedClaims; unknowns/unsupportedClaims нельзя заполнять догадками.",
            inputSchema: z.object({
              question: z.string().trim().min(1).max(1200).optional(),
              focus: z.string().trim().min(1).max(200).optional(),
              anchors: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
              maxEvents: z.coerce.number().int().min(3).max(20).optional(),
            }),
            execute: async ({ question, focus, anchors, maxEvents }) => {
              if (!reserveToolExecution("trace_event_chain")) {
                return {
                  chain: [],
                  unknowns: [],
                  evidenceGroups: [],
                  meta: {
                    returned: 0,
                    skipped: true,
                    reason: "tool_budget_exhausted",
                  },
                };
              }

              const safeQuestion = String(question || params.userQuestion || "").replace(/\s+/g, " ").trim();
              const safeFocus = String(focus || "").replace(/\s+/g, " ").trim();
              const safeAnchors = normalizeTraceAnchors(anchors);
              const startedAt = nowMs();
              try {
                const result = await buildTraceEventChain({
                  client: params.client,
                  bookId: params.bookId,
                  bookTitle: params.bookTitle,
                  question: safeQuestion,
                  focus: safeFocus,
                  anchors: safeAnchors,
                  maxEvents,
                });
                params.capture.evidenceGroups = [...params.capture.evidenceGroups, ...result.groups].slice(-32);
                params.toolRuns.push({
                  tool: "trace_event_chain",
                  args: {
                    question: safeQuestion,
                    focus: safeFocus,
                    anchors: safeAnchors,
                    maxEvents: maxEvents || 12,
                  },
                  resultMeta: {
                    ...result.meta,
                    ledgerPreview: {
                      focus: result.ledger.focus,
                      chain: result.ledger.chain.slice(0, 16),
                      unknowns: result.ledger.unknowns,
                      unsupportedClaims: result.ledger.unsupportedClaims,
                      warnings: result.ledger.warnings,
                      evidenceRefs: result.groups.slice(0, 24).map((group) => ({
                        id: group.id,
                        chapterOrderIndex: group.chapterOrderIndex,
                        paragraphStart: group.paragraphStart,
                        paragraphEnd: group.paragraphEnd,
                        text: clampText(group.text, 360),
                      })),
                    },
                    totalMs: Math.round(nowMs() - startedAt),
                  },
                });

                return {
                  focus: result.ledger.focus,
                  chain: result.ledger.chain,
                  unknowns: result.ledger.unknowns,
                  unsupportedClaims: result.ledger.unsupportedClaims,
                  warnings: result.ledger.warnings,
                  evidenceGroups: result.groups.map(formatEvidenceGroupForPrompt),
                  meta: {
                    mode: "trace_event_chain",
                    returned: result.ledger.chain.length,
                    evidenceGroupCount: result.groups.length,
                    unknownCount: result.ledger.unknowns.length,
                    unsupportedClaimCount: result.ledger.unsupportedClaims.length,
                  },
                };
              } catch (error) {
                params.toolRuns.push({
                  tool: "trace_event_chain",
                  args: {
                    question: safeQuestion,
                    focus: safeFocus,
                    anchors: safeAnchors,
                    maxEvents: maxEvents || 12,
                  },
                  resultMeta: {
                    mode: "trace_event_chain",
                    totalMs: Math.round(nowMs() - startedAt),
                    returned: 0,
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
                return {
                  chain: [],
                  unknowns: ["Не удалось построить проверенную цепочку событий по найденным фрагментам."],
                  evidenceGroups: [],
                  meta: {
                    mode: "trace_event_chain",
                    returned: 0,
                    error: "trace_event_chain_failed",
                  },
                };
              }
            },
          }),
        }
      : {}),
    search_paragraphs: tool({
      description:
        "Поиск доказательных абзацев по semantic+lexical. Кроме hits возвращает evidenceGroups и может вернуть primaryEvidenceSlices/expandedSlices: backend автоматически расширяет плотный кластер hits в непрерывный диапазон соседних параграфов. Для цепочек/причин/последовательностей используй expandedSlices как основной контекст; read_passages нужен только для ручного добора, если slice неполный.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(800),
        scope: z
          .object({
            chapterIds: z.array(z.string().trim().min(1)).max(8).optional(),
            sceneIds: z.array(z.string().trim().min(1)).max(8).optional(),
          })
          .optional(),
        topK: z.coerce.number().int().min(1).max(MAX_HYBRID_PARAGRAPH_RESULTS).optional(),
      }),
      execute: async ({ query, scope, topK }) => {
        if (!reserveToolExecution("search_paragraphs")) {
          return {
            hits: [],
            evidenceGroups: [],
            primaryEvidenceSlices: [],
            meta: {
              returned: 0,
              skipped: true,
              reason: "tool_budget_exhausted",
            },
          };
        }

        const safeQuery = String(query || "").trim();
        const safeTopK = Math.max(
          HYBRID_PARAGRAPH_PROMPT_MIN_TOP_K,
          Math.min(HYBRID_PARAGRAPH_PROMPT_MAX_TOP_K, Number(topK || DEFAULT_HYBRID_PARAGRAPH_TOP_K))
        );
        const context = await ensureBookSearchContext(params.bookId);
        const search = await searchParagraphsHybridTool({
          client: params.client,
          bookId: params.bookId,
          query: safeQuery,
          topK: safeTopK,
          context,
        });

        const chapterScope = new Set((scope?.chapterIds || []).map((value) => String(value || "").trim()).filter(Boolean));
        const sceneIds = Array.from(
          new Set((scope?.sceneIds || []).map((value) => String(value || "").trim()).filter(Boolean))
        ).slice(0, 8);
        const scopedScenes = sceneIds.length
          ? await getSceneContextTool({
              bookId: params.bookId,
              primarySceneIds: sceneIds,
              neighborWindow: 0,
              maxScenes: sceneIds.length,
            })
          : [];
        const isInSceneScope = (hit: HybridParagraphSearchHit) =>
          !scopedScenes.length ||
          scopedScenes.some(
            (scene) =>
              scene.chapterId === hit.chapterId &&
              hit.paragraphIndex >= scene.paragraphStart &&
              hit.paragraphIndex <= scene.paragraphEnd
          );
        const scopedHits =
          chapterScope.size || scopedScenes.length
            ? search.hits.filter((hit) => (!chapterScope.size || chapterScope.has(hit.chapterId)) && isInSceneScope(hit))
            : search.hits;
        const hitsForPrompt = scopedHits.length ? scopedHits : search.hits;

        const expandedSlices = await getAutoExpandedParagraphSlices({
          bookId: params.bookId,
          plans: search.autoExpandedSlicePlans,
        });
        const lexicalCorpusEntry = await getLexicalCorpusCache({
          bookId: params.bookId,
          context,
        });
        const groups = mergeEvidenceCandidateGroups(
          await buildEvidenceGroupsFromHits({
            bookId: params.bookId,
            hits: hitsForPrompt.slice(0, safeTopK),
            matchedSubquery: safeQuery,
            lexicalCorpus: lexicalCorpusEntry.value,
            sceneByRef: new Map(),
          })
        ).slice(0, safeTopK);
        params.capture.evidenceGroups = [...params.capture.evidenceGroups, ...groups].slice(-32);
        if (expandedSlices.length) {
          params.capture.paragraphSlices = [...params.capture.paragraphSlices, ...expandedSlices].slice(-12);
        }

        const autoExpandedMeta = buildAutoExpandedToolMeta({
          plans: search.autoExpandedSlicePlans,
          slices: expandedSlices,
        });
        params.toolRuns.push({
          tool: "search_paragraphs",
          args: {
            query: safeQuery,
            scope: scope || {},
            topK: safeTopK,
          },
          resultMeta: {
            mode: "paragraph_search",
            returned: hitsForPrompt.length,
            evidenceGroupCount: groups.length,
            scoped: chapterScope.size > 0 || scopedScenes.length > 0,
            embeddingRows: search.embeddingRows,
            embeddingInputTokens: search.embeddingInputTokens,
            lexicalParagraphHits: search.lexicalParagraphHits,
            semanticConfidence: search.semanticConfidence,
            queryTerms: search.queryTerms,
            rerank: search.rerank,
            totalMs: search.totalMs,
            ...autoExpandedMeta,
          },
        });

        return {
          hits: formatParagraphHitsForPrompt(hitsForPrompt.slice(0, safeTopK)),
          evidenceGroups: groups.map(formatEvidenceGroupForPrompt),
          primaryEvidenceSlices: formatPrimaryEvidenceSlicesForPrompt(expandedSlices),
          expandedSlices: formatExpandedSlicesForPrompt(expandedSlices),
          meta: {
            returned: hitsForPrompt.length,
            evidenceGroupCount: groups.length,
            scoped: chapterScope.size > 0 || scopedScenes.length > 0,
            semanticConfidence: search.semanticConfidence,
            queryTerms: search.queryTerms,
          },
        };
      },
    }),
    read_passages: tool({
      description:
        "Читает непрерывный текст абзацев вокруг уже найденного места. Используй для проверки цепочки, точной формулировки и соседнего контекста.",
      inputSchema: z.object({
        ranges: z
          .array(
            z.object({
              chapterId: z.string().trim().min(1),
              paragraphStart: z.coerce.number().int().min(1),
              paragraphEnd: z.coerce.number().int().min(1),
            })
          )
          .min(1)
          .max(3),
        expandBefore: z.coerce.number().int().min(0).max(12).optional(),
        expandAfter: z.coerce.number().int().min(0).max(12).optional(),
        maxChars: z.coerce.number().int().min(1000).max(18000).optional(),
      }),
      execute: async ({ ranges, expandBefore, expandAfter, maxChars }) => {
        if (!reserveToolExecution("read_passages")) {
          return {
            passages: [],
            meta: {
              skipped: true,
              reason: "tool_budget_exhausted",
            },
          };
        }

        const startedAt = nowMs();
        const before = Math.max(0, Math.min(12, Number(expandBefore || 0)));
        const after = Math.max(0, Math.min(12, Number(expandAfter || 0)));
        const charLimit = Math.max(1000, Math.min(18000, Number(maxChars || 9000)));
        const slices: ParagraphSliceResult[] = [];
        const groups: EvidenceGroup[] = [];
        for (const range of ranges || []) {
          const start = Math.max(1, Number(range.paragraphStart || 1) - before);
          const end = Math.max(start, Number(range.paragraphEnd || range.paragraphStart || 1) + after);
          const slice = await getParagraphSliceTool({
            bookId: params.bookId,
            chapterId: String(range.chapterId || "").trim(),
            paragraphStart: start,
            paragraphEnd: end,
          });
          if (!slice) continue;
          slices.push(slice);
          const group = createEvidenceGroupFromSlice({
            slice,
            matchedSubquery: "read_passages",
            score: 0.72,
            matchedBy: ["lexical"],
          });
          if (group) groups.push(group);
        }
        params.capture.paragraphSlices = [...params.capture.paragraphSlices, ...slices].slice(-12);
        params.capture.evidenceGroups = [...params.capture.evidenceGroups, ...groups].slice(-32);
        params.toolRuns.push({
          tool: "read_passages",
          args: {
            ranges,
            expandBefore: before,
            expandAfter: after,
            maxChars: charLimit,
          },
          resultMeta: {
            mode: "read_passages",
            totalMs: Math.round(nowMs() - startedAt),
            returned: slices.length,
            evidenceGroupCount: groups.length,
            paragraphCount: slices.reduce((sum, slice) => sum + Math.max(0, slice.paragraphEnd - slice.paragraphStart + 1), 0),
          },
        });

        let remainingChars = charLimit;
        return {
          passages: slices.map((slice) => {
            const text = clampText(slice.text, remainingChars);
            remainingChars = Math.max(0, remainingChars - text.length);
            return {
              chapterId: slice.chapterId,
              chapterOrderIndex: slice.chapterOrderIndex,
              chapterTitle: slice.chapterTitle,
              paragraphStart: slice.paragraphStart,
              paragraphEnd: slice.paragraphEnd,
              text,
            };
          }),
          evidenceGroups: groups.map(formatEvidenceGroupForPrompt),
          meta: {
            returned: slices.length,
            evidenceGroupCount: groups.length,
          },
        };
      },
    }),
  };
}

function deriveCitationsFromEvidenceToolCapture(capture: EvidenceToolChatCapture): ChatCitation[] {
  const citations: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const group of capture.evidenceGroups) {
    const sceneIndex = Number(group.sceneIndex || 0);
    if (!sceneIndex || sceneIndex <= 0) continue;
    const key = `${group.chapterOrderIndex}:${sceneIndex}:${group.paragraphStart}:${group.paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      chapterOrderIndex: group.chapterOrderIndex,
      sceneIndex,
      paragraphStart: group.paragraphStart,
      paragraphEnd: group.paragraphEnd,
      reason: clampText(group.text, 220) || "evidence",
    });
    if (citations.length >= 8) break;
  }
  return citations;
}

function buildDeterministicFallbackAnswerFromEvidenceToolCapture(capture: EvidenceToolChatCapture): string {
  const group = capture.evidenceGroups[0];
  if (group) {
    return `Нашёл релевантный фрагмент: глава ${group.chapterOrderIndex}, абз. ${group.paragraphStart}-${group.paragraphEnd}. ${clampText(
      group.text,
      420
    )}`;
  }
  const slice = capture.paragraphSlices[0];
  if (slice) {
    return `Нашёл релевантный фрагмент: глава ${slice.chapterOrderIndex}, абз. ${slice.paragraphStart}-${slice.paragraphEnd}. ${clampText(
      slice.text,
      420
    )}`;
  }
  return "Не удалось собрать надежные фрагменты книги для ответа. Попробуйте переформулировать вопрос точнее.";
}

function buildEvidenceToolFallbackPayload(capture: EvidenceToolChatCapture) {
  return {
    evidenceGroups: capture.evidenceGroups.slice(-18).map(formatEvidenceGroupForPrompt),
    passages: formatExpandedSlicesForPrompt(capture.paragraphSlices.slice(-6)),
  };
}

async function synthesizeFallbackAnswerFromEvidenceToolCapture(params: {
  model: ReturnType<typeof createVertexChatModelFromConfig>;
  providerOptions: ReturnType<typeof createVertexReasoningProviderOptions>;
  bookTitle: string;
  userQuestion: string;
  capture: EvidenceToolChatCapture;
}): Promise<{ answer: string | null; usage?: LanguageModelUsage; latencyMs?: number }> {
  if (!params.capture.evidenceGroups.length && !params.capture.paragraphSlices.length) {
    return { answer: null };
  }

  try {
    const startedAt = Date.now();
    const payload = buildEvidenceToolFallbackPayload(params.capture);
    const completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: params.model,
        temperature: 0,
        system:
          "Ты отвечаешь строго по уже найденным paragraph evidence/passages одной книги. " +
          "Не используй внешние знания и не добавляй факты без опоры в evidence. " +
          "Scene cards/summaries/facts не считай доказательством точных деталей. " +
          "Не добавляй мосты между событиями и не усиливай формулировку evidence. " +
          "Если данных не хватает, прямо скажи, какая часть не подтверждена.",
        prompt: `Книга: ${params.bookTitle}
Вопрос пользователя: ${params.userQuestion}

Найденные фрагменты (JSON):
${JSON.stringify(payload)}

Дай ответ на русском по найденным фрагментам. Не упоминай внутренние инструменты.`,
        providerOptions: params.providerOptions,
      })
    );

    return {
      answer: String(completion.text || "").trim() || null,
      usage: completion.usage,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return { answer: null };
  }
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
    rerankScore: typeof hit.rerankScore === "number" ? Number(hit.rerankScore.toFixed(6)) : undefined,
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

function formatExpandedSlicesForPrompt(rows: ParagraphSliceResult[]) {
  return rows.map((row) => ({
    chapterOrderIndex: row.chapterOrderIndex,
    chapterTitle: row.chapterTitle,
    paragraphStart: row.paragraphStart,
    paragraphEnd: row.paragraphEnd,
    text: clampText(row.text, MAX_AUTO_EXPANDED_SLICE_CHARS),
  }));
}

function formatPrimaryEvidenceSlicesForPrompt(rows: ParagraphSliceResult[]) {
  return rows.map((row) => {
    const paragraphs = row.text
      .split(/\n{2,}/gu)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, index) => ({
        paragraphIndex: row.paragraphStart + index,
        text: clampText(text, MAX_PRIMARY_EVIDENCE_PARAGRAPH_CHARS),
      }))
      .filter((paragraph) => paragraph.paragraphIndex <= row.paragraphEnd);

    return {
      chapterOrderIndex: row.chapterOrderIndex,
      chapterTitle: row.chapterTitle,
      paragraphStart: row.paragraphStart,
      paragraphEnd: row.paragraphEnd,
      text: clampText(row.text, MAX_AUTO_EXPANDED_SLICE_CHARS),
      paragraphs,
    };
  });
}

function formatParagraphHitsForPrompt(hits: HybridParagraphSearchHit[]) {
  return hits.map((hit) => ({
    chapterId: hit.chapterId,
    chapterOrderIndex: hit.chapterOrderIndex,
    chapterTitle: hit.chapterTitle,
    sceneIndex: hit.sceneIndex,
    paragraphIndex: hit.paragraphIndex,
    score: Number(hit.score.toFixed(6)),
    rerankScore: typeof hit.rerankScore === "number" ? Number(hit.rerankScore.toFixed(6)) : undefined,
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
}): Promise<{ answer: string | null; usage?: LanguageModelUsage; latencyMs?: number }> {
  const evidence = buildFallbackEvidenceSnapshot(params.capture);
  const evidenceHasData =
    evidence.searchHits.length > 0 ||
    evidence.paragraphHits.length > 0 ||
    evidence.contextScenes.length > 0 ||
    evidence.paragraphSlices.length > 0;
  if (!evidenceHasData) {
    return { answer: null };
  }

  try {
    const startedAt = Date.now();
    const completion = await withSemaphore(chatCallSemaphore, async () =>
      generateText({
        model: params.model,
        temperature: 0,
        system:
          "Ты отвечаешь строго по уже собранным данным книги. Не используй внешние знания. " +
          "Главное доказательство - paragraph evidence/passages; scene summaries используй только как навигацию. " +
          "Не добавляй мосты между событиями и не усиливай формулировку evidence. Если данных мало, прямо скажи, чего не хватает.",
        prompt: `Книга: ${params.bookTitle}
Вопрос пользователя: ${params.userQuestion}

Данные из инструментов (JSON):
${JSON.stringify(evidence)}

Дай короткий ответ на русском (2-5 предложений), опираясь только на эти данные.`,
        providerOptions: params.providerOptions,
      })
    );
    const latencyMs = Date.now() - startedAt;

    const answer = String(completion.text || "").trim();
    return {
      answer: answer || null,
      usage: completion.usage,
      latencyMs,
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

function createBookChatSystemPromptV1(bookTitle: string, enabledTools: readonly BookChatToolName[]): string {
  const normalizedTools = normalizeEnabledBookChatTools(enabledTools);
  const available = new Set(normalizedTools);
  const lines = [
    `Ты литературный ассистент по одной книге: "${bookTitle}".`,
    "КРИТИЧНО: внутренние рассуждения (reasoning/thoughts) веди только на русском языке.",
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
    "- Если инструмент вернул primaryEvidenceSlices или expandedSlices, прочитай каждый такой фрагмент целиком: начало, середину и конец.",
    "- Если primaryEvidenceSlices содержит paragraphs, проходи их по paragraphIndex по возрастанию и учитывай поздние изменения состояния, цели, контроля и причинной связи.",
    "- При ответе по primaryEvidenceSlices не останавливайся на top hits; top hits нужны для навигации, а непрерывный slice является главным доказательством.",
    "- Перед финальным ответом проверь, не меняется ли факт, состояние персонажа или причинно-следственная связь ближе к концу primaryEvidenceSlices.",
    "- Не выдумывай факты, которых нет в книге.",
    "- Если данных не хватает, прямо скажи об этом.",
    "- Избегай бесконечных переформулировок одного и того же запроса; обычно достаточно 1-3 поисков.",
    "- После 6 инструментальных вызовов дай лучший возможный ответ по уже найденным данным.",
    "- Если инструменты стали недоступны на финальном шаге, сразу отвечай по уже найденным данным.",
    "- В reasoning/thoughts (если провайдер их показывает) пиши по-русски.",
    "- Отвечай на русском, коротко и по делу."
  );

  lines.push("", "Правила маршрутизации:");
  if (available.has("search_paragraphs_hybrid")) {
    lines.push(
      '- Для факт-чека, вопросов "как именно", "почему", "правда ли", "когда именно", "чем подтверждается" сначала вызывай search_paragraphs_hybrid.',
      '- Если search_paragraphs_hybrid вернул primaryEvidenceSlices или expandedSlices, считай их основным доказательством; top hits используй как навигацию и ранжирование.',
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
      "- Для дословной цитаты, точной формулировки или проверки спорного места сначала найди релевантный фрагмент, затем вызови get_paragraph_slice.",
      "- Не вызывай несколько перекрывающихся get_paragraph_slice по одной главе; если нужен больший контекст, расширь диапазон одним запросом.",
      "- Если search_paragraphs_hybrid уже вернул primaryEvidenceSlices или expandedSlices по нужному эпизоду, не дублируй их перекрывающимися get_paragraph_slice без необходимости."
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

function createBookChatSystemPromptV2(bookTitle: string, enabledTools: readonly BookChatToolName[]): string {
  const normalizedTools = normalizeEnabledBookChatTools(enabledTools);
  const available = new Set(normalizedTools);
  const lines = [
    `Ты литературный ассистент по одной книге: "${bookTitle}".`,
    "КРИТИЧНО: внутренние рассуждения (reasoning/thoughts) веди только на русском языке.",
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
    "ИСТОЧНИКИ ФАКТОВ:",
    "- Источник фактов только результаты инструментов.",
    "- История диалога нужна только для понимания, к чему относится текущий вопрос.",
    "- Предыдущие ответы ассистента, предыдущие сообщения пользователя и общие знания о серии не являются источником фактов.",
    "- Если утверждение есть в истории, но оно не подтверждено инструментами, не используй его как факт.",
    "",
    "ЗАПРЕТ НА ВНЕШНИЙ КАНОН:",
    "- Не используй знания из других книг серии, фильмов, интервью, фанатских разборов и общеизвестных цитат франшизы.",
    "- Даже если утверждение кажется общеизвестным, используй его только если оно подтверждено инструментами по этой книге.",
    "",
    "ИЕРАРХИЯ ДОКАЗАТЕЛЬСТВ:",
    "- primaryEvidenceSlices / expandedSlices из search_paragraphs_hybrid и paragraph slice = основное доказательство.",
    "- paragraph hits = навигация, ранжирование и точечные опоры; не считай top hits полной реконструкцией событий, если есть primaryEvidenceSlices или expandedSlices.",
    "- Если есть primaryEvidenceSlices или expandedSlices, прочитай каждый непрерывный фрагмент целиком: начало, середину и конец.",
    "- Если primaryEvidenceSlices содержит paragraphs, проходи их по paragraphIndex по возрастанию и учитывай поздние изменения состояния, цели, контроля и причинной связи.",
    "- Перед финальным ответом проверь, не меняется ли факт, состояние персонажа или причинно-следственная связь ближе к концу непрерывного фрагмента.",
    "- scene search / scene context = навигация и грубая локализация.",
    "- Нельзя делать окончательный вывод о точных деталях сцены только по данным scene-level.",
    "",
    "ОБЩИЕ ПРАВИЛА:",
    "- Не отвечай, пока не получишь достаточно данных из инструментов.",
    "- Отвечай только на основе результатов инструментов.",
    "- Не выдумывай факты, которых нет в книге.",
    "- Если данных не хватает, прямо скажи об этом.",
    "- Избегай бесконечных переформулировок одного и того же запроса; обычно достаточно 1-3 поисков.",
    "- После 6 инструментальных вызовов отвечай только тем, что подтверждено найденными данными.",
    "- Если инструменты стали недоступны на финальном шаге, сразу отвечай по уже найденным данным.",
    "- Не достраивай недостающие звенья догадкой.",
    "- Если ключевая часть ответа осталась неподтвержденной, прямо скажи это.",
    "- Не сглаживай противоречивые или неполные данные в одну красивую версию событий.",
    "- Если найденные фрагменты не дают полной уверенности в порядке событий или составе участников, скажи об ограничении прямо.",
    "- Короткие follow-up вопросы (\"а почему?\", \"а правда?\", \"а как именно?\") считай книжными, если они относятся к предыдущему обсуждаемому эпизоду или факту.",
    "- Для них тоже опирайся на инструменты, а не на историю чата как источник фактов.",
    "- В reasoning/thoughts (если провайдер их показывает) пиши по-русски.",
    "- Отвечай на русском, коротко и по делу.",
    "",
    "ГРАНИЦА МЕЖДУ ФАКТОМ И ИНТЕРПРЕТАЦИЕЙ:",
    "- Если вопрос требует смысла, темы, мотива, \"чему учит\", \"что это говорит о\", сначала найди текстовые опоры.",
    "- Формулируй такие ответы как вывод по найденным фрагментам, а не как безусловный факт книги.",
    "- Не приписывай книге идеи, которые не опираются на найденные фрагменты.",
    "",
    "ТРЕБОВАНИЕ PARAGRAPH-LEVEL ПОДТВЕРЖДЕНИЯ:",
    "- Для вопросов \"как именно\", \"почему\", \"в каком порядке\", \"кто с кем\", \"что точно произошло\", \"правда ли\", \"чем подтверждается\" не отвечай только по search_scenes или get_scene_context.",
    "- Подтверди такие ответы paragraph-level данными.",
    "- Если точная реконструкция не подтверждается найденными фрагментами, прямо скажи об этом."
  );

  lines.push("", "ПРАВИЛА МАРШРУТИЗАЦИИ:");
  if (available.has("search_paragraphs_hybrid")) {
    lines.push(
      '- Для факт-чека, вопросов "как именно", "почему", "правда ли", "когда именно", "чем подтверждается" сначала вызывай search_paragraphs_hybrid.',
      '- Для вопросов о точных деталях эпизода ("кто был", "как распределились", "что произошло по шагам", "кого встретили", "что именно сказал") сначала вызывай search_paragraphs_hybrid.',
      "- Если search_paragraphs_hybrid вернул primaryEvidenceSlices или expandedSlices, отвечай по ним как по primary evidence; top hits не являются полной реконструкцией фрагмента.",
      '- Для вопросов "в каком порядке", "кто с кем", "что точно произошло" проверяй несколько paragraph hits, а не один.'
    );
  }

  if (available.has("search_scenes")) {
    lines.push(
      '- Для вопросов "в каких сценах", "где появляется", "найди эпизод", "перечисли эпизоды" сначала вызывай search_scenes.',
      '- search_scenes используй как вспомогательную навигацию, а не как единственное основание ответа.'
    );
    if (available.has("get_scene_context")) {
      lines.push("- После поиска сцен добирай get_scene_context, когда нужен расширенный локальный контекст, но не используй scene-level как окончательное доказательство точных деталей.");
    } else {
      lines.push("- Если get_scene_context недоступен, работай только по найденным сценам и не выдумывай соседний контекст.");
    }
  } else if (available.has("search_paragraphs_hybrid")) {
    lines.push("- Поиск сцен отключен. Для вопросов о сценах и эпизодах отвечай по найденным абзацам и явно опирайся на paragraph evidence.");
  }

  if (available.has("get_scene_context") && !available.has("search_scenes")) {
    lines.push("- get_scene_context используй только если sceneIds уже даны явно; иначе не трать шаг на этот инструмент.");
  }

  if (available.has("get_paragraph_slice")) {
    lines.push(
      "- Для дословной цитаты, точной формулировки или проверки спорного места сначала найди релевантный фрагмент, затем вызови get_paragraph_slice.",
      "- Не вызывай несколько перекрывающихся get_paragraph_slice по одной главе; если нужен больший контекст, расширь диапазон одним запросом.",
      "- Если search_paragraphs_hybrid уже вернул primaryEvidenceSlices или expandedSlices по нужному эпизоду, не дублируй их перекрывающимися get_paragraph_slice без необходимости."
    );
  } else {
    lines.push("- Если нужен дословный фрагмент, а get_paragraph_slice недоступен, честно скажи, что точную цитату ты не проверил.");
  }

  lines.push(
    "",
    "ДЕФОЛТЫ ИНСТРУМЕНТОВ:",
    ...(available.has("search_paragraphs_hybrid")
      ? ['- search_paragraphs_hybrid: topK=10 для факт-чека и вопросов "как именно/почему/правда ли/когда именно".']
      : []),
    ...(available.has("search_scenes")
      ? [
          "- search_scenes: topK=8 для простых навигационных вопросов по эпизодам.",
          '- search_scenes: topK=12 для вопросов "впервые", "где появляется", "в каких сценах", "кто участвует".',
        ]
      : []),
    ...(available.has("get_scene_context") ? ["- get_scene_context: обычно neighborWindow=1..2."] : []),
    "",
    "ФОРМАТ ОТВЕТА:",
    "- коротко",
    "- по существу",
    "- без упоминания внутренних шагов, если пользователь этого не просил",
    '- если ответ подтвержден прямо, отвечай уверенно и коротко',
    '- если это вывод по нескольким фрагментам, можно кратко пометить: "По найденным фрагментам..."',
    '- если данных не хватает, прямо скажи: "По найденным фрагментам этого надежно подтвердить не удалось"'
  );

  return lines.join("\n");
}

function createBookChatSystemPrompt(bookTitle: string, enabledTools: readonly BookChatToolName[]): string {
  if (BOOK_CHAT_SYSTEM_PROMPT_VERSION === "tool-aware-v1") {
    return createBookChatSystemPromptV1(bookTitle, enabledTools);
  }
  return createBookChatSystemPromptV2(bookTitle, enabledTools);
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
            rerank: search.rerank,
            sceneEmbeddingCacheHit: search.sceneEmbeddingCacheHit,
            lexicalCacheHit: search.lexicalCacheHit,
            embeddingMs: search.embeddingMs,
            semanticMs: search.semanticMs,
            lexicalMs: search.lexicalMs,
            rerankMs: search.rerankMs,
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
        "Гибридный поиск по абзацам (семантика + лексика). Используй первым шагом для факт-чека и точных вопросов. Возвращает hits для навигации и primaryEvidenceSlices/expandedSlices как главный непрерывный evidence-контекст; если slices есть, читай их целиком перед ответом.",
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
        const expandedSlices = await getAutoExpandedParagraphSlices({
          bookId: params.bookId,
          plans: search.autoExpandedSlicePlans,
        });
        if (expandedSlices.length) {
          params.capture.paragraphSlices = [...params.capture.paragraphSlices, ...expandedSlices].slice(
            -AUTO_CONTEXT_MAX_CAPTURED_SLICES
          );
        }
        const autoExpandedMeta = buildAutoExpandedToolMeta({
          plans: search.autoExpandedSlicePlans,
          slices: expandedSlices,
        });
        params.toolRuns.push({
          tool: "search_paragraphs_hybrid",
          args: {
            query: safeQuery,
            topK: safeTopK,
          },
          resultMeta: {
	            returned: search.hits.length,
	            evidenceFragmentHits: search.evidenceFragmentHits.length,
	            embeddingRows: search.embeddingRows,
	            fragmentEmbeddingRows: search.fragmentEmbeddingRows,
	            embeddingInputTokens: search.embeddingInputTokens,
	            lexicalParagraphHits: search.lexicalParagraphHits,
	            lexicalFragmentHits: search.lexicalFragmentHits,
	            semanticConfidence: search.semanticConfidence,
            queryTerms: search.queryTerms,
            rerank: search.rerank,
            paragraphEmbeddingCacheHit: search.paragraphEmbeddingCacheHit,
            lexicalCacheHit: search.lexicalCacheHit,
            embeddingMs: search.embeddingMs,
            semanticMs: search.semanticMs,
            lexicalMs: search.lexicalMs,
            textFetchMs: search.textFetchMs,
            rerankMs: search.rerankMs,
            mergeMs: search.mergeMs,
            totalMs: search.totalMs,
            ...autoExpandedMeta,
          },
        });

	        return {
	          hits: formatParagraphHitsForPrompt(search.hits.slice(0, safeTopK)),
	          evidenceFragments: search.evidenceFragmentHits.slice(0, safeTopK).map((fragment) => ({
	            id: fragment.id,
	            chapterOrderIndex: fragment.chapterOrderIndex,
	            chapterTitle: fragment.chapterTitle,
	            sceneIndex: fragment.sceneIndex,
	            paragraphStart: fragment.paragraphStart,
	            paragraphEnd: fragment.paragraphEnd,
	            score: Number(fragment.score.toFixed(6)),
	            matchedBy: [
	              ...(fragment.semanticRank ? ["semantic"] : []),
	              ...(fragment.lexicalRank ? ["lexical"] : []),
	              ...(fragment.sceneId ? ["scene_window"] : []),
	            ],
	            text: clampText(fragment.text, MAX_PRIMARY_EVIDENCE_PARAGRAPH_CHARS),
	          })),
	          primaryEvidenceSlices: formatPrimaryEvidenceSlicesForPrompt(expandedSlices),
          expandedSlices: formatExpandedSlicesForPrompt(expandedSlices),
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
          params.capture.paragraphSlices = [...params.capture.paragraphSlices, slice].slice(
            -AUTO_CONTEXT_MAX_CAPTURED_SLICES
          );
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
        rerank: search.rerank,
        sceneEmbeddingCacheHit: search.sceneEmbeddingCacheHit,
        lexicalCacheHit: search.lexicalCacheHit,
        embeddingMs: search.embeddingMs,
        semanticMs: search.semanticMs,
        lexicalMs: search.lexicalMs,
        rerankMs: search.rerankMs,
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
    const expandedSlices = await getAutoExpandedParagraphSlices({
      bookId,
      plans: search.autoExpandedSlicePlans,
    });
    const autoExpandedMeta = buildAutoExpandedToolMeta({
      plans: search.autoExpandedSlicePlans,
      slices: expandedSlices,
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
        rerank: search.rerank,
        paragraphEmbeddingCacheHit: search.paragraphEmbeddingCacheHit,
        lexicalCacheHit: search.lexicalCacheHit,
        embeddingMs: search.embeddingMs,
        semanticMs: search.semanticMs,
        lexicalMs: search.lexicalMs,
        textFetchMs: search.textFetchMs,
        rerankMs: search.rerankMs,
        mergeMs: search.mergeMs,
        totalMs: search.totalMs,
        ...autoExpandedMeta,
      },
      output: {
        hits: formatParagraphHitsForPrompt(search.hits),
        primaryEvidenceSlices: formatPrimaryEvidenceSlicesForPrompt(expandedSlices),
        expandedSlices: formatExpandedSlicesForPrompt(expandedSlices),
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

  const enabledBookTools = normalizeEnabledBookChatTools(params.enabledTools);
  const executionPlan = await planBookChatExecution({
    clientConfig: client.config,
    bookId: book.id,
    bookTitle: book.title,
    userQuestion: latestUserMessage.content,
    enabledTools: enabledBookTools,
  });
  const toolRuns: ChatToolRun[] = [
    {
      tool: "planner",
      args: {
        userQuestion: latestUserMessage.content,
      },
      resultMeta: {
        toolPolicy: executionPlan.decision.toolPolicy,
        modelTier: executionPlan.decision.modelTier,
        selectedChatModelId: executionPlan.selectedChatModelId,
        searchPlan: executionPlan.decision.searchPlan || null,
      },
    },
  ];
  const llmStepRuns = executionPlan.plannerStepRun ? [executionPlan.plannerStepRun] : [];
  const toolsEnabled = enabledBookTools.length > 0 && executionPlan.decision.toolPolicy === "required";
  const selectedRuntimeTools = toolsEnabled ? [...EVIDENCE_TOOL_CHAT_TOOL_NAMES] : [];
  const selectedChatModelId = executionPlan.selectedChatModelId;
  const chatModel = createVertexChatModelFromConfig({
    ...client.config,
    chatModel: selectedChatModelId,
  });
  const providerOptions = createVertexReasoningProviderOptions(selectedChatModelId);
  const capture: EvidenceToolChatCapture = {
    evidenceGroups: [],
    paragraphSlices: [],
  };
  const evidenceTools = toolsEnabled
      ? createEvidenceToolChatTools({
          bookId: book.id,
          bookTitle: book.title,
          userQuestion: latestUserMessage.content,
          client,
          toolRuns,
        capture,
        maxToolExecutions: executionPlan.decision.modelTier === "pro" ? 6 : 3,
      })
    : undefined;

  const mainStartedAt = Date.now();
  const completion = await withSemaphore(chatCallSemaphore, async () =>
    generateText({
      model: chatModel,
      temperature: 0.2,
      system: createEvidenceToolChatSystemPrompt({
        bookTitle: book.title,
        toolsEnabled,
        toolPolicy: executionPlan.decision.toolPolicy,
        searchPlan: executionPlan.decision.searchPlan,
      }),
      messages: preparedMessages,
      providerOptions,
      tools: evidenceTools,
      prepareStep: createEvidenceToolChatPrepareStep({
        toolsEnabled,
        toolPolicy: executionPlan.decision.toolPolicy,
        maxSteps: MAX_AUTONOMOUS_TOOL_STEPS,
      }),
      stopWhen: toolsEnabled ? stepCountIs(MAX_AUTONOMOUS_TOOL_STEPS) : undefined,
    })
  );
  const mainLatencyMs = Date.now() - mainStartedAt;
  toolRuns.push({
    tool: "llm_answer",
    args: {
      toolPolicy: executionPlan.decision.toolPolicy,
      modelTier: executionPlan.decision.modelTier,
    },
    resultMeta: {
      totalMs: mainLatencyMs,
      model: selectedChatModelId,
      mode: "generate",
      evidenceGroupCount: capture.evidenceGroups.length,
      paragraphSliceCount: capture.paragraphSlices.length,
    },
  });
  if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED) {
    llmStepRuns.push({
      step: "main",
      model: selectedChatModelId,
      usage: completion.totalUsage || completion.usage,
      latencyMs: mainLatencyMs,
      metadata: {
        mode: "evidence_tool_generate",
          toolPolicy: executionPlan.decision.toolPolicy,
          modelTier: executionPlan.decision.modelTier,
          searchQueryCount: executionPlan.decision.searchPlan?.searchQueries.length || 0,
        },
      });
  }

  let answerText = String(completion.text || "").trim();
  let usageForMetrics: LanguageModelUsage | undefined = mergeLanguageModelUsage(
    executionPlan.usage,
    completion.totalUsage || completion.usage
  );
  let fallbackKind: string | null = null;
  if (!answerText) {
    const synthesized = await synthesizeFallbackAnswerFromEvidenceToolCapture({
      model: chatModel,
      providerOptions,
      bookTitle: book.title,
      userQuestion: latestUserMessage.content,
      capture,
    });
    usageForMetrics = mergeLanguageModelUsage(usageForMetrics, synthesized.usage);
    if (synthesized.answer) {
      answerText = synthesized.answer;
      fallbackKind = "synthesized_evidence_tools";
      if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED && synthesized.latencyMs !== undefined) {
        llmStepRuns.push({
          step: "fallback",
          model: selectedChatModelId,
          usage: synthesized.usage,
          latencyMs: synthesized.latencyMs,
          metadata: {
            mode: "evidence_tool_synthesis_fallback",
          },
        });
      }
    } else {
      answerText = buildDeterministicFallbackAnswerFromEvidenceToolCapture(capture);
      fallbackKind = "deterministic_evidence_tools";
    }
  }
  const citations = deriveCitationsFromEvidenceToolCapture(capture);

  return {
    answer: answerText,
    citations,
    toolRuns,
    llmStepRuns,
    metrics: buildChatMetrics({
      chatModel: selectedChatModelId,
      embeddingModel: client.config.embeddingModel,
      selectedTools: selectedRuntimeTools,
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
    if (!tool) continue;

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
    selectedTools: normalizeRuntimeToolNames(asStringList(row.selectedTools, 16)),
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
      if (!tool) return null;

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

  const enabledBookTools = normalizeEnabledBookChatTools(params.enabledTools);
  const executionPlan = await planBookChatExecution({
    clientConfig: client.config,
    bookId: book.id,
    bookTitle: book.title,
    userQuestion: latestUserMessage.content,
    enabledTools: enabledBookTools,
  });
  const toolRuns: ChatToolRun[] = [
    {
      tool: "planner",
      args: {
        userQuestion: latestUserMessage.content,
      },
      resultMeta: {
        toolPolicy: executionPlan.decision.toolPolicy,
        modelTier: executionPlan.decision.modelTier,
        selectedChatModelId: executionPlan.selectedChatModelId,
        searchPlan: executionPlan.decision.searchPlan || null,
      },
    },
  ];
  const llmStepRuns = executionPlan.plannerStepRun ? [executionPlan.plannerStepRun] : [];
  const toolsEnabled = enabledBookTools.length > 0 && executionPlan.decision.toolPolicy === "required";
  const selectedRuntimeTools = toolsEnabled ? [...EVIDENCE_TOOL_CHAT_TOOL_NAMES] : [];
  const selectedChatModelId = executionPlan.selectedChatModelId;
  const chatModel = createVertexChatModelFromConfig({
    ...client.config,
    chatModel: selectedChatModelId,
  });
  const providerOptions = createVertexReasoningProviderOptions(selectedChatModelId);
  const capture: EvidenceToolChatCapture = {
    evidenceGroups: [],
    paragraphSlices: [],
  };
  const evidenceTools = toolsEnabled
      ? createEvidenceToolChatTools({
          bookId: book.id,
          bookTitle: book.title,
          userQuestion: latestUserMessage.content,
          client,
          toolRuns,
        capture,
        maxToolExecutions: executionPlan.decision.modelTier === "pro" ? 6 : 3,
      })
    : undefined;

  let streamedAnswer = "";
  try {
    let normalizedAnswer = "";
    let usageForMetrics: LanguageModelUsage | undefined = executionPlan.usage;
    let fallbackKind: string | null = null;
    const mainStartedAt = Date.now();
    await withSemaphore(chatCallSemaphore, async () => {
      const streamResult = streamText({
        model: chatModel,
        temperature: 0.2,
        system: createEvidenceToolChatSystemPrompt({
          bookTitle: book.title,
          toolsEnabled,
          toolPolicy: executionPlan.decision.toolPolicy,
          searchPlan: executionPlan.decision.searchPlan,
        }),
        messages: preparedMessages,
        providerOptions,
        tools: evidenceTools,
        prepareStep: createEvidenceToolChatPrepareStep({
          toolsEnabled,
          toolPolicy: executionPlan.decision.toolPolicy,
          maxSteps: MAX_AUTONOMOUS_TOOL_STEPS,
        }),
        stopWhen: toolsEnabled ? stepCountIs(MAX_AUTONOMOUS_TOOL_STEPS) : undefined,
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
      const mainUsage = (await resolveUsageSafely(streamResult.totalUsage)) || (await resolveUsageSafely(streamResult.usage));
      usageForMetrics = mergeLanguageModelUsage(usageForMetrics, mainUsage);
      const mainLatencyMs = Date.now() - mainStartedAt;
      toolRuns.push({
        tool: "llm_answer",
        args: {
          toolPolicy: executionPlan.decision.toolPolicy,
          modelTier: executionPlan.decision.modelTier,
        },
        resultMeta: {
          totalMs: mainLatencyMs,
          model: selectedChatModelId,
          mode: "stream",
          evidenceGroupCount: capture.evidenceGroups.length,
          paragraphSliceCount: capture.paragraphSlices.length,
        },
      });
      if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED) {
        llmStepRuns.push({
          step: "main",
          model: selectedChatModelId,
          usage: mainUsage,
          latencyMs: mainLatencyMs,
          metadata: {
            mode: "evidence_tool_stream",
          toolPolicy: executionPlan.decision.toolPolicy,
          modelTier: executionPlan.decision.modelTier,
          searchQueryCount: executionPlan.decision.searchPlan?.searchQueries.length || 0,
        },
      });
      }
    });

    let finalAnswer = normalizedAnswer;
    if (!finalAnswer) {
      const synthesized = await synthesizeFallbackAnswerFromEvidenceToolCapture({
        model: chatModel,
        providerOptions,
        bookTitle: book.title,
        userQuestion: latestUserMessage.content,
        capture,
      });
      usageForMetrics = mergeLanguageModelUsage(usageForMetrics, synthesized.usage);
      if (synthesized.answer) {
        finalAnswer = synthesized.answer;
        fallbackKind = "synthesized_evidence_tools";
        if (BOOK_CHAT_LLM_STEP_METRICS_ENABLED && synthesized.latencyMs !== undefined) {
          llmStepRuns.push({
            step: "fallback",
            model: selectedChatModelId,
            usage: synthesized.usage,
            latencyMs: synthesized.latencyMs,
            metadata: {
              mode: "evidence_tool_synthesis_fallback",
            },
          });
        }
      } else {
        finalAnswer = buildDeterministicFallbackAnswerFromEvidenceToolCapture(capture);
        fallbackKind = "deterministic_evidence_tools";
      }
      if (!streamedAnswer.trim()) {
        await params.onDelta(finalAnswer);
      }
    }

    const citations = deriveCitationsFromEvidenceToolCapture(capture);

    return {
      answer: finalAnswer,
      citations,
      toolRuns,
      llmStepRuns,
      metrics: buildChatMetrics({
        chatModel: selectedChatModelId,
        embeddingModel: client.config.embeddingModel,
        selectedTools: selectedRuntimeTools,
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
      const citations = deriveCitationsFromEvidenceToolCapture(capture);
      return {
        answer: streamedAnswer.trim(),
        citations,
        toolRuns,
        llmStepRuns,
        metrics: buildChatMetrics({
          chatModel: selectedChatModelId,
          embeddingModel: client.config.embeddingModel,
          selectedTools: selectedRuntimeTools,
          usage: executionPlan.usage,
          toolRuns,
          totalLatencyMs: Date.now() - startedAt,
          answerLengthChars: streamedAnswer.trim().length,
          citationCount: citations.length,
          fallbackUsed: true,
          fallbackKind: "stream_partial",
        }),
      };
    }

    const synthesized = await synthesizeFallbackAnswerFromEvidenceToolCapture({
      model: chatModel,
      providerOptions,
      bookTitle: book.title,
      userQuestion: latestUserMessage.content,
      capture,
    });
    const fallback = synthesized.answer || buildDeterministicFallbackAnswerFromEvidenceToolCapture(capture);
    await params.onDelta(fallback);
    const citations = deriveCitationsFromEvidenceToolCapture(capture);
    return {
      answer: fallback,
      citations,
      toolRuns,
      llmStepRuns,
      metrics: buildChatMetrics({
        chatModel: selectedChatModelId,
        embeddingModel: client.config.embeddingModel,
        selectedTools: selectedRuntimeTools,
        usage: mergeLanguageModelUsage(executionPlan.usage, synthesized.usage),
        toolRuns,
        totalLatencyMs: Date.now() - startedAt,
        answerLengthChars: fallback.length,
        citationCount: citations.length,
        fallbackUsed: true,
        fallbackKind: synthesized.answer ? "stream_error_synthesized_evidence" : "stream_error_deterministic_evidence",
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
      llmStepRuns: answer.llmStepRuns,
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
