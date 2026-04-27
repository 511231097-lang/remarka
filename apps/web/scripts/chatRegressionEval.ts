import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@remarka/db";
import { requestBookAnalysis } from "../src/lib/bookAnalysisService";
import { DEFAULT_ENABLED_BOOK_CHAT_TOOLS, isBookChatToolName, type BookChatToolName } from "../src/lib/bookChatTools";
import { resolveTokenPricing } from "../src/lib/modelPricing";

type CliOptions = {
  configPath: string;
  outputPath?: string;
  baselinePath?: string;
  runAnalysisOverride?: boolean;
  maxQuestionsOverride?: number;
  golden: boolean;
};

type GoldenCategory = "factual" | "chain" | "comparison" | "character" | "theme" | "quote";

type GoldenQuestion = {
  id: string;
  bookId: string;
  question: string;
  category: GoldenCategory;
  expectedParagraphIds: string[];
  expectedKeywords: string[];
  minRecallK: number;
  expectedFirstTool?: string;
};

type EvalThresholds = {
  costIncreasePct: number;
  p95LatencyIncreasePct: number;
  groundedProxyDropPp: number;
};

type EvalConfigBook = {
  bookId: string;
  label?: string;
  questions?: string[];
};

type EvalConfig = {
  version: "v1";
  name?: string;
  runAnalysis?: boolean;
  analysisTimeoutMinutes?: number;
  analysisPollSeconds?: number;
  chat?: {
    enabledTools?: string[];
    maxQuestionsPerBook?: number;
  };
  regressionThresholds?: Partial<EvalThresholds>;
  questions?: string[];
  books: EvalConfigBook[];
};

type LlmStepUsage = {
  step: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chatCostUsd: number;
};

type QuestionEval = {
  id?: string;
  bookId?: string;
  category?: GoldenCategory;
  question: string;
  answer: string;
  answerPreview: string;
  totalLatencyMs: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
  embeddingInputTokens: number;
  chatCostUsd: number;
  embeddingCostUsd: number;
  totalCostUsd: number;
  citationCount: number;
  toolRunCount: number;
  fallbackUsed: boolean;
  fallbackKind: string | null;
  chatModel: string;
  embeddingModel: string;
  llmSteps: LlmStepUsage[];
  golden?: {
    expectedParagraphIds: string[];
    expectedParagraphRefs: string[];
    retrievedParagraphRefs: string[];
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    keywordCoverage: number;
    matchedKeywords: string[];
    expectedFirstTool: string | null;
    actualFirstTool: string | null;
    toolCorrect: boolean | null;
  };
  quality: {
    hasCitations: boolean;
    usedTools: boolean;
    groundedProxy: boolean;
  };
};

type AnalysisEval = {
  requested: boolean;
  state: "skipped" | "completed" | "failed" | "timeout";
  runId: string | null;
  chatModel: string | null;
  embeddingModel: string | null;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTotalTokens: number;
  embeddingInputTokens: number;
  llmCostUsd: number;
  embeddingCostUsd: number;
  totalCostUsd: number;
  totalElapsedMs: number;
  llmLatencyMs: number;
  embeddingLatencyMs: number;
  llmCalls: number;
  embeddingCalls: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

type AggregateMetrics = {
  questions: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalEmbeddingInputTokens: number;
  citationsRate: number;
  toolUseRate: number;
  fallbackRate: number;
  groundedProxyRate: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  keywordCoverage: number;
  toolCorrectnessRate: number | null;
  stepMetrics: Array<{
    step: string;
    calls: number;
    totalLatencyMs: number;
    avgLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
  }>;
};

type EvalBookReport = {
  bookId: string;
  label: string;
  analysis: AnalysisEval;
  aggregate: AggregateMetrics;
  questions: QuestionEval[];
};

type EvalReport = {
  version: "v1";
  generatedAt: string;
  configPath: string;
  name: string;
  runAnalysis: boolean;
  thresholds: EvalThresholds;
  chatTools: BookChatToolName[];
  books: EvalBookReport[];
  overall: AggregateMetrics;
  comparison?: {
    baselinePath: string;
    deltas: {
      costIncreasePct: number;
      p95LatencyIncreasePct: number;
      groundedProxyDeltaPp: number;
      recallAt5Delta?: number;
      recallAt10Delta?: number;
      mrrDelta?: number;
      keywordCoverageDelta?: number;
    };
    regression: {
      cost: boolean;
      latency: boolean;
      groundedProxy: boolean;
      failed: boolean;
    };
  };
};

const DEFAULT_CONFIG_PATH = "evals/chat-regression.v1.json";
const DEFAULT_GOLDEN_SET_DIR = "evals/golden-set";
const DEFAULT_GOLDEN_RESULTS_DIR = "evals/results";
const DEFAULT_ANALYSIS_TIMEOUT_MINUTES = 120;
const DEFAULT_ANALYSIS_POLL_SECONDS = 15;
const DEFAULT_THRESHOLDS: EvalThresholds = {
  costIncreasePct: 0.25,
  p95LatencyIncreasePct: 0.35,
  groundedProxyDropPp: 0.1,
};

let answerBookChatQuestionLoader:
  | Promise<typeof import("../src/lib/bookChatService")["answerBookChatQuestion"]>
  | null = null;

async function answerBookChatQuestion(params: Parameters<typeof import("../src/lib/bookChatService")["answerBookChatQuestion"]>[0]) {
  if (!answerBookChatQuestionLoader) {
    answerBookChatQuestionLoader = import("../src/lib/bookChatService").then((module) => module.answerBookChatQuestion);
  }
  const handler = await answerBookChatQuestionLoader;
  return handler(params);
}

function parseArgs(argv: string[]): CliOptions {
  let configPath = DEFAULT_CONFIG_PATH;
  let outputPath: string | undefined;
  let baselinePath: string | undefined;
  let runAnalysisOverride: boolean | undefined;
  let maxQuestionsOverride: number | undefined;
  let golden = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();
    if (!token) continue;
    const next = String(argv[index + 1] || "").trim();

    if (token === "--config" && next) {
      configPath = next;
      index += 1;
      continue;
    }
    if (token === "--out" && next) {
      outputPath = next;
      index += 1;
      continue;
    }
    if (token === "--baseline" && next) {
      baselinePath = next;
      index += 1;
      continue;
    }
    if (token === "--golden") {
      golden = true;
      continue;
    }
    if (token === "--run-analysis" && next) {
      runAnalysisOverride = ["1", "true", "yes", "on"].includes(next.toLowerCase());
      index += 1;
      continue;
    }
    if (token === "--max-questions" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxQuestionsOverride = parsed;
      }
      index += 1;
      continue;
    }
  }

  return {
    configPath,
    outputPath,
    baselinePath,
    runAnalysisOverride,
    maxQuestionsOverride,
    golden,
  };
}

