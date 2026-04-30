import type { BookAnalysisState, BookFormat, Prisma } from "@prisma/client";

type AnyDbClient = Record<string, any>;

function inferBookFormat(params: { fileName?: string | null; mimeType?: string | null }): BookFormat {
  const fileName = String(params.fileName || "").trim().toLowerCase();
  const mimeType = String(params.mimeType || "").trim().toLowerCase();
  if (fileName.endsWith(".zip") || mimeType.includes("zip")) {
    return "fb2_zip";
  }
  return "fb2";
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function ensureBookContentVersion(params: {
  client: AnyDbClient;
  bookId: string;
  fileSha256: string;
  fileName?: string | null;
  mimeType?: string | null;
}): Promise<{ id: string; version: number }> {
  const latest = await params.client.bookContentVersion.findFirst({
    where: { bookId: params.bookId },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      fileSha256: true,
    },
  });

  if (latest && String(latest.fileSha256 || "").trim() === String(params.fileSha256 || "").trim()) {
    return {
      id: latest.id,
      version: Number(latest.version || 1),
    };
  }

  const created = await params.client.bookContentVersion.create({
    data: {
      bookId: params.bookId,
      version: latest ? Number(latest.version || 0) + 1 : 1,
      sourceFormat: inferBookFormat({
        fileName: params.fileName,
        mimeType: params.mimeType,
      }),
      fileSha256: String(params.fileSha256 || "").trim(),
      metadataJson: {},
    },
    select: {
      id: true,
      version: true,
    },
  });

  return {
    id: created.id,
    version: Number(created.version || 1),
  };
}

export async function createBookAnalysisRun(params: {
  client: AnyDbClient;
  bookId: string;
  contentVersionId: string;
  configVersion?: string | null;
  configHash?: string | null;
  extractModel?: string | null;
  chatModel?: string | null;
  embeddingModel?: string | null;
  pricingVersion?: string | null;
  startedAt?: Date | null;
}) {
  const latestAttempt = await params.client.bookAnalysisRun.findFirst({
    where: {
      bookId: params.bookId,
      contentVersionId: params.contentVersionId,
    },
    orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
    select: {
      attempt: true,
    },
  });

  const created = await params.client.bookAnalysisRun.create({
    data: {
      bookId: params.bookId,
      contentVersionId: params.contentVersionId,
      attempt: Math.max(1, Number(latestAttempt?.attempt || 0) + 1),
      state: "running",
      configVersion: params.configVersion ? String(params.configVersion).trim() : null,
      configHash: params.configHash ? String(params.configHash).trim() : null,
      extractModel: params.extractModel ? String(params.extractModel).trim() : null,
      chatModel: params.chatModel ? String(params.chatModel).trim() : null,
      embeddingModel: params.embeddingModel ? String(params.embeddingModel).trim() : null,
      pricingVersion: params.pricingVersion ? String(params.pricingVersion).trim() : null,
      startedAt: params.startedAt || new Date(),
    },
    select: {
      id: true,
      attempt: true,
      contentVersionId: true,
    },
  });

  await params.client.book.update({
    where: { id: params.bookId },
    data: {
      currentAnalysisRunId: created.id,
      latestAnalysisRunId: created.id,
    },
  });

  return created;
}

