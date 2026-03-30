import OpenAI from "openai";
import { workerConfig } from "./config";

const SUPPORTED_PROFILES = new Set(["qwen", "deepseek", "gpt", "gemini", "grok"]);

function resolveBaseUrl() {
  const profile = workerConfig.timeweb.extractProfile;
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`Unsupported TIMEWEB_EXTRACT_PROFILE: ${profile}`);
  }

  return `${workerConfig.timeweb.baseHost}/api/v1/cloud-ai/agents/${workerConfig.timeweb.extractAccessId}/v1`;
}

export function createTimewebClient() {
  return new OpenAI({
    apiKey: workerConfig.timeweb.apiToken,
    baseURL: resolveBaseUrl(),
    timeout: workerConfig.timeweb.timeoutMs,
    maxRetries: workerConfig.timeweb.maxRetries,
  });
}
