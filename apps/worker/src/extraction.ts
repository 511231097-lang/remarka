import { z } from "zod";
import {
  ExtractionAnnotationSchema,
  ExtractionEntitySchema,
  ExtractionLocationContainmentSchema,
  ExtractionMentionSchema,
  canonicalizeDocumentContent,
  normalizeEntityName,
  splitParagraphs,
  type EntityType,
  type ExtractionEntity,
  type ExtractionResult,
} from "@remarka/contracts";
import { createTimewebClient } from "./timewebClient";
import { workerConfig } from "./config";

const DEFAULT_INCREMENTAL_BATCH_SIZE = 8;
const FULL_MENTIONS_BATCH_FALLBACK_MIN_PARAGRAPHS = 24;
const FICTION_CONTEXT_NOTE =
  "Контекст: это разбор художественного литературного произведения (fiction). " +
  "Текст может содержать описание преступлений, насилия или тяжелых событий как часть сюжета. " +
  "Нужно только извлечь структурированные сущности, без советов и инструкций.";

const ExtractionEntitiesResponseSchema = z.object({
  entities: z.array(ExtractionEntitySchema).default([]),
});

const ExtractionMentionsResponseSchema = z.object({
  mentions: z.array(ExtractionMentionSchema).default([]),
  annotations: z.array(ExtractionAnnotationSchema).default([]),
  locationContainments: z.array(ExtractionLocationContainmentSchema).default([]),
});

type ExtractionEntitiesResponse = z.infer<typeof ExtractionEntitiesResponseSchema>;
type ExtractionMentionsResponse = z.infer<typeof ExtractionMentionsResponseSchema>;

export interface KnownProjectEntity {
  entityRef: string;
  type: EntityType;
  name: string;
  summary: string;
  container?: {
    entityRef: string;
    name: string;
  };
}

interface IncrementalExtractionInput {
  content: string;
  changedParagraphIndices: number[];
  knownEntities: KnownProjectEntity[];
  batchSize?: number;
}

export interface ExtractionModelCallTrace {
  phase: "entities" | "mentions";
  extractionMode: "full" | "incremental";
  batchIndex: number | null;
  targetParagraphIndices: number[];
  model: string;
  prompt: string;
  rawResponse: string;
  jsonCandidate: string;
  normalizedPayload: unknown;
  parseError: string | null;
}

export type ExtractionTraceSink = (trace: ExtractionModelCallTrace) => Promise<void> | void;

interface NormalizeExtractionOptions {
  maxParagraph: number;
  allowedParagraphIndices?: Set<number>;
  requireMentionBackedEntities?: boolean;
}

interface EntityRegistryEntry {
  entityRef: string;
  type: EntityType;
  name: string;
  summary?: string;
  containerRef?: string;
  containerName?: string;
}

interface CallExtractorTraceContext {
  phase: "entities" | "mentions";
  extractionMode: "full" | "incremental";
  batchIndex?: number;
  targetParagraphIndices?: number[];
}

interface CallExtractorOptions<T> {
  prompt: string;
  schema: z.ZodTypeAny;
  traceSink?: ExtractionTraceSink;
  traceContext?: CallExtractorTraceContext;
}

interface RunExtractionOptions {
  traceSink?: ExtractionTraceSink;
}

function isExtractionJsonParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Extraction JSON parse error");
}

function extractJsonCandidate(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const getFirstJsonObject = (value: string): string | null => {
    const start = value.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < value.length; i += 1) {
      const char = value[i];

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
          return value.slice(start, i + 1).trim();
        }
      }
    }

    return null;
  };

  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1]?.trim() || "");
  for (const block of fencedBlocks) {
    const fromBlock = getFirstJsonObject(block);
    if (fromBlock) {
      return fromBlock;
    }
  }

  const fromText = getFirstJsonObject(trimmed);
  if (fromText) {
    return fromText;
  }

  return trimmed;
}

function normalizeEntityType(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value === "location_small" || value === "location_city" || value === "location_region") {
    return "location";
  }

  return value;
}