export async function upsertBookStageExecution(params: {
  client: AnyDbClient;
  bookId: string;
  contentVersionId: string;
  runId: string;
  stageKey: string;
  state: BookAnalysisState;
  error?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  embeddingInputTokens?: number;
  embeddingTotalTokens?: number;
  llmCostUsd?: number;
  embeddingCostUsd?: number;
  totalCostUsd?: number;
  elapsedMs?: number;
  retryCount?: number;
  llmCalls?: number;
  embeddingCalls?: number;
  chunkCount?: number;
  chunkFailedCount?: number;
  outputRowCount?: number;
  storageBytesJson?: Record<string, unknown> | null;
  metadataJson?: Record<string, unknown> | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}) {
  await params.client.bookStageExecution.upsert({
    where: {
      runId_stageKey: {
        runId: params.runId,
        stageKey: params.stageKey,
      },
    },
    create: {
      bookId: params.bookId,
      contentVersionId: params.contentVersionId,
      runId: params.runId,
      stageKey: params.stageKey,
      state: params.state,
      error: params.error ?? null,
      promptTokens: Math.max(0, Math.round(Number(params.promptTokens || 0))),
      completionTokens: Math.max(0, Math.round(Number(params.completionTokens || 0))),
      totalTokens: Math.max(0, Math.round(Number(params.totalTokens || 0))),
      embeddingInputTokens: Math.max(0, Math.round(Number(params.embeddingInputTokens || 0))),
      embeddingTotalTokens: Math.max(0, Math.round(Number(params.embeddingTotalTokens || 0))),
      llmCostUsd: Math.max(0, Number(params.llmCostUsd || 0)),
      embeddingCostUsd: Math.max(0, Number(params.embeddingCostUsd || 0)),
      totalCostUsd: Math.max(0, Number(params.totalCostUsd || 0)),
      elapsedMs: Math.max(0, Math.round(Number(params.elapsedMs || 0))),
      retryCount: Math.max(0, Math.round(Number(params.retryCount || 0))),
      llmCalls: Math.max(0, Math.round(Number(params.llmCalls || 0))),
      embeddingCalls: Math.max(0, Math.round(Number(params.embeddingCalls || 0))),
      chunkCount: Math.max(0, Math.round(Number(params.chunkCount || 0))),
      chunkFailedCount: Math.max(0, Math.round(Number(params.chunkFailedCount || 0))),
      outputRowCount: Math.max(0, Math.round(Number(params.outputRowCount || 0))),
      storageBytesJson: params.storageBytesJson ? asJson(params.storageBytesJson) : undefined,
      metadataJson: params.metadataJson ? asJson(params.metadataJson) : undefined,
      startedAt: params.startedAt ?? undefined,
      completedAt: params.completedAt ?? undefined,
    },
    update: {
      state: params.state,
      error: params.error ?? null,
      promptTokens: Math.max(0, Math.round(Number(params.promptTokens || 0))),
      completionTokens: Math.max(0, Math.round(Number(params.completionTokens || 0))),
      totalTokens: Math.max(0, Math.round(Number(params.totalTokens || 0))),
      embeddingInputTokens: Math.max(0, Math.round(Number(params.embeddingInputTokens || 0))),
      embeddingTotalTokens: Math.max(0, Math.round(Number(params.embeddingTotalTokens || 0))),
      llmCostUsd: Math.max(0, Number(params.llmCostUsd || 0)),
      embeddingCostUsd: Math.max(0, Number(params.embeddingCostUsd || 0)),
      totalCostUsd: Math.max(0, Number(params.totalCostUsd || 0)),
      elapsedMs: Math.max(0, Math.round(Number(params.elapsedMs || 0))),
      retryCount: Math.max(0, Math.round(Number(params.retryCount || 0))),
      llmCalls: Math.max(0, Math.round(Number(params.llmCalls || 0))),
      embeddingCalls: Math.max(0, Math.round(Number(params.embeddingCalls || 0))),
      chunkCount: Math.max(0, Math.round(Number(params.chunkCount || 0))),
      chunkFailedCount: Math.max(0, Math.round(Number(params.chunkFailedCount || 0))),
      outputRowCount: Math.max(0, Math.round(Number(params.outputRowCount || 0))),
      storageBytesJson: params.storageBytesJson ? asJson(params.storageBytesJson) : undefined,
      metadataJson: params.metadataJson ? asJson(params.metadataJson) : undefined,
      startedAt: params.startedAt ?? undefined,
      completedAt: params.completedAt ?? undefined,
    },
  });
}

