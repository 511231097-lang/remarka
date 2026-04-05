import { z } from "zod";
import {
  AliasTypeSchema,
  EntityPassResultSchema,
  PatchWindowsResultSchema,
  normalizeEntityName,
  type AliasType,
  type EntityPassResult,
  type EntityType,
  type MentionType,
  type MentionCandidateType,
  type PatchWindowsResult,
  type PrepassResult,
} from "@remarka/contracts";
import { createKiaClient } from "./kiaClient";
import { createTimewebClient } from "./timewebClient";
import { createVertexClient } from "./vertexClient";
import { workerConfig } from "./config";
import { logger } from "./logger";

interface ProviderChatCompletionChoice {
  finish_reason?: unknown;
  message?: {
    content?: unknown;
  } | null;
}

interface ProviderChatCompletionPayload {
  choices?: ProviderChatCompletionChoice[];
}

interface KnownEntityForPrompt {
  id: string;
  type: EntityType;
  canonicalName: string;
  normalizedName: string;
  aliases: Array<{ alias: string; normalizedAlias: string }>;
}

interface EntityPassInput {
  contentVersion: number;
  prepass: PrepassResult;
  knownEntities: KnownEntityForPrompt[];
}

interface PatchCandidateInput {
  candidateId: string;
  sourceText: string;
  candidateType: MentionCandidateType;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  conflictGroupId: string;
  entityHintId: string | null;
  entityHintName: string | null;
}

interface PatchWindowInput {
  windowKey: string;
  candidates: PatchCandidateInput[];
}

interface PatchCompletionInput {
  runId: string;
  contentVersion: number;
  windows: PatchWindowInput[];
  entities: Array<{
    id: string;
    type: EntityType;
    canonicalName: string;
    normalizedName: string;
  }>;
}

interface CharacterMergeArbiterEvidenceInput {
  chapterId: string;
  sourceText: string;
  context: string;
}

interface CharacterMergeArbiterEntityInput {
  id: string;
  canonicalName: string;
  normalizedName: string;
  mentionCount: number;
  aliases: Array<{ alias: string; aliasType: AliasType }>;
  evidence: CharacterMergeArbiterEvidenceInput[];
}

interface CharacterBookPassEntityInput {
  id: string;
  canonicalName: string;
  normalizedName: string;
  mentionCount: number;
  aliases: Array<{ alias: string; aliasType: AliasType }>;
}

interface CharacterProfileEvidenceInput {
  chapterId: string;
  sourceText: string;
  context: string;
  mentionType: MentionType;
  confidence: number;
}

interface CharacterProfileChapterSummaryInput {
  chapterId: string;
  summary: string;
}

interface CharacterProfileSynthesisCharacterInput {
  id: string;
  canonicalName: string;
  mentionCount: number;
  aliases: string[];
  evidence: CharacterProfileEvidenceInput[];
  chapterSummaries: CharacterProfileChapterSummaryInput[];
}

export interface CharacterProfileSynthesisInput {
  projectId: string;
  characters: CharacterProfileSynthesisCharacterInput[];
}

export interface CharacterProfileSynthesisResult {
  profiles: Array<{
    characterId: string;
    shortDescription: string;
  }>;
}

export interface CharacterBookPassCanonicalizationInput {
  projectId: string;
  entities: CharacterBookPassEntityInput[];
}

export interface CharacterBookPassCanonicalizationResult {
  groups: Array<{
    canonicalEntityId: string;
    memberEntityIds: string[];
    confidence: number;
    rationale: string;
  }>;
}

export interface CharacterMergeArbiterInput {
  pairId: string;
  sharedAliases: string[];
  leftEntity: CharacterMergeArbiterEntityInput;
  rightEntity: CharacterMergeArbiterEntityInput;
}

export interface CharacterMergeArbiterResult {
  pairId: string;
  decision: "merge" | "keep_separate" | "unresolved";
  confidence: number;
  preferredEntity: "left" | "right" | "none";
  rationale: string;
}

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StrictJsonCallMeta {
  provider: "kia" | "timeweb" | "vertex";
  model: string;
  attempt: number;
  finishReason: string | null;
  usage: LlmTokenUsage | null;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
}

export interface StrictJsonCallDebug {
  prompt: string;
  rawResponse: string;
  jsonCandidate: string;
}

interface StrictJsonCallResult<T> {
  result: T;
  meta: StrictJsonCallMeta;
  debug: StrictJsonCallDebug;
}

export class ExtractionStructuredOutputError extends Error {
  phase:
    | "entity_pass"
    | "mention_completion"
    | "character_merge_arbiter"
    | "character_book_pass"
    | "character_profile";
  provider: "kia" | "timeweb" | "vertex";
  model: string;
  attempt: number;
  finishReason: string | null;
  usage: LlmTokenUsage | null;
  rawResponseSnippet: string;
  jsonCandidateSnippet: string;