function keyByTypeAndName(type: string, name: string): string {
  return `${type}::${normalizeEntityName(name)}`;
}

function normalizeModelPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const source = payload as {
    entities?: Array<Record<string, unknown>>;
    mentions?: Array<Record<string, unknown>>;
    annotations?: Array<Record<string, unknown>>;
    locationContainments?: Array<Record<string, unknown>>;
  };

  const rawEntities = Array.isArray(source.entities) ? source.entities : [];
  const entities: Array<Record<string, unknown>> = [];
  const legacyContainmentHints: Array<{ childRef: string; parentType: string; parentName: string }> = [];

  for (const [index, entry] of rawEntities.entries()) {
    const type = normalizeEntityType(entry.type);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";

    if (!name) continue;

    const entityRefRaw = typeof entry.entityRef === "string" ? entry.entityRef.trim() : "";
    const entityRef = entityRefRaw || `e_${index + 1}`;

    entities.push({
      entityRef,
      type,
      name,
      summary,
    });

    const parentName = typeof entry.parentName === "string" ? entry.parentName.trim() : "";
    const parentType = normalizeEntityType(entry.parentType);
    if (type === "location" && parentType === "location" && parentName) {
      legacyContainmentHints.push({ childRef: entityRef, parentType, parentName });
    }
  }

  const keyToRef = new Map<string, string | null>();
  for (const entity of entities) {
    const key = keyByTypeAndName(String(entity.type || ""), String(entity.name || ""));
    const existing = keyToRef.get(key);

    if (!existing) {
      keyToRef.set(key, String(entity.entityRef));
      continue;
    }

    if (existing !== String(entity.entityRef)) {
      keyToRef.set(key, null);
    }
  }

  const resolveRefByTypeAndName = (type: string, name: string): string => {
    const key = keyByTypeAndName(type, name);
    const value = keyToRef.get(key);
    return value && value.length ? value : "";
  };

  const mentions = Array.isArray(source.mentions)
    ? source.mentions
        .map((entry, index) => {
          const type = normalizeEntityType(entry.type);
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          const mentionText = typeof entry.mentionText === "string" ? entry.mentionText.trim() : "";
          const paragraphIndexRaw = Number(entry.paragraphIndex);
          const paragraphIndex = Number.isInteger(paragraphIndexRaw) ? paragraphIndexRaw : 0;

          if (!name || !mentionText) return null;

          const providedRef = typeof entry.entityRef === "string" ? entry.entityRef.trim() : "";
          const inferredRef = resolveRefByTypeAndName(type, name);
          const entityRef = providedRef || inferredRef || `m_${index + 1}`;

          return {
            entityRef,
            type,
            name,
            paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : 0,
            mentionText,
          };
        })
        .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention))
    : [];

  const annotations = Array.isArray(source.annotations)
    ? source.annotations
        .map((entry, index) => {
          const type = normalizeEntityType(entry.type);
          const label = typeof entry.label === "string" ? entry.label.trim() : "";
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          const paragraphIndexRaw = Number(entry.paragraphIndex);
          const paragraphIndex = Number.isInteger(paragraphIndexRaw) ? paragraphIndexRaw : 0;

          if (!label) return null;

          const providedRef = typeof entry.entityRef === "string" ? entry.entityRef.trim() : "";
          const inferredRef = name ? resolveRefByTypeAndName(type, name) : "";
          const entityRef = providedRef || inferredRef || undefined;

          return {
            ...(entityRef ? { entityRef } : {}),
            paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : 0,
            type,
            label,
            ...(name ? { name } : {}),
          };
        })
        .filter((annotation): annotation is NonNullable<typeof annotation> => Boolean(annotation))
    : [];

  const locationContainments: Array<{ childRef: string; parentRef: string }> = [];

  if (Array.isArray(source.locationContainments)) {
    for (const entry of source.locationContainments) {
      const childRef =
        typeof entry.childRef === "string"
          ? entry.childRef.trim()
          : typeof entry.childEntityRef === "string"
            ? entry.childEntityRef.trim()
            : "";
      const parentRef =
        typeof entry.parentRef === "string"
          ? entry.parentRef.trim()
          : typeof entry.parentEntityRef === "string"
            ? entry.parentEntityRef.trim()
            : "";

      if (!childRef || !parentRef) continue;
      locationContainments.push({ childRef, parentRef });
    }
  }

  for (const hint of legacyContainmentHints) {
    const parentRef = resolveRefByTypeAndName(hint.parentType, hint.parentName);
    if (!parentRef) continue;

    locationContainments.push({
      childRef: hint.childRef,
      parentRef,
    });
  }

  return {
    entities,
    mentions,
    annotations,
    locationContainments,
  };
}

