import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createVertexClient } from "@remarka/ai";
import {
  createArtifactBlobStoreFromEnv,
  createBookAnalysisArtifactManifest,
  createBookAnalysisRun,
  createNpzPrismaAdapter,
  ensureBookContentVersion,
  putArtifactPayload,
  resolveBookTextCorpus,
  resolvePricingVersion,
  resolveTokenPricing,
  upsertBookAnalysisChapterMetric,
  upsertBookStageExecution,
  prisma as basePrisma,
  type BlobStore,
} from "@remarka/db";
import { z } from "zod";

const prisma = createNpzPrismaAdapter(basePrisma);
const PGVECTOR_EMBEDDING_DIMENSIONS = 768;
const ANALYSIS_CONFIG_VERSION = "npz-analysis-v1";
const ANALYSIS_ARTIFACT_SCHEMA_VERSION = "analysis-artifact-payload-v1";
const ANALYSIS_FINALIZE_STAGE = "finalize";
const ANALYSIS_PARAGRAPH_STAGE = "paragraph_embeddings";
const ANALYSIS_SCENE_CHUNK_STAGE = "scene_chunk_llm";
const ANALYSIS_SCENE_EMBEDDING_STAGE = "scene_embeddings";

let artifactBlobStore: BlobStore | null = null;

function getArtifactBlobStore() {
  if (!artifactBlobStore) {
    artifactBlobStore = createArtifactBlobStoreFromEnv();
  }
  return artifactBlobStore;
}

function serializePgVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimensions mismatch: got ${Array.isArray(vector) ? vector.length : 0}, expected ${PGVECTOR_EMBEDDING_DIMENSIONS}`
    );
  }

  return `[${vector
    .map((value, index) => {
      const normalized = Number(value);
      if (!Number.isFinite(normalized)) {
        throw new Error(`Embedding contains non-finite value at index ${index}`);
      }
      return Number(normalized.toFixed(12)).toString();
    })
    .join(",")}]`;
}

export interface ParagraphBlock {
  index: number;
  text: string;
}

const SCENE_BOUNDARY_REASON_VALUES = [
  "location_shift",
  "time_shift",
  "action_shift",
  "participant_shift",
  "narrative_cut",
] as const;

export type SceneBoundaryReason = (typeof SCENE_BOUNDARY_REASON_VALUES)[number];

export interface ParagraphChunk {
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  paragraphs: ParagraphBlock[];
}

const SCENE_WINDOW_STRATEGY = "sliding";

export interface SceneBoundaryCandidate {
  betweenParagraphs: [number, number];
  reason: SceneBoundaryReason;
  confidence: number;
}

export interface SceneEvidenceSpan {
  label: string;
  paragraphStart: number;
  paragraphEnd: number;
}

export interface SceneCandidate {
  paragraphStart: number;
  paragraphEnd: number;
  sceneCard: string;
  participants: string[];
  mentionedEntities: string[];
  locationHints: string[];
  timeHints: string[];
  eventLabels: string[];
  unresolvedForms: string[];
  facts: string[];
  evidenceSpans: SceneEvidenceSpan[];
}

export interface EmbeddingBoundaryHint {
  betweenParagraphs: [number, number];
  distance: number;
  confidence: number;
}

export interface AnalysisLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChapterAnalysisStat = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  status: "pending" | "running" | "completed" | "failed";
  llmModel: string;
  embeddingModel: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  totalBlocks: number;
  checkedBlocks: number;
  chunkCount: number;
  chunkFailedCount: number;
  llmCalls: number;
  llmRetries: number;
  llmLatencyMs: number;
  embeddingCalls: number;
  embeddingLatencyMs: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTotalTokens: number;
  embeddingInputTokens: number;
  embeddingTotalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type AnalysisChapterInput = {
  id: string;
  orderIndex: number;
  title: string;
  rawText: string;
};

type StageMetricSnapshot = {
  state: "queued" | "running" | "completed" | "failed";
  error: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  embeddingInputTokens: number;
  embeddingTotalTokens: number;
  elapsedMs: number;
  retryCount: number;
  llmCalls: number;
  embeddingCalls: number;
  chunkCount: number;
  chunkFailedCount: number;
  outputRowCount: number;
  storageBytes: Record<string, number>;
  startedAt: string | null;
  completedAt: string | null;
};

type RunStorageBytes = {
  paragraphEmbeddings: number;
  sceneEmbeddings: number;
  sceneData: number;
  artifactPayloads: number;
};

type RunMetricContext = {
  runId: string;
  contentVersionId: string;
  pricingVersion: string;
  configHash: string;
  stageMetrics: Record<string, StageMetricSnapshot>;
  chapterStageMetrics: Map<string, Record<string, StageMetricSnapshot>>;
  storageBytes: RunStorageBytes;
};

const ChunkBoundaryRawSchema = z
  .object({
    betweenParagraphs: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    reason: z.enum(SCENE_BOUNDARY_REASON_VALUES),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const ChunkEvidenceSpanRawSchema = z
  .object({
    label: z.string(),
    paragraphStart: z.number().int().positive(),
    paragraphEnd: z.number().int().positive(),
  })
  .strict();

const ChunkSceneRawSchema = z
  .object({
    paragraphStart: z.number().int().positive(),
    paragraphEnd: z.number().int().positive(),
    sceneCard: z.string().optional().default(""),
    participants: z.array(z.string()),
    mentionedEntities: z.array(z.string()),
    locationHints: z.array(z.string()),
    timeHints: z.array(z.string()),
    eventLabels: z.array(z.string()),
    unresolvedForms: z.array(z.string()),
    facts: z.array(z.string()),
    evidenceSpans: z.array(ChunkEvidenceSpanRawSchema),
  })
  .strict();

const ChunkSceneResponseRawSchema = z
  .object({
    boundaries: z.array(ChunkBoundaryRawSchema),
    scenes: z.array(ChunkSceneRawSchema),
  })
  .strict();

type ChunkBoundaryRaw = z.infer<typeof ChunkBoundaryRawSchema>;
type ChunkEvidenceSpanRaw = z.infer<typeof ChunkEvidenceSpanRawSchema>;
type ChunkSceneRaw = z.infer<typeof ChunkSceneRawSchema>;

export const SCENE_CHUNK_RESPONSE_JSON_SCHEMA = {
  type: "object",
  propertyOrdering: ["boundaries", "scenes"],
  properties: {
    boundaries: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: ["betweenParagraphs", "reason", "confidence"],
        properties: {
          betweenParagraphs: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
          reason: {
            type: "string",
            enum: [...SCENE_BOUNDARY_REASON_VALUES],
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
        required: ["betweenParagraphs", "reason", "confidence"],
        additionalProperties: false,
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: [
          "paragraphStart",
          "paragraphEnd",
          "sceneCard",
          "participants",
          "mentionedEntities",
          "locationHints",
          "timeHints",
          "eventLabels",
          "unresolvedForms",
          "facts",
          "evidenceSpans",
        ],
        properties: {
          paragraphStart: { type: "integer" },
          paragraphEnd: { type: "integer" },
          sceneCard: { type: "string" },
          participants: { type: "array", items: { type: "string" } },
          mentionedEntities: { type: "array", items: { type: "string" } },
          locationHints: { type: "array", items: { type: "string" } },
          timeHints: { type: "array", items: { type: "string" } },
          eventLabels: { type: "array", items: { type: "string" } },
          unresolvedForms: { type: "array", items: { type: "string" } },
          facts: { type: "array", items: { type: "string" } },
          evidenceSpans: {
            type: "array",
            items: {
              type: "object",
              propertyOrdering: ["label", "paragraphStart", "paragraphEnd"],
              properties: {
                label: { type: "string" },
                paragraphStart: { type: "integer" },
                paragraphEnd: { type: "integer" },
              },
              required: ["label", "paragraphStart", "paragraphEnd"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "paragraphStart",
          "paragraphEnd",
          "sceneCard",
          "participants",
          "mentionedEntities",
          "locationHints",
          "timeHints",
          "eventLabels",
          "unresolvedForms",
          "facts",
          "evidenceSpans",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["boundaries", "scenes"],
  additionalProperties: false,
} as const;

type EmbeddingUsage = {
  input_tokens?: number;
  total_tokens?: number;
};

function getIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFloatEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(String(process.env[name] || "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

const EMBEDDING_BATCH_SIZE = Math.min(250, Math.max(1, getIntEnv("VERTEX_EMBEDDING_BATCH_SIZE", 250)));
const EMBEDDING_BOUNDARY_PERCENTILE = Math.min(0.99, Math.max(0.5, getFloatEnv("ANALYSIS_EMBEDDING_HINT_PERCENTILE", 0.82)));
const EMBEDDING_BOUNDARY_MAX_HINTS = Math.max(1, getIntEnv("ANALYSIS_EMBEDDING_HINT_MAX", 96));
const PARAGRAPH_EMBEDDING_VERSION = Math.max(1, getIntEnv("PARAGRAPH_EMBEDDING_VERSION", 1));
const SCENE_EMBEDDING_BATCH_SIZE = Math.min(250, Math.max(1, getIntEnv("SCENE_EMBEDDING_BATCH_SIZE", 200)));
const SCENE_EMBEDDING_VERSION = Math.max(1, getIntEnv("SCENE_EMBEDDING_VERSION", 1));
const SCENE_EMBEDDING_EXCERPT_MAX_CHARS = Math.max(200, getIntEnv("SCENE_EMBEDDING_EXCERPT_MAX_CHARS", 1200));
const SCENE_EMBEDDING_TEXT_MAX_CHARS = Math.max(400, getIntEnv("SCENE_EMBEDDING_TEXT_MAX_CHARS", 2400));
const ANALYSIS_CHUNK_CONCURRENCY = Math.max(1, getIntEnv("ANALYSIS_CHUNK_CONCURRENCY", 4));
const ANALYSIS_CHAPTER_CONCURRENCY = Math.max(1, getIntEnv("ANALYSIS_CHAPTER_CONCURRENCY", 4));
const ANALYSIS_CHUNK_RETRY_MAX_ATTEMPTS = Math.max(1, getIntEnv("ANALYSIS_CHUNK_RETRY_MAX_ATTEMPTS", 5));
const ANALYSIS_CHUNK_RETRY_BASE_MS = Math.max(250, getIntEnv("ANALYSIS_CHUNK_RETRY_BASE_MS", 1500));
const ANALYSIS_ARTIFACT_PROMPT_MAX_CHARS = Math.max(1000, getIntEnv("ANALYSIS_ARTIFACT_PROMPT_MAX_CHARS", 80_000));
const ANALYSIS_ARTIFACT_RESPONSE_MAX_CHARS = Math.max(1000, getIntEnv("ANALYSIS_ARTIFACT_RESPONSE_MAX_CHARS", 80_000));
const ANALYSIS_ARTIFACT_ERROR_MAX_CHARS = Math.max(200, getIntEnv("ANALYSIS_ARTIFACT_ERROR_MAX_CHARS", 4000));
const SCENE_CHUNK_SIZE = 20;
const SCENE_CHUNK_OVERLAP = 2;
const POSTGRES_MAX_BIND_VARIABLES = 32_767;
const EMBEDDING_INSERT_BIND_VARIABLES_PER_ROW = 13;
const EMBEDDING_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.min(2_000, Math.floor(POSTGRES_MAX_BIND_VARIABLES / EMBEDDING_INSERT_BIND_VARIABLES_PER_ROW) - 50)
);

function normalizeWhitespace(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (!items.length) return [];
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += normalizedChunkSize) {
    chunks.push(items.slice(index, index + normalizedChunkSize));
  }
  return chunks;
}

export function splitChapterIntoBlocks(rawText: string): ParagraphBlock[] {
  const normalized = normalizeWhitespace(rawText);
  if (!normalized) return [];

  return normalized
    .split(/\n{2,}/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text, index) => ({
      index: index + 1,
      text,
    }));
}

export function createParagraphChunks(
  paragraphs: ParagraphBlock[],
  chunkSize = SCENE_CHUNK_SIZE,
  overlap = SCENE_CHUNK_OVERLAP
): ParagraphChunk[] {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be > 0");
  }
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must be >= 0 and < chunkSize");
  }
  if (!paragraphs.length) return [];

  const stride = chunkSize - overlap;
  const chunks: ParagraphChunk[] = [];
  let startIndex = 0;

  while (startIndex < paragraphs.length) {
    const endIndex = Math.min(startIndex + chunkSize - 1, paragraphs.length - 1);
    const chunkParagraphs = paragraphs.slice(startIndex, endIndex + 1);
    chunks.push({
      chunkStartParagraph: chunkParagraphs[0]!.index,
      chunkEndParagraph: chunkParagraphs[chunkParagraphs.length - 1]!.index,
      paragraphs: chunkParagraphs,
    });

    if (endIndex >= paragraphs.length - 1) {
      break;
    }

    startIndex += stride;
  }

  return chunks;
}

function createSceneAnalysisChunks(params: {
  paragraphs: ParagraphBlock[];
  embeddingHints: EmbeddingBoundaryHint[];
}): ParagraphChunk[] {
  void params.embeddingHints;
  return createParagraphChunks(params.paragraphs, SCENE_CHUNK_SIZE, SCENE_CHUNK_OVERLAP);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index] || 0);
    const rightValue = Number(right[index] || 0);
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;

  return dot / denominator;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return Number(sorted[index] || 0);
}

export function buildEmbeddingBoundaryHints(params: {
  vectors: number[][];
  percentile?: number;
  maxHints?: number;
}): EmbeddingBoundaryHint[] {
  const vectors = params.vectors || [];
  if (vectors.length < 2) return [];

  const percentileThreshold = Math.min(0.99, Math.max(0.5, Number(params.percentile ?? EMBEDDING_BOUNDARY_PERCENTILE)));
  const maxHints = Math.max(
    1,
    Math.min(
      Math.max(1, vectors.length - 1),
      Number.isFinite(Number(params.maxHints)) ? Number(params.maxHints) : EMBEDDING_BOUNDARY_MAX_HINTS
    )
  );

  const edges = Array.from({ length: vectors.length - 1 }, (_, index) => {
    const similarity = cosineSimilarity(vectors[index] || [], vectors[index + 1] || []);
    return {
      betweenParagraphs: [index + 1, index + 2] as [number, number],
      distance: Math.max(0, 1 - similarity),
    };
  });

  const distances = edges.map((edge) => edge.distance).filter((value) => Number.isFinite(value));
  if (!distances.length) return [];

  const threshold = percentile(distances, percentileThreshold);
  let selected = edges.filter((edge) => edge.distance >= threshold && edge.distance > 0);
  if (!selected.length) {
    const strongest = edges
      .slice()
      .sort((left, right) => right.distance - left.distance)
      .filter((edge) => edge.distance > 0)
      .slice(0, 1);
    selected = strongest;
  }

  selected = selected
    .slice()
    .sort((left, right) => right.distance - left.distance)
    .slice(0, maxHints);

  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);

  return selected
    .map((edge) => ({
      betweenParagraphs: edge.betweenParagraphs,
      distance: edge.distance,
      confidence:
        maxDistance > minDistance ? (edge.distance - minDistance) / (maxDistance - minDistance) : 0.5,
    }))
    .sort((left, right) => left.betweenParagraphs[0] - right.betweenParagraphs[0]);
}

function pickEmbeddingHintsForChunk(
  hints: EmbeddingBoundaryHint[],
  chunkStartParagraph: number,
  chunkEndParagraph: number
): EmbeddingBoundaryHint[] {
  return hints.filter(
    (hint) =>
      hint.betweenParagraphs[0] >= chunkStartParagraph && hint.betweenParagraphs[1] <= chunkEndParagraph
  );
}

function parsePositiveInt(value: unknown, fieldName: string): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return parsed;
}

function parseConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("Invalid boundary confidence");
  }
  return parsed;
}

function parseStringArray(value: unknown, fieldName: string, maxLength?: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  const normalized = Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  if (maxLength && maxLength > 0) {
    return normalized.slice(0, maxLength);
  }

  return normalized;
}

function parseOptionalStringArray(value: unknown, maxLength?: number): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
  if (maxLength && maxLength > 0) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function normalizeEvidenceSpans(
  rawEvidenceSpans: ChunkEvidenceSpanRaw[],
  sceneStart: number,
  sceneEnd: number
): SceneEvidenceSpan[] {
  const normalized = rawEvidenceSpans
    .slice(0, 4)
    .flatMap((entry) => {
      const label = String(entry.label || "").trim();
      if (!label) {
        return [];
      }

      let paragraphStart: number;
      let paragraphEnd: number;
      try {
        paragraphStart = parsePositiveInt(entry.paragraphStart, "evidenceSpans.paragraphStart");
        paragraphEnd = parsePositiveInt(entry.paragraphEnd, "evidenceSpans.paragraphEnd");
      } catch {
        return [];
      }

      if (paragraphStart > paragraphEnd) {
        return [];
      }

      if (paragraphEnd < sceneStart || paragraphStart > sceneEnd) {
        return [];
      }

      return [
        {
          label,
          paragraphStart: Math.max(sceneStart, paragraphStart),
          paragraphEnd: Math.min(sceneEnd, paragraphEnd),
        } satisfies SceneEvidenceSpan,
      ];
    });

  return dedupeEvidenceSpans(normalized).sort(
    (left, right) => left.paragraphStart - right.paragraphStart || left.paragraphEnd - right.paragraphEnd
  );
}

function normalizeChunkBoundaries(rawBoundaries: ChunkBoundaryRaw[], chunkStart: number, chunkEnd: number): SceneBoundaryCandidate[] {
  return rawBoundaries.map((row) => {
    const left = parsePositiveInt(row.betweenParagraphs[0], "betweenParagraphs[0]");
    const right = parsePositiveInt(row.betweenParagraphs[1], "betweenParagraphs[1]");
    if (right !== left + 1) {
      throw new Error("betweenParagraphs must contain adjacent indexes");
    }
    if (left < chunkStart || right > chunkEnd) {
      throw new Error("Boundary is outside chunk range");
    }

    return {
      betweenParagraphs: [left, right],
      reason: row.reason,
      confidence: parseConfidence(row.confidence),
    } satisfies SceneBoundaryCandidate;
  });
}

function parseJsonObject<T>(content: unknown): T {
  const text = String(content || "").trim();
  if (!text) {
    throw new Error("Model returned empty response");
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model returned non-object JSON");
  }

  return parsed as T;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampChars(value: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return String(value || "");
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function isRetriableChunkError(error: Error): boolean {
  const message = String(error.message || "").toLocaleLowerCase("en-US");
  const statusMatch = message.match(/\bstatus[\s:=]+(\d{3})\b/);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1] || "", 10) : Number.NaN;
  if (Number.isFinite(statusCode)) {
    if (statusCode === 408 || statusCode === 429) return true;
    if (statusCode >= 500 && statusCode <= 599) return true;
  }

  const transientFragments = [
    "resource exhausted",
    "error-code-429",
    "rate limit",
    "too many requests",
    "status 429",
    "status 408",
    "timeout",
    "timed out",
    "abort",
    "aborted",
    "fetch failed",
    "network",
    "connection reset",
    "econnreset",
    "etimedout",
    "econnrefused",
    "socket hang up",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
  ];

  return transientFragments.some((fragment) => message.includes(fragment));
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeChunkScenes(rawScenes: ChunkSceneRaw[], chunkStart: number, chunkEnd: number): SceneCandidate[] {
  const scenes = rawScenes.map((row) => {
    const paragraphStart = parsePositiveInt(row.paragraphStart, "paragraphStart");
    const paragraphEnd = parsePositiveInt(row.paragraphEnd, "paragraphEnd");
    if (paragraphStart < chunkStart || paragraphEnd > chunkEnd || paragraphStart > paragraphEnd) {
      throw new Error("Scene is outside chunk range");
    }

    return {
      paragraphStart,
      paragraphEnd,
      sceneCard: String(row.sceneCard || "").trim(),
      participants: parseStringArray(row.participants, "participants"),
      mentionedEntities: parseStringArray(row.mentionedEntities, "mentionedEntities"),
      locationHints: parseStringArray(row.locationHints, "locationHints"),
      timeHints: parseStringArray(row.timeHints, "timeHints"),
      eventLabels: parseStringArray(row.eventLabels, "eventLabels", 4),
      unresolvedForms: parseStringArray(row.unresolvedForms, "unresolvedForms"),
      facts: parseStringArray(row.facts, "facts", 5),
      evidenceSpans: normalizeEvidenceSpans(row.evidenceSpans, paragraphStart, paragraphEnd),
    } satisfies SceneCandidate;
  });

  const sorted = scenes
    .slice()
    .sort((left, right) => left.paragraphStart - right.paragraphStart || left.paragraphEnd - right.paragraphEnd);

  if (!sorted.length) {
    throw new Error("scenes must cover chunk range");
  }
  if (sorted[0]!.paragraphStart !== chunkStart) {
    throw new Error("scenes must start from chunkStartParagraph");
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.paragraphStart !== prev.paragraphEnd + 1) {
      throw new Error("scenes must be contiguous without gaps/overlaps");
    }
  }

  if (sorted[sorted.length - 1]!.paragraphEnd !== chunkEnd) {
    throw new Error("scenes must end at chunkEndParagraph");
  }

  return sorted;
}

function reconcileChunkBoundariesWithScenes(
  rawBoundaries: SceneBoundaryCandidate[],
  scenes: SceneCandidate[]
): SceneBoundaryCandidate[] {
  if (scenes.length <= 1) {
    return [];
  }

  const boundaryByPair = new Map<string, SceneBoundaryCandidate>();
  for (const boundary of rawBoundaries) {
    const key = `${boundary.betweenParagraphs[0]}-${boundary.betweenParagraphs[1]}`;
    const current = boundaryByPair.get(key);
    if (!current || boundary.confidence > current.confidence) {
      boundaryByPair.set(key, boundary);
    }
  }

  return scenes.slice(0, -1).map((scene) => {
    const pair: [number, number] = [scene.paragraphEnd, scene.paragraphEnd + 1];
    const key = `${pair[0]}-${pair[1]}`;
    const matched = boundaryByPair.get(key);
    if (matched) {
      return matched;
    }

    return {
      betweenParagraphs: pair,
      reason: "narrative_cut",
      confidence: 0.5,
    } satisfies SceneBoundaryCandidate;
  });
}

export function parseChunkSceneResponse(params: {
  content: unknown;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
}): {
  boundaries: SceneBoundaryCandidate[];
  scenes: SceneCandidate[];
} {
  const parsed = ChunkSceneResponseRawSchema.parse(parseJsonObject<unknown>(params.content));
  const rawBoundaries = normalizeChunkBoundaries(
    parsed.boundaries,
    params.chunkStartParagraph,
    params.chunkEndParagraph
  );
  const scenes = normalizeChunkScenes(parsed.scenes, params.chunkStartParagraph, params.chunkEndParagraph);
  const boundaries = reconcileChunkBoundariesWithScenes(rawBoundaries, scenes);

  return {
    boundaries,
    scenes,
  };
}

function usageFromResponse(response: unknown): Usage {
  if (!response || typeof response !== "object") return {};
  const usage = (response as { usage?: Usage }).usage;
  if (!usage || typeof usage !== "object") return {};
  return usage;
}

function sumUsage(left: Usage, right: Usage): Usage {
  const prompt = Math.max(0, Number(left.prompt_tokens || 0)) + Math.max(0, Number(right.prompt_tokens || 0));
  const completion =
    Math.max(0, Number(left.completion_tokens || 0)) + Math.max(0, Number(right.completion_tokens || 0));
  const total = Math.max(0, Number(left.total_tokens || 0)) + Math.max(0, Number(right.total_tokens || 0));

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
  };
}

function addUsage(target: ChapterAnalysisStat, usage: Usage) {
  const promptTokens = Math.max(0, Number(usage.prompt_tokens || 0));
  const completionTokens = Math.max(0, Number(usage.completion_tokens || 0));
  const totalTokens = Math.max(0, Number(usage.total_tokens || promptTokens + completionTokens));

  target.llmPromptTokens += promptTokens;
  target.llmCompletionTokens += completionTokens;
  target.llmTotalTokens += totalTokens;

  target.promptTokens += promptTokens;
  target.completionTokens += completionTokens;
  target.totalTokens += totalTokens;
}

function addEmbeddingUsage(target: ChapterAnalysisStat, usage: EmbeddingUsage) {
  const inputTokens = Math.max(0, Number(usage.input_tokens || 0));
  const totalTokens = Math.max(0, Number(usage.total_tokens || inputTokens));

  target.embeddingInputTokens += inputTokens;
  target.embeddingTotalTokens += totalTokens;

  target.promptTokens += inputTokens;
  target.totalTokens += totalTokens;
}

function aggregateStats(stats: ChapterAnalysisStat[]) {
  return stats.reduce(
    (acc, stat) => {
      acc.checkedBlocks += stat.checkedBlocks;
      acc.totalBlocks += stat.totalBlocks;
      acc.promptTokens += stat.promptTokens;
      acc.completionTokens += stat.completionTokens;
      acc.totalTokens += stat.totalTokens;
      return acc;
    },
    {
      checkedBlocks: 0,
      totalBlocks: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
  );
}

function createEmptyStageMetric(): StageMetricSnapshot {
  return {
    state: "queued",
    error: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    embeddingInputTokens: 0,
    embeddingTotalTokens: 0,
    elapsedMs: 0,
    retryCount: 0,
    llmCalls: 0,
    embeddingCalls: 0,
    chunkCount: 0,
    chunkFailedCount: 0,
    outputRowCount: 0,
    storageBytes: {},
    startedAt: null,
    completedAt: null,
  };
}

function stageStorageBytesJson(storageBytes: Record<string, number> | null | undefined) {
  if (!storageBytes) return null;
  const normalized = Object.entries(storageBytes).reduce<Record<string, number>>((acc, [key, value]) => {
    const safeValue = Math.max(0, Math.round(Number(value || 0)));
    if (safeValue > 0) {
      acc[key] = safeValue;
    }
    return acc;
  }, {});
  return Object.keys(normalized).length ? normalized : null;
}

function sumStageMetrics(metrics: StageMetricSnapshot[]): StageMetricSnapshot {
  const combined = createEmptyStageMetric();
  if (!metrics.length) {
    return combined;
  }

  let sawRunning = false;
  let sawFailed = false;
  let sawCompleted = false;
  let earliestStartedAt: number | null = null;
  let latestCompletedAt: number | null = null;

  for (const metric of metrics) {
    combined.promptTokens += metric.promptTokens;
    combined.completionTokens += metric.completionTokens;
    combined.totalTokens += metric.totalTokens;
    combined.embeddingInputTokens += metric.embeddingInputTokens;
    combined.embeddingTotalTokens += metric.embeddingTotalTokens;
    combined.elapsedMs += metric.elapsedMs;
    combined.retryCount += metric.retryCount;
    combined.llmCalls += metric.llmCalls;
    combined.embeddingCalls += metric.embeddingCalls;
    combined.chunkCount += metric.chunkCount;
    combined.chunkFailedCount += metric.chunkFailedCount;
    combined.outputRowCount += metric.outputRowCount;
    for (const [key, value] of Object.entries(metric.storageBytes)) {
      combined.storageBytes[key] = Math.max(0, Math.round(Number(combined.storageBytes[key] || 0) + Number(value || 0)));
    }

    if (metric.state === "failed") sawFailed = true;
    else if (metric.state === "running") sawRunning = true;
    else if (metric.state === "completed") sawCompleted = true;

    const startedAt = metric.startedAt ? Date.parse(metric.startedAt) : Number.NaN;
    if (Number.isFinite(startedAt) && (earliestStartedAt === null || startedAt < earliestStartedAt)) {
      earliestStartedAt = startedAt;
    }
    const completedAt = metric.completedAt ? Date.parse(metric.completedAt) : Number.NaN;
    if (Number.isFinite(completedAt) && (latestCompletedAt === null || completedAt > latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }
  }

  combined.state = sawFailed ? "failed" : sawRunning ? "running" : sawCompleted ? "completed" : "queued";
  combined.startedAt = earliestStartedAt !== null ? new Date(earliestStartedAt).toISOString() : null;
  combined.completedAt = latestCompletedAt !== null ? new Date(latestCompletedAt).toISOString() : null;
  combined.error = sawFailed ? metrics.find((item) => item.error)?.error || "Stage failed" : null;
  return combined;
}

function computeRunConfigHash(params: {
  chatModel: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  chunkConcurrency: number;
  chapterConcurrency: number;
  paragraphEmbeddingVersion: number;
  sceneEmbeddingVersion: number;
}) {
  const payload = JSON.stringify({
    configVersion: ANALYSIS_CONFIG_VERSION,
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
    sceneWindowStrategy: SCENE_WINDOW_STRATEGY,
    chunkSize: params.chunkSize,
    chunkOverlap: params.chunkOverlap,
    chunkConcurrency: params.chunkConcurrency,
    chapterConcurrency: params.chapterConcurrency,
    paragraphEmbeddingVersion: params.paragraphEmbeddingVersion,
    sceneEmbeddingVersion: params.sceneEmbeddingVersion,
  });

  return createHash("sha256").update(payload).digest("hex");
}

function estimateParagraphEmbeddingBytes(params: { paragraphs: ParagraphBlock[]; vectorDimensions: number }) {
  return params.paragraphs.reduce(
    (sum, paragraph) => sum + Buffer.byteLength(normalizeWhitespace(paragraph.text), "utf-8") + params.vectorDimensions * 4,
    0
  );
}

function estimateSceneDataBytes(rows: Prisma.BookAnalysisSceneCreateManyInput[]) {
  return rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), "utf-8"), 0);
}

function estimateSceneEmbeddingBytes(params: { sourceTexts: string[]; vectorDimensions: number }) {
  return params.sourceTexts.reduce(
    (sum, sourceText) => sum + Buffer.byteLength(String(sourceText || ""), "utf-8") + params.vectorDimensions * 4,
    0
  );
}

function computeCostBreakdown(params: {
  chatModel: string;
  embeddingModel: string;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  embeddingInputTokens: number;
}) {
  const pricing = resolveTokenPricing({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
  });

  const llmCostUsd =
    (Math.max(0, params.llmPromptTokens) / 1_000_000) * pricing.chatInputPer1MUsd +
    (Math.max(0, params.llmCompletionTokens) / 1_000_000) * pricing.chatOutputPer1MUsd;
  const embeddingCostUsd =
    (Math.max(0, params.embeddingInputTokens) / 1_000_000) * pricing.embeddingInputPer1MUsd;

  return {
    llmCostUsd,
    embeddingCostUsd,
    totalCostUsd: llmCostUsd + embeddingCostUsd,
  };
}

export function mergeBoundaryCandidates(candidates: SceneBoundaryCandidate[]): SceneBoundaryCandidate[] {
  const map = new Map<string, SceneBoundaryCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.betweenParagraphs[0]}-${candidate.betweenParagraphs[1]}`;
    const prev = map.get(key);
    if (!prev || candidate.confidence > prev.confidence) {
      map.set(key, candidate);
    }
  }

  return Array.from(map.values()).sort(
    (left, right) => left.betweenParagraphs[0] - right.betweenParagraphs[0]
  );
}