function resolvePathFromCwd(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return 0;
  const precision = 10 ** digits;
  return Math.round(value * precision) / precision;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] || 0;
}

function pickQuestions(book: EvalConfigBook, sharedQuestions: string[], maxQuestions?: number): string[] {
  const source = (Array.isArray(book.questions) && book.questions.length ? book.questions : sharedQuestions)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!source.length) return [];
  if (!maxQuestions || source.length <= maxQuestions) return source;
  return source.slice(0, maxQuestions);
}

async function loadConfig(configPath: string): Promise<EvalConfig> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<EvalConfig>;

  if (parsed.version !== "v1") {
    throw new Error(`Unsupported config version: ${String(parsed.version || "")}`);
  }
  if (!Array.isArray(parsed.books) || parsed.books.length === 0) {
    throw new Error("Config must contain non-empty books array");
  }

  return parsed as EvalConfig;
}

function normalizeTools(rawTools: string[] | undefined): BookChatToolName[] {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return [...DEFAULT_ENABLED_BOOK_CHAT_TOOLS];
  }

  const tools = Array.from(new Set(rawTools.map((item) => String(item || "").trim()).filter((item) => isBookChatToolName(item)))) as BookChatToolName[];
  if (!tools.length) return [...DEFAULT_ENABLED_BOOK_CHAT_TOOLS];
  return tools;
}

