import { workerConfig } from "./config";

type VertexOpenAIMessage = {
  role: "system" | "user" | "assistant";
  content?: unknown;
};

type VertexOpenAICompletionRequest = {
  model: string;
  messages: VertexOpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: {
    type?: string;
  };
};

type VertexUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

type VertexGenerateContentResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: VertexUsageMetadata;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  if (content && typeof content === "object") return JSON.stringify(content);
  return String(content ?? "");
}

function normalizeFinishReason(raw: string | undefined): string | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "stop") return "stop";
  if (value === "max_tokens") return "length";
  return value;
}

function mapToOpenAiLikeResponse(payload: VertexGenerateContentResponse) {
  const candidate = payload.candidates?.[0];
  const text = String(candidate?.content?.parts?.[0]?.text || "").trim();
  const finishReason = normalizeFinishReason(candidate?.finishReason);
  const usage = payload.usageMetadata || {};

  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content: text,
        },
      },
    ],
    usage: {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    },
  };
}

async function callVertexGenerateContent(
  request: VertexOpenAICompletionRequest
): Promise<ReturnType<typeof mapToOpenAiLikeResponse>> {
  const systemText = request.messages
    .filter((item) => item.role === "system")
    .map((item) => stringifyMessageContent(item.content))
    .filter((item) => item.trim().length > 0)
    .join("\n\n");
  const userText = request.messages
    .filter((item) => item.role !== "system")
    .map((item) => stringifyMessageContent(item.content))
    .filter((item) => item.trim().length > 0)
    .join("\n\n");

  const endpoint = `${workerConfig.vertex.baseUrl}/v1/publishers/google/models/${encodeURIComponent(
    request.model
  )}:generateContent?key=${encodeURIComponent(workerConfig.vertex.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: userText,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: typeof request.temperature === "number" ? request.temperature : 0,
      maxOutputTokens: Number(request.max_tokens || workerConfig.vertex.extractMaxTokens),
    },
  };

  if (systemText.trim().length > 0) {
    body.systemInstruction = {
      role: "system",
      parts: [
        {
          text: systemText,
        },
      ],
    };
  }

  const responseFormatType = String(request.response_format?.type || "").trim().toLowerCase();
  if (responseFormatType === "json_object") {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
  }

  const maxRetries = Math.max(0, workerConfig.vertex.maxRetries);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), workerConfig.vertex.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-proxy-source": workerConfig.vertex.proxySource,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const message =
          (parsed &&
            typeof parsed === "object" &&
            (parsed as { error?: { message?: string } }).error?.message) ||
          text ||
          `Vertex request failed with status ${response.status}`;
        throw new Error(String(message));
      }

      return mapToOpenAiLikeResponse((parsed || {}) as VertexGenerateContentResponse);
    } catch (error) {
      const isLast = attempt >= maxRetries;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isLast) {
        break;
      }
      await sleep(200 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Vertex generateContent failed");
}

export function createVertexClient() {
  return {
    chat: {
      completions: {
        create: callVertexGenerateContent,
      },
    },
  };
}