  constructor(params: {
    message: string;
    phase:
      | "entity_pass"
      | "mention_completion"
      | "character_merge_arbiter"
      | "character_book_pass"
      | "character_profile";
    provider: "kia" | "timeweb" | "vertex";
    model: string;
    attempt: number;
    finishReason: string | null;
    usage: LlmTokenUsage | null;
    rawResponse?: string;
    jsonCandidate?: string;
  }) {
    super(params.message);
    this.name = "ExtractionStructuredOutputError";
    this.phase = params.phase;
    this.provider = params.provider;
    this.model = params.model;
    this.attempt = params.attempt;
    this.finishReason = params.finishReason;
    this.usage = params.usage;
    this.rawResponseSnippet = String(params.rawResponse || "").slice(0, 5000);
    this.jsonCandidateSnippet = String(params.jsonCandidate || "").slice(0, 5000);
  }
}

interface ParsedProviderCompletion {
  completion: ProviderChatCompletionPayload;
  usageRaw: unknown;
}

function parseProviderChatCompletionResponse(response: unknown): ParsedProviderCompletion {
  let payload: unknown = response;

  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) {
      throw new Error("Extraction provider returned empty payload");
    }

    payload = JSON.parse(text);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Extraction provider returned unsupported payload type");
  }

  const envelope = payload as {
    code?: unknown;
    msg?: unknown;
    data?: unknown;
  };

  const providerCode = Number(envelope.code);
  const providerMessage = String(envelope.msg || "").trim();
  if (Number.isFinite(providerCode) && providerCode !== 200) {
    throw new Error(providerMessage ? `Provider error (${providerCode}): ${providerMessage}` : `Provider error (${providerCode})`);
  }

  let completionPayload: unknown = payload;
  if (envelope.data !== undefined && envelope.data !== null) {
    completionPayload = envelope.data;
    if (typeof completionPayload === "string") {
      const text = completionPayload.trim();
      if (!text) {
        throw new Error("Extraction provider returned empty data payload");
      }
      completionPayload = JSON.parse(text);
    }
  }

  if (!completionPayload || typeof completionPayload !== "object") {
    throw new Error("Extraction provider completion payload has unsupported type");
  }

  const payloadRecord = payload as Record<string, unknown>;
  const completionRecord = completionPayload as Record<string, unknown>;

  return {
    completion: completionPayload as ProviderChatCompletionPayload,
    usageRaw: completionRecord.usage ?? payloadRecord.usage ?? null,
  };
}

function parseTokenUsage(rawUsage: unknown): LlmTokenUsage | null {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return null;
  }

  const usage = rawUsage as Record<string, unknown>;

  const readNumber = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value);
      }
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return Math.round(parsed);
        }
      }
    }

    return null;
  };

  const promptTokens = readNumber(
    "prompt_tokens",
    "promptTokens",
    "input_tokens",
    "inputTokens",
    "prompt_token_count",
    "inputTokenCount"
  );
  const completionTokens = readNumber(
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
    "completion_token_count",
    "outputTokenCount"
  );
  const totalTokens = readNumber("total_tokens", "totalTokens", "token_count", "totalTokenCount");

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }

  const safePrompt = promptTokens ?? 0;
  const safeCompletion = completionTokens ?? 0;
  const safeTotal = totalTokens ?? safePrompt + safeCompletion;

  return {
    promptTokens: safePrompt,
    completionTokens: safeCompletion,
    totalTokens: safeTotal,
  };
}

function extractJsonCandidate(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start =
    objectStart >= 0 && arrayStart >= 0
      ? Math.min(objectStart, arrayStart)
      : objectStart >= 0
        ? objectStart
        : arrayStart;
  if (start < 0) return trimmed;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        break;
      }
      stack.pop();
      if (stack.length === 0) {
        return trimmed.slice(start, i + 1).trim();
      }
    }
  }

  return trimmed;
}