function dedupeEntityRegistry(entries: EntityRegistryEntry[]): EntityRegistryEntry[] {
  const byRef = new Map<string, EntityRegistryEntry>();

  for (const entry of entries) {
    const entityRef = entry.entityRef.trim();
    const name = entry.name.trim();
    if (!entityRef || !name) continue;

    const existing = byRef.get(entityRef);

    if (!existing) {
      byRef.set(entityRef, {
        entityRef,
        type: entry.type,
        name,
        summary: entry.summary?.trim() || undefined,
        containerRef: entry.containerRef?.trim() || undefined,
        containerName: entry.containerName?.trim() || undefined,
      });
      continue;
    }

    if (!existing.summary && entry.summary?.trim()) {
      existing.summary = entry.summary.trim();
    }

    if (name.length && name.length < existing.name.length) {
      existing.name = name;
    }

    if (!existing.containerRef && entry.containerRef?.trim()) {
      existing.containerRef = entry.containerRef.trim();
      existing.containerName = entry.containerName?.trim() || undefined;
    }
  }

  return Array.from(byRef.values()).sort((a, b) => {
    const byType = a.type.localeCompare(b.type, "ru", { sensitivity: "base" });
    if (byType !== 0) return byType;

    const byName = a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
    if (byName !== 0) return byName;

    return a.entityRef.localeCompare(b.entityRef, "ru", { sensitivity: "base" });
  });
}

function toRegistryFromKnownEntities(knownEntities: KnownProjectEntity[]): EntityRegistryEntry[] {
  return dedupeEntityRegistry(
    knownEntities.map((entity) => ({
      entityRef: entity.entityRef,
      type: entity.type,
      name: entity.name,
      summary: entity.summary,
      containerRef: entity.container?.entityRef,
      containerName: entity.container?.name,
    }))
  );
}

function toRegistryFromExtractionEntities(entities: ExtractionEntity[]): EntityRegistryEntry[] {
  return dedupeEntityRegistry(
    entities.map((entity) => ({
      entityRef: entity.entityRef,
      type: entity.type,
      name: entity.name,
      summary: entity.summary,
    }))
  );
}

function buildEntityRegistryLiteral(registry: EntityRegistryEntry[]): string {
  if (!registry.length) {
    return "(пока нет известных сущностей проекта)";
  }

  return registry
    .map((entry) => {
      const summary = entry.summary?.trim() || "-";
      const container = entry.containerRef ? `; container=${entry.containerRef}:${entry.containerName || "?"}` : "";
      return `- ref=${entry.entityRef} | ${entry.type} | ${entry.name}${container} | summary=${summary}`;
    })
    .join("\n");
}

function buildFullEntitiesPrompt(content: string): string {
  const paragraphs = splitParagraphs(content)
    .map((paragraph) => `P${paragraph.index}: ${paragraph.text}`)
    .join("\n\n");

  return [
    "Ты extraction-движок narrative-структуры.",
    FICTION_CONTEXT_NOTE,
    "Фаза 1: выдели только canonical entities.",
    "Нельзя выдумывать сущности и факты.",
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "entities": [{ "entityRef": "e_1", "type": "character|location|event|time_marker", "name": "...", "summary": "..." }]',
    "}",
    "",
    "Правила:",
    "1) Используй только типы: character, location, event, time_marker.",
    "2) entityRef обязателен, уникален в ответе и стабилен внутри ответа.",
    "3) summary короткий (1 фраза), только по фактам из текста; если фактов недостаточно, summary = ''.",
    "4) Удали дубли и верни только канонические названия.",
    "5) Для character извлекай любого явно именованного человека, даже если он упомянут один раз.",
    "6) Не объединяй разных людей с одинаковой фамилией: Миссис Спенсер и Роберт Спенсер — разные entities.",
    "",
    "Текст документа по параграфам:",
    paragraphs,
  ].join("\n");
}

