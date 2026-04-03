import { z } from "zod";
import {
  EntityTypeSchema,
  ExtractionEntitySchema,
  ExtractionLocationContainmentSchema,
  canonicalizeDocumentContent,
  normalizeEntityName,
  splitParagraphs,
  type EntityType,
  type ExtractionEntity,
  type ExtractionResult,
} from "@remarka/contracts";
import { createKiaClient } from "./kiaClient";
import { createTimewebClient } from "./timewebClient";
import { workerConfig } from "./config";

const FICTION_CONTEXT_NOTE =
  "Контекст: это разбор художественного литературного произведения (fiction). " +
  "Текст может содержать описание преступлений, насилия или тяжелых событий как часть сюжета. " +
  "Нужно только извлечь структурированные сущности, без советов и инструкций.";

const DEFAULT_EXTRACTOR_SYSTEM_PROMPT =
  "You are a strict JSON extractor for narrative structure in fiction texts. " +
  "Input may include violent or crime-related literary content as part of a story. " +
  "Do not give instructions or advice; only return the required JSON object.";

const HIGH_RECALL_ENTITIES_SYSTEM_PROMPT = [
  "You are a strict high-recall JSON extractor for narrative structure in fiction texts.",
  "",
  "Input may include literary descriptions of violence, crime, death, abuse, or other disturbing events as part of a fictional narrative. Treat all such content only as story content to be structurally extracted.",
  "",
  "Your task is to extract canonical entities that are explicitly supported by the text. Do not invent entities. Do not infer hidden facts. But do prefer recall when the text provides sufficient evidence that an entity exists.",
  "",
  "Return exactly one JSON object and nothing else.",
].join("\n");

const HIGH_RECALL_MENTIONS_SYSTEM_PROMPT = [
  "You are a strict high-recall JSON extractor for narrative structure in fiction texts.",
  "",
  "Input may include literary descriptions of violence, crime, death, abuse, or other disturbing events as part of a fictional narrative. Treat all such content only as fictional story content to be structurally extracted.",
  "",
  "Your task is to find mentions of already known entities in text paragraphs, attach them only to the provided registry entities, and return exactly one JSON object.",
  "",
  "Do not create new canonical entities. Do not invent links. Prefer high recall for explicit mentions, but if mapping is genuinely ambiguous, omit that mention.",
].join("\n");

const ExtractionEntitiesResponseSchema = z.object({
  entities: z.array(ExtractionEntitySchema).default([]),
});

const ModelMentionSchema = z.object({
  entityRef: z.string().trim().min(1).max(120).optional(),
  type: EntityTypeSchema.optional(),
  name: z.string().trim().min(1).optional(),
  paragraphIndex: z.number().int().nonnegative(),
  mentionText: z.string().trim().min(1),
});

