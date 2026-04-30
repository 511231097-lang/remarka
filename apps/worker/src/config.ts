function getRequiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getOptionalEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function getRequiredEnvIf(name: string, required: boolean): string {
  const value = getOptionalEnv(name);
  if (required && !value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getBoolEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function getFloatEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

type ArtifactStorageProvider = "local" | "s3";
type BookStorageProvider = "local" | "s3";
type VertexModelTier = "lite" | "flash" | "pro";
type AnalysisQueueMode = "outbox" | "pgboss-hybrid";

const DEFAULT_VERTEX_MODEL_BY_TIER: Record<VertexModelTier, string> = {
  lite: "gemini-3.1-flash-lite-preview",
  flash: "gemini-3.1-flash-lite-preview",
  pro: "gemini-3.1-pro-preview",
};

function parseVertexModelTier(raw: string, envName: string): VertexModelTier {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (normalized === "lite" || normalized === "flash" || normalized === "pro") {
    return normalized;
  }
  throw new Error(`${envName} must be one of: lite, flash, pro`);
}

function parseVertexModelTierOverrides(raw: string): Record<string, VertexModelTier> {
  const result: Record<string, VertexModelTier> = {};
  const value = String(raw || "").trim();
  if (!value) return result;

  const entries = value
    .split(/[,;\n]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const separatorIndex = Math.max(entry.indexOf("="), entry.indexOf(":"));
    if (separatorIndex <= 0 || separatorIndex >= entry.length - 1) {
      throw new Error(
        `VERTEX_MODEL_TIER_OVERRIDES has invalid entry "${entry}". Expected format phase=tier (example: book_literary=pro).`
      );
    }

    const phase = entry.slice(0, separatorIndex).trim();
    const tierRaw = entry.slice(separatorIndex + 1).trim();
    if (!phase) {
      throw new Error(`VERTEX_MODEL_TIER_OVERRIDES has invalid empty phase in entry "${entry}"`);
    }
    result[phase] = parseVertexModelTier(tierRaw, "VERTEX_MODEL_TIER_OVERRIDES");
  }

  return result;
}

// Vertex is the only extraction provider currently used. The legacy
// EXTRACT_LLM_PROVIDER / LLM_PROVIDER env vars are intentionally ignored
// — see the cleanup PR removing the timeweb/kia clients for context.

const configuredVertexModelByTier: Record<VertexModelTier, string> = {
  lite: String(process.env.VERTEX_MODEL_LITE || DEFAULT_VERTEX_MODEL_BY_TIER.lite).trim(),
  flash: String(process.env.VERTEX_MODEL_FLASH || DEFAULT_VERTEX_MODEL_BY_TIER.flash).trim(),
  pro: String(process.env.VERTEX_MODEL_PRO || DEFAULT_VERTEX_MODEL_BY_TIER.pro).trim(),
};
for (const [tier, model] of Object.entries(configuredVertexModelByTier)) {
  if (!model.trim()) {
    throw new Error(`VERTEX_MODEL_${tier.toUpperCase()} must not be empty`);
  }
}

const configuredVertexModelTierRaw = String(process.env.VERTEX_MODEL_TIER || process.env.VERTEX_MODEL_TIER_DEFAULT || "")
  .trim()
  .toLowerCase();
const hasExplicitVertexModelTier = configuredVertexModelTierRaw.length > 0;
const configuredVertexModelTier = parseVertexModelTier(
  configuredVertexModelTierRaw || "lite",
  hasExplicitVertexModelTier ? "VERTEX_MODEL_TIER" : "VERTEX_MODEL_TIER_DEFAULT"
);
const configuredVertexModelTierOverrides = parseVertexModelTierOverrides(process.env.VERTEX_MODEL_TIER_OVERRIDES || "");
const configuredVertexPhaseModels = Object.fromEntries(
  Object.entries(configuredVertexModelTierOverrides).map(([phase, tier]) => [phase, configuredVertexModelByTier[tier]])
) as Record<string, string>;

const configuredVertexExtractModelLegacy = String(process.env.VERTEX_EXTRACT_MODEL || "").trim();
const configuredVertexExtractModel =
  hasExplicitVertexModelTier || !configuredVertexExtractModelLegacy
    ? configuredVertexModelByTier[configuredVertexModelTier]
    : configuredVertexExtractModelLegacy;
const configuredVertexFallbackModel = String(process.env.VERTEX_EXTRACT_FALLBACK_MODEL || "").trim();
const artifactsEnabled = getBoolEnv("ANALYSIS_ARTIFACTS_ENABLED", true);
const configuredArtifactStorageProviderRaw = String(process.env.ARTIFACTS_STORAGE_PROVIDER || "local")
  .trim()
  .toLowerCase();
if (configuredArtifactStorageProviderRaw && !["local", "s3"].includes(configuredArtifactStorageProviderRaw)) {
  throw new Error(`Unsupported ARTIFACTS_STORAGE_PROVIDER: ${configuredArtifactStorageProviderRaw}`);
}
const configuredArtifactStorageProvider: ArtifactStorageProvider =
  configuredArtifactStorageProviderRaw === "s3" ? "s3" : "local";
const requireS3ArtifactConfig = artifactsEnabled && configuredArtifactStorageProvider === "s3";
const defaultImportBlobDir = String(process.env.IMPORT_BLOB_DIR || "/tmp/remarka-imports").trim() || "/tmp/remarka-imports";
const configuredBooksStorageProviderRaw = String(process.env.BOOKS_STORAGE_PROVIDER || "local")
  .trim()
  .toLowerCase();
if (configuredBooksStorageProviderRaw && !["local", "s3"].includes(configuredBooksStorageProviderRaw)) {
  throw new Error(`Unsupported BOOKS_STORAGE_PROVIDER: ${configuredBooksStorageProviderRaw}`);
}
const configuredBooksStorageProvider: BookStorageProvider =
  configuredBooksStorageProviderRaw === "s3" ? "s3" : "local";
const requireS3BooksConfig = configuredBooksStorageProvider === "s3";
const defaultBooksLocalDir =
  String(process.env.BOOKS_LOCAL_DIR || `${defaultImportBlobDir}/books`).trim() || `${defaultImportBlobDir}/books`;
const defaultBooksS3Region = "us-east-1";
const defaultBooksS3KeyPrefix = "remarka/books";
const configuredAnalysisQueueModeRaw = String(process.env.ANALYSIS_QUEUE_MODE || "pgboss-hybrid")
  .trim()
  .toLowerCase();
const configuredAnalysisQueueMode: AnalysisQueueMode =
  configuredAnalysisQueueModeRaw === "outbox" ? "outbox" : "pgboss-hybrid";

export const workerConfig = {
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  outbox: {
    pollIntervalMs: getIntEnv("OUTBOX_POLL_INTERVAL_MS", 1200),
    batchSize: getIntEnv("OUTBOX_BATCH_SIZE", 16),
    maxAttempts: getIntEnv("OUTBOX_MAX_ATTEMPTS", 8),
    eventConcurrency: getIntEnv("OUTBOX_EVENT_CONCURRENCY", 4),
    claimLeaseMs: getIntEnv("OUTBOX_CLAIM_LEASE_MS", 10 * 60_000),
    deferredDependenciesDelayMs: getIntEnv("OUTBOX_DEFERRED_DEPENDENCIES_DELAY_MS", 15_000),
    deferredLockDelayMs: getIntEnv("OUTBOX_DEFERRED_LOCK_DELAY_MS", 2_000),
    retryableFailureDelayMs: getIntEnv("OUTBOX_RETRYABLE_FAILURE_DELAY_MS", 15_000),
    staleTaskSweepIntervalMs: getIntEnv("BOOK_ANALYZER_STALE_SWEEP_INTERVAL_MS", 60_000),
    staleTaskTtlMs: getIntEnv("BOOK_ANALYZER_STALE_TASK_TTL_MS", 5_400_000),
  },
  analysisQueue: {
    mode: configuredAnalysisQueueMode,
    dispatcherEnabled: getBoolEnv("ANALYSIS_DISPATCHER_ENABLED", true),
    executorConcurrency: getIntEnv("ANALYSIS_EXECUTOR_CONCURRENCY", 1),
    jobRetryLimit: getIntEnv("ANALYSIS_JOB_RETRY_LIMIT", 5),
    jobRetryBaseMs: getIntEnv("ANALYSIS_JOB_RETRY_BASE_MS", 5_000),
    watchdogIntervalMs: getIntEnv("ANALYSIS_WATCHDOG_INTERVAL_MS", 60_000),
    runningStaleTtlMs: getIntEnv("ANALYSIS_RUNNING_STALE_TTL_MS", 45 * 60_000),
    queuedStaleTtlMs: getIntEnv("ANALYSIS_QUEUED_STALE_TTL_MS", 10 * 60_000),
    fairSharePerUserInFlight: getIntEnv("ANALYSIS_FAIR_SHARE_PER_USER_IN_FLIGHT", 1),
    fairShareDeferMs: getIntEnv("ANALYSIS_FAIR_SHARE_DEFER_MS", 15_000),
  },
  showcaseInternalApi: {
    baseUrl: String(process.env.SHOWCASE_INTERNAL_API_BASE_URL || "http://web:3000")
      .trim()
      .replace(/\/+$/, ""),
    token: String(process.env.INTERNAL_WORKER_TOKEN || "remarka-internal-dev-token").trim(),
    timeoutMs: getIntEnv("SHOWCASE_INTERNAL_API_TIMEOUT_MS", 45_000),
    maxRetries: getIntEnv("SHOWCASE_INTERNAL_API_MAX_RETRIES", 2),
  },
  imports: {
    blobDir: defaultImportBlobDir,
    maxZipUncompressedBytes: getIntEnv("IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES", 50 * 1024 * 1024),
  },
  books: {
    storageProvider: configuredBooksStorageProvider,
    localDir: defaultBooksLocalDir,
    s3: {
      bucket: getRequiredEnvIf("BOOKS_S3_BUCKET", requireS3BooksConfig),
      region: String(process.env.BOOKS_S3_REGION || defaultBooksS3Region).trim() || defaultBooksS3Region,
      endpoint: getOptionalEnv("BOOKS_S3_ENDPOINT"),
      keyPrefix: String(process.env.BOOKS_S3_KEY_PREFIX || defaultBooksS3KeyPrefix).trim() || defaultBooksS3KeyPrefix,
      forcePathStyle: getBoolEnv("BOOKS_S3_FORCE_PATH_STYLE", true),
      accessKeyId: getRequiredEnvIf("BOOKS_S3_ACCESS_KEY_ID", requireS3BooksConfig),
      secretAccessKey: getRequiredEnvIf("BOOKS_S3_SECRET_ACCESS_KEY", requireS3BooksConfig),
      sessionToken: getOptionalEnv("BOOKS_S3_SESSION_TOKEN"),
    },
  },
  artifacts: {
    enabled: artifactsEnabled,
    storageProvider: configuredArtifactStorageProvider,
    localDir:
      String(process.env.ANALYSIS_ARTIFACTS_LOCAL_DIR || `${defaultImportBlobDir}/analysis-artifacts`).trim() ||
      `${defaultImportBlobDir}/analysis-artifacts`,
    s3: {
      bucket: getRequiredEnvIf("ARTIFACTS_S3_BUCKET", requireS3ArtifactConfig),
      region: String(process.env.ARTIFACTS_S3_REGION || "us-east-1").trim() || "us-east-1",
      endpoint: getOptionalEnv("ARTIFACTS_S3_ENDPOINT"),
      keyPrefix: String(process.env.ARTIFACTS_S3_KEY_PREFIX || "remarka/analysis-artifacts").trim() || "remarka/analysis-artifacts",
      forcePathStyle: getBoolEnv("ARTIFACTS_S3_FORCE_PATH_STYLE", true),
      accessKeyId: getRequiredEnvIf("ARTIFACTS_S3_ACCESS_KEY_ID", requireS3ArtifactConfig),
      secretAccessKey: getRequiredEnvIf("ARTIFACTS_S3_SECRET_ACCESS_KEY", requireS3ArtifactConfig),
      sessionToken: getOptionalEnv("ARTIFACTS_S3_SESSION_TOKEN"),
    },
  },
  pipeline: {
    enableEventExtraction: getBoolEnv("ENABLE_EVENT_EXTRACTION", true),
    enableBookQuotesAnalyzer: getBoolEnv("BOOK_QUOTES_ANALYZER_ENABLED", true),
    enableBookLiteraryAnalyzer: getBoolEnv("BOOK_LITERARY_ANALYZER_ENABLED", true),
    analysisAutoRerunEnabled: getBoolEnv("ANALYSIS_AUTO_RERUN_ENABLED", true),
    analysisAutoRerunMaxAttempts: getIntEnv("ANALYSIS_AUTO_RERUN_MAX_ATTEMPTS", 1),
    analysisAutoRerunEmptyMinCandidates: getIntEnv("ANALYSIS_AUTO_RERUN_EMPTY_MIN_CANDIDATES", 120),
    analysisAutoRerunEmptyMinContentChars: getIntEnv("ANALYSIS_AUTO_RERUN_EMPTY_MIN_CONTENT_CHARS", 2500),
    patchWindowsCap: getIntEnv("PATCH_WINDOWS_CAP", 32),
    patchWindowSize: getIntEnv("PATCH_WINDOW_SIZE", 12),
    entityPassBatchCandidates: getIntEnv("ENTITY_PASS_BATCH_CANDIDATES", getIntEnv("ENTITY_PASS_CANDIDATES_CAP", 1200)),
    entityPassBatchSnippetsCap: getIntEnv("ENTITY_PASS_BATCH_SNIPPETS_CAP", getIntEnv("ENTITY_PASS_SNIPPETS_CAP", 192)),
    entityPassBatchSnippetMaxChars: getIntEnv(
      "ENTITY_PASS_BATCH_SNIPPET_MAX_CHARS",
      getIntEnv("ENTITY_PASS_SNIPPET_MAX_CHARS", 1200)
    ),
    entityPassBatchCandidateTextMaxChars: getIntEnv(
      "ENTITY_PASS_BATCH_CANDIDATE_TEXT_MAX_CHARS",
      getIntEnv("ENTITY_PASS_CANDIDATE_TEXT_MAX_CHARS", 160)
    ),
    entityPassKnownEntitiesCap: getIntEnv("ENTITY_PASS_KNOWN_ENTITIES_CAP", 400),
    entityPassKnownAliasesPerEntity: getIntEnv("ENTITY_PASS_KNOWN_ALIASES_PER_ENTITY", 8),
    entityPassSkipWhenNoCandidates: getBoolEnv("ENTITY_PASS_SKIP_WHEN_NO_CANDIDATES", true),
    pronounConfidenceThreshold: getFloatEnv("PRONOUN_CONFIDENCE_THRESHOLD", 0.9),
    bookPassMergeArbiterEnabled: getBoolEnv("BOOK_PASS_MERGE_ARBITER_ENABLED", true),
    bookPassMergeArbiterMaxPairs: getIntEnv("BOOK_PASS_MERGE_ARBITER_MAX_PAIRS", 12),
    bookPassMergeArbiterMinMentionCount: getIntEnv("BOOK_PASS_MERGE_ARBITER_MIN_MENTION_COUNT", 5),
    bookPassMergeArbiterConfidenceThreshold: getFloatEnv("BOOK_PASS_MERGE_ARBITER_CONFIDENCE_THRESHOLD", 0.95),
    bookPassMergeArbiterSurnameDistance: getIntEnv("BOOK_PASS_MERGE_ARBITER_SURNAME_DISTANCE", 1),
    bookPassMergeArbiterEvidenceMentionsPerEntity: getIntEnv("BOOK_PASS_MERGE_ARBITER_EVIDENCE_MENTIONS_PER_ENTITY", 6),
    bookEmbeddingConcurrency: getIntEnv("BOOK_EMBEDDING_CONCURRENCY", 8),
    bookSceneEdgeBatchSize: getIntEnv("BOOK_SCENE_EDGE_BATCH_SIZE", 12),
    bookSceneEdgeBatchConcurrency: getIntEnv("BOOK_SCENE_EDGE_BATCH_CONCURRENCY", 6),
    bookSceneEdgeCharLimit: getIntEnv("BOOK_SCENE_EDGE_CHAR_LIMIT", 180),
    bookSceneEdgeMaxTokens: getIntEnv("BOOK_SCENE_EDGE_MAX_TOKENS", 4096),
    bookSceneEdgeMaxAttempts: getIntEnv("BOOK_SCENE_EDGE_MAX_ATTEMPTS", 1),
  },
  vertex: {
    apiKey: getRequiredEnv("VERTEX_API_KEY"),
    proxySource: String(process.env.VERTEX_PROXY_SOURCE || process.env.TIMEWEB_PROXY_SOURCE || "remarka-worker-vertex").trim(),
    baseUrl: String(process.env.VERTEX_BASE_URL || "https://aiplatform.googleapis.com").replace(/\/+$/, ""),
    modelTier: configuredVertexModelTier,
    modelByTier: configuredVertexModelByTier,
    modelTierOverrides: configuredVertexModelTierOverrides,
    phaseModels: configuredVertexPhaseModels,
    extractModel: configuredVertexExtractModel,
    chatModel:
      String(process.env.VERTEX_CHAT_MODEL || "").trim() ||
      configuredVertexModelByTier.lite ||
      configuredVertexExtractModel,
    embeddingModel: String(process.env.VERTEX_EMBEDDING_MODEL || "gemini-embedding-001").trim() || "gemini-embedding-001",
    embeddingDimensions: getIntEnv("VERTEX_EMBEDDING_DIM", 768),
    extractFallbackModel: configuredVertexFallbackModel,
    extractMaxTokens: getIntEnv("VERTEX_EXTRACT_MAX_TOKENS", getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096)),
    literaryMaxTokens: getIntEnv(
      "VERTEX_LITERARY_MAX_TOKENS",
      getIntEnv("VERTEX_EXTRACT_MAX_TOKENS", getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096))
    ),
    thinkingBudget: getIntEnv("VERTEX_THINKING_BUDGET", 0),
    extractAttempts: getIntEnv("VERTEX_EXTRACT_ATTEMPTS", getIntEnv("TIMEWEB_EXTRACT_ATTEMPTS", 3)),
    timeoutMs: getIntEnv("VERTEX_TIMEOUT_MS", getIntEnv("TIMEWEB_TIMEOUT_MS", 120000)),
    maxRetries: getIntEnv("VERTEX_MAX_RETRIES", getIntEnv("TIMEWEB_MAX_RETRIES", 2)),
  },
};