function normalizeThresholds(input: Partial<EvalThresholds> | undefined): EvalThresholds {
  return {
    costIncreasePct: Math.max(0, asNumber(input?.costIncreasePct, DEFAULT_THRESHOLDS.costIncreasePct)),
    p95LatencyIncreasePct: Math.max(0, asNumber(input?.p95LatencyIncreasePct, DEFAULT_THRESHOLDS.p95LatencyIncreasePct)),
    groundedProxyDropPp: Math.max(0, asNumber(input?.groundedProxyDropPp, DEFAULT_THRESHOLDS.groundedProxyDropPp)),
  };
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadLatestRun(bookId: string) {
  return prisma.bookAnalysisRun.findFirst({
    where: { bookId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      state: true,
      error: true,
      chatModel: true,
      embeddingModel: true,
      llmPromptTokens: true,
      llmCompletionTokens: true,
      llmTotalTokens: true,
      embeddingInputTokens: true,
      llmCostUsd: true,
      embeddingCostUsd: true,
      totalCostUsd: true,
      totalElapsedMs: true,
      llmLatencyMs: true,
      embeddingLatencyMs: true,
      llmCalls: true,
      embeddingCalls: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });
}

function toAnalysisEval(params: {
  requested: boolean;
  state: "skipped" | "completed" | "failed" | "timeout";
  error?: string | null;
  run:
    | null
    | {
        id: string;
        chatModel: string | null;
        embeddingModel: string | null;
        llmPromptTokens: number;
        llmCompletionTokens: number;
        llmTotalTokens: number;
        embeddingInputTokens: number;
        llmCostUsd: number;
        embeddingCostUsd: number;
        totalCostUsd: number;
        totalElapsedMs: number;
        llmLatencyMs: number;
        embeddingLatencyMs: number;
        llmCalls: number;
        embeddingCalls: number;
        startedAt: Date | null;
        completedAt: Date | null;
      };
}): AnalysisEval {
  return {
    requested: params.requested,
    state: params.state,
    runId: params.run?.id || null,
    chatModel: params.run?.chatModel || null,
    embeddingModel: params.run?.embeddingModel || null,
    llmPromptTokens: Math.max(0, Number(params.run?.llmPromptTokens || 0)),
    llmCompletionTokens: Math.max(0, Number(params.run?.llmCompletionTokens || 0)),
    llmTotalTokens: Math.max(0, Number(params.run?.llmTotalTokens || 0)),
    embeddingInputTokens: Math.max(0, Number(params.run?.embeddingInputTokens || 0)),
    llmCostUsd: round(Math.max(0, Number(params.run?.llmCostUsd || 0))),
    embeddingCostUsd: round(Math.max(0, Number(params.run?.embeddingCostUsd || 0))),
    totalCostUsd: round(Math.max(0, Number(params.run?.totalCostUsd || 0))),
    totalElapsedMs: Math.max(0, Number(params.run?.totalElapsedMs || 0)),
    llmLatencyMs: Math.max(0, Number(params.run?.llmLatencyMs || 0)),
    embeddingLatencyMs: Math.max(0, Number(params.run?.embeddingLatencyMs || 0)),
    llmCalls: Math.max(0, Number(params.run?.llmCalls || 0)),
    embeddingCalls: Math.max(0, Number(params.run?.embeddingCalls || 0)),
    startedAt: params.run?.startedAt ? params.run.startedAt.toISOString() : null,
    completedAt: params.run?.completedAt ? params.run.completedAt.toISOString() : null,
    error: params.error ? String(params.error) : null,
  };
}

async function runAnalysisIfNeeded(params: {
  bookId: string;
  runAnalysis: boolean;
  timeoutMinutes: number;
  pollSeconds: number;
}): Promise<AnalysisEval> {
  if (!params.runAnalysis) {
    const run = await loadLatestRun(params.bookId);
    return toAnalysisEval({
      requested: false,
      state: "skipped",
      run: run
        ? {
            id: run.id,
            chatModel: run.chatModel,
            embeddingModel: run.embeddingModel,
            llmPromptTokens: run.llmPromptTokens,
            llmCompletionTokens: run.llmCompletionTokens,
            llmTotalTokens: run.llmTotalTokens,
            embeddingInputTokens: run.embeddingInputTokens,
            llmCostUsd: run.llmCostUsd,
            embeddingCostUsd: run.embeddingCostUsd,
            totalCostUsd: run.totalCostUsd,
            totalElapsedMs: run.totalElapsedMs,
            llmLatencyMs: run.llmLatencyMs,
            embeddingLatencyMs: run.embeddingLatencyMs,
            llmCalls: run.llmCalls,
            embeddingCalls: run.embeddingCalls,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          }
        : null,
    });
  }

  const requestedAt = new Date();
  let requestError: string | null = null;
  try {
    await requestBookAnalysis(params.bookId, "manual");
  } catch (error) {
    requestError = error instanceof Error ? error.message : "request failed";
  }

  const timeoutMs = Math.max(1, params.timeoutMinutes) * 60_000;
  const pollMs = Math.max(3, params.pollSeconds) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const book = await prisma.book.findUnique({
      where: { id: params.bookId },
      select: {
        analysisStatus: true,
        analysisError: true,
      },
    });
    const latestRun = await prisma.bookAnalysisRun.findFirst({
      where: {
        bookId: params.bookId,
        createdAt: {
          gte: requestedAt,
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        state: true,
        error: true,
        chatModel: true,
        embeddingModel: true,
        llmPromptTokens: true,
        llmCompletionTokens: true,
        llmTotalTokens: true,
        embeddingInputTokens: true,
        llmCostUsd: true,
        embeddingCostUsd: true,
        totalCostUsd: true,
        totalElapsedMs: true,
        llmLatencyMs: true,
        embeddingLatencyMs: true,
        llmCalls: true,
        embeddingCalls: true,
        startedAt: true,
        completedAt: true,
      },
    });

    if (book?.analysisStatus === "completed" && latestRun) {
      return toAnalysisEval({
        requested: true,
        state: "completed",
        run: latestRun,
      });
    }

    if (book?.analysisStatus === "failed") {
      return toAnalysisEval({
        requested: true,
        state: "failed",
        error: String(book.analysisError || latestRun?.error || requestError || "analysis failed"),
        run: latestRun,
      });
    }

    await sleep(pollMs);
  }

  const timeoutRun = await prisma.bookAnalysisRun.findFirst({
    where: {
      bookId: params.bookId,
      createdAt: {
        gte: requestedAt,
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      chatModel: true,
      embeddingModel: true,
      llmPromptTokens: true,
      llmCompletionTokens: true,
      llmTotalTokens: true,
      embeddingInputTokens: true,
      llmCostUsd: true,
      embeddingCostUsd: true,
      totalCostUsd: true,
      totalElapsedMs: true,
      llmLatencyMs: true,
      embeddingLatencyMs: true,
      llmCalls: true,
      embeddingCalls: true,
      startedAt: true,
      completedAt: true,
    },
  });

  return toAnalysisEval({
    requested: true,
    state: "timeout",
    error: requestError ? `timeout (${requestError})` : "timeout",
    run: timeoutRun,
  });
}

function parseLlmSteps(
  steps:
    | Array<{
        step?: string;
        model?: string;
        latencyMs?: number;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
      }>
    | undefined
): LlmStepUsage[] {
  if (!Array.isArray(steps)) return [];
  const rows: LlmStepUsage[] = [];
  for (const item of steps) {
    const step = String(item?.step || "").trim() || "unknown";
    const model = String(item?.model || "").trim();
    const inputTokens = Math.max(0, Math.round(asNumber(item?.usage?.inputTokens)));
    const outputTokens = Math.max(0, Math.round(asNumber(item?.usage?.outputTokens)));
    const explicitTotal = Math.max(0, Math.round(asNumber(item?.usage?.totalTokens)));
    const totalTokens = explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens;
    const pricing = resolveTokenPricing({
      chatModel: model,
      embeddingModel: "gemini-embedding-001",
    });
    const chatCostUsd =
      (inputTokens / 1_000_000) * pricing.chatInputPer1MUsd +
      (outputTokens / 1_000_000) * pricing.chatOutputPer1MUsd;

    rows.push({
      step,
      model,
      latencyMs: Math.max(0, Math.round(asNumber(item?.latencyMs))),
      inputTokens,
      outputTokens,
      totalTokens,
      chatCostUsd: round(Math.max(0, chatCostUsd)),
    });
  }
  return rows;
}

function aggregateQuestions(items: QuestionEval[]): AggregateMetrics {
  const count = items.length;
  const totalCostUsd = items.reduce((sum, item) => sum + item.totalCostUsd, 0);
  const totalLatencyMs = items.reduce((sum, item) => sum + item.totalLatencyMs, 0);
  const totalInputTokens = items.reduce((sum, item) => sum + item.modelInputTokens, 0);
  const totalOutputTokens = items.reduce((sum, item) => sum + item.modelOutputTokens, 0);
  const totalTokens = items.reduce((sum, item) => sum + item.modelTotalTokens, 0);
  const totalEmbeddingInputTokens = items.reduce((sum, item) => sum + item.embeddingInputTokens, 0);
  const citationHits = items.filter((item) => item.quality.hasCitations).length;
  const toolHits = items.filter((item) => item.quality.usedTools).length;
  const groundedHits = items.filter((item) => item.quality.groundedProxy).length;
  const fallbackHits = items.filter((item) => item.fallbackUsed).length;
  const latencies = items.map((item) => item.totalLatencyMs);
  const goldenItems = items.filter((item) => item.golden);
  const toolChecks = goldenItems
    .map((item) => item.golden?.toolCorrect)
    .filter((value): value is boolean => typeof value === "boolean");

  const stepBucket = new Map<
    string,
    {
      calls: number;
      totalLatencyMs: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      totalCostUsd: number;
    }
  >();
  for (const item of items) {
    for (const step of item.llmSteps) {
      const key = String(step.step || "").trim() || "unknown";
      const bucket = stepBucket.get(key) || {
        calls: 0,
        totalLatencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
      };
      bucket.calls += 1;
      bucket.totalLatencyMs += step.latencyMs;
      bucket.inputTokens += step.inputTokens;
      bucket.outputTokens += step.outputTokens;
      bucket.totalTokens += step.totalTokens;
      bucket.totalCostUsd += step.chatCostUsd;
      stepBucket.set(key, bucket);
    }
  }

  const stepMetrics = Array.from(stepBucket.entries())
    .map(([step, value]) => ({
      step,
      calls: value.calls,
      totalLatencyMs: value.totalLatencyMs,
      avgLatencyMs: value.calls > 0 ? Math.round(value.totalLatencyMs / value.calls) : 0,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      totalTokens: value.totalTokens,
      totalCostUsd: round(value.totalCostUsd),
    }))
    .sort((left, right) => right.totalCostUsd - left.totalCostUsd);

  return {
    questions: count,
    totalCostUsd: round(totalCostUsd),
    totalLatencyMs,
    avgLatencyMs: count > 0 ? Math.round(totalLatencyMs / count) : 0,
    p95LatencyMs: Math.round(percentile(latencies, 0.95)),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalEmbeddingInputTokens,
    citationsRate: count > 0 ? round(citationHits / count, 6) : 0,
    toolUseRate: count > 0 ? round(toolHits / count, 6) : 0,
    fallbackRate: count > 0 ? round(fallbackHits / count, 6) : 0,
    groundedProxyRate: count > 0 ? round(groundedHits / count, 6) : 0,
    recallAt5:
      goldenItems.length > 0
        ? round(goldenItems.reduce((sum, item) => sum + Number(item.golden?.recallAt5 || 0), 0) / goldenItems.length, 6)
        : 0,
    recallAt10:
      goldenItems.length > 0
        ? round(goldenItems.reduce((sum, item) => sum + Number(item.golden?.recallAt10 || 0), 0) / goldenItems.length, 6)
        : 0,
    mrr:
      goldenItems.length > 0
        ? round(goldenItems.reduce((sum, item) => sum + Number(item.golden?.mrr || 0), 0) / goldenItems.length, 6)
        : 0,
    keywordCoverage:
      goldenItems.length > 0
        ? round(
            goldenItems.reduce((sum, item) => sum + Number(item.golden?.keywordCoverage || 0), 0) / goldenItems.length,
            6
          )
        : 0,
    toolCorrectnessRate:
      toolChecks.length > 0 ? round(toolChecks.filter(Boolean).length / toolChecks.length, 6) : null,
    stepMetrics,
  };
}

function buildComparison(params: {
  baselinePath: string;
  current: AggregateMetrics;
  baseline: AggregateMetrics;
  thresholds: EvalThresholds;
}) {
  const baselineCost = Math.max(0.00000001, params.baseline.totalCostUsd);
  const baselineLatency = Math.max(1, params.baseline.p95LatencyMs);

  const costIncreasePct = (params.current.totalCostUsd - params.baseline.totalCostUsd) / baselineCost;
  const p95LatencyIncreasePct = (params.current.p95LatencyMs - params.baseline.p95LatencyMs) / baselineLatency;
  const groundedProxyDeltaPp = params.current.groundedProxyRate - params.baseline.groundedProxyRate;
  const recallAt5Delta = params.current.recallAt5 - asNumber(params.baseline.recallAt5);
  const recallAt10Delta = params.current.recallAt10 - asNumber(params.baseline.recallAt10);
  const mrrDelta = params.current.mrr - asNumber(params.baseline.mrr);
  const keywordCoverageDelta = params.current.keywordCoverage - asNumber(params.baseline.keywordCoverage);

  const costFail = costIncreasePct > params.thresholds.costIncreasePct;
  const latencyFail = p95LatencyIncreasePct > params.thresholds.p95LatencyIncreasePct;
  const groundedFail = groundedProxyDeltaPp < -params.thresholds.groundedProxyDropPp;

  return {
    baselinePath: params.baselinePath,
    deltas: {
      costIncreasePct: round(costIncreasePct, 6),
      p95LatencyIncreasePct: round(p95LatencyIncreasePct, 6),
      groundedProxyDeltaPp: round(groundedProxyDeltaPp, 6),
      recallAt5Delta: round(recallAt5Delta, 6),
      recallAt10Delta: round(recallAt10Delta, 6),
      mrrDelta: round(mrrDelta, 6),
      keywordCoverageDelta: round(keywordCoverageDelta, 6),
    },
    regression: {
      cost: costFail,
      latency: latencyFail,
      groundedProxy: groundedFail,
      failed: costFail || latencyFail || groundedFail,
    },
  };
}

function normalizeGoldenString(value: unknown): string {
  return String(value || "").trim();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => String(item || "").trim()).filter(Boolean))
  );
}

