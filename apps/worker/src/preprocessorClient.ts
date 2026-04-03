import { PrepassResultSchema, type PrepassResult } from "@remarka/contracts";
import { workerConfig } from "./config";

interface PrepassRequest {
  content: string;
  contentVersion: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPrepass(input: PrepassRequest): Promise<PrepassResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= workerConfig.preprocessor.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), workerConfig.preprocessor.timeoutMs);

    try {
      const response = await fetch(`${workerConfig.preprocessor.url}/prepass`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Preprocessor error ${response.status}: ${text || "unknown"}`);
      }

      const payload = await response.json();
      const parsed = PrepassResultSchema.parse(payload);
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < workerConfig.preprocessor.retries) {
        await sleep(250 * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Preprocessor call failed");
}