async function callStrictJson<T>(params: {
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  phase:
    | "entity_pass"
    | "mention_completion"
    | "character_merge_arbiter"
    | "character_book_pass"
    | "character_profile";
  timewebModelId?: string | null;
}): Promise<StrictJsonCallResult<T>> {
  const provider = workerConfig.extraction.provider;
  const requestedTimewebModelId = provider === "timeweb" ? String(params.timewebModelId || "").trim() : "";
  const client =
    provider === "kia"
      ? createKiaClient()
      : provider === "vertex"
        ? createVertexClient()
        : createTimewebClient({
            accessId: requestedTimewebModelId || null,
          });
  const configuredPrimaryModel =
    provider === "kia"
      ? workerConfig.kia.extractModel
      : provider === "vertex"
        ? workerConfig.vertex.extractModel
        : workerConfig.timeweb.extractModel;
  const configuredFallbackModel =
    provider === "kia"
      ? workerConfig.kia.extractFallbackModel
      : provider === "vertex"
        ? workerConfig.vertex.extractFallbackModel
        : workerConfig.timeweb.extractFallbackModel;
  const modelCandidates = Array.from(
    new Set(
      [
        requestedTimewebModelId,
        configuredPrimaryModel,
        configuredFallbackModel,
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
  const maxAttempts = Math.max(
    1,
    provider === "kia"
      ? workerConfig.kia.extractAttempts
      : provider === "vertex"
        ? workerConfig.vertex.extractAttempts
        : workerConfig.timeweb.extractAttempts
  );
  const maxTokens =
    provider === "kia"
      ? workerConfig.kia.extractMaxTokens
      : provider === "vertex"
        ? workerConfig.vertex.extractMaxTokens
        : workerConfig.timeweb.extractMaxTokens;
  const proxySource =
    provider === "kia"
      ? workerConfig.kia.proxySource
      : provider === "vertex"
        ? workerConfig.vertex.proxySource
        : workerConfig.timeweb.proxySource;

  let lastError: Error | null = null;

  for (const model of modelCandidates) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptStartedAtMs = Date.now();
      try {
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON extractor. Return exactly one complete JSON object (root must be an object, never an array) that matches the schema. No markdown. No prose.",
              },
              {
                role: "user",
                content:
                  attempt === 1
                    ? params.prompt
                    : `${params.prompt}\n\nIMPORTANT: previous output was invalid. Return ONLY one complete valid JSON object that matches the schema exactly. Root must be an object with required keys. Do not use alternate keys.`,
              },
            ],
            temperature: 0,
            max_tokens: maxTokens,
            response_format: {
              type: "json_object",
            },
          },
          proxySource
            ? {
                headers: {
                  "x-proxy-source": proxySource,
                },
              }
            : undefined
        );

        const parsedResponse = parseProviderChatCompletionResponse(response);
        const completion = parsedResponse.completion;
        const finishReasonRaw = completion.choices?.[0]?.finish_reason;
        const finishReason =
          typeof finishReasonRaw === "string" && finishReasonRaw.trim().length > 0 ? finishReasonRaw.trim() : null;
        const usage = parseTokenUsage(parsedResponse.usageRaw);

        const raw = String(completion.choices?.[0]?.message?.content || "").trim();
        if (!raw) {
          throw new ExtractionStructuredOutputError({
            message: `${params.phase} empty response (finish_reason=${finishReason || "unknown"})`,
            phase: params.phase,
            provider,
            model,
            attempt,
            finishReason,
            usage,
            rawResponse: raw,
          });
        }

        const jsonCandidate = extractJsonCandidate(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonCandidate);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ExtractionStructuredOutputError({
            message,
            phase: params.phase,
            provider,
            model,
            attempt,
            finishReason,
            usage,
            rawResponse: raw,
            jsonCandidate,
          });
        }

        let result: T;
        try {
          result = params.schema.parse(parsed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ExtractionStructuredOutputError({
            message,
            phase: params.phase,
            provider,
            model,
            attempt,
            finishReason,
            usage,
            rawResponse: raw,
            jsonCandidate,
          });
        }
        const completedAtMs = Date.now();
        const latencyMs = Math.max(0, completedAtMs - attemptStartedAtMs);
        const startedAt = new Date(attemptStartedAtMs).toISOString();
        const completedAt = new Date(completedAtMs).toISOString();

        logger.info(
          {
            phase: params.phase,
            provider,
            model,
            attempt,
            finishReason,
            promptTokens: usage?.promptTokens ?? null,
            completionTokens: usage?.completionTokens ?? null,
            totalTokens: usage?.totalTokens ?? null,
            latencyMs,
            startedAt,
            completedAt,
          },
          "LLM strict-json call completed"
        );

        return {
          result,
          meta: {
            provider,
            model,
            attempt,
            finishReason,
            usage,
            startedAt,
            completedAt,
            latencyMs,
          },
          debug: {
            prompt: params.prompt,
            rawResponse: raw,
            jsonCandidate,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const completedAtMs = Date.now();
        const latencyMs = Math.max(0, completedAtMs - attemptStartedAtMs);
        const structured = error instanceof ExtractionStructuredOutputError ? error : null;
        logger.warn(
          {
            phase: params.phase,
            provider,
            model,
            attempt,
            latencyMs,
            finishReason: structured?.finishReason ?? null,
            promptTokens: structured?.usage?.promptTokens ?? null,
            completionTokens: structured?.usage?.completionTokens ?? null,
            totalTokens: structured?.usage?.totalTokens ?? null,
            error: lastError.message,
          },
          "LLM strict-json call attempt failed"
        );
      }
    }
  }

  throw lastError || new Error(`${params.phase} failed`);
}

function buildKnownEntitiesLiteral(knownEntities: KnownEntityForPrompt[]): string {
  if (!knownEntities.length) return "[]";
  return JSON.stringify(
    knownEntities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      canonicalName: entity.canonicalName,
      normalizedName: entity.normalizedName,
      aliases: entity.aliases,
    }))
  );
}