function parseGoldenCategory(value: unknown): GoldenCategory {
  const normalized = normalizeGoldenString(value);
  if (
    normalized === "factual" ||
    normalized === "chain" ||
    normalized === "comparison" ||
    normalized === "character" ||
    normalized === "theme" ||
    normalized === "quote"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported golden question category: ${normalized}`);
}

function parseGoldenQuestion(line: string, filePath: string, lineNumber: number): GoldenQuestion {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const id = normalizeGoldenString(parsed.id);
  const bookId = normalizeGoldenString(parsed.bookId);
  const question = normalizeGoldenString(parsed.question);
  const expectedParagraphIds = normalizeStringList(parsed.expectedParagraphIds);
  const expectedKeywords = normalizeStringList(parsed.expectedKeywords);
  const minRecallK = Math.max(1, Number.parseInt(String(parsed.minRecallK || 5), 10) || 5);
  if (!id || !bookId || !question) {
    throw new Error(`Invalid golden question identity at ${filePath}:${lineNumber}`);
  }
  if (!expectedParagraphIds.length) {
    throw new Error(`Golden question must include expectedParagraphIds at ${filePath}:${lineNumber}`);
  }

  return {
    id,
    bookId,
    question,
    category: parseGoldenCategory(parsed.category),
    expectedParagraphIds,
    expectedKeywords,
    minRecallK,
    expectedFirstTool: normalizeGoldenString(parsed.expectedFirstTool) || undefined,
  };
}

async function loadGoldenQuestions(goldenSetDir: string): Promise<GoldenQuestion[]> {
  const questionsDir = path.join(goldenSetDir, "questions");
  const files = (await readdir(questionsDir))
    .filter((file) => file.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));
  const questions: GoldenQuestion[] = [];
  for (const file of files) {
    const filePath = path.join(questionsDir, file);
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n");
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      questions.push(parseGoldenQuestion(trimmed, filePath, index + 1));
    }
  }
  if (!questions.length) {
    throw new Error(`No golden questions found in ${questionsDir}`);
  }
  return questions;
}

function makeParagraphRef(row: { chapterId: string; paragraphIndex: number }) {
  return `${String(row.chapterId || "").trim()}:${Math.max(0, Number(row.paragraphIndex || 0))}`;
}

async function loadExpectedParagraphRefs(questions: readonly GoldenQuestion[]) {
  const paragraphIds = Array.from(new Set(questions.flatMap((question) => question.expectedParagraphIds)));
  const rows = paragraphIds.length
    ? await prisma.bookParagraph.findMany({
        where: {
          id: {
            in: paragraphIds,
          },
        },
        select: {
          id: true,
          chapterId: true,
          paragraphIndex: true,
        },
      })
    : [];
  const refById = new Map(rows.map((row) => [row.id, makeParagraphRef(row)]));
  const missing = paragraphIds.filter((id) => !refById.has(id));
  if (missing.length) {
    throw new Error(`Golden expectedParagraphIds not found: ${missing.join(", ")}`);
  }
  return refById;
}

function extractRetrievedParagraphRefs(toolRuns: unknown): string[] {
  if (!Array.isArray(toolRuns)) return [];
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const run of toolRuns) {
    if (!run || typeof run !== "object") continue;
    const meta = (run as { resultMeta?: unknown }).resultMeta;
    if (!meta || typeof meta !== "object") continue;
    const refs = (meta as { retrievedParagraphRefs?: unknown }).retrievedParagraphRefs;
    if (!Array.isArray(refs)) continue;
    for (const item of refs) {
      if (!item || typeof item !== "object") continue;
      const chapterId = normalizeGoldenString((item as Record<string, unknown>).chapterId);
      const paragraphIndex = Number((item as Record<string, unknown>).paragraphIndex);
      if (!chapterId || !Number.isFinite(paragraphIndex) || paragraphIndex <= 0) continue;
      const ref = makeParagraphRef({ chapterId, paragraphIndex });
      if (seen.has(ref)) continue;
      seen.add(ref);
      rows.push(ref);
    }
  }
  return rows;
}

function calculateRecall(expectedRefs: readonly string[], retrievedRefs: readonly string[], topK: number): number {
  if (!expectedRefs.length) return 0;
  const retrieved = new Set(retrievedRefs.slice(0, Math.max(1, topK)));
  const hits = expectedRefs.filter((ref) => retrieved.has(ref)).length;
  return round(hits / expectedRefs.length, 6);
}

function calculateMrr(expectedRefs: readonly string[], retrievedRefs: readonly string[]): number {
  const expected = new Set(expectedRefs);
  for (const [index, ref] of retrievedRefs.entries()) {
    if (expected.has(ref)) return round(1 / (index + 1), 6);
  }
  return 0;
}

function calculateKeywordCoverage(answer: string, keywords: readonly string[]) {
  if (!keywords.length) {
    return {
      keywordCoverage: 0,
      matchedKeywords: [],
    };
  }
  const normalizedAnswer = answer.toLocaleLowerCase("ru-RU");
  const matchedKeywords = keywords.filter((keyword) => normalizedAnswer.includes(keyword.toLocaleLowerCase("ru-RU")));
  return {
    keywordCoverage: round(matchedKeywords.length / keywords.length, 6),
    matchedKeywords,
  };
}

function firstMeaningfulTool(toolRuns: unknown): string | null {
  if (!Array.isArray(toolRuns)) return null;
  for (const run of toolRuns) {
    if (!run || typeof run !== "object") continue;
    const tool = normalizeGoldenString((run as { tool?: unknown }).tool);
    if (!tool || tool === "planner" || tool.startsWith("llm_")) continue;
    return tool;
  }
  return null;
}

function createDefaultOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `evals/results/chat-regression-${timestamp}.json`;
}

function createDefaultGoldenOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DEFAULT_GOLDEN_RESULTS_DIR}/golden-${timestamp}.json`;
}

function createDefaultBaselineOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DEFAULT_GOLDEN_RESULTS_DIR}/baseline-${timestamp}.json`;
}

async function findLatestGoldenBaseline(resultsDir: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(resultsDir);
  } catch {
    return null;
  }
  const candidates = files.filter(
    (file) => (file.startsWith("baseline-") || file.startsWith("golden-")) && file.endsWith(".json")
  );
  const rows = await Promise.all(
    candidates.map(async (file) => {
      const filePath = path.join(resultsDir, file);
      const fileStat = await stat(filePath);
      return {
        filePath,
        mtimeMs: fileStat.mtimeMs,
      };
    })
  );
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return rows[0]?.filePath || null;
}

async function runGolden() {
  process.env.BOOK_CHAT_EVAL_RETRIEVAL_METRICS_ENABLED =
    process.env.BOOK_CHAT_EVAL_RETRIEVAL_METRICS_ENABLED || "1";

  const options = parseArgs(process.argv.slice(2));
  const goldenSetDir = resolvePathFromCwd(DEFAULT_GOLDEN_SET_DIR);
  const questions = await loadGoldenQuestions(goldenSetDir);
  const expectedRefById = await loadExpectedParagraphRefs(questions);
  const questionsByBook = new Map<string, GoldenQuestion[]>();
  for (const question of questions) {
    const rows = questionsByBook.get(question.bookId) || [];
    rows.push(question);
    questionsByBook.set(question.bookId, rows);
  }

  const chatTools = normalizeTools(undefined);
  const thresholds = DEFAULT_THRESHOLDS;
  const baselinePath = options.baselinePath
    ? resolvePathFromCwd(options.baselinePath)
    : await findLatestGoldenBaseline(resolvePathFromCwd(DEFAULT_GOLDEN_RESULTS_DIR));

  const booksReport: EvalBookReport[] = [];
  const bookEntries = Array.from(questionsByBook.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [bookIndex, [bookId, bookQuestions]] of bookEntries.entries()) {
    const bookRecord = await prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true, title: true },
    });
    if (!bookRecord) {
      throw new Error(`Book not found: ${bookId}`);
    }

    process.stdout.write(`\n[${bookIndex + 1}/${bookEntries.length}] ${bookRecord.title} (${bookId})\n`);
    const analysis = await runAnalysisIfNeeded({
      bookId,
      runAnalysis: false,
      timeoutMinutes: DEFAULT_ANALYSIS_TIMEOUT_MINUTES,
      pollSeconds: DEFAULT_ANALYSIS_POLL_SECONDS,
    });
    process.stdout.write(`  analysis result: ${analysis.state}${analysis.runId ? ` (run ${analysis.runId})` : ""}\n`);

    const questionReports: QuestionEval[] = [];
    for (const [questionIndex, question] of bookQuestions.entries()) {
      process.stdout.write(`  q${questionIndex + 1}/${bookQuestions.length} ${question.id}: ${question.question.slice(0, 80)}\n`);
      const result = await answerBookChatQuestion({
        bookId,
        enabledTools: chatTools,
        messages: [
          {
            role: "user",
            content: question.question,
          },
        ],
      });

      const llmSteps = parseLlmSteps(result.llmStepRuns as any);
      const answerText = String(result.answer || "").trim();
      const expectedParagraphRefs = question.expectedParagraphIds.map((id) => expectedRefById.get(id) || "");
      const retrievedParagraphRefs = extractRetrievedParagraphRefs(result.toolRuns);
      const keywordMetrics = calculateKeywordCoverage(answerText, question.expectedKeywords);
      const actualFirstTool = firstMeaningfulTool(result.toolRuns);
      const expectedFirstTool = question.expectedFirstTool || null;

      questionReports.push({
        id: question.id,
        bookId,
        category: question.category,
        question: question.question,
        answer: answerText,
        answerPreview: answerText.replace(/\s+/g, " ").slice(0, 240),
        totalLatencyMs: Math.max(0, Number(result.metrics.totalLatencyMs || 0)),
        modelInputTokens: Math.max(0, Number(result.metrics.modelInputTokens || 0)),
        modelOutputTokens: Math.max(0, Number(result.metrics.modelOutputTokens || 0)),
        modelTotalTokens: Math.max(0, Number(result.metrics.modelTotalTokens || 0)),
        embeddingInputTokens: Math.max(0, Number(result.metrics.embeddingInputTokens || 0)),
        chatCostUsd: round(Math.max(0, Number(result.metrics.chatCostUsd || 0))),
        embeddingCostUsd: round(Math.max(0, Number(result.metrics.embeddingCostUsd || 0))),
        totalCostUsd: round(Math.max(0, Number(result.metrics.totalCostUsd || 0))),
        citationCount: Math.max(0, Number(result.metrics.citationCount || 0)),
        toolRunCount: Array.isArray(result.toolRuns) ? result.toolRuns.length : 0,
        fallbackUsed: Boolean(result.metrics.fallbackUsed),
        fallbackKind: result.metrics.fallbackKind ? String(result.metrics.fallbackKind) : null,
        chatModel: String(result.metrics.chatModel || "").trim(),
        embeddingModel: String(result.metrics.embeddingModel || "").trim(),
        llmSteps,
        golden: {
          expectedParagraphIds: question.expectedParagraphIds,
          expectedParagraphRefs,
          retrievedParagraphRefs,
          recallAt5: calculateRecall(expectedParagraphRefs, retrievedParagraphRefs, 5),
          recallAt10: calculateRecall(expectedParagraphRefs, retrievedParagraphRefs, 10),
          mrr: calculateMrr(expectedParagraphRefs, retrievedParagraphRefs),
          keywordCoverage: keywordMetrics.keywordCoverage,
          matchedKeywords: keywordMetrics.matchedKeywords,
          expectedFirstTool,
          actualFirstTool,
          toolCorrect: expectedFirstTool ? actualFirstTool === expectedFirstTool : null,
        },
        quality: {
          hasCitations: Number(result.metrics.citationCount || 0) > 0,
          usedTools: (Array.isArray(result.toolRuns) ? result.toolRuns.length : 0) > 0,
          groundedProxy: Number(result.metrics.citationCount || 0) > 0 && !Boolean(result.metrics.fallbackUsed),
        },
      });
    }

    booksReport.push({
      bookId,
      label: bookRecord.title,
      analysis,
      aggregate: aggregateQuestions(questionReports),
      questions: questionReports,
    });
  }

  const overall = aggregateQuestions(booksReport.flatMap((book) => book.questions));
  const report: EvalReport = {
    version: "v1",
    generatedAt: new Date().toISOString(),
    configPath: goldenSetDir,
    name: "golden-set",
    runAnalysis: false,
    thresholds,
    chatTools,
    books: booksReport,
    overall,
  };

  if (baselinePath) {
    const baselineRaw = await readFile(baselinePath, "utf-8");
    const baseline = JSON.parse(baselineRaw) as Partial<EvalReport>;
    if (baseline?.overall) {
      report.comparison = buildComparison({
        baselinePath,
        current: overall,
        baseline: baseline.overall as AggregateMetrics,
        thresholds,
      });
    }
  }

  const outputPath = resolvePathFromCwd(options.outputPath || createDefaultGoldenOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");

  let baselineCreatedPath: string | null = null;
  if (!baselinePath) {
    baselineCreatedPath = resolvePathFromCwd(createDefaultBaselineOutputPath());
    await copyFile(outputPath, baselineCreatedPath);
  }

  process.stdout.write(`\nSaved report: ${outputPath}\n`);
  if (baselineCreatedPath) {
    process.stdout.write(`Saved baseline: ${baselineCreatedPath}\n`);
  }
  process.stdout.write(
    `Golden overall: recall@5=${report.overall.recallAt5}, recall@10=${report.overall.recallAt10}, mrr=${report.overall.mrr}, keyword_coverage=${report.overall.keywordCoverage}, costUsd=${report.overall.totalCostUsd}, p95=${report.overall.p95LatencyMs}ms\n`
  );
  if (report.comparison) {
    process.stdout.write(
      `Golden deltas: recall@5=${report.comparison.deltas.recallAt5Delta}, recall@10=${report.comparison.deltas.recallAt10Delta}, mrr=${report.comparison.deltas.mrrDelta}, keyword_coverage=${report.comparison.deltas.keywordCoverageDelta}\n`
    );
    process.stdout.write(`Regression status: ${report.comparison.regression.failed ? "FAILED" : "OK"}\n`);
    if (report.comparison.regression.failed) process.exitCode = 2;
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.golden) {
    await runGolden();
    return;
  }

  const configPath = resolvePathFromCwd(options.configPath);
  const config = await loadConfig(configPath);

  const runAnalysis = options.runAnalysisOverride ?? Boolean(config.runAnalysis);
  const chatTools = normalizeTools(config.chat?.enabledTools);
  const maxQuestions = options.maxQuestionsOverride ?? Math.max(1, Number(config.chat?.maxQuestionsPerBook || 10));
  const thresholds = normalizeThresholds(config.regressionThresholds);
  const sharedQuestions = Array.isArray(config.questions) ? config.questions.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const analysisTimeoutMinutes = Math.max(1, Number(config.analysisTimeoutMinutes || DEFAULT_ANALYSIS_TIMEOUT_MINUTES));
  const analysisPollSeconds = Math.max(3, Number(config.analysisPollSeconds || DEFAULT_ANALYSIS_POLL_SECONDS));

  const booksReport: EvalBookReport[] = [];

  for (const [bookIndex, book] of config.books.entries()) {
    const bookId = String(book.bookId || "").trim();
    if (!bookId) continue;
    const bookRecord = await prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true, title: true },
    });
    if (!bookRecord) {
      throw new Error(`Book not found: ${bookId}`);
    }

    const label = String(book.label || bookRecord.title || `book-${bookIndex + 1}`).trim();
    const questions = pickQuestions(book, sharedQuestions, maxQuestions);
    if (!questions.length) {
      throw new Error(`No questions resolved for book ${bookId}. Provide questions in book.questions or root questions.`);
    }

    process.stdout.write(`\n[${bookIndex + 1}/${config.books.length}] ${label} (${bookId})\n`);
    process.stdout.write(`  analysis: ${runAnalysis ? "run" : "skip"}\n`);

    const analysis = await runAnalysisIfNeeded({
      bookId,
      runAnalysis,
      timeoutMinutes: analysisTimeoutMinutes,
      pollSeconds: analysisPollSeconds,
    });

    process.stdout.write(`  analysis result: ${analysis.state}${analysis.runId ? ` (run ${analysis.runId})` : ""}\n`);

    const questionReports: QuestionEval[] = [];
    for (const [questionIndex, question] of questions.entries()) {
      process.stdout.write(`  q${questionIndex + 1}/${questions.length}: ${question.slice(0, 80)}\n`);
      const result = await answerBookChatQuestion({
        bookId,
        enabledTools: chatTools,
        messages: [
          {
            role: "user",
            content: question,
          },
        ],
      });

      const llmSteps = parseLlmSteps(result.llmStepRuns as any);
      const answerText = String(result.answer || "").trim();

      questionReports.push({
        question,
        answer: answerText,
        answerPreview: answerText.replace(/\s+/g, " ").slice(0, 240),
        totalLatencyMs: Math.max(0, Number(result.metrics.totalLatencyMs || 0)),
        modelInputTokens: Math.max(0, Number(result.metrics.modelInputTokens || 0)),
        modelOutputTokens: Math.max(0, Number(result.metrics.modelOutputTokens || 0)),
        modelTotalTokens: Math.max(0, Number(result.metrics.modelTotalTokens || 0)),
        embeddingInputTokens: Math.max(0, Number(result.metrics.embeddingInputTokens || 0)),
        chatCostUsd: round(Math.max(0, Number(result.metrics.chatCostUsd || 0))),
        embeddingCostUsd: round(Math.max(0, Number(result.metrics.embeddingCostUsd || 0))),
        totalCostUsd: round(Math.max(0, Number(result.metrics.totalCostUsd || 0))),
        citationCount: Math.max(0, Number(result.metrics.citationCount || 0)),
        toolRunCount: Array.isArray(result.toolRuns) ? result.toolRuns.length : 0,
        fallbackUsed: Boolean(result.metrics.fallbackUsed),
        fallbackKind: result.metrics.fallbackKind ? String(result.metrics.fallbackKind) : null,
        chatModel: String(result.metrics.chatModel || "").trim(),
        embeddingModel: String(result.metrics.embeddingModel || "").trim(),
        llmSteps,
        quality: {
          hasCitations: Number(result.metrics.citationCount || 0) > 0,
          usedTools: (Array.isArray(result.toolRuns) ? result.toolRuns.length : 0) > 0,
          groundedProxy: Number(result.metrics.citationCount || 0) > 0 && !Boolean(result.metrics.fallbackUsed),
        },
      });
    }

    booksReport.push({
      bookId,
      label,
      analysis,
      aggregate: aggregateQuestions(questionReports),
      questions: questionReports,
    });
  }

  const overall = aggregateQuestions(booksReport.flatMap((book) => book.questions));
  const report: EvalReport = {
    version: "v1",
    generatedAt: new Date().toISOString(),
    configPath,
    name: String(config.name || path.basename(configPath, path.extname(configPath))).trim() || "chat-regression",
    runAnalysis,
    thresholds,
    chatTools,
    books: booksReport,
    overall,
  };

  if (options.baselinePath) {
    const baselinePath = resolvePathFromCwd(options.baselinePath);
    const baselineRaw = await readFile(baselinePath, "utf-8");
    const baseline = JSON.parse(baselineRaw) as Partial<EvalReport>;
    if (baseline?.overall) {
      report.comparison = buildComparison({
        baselinePath,
        current: overall,
        baseline: baseline.overall as AggregateMetrics,
        thresholds,
      });
    }
  }

  const outputPath = resolvePathFromCwd(options.outputPath || createDefaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");

  process.stdout.write(`\nSaved report: ${outputPath}\n`);
  process.stdout.write(
    `Overall: costUsd=${report.overall.totalCostUsd}, p95=${report.overall.p95LatencyMs}ms, groundedProxy=${report.overall.groundedProxyRate}\n`
  );

  if (report.comparison?.regression.failed) {
    process.stdout.write("Regression status: FAILED\n");
    process.exitCode = 2;
    return;
  }
  if (report.comparison) {
    process.stdout.write("Regression status: OK\n");
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