export async function upsertBookAnalysisChapterMetric(params: {
  client: AnyDbClient;
  bookId: string;
  contentVersionId: string;
  runId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  stageKey: string;
  state: BookAnalysisState;
  error?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  embeddingInputTokens?: number;
  embeddingTotalTokens?: number;
  elapsedMs?: number;
  retryCount?: number;
  llmCalls?: number;
  embeddingCalls?: number;
  chunkCount?: number;
  chunkFailedCount?: number;
  outputRowCount?: number;
  storageBytesJson?: Record<string, unknown> | null;
  metadataJson?: Record<string, unknown> | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}) {
  await params.client.bookAnalysisChapterMetric.upsert({
    where: {
      runId_chapterId_stageKey: {
        runId: params.runId,
        chapterId: params.chapterId,
        stageKey: params.stageKey,
      },
    },
    create: {
      bookId: params.bookId,
      contentVersionId: params.contentVersionId,
      runId: params.runId,
      chapterId: params.chapterId,
      chapterOrderIndex: Math.max(0, Math.round(Number(params.chapterOrderIndex || 0))),
      chapterTitle: String(params.chapterTitle || "").trim(),
      stageKey: params.stageKey,
      state: params.state,
      error: params.error ?? null,
      promptTokens: Math.max(0, Math.round(Number(params.promptTokens || 0))),
      completionTokens: Math.max(0, Math.round(Number(params.completionTokens || 0))),
      totalTokens: Math.max(0, Math.round(Number(params.totalTokens || 0))),
      embeddingInputTokens: Math.max(0, Math.round(Number(params.embeddingInputTokens || 0))),
      embeddingTotalTokens: Math.max(0, Math.round(Number(params.embeddingTotalTokens || 0))),
      elapsedMs: Math.max(0, Math.round(Number(params.elapsedMs || 0))),
      retryCount: Math.max(0, Math.round(Number(params.retryCount || 0))),
      llmCalls: Math.max(0, Math.round(Number(params.llmCalls || 0))),
      embeddingCalls: Math.max(0, Math.round(Number(params.embeddingCalls || 0))),
      chunkCount: Math.max(0, Math.round(Number(params.chunkCount || 0))),
      chunkFailedCount: Math.max(0, Math.round(Number(params.chunkFailedCount || 0))),
      outputRowCount: Math.max(0, Math.round(Number(params.outputRowCount || 0))),
      storageBytesJson: params.storageBytesJson ? asJson(params.storageBytesJson) : undefined,
      metadataJson: params.metadataJson ? asJson(params.metadataJson) : undefined,
      startedAt: params.startedAt ?? undefined,
      completedAt: params.completedAt ?? undefined,
    },
    update: {
      chapterOrderIndex: Math.max(0, Math.round(Number(params.chapterOrderIndex || 0))),
      chapterTitle: String(params.chapterTitle || "").trim(),
      state: params.state,
      error: params.error ?? null,
      promptTokens: Math.max(0, Math.round(Number(params.promptTokens || 0))),
      completionTokens: Math.max(0, Math.round(Number(params.completionTokens || 0))),
      totalTokens: Math.max(0, Math.round(Number(params.totalTokens || 0))),
      embeddingInputTokens: Math.max(0, Math.round(Number(params.embeddingInputTokens || 0))),
      embeddingTotalTokens: Math.max(0, Math.round(Number(params.embeddingTotalTokens || 0))),
      elapsedMs: Math.max(0, Math.round(Number(params.elapsedMs || 0))),
      retryCount: Math.max(0, Math.round(Number(params.retryCount || 0))),
      llmCalls: Math.max(0, Math.round(Number(params.llmCalls || 0))),
      embeddingCalls: Math.max(0, Math.round(Number(params.embeddingCalls || 0))),
      chunkCount: Math.max(0, Math.round(Number(params.chunkCount || 0))),
      chunkFailedCount: Math.max(0, Math.round(Number(params.chunkFailedCount || 0))),
      outputRowCount: Math.max(0, Math.round(Number(params.outputRowCount || 0))),
      storageBytesJson: params.storageBytesJson ? asJson(params.storageBytesJson) : undefined,
      metadataJson: params.metadataJson ? asJson(params.metadataJson) : undefined,
      startedAt: params.startedAt ?? undefined,
      completedAt: params.completedAt ?? undefined,
    },
  });
}

