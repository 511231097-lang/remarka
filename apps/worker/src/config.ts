function getRequiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
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

const DEFAULT_EXTRACT_MODEL = "a6de1886-5c89-45b8-9d7b-78eecae8a32b";
const configuredExtractModel = String(process.env.TIMEWEB_EXTRACT_MODEL || DEFAULT_EXTRACT_MODEL).trim();
const configuredFallbackModel = String(process.env.TIMEWEB_EXTRACT_FALLBACK_MODEL || "").trim();

export const workerConfig = {
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  queuePollIntervalSeconds: getIntEnv("QUEUE_POLL_INTERVAL_SECONDS", 2),
  timeweb: {
    apiToken: getRequiredEnv("TIMEWEB_API_TOKEN"),
    proxySource: getRequiredEnv("TIMEWEB_PROXY_SOURCE"),
    baseHost: String(process.env.TIMEWEB_BASE_HOST || "https://agent.timeweb.cloud").replace(/\/+$/, ""),
    extractProfile: String(process.env.TIMEWEB_EXTRACT_PROFILE || "qwen").trim().toLowerCase(),
    extractAccessId: getRequiredEnv("TIMEWEB_EXTRACT_ACCESS_ID"),
    extractModel: configuredExtractModel,
    extractFallbackModel:
      configuredFallbackModel || (configuredExtractModel === DEFAULT_EXTRACT_MODEL ? "" : DEFAULT_EXTRACT_MODEL),
    extractMaxTokens: getIntEnv("TIMEWEB_EXTRACT_MAX_TOKENS", 4096),
    extractAttempts: getIntEnv("TIMEWEB_EXTRACT_ATTEMPTS", 3),
    timeoutMs: getIntEnv("TIMEWEB_TIMEOUT_MS", 120000),
    maxRetries: getIntEnv("TIMEWEB_MAX_RETRIES", 2),
  },
};
