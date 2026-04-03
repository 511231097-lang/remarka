import OpenAI from "openai";
import { workerConfig } from "./config";

export function createKiaClient() {
  return new OpenAI({
    apiKey: workerConfig.kia.apiKey,
    baseURL: workerConfig.kia.baseUrl,
    timeout: workerConfig.kia.timeoutMs,
    maxRetries: workerConfig.kia.maxRetries,
  });
}