function buildFullMentionsPrompt(content: string, entityRegistry: EntityRegistryEntry[]): string {
  const paragraphs = splitParagraphs(content)
    .map((paragraph) => `P${paragraph.index}: ${paragraph.text}`)
    .join("\n\n");

  return [
    "Ты extraction-движок narrative-структуры.",
    FICTION_CONTEXT_NOTE,
    "Фаза 2: выдели mentions, annotations и locationContainments по фиксированному реестру сущностей.",
    "Нельзя создавать новые canonical entities.",
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "mentions": [{ "entityRef": "...", "type": "character|location|event|time_marker", "name": "...", "paragraphIndex": 0, "mentionText": "..." }],',
    '  "annotations": [{ "entityRef": "...", "paragraphIndex": 0, "type": "character|location|event|time_marker", "label": "Короткая пометка", "name": "..." }],',
    '  "locationContainments": [{ "childRef": "...", "parentRef": "..." }]',
    "}",
    "",
    "Обязательные правила:",
    "1) entityRef должен ТОЧНО совпадать с entityRef из реестра.",
    "2) type и name должны соответствовать той же сущности из реестра.",
    "3) mentionText должен быть точной подстрокой соответствующего параграфа.",
    "4) paragraphIndex должен существовать.",
    "5) Аннотации только если есть явное локальное основание в абзаце.",
    "6) label до 120 символов.",
    "7) Если нельзя однозначно сопоставить mention к сущности из реестра — пропусти mention.",
    "8) Возвращай ВСЕ явные вхождения mentions: если одно и то же mentionText встречается несколько раз, добавь отдельные элементы.",
    "9) locationContainments добавляй только при явном сигнале 'локация внутри локации'; childRef и parentRef должны ссылаться на location.",
    "",
    "Реестр сущностей:",
    buildEntityRegistryLiteral(entityRegistry),
    "",
    "Текст документа по параграфам:",
    paragraphs,
  ].join("\n");
}

function formatIncrementalScopedParagraphs(content: string, targetIndices: number[]) {
  const paragraphs = splitParagraphs(content);
  const maxParagraph = Math.max(0, paragraphs.length - 1);
  const targetSet = new Set(targetIndices);
  const windowSet = new Set<number>();

  for (const index of targetIndices) {
    const around = [index - 1, index, index + 1];
    for (const candidate of around) {
      if (candidate >= 0 && candidate <= maxParagraph) {
        windowSet.add(candidate);
      }
    }
  }

  return Array.from(windowSet)
    .sort((a, b) => a - b)
    .map((index) => {
      const marker = targetSet.has(index) ? "TARGET" : "CONTEXT";
      return `P${index} [${marker}]: ${paragraphs[index]?.text || ""}`;
    })
    .join("\n\n");
}