type FinalScene = {
  paragraphStart: number;
  paragraphEnd: number;
  changeSignal: string;
  sceneCard: string;
  participants: string[];
  mentionedEntities: string[];
  locationHints: string[];
  timeHints: string[];
  eventLabels: string[];
  unresolvedForms: string[];
  facts: string[];
  evidenceSpans: SceneEvidenceSpan[];
};

type SceneEmbeddingSourceRow = {
  id: string;
  bookId: string;
  chapterId: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  locationLabel: string | null;
  timeLabel: string | null;
  participantsJson: unknown;
  sceneSummary: string;
  sceneCard: string;
  mentionedEntitiesJson: unknown;
  locationHintsJson: unknown;
  timeHintsJson: unknown;
  eventLabelsJson: unknown;
  unresolvedFormsJson: unknown;
  factsJson: unknown;
  excerptText: string;
};

type SceneEmbeddingDocument = {
  sceneId: string;
  bookId: string;
  chapterId: string;
  sceneIndex: number;
  sourceText: string;
  sourceTextHash: string;
};

type ParagraphEmbeddingDocument = {
  bookId: string;
  chapterId: string;
  paragraphIndex: number;
  sourceText: string;
  sourceTextHash: string;
};

function buildFinalScenes(totalParagraphs: number, boundaries: SceneBoundaryCandidate[]): FinalScene[] {
  if (totalParagraphs <= 0) return [];

  const sceneStarts = [1, ...boundaries.map((boundary) => boundary.betweenParagraphs[1])];
  return sceneStarts.map((paragraphStart, index) => {
    const nextStart = sceneStarts[index + 1];
    return {
      paragraphStart,
      paragraphEnd: nextStart ? nextStart - 1 : totalParagraphs,
      changeSignal: index === 0 ? "chapter_start" : boundaries[index - 1]!.reason,
      sceneCard: "",
      participants: [],
      mentionedEntities: [],
      locationHints: [],
      timeHints: [],
      eventLabels: [],
      unresolvedForms: [],
      facts: [],
      evidenceSpans: [],
    };
  });
}

function dedupeStringList(values: string[], maxLength?: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (maxLength && result.length >= maxLength) break;
  }

  return result;
}

function dedupeEvidenceSpans(spans: SceneEvidenceSpan[]): SceneEvidenceSpan[] {
  const seen = new Set<string>();
  const result: SceneEvidenceSpan[] = [];

  for (const span of spans) {
    const label = String(span.label || "").trim();
    if (!label) continue;
    const paragraphStart = Number(span.paragraphStart || 0);
    const paragraphEnd = Number(span.paragraphEnd || 0);
    if (!Number.isFinite(paragraphStart) || !Number.isFinite(paragraphEnd) || paragraphStart <= 0 || paragraphEnd < paragraphStart) {
      continue;
    }

    const key = `${label.toLocaleLowerCase("ru-RU")}|${paragraphStart}|${paragraphEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      label,
      paragraphStart,
      paragraphEnd,
    });
    if (result.length >= 4) break;
  }

  return result;
}

function buildSceneCardFromExcerpt(excerptText: string): string {
  const text = String(excerptText || "").replace(/\s+/g, " ").trim();
  if (!text) return "Сцена без текста.";
  if (text.length <= 220) return text;
  return `${text.slice(0, 217)}...`;
}

function enrichFinalScenesFromChunkScenes(
  scenes: FinalScene[],
  chunkScenes: SceneCandidate[],
  paragraphs: ParagraphBlock[]
): FinalScene[] {
  return scenes.map((scene) => {
    const exact = chunkScenes.filter(
      (candidate) => candidate.paragraphStart === scene.paragraphStart && candidate.paragraphEnd === scene.paragraphEnd
    );
    const enclosed = chunkScenes.filter(
      (candidate) => candidate.paragraphStart >= scene.paragraphStart && candidate.paragraphEnd <= scene.paragraphEnd
    );

    const source = exact.length ? exact : enclosed;
    if (!source.length) {
      const excerpt = buildSceneExcerpt(paragraphs, scene.paragraphStart, scene.paragraphEnd);
      return {
        ...scene,
        sceneCard: buildSceneCardFromExcerpt(excerpt),
      };
    }

    const rawSpans = source.flatMap((candidate) =>
      candidate.evidenceSpans
        .filter(
          (span) =>
            span.paragraphStart >= scene.paragraphStart && span.paragraphEnd <= scene.paragraphEnd
        )
        .map((span) => ({
          ...span,
          label: String(span.label || "").trim(),
        }))
    );

    const preferredSceneCard =
      source
        .map((candidate) => String(candidate.sceneCard || "").trim())
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)[0] || "";
    const excerpt = buildSceneExcerpt(paragraphs, scene.paragraphStart, scene.paragraphEnd);

    return {
      ...scene,
      sceneCard: preferredSceneCard || buildSceneCardFromExcerpt(excerpt),
      participants: dedupeStringList(source.flatMap((candidate) => candidate.participants)),
      mentionedEntities: dedupeStringList(source.flatMap((candidate) => candidate.mentionedEntities)),
      locationHints: dedupeStringList(source.flatMap((candidate) => candidate.locationHints)),
      timeHints: dedupeStringList(source.flatMap((candidate) => candidate.timeHints)),
      eventLabels: dedupeStringList(source.flatMap((candidate) => candidate.eventLabels), 4),
      unresolvedForms: dedupeStringList(source.flatMap((candidate) => candidate.unresolvedForms)),
      facts: dedupeStringList(source.flatMap((candidate) => candidate.facts), 5),
      evidenceSpans: dedupeEvidenceSpans(rawSpans),
    };
  });
}

function buildSceneExcerpt(paragraphs: ParagraphBlock[], paragraphStart: number, paragraphEnd: number): string {
  return paragraphs
    .slice(paragraphStart - 1, paragraphEnd)
    .map((paragraph) => paragraph.text)
    .join("\n\n");
}

function buildSceneEmbeddingText(params: {
  bookTitle: string;
  chapterTitle: string;
  scene: SceneEmbeddingSourceRow;
}): string {
  const sceneCard = String(params.scene.sceneCard || params.scene.sceneSummary || "").trim();
  const participants = parseOptionalStringArray(params.scene.participantsJson, 20);
  const mentionedEntities = parseOptionalStringArray(params.scene.mentionedEntitiesJson, 24);
  const unresolvedForms = parseOptionalStringArray(params.scene.unresolvedFormsJson, 12);
  const eventLabels = parseOptionalStringArray(params.scene.eventLabelsJson, 8);
  const facts = parseOptionalStringArray(params.scene.factsJson, 8);

  const locationHintsRaw = parseOptionalStringArray(params.scene.locationHintsJson, 8);
  const timeHintsRaw = parseOptionalStringArray(params.scene.timeHintsJson, 8);
  const locationHints = locationHintsRaw.length
    ? locationHintsRaw
    : params.scene.locationLabel
      ? [String(params.scene.locationLabel).trim()]
      : [];
  const timeHints = timeHintsRaw.length
    ? timeHintsRaw
    : params.scene.timeLabel
      ? [String(params.scene.timeLabel).trim()]
      : [];

  const excerpt = clampChars(normalizeWhitespace(params.scene.excerptText), SCENE_EMBEDDING_EXCERPT_MAX_CHARS);
  const lines = [
    `Книга: ${String(params.bookTitle || "").trim()}`,
    `Глава: ${String(params.chapterTitle || "").trim()}`,
    `Сцена #${params.scene.sceneIndex}: ${sceneCard}`,
    `Абзацы: ${params.scene.paragraphStart}-${params.scene.paragraphEnd}`,
    participants.length ? `Участники: ${participants.join(", ")}` : "",
    mentionedEntities.length ? `Сущности: ${mentionedEntities.join(", ")}` : "",
    unresolvedForms.length ? `Неразрешённые формы: ${unresolvedForms.join(", ")}` : "",
    locationHints.length ? `Локация: ${locationHints.join(", ")}` : "",
    timeHints.length ? `Время: ${timeHints.join(", ")}` : "",
    eventLabels.length ? `События: ${eventLabels.join(", ")}` : "",
    facts.length ? `Факты: ${facts.join("; ")}` : "",
    excerpt ? `Фрагмент: ${excerpt}` : "",
  ].filter(Boolean);

  return clampChars(lines.join("\n"), SCENE_EMBEDDING_TEXT_MAX_CHARS);
}