function limitKnownEntitiesForPrompt(knownEntities: KnownEntityForPrompt[]): KnownEntityForPrompt[] {
  if (!knownEntities.length) return [];

  const entitiesCap = workerConfig.pipeline.entityPassKnownEntitiesCap;
  const aliasesCap = workerConfig.pipeline.entityPassKnownAliasesPerEntity;

  return knownEntities.slice(0, entitiesCap).map((entity) => ({
    ...entity,
    aliases: entity.aliases.slice(0, aliasesCap),
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function collapseWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function normalizeSummary(rawSummary: unknown): string {
  const explicit = asString(rawSummary);
  if (!explicit) return "";
  return truncateText(collapseWhitespace(explicit), 500);
}

function normalizeEntityType(rawType: unknown, fallback: EntityType): EntityType {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "character" || value === "location" || value === "event") return value;
  if (
    value.includes("char") ||
    value.includes("person") ||
    value.includes("human") ||
    value.includes("геро") ||
    value.includes("персонаж")
  ) {
    return "character";
  }
  if (
    value.includes("loc") ||
    value.includes("place") ||
    value.includes("setting") ||
    value.includes("локац") ||
    value.includes("мест")
  ) {
    return "location";
  }
  if (
    value.includes("event") ||
    value.includes("incident") ||
    value.includes("action") ||
    value.includes("событ")
  ) {
    return "event";
  }
  return fallback;
}

function inferAliasTypeFromText(alias: string): AliasType {
  const raw = String(alias || "").trim();
  if (!raw) return "name";
  const normalized = raw.toLowerCase();
  if (/^(он|она|они|его|ее|её|их|ему|ей|им|ним|не[йё])$/u.test(normalized)) return "descriptor";
  if (raw.includes("\"") || raw.includes("«") || raw.includes("»")) return "nickname";
  if (/\b(мистер|мисс|господин|госпожа|капитан|доктор|профессор|сэр|леди|князь|граф|барон)\b/iu.test(raw)) {
    return "title";
  }
  if (raw.split(/\s+/u).length >= 3) return "name";
  if (/^[a-zа-яё\-]+$/iu.test(raw) && raw.length <= 24) return "nickname";
  if (/\b(директор|хозяйка|старик|рыбак|охранник|врач|учитель|командир)\b/iu.test(raw)) return "descriptor";
  return "name";
}

function normalizeAliasType(value: unknown, fallbackAlias: string): AliasType {
  const parsed = AliasTypeSchema.safeParse(String(value || "").trim().toLowerCase());
  if (parsed.success) return parsed.data;
  return inferAliasTypeFromText(fallbackAlias);
}

function normalizeAliases(rawValue: unknown, canonicalName: string) {
  const out: Array<{
    alias: string;
    normalizedAlias: string;
    aliasType: AliasType;
    observed: boolean;
    confidence: number;
  }> = [];
  const seen = new Set<string>();

  const pushAlias = (aliasRaw: unknown, aliasTypeRaw: unknown, observed: boolean, confidenceRaw: unknown) => {
    const alias = asString(aliasRaw);
    if (!alias) return;
    const normalizedAlias = normalizeEntityName(alias);
    if (!normalizedAlias) return;
    if (seen.has(normalizedAlias)) return;
    seen.add(normalizedAlias);
    out.push({
      alias,
      normalizedAlias,
      aliasType: normalizeAliasType(aliasTypeRaw, alias),
      observed,
      confidence: clamp01(asOptionalNumber(confidenceRaw) ?? 0.75),
    });
  };

  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (typeof item === "string") {
        pushAlias(item, null, true, 0.75);
        continue;
      }

      const record = asRecord(item);
      if (!record) continue;
      pushAlias(
        record.alias ?? record.name ?? record.text ?? record.value,
        record.aliasType ?? record.type,
        Boolean(record.observed ?? true),
        record.confidence
      );
    }
  } else if (typeof rawValue === "string") {
    pushAlias(rawValue, null, true, 0.75);
  }

  pushAlias(canonicalName, "name", true, 1);
  return out.slice(0, 24);
}

function normalizeEvidence(rawValue: unknown, fallbackSnippetId: string) {
  const out: Array<{ snippetId: string; quote: string }> = [];

  const pushEvidence = (snippetIdRaw: unknown, quoteRaw: unknown) => {
    const quote = asString(quoteRaw);
    if (!quote) return;
    const snippetId = asString(snippetIdRaw) || fallbackSnippetId;
    out.push({
      snippetId,
      quote,
    });
  };

  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (typeof item === "string") {
        pushEvidence(fallbackSnippetId, item);
        continue;
      }
      const record = asRecord(item);
      if (!record) continue;
      pushEvidence(record.snippetId ?? record.snippet, record.quote ?? record.text ?? record.value);
    }
  } else if (typeof rawValue === "string") {
    pushEvidence(fallbackSnippetId, rawValue);
  }

  return out.slice(0, 12);
}