function buildIncrementalEntitiesPrompt(params: {
  content: string;
  targetIndices: number[];
  knownEntities: KnownProjectEntity[];
}): string {
  const targetsLiteral = params.targetIndices.join(", ");
  const scopedParagraphs = formatIncrementalScopedParagraphs(params.content, params.targetIndices);
  const knownRegistry = toRegistryFromKnownEntities(params.knownEntities);

  return [
    "Ты extraction-движок narrative-структуры.",
    FICTION_CONTEXT_NOTE,
    "Фаза 1 (incremental): выдели entities только по TARGET-абзацам.",
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "entities": [{ "entityRef": "e_1", "type": "character|location|event|time_marker", "name": "...", "summary": "..." }]',
    "}",
    "",
    `TARGET-абзацы: [${targetsLiteral}]`,
    "",
    "Правила:",
    "1) Извлекай entities только если есть явное упоминание в TARGET-абзацах.",
    "2) CONTEXT-абзацы используются только для понимания смысла и disambiguation.",
    "3) Если сущность уже есть в реестре и это тот же объект, используй ТОЧНО тот же entityRef и name.",
    "4) Не создавай дублей и не выдумывай новые сущности.",
    "5) Для character извлекай явные персональные имена даже при единственном упоминании.",
    "",
    "Реестр уже известных сущностей проекта:",
    buildEntityRegistryLiteral(knownRegistry),
    "",
    "Текст (TARGET + CONTEXT) по параграфам:",
    scopedParagraphs,
  ].join("\n");
}

function buildIncrementalMentionsPrompt(params: {
  content: string;
  targetIndices: number[];
  entityRegistry: EntityRegistryEntry[];
}): string {
  const targetsLiteral = params.targetIndices.join(", ");
  const scopedParagraphs = formatIncrementalScopedParagraphs(params.content, params.targetIndices);

  return [
    "Ты extraction-движок narrative-структуры.",
    FICTION_CONTEXT_NOTE,
    "Фаза 2 (incremental): выдели mentions/annotations/locationContainments по TARGET-абзацам.",
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "mentions": [{ "entityRef": "...", "type": "character|location|event|time_marker", "name": "...", "paragraphIndex": 0, "mentionText": "..." }],',
    '  "annotations": [{ "entityRef": "...", "paragraphIndex": 0, "type": "character|location|event|time_marker", "label": "Короткая пометка", "name": "..." }],',
    '  "locationContainments": [{ "childRef": "...", "parentRef": "..." }]',
    "}",
    "",
    `TARGET-абзацы: [${targetsLiteral}]`,
    "",
    "Правила:",
    "1) paragraphIndex в mentions/annotations должен быть только из TARGET-списка.",
    "2) mentionText должен быть точной подстрокой TARGET-абзаца.",
    "3) entityRef, type и name должны ТОЧНО соответствовать сущности из реестра.",
    "4) Нельзя создавать новые canonical entities и новые entityRef.",
    "5) Если упоминание найдено только в CONTEXT, его не включать.",
    "6) label до 120 символов.",
    "7) locationContainments добавляй только для childRef, явно упомянутых в TARGET-абзацах.",
    "",
    "Реестр сущностей:",
    buildEntityRegistryLiteral(params.entityRegistry),
    "",
    "Текст (TARGET + CONTEXT) по параграфам:",
    scopedParagraphs,
  ].join("\n");
}