export async function createBookAnalysisArtifactManifest(params: {
  client: AnyDbClient;
  runId?: string | null;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  attempt: number;
  stageKey?: string | null;
  phase: string;
  status: string;
  llmModel: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  elapsedMs?: number;
  errorMessage?: string | null;
  storageProvider?: string | null;
  payloadKey?: string | null;
  payloadSizeBytes?: number;
  payloadSha256?: string | null;
  compression?: string | null;
  schemaVersion?: string | null;
  promptText?: string | null;
  inputJson?: Record<string, unknown> | null;
  responseText?: string | null;
  parsedJson?: Record<string, unknown> | null;
}) {
  return params.client.bookAnalysisArtifact.create({
    data: {
      runId: params.runId ? String(params.runId).trim() : null,
      bookId: params.bookId,
      chapterId: params.chapterId,
      chapterOrderIndex: Math.max(0, Math.round(Number(params.chapterOrderIndex || 0))),
      chapterTitle: String(params.chapterTitle || "").trim(),
      chunkStartParagraph: Math.max(0, Math.round(Number(params.chunkStartParagraph || 0))),
      chunkEndParagraph: Math.max(0, Math.round(Number(params.chunkEndParagraph || 0))),
      attempt: Math.max(1, Math.round(Number(params.attempt || 1))),
      stageKey: params.stageKey ?? null,
      phase: String(params.phase || "").trim(),
      status: String(params.status || "").trim(),
      llmModel: String(params.llmModel || "").trim() || "unknown-llm-model",
      promptTokens: Math.max(0, Math.round(Number(params.promptTokens || 0))),
      completionTokens: Math.max(0, Math.round(Number(params.completionTokens || 0))),
      totalTokens: Math.max(0, Math.round(Number(params.totalTokens || 0))),
      elapsedMs: Math.max(0, Math.round(Number(params.elapsedMs || 0))),
      errorMessage: params.errorMessage ? String(params.errorMessage).trim() : null,
      storageProvider: params.storageProvider ? String(params.storageProvider).trim() : null,
      payloadKey: params.payloadKey ? String(params.payloadKey).trim() : null,
      payloadSizeBytes: Math.max(0, Math.round(Number(params.payloadSizeBytes || 0))),
      payloadSha256: params.payloadSha256 ? String(params.payloadSha256).trim() : null,
      compression: params.compression ? String(params.compression).trim() : null,
      schemaVersion: params.schemaVersion ? String(params.schemaVersion).trim() : null,
      promptText: params.promptText ?? null,
      inputJson: params.inputJson ? asJson(params.inputJson) : undefined,
      responseText: params.responseText ?? null,
      parsedJson: params.parsedJson ? asJson(params.parsedJson) : undefined,
    },
  });
}

