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

const configuredExtractProviderRaw = String(process.env.EXTRACT_LLM_PROVIDER || process.env.LLM_PROVIDER || "timeweb")
  .trim()
  .toLowerCase();
const configuredExtractProvider = configuredExtractProviderRaw === "kia" ? "kia" : "timeweb";
if (configuredExtractProviderRaw && !new Set(["timeweb", "kia"]).has(configuredExtractProviderRaw)) {
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
const isTimewebProvider = configuredExtractProvider === "timeweb";
const isKiaProvider = configuredExtractProvider === "kia";

export const workerConfig = {
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  outbox: {
    pollIntervalMs: getIntEnv("OUTBOX_POLL_INTERVAL_MS", 1200),
    batchSize: getIntEnv("OUTBOX_BATCH_SIZE", 16),
    maxAttempts: getIntEnv("OUTBOX_MAX_ATTEMPTS", 8),
  },
  imports: {
    blobDir: String(process.env.IMPORT_BLOB_DIR || "/tmp/remarka-imports").trim() || "/tmp/remarka-imports",
    maxZipUncompressedBytes: getIntEnv("IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES", 50 * 1024 * 1024),
  },
  pipeline: {
    enableEventExtraction: getBoolEnv("ENABLE_EVENT_EXTRACTION", false),
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
};