function buildSceneEmbeddingDocuments(params: {
  bookTitle: string;
  chapterTitle: string;
  scenes: SceneEmbeddingSourceRow[];
}): SceneEmbeddingDocument[] {
  return params.scenes.map((scene) => {
    const sourceText = buildSceneEmbeddingText({
      bookTitle: params.bookTitle,
      chapterTitle: params.chapterTitle,
      scene,
    });
    return {
      sceneId: scene.id,
      bookId: scene.bookId,
      chapterId: scene.chapterId,
      sceneIndex: scene.sceneIndex,
      sourceText,
      sourceTextHash: sha256Hex(sourceText),
    };
  });
}

type ChunkAnalysisSuccess = {
  ok: true;
  chunk: ParagraphChunk;
  parsed: {
    boundaries: SceneBoundaryCandidate[];
    scenes: SceneCandidate[];
  };
  usage: Usage;
  attemptCount: number;
  elapsedMs: number;
  artifactPayloadBytes: number;
};

type ChunkAnalysisFailure = {
  ok: false;
  chunk: ParagraphChunk;
  error: Error;
  usage: Usage;
  attemptCount: number;
  elapsedMs: number;
  artifactPayloadBytes: number;
};

type ChunkAnalysisResult = ChunkAnalysisSuccess | ChunkAnalysisFailure;

type ChunkAttemptArtifactPayload = {
  promptText: string;
  inputJson: Record<string, unknown>;
  responseText: string | null;
  parsedJson: Record<string, unknown> | null;
  usage: Usage;
  elapsedMs: number;
};

class ChunkAttemptError extends Error {
  artifact: ChunkAttemptArtifactPayload;

  constructor(message: string, artifact: ChunkAttemptArtifactPayload) {
    super(message);
    this.name = "ChunkAttemptError";
    this.artifact = artifact;
  }
}

class ChunkCallError extends Error {
  usage: Usage;
  attemptCount: number;
  elapsedMs: number;
  artifactPayloadBytes: number;

  constructor(message: string, params: { usage: Usage; attemptCount: number; elapsedMs: number; artifactPayloadBytes: number }) {
    super(message);
    this.name = "ChunkCallError";
    this.usage = params.usage;
    this.attemptCount = params.attemptCount;
    this.elapsedMs = params.elapsedMs;
    this.artifactPayloadBytes = params.artifactPayloadBytes;
  }
}

async function persistChunkArtifact(params: {
  runId: string;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  attempt: number;
  llmModel: string;
  status: "ok" | "error";
  phase: string;
  artifact: ChunkAttemptArtifactPayload;
  errorMessage?: string;
}): Promise<{ payloadSizeBytes: number }> {
  const promptTokens = Math.max(0, Number(params.artifact.usage.prompt_tokens || 0));
  const completionTokens = Math.max(0, Number(params.artifact.usage.completion_tokens || 0));
  const totalTokens = Math.max(
    0,
    Number(params.artifact.usage.total_tokens || promptTokens + completionTokens)
  );
  const promptText = clampChars(String(params.artifact.promptText || ""), ANALYSIS_ARTIFACT_PROMPT_MAX_CHARS);
  const inputJson = (params.artifact.inputJson || {}) as Record<string, unknown>;
  const responseText = params.artifact.responseText
    ? clampChars(String(params.artifact.responseText || ""), ANALYSIS_ARTIFACT_RESPONSE_MAX_CHARS)
    : null;
  const parsedJson = params.artifact.parsedJson ? (params.artifact.parsedJson as Record<string, unknown>) : null;
  const errorMessage = params.errorMessage ? clampChars(String(params.errorMessage || ""), ANALYSIS_ARTIFACT_ERROR_MAX_CHARS) : null;

  let storedPayload:
    | {
        provider: string;
        storageKey: string;
        sizeBytes: number;
        sha256: string;
        compression: string;
      }
    | null = null;

  try {
    storedPayload = await putArtifactPayload({
      store: getArtifactBlobStore(),
      prefix: `analysis-runs/${params.bookId}/${params.runId}/${ANALYSIS_SCENE_CHUNK_STAGE}/chapter-${params.chapterOrderIndex}/chunk-${params.chunkStartParagraph}-${params.chunkEndParagraph}`,
      fileName: `attempt-${Math.max(1, Math.floor(params.attempt))}.json.gz`,
      payload: {
        prompt: promptText,
        input: inputJson,
        response: responseText,
        parsed: parsedJson,
        debug: {
          phase: params.phase,
          status: params.status,
          llmModel: params.llmModel,
          promptTokens,
          completionTokens,
          totalTokens,
          elapsedMs: Math.max(0, Math.round(Number(params.artifact.elapsedMs || 0))),
          errorMessage,
        },
      },
    });
  } catch (error) {
    params.errorMessage ||= error instanceof Error ? error.message : String(error);
  }

  await createBookAnalysisArtifactManifest({
    client: prisma,
    runId: params.runId,
    bookId: params.bookId,
    chapterId: params.chapterId,
    chapterOrderIndex: params.chapterOrderIndex,
    chapterTitle: params.chapterTitle,
    chunkStartParagraph: params.chunkStartParagraph,
    chunkEndParagraph: params.chunkEndParagraph,
    attempt: Math.max(1, Math.floor(params.attempt)),
    stageKey: ANALYSIS_SCENE_CHUNK_STAGE,
    phase: params.phase,
    status: params.status,
    llmModel: String(params.llmModel || "").trim() || "unknown-llm-model",
    promptTokens,
    completionTokens,
    totalTokens,
    elapsedMs: Math.max(0, Math.round(Number(params.artifact.elapsedMs || 0))),
    errorMessage,
    storageProvider: storedPayload?.provider || null,
    payloadKey: storedPayload?.storageKey || null,
    payloadSizeBytes: storedPayload?.sizeBytes || 0,
    payloadSha256: storedPayload?.sha256 || null,
    compression: storedPayload?.compression || null,
    schemaVersion: ANALYSIS_ARTIFACT_SCHEMA_VERSION,
    promptText: storedPayload ? null : promptText,
    inputJson: storedPayload ? null : inputJson,
    responseText: storedPayload ? null : responseText,
    parsedJson: storedPayload ? null : parsedJson,
  });

  return {
    payloadSizeBytes: Math.max(0, Number(storedPayload?.sizeBytes || 0)),
  };
}

type ChapterRunSuccess = {
  ok: true;
  chapterId: string;
};

type ChapterRunFailure = {
  ok: false;
  chapterId: string;
  error: Error;
};

type ChapterRunResult = ChapterRunSuccess | ChapterRunFailure;

async function persistBookAnalysisProgress(params: {
  bookId: string;
  status: "running" | "completed" | "failed";
  chapterStats: ChapterAnalysisStat[];
  error?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}) {
  const aggregate = aggregateStats(params.chapterStats);
  const finishedAtValue = params.finishedAt ?? undefined;
  await prisma.book.update({
    where: { id: params.bookId },
    data: {
      analysisState: params.status,
      analysisStatus: params.status,
      analysisError: params.error ?? null,
      analysisCheckedBlocks: aggregate.checkedBlocks,
      analysisTotalBlocks: aggregate.totalBlocks,
      analysisPromptTokens: aggregate.promptTokens,
      analysisCompletionTokens: aggregate.completionTokens,
      analysisTotalTokens: aggregate.totalTokens,
      analysisChapterStatsJson: params.chapterStats as unknown as Prisma.InputJsonValue,
      ...(params.startedAt !== undefined ? { analysisStartedAt: params.startedAt } : {}),
      ...(params.finishedAt !== undefined ? { analysisFinishedAt: params.finishedAt } : {}),
      ...(finishedAtValue !== undefined ? { analysisCompletedAt: finishedAtValue } : {}),
    },
  });
}

const RUN_STAGE_KEYS = [
  ANALYSIS_PARAGRAPH_STAGE,
  ANALYSIS_SCENE_CHUNK_STAGE,
  ANALYSIS_SCENE_EMBEDDING_STAGE,
  ANALYSIS_FINALIZE_STAGE,
] as const;

function resolveRunCurrentStageKey(stageMetrics: Record<string, StageMetricSnapshot>, runState: "running" | "completed" | "failed") {
  if (runState === "completed") return ANALYSIS_FINALIZE_STAGE;
  for (const stageKey of RUN_STAGE_KEYS) {
    if (stageMetrics[stageKey]?.state === "failed") return stageKey;
  }
  for (const stageKey of RUN_STAGE_KEYS) {
    if (stageMetrics[stageKey]?.state === "running") return stageKey;
  }
  for (const stageKey of RUN_STAGE_KEYS) {
    if (stageMetrics[stageKey]?.state === "queued") return stageKey;
  }
  return ANALYSIS_FINALIZE_STAGE;
}