export async function upsertBookChatTurnMetric(params: {
  client: AnyDbClient;
  bookId: string;
  threadId: string;
  messageId: string;
  chatModel: string;
  embeddingModel: string;
  selectedTools: string[];
  toolConfigKey: string;
  promptVariant: string;
  systemPromptVersion: string;
  pricingVersion: string;
  modelInputTokens?: number;
  modelOutputTokens?: number;
  modelTotalTokens?: number;
  modelCachedInputTokens?: number;
  modelThoughtsTokens?: number;
  embeddingInputTokens?: number;
  chatCostUsd?: number;
  embeddingCostUsd?: number;
  totalCostUsd?: number;
  totalLatencyMs?: number;
  answerLengthChars?: number;
  citationCount?: number;
  fallbackUsed?: boolean;
  fallbackKind?: string | null;
}) {
  const baseFields = {
    chatModel: String(params.chatModel || "").trim(),
    embeddingModel: String(params.embeddingModel || "").trim(),
    selectedToolsJson: asJson(params.selectedTools || []),
    toolConfigKey: String(params.toolConfigKey || "").trim(),
    promptVariant: String(params.promptVariant || "").trim(),
    systemPromptVersion: String(params.systemPromptVersion || "").trim(),
    pricingVersion: String(params.pricingVersion || "").trim(),
    modelInputTokens: Math.max(0, Math.round(Number(params.modelInputTokens || 0))),
    modelOutputTokens: Math.max(0, Math.round(Number(params.modelOutputTokens || 0))),
    modelTotalTokens: Math.max(0, Math.round(Number(params.modelTotalTokens || 0))),
    modelCachedInputTokens: Math.max(0, Math.round(Number(params.modelCachedInputTokens || 0))),
    modelThoughtsTokens: Math.max(0, Math.round(Number(params.modelThoughtsTokens || 0))),
    embeddingInputTokens: Math.max(0, Math.round(Number(params.embeddingInputTokens || 0))),
    chatCostUsd: Math.max(0, Number(params.chatCostUsd || 0)),
    embeddingCostUsd: Math.max(0, Number(params.embeddingCostUsd || 0)),
    totalCostUsd: Math.max(0, Number(params.totalCostUsd || 0)),
    totalLatencyMs: Math.max(0, Math.round(Number(params.totalLatencyMs || 0))),
    answerLengthChars: Math.max(0, Math.round(Number(params.answerLengthChars || 0))),
    citationCount: Math.max(0, Math.round(Number(params.citationCount || 0))),
    fallbackUsed: Boolean(params.fallbackUsed),
    fallbackKind: params.fallbackKind ? String(params.fallbackKind).trim() : null,
  };

  return params.client.bookChatTurnMetric.upsert({
    where: {
      messageId: params.messageId,
    },
    create: {
      bookId: params.bookId,
      threadId: params.threadId,
      messageId: params.messageId,
      ...baseFields,
    },
    update: baseFields,
  });
}

export async function replaceBookChatToolRuns(params: {
  client: AnyDbClient;
  turnMetricId: string;
  runs: Array<{
    toolName: string;
    orderIndex: number;
    latencyMs?: number;
    argsSummaryJson?: Record<string, unknown>;
    resultSummaryJson?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    storageProvider?: string | null;
    payloadKey?: string | null;
    payloadSizeBytes?: number;
    payloadSha256?: string | null;
    compression?: string | null;
  }>;
}) {
  await params.client.bookChatToolRun.deleteMany({
    where: {
      turnMetricId: params.turnMetricId,
    },
  });

  if (!params.runs.length) return;

  await params.client.bookChatToolRun.createMany({
    data: params.runs.map((run) => ({
      turnMetricId: params.turnMetricId,
      toolName: String(run.toolName || "").trim(),
      orderIndex: Math.max(0, Math.round(Number(run.orderIndex || 0))),
      latencyMs: Math.max(0, Math.round(Number(run.latencyMs || 0))),
      argsSummaryJson: asJson(run.argsSummaryJson || {}),
      resultSummaryJson: asJson(run.resultSummaryJson || {}),
      errorCode: run.errorCode ? String(run.errorCode).trim() : null,
      errorMessage: run.errorMessage ? String(run.errorMessage).trim() : null,
      storageProvider: run.storageProvider ? String(run.storageProvider).trim() : null,
      payloadKey: run.payloadKey ? String(run.payloadKey).trim() : null,
      payloadSizeBytes: Math.max(0, Math.round(Number(run.payloadSizeBytes || 0))),
      payloadSha256: run.payloadSha256 ? String(run.payloadSha256).trim() : null,
      compression: run.compression ? String(run.compression).trim() : null,
    })),
  });
}