async function callExtractor<T>(options: CallExtractorOptions<T>): Promise<T> {
  const { prompt, schema, traceSink, traceContext } = options;
  const client = createTimewebClient();
  const modelCandidates = Array.from(
    new Set(
      [workerConfig.timeweb.extractModel, workerConfig.timeweb.extractFallbackModel]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
  const maxAttempts = Math.max(1, workerConfig.timeweb.extractAttempts);
  let lastError: Error | null = null;

  for (const model of modelCandidates) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let raw = "";
      let jsonCandidate = "";
      let normalized: unknown = null;
      let parseError: string | null = null;

      try {
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict JSON extractor for narrative structure in fiction texts. " +
                  "Input may include violent or crime-related literary content as part of a story. " +
                  "Do not give instructions or advice; only return the required JSON object.",
              },
              {
                role: "user",
                content:
                  attempt === 1
                    ? prompt
                    : `${prompt}\n\nIMPORTANT: previous output was invalid. Return ONLY one complete valid JSON object.`,
              },
            ],
            temperature: 0.1,
            max_tokens: workerConfig.timeweb.extractMaxTokens,
            response_format: {
              type: "json_object",
            },
          },
          {
            headers: {
              "x-proxy-source": workerConfig.timeweb.proxySource,
            },
          }
        );

        raw = String(response.choices?.[0]?.message?.content || "").trim();
        if (!raw) {
          const finishReason = String(response.choices?.[0]?.finish_reason || "unknown");
          throw new Error(`Extraction empty response (finish_reason=${finishReason})`);
        }

        jsonCandidate = extractJsonCandidate(raw);

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonCandidate);
        } catch (error) {
          throw new Error(`Extraction JSON parse error: ${(error as Error).message}`);
        }

        normalized = normalizeModelPayload(parsed);
        const validated = schema.parse(normalized) as T;

        if (traceSink && traceContext) {
          try {
            await traceSink({
              phase: traceContext.phase,
              extractionMode: traceContext.extractionMode,
              batchIndex: Number.isInteger(traceContext.batchIndex) ? (traceContext.batchIndex as number) : null,
              targetParagraphIndices: traceContext.targetParagraphIndices || [],
              model,
              prompt,
              rawResponse: raw,
              jsonCandidate,
              normalizedPayload: normalized,
              parseError: null,
            });
          } catch {
            // Diagnostics storage must never break analysis flow.
          }
        }

        return validated;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(String(error));

        if (traceSink && traceContext) {
          try {
            await traceSink({
              phase: traceContext.phase,
              extractionMode: traceContext.extractionMode,
              batchIndex: Number.isInteger(traceContext.batchIndex) ? (traceContext.batchIndex as number) : null,
              targetParagraphIndices: traceContext.targetParagraphIndices || [],
              model,
              prompt,
              rawResponse: raw,
              jsonCandidate,
              normalizedPayload: normalized,
              parseError,
            });
          } catch {
            // Diagnostics storage must never break analysis flow.
          }
        }

        const isContentFilter = parseError.includes("finish_reason=content_filter");
        if (isContentFilter) {
          break;
        }
      }
    }
  }

  throw lastError ?? new Error("Extraction failed without a captured error");
}

function dedupeExtraction(result: ExtractionResult): ExtractionResult {
  const entitiesByRef = new Map<string, ExtractionResult["entities"][number]>();

  for (const entity of result.entities) {
    const key = entity.entityRef.trim();
    if (!key) continue;

    const existing = entitiesByRef.get(key);

    if (!existing) {
      entitiesByRef.set(key, entity);
      continue;
    }

    if (!existing.summary && entity.summary) {
      existing.summary = entity.summary;
    }

    if (entity.name.length < existing.name.length) {
      existing.name = entity.name;
    }
  }

  const annotationsByKey = new Map<string, ExtractionResult["annotations"][number]>();

  for (const annotation of result.annotations) {
    const key = [
      annotation.paragraphIndex,
      annotation.type,
      annotation.label.toLowerCase(),
      annotation.entityRef || "",
      normalizeEntityName(annotation.name || ""),
    ].join("::");

    if (!annotationsByKey.has(key)) {
      annotationsByKey.set(key, annotation);
    }
  }

  const containmentsByChild = new Map<string, ExtractionResult["locationContainments"][number]>();

  for (const containment of result.locationContainments) {
    const childRef = containment.childRef.trim();
    const parentRef = containment.parentRef.trim();

    if (!childRef || !parentRef) continue;
    if (childRef === parentRef) continue;

    containmentsByChild.set(childRef, {
      childRef,
      parentRef,
    });
  }

  return {
    entities: Array.from(entitiesByRef.values()),
    mentions: result.mentions,
    annotations: Array.from(annotationsByKey.values()),
    locationContainments: Array.from(containmentsByChild.values()),
  };
}