async function syncRunScopedMetrics(params: {
  bookId: string;
  runContext: RunMetricContext;
  chapterStats: ChapterAnalysisStat[];
  runState: "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt?: Date | null;
  chatModel: string;
  embeddingModel: string;
  extractModel: string;
  runError?: string | null;
  qualityFlags?: Record<string, unknown>;
}) {
  for (const stageKey of RUN_STAGE_KEYS) {
    const stageSnapshots = Array.from(params.runContext.chapterStageMetrics.values())
      .map((row) => row[stageKey])
      .filter(Boolean);
    params.runContext.stageMetrics[stageKey] = sumStageMetrics(stageSnapshots);
  }

  const aggregate = aggregateStats(params.chapterStats);
  const llmPromptTokens = params.chapterStats.reduce((sum, stat) => sum + stat.llmPromptTokens, 0);
  const llmCompletionTokens = params.chapterStats.reduce((sum, stat) => sum + stat.llmCompletionTokens, 0);
  const llmTotalTokens = params.chapterStats.reduce((sum, stat) => sum + stat.llmTotalTokens, 0);
  const embeddingInputTokens = params.chapterStats.reduce((sum, stat) => sum + stat.embeddingInputTokens, 0);
  const embeddingTotalTokens = params.chapterStats.reduce((sum, stat) => sum + stat.embeddingTotalTokens, 0);
  const llmLatencyMs = params.chapterStats.reduce((sum, stat) => sum + stat.llmLatencyMs, 0);
  const embeddingLatencyMs = params.chapterStats.reduce((sum, stat) => sum + stat.embeddingLatencyMs, 0);
  const chunkCount = params.chapterStats.reduce((sum, stat) => sum + stat.chunkCount, 0);
  const chunkFailedCount = params.chapterStats.reduce((sum, stat) => sum + stat.chunkFailedCount, 0);
  const llmCalls = params.chapterStats.reduce((sum, stat) => sum + stat.llmCalls, 0);
  const llmRetries = params.chapterStats.reduce((sum, stat) => sum + stat.llmRetries, 0);
  const embeddingCalls = params.chapterStats.reduce((sum, stat) => sum + stat.embeddingCalls, 0);
  const paragraphEmbeddingCount = params.runContext.stageMetrics[ANALYSIS_PARAGRAPH_STAGE]?.outputRowCount || 0;
  const sceneCount = params.runContext.stageMetrics[ANALYSIS_FINALIZE_STAGE]?.outputRowCount || 0;
  const artifactCount = params.runContext.stageMetrics[ANALYSIS_SCENE_CHUNK_STAGE]?.outputRowCount || 0;
  const totalElapsedMs =
    params.finishedAt && params.finishedAt.getTime() >= params.startedAt.getTime()
      ? params.finishedAt.getTime() - params.startedAt.getTime()
      : Math.max(0, ...params.chapterStats.map((stat) => stat.elapsedMs));
  const storageBytes = RUN_STAGE_KEYS.reduce<Record<string, number>>((acc, stageKey) => {
    for (const [key, value] of Object.entries(params.runContext.stageMetrics[stageKey]?.storageBytes || {})) {
      acc[key] = Math.max(0, Math.round(Number(acc[key] || 0) + Number(value || 0)));
    }
    return acc;
  }, {});

  const costBreakdown = computeCostBreakdown({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
    llmPromptTokens,
    llmCompletionTokens,
    embeddingInputTokens,
  });

  const currentStageKey = resolveRunCurrentStageKey(params.runContext.stageMetrics, params.runState);

  await prisma.bookAnalysisRun.update({
    where: { id: params.runContext.runId },
    data: {
      state: params.runState,
      currentStageKey,
      error: params.runError ?? null,
      configVersion: ANALYSIS_CONFIG_VERSION,
      configHash: params.runContext.configHash,
      extractModel: params.extractModel,
      chatModel: params.chatModel,
      embeddingModel: params.embeddingModel,
      pricingVersion: params.runContext.pricingVersion,
      llmPromptTokens,
      llmCompletionTokens,
      llmTotalTokens,
      embeddingInputTokens,
      embeddingTotalTokens,
      llmCostUsd: costBreakdown.llmCostUsd,
      embeddingCostUsd: costBreakdown.embeddingCostUsd,
      totalCostUsd: costBreakdown.totalCostUsd,
      totalElapsedMs: Math.max(0, Math.round(totalElapsedMs)),
      llmLatencyMs,
      embeddingLatencyMs,
      chunkCount,
      chunkFailedCount,
      llmCalls,
      llmRetries,
      embeddingCalls,
      paragraphEmbeddingCount,
      sceneCount,
      artifactCount,
      storageBytesJson: stageStorageBytesJson(storageBytes) as unknown as Prisma.InputJsonValue,
      ...(params.qualityFlags !== undefined
        ? {
            qualityFlagsJson: params.qualityFlags as unknown as Prisma.InputJsonValue,
          }
        : {}),
      startedAt: params.startedAt,
      completedAt: params.runState === "running" ? null : params.finishedAt ?? new Date(),
    },
  });

  for (const stageKey of RUN_STAGE_KEYS) {
    const metric = params.runContext.stageMetrics[stageKey];
    const costs = computeCostBreakdown({
      chatModel: params.chatModel,
      embeddingModel: params.embeddingModel,
      llmPromptTokens: metric.promptTokens,
      llmCompletionTokens: metric.completionTokens,
      embeddingInputTokens: metric.embeddingInputTokens,
    });

    await upsertBookStageExecution({
      client: prisma,
      bookId: params.bookId,
      contentVersionId: params.runContext.contentVersionId,
      runId: params.runContext.runId,
      stageKey,
      state: metric.state,
      error: metric.error,
      promptTokens: metric.promptTokens,
      completionTokens: metric.completionTokens,
      totalTokens: metric.totalTokens,
      embeddingInputTokens: metric.embeddingInputTokens,
      embeddingTotalTokens: metric.embeddingTotalTokens,
      llmCostUsd: costs.llmCostUsd,
      embeddingCostUsd: costs.embeddingCostUsd,
      totalCostUsd: costs.totalCostUsd,
      elapsedMs: metric.elapsedMs,
      retryCount: metric.retryCount,
      llmCalls: metric.llmCalls,
      embeddingCalls: metric.embeddingCalls,
      chunkCount: metric.chunkCount,
      chunkFailedCount: metric.chunkFailedCount,
      outputRowCount: metric.outputRowCount,
      storageBytesJson: stageStorageBytesJson(metric.storageBytes),
      startedAt: metric.startedAt ? new Date(metric.startedAt) : undefined,
      completedAt: metric.completedAt ? new Date(metric.completedAt) : undefined,
    });
  }

  for (const chapterStat of params.chapterStats) {
    const stageMetrics = params.runContext.chapterStageMetrics.get(chapterStat.chapterId) || {};
    for (const stageKey of RUN_STAGE_KEYS) {
      const metric = stageMetrics[stageKey];
      if (!metric) continue;
      await upsertBookAnalysisChapterMetric({
        client: prisma,
        bookId: params.bookId,
        contentVersionId: params.runContext.contentVersionId,
        runId: params.runContext.runId,
        chapterId: chapterStat.chapterId,
        chapterOrderIndex: chapterStat.chapterOrderIndex,
        chapterTitle: chapterStat.chapterTitle,
        stageKey,
        state: metric.state,
        error: metric.error,
        promptTokens: metric.promptTokens,
        completionTokens: metric.completionTokens,
        totalTokens: metric.totalTokens,
        embeddingInputTokens: metric.embeddingInputTokens,
        embeddingTotalTokens: metric.embeddingTotalTokens,
        elapsedMs: metric.elapsedMs,
        retryCount: metric.retryCount,
        llmCalls: metric.llmCalls,
        embeddingCalls: metric.embeddingCalls,
        chunkCount: metric.chunkCount,
        chunkFailedCount: metric.chunkFailedCount,
        outputRowCount: metric.outputRowCount,
        storageBytesJson: stageStorageBytesJson(metric.storageBytes),
        startedAt: metric.startedAt ? new Date(metric.startedAt) : undefined,
        completedAt: metric.completedAt ? new Date(metric.completedAt) : undefined,
      });
    }
  }

  await prisma.book.update({
    where: { id: params.bookId },
    data: {
      currentAnalysisRunId: params.runState === "running" ? params.runContext.runId : null,
      latestAnalysisRunId: params.runContext.runId,
      analysisPromptTokens: aggregate.promptTokens,
      analysisCompletionTokens: aggregate.completionTokens,
      analysisTotalTokens: aggregate.totalTokens,
    },
  });
}

async function requestEmbeddingBoundaryHints(params: {
  client: ReturnType<typeof createVertexClient>;
  paragraphs: ParagraphBlock[];
}) {
  const response = await params.client.embeddings.createBatch({
    texts: params.paragraphs.map((paragraph) => paragraph.text),
    taskType: "RETRIEVAL_DOCUMENT",
    batchSize: EMBEDDING_BATCH_SIZE,
  });

  const hints = buildEmbeddingBoundaryHints({
    vectors: response.vectors,
    percentile: EMBEDDING_BOUNDARY_PERCENTILE,
    maxHints: EMBEDDING_BOUNDARY_MAX_HINTS,
  });
  if (response.vectors.length !== params.paragraphs.length) {
    throw new Error(
      `Paragraph embeddings count mismatch: got ${response.vectors.length}, expected ${params.paragraphs.length}`
    );
  }

  return {
    hints,
    vectors: response.vectors,
    usage: response.usage,
  };
}

