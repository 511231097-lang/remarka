export type VertexOpenAIMessage = {
  role: "system" | "user" | "assistant";
  content?: unknown;
};

export type VertexOpenAICompletionRequest = {
  model?: string;
  messages: VertexOpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  vertexThinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  response_format?: {
    type?: string;
  };
  response_schema?: Record<string, unknown>;
  response_json_schema?: Record<string, unknown>;
};

export type VertexOpenAICompletionStreamRequest = VertexOpenAICompletionRequest & {
  onDelta?: (delta: string) => void | Promise<void>;
};

export type VertexEmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY";

export type VertexEmbeddingBatchRequest = {
  model?: string;
  texts: string[];
  taskType?: VertexEmbeddingTaskType;
  outputDimensionality?: number;
  autoTruncate?: boolean;
  batchSize?: number;
};

export type VertexEmbeddingRequest = Omit<VertexEmbeddingBatchRequest, "texts"> & {
  text: string;
};

type VertexThinkingConfig = {
  thinkingBudget?: number;
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
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

type VertexPredictResponse = {
  predictions?: Array<{
    embeddings?: {
      values?: unknown;
      statistics?: {
        token_count?: number;
        truncated?: boolean;
      };
    };
  }>;
};

export interface VertexClientOptions {
  apiKey?: string;
  baseUrl?: string;
  chatModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  proxySource?: string;
}

export interface ResolvedVertexClientOptions {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  timeoutMs: number;
  maxRetries: number;
  thinkingBudget: number;
  maxOutputTokens: number;
  proxySource: string;
}

const DEFAULT_VERTEX_CONFIG = {
  baseUrl: "https://aiplatform.googleapis.com",
  chatModel: "gemini-3.1-flash-lite-preview",
  embeddingModel: "gemini-embedding-001",
  embeddingDimensions: 768,
  timeoutMs: 120000,
  maxRetries: 2,
  thinkingBudget: 0,
  maxOutputTokens: 4096,
  proxySource: "npz-vertex-client",
} satisfies Omit<ResolvedVertexClientOptions, "apiKey">;

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function isSchemaCompatibilityError(error: Error): boolean {
  const message = String(error.message || "").toLowerCase();
  return (
    message.includes("response_schema") ||
    message.includes("responseschema") ||
    message.includes("response_json_schema") ||
    message.includes("responsejsonschema")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveVertexClientOptions(overrides: Partial<VertexClientOptions> = {}): ResolvedVertexClientOptions {
  return {
    apiKey: String(overrides.apiKey ?? process.env.VERTEX_API_KEY ?? "").trim(),
    baseUrl: String(overrides.baseUrl ?? process.env.VERTEX_BASE_URL ?? DEFAULT_VERTEX_CONFIG.baseUrl).replace(/\/+$/, ""),
    chatModel: String(overrides.chatModel ?? process.env.VERTEX_CHAT_MODEL ?? DEFAULT_VERTEX_CONFIG.chatModel).trim(),
    embeddingModel: String(
      overrides.embeddingModel ?? process.env.VERTEX_EMBEDDING_MODEL ?? DEFAULT_VERTEX_CONFIG.embeddingModel
    ).trim(),
    embeddingDimensions: parseIntEnv(
      String(overrides.embeddingDimensions ?? process.env.VERTEX_EMBEDDING_DIM ?? ""),
      DEFAULT_VERTEX_CONFIG.embeddingDimensions
    ),
    timeoutMs: parseIntEnv(
      String(overrides.timeoutMs ?? process.env.VERTEX_TIMEOUT_MS ?? ""),
      DEFAULT_VERTEX_CONFIG.timeoutMs
    ),
    maxRetries: parseIntEnv(
      String(overrides.maxRetries ?? process.env.VERTEX_MAX_RETRIES ?? ""),
      DEFAULT_VERTEX_CONFIG.maxRetries
    ),
    thinkingBudget: parseIntEnv(
      String(overrides.thinkingBudget ?? process.env.VERTEX_THINKING_BUDGET ?? ""),
      DEFAULT_VERTEX_CONFIG.thinkingBudget
    ),
    maxOutputTokens: parseIntEnv(
      String(overrides.maxOutputTokens ?? process.env.VERTEX_MAX_OUTPUT_TOKENS ?? ""),
      DEFAULT_VERTEX_CONFIG.maxOutputTokens
    ),
    proxySource: String(overrides.proxySource ?? process.env.VERTEX_PROXY_SOURCE ?? DEFAULT_VERTEX_CONFIG.proxySource).trim(),
  };
}

function ensureVertexApiKey(config: ResolvedVertexClientOptions) {
  if (!config.apiKey) {
    throw new Error("VERTEX_API_KEY is required to call Vertex");
  }
}

function clampEmbeddingDimensions(values: number[], dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) return values;
  if (values.length === dimensions) return values;
  if (values.length > dimensions) return values.slice(0, dimensions);

  const out = [...values];
  while (out.length < dimensions) {
    out.push(0);
  }
  return out;
}

async function requestVertexJson(params: {
  config: ResolvedVertexClientOptions;
  endpoint: string;
  body: Record<string, unknown>;
}): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= params.config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);

    try {
      const response = await fetch(params.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-proxy-source": params.config.proxySource,
        },
        body: JSON.stringify(params.body),
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

      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= params.config.maxRetries) break;
      await sleep(200 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Vertex request failed");
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

function extractStreamText(payload: VertexGenerateContentResponse): string {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  return parts
    .map((part) => String(part?.text || ""))
    .join("");
}

function usageFromPayload(payload: VertexGenerateContentResponse) {
  const usage = payload.usageMetadata || {};
  return {
    prompt_tokens: Number(usage.promptTokenCount || 0),
    completion_tokens: Number(usage.candidatesTokenCount || 0),
    total_tokens: Number(usage.totalTokenCount || 0),
  };
}

export function createVertexClient(options: Partial<VertexClientOptions> = {}) {
  const config = resolveVertexClientOptions(options);

  async function createCompletion(request: VertexOpenAICompletionRequest) {
    ensureVertexApiKey(config);

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

    const model = String(request.model || config.chatModel).trim() || config.chatModel;
    const endpoint = `${config.baseUrl}/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

    const hasJsonResponseFormat = String(request.response_format?.type || "").trim().toLowerCase() === "json_object";
    const hasResponseSchema = !!(request.response_schema && typeof request.response_schema === "object");
    const hasResponseJsonSchema = !!(request.response_json_schema && typeof request.response_json_schema === "object");
    const hasStructuredSchema = hasResponseSchema || hasResponseJsonSchema;

    const buildBody = (includeSchema: boolean): Record<string, unknown> => {
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
          maxOutputTokens: Number(request.max_tokens || config.maxOutputTokens),
        },
      };

      if (hasJsonResponseFormat || (includeSchema && hasStructuredSchema)) {
        (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
      }

      if (includeSchema && hasResponseJsonSchema) {
        (body.generationConfig as Record<string, unknown>).responseJsonSchema = request.response_json_schema;
      } else if (includeSchema && hasResponseSchema) {
        (body.generationConfig as Record<string, unknown>).responseSchema = request.response_schema;
      }

      return body;
    };

    const applyRuntimeOptions = (body: Record<string, unknown>) => {
      const requestedThinkingLevel = String(request.vertexThinkingLevel || "").trim().toUpperCase();
      if (
        requestedThinkingLevel === "MINIMAL" ||
        requestedThinkingLevel === "LOW" ||
        requestedThinkingLevel === "MEDIUM" ||
        requestedThinkingLevel === "HIGH"
      ) {
        (body.generationConfig as Record<string, unknown>).thinkingConfig = {
          thinkingLevel: requestedThinkingLevel,
        } satisfies VertexThinkingConfig;
      } else if (config.thinkingBudget > 0) {
        (body.generationConfig as Record<string, unknown>).thinkingConfig = {
          thinkingBudget: Math.max(1, Math.floor(config.thinkingBudget)),
        } satisfies VertexThinkingConfig;
      }

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
    };

    const body = buildBody(true);
    applyRuntimeOptions(body);

    let parsed: unknown;
    try {
      parsed = await requestVertexJson({
        config,
        endpoint,
        body,
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (!hasStructuredSchema || !isSchemaCompatibilityError(normalizedError)) {
        throw normalizedError;
      }

      parsed = await requestVertexJson({
        config,
        endpoint,
        body: (() => {
          const fallbackBody = buildBody(false);
          applyRuntimeOptions(fallbackBody);
          return fallbackBody;
        })(),
      });
    }

    return mapToOpenAiLikeResponse((parsed || {}) as VertexGenerateContentResponse);
  }

  async function createCompletionStream(request: VertexOpenAICompletionStreamRequest): Promise<{
    content: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }> {
    ensureVertexApiKey(config);

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

    const model = String(request.model || config.chatModel).trim() || config.chatModel;
    const endpoint = `${config.baseUrl}/v1/publishers/google/models/${encodeURIComponent(
      model
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;
    const hasJsonResponseFormat = String(request.response_format?.type || "").trim().toLowerCase() === "json_object";
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
        maxOutputTokens: Number(request.max_tokens || config.maxOutputTokens),
      },
    };

    if (hasJsonResponseFormat) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
    }

    const requestedThinkingLevel = String(request.vertexThinkingLevel || "").trim().toUpperCase();
    if (
      requestedThinkingLevel === "MINIMAL" ||
      requestedThinkingLevel === "LOW" ||
      requestedThinkingLevel === "MEDIUM" ||
      requestedThinkingLevel === "HIGH"
    ) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingLevel: requestedThinkingLevel,
      } satisfies VertexThinkingConfig;
    } else if (config.thinkingBudget > 0) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: Math.max(1, Math.floor(config.thinkingBudget)),
      } satisfies VertexThinkingConfig;
    }

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-proxy-source": config.proxySource,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Vertex stream request failed with status ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Vertex stream response has no body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let fullText = "";
      let latestUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      const flushEventBlock = async (eventBlock: string) => {
        const lines = eventBlock
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.trimEnd());
        const dataLines = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart());
        if (!dataLines.length) return;

        const payloadText = dataLines.join("\n").trim();
        if (!payloadText || payloadText === "[DONE]") return;

        let payload: VertexGenerateContentResponse;
        try {
          payload = JSON.parse(payloadText) as VertexGenerateContentResponse;
        } catch {
          return;
        }

        latestUsage = usageFromPayload(payload);
        const chunkText = extractStreamText(payload);
        if (!chunkText) return;

        let delta = chunkText;
        if (chunkText.startsWith(fullText)) {
          delta = chunkText.slice(fullText.length);
          fullText = chunkText;
        } else {
          fullText += chunkText;
        }

        if (delta && request.onDelta) {
          await request.onDelta(delta);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd >= 0) {
          const eventBlock = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          await flushEventBlock(eventBlock);
          eventEnd = buffer.indexOf("\n\n");
        }
      }

      buffer += decoder.decode().replace(/\r/g, "");
      const trailing = buffer.trim();
      if (trailing) {
        await flushEventBlock(trailing);
      }

      return {
        content: fullText.trim(),
        usage: latestUsage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createEmbeddingsBatch(request: VertexEmbeddingBatchRequest): Promise<{
    vectors: number[][];
    usage: {
      input_tokens: number;
      total_tokens: number;
    };
  }> {
    ensureVertexApiKey(config);

    const texts = Array.isArray(request.texts) ? request.texts.map((item) => String(item ?? "")) : [];
    if (!texts.length) {
      return {
        vectors: [],
        usage: {
          input_tokens: 0,
          total_tokens: 0,
        },
      };
    }

    const model = String(request.model || config.embeddingModel).trim() || config.embeddingModel;
    const outputDimensionality = Number.isInteger(request.outputDimensionality) && Number(request.outputDimensionality) > 0
      ? Number(request.outputDimensionality)
      : config.embeddingDimensions;
    const requestedBatchSize = Number.parseInt(String(request.batchSize ?? ""), 10);
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.min(250, Math.max(1, requestedBatchSize))
      : 250;

    const vectors: number[][] = [];
    let inputTokens = 0;

    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const endpoint = `${config.baseUrl}/v1/publishers/google/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(config.apiKey)}`;
      const parsedRaw = await requestVertexJson({
        config,
        endpoint,
        body: {
          instances: batch.map((text) => ({
            task_type: request.taskType || "RETRIEVAL_DOCUMENT",
            content: text,
          })),
          parameters: {
            outputDimensionality,
            autoTruncate: request.autoTruncate !== false,
          },
        },
      });

      const parsed = (parsedRaw || {}) as VertexPredictResponse;
      const predictions = Array.isArray(parsed.predictions) ? parsed.predictions : [];
      if (predictions.length !== batch.length) {
        throw new Error(`Vertex embeddings count mismatch: got ${predictions.length}, expected ${batch.length}`);
      }

      for (const prediction of predictions) {
        const valuesRaw = prediction?.embeddings?.values;
        if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) {
          throw new Error("Vertex embedding response has no values");
        }

        const values = valuesRaw
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item));
        if (!values.length) {
          throw new Error("Vertex embedding response contains invalid values");
        }

        vectors.push(clampEmbeddingDimensions(values, outputDimensionality));
        inputTokens += Number(prediction?.embeddings?.statistics?.token_count || 0);
      }
    }

    return {
      vectors,
      usage: {
        input_tokens: inputTokens,
        total_tokens: inputTokens,
      },
    };
  }

  async function createEmbedding(request: VertexEmbeddingRequest): Promise<{
    vector: number[];
    usage: {
      input_tokens: number;
      total_tokens: number;
    };
  }> {
    const batch = await createEmbeddingsBatch({
      ...request,
      texts: [request.text],
    });
    const vector = batch.vectors[0];
    if (!vector) {
      throw new Error("Vertex embedding response has no vector");
    }

    return {
      vector,
      usage: batch.usage,
    };
  }

  return {
    config,
    chat: {
      completions: {
        create: createCompletion,
        stream: createCompletionStream,
      },
    },
    embeddings: {
      create: createEmbedding,
      createBatch: createEmbeddingsBatch,
    },
  };
}
