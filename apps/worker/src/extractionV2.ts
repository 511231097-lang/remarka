import { z } from "zod";
import {
  EntityPassResultSchema,
  PatchWindowsResultSchema,
  normalizeEntityName,
  type EntityPassResult,
  type EntityType,
  type PatchWindowsResult,
  type PrepassResult,
} from "@remarka/contracts";
import { createKiaClient } from "./kiaClient";
import { createTimewebClient } from "./timewebClient";
import { workerConfig } from "./config";

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

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StrictJsonCallMeta {
  provider: "kia" | "timeweb";
  model: string;
  attempt: number;
  finishReason: string | null;
  usage: LlmTokenUsage | null;
}

interface StrictJsonCallResult<T> {
  result: T;
  meta: StrictJsonCallMeta;
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

  const start = trimmed.indexOf("{");
  if (start < 0) return trimmed;

  let depth = 0;
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

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1).trim();
      }
    }
  }

  return trimmed;
}

async function callStrictJson<T>(params: {
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  phase: "entity_pass" | "mention_completion";
}): Promise<StrictJsonCallResult<T>> {
  const useKiaProvider = workerConfig.extraction.provider === "kia";
  const client = useKiaProvider ? createKiaClient() : createTimewebClient();
  const modelCandidates = Array.from(
    new Set(
      [
        useKiaProvider ? workerConfig.kia.extractModel : workerConfig.timeweb.extractModel,
        useKiaProvider ? workerConfig.kia.extractFallbackModel : workerConfig.timeweb.extractFallbackModel,
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
  const maxAttempts = Math.max(1, useKiaProvider ? workerConfig.kia.extractAttempts : workerConfig.timeweb.extractAttempts);
  const maxTokens = useKiaProvider ? workerConfig.kia.extractMaxTokens : workerConfig.timeweb.extractMaxTokens;
  const proxySource = useKiaProvider ? workerConfig.kia.proxySource : workerConfig.timeweb.proxySource;

  let lastError: Error | null = null;

  for (const model of modelCandidates) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON extractor. Return exactly one JSON object that matches the schema. No markdown.",
              },
              {
                role: "user",
                content:
                  attempt === 1
                    ? params.prompt
                    : `${params.prompt}\n\nIMPORTANT: previous output was invalid. Return ONLY one complete valid JSON object.`,
              },
            ],
            temperature: 0,
            max_tokens: maxTokens,
            response_format: {
              type: "json_object",
            },
          },
          {
            headers: {
              "x-proxy-source": proxySource,
            },
          }
        );

        const parsedResponse = parseProviderChatCompletionResponse(response);
        const completion = parsedResponse.completion;
        const finishReasonRaw = completion.choices?.[0]?.finish_reason;
        const finishReason =
          typeof finishReasonRaw === "string" && finishReasonRaw.trim().length > 0 ? finishReasonRaw.trim() : null;
        const usage = parseTokenUsage(parsedResponse.usageRaw);

        const raw = String(completion.choices?.[0]?.message?.content || "").trim();
        if (!raw) {
          throw new Error(`${params.phase} empty response (finish_reason=${finishReason || "unknown"})`);
        }

        const jsonCandidate = extractJsonCandidate(raw);
        const parsed = JSON.parse(jsonCandidate);
        return {
          result: params.schema.parse(parsed),
          meta: {
            provider: useKiaProvider ? "kia" : "timeweb",
            model,
            attempt,
            finishReason,
            usage,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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

function normalizeEntityType(rawType: unknown, fallback: EntityType): EntityType {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "character" || value === "location" || value === "event") return value;
  if (value.includes("loc")) return "location";
  if (value.includes("event")) return "event";
  if (value.includes("char")) return "character";
  return fallback;
}

function normalizeAliases(rawValue: unknown, canonicalName: string) {
  const out: Array<{ alias: string; normalizedAlias: string; observed: boolean; confidence: number }> = [];
  const seen = new Set<string>();

  const pushAlias = (aliasRaw: unknown, observed: boolean, confidenceRaw: unknown) => {
    const alias = asString(aliasRaw);
    if (!alias) return;
    const normalizedAlias = normalizeEntityName(alias);
    if (!normalizedAlias) return;
    if (seen.has(normalizedAlias)) return;
    seen.add(normalizedAlias);
    out.push({
      alias,
      normalizedAlias,
      observed,
      confidence: clamp01(asOptionalNumber(confidenceRaw) ?? 0.75),
    });
  };

  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (typeof item === "string") {
        pushAlias(item, true, 0.75);
        continue;
      }

      const record = asRecord(item);
      if (!record) continue;
      pushAlias(record.alias ?? record.name ?? record.text ?? record.value, Boolean(record.observed ?? true), record.confidence);
    }
  } else if (typeof rawValue === "string") {
    pushAlias(rawValue, true, 0.75);
  }

  pushAlias(canonicalName, true, 1);
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
  const root = asRecord(raw) || {};

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

    normalizedEntities.push({
      tempEntityId,
      type,
      canonicalName,
      normalizedName,
      summary: asString(item.summary) || "",
      resolution: {
        action: resolutionAction,
        existingEntityId: existingEntityId || null,
      },
      aliases: normalizeAliases(item.aliases ?? item.alias, canonicalName),
      evidence: normalizeEvidence(item.evidence ?? item.quotes ?? item.quote, fallbackSnippetId),
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

export async function runEntityPass(input: EntityPassInput): Promise<StrictJsonCallResult<EntityPassResult>> {
  const knownEntities = limitKnownEntitiesForPrompt(input.knownEntities);
  const prompt = [
    "You are extracting canonical entities and observed aliases from Russian fiction text.",
    "Rules:",
    "1) Return entities+aliases only for provided candidates/snippets.",
    "2) Do not return offsets/spans.",
    "3) Use resolution.action=link_existing only when sure and provide existingEntityId.",
    "4) aliases must be observed in snippets.",
    "5) Return strict JSON object matching schema.",
    "6) aliases must be objects: {alias, normalizedAlias, observed, confidence}.",
    "7) Every entity must include: tempEntityId, type, canonicalName, normalizedName, resolution, aliases, evidence.",
    "8) Do NOT output entityId field for new entities.",
    "",
    `contentVersion: ${input.contentVersion}`,
    `knownEntities: ${buildKnownEntitiesLiteral(knownEntities)}`,
    `candidates: ${JSON.stringify(input.prepass.candidates)}`,
    `snippets: ${JSON.stringify(input.prepass.snippets)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "entity_pass",
  });

  const normalized = normalizeEntityPassPayload(raw.result, input);
  return {
    result: EntityPassResultSchema.parse(normalized),
    meta: raw.meta,
  };
}

export async function runPatchCompletion(input: PatchCompletionInput): Promise<StrictJsonCallResult<PatchWindowsResult>> {
  const prompt = [
    "You are deciding ambiguous mention candidates.",
    "Rules:",
    "1) You MAY operate only on provided candidateId values.",
    "2) NEVER output offsets or free-form spans.",
    "3) Prefer reject_candidate when uncertain.",
    "4) Use link_candidate for known entities.",
    "5) create_entity_and_link is allowed only for clearly explicit mentions.",
    "6) Return strict JSON object matching schema.",
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
  });
}