const ExtractionMentionsResponseSchema = z.object({
  mentions: z.array(ModelMentionSchema).default([]),
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
  attempt: number;
  finishReason: string | null;
  prompt: string;
  rawResponse: string;
  jsonCandidate: string;
  normalizedPayload: unknown;
  parseError: string | null;
  requestStartedAt: Date | null;
  requestCompletedAt: Date | null;
  durationMs: number | null;
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
  systemPrompt?: string;
  traceSink?: ExtractionTraceSink;
  traceContext?: CallExtractorTraceContext;
}

interface RunExtractionOptions {
  traceSink?: ExtractionTraceSink;
  knownEntities?: KnownProjectEntity[];
  onFullMentionsBatch?: (payload: {
    batchIndex: number;
    targetParagraphIndices: number[];
    mentions: ExtractionResult["mentions"];
    locationContainments: ExtractionResult["locationContainments"];
  }) => Promise<void> | void;
}

interface ProviderChatCompletionChoice {
  finish_reason?: unknown;
  message?: {
    content?: unknown;
  } | null;
}

interface ProviderChatCompletionPayload {
  choices?: ProviderChatCompletionChoice[];
}

function parseProviderChatCompletionResponse(response: unknown): ProviderChatCompletionPayload {
  let payload: unknown = response;

  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) {
      throw new Error("Extraction provider returned empty payload");
    }

    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Extraction provider returned non-JSON payload: ${(error as Error).message}`);
    }
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
    throw new Error(
      providerMessage
        ? `KIA provider error (${providerCode}): ${providerMessage}`
        : `KIA provider error (${providerCode})`
    );
  }

  let completionPayload: unknown = payload;
  if (envelope.data !== undefined && envelope.data !== null) {
    completionPayload = envelope.data;
    if (typeof completionPayload === "string") {
      const text = completionPayload.trim();
      if (!text) {
        throw new Error("Extraction provider returned empty data payload");
      }
      try {
        completionPayload = JSON.parse(text);
      } catch (error) {
        throw new Error(`Extraction provider returned invalid data payload: ${(error as Error).message}`);
      }
    }
  }

  if (!completionPayload || typeof completionPayload !== "object") {
    throw new Error("Extraction provider completion payload has unsupported type");
  }

  return completionPayload as ProviderChatCompletionPayload;
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
        .map((entry) => {
          const type = normalizeEntityType(entry.type);
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          const mentionText = typeof entry.mentionText === "string" ? entry.mentionText.trim() : "";
          const paragraphIndexRaw = Number(entry.paragraphIndex);
          const paragraphIndex = Number.isInteger(paragraphIndexRaw) ? paragraphIndexRaw : 0;

          if (!mentionText) return null;

          const providedRef = typeof entry.entityRef === "string" ? entry.entityRef.trim() : "";
          const inferredRef = type && name ? resolveRefByTypeAndName(type, name) : "";
          const entityRef = providedRef || inferredRef;
          if (!entityRef) return null;

          const mentionPayload: Record<string, unknown> = {
            entityRef,
            paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : 0,
            mentionText,
          };

          if (type) {
            mentionPayload.type = type;
          }

          if (name) {
            mentionPayload.name = name;
          }

          return mentionPayload;
        })
        .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention))
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
    annotations: [],
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

const ENTITY_TYPE_SET = new Set<EntityType>(["character", "location", "event"]);

function hydrateMentionsWithRegistry(
  modelMentions: ExtractionMentionsResponse["mentions"],
  entityRegistry: EntityRegistryEntry[]
): ExtractionResult["mentions"] {
  if (!modelMentions.length || !entityRegistry.length) return [];

  const registryByRef = new Map(entityRegistry.map((entry) => [entry.entityRef, entry]));
  const hydrated: ExtractionResult["mentions"] = [];

  for (const mention of modelMentions) {
    const entityRef = String(mention.entityRef || "").trim();
    if (!entityRef) continue;

    const registryEntity = registryByRef.get(entityRef);
    const fallbackType = normalizeEntityType(mention.type);
    const fallbackName = typeof mention.name === "string" ? mention.name.trim() : "";
    const type = (registryEntity?.type || fallbackType) as EntityType;
    const name = registryEntity?.name || fallbackName;

    if (!ENTITY_TYPE_SET.has(type)) continue;
    if (!name) continue;

    hydrated.push({
      entityRef,
      type,
      name,
      paragraphIndex: mention.paragraphIndex,
      mentionText: mention.mentionText,
    });
  }

  return hydrated;
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

function buildFullEntitiesPrompt(params: { content: string; knownEntities: KnownProjectEntity[] }): string {
  const paragraphs = splitParagraphs(params.content)
    .map((paragraph) => `P${paragraph.index}: ${paragraph.text}`)
    .join("\n\n");
  const knownRegistry = toRegistryFromKnownEntities(params.knownEntities);

  return [
    "Ты extraction-движок narrative-структуры для художественного текста.",
    "",
    "Задача:",
    "Фаза 1. Извлеки только canonical entities, которые явно поддержаны текстом.",
    "Нельзя выдумывать сущности и факты.",
    "Но нельзя и пропускать явно существующие сущности только из-за осторожности.",
    "",
    "Реестр уже известных сущностей проекта:",
    buildEntityRegistryLiteral(knownRegistry),
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "entities": [',
    "    {",
    '      "entityRef": "e_1",',
    '      "type": "character|location|event",',
    '      "name": "...",',
    '      "summary": "..."',
    "    }",
    "  ]",
    "}",
    "",
    "Правила формата:",
    "1) Используй только типы: character, location, event.",
    "2) entityRef обязателен, уникален в ответе и стабилен внутри ответа.",
    "3) Если сущность уже есть в реестре и это тот же объект, используй ТОЧНО тот же entityRef и ТОЧНО то же name из реестра.",
    "4) Если сущности нет в реестре, создай новый entityRef в формате e_N.",
    '5) summary - короткая factual-фраза по тексту, без домыслов. Если фактов недостаточно, summary = "".',
    "6) Верни только валидный JSON-объект. Без markdown, без комментариев.",
    "",
    "Правила извлечения:",
    "7) Извлекай только канонические сущности, а не их mention-формы.",
    "8) Для новой сущности выбирай наиболее полную и нейтральную каноническую форму имени или названия, которая прямо есть в тексте.",
    "9) Не включай в canonical name случайные эпитеты, эмоциональные оценки, местоимения, указатели или временные уточнения.",
    "10) Удаляй дубли. Если несколько mention-форм обозначают одну и ту же сущность, верни одну canonical entity.",
    "11) Не создавай новую сущность только из-за сокращенной формы, титула или альтернативного написания, если это тот же объект.",
    "12) Не объединяй разных людей с одинаковой фамилией или похожими титулами.",
    "",
    "Что считать character:",
    "13) Character = явно упомянутый человек, персонаж или индивидуализированная фигура.",
    "14) Извлекай любого явно именованного человека, даже если он упомянут один раз.",
    '15) Извлекай также явно индивидуализированного персонажа без личного имени, если текст подает его как устойчивую отдельную фигуру, например: "Император", "доктор", "королева", если это в данном фрагменте именно конкретный персонаж, а не роль вообще.',
    '16) Не извлекай безличные группы и неиндивидуализированные множества: "солдаты", "люди", "толпа", если это не отдельная именованная сущность.',
    "",
    "Что считать location:",
    "17) Location = конкретное место, явно фигурирующее в тексте как значимая точка действия.",
    "18) Извлекай именованные места: города, страны, здания, комнаты, улицы, регионы, учреждения.",
    '19) Не извлекай слишком общие неканонические места вроде "дом", "улица", "комната", если они не поданы как отдельная устойчивая сущность или не имеют собственного названия.',
    "",
    "Что считать event:",
    "20) Event = явно выделяемое событие, происшествие, битва, казнь, встреча, война, катастрофа, церемония или иной narratively distinct occurrence.",
    "21) Извлекай event только если текст действительно указывает на отдельное событие, а не просто на действие в обычном предложении.",
    "22) Если это просто единичное локальное действие без статуса отдельного события, не создавай event.",
    "23) Название event делай коротким и каноническим по тексту; не превращай целое предложение в name.",
    "",
    "Правила консервативности:",
    "24) Не извлекай абстракции, темы, эмоции, свойства, профессии как таковые, если они не представлены как конкретная сущность.",
    "25) Не извлекай местоимения, описания-в-один-раз и случайные noun phrases без статуса сущности.",
    "26) Если есть разумное textual evidence, что это отдельная сущность нужного типа, лучше включить ее, чем пропустить.",
    "27) Если evidence недостаточно для уверенной canonical entity, не извлекай.",
    "",
    "Порядок:",
    "28) Сначала проверь совпадения с реестром.",
    "29) Затем извлеки новые canonical entities из текущего текста.",
    "30) Внутри каждого type постарайся не пропускать явно присутствующие сущности.",
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
    "Ты extraction-движок narrative-структуры для художественного текста.",
    "",
    "Задача:",
    "Фаза 2. Извлеки mentions и locationContainments только по уже известному фиксированному реестру сущностей.",
    "Нельзя создавать новые canonical entities.",
    "Нельзя придумывать новые entityRef.",
    "Нужно максимально полно собрать все явные mentions, которые можно однозначно сопоставить сущностям из реестра.",
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "mentions": [',
    "    {",
    '      "entityRef": "...",',
    '      "paragraphIndex": 0,',
    '      "mentionText": "..."',
    "    }",
    "  ],",
    '  "locationContainments": [',
    "    {",
    '      "childRef": "...",',
    '      "parentRef": "..."',
    "    }",
    "  ]",
    "}",
    "",
    "Обязательные правила формата:",
    "1) entityRef должен ТОЧНО совпадать с entityRef из реестра.",
    "2) mentionText должен быть точной подстрокой соответствующего параграфа, без нормализации и без перефразирования.",
    "3) paragraphIndex должен существовать в тексте.",
    "4) Не возвращай type и name в mentions: они берутся по entityRef из реестра на стороне системы.",
    "5) Возвращай только валидный JSON-объект. Без markdown, без комментариев.",
    "6) Верни компактный JSON (minified), без лишних пробелов и переносов.",
    "",
    "Правила для mentions:",
    "6) Mention = конкретное текстовое вхождение, которое ссылается на сущность из реестра.",
    "7) Возвращай ВСЕ явные вхождения mentions, которые можно однозначно сопоставить сущностям из реестра.",
    "8) Если одно и то же mentionText встречается несколько раз в одном абзаце, добавь отдельный mention для каждого вхождения.",
    "9) MentionText должен быть минимальной точной текстовой формой упоминания, а не расширенным фрагментом предложения.",
    "10) Не объединяй несколько вхождений в один mention.",
    "11) Если в абзаце есть несколько отдельных mention-ов одной сущности, верни несколько элементов.",
    "12) Mention можно добавлять для:",
    "   - полного имени,",
    "   - короткой формы имени,",
    "   - фамилии,",
    "   - титула,",
    "   - устойчивого обозначения,",
    "   - явно отсылающего описательного референса,",
    "   но только если его можно однозначно сопоставить сущности из реестра.",
    "13) Не добавляй mention, если соответствие сущности из реестра неоднозначно.",
    "14) Не создавай mention только на основе слабой догадки или world knowledge.",
    "15) Не извлекай mention для местоимений, если у тебя нет очень надежного и локально однозначного соответствия сущности из реестра.",
    "16) Если местоимения в твоем текущем пайплайне часто шумят, лучше пропустить местоимение, чем привязать его неверно.",
    "",
    "Правила для linking:",
    "17) Сначала ищи совпадения по реестру сущностей.",
    "18) Если в тексте встречается сокращенная, титульная или альтернативная форма, привязывай ее к сущности из реестра только если из локального контекста ясно, что это именно она.",
    "19) Не создавай отдельные mentions для сущности, которой нет в реестре.",
    "20) Если текст явно указывает на персонажа, но в реестре его нет, пропусти это mention.",
    "21) Не сливай разные сущности реестра только потому, что у них похожие имена или общая фамилия.",
    "",
    "Правила для locationContainments:",
    "22) Добавляй locationContainments только если текст явно указывает, что одна location находится внутри другой location.",
    "23) childRef и parentRef должны обе ссылаться на location из реестра.",
    "24) Не выводи containment по общему знанию мира.",
    "25) Если отношение вложенности не сказано явно или почти явно в тексте, не добавляй его.",
    "",
    "Анти-шум правила:",
    "26) Не возвращай абстрактные references, которые не являются точным текстовым mention.",
    "27) Не возвращай mentionText, которого нет в буквальном виде в соответствующем абзаце.",
    "28) Не расширяй mentionText лишними словами ради \"удобства\".",
    "29) Не сокращай mentionText так, чтобы терялась фактическая точная форма упоминания.",
    "30) Если сомневаешься между двумя сущностями из реестра - пропусти mention.",
    "31) Если соответствие однозначно и mention явно есть в тексте - лучше включить его, чем пропустить.",
    "",
    "Рекомендуемый порядок работы:",
    "32) Пройди абзацы по одному, сверху вниз.",
    "33) Внутри каждого абзаца проверь все сущности реестра и все их возможные явные текстовые формы.",
    "34) Для каждого найденного вхождения добавь отдельный mention.",
    "35) Затем отдельно проверь, есть ли явные locationContainments.",
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
    '  "entities": [{ "entityRef": "e_1", "type": "character|location|event", "name": "...", "summary": "..." }]',
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
    "Ты extraction-движок narrative-структуры для художественного текста.",
    "",
    "Задача:",
    "Фаза 2. Извлеки mentions и locationContainments только по уже известному фиксированному реестру сущностей.",
    "Нельзя создавать новые canonical entities.",
    "Нельзя придумывать новые entityRef.",
    "Нужно максимально полно собрать все явные mentions, которые можно однозначно сопоставить сущностям из реестра.",
    "",
    `TARGET-абзацы: [${targetsLiteral}]`,
    "",
    "Верни JSON строго по схеме:",
    "{",
    '  "mentions": [',
    "    {",
    '      "entityRef": "...",',
    '      "paragraphIndex": 0,',
    '      "mentionText": "..."',
    "    }",
    "  ],",
    '  "locationContainments": [',
    "    {",
    '      "childRef": "...",',
    '      "parentRef": "..."',
    "    }",
    "  ]",
    "}",
    "",
    "Обязательные правила формата:",
    "1) entityRef должен ТОЧНО совпадать с entityRef из реестра.",
    "2) mentionText должен быть точной подстрокой соответствующего параграфа, без нормализации и без перефразирования.",
    "3) paragraphIndex должен существовать в тексте.",
    "4) Не возвращай type и name в mentions: они берутся по entityRef из реестра на стороне системы.",
    "5) Возвращай только валидный JSON-объект. Без markdown, без комментариев.",
    "6) Верни компактный JSON (minified), без лишних пробелов и переносов.",
    "",
    "Правила для mentions:",
    "6) Mention = конкретное текстовое вхождение, которое ссылается на сущность из реестра.",
    "7) Возвращай ВСЕ явные вхождения mentions, которые можно однозначно сопоставить сущностям из реестра.",
    "8) Если одно и то же mentionText встречается несколько раз в одном абзаце, добавь отдельный mention для каждого вхождения.",
    "9) MentionText должен быть минимальной точной текстовой формой упоминания, а не расширенным фрагментом предложения.",
    "10) Не объединяй несколько вхождений в один mention.",
    "11) Если в абзаце есть несколько отдельных mention-ов одной сущности, верни несколько элементов.",
    "12) Mention можно добавлять для:",
    "   - полного имени,",
    "   - короткой формы имени,",
    "   - фамилии,",
    "   - титула,",
    "   - устойчивого обозначения,",
    "   - явно отсылающего описательного референса,",
    "   но только если его можно однозначно сопоставить сущности из реестра.",
    "13) Не добавляй mention, если соответствие сущности из реестра неоднозначно.",
    "14) Не создавай mention только на основе слабой догадки или world knowledge.",
    "15) Не извлекай mention для местоимений, если у тебя нет очень надежного и локально однозначного соответствия сущности из реестра.",
    "16) Если местоимения в твоем текущем пайплайне часто шумят, лучше пропустить местоимение, чем привязать его неверно.",
    "",
    "Правила для linking:",
    "17) Сначала ищи совпадения по реестру сущностей.",
    "18) Если в тексте встречается сокращенная, титульная или альтернативная форма, привязывай ее к сущности из реестра только если из локального контекста ясно, что это именно она.",
    "19) Не создавай отдельные mentions для сущности, которой нет в реестре.",
    "20) Если текст явно указывает на персонажа, но в реестре его нет, пропусти это mention.",
    "21) Не сливай разные сущности реестра только потому, что у них похожие имена или общая фамилия.",
    "",
    "Правила для locationContainments:",
    "22) Добавляй locationContainments только если текст явно указывает, что одна location находится внутри другой location.",
    "23) childRef и parentRef должны обе ссылаться на location из реестра.",
    "24) Не выводи containment по общему знанию мира.",
    "25) Если отношение вложенности не сказано явно или почти явно в тексте, не добавляй его.",
    "",
    "Анти-шум правила:",
    "26) Не возвращай абстрактные references, которые не являются точным текстовым mention.",
    "27) Не возвращай mentionText, которого нет в буквальном виде в соответствующем абзаце.",
    "28) Не расширяй mentionText лишними словами ради \"удобства\".",
    "29) Не сокращай mentionText так, чтобы терялась фактическая точная форма упоминания.",
    "30) Если сомневаешься между двумя сущностями из реестра - пропусти mention.",
    "31) Если соответствие однозначно и mention явно есть в тексте - лучше включить его, чем пропустить.",
    "",
    "Рекомендуемый порядок работы:",
    "32) Пройди абзацы по одному, сверху вниз.",
    "33) Внутри каждого абзаца проверь все сущности реестра и все их возможные явные текстовые формы.",
    "34) Для каждого найденного вхождения добавь отдельный mention.",
    "35) Затем отдельно проверь, есть ли явные locationContainments.",
    "",
    "Дополнительные правила incremental:",
    "36) paragraphIndex в ответе должен быть только из TARGET-абзацев.",
    "37) Если mention найден только в CONTEXT-абзаце, не добавляй его в ответ.",
    "38) locationContainments добавляй только если childRef явно упомянут в TARGET-абзацах.",
    "",
    "Реестр сущностей:",
    buildEntityRegistryLiteral(params.entityRegistry),
    "",
    "Текст документа по параграфам:",
    scopedParagraphs,
  ].join("\n");
}

async function callExtractor<T>(options: CallExtractorOptions<T>): Promise<T> {
  const { prompt, schema, systemPrompt, traceSink, traceContext } = options;
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
      let raw = "";
      let jsonCandidate = "";
      let normalized: unknown = null;
      let parseError: string | null = null;
      let finishReason: string | null = null;
      let requestStartedAt: Date | null = null;
      let requestCompletedAt: Date | null = null;
      let durationMs: number | null = null;

      try {
        requestStartedAt = new Date();
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content: (systemPrompt || "").trim() || DEFAULT_EXTRACTOR_SYSTEM_PROMPT,
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
        const completion = parseProviderChatCompletionResponse(response);

        requestCompletedAt = new Date();
        durationMs = Math.max(0, requestCompletedAt.getTime() - requestStartedAt.getTime());
        const finishReasonRaw = completion.choices?.[0]?.finish_reason;
        finishReason =
          typeof finishReasonRaw === "string" && finishReasonRaw.trim().length > 0 ? finishReasonRaw.trim() : null;

        raw = String(completion.choices?.[0]?.message?.content || "").trim();
        if (!raw) {
          throw new Error(`Extraction empty response (finish_reason=${finishReason || "unknown"})`);
        }

        jsonCandidate = extractJsonCandidate(raw);

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonCandidate);
        } catch (error) {
          throw new Error(
            `Extraction JSON parse error (finish_reason=${finishReason || "unknown"}): ${(error as Error).message}`
          );
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
              attempt,
              finishReason,
              prompt,
              rawResponse: raw,
              jsonCandidate,
              normalizedPayload: normalized,
              parseError: null,
              requestStartedAt,
              requestCompletedAt,
              durationMs,
            });
          } catch {
            // Diagnostics storage must never break analysis flow.
          }
        }

        return validated;
      } catch (error) {
        if (!requestCompletedAt) {
          requestCompletedAt = new Date();
          durationMs = requestStartedAt ? Math.max(0, requestCompletedAt.getTime() - requestStartedAt.getTime()) : null;
        }
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
              attempt,
              finishReason,
              prompt,
              rawResponse: raw,
              jsonCandidate,
              normalizedPayload: normalized,
              parseError,
              requestStartedAt,
              requestCompletedAt,
              durationMs,
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

interface MentionsBatchBudget {
  batchMaxChars: number;
  batchMaxParagraphs: number;
  singleCallMaxChars: number;
  singleCallMaxParagraphs: number;
}

const MENTIONS_SINGLE_CALL_BASE_MAX_CHARS = 22000;
const MENTIONS_SINGLE_CALL_MIN_MAX_CHARS = 8000;
const MENTIONS_SINGLE_CALL_BASE_MAX_PARAGRAPHS = 70;
const MENTIONS_SINGLE_CALL_MIN_MAX_PARAGRAPHS = 24;

const MENTIONS_BATCH_BASE_MAX_CHARS = 12000;
const MENTIONS_BATCH_MIN_MAX_CHARS = 4000;
const MENTIONS_BATCH_BASE_MAX_PARAGRAPHS = 28;
const MENTIONS_BATCH_MIN_MAX_PARAGRAPHS = 10;

const MENTIONS_REGISTRY_CHAR_PENALTY_PER_1K = 900;
const MENTIONS_REGISTRY_PARAGRAPH_PENALTY_PER_1K = 1.5;

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function computeMentionsBatchBudget(entityRegistry: EntityRegistryEntry[]): MentionsBatchBudget {
  const registryChars = buildEntityRegistryLiteral(entityRegistry).length;
  const penaltyUnits = registryChars / 1000;

  const batchMaxChars = clampInt(
    MENTIONS_BATCH_BASE_MAX_CHARS - penaltyUnits * MENTIONS_REGISTRY_CHAR_PENALTY_PER_1K,
    MENTIONS_BATCH_MIN_MAX_CHARS,
    MENTIONS_BATCH_BASE_MAX_CHARS
  );
  const batchMaxParagraphs = clampInt(
    MENTIONS_BATCH_BASE_MAX_PARAGRAPHS - penaltyUnits * MENTIONS_REGISTRY_PARAGRAPH_PENALTY_PER_1K,
    MENTIONS_BATCH_MIN_MAX_PARAGRAPHS,
    MENTIONS_BATCH_BASE_MAX_PARAGRAPHS
  );

  const singleCallMaxChars = clampInt(
    MENTIONS_SINGLE_CALL_BASE_MAX_CHARS - penaltyUnits * MENTIONS_REGISTRY_CHAR_PENALTY_PER_1K * 1.2,
    MENTIONS_SINGLE_CALL_MIN_MAX_CHARS,
    MENTIONS_SINGLE_CALL_BASE_MAX_CHARS
  );
  const singleCallMaxParagraphs = clampInt(
    MENTIONS_SINGLE_CALL_BASE_MAX_PARAGRAPHS - penaltyUnits * MENTIONS_REGISTRY_PARAGRAPH_PENALTY_PER_1K * 2,
    MENTIONS_SINGLE_CALL_MIN_MAX_PARAGRAPHS,
    MENTIONS_SINGLE_CALL_BASE_MAX_PARAGRAPHS
  );

  return {
    batchMaxChars,
    batchMaxParagraphs,
    singleCallMaxChars,
    singleCallMaxParagraphs,
  };
}

function isLengthRelatedExtractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message) return false;

  return (
    message.includes("finish_reason=length") ||
    message.includes("Unterminated string in JSON") ||
    message.includes("Unexpected end of JSON input")
  );
}

function shouldTrySingleMentionsCall(content: string, paragraphCount: number, budget: MentionsBatchBudget): boolean {
  return content.length <= budget.singleCallMaxChars && paragraphCount <= budget.singleCallMaxParagraphs;
}

function buildMentionTargetBatches(content: string, budget: MentionsBatchBudget): number[][] {
  const paragraphs = splitParagraphs(content);
  if (!paragraphs.length) return [];

  const batches: number[][] = [];
  let currentBatch: number[] = [];
  let currentChars = 0;

  for (const paragraph of paragraphs) {
    const nextChars = currentChars + paragraph.text.length;
    const wouldExceedChars = nextChars > budget.batchMaxChars;
    const wouldExceedCount = currentBatch.length >= budget.batchMaxParagraphs;

    if (currentBatch.length > 0 && (wouldExceedChars || wouldExceedCount)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(paragraph.index);
    currentChars += paragraph.text.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function extractMentionsInAdaptiveBatches(params: {
  content: string;
  entityRegistry: EntityRegistryEntry[];
  batchBudget: MentionsBatchBudget;
  traceSink?: ExtractionTraceSink;
  maxParagraph: number;
  onBatch?: (payload: {
    batchIndex: number;
    targetParagraphIndices: number[];
    mentions: ExtractionResult["mentions"];
    locationContainments: ExtractionResult["locationContainments"];
  }) => Promise<void> | void;
}): Promise<Pick<ExtractionResult, "mentions" | "locationContainments">> {
  const initialBatches = buildMentionTargetBatches(params.content, params.batchBudget);
  const queue = [...initialBatches];
  const mergedMentions: ExtractionResult["mentions"] = [];
  const mergedContainments: ExtractionResult["locationContainments"] = [];
  let emittedBatchIndex = 0;

  while (queue.length > 0) {
    const targetIndices = queue.shift() as number[];
    const targetSet = new Set(targetIndices);

    try {
      const batchResponse = await callExtractor<ExtractionMentionsResponse>({
        systemPrompt: HIGH_RECALL_MENTIONS_SYSTEM_PROMPT,
        prompt: buildIncrementalMentionsPrompt({
          content: params.content,
          targetIndices,
          entityRegistry: params.entityRegistry,
        }),
        schema: ExtractionMentionsResponseSchema,
        traceSink: params.traceSink,
        traceContext: {
          phase: "mentions",
          extractionMode: "full",
          batchIndex: emittedBatchIndex,
          targetParagraphIndices: targetIndices,
        },
      });

      const normalizedBatch = normalizeExtraction(
        {
          entities: [],
          mentions: hydrateMentionsWithRegistry(batchResponse.mentions, params.entityRegistry),
          annotations: [],
          locationContainments: batchResponse.locationContainments,
        },
        {
          maxParagraph: params.maxParagraph,
          allowedParagraphIndices: targetSet,
          requireMentionBackedEntities: true,
        }
      );

      mergedMentions.push(...normalizedBatch.mentions);
      mergedContainments.push(...normalizedBatch.locationContainments);

      if (params.onBatch) {
        await params.onBatch({
          batchIndex: emittedBatchIndex,
          targetParagraphIndices: targetIndices,
          mentions: normalizedBatch.mentions,
          locationContainments: normalizedBatch.locationContainments,
        });
      }

      emittedBatchIndex += 1;
    } catch (error) {
      if (isLengthRelatedExtractionError(error) && targetIndices.length > 1) {
        const middle = Math.ceil(targetIndices.length / 2);
        const firstHalf = targetIndices.slice(0, middle);
        const secondHalf = targetIndices.slice(middle);

        // Process left-to-right; split only when needed.
        queue.unshift(secondHalf);
        queue.unshift(firstHalf);
        continue;
      }

      throw error;
    }
  }

  const normalizedMerged = normalizeExtraction(
    {
      entities: [],
      mentions: mergedMentions,
      annotations: [],
      locationContainments: mergedContainments,
    },
    {
      maxParagraph: params.maxParagraph,
      allowedParagraphIndices: new Set(splitParagraphs(params.content).map((paragraph) => paragraph.index)),
      requireMentionBackedEntities: true,
    }
  );

  return {
    mentions: normalizedMerged.mentions,
    locationContainments: normalizedMerged.locationContainments,
  };
}

export async function runExtraction(rawContent: string, options: RunExtractionOptions = {}): Promise<ExtractionResult> {
  const content = canonicalizeDocumentContent(rawContent);
  const paragraphs = splitParagraphs(content);
  const knownEntities = options.knownEntities || [];

  if (!paragraphs.length) {
    return {
      entities: [],
      mentions: [],
      annotations: [],
      locationContainments: [],
    };
  }

  const entitiesResponse = await callExtractor<ExtractionEntitiesResponse>({
    systemPrompt: HIGH_RECALL_ENTITIES_SYSTEM_PROMPT,
    prompt: buildFullEntitiesPrompt({
      content,
      knownEntities,
    }),
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

  const entityRegistry = dedupeEntityRegistry([
    ...toRegistryFromKnownEntities(knownEntities),
    ...toRegistryFromExtractionEntities(passOneEntities),
  ]);
  const mentionsBatchBudget = computeMentionsBatchBudget(entityRegistry);
  const fullTargetParagraphIndices = paragraphs.map((paragraph) => paragraph.index);
  let mentions: ExtractionResult["mentions"] = [];
  let locationContainments: ExtractionResult["locationContainments"] = [];

  const trySingleCall = shouldTrySingleMentionsCall(content, paragraphs.length, mentionsBatchBudget);

  if (trySingleCall) {
    try {
      const mentionsResponse = await callExtractor<ExtractionMentionsResponse>({
        systemPrompt: HIGH_RECALL_MENTIONS_SYSTEM_PROMPT,
        prompt: buildFullMentionsPrompt(content, entityRegistry),
        schema: ExtractionMentionsResponseSchema,
        traceSink: options.traceSink,
        traceContext: {
          phase: "mentions",
          extractionMode: "full",
        },
      });

      const normalizedSingle = normalizeExtraction(
        {
          entities: [],
          mentions: hydrateMentionsWithRegistry(mentionsResponse.mentions, entityRegistry),
          annotations: [],
          locationContainments: mentionsResponse.locationContainments,
        },
        {
          maxParagraph: paragraphs.length - 1,
          allowedParagraphIndices: new Set(fullTargetParagraphIndices),
          requireMentionBackedEntities: true,
        }
      );

      mentions = normalizedSingle.mentions;
      locationContainments = normalizedSingle.locationContainments;

      if (options.onFullMentionsBatch) {
        await options.onFullMentionsBatch({
          batchIndex: 0,
          targetParagraphIndices: fullTargetParagraphIndices,
          mentions,
          locationContainments,
        });
      }
    } catch (error) {
      if (!isLengthRelatedExtractionError(error)) {
        throw error;
      }

      const batched = await extractMentionsInAdaptiveBatches({
        content,
        entityRegistry,
        batchBudget: mentionsBatchBudget,
        traceSink: options.traceSink,
        maxParagraph: paragraphs.length - 1,
        onBatch: options.onFullMentionsBatch,
      });

      mentions = batched.mentions;
      locationContainments = batched.locationContainments;
    }
  } else {
    const batched = await extractMentionsInAdaptiveBatches({
      content,
      entityRegistry,
      batchBudget: mentionsBatchBudget,
      traceSink: options.traceSink,
      maxParagraph: paragraphs.length - 1,
      onBatch: options.onFullMentionsBatch,
    });

    mentions = batched.mentions;
    locationContainments = batched.locationContainments;
  }

  return normalizeExtraction(
    {
      entities: passOneEntities,
      mentions,
      annotations: [],
      locationContainments,
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

  const targetIndices = changedParagraphIndices;
  const passOne = await callExtractor<ExtractionEntitiesResponse>({
    systemPrompt: HIGH_RECALL_ENTITIES_SYSTEM_PROMPT,
    prompt: buildIncrementalEntitiesPrompt({
      content,
      targetIndices,
      knownEntities: input.knownEntities,
    }),
    schema: ExtractionEntitiesResponseSchema,
    traceSink: options.traceSink,
    traceContext: {
      phase: "entities",
      extractionMode: "incremental",
      targetParagraphIndices: targetIndices,
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
    systemPrompt: HIGH_RECALL_MENTIONS_SYSTEM_PROMPT,
    prompt: buildIncrementalMentionsPrompt({
      content,
      targetIndices,
      entityRegistry: mentionRegistry,
    }),
    schema: ExtractionMentionsResponseSchema,
    traceSink: options.traceSink,
    traceContext: {
      phase: "mentions",
      extractionMode: "incremental",
      targetParagraphIndices: targetIndices,
    },
  });

  return normalizeExtraction(
    {
      entities: passOneEntities,
      mentions: hydrateMentionsWithRegistry(passTwo.mentions, mentionRegistry),
      annotations: [],
      locationContainments: passTwo.locationContainments,
    },
    {
      maxParagraph: paragraphs.length - 1,
      allowedParagraphIndices: new Set(targetIndices),
      requireMentionBackedEntities: true,
    }
  );
}
