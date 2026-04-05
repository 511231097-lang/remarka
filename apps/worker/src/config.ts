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

const DEFAULT_KIA_EXTRACT_MODEL = "gemini-3-flash-openai";

function resolveKiaModelRoute(model: string): string {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return "gemini-3-flash";
  return normalized.replace(/-openai$/i, "");
}

function normalizeKiaBaseUrl(raw: string, model: string): string {
  const value = raw.replace(/\/+$/, "");
  const modelRoute = resolveKiaModelRoute(model);
  const defaultBaseUrl = `https://api.kie.ai/${modelRoute}/v1`;

  if (!value) return defaultBaseUrl;

  const legacyApiVersionMatch = value.match(/^(https?:\/\/[^/]+)\/api\/v(\d+)$/i);
  if (legacyApiVersionMatch) {
    const host = legacyApiVersionMatch[1];
    const version = legacyApiVersionMatch[2];
    if (/^https?:\/\/api\.kie\.ai$/i.test(host)) {
      return `${host}/${modelRoute}/v${version}`;
    }
    return value;
  }

  if (/^https?:\/\/api\.kie\.ai$/i.test(value)) {
    return `${value}/${modelRoute}/v1`;
  }

  if (/\/v\d+$/i.test(value)) return value;

  return `${value}/v1`;
}

type ExtractProvider = "timeweb" | "kia" | "vertex";
type ArtifactStorageProvider = "local" | "s3";

const configuredExtractProviderRaw = String(process.env.EXTRACT_LLM_PROVIDER || process.env.LLM_PROVIDER || "vertex")
  .trim()
  .toLowerCase();
const supportedExtractProviders = new Set(["timeweb", "kia", "vertex"]);
const configuredExtractProvider: ExtractProvider =
  configuredExtractProviderRaw === "kia"
    ? "kia"
    : configuredExtractProviderRaw === "vertex"
      ? "vertex"
      : "timeweb";
if (configuredExtractProviderRaw && !supportedExtractProviders.has(configuredExtractProviderRaw)) {
  throw new Error(`Unsupported EXTRACT_LLM_PROVIDER: ${configuredExtractProviderRaw}`);
}

const DEFAULT_EXTRACT_MODEL = "a6de1886-5c89-45b8-9d7b-78eecae8a32b";
const configuredExtractModel = String(process.env.TIMEWEB_EXTRACT_MODEL || DEFAULT_EXTRACT_MODEL).trim();
const configuredFallbackModel = String(process.env.TIMEWEB_EXTRACT_FALLBACK_MODEL || "").trim();
const configuredKiaExtractModel = String(
  process.env.KIA_EXTRACT_MODEL || process.env.KIA_GEMINI_MODEL || DEFAULT_KIA_EXTRACT_MODEL
)
  .trim();
const configuredKiaFallbackModel = String(process.env.KIA_EXTRACT_FALLBACK_MODEL || "").trim();
const DEFAULT_VERTEX_EXTRACT_MODEL = "gemini-3.1-flash-lite-preview";
const configuredVertexExtractModel = String(process.env.VERTEX_EXTRACT_MODEL || DEFAULT_VERTEX_EXTRACT_MODEL).trim();
const configuredVertexFallbackModel = String(process.env.VERTEX_EXTRACT_FALLBACK_MODEL || "").trim();
const isTimewebProvider = configuredExtractProvider === "timeweb";
const isKiaProvider = configuredExtractProvider === "kia";
const isVertexProvider = configuredExtractProvider === "vertex";
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