function normalizeExtraction(result: ExtractionResult, options: NormalizeExtractionOptions): ExtractionResult {
  const mentions = result.mentions.filter((mention) => {
    if (mention.paragraphIndex < 0 || mention.paragraphIndex > options.maxParagraph) {
      return false;
    }

    if (options.allowedParagraphIndices && !options.allowedParagraphIndices.has(mention.paragraphIndex)) {
      return false;
    }

    return true;
  });

  const annotations = result.annotations.filter((annotation) => {
    if (annotation.paragraphIndex < 0 || annotation.paragraphIndex > options.maxParagraph) {
      return false;
    }

    if (options.allowedParagraphIndices && !options.allowedParagraphIndices.has(annotation.paragraphIndex)) {
      return false;
    }

    return true;
  });

  const mentionedEntityRefs = new Set(mentions.map((mention) => mention.entityRef));

  const entities = result.entities.filter((entity) => {
    if (!options.requireMentionBackedEntities) {
      return true;
    }

    return mentionedEntityRefs.has(entity.entityRef);
  });

  const allowedContainmentChildren = options.requireMentionBackedEntities
    ? new Set(mentions.filter((mention) => mention.type === "location").map((mention) => mention.entityRef))
    : null;

  const locationContainments = result.locationContainments.filter((containment) => {
    if (!containment.childRef.trim() || !containment.parentRef.trim()) return false;
    if (containment.childRef === containment.parentRef) return false;

    if (allowedContainmentChildren && !allowedContainmentChildren.has(containment.childRef)) {
      return false;
    }

    return true;
  });

  return dedupeExtraction({
    entities,
    mentions,
    annotations,
    locationContainments,
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function runMentionsInBatches(params: {
  content: string;
  paragraphCount: number;
  entityRegistry: EntityRegistryEntry[];
  traceSink?: ExtractionTraceSink;
}): Promise<ExtractionMentionsResponse> {
  const allIndices = Array.from({ length: params.paragraphCount }, (_, index) => index);
  const batches = chunk(allIndices, DEFAULT_INCREMENTAL_BATCH_SIZE);

  const aggregated: ExtractionMentionsResponse = {
    mentions: [],
    annotations: [],
    locationContainments: [],
  };

  for (const [batchIndex, targetIndices] of batches.entries()) {
    const partial = await callExtractor<ExtractionMentionsResponse>({
      prompt: buildIncrementalMentionsPrompt({
        content: params.content,
        targetIndices,
        entityRegistry: params.entityRegistry,
      }),
      schema: ExtractionMentionsResponseSchema,
      traceSink: params.traceSink,
      traceContext: {
        phase: "mentions",
        extractionMode: "incremental",
        batchIndex,
        targetParagraphIndices: targetIndices,
      },
    });

    const normalizedPartial = normalizeExtraction(
      {
        entities: [],
        mentions: partial.mentions,
        annotations: partial.annotations,
        locationContainments: partial.locationContainments,
      },
      {
        maxParagraph: Math.max(0, params.paragraphCount - 1),
        allowedParagraphIndices: new Set(targetIndices),
      }
    );

    aggregated.mentions.push(...normalizedPartial.mentions);
    aggregated.annotations.push(...normalizedPartial.annotations);
    aggregated.locationContainments.push(...normalizedPartial.locationContainments);
  }

  return aggregated;
}

export async function runExtraction(rawContent: string, options: RunExtractionOptions = {}): Promise<ExtractionResult> {
  const content = canonicalizeDocumentContent(rawContent);
  const paragraphs = splitParagraphs(content);

  if (!paragraphs.length) {
    return {
      entities: [],
      mentions: [],
      annotations: [],
      locationContainments: [],
    };
  }

  const entitiesResponse = await callExtractor<ExtractionEntitiesResponse>({
    prompt: buildFullEntitiesPrompt(content),
    schema: ExtractionEntitiesResponseSchema,
    traceSink: options.traceSink,
    traceContext: {
      phase: "entities",
      extractionMode: "full",
    },
  });

  const passOneEntities = dedupeExtraction({
    entities: entitiesResponse.entities,
    mentions: [],
    annotations: [],
    locationContainments: [],
  }).entities;

  const entityRegistry = toRegistryFromExtractionEntities(passOneEntities);
  let mentionsResponse: ExtractionMentionsResponse;

  const shouldUseBatchMentions = paragraphs.length >= FULL_MENTIONS_BATCH_FALLBACK_MIN_PARAGRAPHS;

  if (shouldUseBatchMentions) {
    mentionsResponse = await runMentionsInBatches({
      content,
      paragraphCount: paragraphs.length,
      entityRegistry,
      traceSink: options.traceSink,
    });
  } else {
    try {
      mentionsResponse = await callExtractor<ExtractionMentionsResponse>({
        prompt: buildFullMentionsPrompt(content, entityRegistry),
        schema: ExtractionMentionsResponseSchema,
        traceSink: options.traceSink,
        traceContext: {
          phase: "mentions",
          extractionMode: "full",
        },
      });
    } catch (error) {
      if (!isExtractionJsonParseError(error) || paragraphs.length < 2) {
        throw error;
      }

      mentionsResponse = await runMentionsInBatches({
        content,
        paragraphCount: paragraphs.length,
        entityRegistry,
        traceSink: options.traceSink,
      });
    }
  }

  return normalizeExtraction(
    {
      entities: passOneEntities,
      mentions: mentionsResponse.mentions,
      annotations: mentionsResponse.annotations,
      locationContainments: mentionsResponse.locationContainments,
    },
    { maxParagraph: paragraphs.length - 1 }
  );
}

export async function runExtractionIncremental(
  input: IncrementalExtractionInput,
  options: RunExtractionOptions = {}
): Promise<ExtractionResult> {
  const content = canonicalizeDocumentContent(input.content);
  const paragraphs = splitParagraphs(content);

  if (!paragraphs.length) {
    return {
      entities: [],
      mentions: [],
      annotations: [],
      locationContainments: [],
    };
  }

  const changedParagraphIndices = Array.from(new Set(input.changedParagraphIndices))
    .filter((index) => index >= 0 && index < paragraphs.length)
    .sort((a, b) => a - b);

  if (!changedParagraphIndices.length) {
    return {
      entities: [],
      mentions: [],
      annotations: [],
      locationContainments: [],
    };
  }

  const batchSize = Math.max(1, input.batchSize || DEFAULT_INCREMENTAL_BATCH_SIZE);
  const batches = chunk(changedParagraphIndices, batchSize);
  const collected: ExtractionResult = {
    entities: [],
    mentions: [],
    annotations: [],
    locationContainments: [],
  };

  for (const [batchIndex, batch] of batches.entries()) {
    const passOne = await callExtractor<ExtractionEntitiesResponse>({
      prompt: buildIncrementalEntitiesPrompt({
        content,
        targetIndices: batch,
        knownEntities: input.knownEntities,
      }),
      schema: ExtractionEntitiesResponseSchema,
      traceSink: options.traceSink,
      traceContext: {
        phase: "entities",
        extractionMode: "incremental",
        batchIndex,
        targetParagraphIndices: batch,
      },
    });

    const passOneEntities = dedupeExtraction({
      entities: passOne.entities,
      mentions: [],
      annotations: [],
      locationContainments: [],
    }).entities;

    const mentionRegistry = dedupeEntityRegistry([
      ...toRegistryFromKnownEntities(input.knownEntities),
      ...toRegistryFromExtractionEntities(passOneEntities),
    ]);

    const passTwo = await callExtractor<ExtractionMentionsResponse>({
      prompt: buildIncrementalMentionsPrompt({
        content,
        targetIndices: batch,
        entityRegistry: mentionRegistry,
      }),
      schema: ExtractionMentionsResponseSchema,
      traceSink: options.traceSink,
      traceContext: {
        phase: "mentions",
        extractionMode: "incremental",
        batchIndex,
        targetParagraphIndices: batch,
      },
    });

    const normalized = normalizeExtraction(
      {
        entities: passOneEntities,
        mentions: passTwo.mentions,
        annotations: passTwo.annotations,
        locationContainments: passTwo.locationContainments,
      },
      {
        maxParagraph: paragraphs.length - 1,
        allowedParagraphIndices: new Set(batch),
        requireMentionBackedEntities: true,
      }
    );

    collected.entities.push(...normalized.entities);
    collected.mentions.push(...normalized.mentions);
    collected.annotations.push(...normalized.annotations);
    collected.locationContainments.push(...normalized.locationContainments);
  }

  return dedupeExtraction(collected);
}