async function prewarmEmbeddingModel(params: {
  client: ReturnType<typeof createVertexClient>;
  logger: AnalysisLogger;
}) {
  const startedAt = Date.now();
  try {
    const prewarm = await params.client.embeddings.create({
      text: "prewarm paragraph embeddings",
      taskType: "RETRIEVAL_DOCUMENT",
      autoTruncate: true,
    });
    params.logger.info("Embedding model prewarmed", {
      embeddingModel: params.client.config.embeddingModel,
      embeddingInputTokens: Number(prewarm.usage.input_tokens || 0),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    params.logger.warn("Embedding prewarm failed; continuing analysis", {
      embeddingModel: params.client.config.embeddingModel,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
  }
}

function buildParagraphEmbeddingDocuments(params: {
  bookId: string;
  chapterId: string;
  paragraphs: ParagraphBlock[];
}): ParagraphEmbeddingDocument[] {
  return params.paragraphs.map((paragraph) => {
    const sourceText = normalizeWhitespace(paragraph.text);
    return {
      bookId: params.bookId,
      chapterId: params.chapterId,
      paragraphIndex: paragraph.index,
      sourceText,
      sourceTextHash: sha256Hex(sourceText),
    };
  });
}

async function persistParagraphEmbeddings(params: {
  bookId: string;
  chapterId: string;
  paragraphs: ParagraphBlock[];
  vectors: number[][];
  embeddingModel: string;
}) {
  if (!params.paragraphs.length) return;
  if (params.vectors.length !== params.paragraphs.length) {
    throw new Error(
      `Paragraph embedding vectors mismatch: got ${params.vectors.length}, expected ${params.paragraphs.length}`
    );
  }

  const documents = buildParagraphEmbeddingDocuments({
    bookId: params.bookId,
    chapterId: params.chapterId,
    paragraphs: params.paragraphs,
  });
  const now = new Date();

  const rows = documents.map((item, index) => {
    const vector = params.vectors[index] || [];
    const vectorLiteral = serializePgVectorLiteral(vector);

    return Prisma.sql`(
      ${randomUUID()},
      ${item.bookId},
      ${item.chapterId},
      ${item.paragraphIndex},
      ${params.embeddingModel},
      ${PARAGRAPH_EMBEDDING_VERSION},
      ${"RETRIEVAL_DOCUMENT"},
      ${vector.length},
      ${item.sourceText},
      ${item.sourceTextHash},
      ${now},
      ${now},
      CAST(${vectorLiteral} AS vector(768))
    )`;
  });

  for (const rowBatch of chunkArray(rows, EMBEDDING_INSERT_BATCH_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "BookParagraphEmbedding" (
          "id",
          "bookId",
          "chapterId",
          "paragraphIndex",
          "embeddingModel",
          "embeddingVersion",
          "taskType",
          "dimensions",
          "sourceText",
          "sourceTextHash",
          "createdAt",
          "updatedAt",
          "vector"
        )
        VALUES ${Prisma.join(rowBatch)}
      `
    );
  }
}

async function requestSceneEmbeddings(params: {
  client: ReturnType<typeof createVertexClient>;
  bookTitle: string;
  chapterTitle: string;
  scenes: SceneEmbeddingSourceRow[];
}): Promise<{
  documents: SceneEmbeddingDocument[];
  vectors: number[][];
  usage: EmbeddingUsage;
}> {
  const documents = buildSceneEmbeddingDocuments({
    bookTitle: params.bookTitle,
    chapterTitle: params.chapterTitle,
    scenes: params.scenes,
  });
  if (!documents.length) {
    return {
      documents: [],
      vectors: [],
      usage: {
        input_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  const response = await params.client.embeddings.createBatch({
    texts: documents.map((item) => item.sourceText),
    taskType: "RETRIEVAL_DOCUMENT",
    autoTruncate: true,
    batchSize: SCENE_EMBEDDING_BATCH_SIZE,
  });

  if (response.vectors.length !== documents.length) {
    throw new Error(
      `Scene embeddings count mismatch: got ${response.vectors.length}, expected ${documents.length}`
    );
  }

  return {
    documents,
    vectors: response.vectors,
    usage: response.usage,
  };
}

function normalizeModelMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text || "");
        }
        return JSON.stringify(item);
      })
      .join("")
      .trim();
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text || "").trim();
  }
  return String(content || "").trim();
}

async function requestChunkSceneBoundaries(params: {
  client: ReturnType<typeof createVertexClient>;
  chapterId: string;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  paragraphs: ParagraphBlock[];
  embeddingHints: EmbeddingBoundaryHint[];
}) {
  const prompt = `Проанализируй фрагмент художественного произведения и найди только убедительные границы сцен внутри данного диапазона абзацев.

Твоя задача:
1. определить, где внутри фрагмента начинаются новые сцены;
2. вернуть список границ сцен;
3. вернуть итоговые сцены как непрерывные диапазоны абзацев;
4. для каждой сцены вернуть компактные структурированные данные, полезные для поиска и последующей проверки ответа.

Что считать новой сценой:
- явная смена места действия;
- явная смена времени;
- переход к другому локальному эпизоду или новому очагу действия;
- заметное переключение активного состава участников;
- явный повествовательный разрыв.

Что НЕ считать новой сценой само по себе:
- просто новый абзац;
- продолжение того же разговора;
- небольшое смещение внимания внутри того же эпизода;
- появление или исчезновение второстепенного участника без явного разрыва;
- неуверенные догадки о смене места или времени.

Главный принцип:
лучше пропустить слабую границу, чем придумать лишнюю.

Правила:
- смотри только на данный фрагмент;
- не используй знания о книге вне данного фрагмента;
- не додумывай скрытые переходы, если они не подтверждены текстом;
- не нормализуй имена через догадки;
- candidateBoundaryHints — это слабые подсказки по embedding-distance между соседними абзацами; они могут быть неточными и их можно игнорировать.
- participants указывай только для реально активных участников сцены;
- mentionedEntities включай только если они реально значимы для сцены;
- unresolvedForms используй для важных, но неразрешённых форм появления: например, "кто-то в темноте", "неизвестный человек", "черная собака";
- facts должны быть короткими, атомарными и проверяемыми по самому фрагменту;
- evidenceSpans должны ссылаться только на абзацы внутри соответствующей сцены;
- если во фрагменте нет убедительных новых сцен, верни пустой массив boundaries и одну сцену на весь диапазон.

Формат ответа:
{
  "boundaries": [
    {
      "betweenParagraphs": [12, 13],
      "reason": "location_shift | time_shift | action_shift | participant_shift | narrative_cut",
      "confidence": 0.0
    }
  ],
  "scenes": [
    {
      "paragraphStart": 8,
      "paragraphEnd": 12,
      "sceneCard": "",
      "participants": ["..."],
      "mentionedEntities": ["..."],
      "locationHints": ["..."],
      "timeHints": ["..."],
      "eventLabels": ["..."],
      "unresolvedForms": ["..."],
      "facts": ["..."],
      "evidenceSpans": [
        {
          "label": "",
          "paragraphStart": 8,
          "paragraphEnd": 9
        }
      ]
    }
  ]
}

Жесткие требования к JSON:
- вернуть только JSON;
- без markdown;
- без комментариев;
- без пояснительного текста;
- boundaries содержит только реальные границы;
- betweenParagraphs всегда пара соседних глобальных номеров абзацев;
- confidence — число от 0 до 1;
- scenes должны полностью покрывать диапазон от chunkStartParagraph до chunkEndParagraph без дыр и без пересечений;
- reason только из enum: location_shift, time_shift, action_shift, participant_shift, narrative_cut;
- sceneCard — 1-2 коротких предложения;
- eventLabels — не более 4 коротких меток;
- facts — не более 5 коротких фактов;
- evidenceSpans — не более 4 span-ов на сцену.`;

  const paragraphsJson = params.paragraphs.map((paragraph) => ({
    paragraphIndex: paragraph.index,
    text: paragraph.text,
  }));
  const chunkEmbeddingHints = pickEmbeddingHintsForChunk(
    params.embeddingHints,
    params.chunkStartParagraph,
    params.chunkEndParagraph
  ).map((hint) => ({
    betweenParagraphs: hint.betweenParagraphs,
    confidence: Number(hint.confidence.toFixed(4)),
    distance: Number(hint.distance.toFixed(6)),
  }));

  const userInputText = `Входные данные:
- chapterId: ${params.chapterId}
- chapterTitle: ${params.chapterTitle}
- chunkStartParagraph: ${params.chunkStartParagraph}
- chunkEndParagraph: ${params.chunkEndParagraph}
- candidateBoundaryHints: ${JSON.stringify(chunkEmbeddingHints)}

Абзацы фрагмента:
${JSON.stringify(paragraphsJson)}

Найди только убедительные границы сцен и верни итоговые сцены в строгом JSON-формате.
Сцены должны полностью покрывать диапазон чанка без дыр и без пересечений.
Если убедительных границ нет, верни одну сцену на весь диапазон.`;

  const inputJson = {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    chunkStartParagraph: params.chunkStartParagraph,
    chunkEndParagraph: params.chunkEndParagraph,
    candidateBoundaryHints: chunkEmbeddingHints,
    paragraphs: paragraphsJson,
  } satisfies Record<string, unknown>;

  const startedAtMs = Date.now();
  try {
    const completion = await params.client.chat.completions.create({
      temperature: 0,
      response_format: {
        type: "json_object",
      },
      response_schema: SCENE_CHUNK_RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: userInputText,
        },
      ],
    });

    const usage = usageFromResponse(completion);
    const message = (completion.choices?.[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    const responseText = normalizeModelMessageContent(message);
    try {
      const parsed = parseChunkSceneResponse({
        content: responseText,
        chunkStartParagraph: params.chunkStartParagraph,
        chunkEndParagraph: params.chunkEndParagraph,
      });

      return {
        parsed,
        artifact: {
          promptText: `${prompt}\n\n${userInputText}`,
          inputJson,
          responseText,
          parsedJson: {
            boundaries: parsed.boundaries,
            scenes: parsed.scenes,
          },
          usage,
          elapsedMs: Date.now() - startedAtMs,
        } satisfies ChunkAttemptArtifactPayload,
      };
    } catch (error) {
      throw new ChunkAttemptError(
        error instanceof Error ? error.message : String(error),
        {
          promptText: `${prompt}\n\n${userInputText}`,
          inputJson,
          responseText,
          parsedJson: null,
          usage,
          elapsedMs: Date.now() - startedAtMs,
        } satisfies ChunkAttemptArtifactPayload
      );
    }
  } catch (error) {
    if (error instanceof ChunkAttemptError) {
      throw error;
    }

    throw new ChunkAttemptError(
      error instanceof Error ? error.message : String(error),
      {
        promptText: `${prompt}\n\n${userInputText}`,
        inputJson,
        responseText: null,
        parsedJson: null,
        usage: {},
        elapsedMs: Date.now() - startedAtMs,
      } satisfies ChunkAttemptArtifactPayload
    );
  }
}

async function requestChunkSceneBoundariesWithRetry(params: {
  client: ReturnType<typeof createVertexClient>;
  logger: AnalysisLogger;
  runId: string;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  paragraphs: ParagraphBlock[];
  embeddingHints: EmbeddingBoundaryHint[];
}) {
  let attempt = 1;
  let retryDelayMs = ANALYSIS_CHUNK_RETRY_BASE_MS;
  let totalElapsedMs = 0;
  let totalArtifactPayloadBytes = 0;
  let usageTotal: Usage = {};

  while (true) {
    try {
      const chunkResult = await requestChunkSceneBoundaries({
        client: params.client,
        chapterId: params.chapterId,
        chapterTitle: params.chapterTitle,
        chunkStartParagraph: params.chunkStartParagraph,
        chunkEndParagraph: params.chunkEndParagraph,
        paragraphs: params.paragraphs,
        embeddingHints: params.embeddingHints,
      });
      usageTotal = sumUsage(usageTotal, chunkResult.artifact.usage);
      totalElapsedMs += Math.max(0, Number(chunkResult.artifact.elapsedMs || 0));

      const persistedArtifact = await persistChunkArtifact({
        runId: params.runId,
        bookId: params.bookId,
        chapterId: params.chapterId,
        chapterOrderIndex: params.chapterOrderIndex,
        chapterTitle: params.chapterTitle,
        chunkStartParagraph: params.chunkStartParagraph,
        chunkEndParagraph: params.chunkEndParagraph,
        attempt,
        llmModel: params.client.config.chatModel,
        status: "ok",
        phase: "chunk_llm",
        artifact: chunkResult.artifact,
      });

      return {
        parsed: chunkResult.parsed,
        usage: usageTotal,
        attemptCount: attempt,
        elapsedMs: totalElapsedMs,
        artifactPayloadBytes: totalArtifactPayloadBytes + persistedArtifact.payloadSizeBytes,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const artifact =
        error instanceof ChunkAttemptError
          ? error.artifact
          : ({
              promptText: "",
              inputJson: {},
              responseText: null,
              parsedJson: null,
              usage: {},
              elapsedMs: 0,
            } satisfies ChunkAttemptArtifactPayload);
      usageTotal = sumUsage(usageTotal, artifact.usage);
      totalElapsedMs += Math.max(0, Number(artifact.elapsedMs || 0));

      const persistedArtifact = await persistChunkArtifact({
        runId: params.runId,
        bookId: params.bookId,
        chapterId: params.chapterId,
        chapterOrderIndex: params.chapterOrderIndex,
        chapterTitle: params.chapterTitle,
        chunkStartParagraph: params.chunkStartParagraph,
        chunkEndParagraph: params.chunkEndParagraph,
        attempt,
        llmModel: params.client.config.chatModel,
        status: "error",
        phase: "chunk_llm",
        artifact,
        errorMessage: normalizedError.message,
      });

      const shouldRetry =
        attempt < ANALYSIS_CHUNK_RETRY_MAX_ATTEMPTS && isRetriableChunkError(normalizedError);
      if (!shouldRetry) {
        throw new ChunkCallError(normalizedError.message, {
          usage: usageTotal,
          attemptCount: attempt,
          elapsedMs: totalElapsedMs,
          artifactPayloadBytes: totalArtifactPayloadBytes + persistedArtifact.payloadSizeBytes,
        });
      }
      totalArtifactPayloadBytes += persistedArtifact.payloadSizeBytes;

      params.logger.warn("Chunk request throttled; retrying", {
        bookId: params.bookId,
        chapterId: params.chapterId,
        chunkStartParagraph: params.chunkStartParagraph,
        chunkEndParagraph: params.chunkEndParagraph,
        attempt,
        retryDelayMs,
        maxAttempts: ANALYSIS_CHUNK_RETRY_MAX_ATTEMPTS,
        error: normalizedError.message,
      });

      await delay(retryDelayMs);
      attempt += 1;
      retryDelayMs = Math.min(20_000, Math.round(retryDelayMs * 1.8));
    }
  }
}

export async function runBookAnalysis(params: { bookId: string; logger: AnalysisLogger }) {
  const client = createVertexClient();
  if (!client.config.apiKey) {
    throw new Error("VERTEX_API_KEY is required");
  }

  const book = await prisma.book.findUnique({
    where: { id: params.bookId },
    select: {
      id: true,
      title: true,
      fileSha256: true,
      fileName: true,
      mimeType: true,
    },
  });

  if (!book) {
    throw new Error("Book not found");
  }

  const resolvedCorpus = await resolveBookTextCorpus({
    client: prisma,
    bookId: book.id,
    logger: params.logger,
  });
  const chapters: AnalysisChapterInput[] = resolvedCorpus.chapters.map((chapter) => ({
    id: chapter.chapterId,
    orderIndex: chapter.orderIndex,
    title: chapter.title,
    rawText: chapter.rawText,
  }));

  const chapterStats: ChapterAnalysisStat[] = chapters.map((chapter) => ({
    chapterId: chapter.id,
    chapterOrderIndex: chapter.orderIndex,
    chapterTitle: chapter.title,
    status: "pending",
    llmModel: client.config.chatModel,
    embeddingModel: client.config.embeddingModel,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    totalBlocks: splitChapterIntoBlocks(String(chapter.rawText || "")).length,
    checkedBlocks: 0,
    chunkCount: 0,
    chunkFailedCount: 0,
    llmCalls: 0,
    llmRetries: 0,
    llmLatencyMs: 0,
    embeddingCalls: 0,
    embeddingLatencyMs: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmTotalTokens: 0,
    embeddingInputTokens: 0,
    embeddingTotalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }));

  const startedAt = new Date();
  const contentVersion = await ensureBookContentVersion({
    client: prisma,
    bookId: book.id,
    fileSha256: book.fileSha256,
    fileName: book.fileName,
    mimeType: book.mimeType,
  });
  const run = await createBookAnalysisRun({
    client: prisma,
    bookId: book.id,
    contentVersionId: contentVersion.id,
    configVersion: ANALYSIS_CONFIG_VERSION,
    configHash: computeRunConfigHash({
      chatModel: client.config.chatModel,
      embeddingModel: client.config.embeddingModel,
      chunkSize: SCENE_CHUNK_SIZE,
      chunkOverlap: SCENE_CHUNK_OVERLAP,
      chunkConcurrency: ANALYSIS_CHUNK_CONCURRENCY,
      chapterConcurrency: ANALYSIS_CHAPTER_CONCURRENCY,
      paragraphEmbeddingVersion: PARAGRAPH_EMBEDDING_VERSION,
      sceneEmbeddingVersion: SCENE_EMBEDDING_VERSION,
    }),
    extractModel: client.config.chatModel,
    chatModel: client.config.chatModel,
    embeddingModel: client.config.embeddingModel,
    pricingVersion: resolvePricingVersion(),
    startedAt,
  });
  const runContext: RunMetricContext = {
    runId: run.id,
    contentVersionId: contentVersion.id,
    pricingVersion: resolvePricingVersion(),
    configHash: computeRunConfigHash({
      chatModel: client.config.chatModel,
      embeddingModel: client.config.embeddingModel,
      chunkSize: SCENE_CHUNK_SIZE,
      chunkOverlap: SCENE_CHUNK_OVERLAP,
      chunkConcurrency: ANALYSIS_CHUNK_CONCURRENCY,
      chapterConcurrency: ANALYSIS_CHAPTER_CONCURRENCY,
      paragraphEmbeddingVersion: PARAGRAPH_EMBEDDING_VERSION,
      sceneEmbeddingVersion: SCENE_EMBEDDING_VERSION,
    }),
    stageMetrics: Object.fromEntries(RUN_STAGE_KEYS.map((stageKey) => [stageKey, createEmptyStageMetric()])),
    chapterStageMetrics: new Map(),
    storageBytes: {
      paragraphEmbeddings: 0,
      sceneEmbeddings: 0,
      sceneData: 0,
      artifactPayloads: 0,
    },
  };

  params.logger.info("Book analysis started", {
    bookId: book.id,
    title: book.title,
    sceneWindowStrategy: SCENE_WINDOW_STRATEGY,
    sceneWindowSize: SCENE_CHUNK_SIZE,
    sceneWindowOverlap: SCENE_CHUNK_OVERLAP,
    chapters: chapters.length,
  });

  await prisma.$transaction(async (tx: any) => {
    await tx.bookParagraphEmbedding.deleteMany({
      where: {
        bookId: book.id,
      },
    });

    await tx.bookScene.deleteMany({
      where: {
        bookId: book.id,
      },
    });

    await tx.book.update({
      where: { id: book.id },
      data: {
        analysisState: "running",
        analysisStatus: "running",
        analysisError: null,
        analysisStartedAt: startedAt,
        analysisFinishedAt: null,
        analysisCompletedAt: null,
        analysisCheckedBlocks: 0,
        analysisTotalBlocks: chapterStats.reduce((sum, stat) => sum + stat.totalBlocks, 0),
        analysisPromptTokens: 0,
        analysisCompletionTokens: 0,
        analysisTotalTokens: 0,
        analysisChapterStatsJson: chapterStats as unknown as Prisma.InputJsonValue,
        currentAnalysisRunId: run.id,
        latestAnalysisRunId: run.id,
      },
    });
  });
  await prewarmEmbeddingModel({
    client,
    logger: params.logger,
  });

  let progressQueue = Promise.resolve();
  const enqueueProgressUpdate = (mutate: () => void) => {
    progressQueue = progressQueue.then(async () => {
      mutate();
      await persistBookAnalysisProgress({
        bookId: book.id,
        status: "running",
        chapterStats,
      });
      await syncRunScopedMetrics({
        bookId: book.id,
        runContext,
        chapterStats,
        runState: "running",
        startedAt,
        chatModel: client.config.chatModel,
        embeddingModel: client.config.embeddingModel,
        extractModel: client.config.chatModel,
      });
    });
    return progressQueue;
  };

  const analyzeChapter = async (chapter: AnalysisChapterInput): Promise<ChapterRunResult> => {
    const chapterStat = chapterStats.find((item) => item.chapterId === chapter.id);
    if (!chapterStat) {
      return {
        ok: false,
        chapterId: chapter.id,
        error: new Error("Chapter stat not found"),
      };
    }

    const chapterStartedAtMs = Date.now();
    const chapterStartedIso = new Date(chapterStartedAtMs).toISOString();
    const chapterStageMetrics = {
      [ANALYSIS_PARAGRAPH_STAGE]: createEmptyStageMetric(),
      [ANALYSIS_SCENE_CHUNK_STAGE]: createEmptyStageMetric(),
      [ANALYSIS_SCENE_EMBEDDING_STAGE]: createEmptyStageMetric(),
      [ANALYSIS_FINALIZE_STAGE]: createEmptyStageMetric(),
    };
    runContext.chapterStageMetrics.set(chapter.id, chapterStageMetrics);

    try {
      await enqueueProgressUpdate(() => {
        chapterStat.status = "running";
        chapterStat.startedAt = chapterStartedIso;
        chapterStat.finishedAt = null;
        chapterStat.elapsedMs = 0;
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].state = "running";
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].startedAt = chapterStartedIso;
      });

      const blocks = splitChapterIntoBlocks(String(chapter.rawText || ""));
      if (!blocks.length) {
        const finishedAt = new Date();
        await enqueueProgressUpdate(() => {
          chapterStat.checkedBlocks = chapterStat.totalBlocks;
          chapterStat.status = "completed";
          chapterStat.finishedAt = finishedAt.toISOString();
          chapterStat.elapsedMs = Math.max(0, finishedAt.getTime() - chapterStartedAtMs);
          chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].completedAt = finishedAt.toISOString();
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].startedAt = chapterStartedIso;
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].completedAt = finishedAt.toISOString();
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].startedAt = chapterStartedIso;
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt = finishedAt.toISOString();
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].startedAt = chapterStartedIso;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].completedAt = finishedAt.toISOString();
        });
        return {
          ok: true,
          chapterId: chapter.id,
        };
      }

      const boundaryEmbeddingStartedAt = Date.now();
      const { hints: embeddingHints, vectors: paragraphVectors, usage: embeddingUsage } = await requestEmbeddingBoundaryHints({
        client,
        paragraphs: blocks,
      });
      const boundaryEmbeddingElapsedMs = Date.now() - boundaryEmbeddingStartedAt;
      await enqueueProgressUpdate(() => {
        addEmbeddingUsage(chapterStat, embeddingUsage);
        chapterStat.embeddingCalls += 1;
        chapterStat.embeddingLatencyMs += Math.max(0, boundaryEmbeddingElapsedMs);
      });

      await persistParagraphEmbeddings({
        bookId: book.id,
        chapterId: chapter.id,
        paragraphs: blocks,
        vectors: paragraphVectors,
        embeddingModel: client.config.embeddingModel,
      });
      const paragraphEmbeddingBytes = estimateParagraphEmbeddingBytes({
        paragraphs: blocks,
        vectorDimensions: PGVECTOR_EMBEDDING_DIMENSIONS,
      });
      await enqueueProgressUpdate(() => {
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].state = "completed";
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].embeddingInputTokens = Math.max(
          0,
          Number(embeddingUsage.input_tokens || 0)
        );
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].embeddingTotalTokens = Math.max(
          0,
          Number(embeddingUsage.total_tokens || embeddingUsage.input_tokens || 0)
        );
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].elapsedMs = Math.max(0, boundaryEmbeddingElapsedMs);
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].embeddingCalls = 1;
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].outputRowCount = paragraphVectors.length;
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].storageBytes = {
          paragraphEmbeddings: paragraphEmbeddingBytes,
        };
        chapterStageMetrics[ANALYSIS_PARAGRAPH_STAGE].completedAt = new Date().toISOString();
        chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state = "running";
        chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].startedAt ||= new Date().toISOString();
      });

      params.logger.info("Chapter embedding hints prepared", {
        bookId: book.id,
        chapterId: chapter.id,
        chapterOrderIndex: chapter.orderIndex,
        paragraphCount: blocks.length,
        hintCount: embeddingHints.length,
        embeddingInputTokens: Number(embeddingUsage.input_tokens || 0),
        paragraphEmbeddingsPersisted: paragraphVectors.length,
        paragraphEmbeddingVersion: PARAGRAPH_EMBEDDING_VERSION,
      });

      const chunks = createSceneAnalysisChunks({
        paragraphs: blocks,
        embeddingHints,
      });
      params.logger.info("Chapter analysis windows prepared", {
        bookId: book.id,
        chapterId: chapter.id,
        chapterOrderIndex: chapter.orderIndex,
        sceneWindowStrategy: SCENE_WINDOW_STRATEGY,
        paragraphCount: blocks.length,
        hintCount: embeddingHints.length,
        windowCount: chunks.length,
        windowSize: SCENE_CHUNK_SIZE,
        windowOverlap: SCENE_CHUNK_OVERLAP,
        chunkConcurrency: ANALYSIS_CHUNK_CONCURRENCY,
      });

      const boundaryCandidates: SceneBoundaryCandidate[] = [];
      const chunkScenes: SceneCandidate[] = [];
      const coveredParagraphIndexes = new Set<number>();
      const inFlight = new Map<number, Promise<{ taskId: number; result: ChunkAnalysisResult }>>();
      const chunkQueue = chunks.slice();
      const effectiveChunkConcurrency = Math.min(Math.max(1, ANALYSIS_CHUNK_CONCURRENCY), chunkQueue.length || 1);
      let nextTaskId = 1;

      const buildChunkTask = (chunk: ParagraphChunk): Promise<ChunkAnalysisResult> =>
        requestChunkSceneBoundariesWithRetry({
          client,
          logger: params.logger,
          runId: runContext.runId,
          bookId: book.id,
          chapterId: chapter.id,
          chapterOrderIndex: chapter.orderIndex,
          chapterTitle: chapter.title,
          chunkStartParagraph: chunk.chunkStartParagraph,
          chunkEndParagraph: chunk.chunkEndParagraph,
          paragraphs: chunk.paragraphs,
          embeddingHints,
        })
          .then(({ parsed, usage, attemptCount, elapsedMs, artifactPayloadBytes }): ChunkAnalysisSuccess => ({
            ok: true,
            chunk,
            parsed,
            usage,
            attemptCount,
            elapsedMs,
            artifactPayloadBytes,
          }))
          .catch((error): ChunkAnalysisFailure => {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            const usage = error instanceof ChunkCallError ? error.usage : {};
            const attemptCount = error instanceof ChunkCallError ? error.attemptCount : 1;
            const elapsedMs = error instanceof ChunkCallError ? error.elapsedMs : 0;
            const artifactPayloadBytes = error instanceof ChunkCallError ? error.artifactPayloadBytes : 0;
            return {
              ok: false,
              chunk,
              error: normalizedError,
              usage,
              attemptCount,
              elapsedMs,
              artifactPayloadBytes,
            };
          });

      const launchNext = () => {
        while (inFlight.size < effectiveChunkConcurrency && chunkQueue.length > 0) {
          const nextChunk = chunkQueue.shift();
          if (!nextChunk) break;
          const taskId = nextTaskId;
          nextTaskId += 1;
          inFlight.set(
            taskId,
            buildChunkTask(nextChunk).then((result) => ({
              taskId,
              result,
            }))
          );
        }
      };

      launchNext();
      while (inFlight.size > 0) {
        const settled = await Promise.race(inFlight.values());
        inFlight.delete(settled.taskId);

        const chunkResult = settled.result;
        await enqueueProgressUpdate(() => {
          addUsage(chapterStat, chunkResult.usage);
          chapterStat.llmCalls += Math.max(1, chunkResult.attemptCount);
          chapterStat.llmRetries += Math.max(0, chunkResult.attemptCount - 1);
          chapterStat.llmLatencyMs += Math.max(0, Math.round(chunkResult.elapsedMs));
          chapterStat.chunkCount += 1;
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state = "running";
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].promptTokens += Math.max(
            0,
            Number(chunkResult.usage.prompt_tokens || 0)
          );
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].completionTokens += Math.max(
            0,
            Number(chunkResult.usage.completion_tokens || 0)
          );
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].totalTokens += Math.max(
            0,
            Number(chunkResult.usage.total_tokens || 0)
          );
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].elapsedMs += Math.max(0, Math.round(chunkResult.elapsedMs));
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].retryCount += Math.max(0, chunkResult.attemptCount - 1);
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].llmCalls += Math.max(1, chunkResult.attemptCount);
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].chunkCount += 1;
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].outputRowCount += Math.max(1, chunkResult.attemptCount);
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].storageBytes.artifactPayloads = Math.max(
            0,
            Number(chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].storageBytes.artifactPayloads || 0) +
              Number(chunkResult.artifactPayloadBytes || 0)
          );
          if (!chunkResult.ok) {
            chapterStat.chunkFailedCount += 1;
            chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].chunkFailedCount += 1;
            chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].error = chunkResult.error.message;
            chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state = "failed";
            chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].completedAt = new Date().toISOString();
            return;
          }
          for (
            let paragraphIndex = chunkResult.chunk.chunkStartParagraph;
            paragraphIndex <= chunkResult.chunk.chunkEndParagraph;
            paragraphIndex += 1
          ) {
            coveredParagraphIndexes.add(paragraphIndex);
          }
          chapterStat.checkedBlocks = coveredParagraphIndexes.size;
        });

        if (!chunkResult.ok) {
          throw chunkResult.error;
        }

        boundaryCandidates.push(...chunkResult.parsed.boundaries);
        chunkScenes.push(...chunkResult.parsed.scenes);

        launchNext();
      }
      await enqueueProgressUpdate(() => {
        chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state =
          chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].state === "failed" ? "failed" : "completed";
        chapterStageMetrics[ANALYSIS_SCENE_CHUNK_STAGE].completedAt = new Date().toISOString();
        chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].state = "running";
        chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].startedAt ||= new Date().toISOString();
      });

      const sceneBoundaries = mergeBoundaryCandidates(boundaryCandidates);
      params.logger.info("Chapter boundaries merged", {
        bookId: book.id,
        chapterId: chapter.id,
        chapterOrderIndex: chapter.orderIndex,
        candidateCount: boundaryCandidates.length,
        mergedCount: sceneBoundaries.length,
      });

      const finalScenes = enrichFinalScenesFromChunkScenes(
        buildFinalScenes(blocks.length, sceneBoundaries),
        chunkScenes,
        blocks
      );

      const scenesToCreate: Prisma.BookAnalysisSceneCreateManyInput[] = [];
      for (let index = 0; index < finalScenes.length; index += 1) {
        const scene = finalScenes[index]!;
        const sceneText = buildSceneExcerpt(blocks, scene.paragraphStart, scene.paragraphEnd);
        const sceneSummary = buildSceneCardFromExcerpt(sceneText);

        scenesToCreate.push({
          bookId: book.id,
          chapterId: chapter.id,
          sceneIndex: index + 1,
          paragraphStart: scene.paragraphStart,
          paragraphEnd: scene.paragraphEnd,
          locationLabel: scene.locationHints[0] || null,
          timeLabel: scene.timeHints[0] || null,
          participantsJson: scene.participants as unknown as Prisma.InputJsonValue,
          sceneSummary: sceneSummary,
          sceneCard: scene.sceneCard || sceneSummary,
          mentionedEntitiesJson: scene.mentionedEntities as unknown as Prisma.InputJsonValue,
          locationHintsJson: scene.locationHints as unknown as Prisma.InputJsonValue,
          timeHintsJson: scene.timeHints as unknown as Prisma.InputJsonValue,
          eventLabelsJson: scene.eventLabels as unknown as Prisma.InputJsonValue,
          unresolvedFormsJson: scene.unresolvedForms as unknown as Prisma.InputJsonValue,
          factsJson: scene.facts as unknown as Prisma.InputJsonValue,
          evidenceSpansJson: scene.evidenceSpans as unknown as Prisma.InputJsonValue,
          changeSignal: scene.changeSignal,
          excerptText: sceneText,
        });
      }
      const sceneDataBytes = estimateSceneDataBytes(scenesToCreate);

      if (scenesToCreate.length) {
        await prisma.bookScene.createMany({
          data: scenesToCreate,
        });

        const persistedScenes = await prisma.bookScene.findMany({
          where: {
            bookId: book.id,
            chapterId: chapter.id,
          },
          orderBy: {
            sceneIndex: "asc",
          },
          select: {
            id: true,
            bookId: true,
            chapterId: true,
            sceneIndex: true,
            paragraphStart: true,
            paragraphEnd: true,
            locationLabel: true,
            timeLabel: true,
            participantsJson: true,
            sceneSummary: true,
            sceneCard: true,
            mentionedEntitiesJson: true,
            locationHintsJson: true,
            timeHintsJson: true,
            eventLabelsJson: true,
            unresolvedFormsJson: true,
            factsJson: true,
            excerptText: true,
          },
        });

        const sceneEmbeddingStartedAt = Date.now();
        const { documents, vectors, usage: sceneEmbeddingUsage } = await requestSceneEmbeddings({
          client,
          bookTitle: book.title,
          chapterTitle: chapter.title,
          scenes: persistedScenes,
        });
        const sceneEmbeddingElapsedMs = Date.now() - sceneEmbeddingStartedAt;

        if (documents.length) {
          const now = new Date();
          const rows = documents.map((item, index) => {
            const vector = vectors[index] || [];
            const vectorLiteral = serializePgVectorLiteral(vector);

            return Prisma.sql`(
              ${randomUUID()},
              ${item.sceneId},
              ${item.bookId},
              ${item.chapterId},
              ${item.sceneIndex},
              ${client.config.embeddingModel},
              ${SCENE_EMBEDDING_VERSION},
              ${"RETRIEVAL_DOCUMENT"},
              ${vector.length},
              ${item.sourceText},
              ${item.sourceTextHash},
              ${now},
              ${now},
              CAST(${vectorLiteral} AS vector(768))
            )`;
          });

          for (const rowBatch of chunkArray(rows, EMBEDDING_INSERT_BATCH_SIZE)) {
            await prisma.$executeRaw(
              Prisma.sql`
                INSERT INTO "BookSceneEmbedding" (
                  "id",
                  "sceneId",
                  "bookId",
                  "chapterId",
                  "sceneIndex",
                  "embeddingModel",
                  "embeddingVersion",
                  "taskType",
                  "dimensions",
                  "sourceText",
                  "sourceTextHash",
                  "createdAt",
                  "updatedAt",
                  "vector"
                )
                VALUES ${Prisma.join(rowBatch)}
              `
            );
          }
        }
        const sceneEmbeddingBytes = estimateSceneEmbeddingBytes({
          sourceTexts: documents.map((item) => item.sourceText),
          vectorDimensions: PGVECTOR_EMBEDDING_DIMENSIONS,
        });

        await enqueueProgressUpdate(() => {
          addEmbeddingUsage(chapterStat, sceneEmbeddingUsage);
          chapterStat.embeddingCalls += 1;
          chapterStat.embeddingLatencyMs += Math.max(0, sceneEmbeddingElapsedMs);
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].embeddingInputTokens = Math.max(
            0,
            Number(sceneEmbeddingUsage.input_tokens || 0)
          );
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].embeddingTotalTokens = Math.max(
            0,
            Number(sceneEmbeddingUsage.total_tokens || sceneEmbeddingUsage.input_tokens || 0)
          );
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].elapsedMs = Math.max(0, sceneEmbeddingElapsedMs);
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].embeddingCalls = 1;
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].outputRowCount = documents.length;
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].storageBytes = {
            sceneEmbeddings: sceneEmbeddingBytes,
          };
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt = new Date().toISOString();
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].startedAt ||= chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].completedAt = chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].outputRowCount = scenesToCreate.length;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].storageBytes = {
            sceneData: sceneDataBytes,
          };
        });

        params.logger.info("Chapter scene embeddings created", {
          bookId: book.id,
          chapterId: chapter.id,
          chapterOrderIndex: chapter.orderIndex,
          sceneCount: documents.length,
          embeddingModel: client.config.embeddingModel,
          embeddingVersion: SCENE_EMBEDDING_VERSION,
          embeddingInputTokens: Number(sceneEmbeddingUsage.input_tokens || 0),
        });
      } else {
        await enqueueProgressUpdate(() => {
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt = new Date().toISOString();
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].state = "completed";
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].startedAt ||= chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].completedAt = chapterStageMetrics[ANALYSIS_SCENE_EMBEDDING_STAGE].completedAt;
          chapterStageMetrics[ANALYSIS_FINALIZE_STAGE].storageBytes = {
            sceneData: sceneDataBytes,
          };
        });
      }

      const finishedAt = new Date();
      await enqueueProgressUpdate(() => {
        chapterStat.checkedBlocks = chapterStat.totalBlocks;
        chapterStat.status = "completed";
        chapterStat.finishedAt = finishedAt.toISOString();
        chapterStat.elapsedMs = Math.max(0, finishedAt.getTime() - chapterStartedAtMs);
      });

      return {
        ok: true,
        chapterId: chapter.id,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const failedAt = new Date();
      await enqueueProgressUpdate(() => {
        chapterStat.status = "failed";
        chapterStat.finishedAt = failedAt.toISOString();
        chapterStat.elapsedMs = Math.max(0, failedAt.getTime() - chapterStartedAtMs);
        for (const stageKey of RUN_STAGE_KEYS) {
          const metric = chapterStageMetrics[stageKey];
          if (!metric.startedAt) metric.startedAt = chapterStartedIso;
          if (metric.state === "completed") continue;
          metric.state = "failed";
          metric.error = normalizedError.message;
          metric.completedAt = failedAt.toISOString();
        }
      });

      return {
        ok: false,
        chapterId: chapter.id,
        error: normalizedError,
      };
    }
  };

  const chapterQueue = chapters.slice();
  const inFlightChapters = new Map<number, Promise<{ taskId: number; result: ChapterRunResult }>>();
  const effectiveChapterConcurrency = Math.min(Math.max(1, ANALYSIS_CHAPTER_CONCURRENCY), chapterQueue.length || 1);
  let nextChapterTaskId = 1;
  const chapterFailures: Array<{ chapterId: string; error: Error }> = [];

  params.logger.info("Book chapter batching started", {
    bookId: book.id,
    chapters: chapters.length,
    chapterConcurrency: effectiveChapterConcurrency,
    chunkConcurrency: ANALYSIS_CHUNK_CONCURRENCY,
  });

  const launchNextChapter = () => {
    while (inFlightChapters.size < effectiveChapterConcurrency && chapterQueue.length > 0) {
      const nextChapter = chapterQueue.shift();
      if (!nextChapter) break;

      const taskId = nextChapterTaskId;
      nextChapterTaskId += 1;
      inFlightChapters.set(
        taskId,
        analyzeChapter(nextChapter).then((result) => ({
          taskId,
          result,
        }))
      );
    }
  };

  launchNextChapter();
  while (inFlightChapters.size > 0) {
    const settled = await Promise.race(inFlightChapters.values());
    inFlightChapters.delete(settled.taskId);

    if (!settled.result.ok) {
      chapterFailures.push({
        chapterId: settled.result.chapterId,
        error: settled.result.error,
      });
      params.logger.error("Chapter analysis failed", {
        bookId: book.id,
        chapterId: settled.result.chapterId,
        error: settled.result.error.message,
      });
    }

    launchNextChapter();
  }

  await progressQueue;
  const failedChapterIds = chapterStats.filter((item) => item.status === "failed").map((item) => item.chapterId);
  const successfulChapterCount = chapterStats.filter((item) => item.status === "completed").length;
  const degradationReasons = chapterFailures.length > 0 ? ["chapter_partial_failures"] : [];

  if (chapterFailures.length > 0 && successfulChapterCount === 0) {
    const finalError = chapterFailures[0]?.error || new Error("Analysis failed without usable output");
    await syncRunScopedMetrics({
      bookId: book.id,
      runContext,
      chapterStats,
      runState: "failed",
      startedAt,
      finishedAt: new Date(),
      chatModel: client.config.chatModel,
      embeddingModel: client.config.embeddingModel,
      extractModel: client.config.chatModel,
      runError: finalError.message,
      qualityFlags: {
        degraded: false,
        degradationReasons: ["no_usable_output"],
        failedChapterIds,
        retryExhausted: false,
      },
    });
    throw finalError;
  }

  const completedAt = new Date();
  await persistBookAnalysisProgress({
    bookId: book.id,
    status: "completed",
    chapterStats,
    finishedAt: completedAt,
  });
  await syncRunScopedMetrics({
    bookId: book.id,
    runContext,
    chapterStats,
    runState: "completed",
    startedAt,
    finishedAt: completedAt,
    chatModel: client.config.chatModel,
    embeddingModel: client.config.embeddingModel,
    extractModel: client.config.chatModel,
    qualityFlags: {
      degraded: chapterFailures.length > 0,
      degradationReasons,
      failedChapterIds,
      retryExhausted: false,
    },
  });

  if (chapterFailures.length > 0) {
    params.logger.warn("Book analysis completed with degradation", {
      bookId: book.id,
      chapters: chapters.length,
      failedChapterCount: failedChapterIds.length,
      failedChapterIds,
      degradationReasons,
    });
  } else {
    params.logger.info("Book analysis completed", {
      bookId: book.id,
      chapters: chapters.length,
    });
  }
}

export async function markBookAnalysisFailed(params: {
  bookId: string;
  error: string;
  logger: AnalysisLogger;
  qualityFlags?: {
    degraded?: boolean;
    degradationReasons?: string[];
    failedChapterIds?: string[];
    retryExhausted?: boolean;
  };
}) {
  const book = await prisma.book.findUnique({
    where: { id: params.bookId },
    select: {
      currentAnalysisRunId: true,
      latestAnalysisRunId: true,
    },
  });

  await prisma.$transaction(async (tx: any) => {
    await tx.bookScene.deleteMany({
      where: {
        bookId: params.bookId,
      },
    });

    await tx.book.updateMany({
      where: {
        id: params.bookId,
      },
      data: {
        analysisState: "failed",
        analysisStatus: "failed",
        analysisError: String(params.error || "Analysis failed").slice(0, 2000),
        analysisFinishedAt: new Date(),
        analysisCompletedAt: new Date(),
        currentAnalysisRunId: null,
      },
    });

    const failedRunId = String(book?.currentAnalysisRunId || book?.latestAnalysisRunId || "").trim();
    if (failedRunId) {
      await tx.bookAnalysisRun.updateMany({
        where: { id: failedRunId },
        data: {
          state: "failed",
          error: String(params.error || "Analysis failed").slice(0, 2000),
          qualityFlagsJson: ({
            degraded: Boolean(params.qualityFlags?.degraded),
            degradationReasons: Array.isArray(params.qualityFlags?.degradationReasons)
              ? params.qualityFlags?.degradationReasons
              : [],
            failedChapterIds: Array.isArray(params.qualityFlags?.failedChapterIds) ? params.qualityFlags?.failedChapterIds : [],
            retryExhausted: Boolean(params.qualityFlags?.retryExhausted),
          } as unknown) as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      await tx.bookStageExecution.updateMany({
        where: {
          runId: failedRunId,
          state: {
            not: "completed",
          },
        },
        data: {
          state: "failed",
          error: String(params.error || "Analysis failed").slice(0, 2000),
          completedAt: new Date(),
        },
      });
      await tx.bookAnalysisChapterMetric.updateMany({
        where: {
          runId: failedRunId,
          state: {
            not: "completed",
          },
        },
        data: {
          state: "failed",
          error: String(params.error || "Analysis failed").slice(0, 2000),
          completedAt: new Date(),
        },
      });
    }
  });

  params.logger.error("Book analysis failed", {
    bookId: params.bookId,
    error: params.error,
  });
}