export const workerConfig = {
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  outbox: {
    pollIntervalMs: getIntEnv("OUTBOX_POLL_INTERVAL_MS", 1200),
    batchSize: getIntEnv("OUTBOX_BATCH_SIZE", 16),
    maxAttempts: getIntEnv("OUTBOX_MAX_ATTEMPTS", 8),
    eventConcurrency: getIntEnv("OUTBOX_EVENT_CONCURRENCY", 4),
  },
  imports: {
    blobDir: defaultImportBlobDir,
    maxZipUncompressedBytes: getIntEnv("IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES", 50 * 1024 * 1024),
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
  },
  preprocessor: {
    url: String(process.env.PREPROCESSOR_URL || "http://127.0.0.1:8010").replace(/\/+$/, ""),
    timeoutMs: getIntEnv("PREPROCESSOR_TIMEOUT_MS", 20_000),
    retries: getIntEnv("PREPROCESSOR_RETRIES", 3),
  },
  extraction: {
    provider: configuredExtractProvider,
  },
  timeweb: {
    apiToken: getRequiredEnvIf("TIMEWEB_API_TOKEN", isTimewebProvider),
    proxySource: getRequiredEnvIf("TIMEWEB_PROXY_SOURCE", isTimewebProvider),
    baseHost: String(process.env.TIMEWEB_BASE_HOST || "https://agent.timeweb.cloud").replace(/\/+$/, ""),
    extractProfile: String(process.env.TIMEWEB_EXTRACT_PROFILE || "qwen").trim().toLowerCase(),
    extractAccessId: getRequiredEnvIf("TIMEWEB_EXTRACT_ACCESS_ID", isTimewebProvider),
    extractModel: configuredExtractModel,
    extractFallbackModel:
      configuredFallbackModel || (configuredExtractModel === DEFAULT_EXTRACT_MODEL ? "" : DEFAULT_EXTRACT_MODEL),
    extractMaxTokens: getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096),
    extractAttempts: getIntEnv("TIMEWEB_EXTRACT_ATTEMPTS", 3),
    timeoutMs: getIntEnv("TIMEWEB_TIMEOUT_MS", 120000),
    maxRetries: getIntEnv("TIMEWEB_MAX_RETRIES", 2),
  },
  kia: {
    apiKey: getRequiredEnvIf("KIA_API_KEY", isKiaProvider),
    proxySource: String(process.env.KIA_PROXY_SOURCE || process.env.TIMEWEB_PROXY_SOURCE || "remarka-worker-kia").trim(),
    baseUrl: normalizeKiaBaseUrl(
      String(process.env.KIA_CHAT_BASE_URL || process.env.KIA_BASE_URL || "").trim(),
      configuredKiaExtractModel
    ),
    extractModel: configuredKiaExtractModel,
    extractFallbackModel: configuredKiaFallbackModel,
    extractMaxTokens: getIntEnv("KIA_EXTRACT_MAX_TOKENS", getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096)),
    extractAttempts: getIntEnv("KIA_EXTRACT_ATTEMPTS", getIntEnv("TIMEWEB_EXTRACT_ATTEMPTS", 3)),
    timeoutMs: getIntEnv("KIA_TIMEOUT_MS", getIntEnv("TIMEWEB_TIMEOUT_MS", 120000)),
    maxRetries: getIntEnv("KIA_MAX_RETRIES", getIntEnv("TIMEWEB_MAX_RETRIES", 2)),
  },
  vertex: {
    apiKey: getRequiredEnvIf("VERTEX_API_KEY", isVertexProvider),
    proxySource: String(process.env.VERTEX_PROXY_SOURCE || process.env.TIMEWEB_PROXY_SOURCE || "remarka-worker-vertex").trim(),
    baseUrl: String(process.env.VERTEX_BASE_URL || "https://aiplatform.googleapis.com").replace(/\/+$/, ""),
    extractModel: configuredVertexExtractModel,
    extractFallbackModel: configuredVertexFallbackModel,
    extractMaxTokens: getIntEnv("VERTEX_EXTRACT_MAX_TOKENS", getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096)),
    extractAttempts: getIntEnv("VERTEX_EXTRACT_ATTEMPTS", getIntEnv("TIMEWEB_EXTRACT_ATTEMPTS", 3)),
    timeoutMs: getIntEnv("VERTEX_TIMEOUT_MS", getIntEnv("TIMEWEB_TIMEOUT_MS", 120000)),
    maxRetries: getIntEnv("VERTEX_MAX_RETRIES", getIntEnv("TIMEWEB_MAX_RETRIES", 2)),
  },
};