function normalizeEntityPassPayload(raw: unknown, input: EntityPassInput): EntityPassResult {
  const rootRecord = asRecord(raw);
  const rootArray = Array.isArray(raw) ? raw : null;
  const root = rootRecord || {};

  const entityInputs: Array<{ item: unknown; fallbackType: EntityType }> = [];
  const appendItems = (value: unknown, fallbackType: EntityType) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      entityInputs.push({ item, fallbackType });
    }
  };

  appendItems(root.entities, "character");
  appendItems(root.characters, "character");
  appendItems(root.locations, "location");
  appendItems(root.events, "event");
  appendItems(root.incidents, "event");
  appendItems(root.actions, "event");
  appendItems((root as Record<string, unknown>)["персонажи"], "character");
  appendItems((root as Record<string, unknown>)["локации"], "location");
  appendItems((root as Record<string, unknown>)["события"], "event");
  appendItems(root.data, "character");
  appendItems(root.items, "character");
  appendItems(rootArray, "character");

  const normalizedEntities: EntityPassResult["entities"] = [];

  for (let index = 0; index < entityInputs.length; index += 1) {
    const source = entityInputs[index];
    const item = asRecord(source.item);
    if (!item) continue;

    const canonicalName =
      asString(item.canonicalName) ||
      asString(item.name) ||
      asString(item.entityName) ||
      asString(item.title) ||
      asString(item.label);
    if (!canonicalName) continue;

    const normalizedName = asString(item.normalizedName) || normalizeEntityName(canonicalName);
    if (!normalizedName) continue;

    const tempEntityId = asString(item.tempEntityId) || asString(item.entityId) || asString(item.id) || `tmp:${index + 1}`;
    const type = normalizeEntityType(item.type, source.fallbackType);
    const resolution = asRecord(item.resolution);
    const existingEntityId =
      asString(resolution?.existingEntityId) ||
      asString(resolution?.entityId) ||
      asString(item.existingEntityId) ||
      null;
    const resolutionActionRaw = asString(resolution?.action);
    const resolutionAction =
      resolutionActionRaw === "link_existing" || (resolutionActionRaw === "link" && existingEntityId)
        ? "link_existing"
        : existingEntityId
          ? "link_existing"
          : "create_new";

    const fallbackSnippetId = asString(item.snippetId) || "snip:0";
    const evidence = normalizeEvidence(item.evidence ?? item.quotes ?? item.quote, fallbackSnippetId);
    const summaryCandidate = asString(item.summary) || asString(item.description) || asString(item.bio) || asString(item.blurb);
    const summary = normalizeSummary(summaryCandidate);

    normalizedEntities.push({
      tempEntityId,
      type,
      canonicalName,
      normalizedName,
      summary,
      resolution: {
        action: resolutionAction,
        existingEntityId: existingEntityId || null,
      },
      aliases: normalizeAliases(item.aliases ?? item.alias, canonicalName),
      evidence,
    });
  }

  const deduped = new Map<string, EntityPassResult["entities"][number]>();
  for (const entity of normalizedEntities) {
    const key = `${entity.type}:${entity.normalizedName}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, entity);
      continue;
    }

    const mergedAliases = [...existing.aliases, ...entity.aliases];
    const aliasSeen = new Set<string>();
    existing.aliases = mergedAliases.filter((alias) => {
      const keyAlias = alias.normalizedAlias;
      if (aliasSeen.has(keyAlias)) return false;
      aliasSeen.add(keyAlias);
      return true;
    });

    if (!existing.summary && entity.summary) {
      existing.summary = entity.summary;
    }

    if (existing.resolution.action !== "link_existing" && entity.resolution.action === "link_existing") {
      existing.resolution = entity.resolution;
    }

    existing.evidence = [...existing.evidence, ...entity.evidence].slice(0, 12);
  }

  const parsedContentVersion = asOptionalNumber(root.contentVersion);
  const contentVersion =
    parsedContentVersion !== null && Number.isInteger(parsedContentVersion) && parsedContentVersion >= 0
      ? parsedContentVersion
      : input.contentVersion;

  return {
    contentVersion,
    entities: Array.from(deduped.values()).slice(0, 256),
  };
}

export async function runEntityPass(
  input: EntityPassInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<EntityPassResult>> {
  const knownEntities = limitKnownEntitiesForPrompt(input.knownEntities);
  const prompt = [
    "You are extracting canonical entities and observed aliases from Russian fiction text.",
    "",
    "Your task is to construct an accurate entity registry strictly grounded in the provided text.",
    "",
    "=====================",
    "CORE PRINCIPLES",
    "=====================",
    "",
    "- Treat identity as a strict condition that must be proven, not assumed.",
    "- Only rely on explicit evidence in the snippets.",
    "- When uncertain, prefer creating separate entities over merging.",
    "- False merges are more harmful than duplicate entities.",
    "",
    "=====================",
    "IDENTITY RULE",
    "=====================",
    "",
    "Two references must be treated as the same entity ONLY if the snippets explicitly prove they refer to the same individual.",
    "",
    "If identity is not clearly proven, they must be treated as different entities.",
    "",
    "Do NOT infer identity based on:",
    "- shared surname",
    "- co-occurrence in the same context",
    "- semantic similarity",
    "- narrative assumptions",
    "- frequency or prominence",
    "",
    "=====================",
    "ALIAS RULES",
    "=====================",
    "",
    "An alias is valid ONLY if:",
    "",
    "1) It is explicitly observed in the snippets",
    "2) It clearly refers to the same individual",
    "3) There is no ambiguity with other possible individuals",
    "",
    "If a surface form could plausibly refer to more than one individual, it must be treated as ambiguous and MUST NOT be assigned as an alias.",
    "",
    "Do NOT assign aliases based on:",
    "- similarity to the canonical name",
    "- partial matches",
    "- inferred relationships",
    "- contextual guessing",
    "",
    "=====================",
    "AMBIGUITY HANDLING",
    "=====================",
    "",
    "If a surface form:",
    "- could refer to multiple individuals",
    "- or lacks clear grounding in the snippets",
    "",
    "Then:",
    "- do NOT assign it as an alias",
    "- do NOT merge entities based on it",
    "",
    "=====================",
    "MERGING RULES",
    "=====================",
    "",
    "Merge references ONLY when identity is explicitly established in the text.",
    "",
    "If there is any doubt:",
    "- do NOT merge",
    "- create separate entities",
    "",
    "Do NOT optimize for fewer entities.",
    "",
    "=====================",
    "RESOLUTION RULES",
    "=====================",
    "",
    "Use resolution.action=link_existing ONLY when identity is certain.",
    "",
    "If identity is uncertain:",
    "- create a new entity",
    "",
    "=====================",
    "ALIAS TYPES",
    "=====================",
    "",
    "Allowed aliases include:",
    "- exact name variants",
    "- short forms",
    "- nicknames or epithets explicitly used in the text",
    "- titles or roles explicitly referring to the same individual",
    "",
    "All aliases must be grounded in snippets and unambiguous.",
    "",
    "=====================",
    "SUMMARY RULE",
    "=====================",
    "",
    "Each entity must include a summary:",
    "- one concise factual sentence in Russian",
    "- maximum 180 characters",
    "- strictly based on snippet content",
    "- no speculation",
    "",
    "=====================",
    "EVENT EXTRACTION",
    "=====================",
    "",
    "Extract events ONLY if:",
    "- there is a clearly described action or incident",
    "- it is explicitly present in the snippets",
    "",
    "=====================",
    "OUTPUT RULES",
    "=====================",
    "",
    "Return a strict JSON object matching the schema.",
    "",
    "aliases must be objects:",
    "{alias, normalizedAlias, aliasType, observed, confidence}",
    "",
    "Each entity must include:",
    "- tempEntityId",
    "- type",
    "- canonicalName",
    "- normalizedName",
    "- resolution",
    "- aliases",
    "- evidence",
    "- summary",
    "",
    "Do NOT output entityId for new entities.",
    "",
    "Do NOT include offsets or spans.",
    "",
    "=====================",
    "INPUT",
    "=====================",
    "",
    `contentVersion: ${input.contentVersion}`,
    `knownEntities: ${buildKnownEntitiesLiteral(knownEntities)}`,
    `candidates: ${JSON.stringify(input.prepass.candidates)}`,
    `snippets: ${JSON.stringify(input.prepass.snippets)}`,
    `chunks: ${JSON.stringify(input.prepass.chunks || [])}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "entity_pass",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeEntityPassPayload(raw.result, input);
  return {
    result: EntityPassResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

const CharacterBookPassCanonicalizationResultSchema = z.object({
  groups: z
    .array(
      z.object({
        canonicalEntityId: z.string().min(1),
        memberEntityIds: z.array(z.string().min(1)).min(1),
        confidence: z.number().min(0).max(1),
        rationale: z.string().default(""),
      })
    )
    .default([]),
});

function normalizeCharacterBookPassPayload(
  raw: unknown,
  input: CharacterBookPassCanonicalizationInput
): CharacterBookPassCanonicalizationResult {
  const root = asRecord(raw) || {};
  const groupsRaw = Array.isArray(root.groups) ? root.groups : [];
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity] as const));

  const selectBestCanonicalId = (ids: string[]): string => {
    let bestId = ids[0];
    let bestMentionCount = -1;
    let bestNameLength = -1;

    for (const id of ids) {
      const entity = entityById.get(id);
      if (!entity) continue;

      if (
        entity.mentionCount > bestMentionCount ||
        (entity.mentionCount === bestMentionCount && entity.canonicalName.length > bestNameLength)
      ) {
        bestId = id;
        bestMentionCount = entity.mentionCount;
        bestNameLength = entity.canonicalName.length;
      }
    }

    return bestId;
  };

  const groups: CharacterBookPassCanonicalizationResult["groups"] = [];
  const seenGroupKeys = new Set<string>();

  for (const rawGroup of groupsRaw) {
    const record = asRecord(rawGroup);
    if (!record) continue;

    const rawIds = Array.isArray(record.memberEntityIds)
      ? record.memberEntityIds
      : Array.isArray(record.memberIds)
        ? record.memberIds
        : Array.isArray(record.entities)
          ? record.entities
          : [];

    const validIds = Array.from(
      new Set(
        rawIds
          .map((value) => asString(value))
          .filter((value): value is string => Boolean(value && entityById.has(value)))
      )
    );
    if (!validIds.length) continue;

    const canonicalCandidate =
      asString(record.canonicalEntityId) ||
      asString(record.canonicalId) ||
      asString(record.targetEntityId) ||
      null;
    const canonicalEntityId =
      canonicalCandidate && entityById.has(canonicalCandidate) ? canonicalCandidate : selectBestCanonicalId(validIds);
    if (!validIds.includes(canonicalEntityId)) {
      validIds.unshift(canonicalEntityId);
    }

    const groupKey = [...validIds].sort().join("::");
    if (!groupKey || seenGroupKeys.has(groupKey)) continue;
    seenGroupKeys.add(groupKey);

    groups.push({
      canonicalEntityId,
      memberEntityIds: validIds,
      confidence: clamp01(asOptionalNumber(record.confidence) ?? 0),
      rationale: truncateText(collapseWhitespace(asString(record.rationale) || asString(record.reason) || ""), 400),
    });
  }

  return {
    groups,
  };
}

