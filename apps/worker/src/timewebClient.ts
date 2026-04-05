import OpenAI from "openai";
import { workerConfig } from "./config";

const SUPPORTED_PROFILES = new Set(["qwen", "deepseek", "gpt", "gemini", "grok"]);

function resolveBaseUrl(accessIdOverride?: string | null) {
  const profile = workerConfig.timeweb.extractProfile;
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`Unsupported TIMEWEB_EXTRACT_PROFILE: ${profile}`);
  }

  const requestedAccessId = String(accessIdOverride || "").trim();
  const effectiveAccessId = requestedAccessId || workerConfig.timeweb.extractAccessId;
  return `${workerConfig.timeweb.baseHost}/api/v1/cloud-ai/agents/${effectiveAccessId}/v1`;
}

export function createTimewebClient(options?: { accessId?: string | null }) {
  return new OpenAI({
    apiKey: workerConfig.timeweb.apiToken,
    baseURL: resolveBaseUrl(options?.accessId),
    timeout: workerConfig.timeweb.timeoutMs,
    maxRetries: workerConfig.timeweb.maxRetries,
  });
}