const CharacterProfileSynthesisResultSchema = z.object({
  profiles: z
    .array(
      z.object({
        characterId: z.string().min(1),
        shortDescription: z.string().default(""),
      })
    )
    .default([]),
});

function normalizeCharacterProfileSynthesisPayload(
  raw: unknown,
  input: CharacterProfileSynthesisInput
): CharacterProfileSynthesisResult {
  const rootRecord = asRecord(raw);
  const rootArray = Array.isArray(raw) ? raw : null;
  const root = rootRecord || {};

  const profileInputs: unknown[] = [];
  const appendItems = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) profileInputs.push(item);
  };

  appendItems(root.profiles);
  appendItems(root.characters);
  appendItems(root.items);
  appendItems(root.data);
  appendItems(rootArray);

  const validIds = new Set(input.characters.map((character) => character.id));
  const byCharacterId = new Map<string, { characterId: string; shortDescription: string }>();

  for (const item of profileInputs) {
    const record = asRecord(item);
    if (!record) continue;

    const characterId =
      asString(record.characterId) || asString(record.entityId) || asString(record.id) || asString(record.targetEntityId);
    if (!characterId || !validIds.has(characterId)) continue;

    const descriptionRaw =
      asString(record.shortDescription) || asString(record.summary) || asString(record.description) || asString(record.profile) || "";
    const shortDescription = truncateText(collapseWhitespace(descriptionRaw), 180);
    if (!shortDescription) continue;

    const existing = byCharacterId.get(characterId);
    if (!existing || shortDescription.length > existing.shortDescription.length) {
      byCharacterId.set(characterId, {
        characterId,
        shortDescription,
      });
    }
  }

  return {
    profiles: Array.from(byCharacterId.values()),
  };
}

export async function runCharacterBookPassCanonicalization(
  input: CharacterBookPassCanonicalizationInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<CharacterBookPassCanonicalizationResult>> {
  const entities = input.entities.map((entity) => ({
    id: entity.id,
    canonicalName: entity.canonicalName,
    normalizedName: entity.normalizedName,
    mentionCount: entity.mentionCount,
    aliases: entity.aliases.slice(0, 20).map((alias) => ({
      alias: alias.alias,
      aliasType: alias.aliasType,
    })),
  }));

  const prompt = [
    "You are canonicalizing character entities for one complete fiction book.",
    "",
    "Task: return canonical merge groups for entities that refer to exactly the same person.",
    "",
    "Critical rules:",
    "1) Prefer KEEPING entities separate when uncertain.",
    "2) False merges are more harmful than duplicates.",
    "3) Shared surname alone is NOT enough.",
    "4) Shared short name alone is NOT enough.",
    "5) Merge only when identity is strongly supported by canonical names and aliases.",
    "",
    "Output format:",
    'Return strict JSON object: {"groups":[...]}',
    "Each group item must contain:",
    "- canonicalEntityId: string (one of provided IDs)",
    "- memberEntityIds: string[] (subset of provided IDs, can contain one item)",
    "- confidence: number [0..1]",
    "- rationale: short factual reason",
    "",
    "Do NOT invent IDs.",
    "Do NOT include text spans or offsets.",
    "",
    "Input entities:",
    JSON.stringify(entities),
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "character_book_pass",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeCharacterBookPassPayload(raw.result, input);
  return {
    result: CharacterBookPassCanonicalizationResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runCharacterProfileSynthesis(
  input: CharacterProfileSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<CharacterProfileSynthesisResult>> {
  const characters = input.characters.map((character) => ({
    id: character.id,
    canonicalName: character.canonicalName,
    mentionCount: character.mentionCount,
    aliases: character.aliases.slice(0, 16),
    chapterSummaries: character.chapterSummaries.slice(0, 12).map((item) => ({
      chapterId: item.chapterId,
      summary: truncateText(collapseWhitespace(item.summary), 180),
    })),
    evidence: character.evidence.slice(0, 8).map((item) => ({
      chapterId: item.chapterId,
      mentionType: item.mentionType,
      sourceText: truncateText(item.sourceText, 80),
      context: truncateText(item.context, 280),
      confidence: clamp01(item.confidence),
    })),
  }));

  const prompt = [
    "You are synthesizing stable character descriptions for one complete fiction book.",
    "",
    "Task: write exactly one concise sentence in Russian for each character.",
    "Use chapter-level summaries from entity_pass as the primary source.",
    "Use evidence snippets only as fallback when chapter summaries are missing.",
    "",
    "Hard rules:",
    "1) Use only facts grounded in provided chapter summaries and fallback evidence.",
    "2) Keep only stable identity-level facts: who this character is in the story.",
    "3) Prefer facts repeated or consistent across multiple chapter summaries/evidence snippets.",
    "4) Avoid episodic/random details.",
    "5) Do NOT list artifacts unless they define the character identity.",
    "6) No speculation, no hidden motives, no spoilers outside evidence.",
    "7) Max 180 characters per description.",
    "",
    "Output format:",
    'Return strict JSON object: {"profiles":[...]}',
    "Each profile item must contain:",
    "- characterId: string (one of provided IDs)",
    "- shortDescription: string (one sentence in Russian, max 180 chars)",
    "",
    "Do NOT invent IDs.",
    "",
    "Input characters:",
    JSON.stringify(characters),
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "character_profile",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeCharacterProfileSynthesisPayload(raw.result, input);
  return {
    result: CharacterProfileSynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

const CharacterMergeArbiterResultSchema = z.object({
  pairId: z.string(),
  decision: z.enum(["merge", "keep_separate", "unresolved"]),
  confidence: z.number().min(0).max(1),
  preferredEntity: z.enum(["left", "right", "none"]),
  rationale: z.string(),
});

function normalizeMergeArbiterDecision(rawValue: unknown): CharacterMergeArbiterResult["decision"] {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (["merge", "same", "same_entity", "same_person", "same_character", "link", "link_existing"].includes(raw)) {
    return "merge";
  }
  if (["keep_separate", "separate", "different", "different_entity", "different_person"].includes(raw)) {
    return "keep_separate";
  }
  return "unresolved";
}

function normalizeMergeArbiterPreferredEntity(rawValue: unknown): CharacterMergeArbiterResult["preferredEntity"] {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (["left", "a", "entity_a", "first"].includes(raw)) return "left";
  if (["right", "b", "entity_b", "second"].includes(raw)) return "right";
  return "none";
}

function normalizeCharacterMergeArbiterPayload(
  raw: unknown,
  input: CharacterMergeArbiterInput
): CharacterMergeArbiterResult {
  const root = asRecord(raw) || {};
  const confidence = clamp01(asOptionalNumber(root.confidence ?? root.score ?? root.probability) ?? 0);
  const rationale = truncateText(collapseWhitespace(asString(root.rationale) || asString(root.reason) || ""), 400);
  return {
    pairId: asString(root.pairId) || input.pairId,
    decision: normalizeMergeArbiterDecision(root.decision ?? root.action ?? root.verdict),
    confidence,
    preferredEntity: normalizeMergeArbiterPreferredEntity(
      root.preferredEntity ?? root.preferredCanonical ?? root.canonicalChoice
    ),
    rationale,
  };
}

export async function runCharacterMergeArbiter(
  input: CharacterMergeArbiterInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<CharacterMergeArbiterResult>> {
  const compactEntity = (entity: CharacterMergeArbiterEntityInput) => ({
    id: entity.id,
    canonicalName: entity.canonicalName,
    normalizedName: entity.normalizedName,
    mentionCount: entity.mentionCount,
    aliases: entity.aliases.slice(0, 20).map((alias) => ({
      alias: alias.alias,
      aliasType: alias.aliasType,
    })),
    evidence: entity.evidence.slice(0, 8).map((item) => ({
      chapterId: item.chapterId,
      sourceText: truncateText(item.sourceText, 64),
      context: truncateText(item.context, 280),
    })),
  });

  const payload = {
    pairId: input.pairId,
    sharedAliases: input.sharedAliases.slice(0, 24),
    leftEntity: compactEntity(input.leftEntity),
    rightEntity: compactEntity(input.rightEntity),
  };

  const prompt = [
    "You are a strict identity arbiter for Russian fiction character records.",
    "",
    "Task: decide whether LEFT and RIGHT represent the same individual.",
    "",
    "Rules:",
    "1) Merge ONLY if identity is clearly supported by evidence snippets.",
    "2) Shared surname alone is NOT enough.",
    "3) Shared short alias (e.g., first name) alone is NOT enough.",
    "4) Orthographic spelling variants are allowed only when evidence strongly points to one person.",
    "5) If uncertain, return keep_separate or unresolved (prefer not merging).",
    "",
    "Return strict JSON object with keys:",
    "- pairId",
    "- decision: merge | keep_separate | unresolved",
    "- confidence: number in [0,1]",
    "- preferredEntity: left | right | none",
    "- rationale: short factual reason",
    "",
    `input: ${JSON.stringify(payload)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "character_merge_arbiter",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeCharacterMergeArbiterPayload(raw.result, input);
  return {
    result: CharacterMergeArbiterResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runPatchCompletion(
  input: PatchCompletionInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<PatchWindowsResult>> {
  const requiredShapeExample = JSON.stringify(
    {
      runId: input.runId,
      contentVersion: input.contentVersion,
      windows: [
        {
          windowKey: "w:1",
          ops: [
            {
              op: "reject_candidate",
              candidateId: "<candidate-id>",
              entityId: null,
              confidence: 0.2,
            },
          ],
        },
      ],
    },
    null,
    2
  );

  const prompt = [
    "You are deciding ambiguous mention candidates.",
    "Rules:",
    "1) You MAY operate only on provided candidateId values.",
    "2) NEVER output offsets or free-form spans.",
    "3) Prefer reject_candidate when uncertain.",
    "4) Use link_candidate for known entities.",
    "5) create_entity_and_link is allowed only for clearly explicit mentions.",
    "6) Return strict JSON object matching schema.",
    "7) Root MUST be an object with keys: runId, contentVersion, windows.",
    "8) Every decision MUST be in windows[].ops[] with key 'op' (not 'action').",
    "9) Do NOT return top-level arrays.",
    "10) Do NOT use alternate keys: decisions, link_candidates, reject_candidates, link_candidate, reject_candidate.",
    "11) Keep runId/contentVersion exactly equal to provided values.",
    "12) For each op include confidence [0..1].",
    "13) If uncertain about a candidate, use op=reject_candidate with low confidence.",
    "",
    "Required output shape example (values are illustrative):",
    requiredShapeExample,
    "",
    `runId: ${input.runId}`,
    `contentVersion: ${input.contentVersion}`,
    `entities: ${JSON.stringify(input.entities)}`,
    `windows: ${JSON.stringify(input.windows)}`,
  ].join("\n");

  return callStrictJson<PatchWindowsResult>({
    prompt,
    schema: PatchWindowsResultSchema,
    phase: "mention_completion",
    timewebModelId: options?.timewebModelId || null,
  });
}
