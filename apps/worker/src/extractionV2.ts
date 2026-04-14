import { z } from "zod";
import {
  ActPassResultSchema,
  AppearancePassResultSchema,
  AliasTypeSchema,
  EntityPassResultSchema,
  PatchWindowsResultSchema,
  normalizeEntityName,
  type ActPassResult,
  type AppearancePassResult,
  type AppearanceScope,
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

export interface ActPassInput {
  contentVersion: number;
  paragraphs: Array<{
    index: number;
    text: string;
    startOffset: number;
  }>;
  characterSignals: Array<{
    paragraphIndex: number;
    characterId: string;
    canonicalName: string;
    mentionText: string;
  }>;
}

export interface AppearanceEvidenceCandidateInput {
  evidenceId: string;
  characterId: string;
  canonicalName: string;
  actOrderIndex: number | null;
  actTitle: string | null;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  mentionText: string;
  context: string;
}

export interface AppearancePassInput {
  contentVersion: number;
  acts: Array<{
    orderIndex: number;
    title: string;
    summary: string;
    paragraphStart: number;
    paragraphEnd: number;
  }>;
  evidenceCandidates: AppearanceEvidenceCandidateInput[];
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

export interface BookChapterSummaryInput {
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterSummaryResult {
  summary: string;
}

export interface BookSummaryFromChapterSummariesInput {
  bookTitle: string;
  author: string | null;
  chapterSummaries: Array<{
    orderIndex: number;
    title: string;
    summary: string;
  }>;
}

export interface BookSummaryFromChapterSummariesResult {
  summary: string;
}

export interface BookChapterCharactersInput {
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterCharactersResult {
  characters: Array<{
    name: string;
    aliases: string[];
    roleInChapter: string;
    mentionCount: number;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookCharacterProfileSynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  characterName: string;
  aliases: string[];
  mentionCount: number;
  firstAppearanceChapterOrder: number | null;
  chapterSignals: Array<{
    chapterOrderIndex: number;
    chapterTitle: string;
    roleInChapter: string;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookCharacterProfileSynthesisResult {
  role: string;
  description: string;
  arc: string;
}

export interface BookChapterLocationsInput {
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterLocationsResult {
  locations: Array<{
    name: string;
    aliases: string[];
    functionInChapter: string;
    mentionCount: number;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookLocationProfileSynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  locationName: string;
  aliases: string[];
  mentionCount: number;
  firstAppearanceChapterOrder: number | null;
  chapterSignals: Array<{
    chapterOrderIndex: number;
    chapterTitle: string;
    functionInChapter: string;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookLocationProfileSynthesisResult {
  description: string;
  significance: string;
}

export interface BookChapterThemesInput {
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterThemesResult {
  themes: Array<{
    name: string;
    aliases: string[];
    manifestationInChapter: string;
    mentionCount: number;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookThemeProfileSynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  themeName: string;
  aliases: string[];
  mentionCount: number;
  firstAppearanceChapterOrder: number | null;
  chapterSignals: Array<{
    chapterOrderIndex: number;
    chapterTitle: string;
    manifestationInChapter: string;
    quotes: Array<{
      text: string;
      context: string;
    }>;
  }>;
}

export interface BookThemeProfileSynthesisResult {
  description: string;
  development: string;
}

export type BookQuoteType =
  | "dialogue"
  | "monologue"
  | "narration"
  | "description"
  | "reflection"
  | "action";

export type BookQuoteTag =
  | "conflict"
  | "relationship"
  | "identity"
  | "morality"
  | "power"
  | "freedom"
  | "fear"
  | "guilt"
  | "hope"
  | "fate"
  | "society"
  | "violence"
  | "love"
  | "death"
  | "faith";

export type BookQuoteMentionKind = "character" | "theme" | "location";

export interface BookChapterQuotesInput {
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterQuotesResult {
  quotes: Array<{
    text: string;
    startChar: number;
    endChar: number;
    type: BookQuoteType;
    tags: BookQuoteTag[];
    confidence: number;
    commentary: string;
    mentions: Array<{
      kind: BookQuoteMentionKind;
      value: string;
      normalizedValue: string;
      startChar: number;
      endChar: number;
      confidence: number;
    }>;
  }>;
}

export type BookLiterarySectionKey =
  | "what_is_really_going_on"
  | "main_idea"
  | "how_it_works"
  | "hidden_details"
  | "characters"
  | "conflicts"
  | "structure"
  | "important_turns"
  | "takeaways"
  | "conclusion";

export const BOOK_LITERARY_SECTION_KEYS: BookLiterarySectionKey[] = [
  "what_is_really_going_on",
  "main_idea",
  "how_it_works",
  "hidden_details",
  "characters",
  "conflicts",
  "structure",
  "important_turns",
  "takeaways",
  "conclusion",
];

export interface BookLiterarySynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  chapterCount: number;
  quotes: Array<{
    quoteId: string;
    chapterOrderIndex: number;
    type: BookQuoteType;
    tags: BookQuoteTag[];
    confidence: number;
    text: string;
    commentary: string | null;
    mentions: Array<{
      kind: BookQuoteMentionKind;
      value: string;
      confidence: number;
    }>;
  }>;
}

export interface BookLiterarySynthesisSection {
  title: string;
  summary: string;
  bodyMarkdown: string;
  bullets: string[];
  evidenceQuoteIds: string[];
  confidence: number;
}

export interface BookLiterarySynthesisResult {
  sections: Record<BookLiterarySectionKey, BookLiterarySynthesisSection>;
}

export interface BookChapterLiterarySynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  chapterOrderIndex: number;
  chapterTitle: string;
  chapterText: string;
}

export interface BookLiteraryMergeChapterInput {
  chapterOrderIndex: number;
  chapterTitle: string;
  sections: Record<BookLiterarySectionKey, BookLiterarySynthesisSection>;
}

export interface BookLiteraryMergeSynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  chapterCount: number;
  chapterAnalyses: BookLiteraryMergeChapterInput[];
}

export interface BookChapterStructuralFactsInput {
  bookTitle: string;
  bookAuthor: string | null;
  chapterOrderIndex: number;
  chapterTitle: string;
  chapterText: string;
}

export interface BookChapterStructuralFactsResult {
  events: Array<{
    id: string;
    description: string;
    characters: string[];
    importance: number;
  }>;
  characterChanges: Array<{
    character: string;
    before: string;
    after: string;
    reason: string;
  }>;
  conflicts: Array<{
    type: "external" | "internal";
    description: string;
    participants: string[];
  }>;
  symbols: Array<{
    entity: string;
    description: string;
    context: string;
  }>;
  facts: string[];
}

export interface BookLiteraryMergeFactsChapterInput {
  chapterOrderIndex: number;
  chapterTitle: string;
  facts: BookChapterStructuralFactsResult;
}

export type BookLiteraryPatternEvidenceType =
  | "event"
  | "characterChange"
  | "conflict"
  | "symbol"
  | "fact";

export interface BookLiteraryPatternEvidence {
  type: BookLiteraryPatternEvidenceType;
  chapter: number;
  ref: string;
}

export interface BookLiteraryPattern {
  id: string;
  name: string;
  core: string;
  whyItMatters: string;
  evidence: BookLiteraryPatternEvidence[];
  evolution: string;
  strength: number;
}

export interface BookLiteraryPatternPassInput {
  bookTitle: string;
  chapterCount: number;
  chapterFacts: BookLiteraryMergeFactsChapterInput[];
}

export interface BookLiteraryPatternPassResult {
  patterns: BookLiteraryPattern[];
}

export interface BookLiteraryMergeFactsSynthesisInput {
  bookTitle: string;
  bookAuthor: string | null;
  chapterCount: number;
  chapterFacts: BookLiteraryMergeFactsChapterInput[];
  patterns: BookLiteraryPattern[];
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

export type StrictJsonPhase =
  | "entity_pass"
  | "act_pass"
  | "appearance_pass"
  | "mention_completion"
  | "character_merge_arbiter"
  | "character_book_pass"
  | "character_profile"
  | "book_chapter_summary"
  | "book_summary"
  | "book_chapter_characters"
  | "book_character_profile"
  | "book_chapter_locations"
  | "book_location_profile"
  | "book_chapter_themes"
  | "book_theme_profile"
  | "book_chapter_quotes"
  | "book_literary"
  | "book_core_window_scan"
  | "book_core_profiles"
  | "book_core_literary_pattern"
  | "book_core_literary_synthesis";

export interface StrictJsonCallResult<T> {
  result: T;
  meta: StrictJsonCallMeta;
  debug: StrictJsonCallDebug;
}

export class ExtractionStructuredOutputError extends Error {
  phase: StrictJsonPhase;
  provider: "kia" | "timeweb" | "vertex";
  model: string;
  attempt: number;
  finishReason: string | null;
  usage: LlmTokenUsage | null;
  rawResponseSnippet: string;
  jsonCandidateSnippet: string;

  constructor(params: {
    message: string;
    phase: StrictJsonPhase;
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

type VertexThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export async function callStrictJson<T>(params: {
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  phase: StrictJsonPhase;
  timewebModelId?: string | null;
  vertexModel?: string | null;
  vertexThinkingLevel?: VertexThinkingLevel | null;
  maxTokens?: number | null;
  allowedModels?: string[] | null;
  disableGlobalFallback?: boolean;
  maxAttempts?: number | null;
}): Promise<StrictJsonCallResult<T>> {
  const resolveVertexModelForPhase = (phase: string): string => {
    const phaseModel = workerConfig.vertex.phaseModels[phase];
    if (typeof phaseModel === "string" && phaseModel.trim().length > 0) {
      return phaseModel.trim();
    }
    return workerConfig.vertex.extractModel;
  };
  const provider = workerConfig.extraction.provider;
  const requestedTimewebModelId = provider === "timeweb" ? String(params.timewebModelId || "").trim() : "";
  const requestedVertexModel = provider === "vertex" ? String(params.vertexModel || "").trim() : "";
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
        ? requestedVertexModel || resolveVertexModelForPhase(params.phase)
        : workerConfig.timeweb.extractModel;
  const configuredFallbackModel =
    provider === "kia"
      ? workerConfig.kia.extractFallbackModel
      : provider === "vertex"
        ? workerConfig.vertex.extractFallbackModel
        : workerConfig.timeweb.extractFallbackModel;
  const allowedModels = Array.isArray(params.allowedModels)
    ? params.allowedModels.map((value) => String(value || "").trim()).filter((value) => value.length > 0)
    : [];
  const modelCandidates =
    allowedModels.length > 0
      ? Array.from(new Set(allowedModels))
      : Array.from(
          new Set(
            [
              requestedTimewebModelId,
              requestedVertexModel,
              configuredPrimaryModel,
              params.disableGlobalFallback ? "" : configuredFallbackModel,
            ]
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          )
        );
  const maxAttempts = Math.max(
    1,
    Number.isFinite(params.maxAttempts)
      ? Math.floor(params.maxAttempts as number)
      : provider === "kia"
        ? workerConfig.kia.extractAttempts
        : provider === "vertex"
          ? workerConfig.vertex.extractAttempts
          : workerConfig.timeweb.extractAttempts
  );
  const maxTokens =
    params.maxTokens && Number.isFinite(params.maxTokens)
      ? Math.max(1, Math.floor(params.maxTokens))
      :
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
        const requestPayload: Record<string, unknown> = {
          model,
          messages: [
            {
              role: "system",
              content:
                [
                  "Ты — строгий JSON-движок анализа художественного произведения.",
                  "",
                  "Работаешь только по входным данным текущего запроса.",
                  "Нельзя использовать внешние знания о книге, авторе, персонажах, сюжете или мире произведения.",
                  "Нельзя додумывать отсутствующие факты.",
                  "Нельзя смешивать данные из разных источников, если это не разрешено во входе явно.",
                  "",
                  "Общие правила работы:",
                  "",
                  "1. Возвращай только результат по заданной структуре.",
                  "2. Не добавляй пояснений, комментариев, вступлений и заключений вне требуемого формата.",
                  "3. Не используй markdown, если он не запрошен внутри конкретных полей.",
                  "4. Не используй академический, канцелярский или художественно-украшенный стиль без прямого требования.",
                  "5. Не используй общие фразы, которые подходят почти к любой книге.",
                  "6. Любое утверждение должно опираться только на входные данные.",
                  "7. Если данных недостаточно, явно снижай уверенность и не выдумывай недостающее.",
                  "8. Сохраняй язык входного запроса. Если вход на русском, ответ полностью на русском.",
                  "9. Никакого смешения языков в одном ответе.",
                  "10. Никаких служебных артефактов вроде [object Object], null вместо строки, пустых объектов, битых массивов или незаполненных шаблонов.",
                  "11. Строго соблюдай типы полей: строки остаются строками, массивы — массивами, числа — числами.",
                  "12. Не подменяй извлечение фактов интерпретацией.",
                  "13. Не подменяй объяснение книги моралью или универсальными выводами.",
                  "14. Если поле требует конкретики, давай конкретику, а не абстракцию.",
                  "15. При сомнении выбирай более узкую, фактическую и проверяемую формулировку.",
                  "",
                  "Правило качества:",
                  "если утверждение нельзя проверить по входным данным, его нельзя включать в ответ.",
                  "",
                  "Главный приоритет:",
                  "точность, структурность, консистентность, чистый машинно-обрабатываемый результат.",
                ].join("\n"),
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
        };

        if (provider === "vertex") {
          const thinkingLevel = String(params.vertexThinkingLevel || "").trim().toUpperCase();
          if (thinkingLevel === "MINIMAL" || thinkingLevel === "LOW" || thinkingLevel === "MEDIUM" || thinkingLevel === "HIGH") {
            requestPayload.vertexThinkingLevel = thinkingLevel;
          }
        }

        const response = await client.chat.completions.create(
          requestPayload as any,
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

function resolveBookLiteraryMaxTokens(): number {
  if (workerConfig.extraction.provider === "vertex") {
    return workerConfig.vertex.literaryMaxTokens;
  }
  if (workerConfig.extraction.provider === "kia") {
    return workerConfig.kia.extractMaxTokens;
  }
  return workerConfig.timeweb.extractMaxTokens;
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

function asStringLike(value: unknown): string | null {
  const direct = asString(value);
  if (direct) {
    if (direct.toLowerCase() === "[object object]") return null;
    return direct;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const record = asRecord(value);
  if (!record) return null;

  const nested = (
    asString(record.fact) ||
    asString(record.text) ||
    asString(record.value) ||
    asString(record.description) ||
    asString(record.ref) ||
    asString(record.name) ||
    asString(record.title) ||
    asString(record.label)
  );
  if (!nested) return null;
  if (nested.toLowerCase() === "[object object]") return null;
  return nested;
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

const BookChapterSummaryResultSchema = z.object({
  summary: z.string().min(1).max(200),
});

const BookSummaryFromChapterSummariesResultSchema = z.object({
  summary: z.string().min(1).max(280),
});

const BookChapterCharactersResultSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().min(1).max(140),
        aliases: z.array(z.string().min(1).max(140)).max(16),
        roleInChapter: z.string().min(1).max(200),
        mentionCount: z.number().int().min(1).max(500),
        quotes: z
          .array(
            z.object({
              text: z.string().min(1).max(320),
              context: z.string().min(1).max(320),
            })
          )
          .max(8),
      })
    )
    .max(64),
});

const BookCharacterProfileSynthesisResultSchema = z.object({
  role: z.string().min(1).max(140),
  description: z.string().min(1).max(360),
  arc: z.string().min(1).max(360),
});

const BookChapterLocationsResultSchema = z.object({
  locations: z
    .array(
      z.object({
        name: z.string().min(1).max(140),
        aliases: z.array(z.string().min(1).max(140)).max(16),
        functionInChapter: z.string().min(1).max(220),
        mentionCount: z.number().int().min(1).max(500),
        quotes: z
          .array(
            z.object({
              text: z.string().min(1).max(320),
              context: z.string().min(1).max(320),
            })
          )
          .max(8),
      })
    )
    .max(64),
});

const BookLocationProfileSynthesisResultSchema = z.object({
  description: z.string().min(1).max(360),
  significance: z.string().min(1).max(360),
});

const BookChapterThemesResultSchema = z.object({
  themes: z
    .array(
      z.object({
        name: z.string().min(1).max(140),
        aliases: z.array(z.string().min(1).max(140)).max(16),
        manifestationInChapter: z.string().min(1).max(220),
        mentionCount: z.number().int().min(1).max(500),
        quotes: z
          .array(
            z.object({
              text: z.string().min(1).max(320),
              context: z.string().min(1).max(320),
            })
          )
          .max(8),
      })
    )
    .max(64),
});

const BookThemeProfileSynthesisResultSchema = z.object({
  description: z.string().min(1).max(360),
  development: z.string().min(1).max(360),
});

const BookQuoteTypeSchema = z.enum([
  "dialogue",
  "monologue",
  "narration",
  "description",
  "reflection",
  "action",
]);

const BookQuoteTagSchema = z.enum([
  "conflict",
  "relationship",
  "identity",
  "morality",
  "power",
  "freedom",
  "fear",
  "guilt",
  "hope",
  "fate",
  "society",
  "violence",
  "love",
  "death",
  "faith",
]);

const BookQuoteMentionKindSchema = z.enum(["character", "theme", "location"]);

const BookChapterQuotesResultSchema = z.object({
  quotes: z
    .array(
      z.object({
        text: z.string().min(1).max(1200),
        startChar: z.number().int().min(0),
        endChar: z.number().int().min(1),
        type: BookQuoteTypeSchema,
        tags: z.array(BookQuoteTagSchema).max(8),
        confidence: z.number().min(0).max(1),
        commentary: z.string().min(0).max(420),
        mentions: z
          .array(
            z.object({
              kind: BookQuoteMentionKindSchema,
              value: z.string().min(1).max(140),
              normalizedValue: z.string().min(1).max(140),
              startChar: z.number().int().min(0),
              endChar: z.number().int().min(1),
              confidence: z.number().min(0).max(1),
            })
          )
          .max(16),
      })
    )
    .max(320),
});

const BookLiterarySectionSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(360),
  bodyMarkdown: z.string().min(1).max(4000),
  bullets: z.array(z.string().min(1).max(240)).min(4).max(7),
  evidenceQuoteIds: z.array(z.string().min(1)).max(24),
  confidence: z.number().min(0).max(1),
});

const BookLiterarySynthesisResultSchema = z.object({
  sections: z.object({
    what_is_really_going_on: BookLiterarySectionSchema,
    main_idea: BookLiterarySectionSchema,
    how_it_works: BookLiterarySectionSchema,
    hidden_details: BookLiterarySectionSchema,
    characters: BookLiterarySectionSchema,
    conflicts: BookLiterarySectionSchema,
    structure: BookLiterarySectionSchema,
    important_turns: BookLiterarySectionSchema,
    takeaways: BookLiterarySectionSchema,
    conclusion: BookLiterarySectionSchema,
  }),
});

const BookChapterStructuralFactsResultSchema = z.object({
  events: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        description: z.string().min(1).max(360),
        characters: z.array(z.string().min(1).max(140)).max(16),
        importance: z.number().min(0).max(1),
      })
    )
    .min(4)
    .max(10),
  characterChanges: z
    .array(
      z.object({
        character: z.string().min(1).max(140),
        before: z.string().min(1).max(320),
        after: z.string().min(1).max(320),
        reason: z.string().min(1).max(360),
      })
    )
    .max(3),
  conflicts: z
    .array(
      z.object({
        type: z.enum(["external", "internal"]),
        description: z.string().min(1).max(360),
        participants: z.array(z.string().min(1).max(140)).max(16),
      })
    )
    .min(1)
    .max(4),
  symbols: z
    .array(
      z.object({
        entity: z.string().min(1).max(140),
        description: z.string().min(1).max(320),
        context: z.string().min(1).max(360),
      })
    )
    .max(3),
  facts: z.array(z.string().min(1).max(420)).min(1).max(8),
});

const BookLiteraryPatternEvidenceSchema = z.object({
  type: z.enum(["event", "characterChange", "conflict", "symbol", "fact"]),
  chapter: z.number().int().min(1).max(5000),
  ref: z.string().min(1).max(260),
});

const BookLiteraryPatternSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  core: z.string().min(1).max(220),
  whyItMatters: z.string().min(1).max(420),
  evidence: z.array(BookLiteraryPatternEvidenceSchema).min(3).max(6),
  evolution: z.string().min(1).max(720),
  strength: z.number().min(0).max(1),
});

const BookLiteraryPatternPassResultSchema = z.object({
  patterns: z.array(BookLiteraryPatternSchema).min(4).max(7),
});

function normalizeBookChapterSummaryPayload(raw: unknown): BookChapterSummaryResult {
  const root = asRecord(raw) || {};
  const summaryCandidate =
    asString(root.summary) ||
    asString(root.chapterSummary) ||
    asString(root.description) ||
    asString(root.text) ||
    asString(root.value) ||
    "";
  const summary = truncateText(collapseWhitespace(summaryCandidate), 200);
  return { summary };
}

function normalizeBookSummaryPayload(raw: unknown): BookSummaryFromChapterSummariesResult {
  const root = asRecord(raw) || {};
  const summaryCandidate =
    asString(root.summary) ||
    asString(root.bookSummary) ||
    asString(root.description) ||
    asString(root.text) ||
    asString(root.value) ||
    "";
  const summary = truncateText(collapseWhitespace(summaryCandidate), 280);
  return { summary };
}

function normalizeStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const itemText = asStringLike(item);
    if (!itemText) continue;
    const text = truncateText(collapseWhitespace(itemText), maxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }

  return out;
}

function normalizeBookChapterCharactersPayload(raw: unknown): BookChapterCharactersResult {
  const root = asRecord(raw) || {};
  const items = Array.isArray(root.characters)
    ? root.characters
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.persons)
        ? root.persons
        : Array.isArray(root.entities)
          ? root.entities
          : [];

  const byName = new Map<string, BookChapterCharactersResult["characters"][number]>();

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    const nameCandidate =
      asString(record.name) ||
      asString(record.characterName) ||
      asString(record.canonicalName) ||
      asString(record.title) ||
      "";
    const name = truncateText(collapseWhitespace(nameCandidate), 140);
    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    if (!normalizedName) continue;

    const aliases = normalizeStringList(
      Array.isArray(record.aliases)
        ? record.aliases
        : Array.isArray(record.alias)
          ? record.alias
          : [],
      16,
      140
    ).filter((alias) => normalizeEntityName(alias) !== normalizedName);
    const roleInChapter = truncateText(
      collapseWhitespace(
        asString(record.roleInChapter) ||
          asString(record.role) ||
          asString(record.chapterRole) ||
          "Важный участник событий главы"
      ),
      200
    );
    const mentionCountRaw = asOptionalNumber(record.mentionCount);
    const mentionCount = Math.max(1, Math.min(500, Math.round(mentionCountRaw ?? 1)));
    const rawQuotes = Array.isArray(record.quotes)
      ? record.quotes
      : Array.isArray(record.citations)
        ? record.citations
        : Array.isArray(record.examples)
          ? record.examples
          : [];

    const quoteMap = new Map<string, { text: string; context: string }>();
    for (const quoteValue of rawQuotes) {
      const quoteRecord = asRecord(quoteValue);
      const quoteTextRaw =
        (quoteRecord ? asString(quoteRecord.text) || asString(quoteRecord.quote) : null) ||
        (typeof quoteValue === "string" ? quoteValue : null) ||
        "";
      const contextRaw =
        (quoteRecord ? asString(quoteRecord.context) || asString(quoteRecord.note) : null) || "Эпизод главы";
      const text = truncateText(collapseWhitespace(quoteTextRaw), 320);
      const context = truncateText(collapseWhitespace(contextRaw), 320);
      if (!text || !context) continue;
      const quoteKey = text.toLowerCase();
      if (quoteMap.has(quoteKey)) continue;
      quoteMap.set(quoteKey, { text, context });
      if (quoteMap.size >= 8) break;
    }

    const existing = byName.get(normalizedName);
    if (!existing) {
      byName.set(normalizedName, {
        name,
        aliases,
        roleInChapter: roleInChapter || "Важный участник событий главы",
        mentionCount,
        quotes: Array.from(quoteMap.values()).slice(0, 8),
      });
      continue;
    }

    existing.mentionCount = Math.min(500, existing.mentionCount + mentionCount);
    if (!existing.roleInChapter || existing.roleInChapter === "Важный участник событий главы") {
      existing.roleInChapter = roleInChapter || existing.roleInChapter;
    }

    const aliasUnion = normalizeStringList([...existing.aliases, ...aliases], 16, 140).filter(
      (alias) => normalizeEntityName(alias) !== normalizedName
    );
    existing.aliases = aliasUnion;

    const existingQuotes = new Map(existing.quotes.map((quote) => [quote.text.toLowerCase(), quote] as const));
    for (const quote of quoteMap.values()) {
      const key = quote.text.toLowerCase();
      if (existingQuotes.has(key)) continue;
      if (existingQuotes.size >= 8) break;
      existingQuotes.set(key, quote);
    }
    existing.quotes = Array.from(existingQuotes.values()).slice(0, 8);
  }

  return {
    characters: Array.from(byName.values()).slice(0, 64),
  };
}

function normalizeBookChapterLocationsPayload(raw: unknown): BookChapterLocationsResult {
  const root = asRecord(raw) || {};
  const items = Array.isArray(root.locations)
    ? root.locations
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.places)
        ? root.places
        : Array.isArray(root.entities)
          ? root.entities
          : [];

  const byName = new Map<string, BookChapterLocationsResult["locations"][number]>();

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    const nameCandidate =
      asString(record.name) ||
      asString(record.locationName) ||
      asString(record.placeName) ||
      asString(record.canonicalName) ||
      asString(record.title) ||
      "";
    const name = truncateText(collapseWhitespace(nameCandidate), 140);
    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    if (!normalizedName) continue;

    const aliases = normalizeStringList(
      Array.isArray(record.aliases)
        ? record.aliases
        : Array.isArray(record.alias)
          ? record.alias
          : [],
      16,
      140
    ).filter((alias) => normalizeEntityName(alias) !== normalizedName);
    const functionInChapter = truncateText(
      collapseWhitespace(
        asString(record.functionInChapter) ||
          asString(record.roleInChapter) ||
          asString(record.function) ||
          asString(record.role) ||
          "Важная локация главы"
      ),
      220
    );
    const mentionCountRaw = asOptionalNumber(record.mentionCount);
    const mentionCount = Math.max(1, Math.min(500, Math.round(mentionCountRaw ?? 1)));
    const rawQuotes = Array.isArray(record.quotes)
      ? record.quotes
      : Array.isArray(record.citations)
        ? record.citations
        : Array.isArray(record.examples)
          ? record.examples
          : [];

    const quoteMap = new Map<string, { text: string; context: string }>();
    for (const quoteValue of rawQuotes) {
      const quoteRecord = asRecord(quoteValue);
      const quoteTextRaw =
        (quoteRecord ? asString(quoteRecord.text) || asString(quoteRecord.quote) : null) ||
        (typeof quoteValue === "string" ? quoteValue : null) ||
        "";
      const contextRaw =
        (quoteRecord ? asString(quoteRecord.context) || asString(quoteRecord.note) : null) || "Эпизод главы";
      const text = truncateText(collapseWhitespace(quoteTextRaw), 320);
      const context = truncateText(collapseWhitespace(contextRaw), 320);
      if (!text || !context) continue;
      const quoteKey = text.toLowerCase();
      if (quoteMap.has(quoteKey)) continue;
      quoteMap.set(quoteKey, { text, context });
      if (quoteMap.size >= 8) break;
    }

    const existing = byName.get(normalizedName);
    if (!existing) {
      byName.set(normalizedName, {
        name,
        aliases,
        functionInChapter: functionInChapter || "Важная локация главы",
        mentionCount,
        quotes: Array.from(quoteMap.values()).slice(0, 8),
      });
      continue;
    }

    existing.mentionCount = Math.min(500, existing.mentionCount + mentionCount);
    if (!existing.functionInChapter || existing.functionInChapter === "Важная локация главы") {
      existing.functionInChapter = functionInChapter || existing.functionInChapter;
    }

    const aliasUnion = normalizeStringList([...existing.aliases, ...aliases], 16, 140).filter(
      (alias) => normalizeEntityName(alias) !== normalizedName
    );
    existing.aliases = aliasUnion;

    const existingQuotes = new Map(existing.quotes.map((quote) => [quote.text.toLowerCase(), quote] as const));
    for (const quote of quoteMap.values()) {
      const key = quote.text.toLowerCase();
      if (existingQuotes.has(key)) continue;
      if (existingQuotes.size >= 8) break;
      existingQuotes.set(key, quote);
    }
    existing.quotes = Array.from(existingQuotes.values()).slice(0, 8);
  }

  return {
    locations: Array.from(byName.values()).slice(0, 64),
  };
}

function normalizeBookChapterThemesPayload(raw: unknown): BookChapterThemesResult {
  const root = asRecord(raw) || {};
  const items = Array.isArray(root.themes)
    ? root.themes
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.topics)
        ? root.topics
        : Array.isArray(root.entities)
          ? root.entities
          : [];

  const byName = new Map<string, BookChapterThemesResult["themes"][number]>();

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    const nameCandidate =
      asString(record.name) ||
      asString(record.themeName) ||
      asString(record.topicName) ||
      asString(record.canonicalName) ||
      asString(record.title) ||
      "";
    const name = truncateText(collapseWhitespace(nameCandidate), 140);
    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    if (!normalizedName) continue;

    const aliases = normalizeStringList(
      Array.isArray(record.aliases)
        ? record.aliases
        : Array.isArray(record.alias)
          ? record.alias
          : [],
      16,
      140
    ).filter((alias) => normalizeEntityName(alias) !== normalizedName);
    const manifestationInChapter = truncateText(
      collapseWhitespace(
        asString(record.manifestationInChapter) ||
          asString(record.roleInChapter) ||
          asString(record.functionInChapter) ||
          asString(record.manifestation) ||
          asString(record.role) ||
          "Ключевая тема главы"
      ),
      220
    );
    const mentionCountRaw = asOptionalNumber(record.mentionCount);
    const mentionCount = Math.max(1, Math.min(500, Math.round(mentionCountRaw ?? 1)));
    const rawQuotes = Array.isArray(record.quotes)
      ? record.quotes
      : Array.isArray(record.citations)
        ? record.citations
        : Array.isArray(record.examples)
          ? record.examples
          : [];

    const quoteMap = new Map<string, { text: string; context: string }>();
    for (const quoteValue of rawQuotes) {
      const quoteRecord = asRecord(quoteValue);
      const quoteTextRaw =
        (quoteRecord ? asString(quoteRecord.text) || asString(quoteRecord.quote) : null) ||
        (typeof quoteValue === "string" ? quoteValue : null) ||
        "";
      const contextRaw =
        (quoteRecord ? asString(quoteRecord.context) || asString(quoteRecord.note) : null) || "Эпизод главы";
      const text = truncateText(collapseWhitespace(quoteTextRaw), 320);
      const context = truncateText(collapseWhitespace(contextRaw), 320);
      if (!text || !context) continue;
      const quoteKey = text.toLowerCase();
      if (quoteMap.has(quoteKey)) continue;
      quoteMap.set(quoteKey, { text, context });
      if (quoteMap.size >= 8) break;
    }

    const existing = byName.get(normalizedName);
    if (!existing) {
      byName.set(normalizedName, {
        name,
        aliases,
        manifestationInChapter: manifestationInChapter || "Ключевая тема главы",
        mentionCount,
        quotes: Array.from(quoteMap.values()).slice(0, 8),
      });
      continue;
    }

    existing.mentionCount = Math.min(500, existing.mentionCount + mentionCount);
    if (!existing.manifestationInChapter || existing.manifestationInChapter === "Ключевая тема главы") {
      existing.manifestationInChapter = manifestationInChapter || existing.manifestationInChapter;
    }

    const aliasUnion = normalizeStringList([...existing.aliases, ...aliases], 16, 140).filter(
      (alias) => normalizeEntityName(alias) !== normalizedName
    );
    existing.aliases = aliasUnion;

    const existingQuotes = new Map(existing.quotes.map((quote) => [quote.text.toLowerCase(), quote] as const));
    for (const quote of quoteMap.values()) {
      const key = quote.text.toLowerCase();
      if (existingQuotes.has(key)) continue;
      if (existingQuotes.size >= 8) break;
      existingQuotes.set(key, quote);
    }
    existing.quotes = Array.from(existingQuotes.values()).slice(0, 8);
  }

  return {
    themes: Array.from(byName.values()).slice(0, 64),
  };
}

function normalizeBookCharacterProfileSynthesisPayload(raw: unknown, input: BookCharacterProfileSynthesisInput): BookCharacterProfileSynthesisResult {
  const root = asRecord(raw) || {};
  const role = truncateText(
    collapseWhitespace(
      asString(root.role) ||
        asString(root.characterRole) ||
        "Персонаж"
    ),
    140
  );
  const description = truncateText(
    collapseWhitespace(
      asString(root.description) ||
        asString(root.summary) ||
        `${input.characterName} — заметный персонаж книги.`
    ),
    360
  );
  const arc = truncateText(
    collapseWhitespace(
      asString(root.arc) ||
        asString(root.development) ||
        asString(root.progression) ||
        "Динамика персонажа в тексте пока выражена кратко."
    ),
    360
  );

  return {
    role: role || "Персонаж",
    description: description || `${input.characterName} — заметный персонаж книги.`,
    arc: arc || "Динамика персонажа в тексте пока выражена кратко.",
  };
}

function normalizeBookLocationProfileSynthesisPayload(
  raw: unknown,
  input: BookLocationProfileSynthesisInput
): BookLocationProfileSynthesisResult {
  const root = asRecord(raw) || {};
  const description = truncateText(
    collapseWhitespace(
      asString(root.description) ||
        asString(root.summary) ||
        `${input.locationName} — локация книги, важная для развития действий.`
    ),
    360
  );
  const significance = truncateText(
    collapseWhitespace(
      asString(root.significance) ||
        asString(root.importance) ||
        asString(root.narrativeFunction) ||
        "Локация влияет на атмосферу и ход событий произведения."
    ),
    360
  );

  return {
    description: description || `${input.locationName} — локация книги, важная для развития действий.`,
    significance: significance || "Локация влияет на атмосферу и ход событий произведения.",
  };
}

function normalizeBookThemeProfileSynthesisPayload(
  raw: unknown,
  input: BookThemeProfileSynthesisInput
): BookThemeProfileSynthesisResult {
  const root = asRecord(raw) || {};
  const description = truncateText(
    collapseWhitespace(
      asString(root.description) ||
        asString(root.summary) ||
        `${input.themeName} — тема книги, проявляющаяся в ключевых эпизодах.`
    ),
    360
  );
  const development = truncateText(
    collapseWhitespace(
      asString(root.development) ||
        asString(root.progression) ||
        asString(root.evolution) ||
        "Тема развивается по мере хода сюжета и раскрытия персонажей."
    ),
    360
  );

  return {
    description: description || `${input.themeName} — тема книги, проявляющаяся в ключевых эпизодах.`,
    development: development || "Тема развивается по мере хода сюжета и раскрытия персонажей.",
  };
}

function normalizeBookQuoteType(value: unknown): BookQuoteType {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dialogue" || normalized === "диалог" || normalized === "speech") return "dialogue";
  if (normalized === "monologue" || normalized === "монолог") return "monologue";
  if (normalized === "description" || normalized === "описание") return "description";
  if (normalized === "reflection" || normalized === "размышление" || normalized === "thought") return "reflection";
  if (normalized === "action" || normalized === "действие" || normalized === "event") return "action";
  return "narration";
}

const BOOK_QUOTE_TAG_ALIASES: Record<string, BookQuoteTag> = {
  conflict: "conflict",
  конфликт: "conflict",
  relationship: "relationship",
  отношения: "relationship",
  identity: "identity",
  идентичность: "identity",
  morality: "morality",
  мораль: "morality",
  power: "power",
  власть: "power",
  freedom: "freedom",
  свобода: "freedom",
  fear: "fear",
  страх: "fear",
  guilt: "guilt",
  вина: "guilt",
  hope: "hope",
  надежда: "hope",
  fate: "fate",
  судьба: "fate",
  society: "society",
  общество: "society",
  violence: "violence",
  насилие: "violence",
  love: "love",
  любовь: "love",
  death: "death",
  смерть: "death",
  faith: "faith",
  вера: "faith",
};

function normalizeBookQuoteTag(value: unknown): BookQuoteTag | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return BOOK_QUOTE_TAG_ALIASES[normalized] || null;
}

function normalizeBookQuoteMentionKind(value: unknown): BookQuoteMentionKind | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "character" || normalized === "персонаж") return "character";
  if (normalized === "theme" || normalized === "тема") return "theme";
  if (normalized === "location" || normalized === "локация" || normalized === "place") return "location";
  return null;
}

function normalizeBookChapterQuotesPayload(
  raw: unknown,
  chapterText: string
): BookChapterQuotesResult {
  const root = asRecord(raw) || {};
  const chapterLength = String(chapterText || "").length;
  const items = Array.isArray(root.quotes)
    ? root.quotes
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.fragments)
        ? root.fragments
        : Array.isArray(root.citations)
          ? root.citations
          : [];

  const results: BookChapterQuotesResult["quotes"] = [];

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    const text = truncateText(
      collapseWhitespace(
        asString(record.text) ||
          asString(record.quote) ||
          asString(record.fragment) ||
          ""
      ),
      1200
    );
    if (!text) continue;

    const startCandidate = asOptionalNumber(record.startChar ?? record.start ?? record.offsetStart);
    const endCandidate = asOptionalNumber(record.endChar ?? record.end ?? record.offsetEnd);
    let startChar =
      startCandidate !== null && Number.isFinite(startCandidate)
        ? Math.max(0, Math.floor(startCandidate))
        : 0;
    let endChar =
      endCandidate !== null && Number.isFinite(endCandidate)
        ? Math.max(startChar + 1, Math.floor(endCandidate))
        : startChar + text.length;

    if (chapterLength > 0) {
      startChar = Math.min(startChar, Math.max(0, chapterLength - 1));
      endChar = Math.min(Math.max(startChar + 1, endChar), chapterLength);
    }

    const type = normalizeBookQuoteType(record.type ?? record.quoteType);
    const tagsSource = Array.isArray(record.tags) ? record.tags : Array.isArray(record.labels) ? record.labels : [];
    const tags: BookQuoteTag[] = [];
    const tagSeen = new Set<BookQuoteTag>();
    for (const rawTag of tagsSource) {
      const normalizedTag = normalizeBookQuoteTag(rawTag);
      if (!normalizedTag || tagSeen.has(normalizedTag)) continue;
      tags.push(normalizedTag);
      tagSeen.add(normalizedTag);
      if (tags.length >= 8) break;
    }

    const confidence = clamp01(asOptionalNumber(record.confidence) ?? 0.65);
    const commentary = truncateText(
      collapseWhitespace(
        asString(record.commentary) ||
          asString(record.note) ||
          asString(record.context) ||
          ""
      ),
      420
    );

    const rawMentions = Array.isArray(record.mentions)
      ? record.mentions
      : Array.isArray(record.entities)
        ? record.entities
        : [];
    const mentions: BookChapterQuotesResult["quotes"][number]["mentions"] = [];
    const mentionSeen = new Set<string>();
    for (const mentionValue of rawMentions) {
      const mentionRecord = asRecord(mentionValue);
      if (!mentionRecord) continue;

      const kind = normalizeBookQuoteMentionKind(mentionRecord.kind ?? mentionRecord.type);
      if (!kind) continue;

      const mentionText = truncateText(
        collapseWhitespace(
          asString(mentionRecord.value) ||
            asString(mentionRecord.name) ||
            asString(mentionRecord.text) ||
            ""
        ),
        140
      );
      if (!mentionText) continue;

      const normalizedValue =
        truncateText(
          collapseWhitespace(
            asString(mentionRecord.normalizedValue) || normalizeEntityName(mentionText) || ""
          ),
          140
        ) || "";
      if (!normalizedValue) continue;

      const mentionStartRaw = asOptionalNumber(
        mentionRecord.startChar ?? mentionRecord.start ?? mentionRecord.offsetStart
      );
      const mentionEndRaw = asOptionalNumber(
        mentionRecord.endChar ?? mentionRecord.end ?? mentionRecord.offsetEnd
      );
      let mentionStart =
        mentionStartRaw !== null && Number.isFinite(mentionStartRaw)
          ? Math.max(0, Math.floor(mentionStartRaw))
          : 0;
      let mentionEnd =
        mentionEndRaw !== null && Number.isFinite(mentionEndRaw)
          ? Math.max(mentionStart + 1, Math.floor(mentionEndRaw))
          : mentionStart + mentionText.length;
      mentionStart = Math.min(mentionStart, Math.max(0, text.length - 1));
      mentionEnd = Math.min(Math.max(mentionStart + 1, mentionEnd), text.length);

      const key = `${kind}:${normalizedValue}:${mentionStart}:${mentionEnd}`;
      if (mentionSeen.has(key)) continue;
      mentionSeen.add(key);
      mentions.push({
        kind,
        value: mentionText,
        normalizedValue,
        startChar: mentionStart,
        endChar: mentionEnd,
        confidence: clamp01(asOptionalNumber(mentionRecord.confidence) ?? confidence),
      });
      if (mentions.length >= 16) break;
    }

    results.push({
      text,
      startChar,
      endChar,
      type,
      tags,
      confidence,
      commentary,
      mentions,
    });
    if (results.length >= 320) break;
  }

  return { quotes: results };
}

const BOOK_LITERARY_SECTION_TITLE_BY_KEY: Record<BookLiterarySectionKey, string> = {
  what_is_really_going_on: "Что на самом деле происходит",
  main_idea: "Главная идея",
  how_it_works: "Как это работает",
  hidden_details: "Скрытые детали",
  characters: "Персонажи",
  conflicts: "Конфликты",
  structure: "Структура",
  important_turns: "Важные повороты",
  takeaways: "Что важно вынести",
  conclusion: "Вывод",
};

function normalizeBookLiterarySynthesisPayload(raw: unknown): BookLiterarySynthesisResult {
  const root = asRecord(raw) || {};
  const sectionsRecord = asRecord(root.sections) || {};
  if (!asRecord(root.sections)) {
    throw new Error("book_literary_synthesis: sections object is required");
  }

  const sections = Object.fromEntries(
    BOOK_LITERARY_SECTION_KEYS.map((key) => {
      const record = asRecord(sectionsRecord[key]);
      if (!record) {
        throw new Error(`book_literary_synthesis: missing section ${key}`);
      }
      const title =
        truncateText(
          collapseWhitespace(asString(record.title) || BOOK_LITERARY_SECTION_TITLE_BY_KEY[key]),
          120
        ) || BOOK_LITERARY_SECTION_TITLE_BY_KEY[key];

      const summary =
        truncateText(
          collapseWhitespace(
            asString(record.summary) || ""
          ),
          360
        );
      if (!summary) {
        throw new Error(`book_literary_synthesis: section ${key} summary is required`);
      }

      const bodyMarkdown =
        truncateText(
          String(asString(record.bodyMarkdown) || "")
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
          4000
        );
      if (!bodyMarkdown) {
        throw new Error(`book_literary_synthesis: section ${key} bodyMarkdown is required`);
      }

      const bullets = normalizeStringList(record.bullets, 7, 240);
      const evidenceSource = Array.isArray(record.evidenceQuoteIds) ? record.evidenceQuoteIds : [];
      const evidenceQuoteIds: string[] = [];
      const evidenceSeen = new Set<string>();
      for (const entry of evidenceSource) {
        const id = truncateText(collapseWhitespace(asString(entry) || ""), 120);
        if (!id || evidenceSeen.has(id)) continue;
        evidenceSeen.add(id);
        evidenceQuoteIds.push(id);
        if (evidenceQuoteIds.length >= 24) break;
      }

      const confidenceRaw = asOptionalNumber(record.confidence);
      if (confidenceRaw === null) {
        throw new Error(`book_literary_synthesis: section ${key} confidence is required`);
      }
      const confidence = clamp01(confidenceRaw);
      return [
        key,
        {
          title,
          summary,
          bodyMarkdown,
          bullets,
          evidenceQuoteIds,
          confidence,
        } satisfies BookLiterarySynthesisSection,
      ] as const;
    })
  ) as Record<BookLiterarySectionKey, BookLiterarySynthesisSection>;

  return { sections };
}

function normalizeConflictType(value: unknown): "external" | "internal" {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "internal" ? "internal" : "external";
}

function normalizeBookChapterStructuralFactsPayload(raw: unknown): BookChapterStructuralFactsResult {
  const root = asRecord(raw) || {};

  const eventsSource = Array.isArray(root.events) ? root.events : [];
  const events: BookChapterStructuralFactsResult["events"] = [];
  for (let index = 0; index < eventsSource.length; index += 1) {
    const record = asRecord(eventsSource[index]);
    if (!record) continue;

    const description = truncateText(
      collapseWhitespace(asString(record.description) || ""),
      360
    );
    if (!description) continue;

    const idRaw = truncateText(
      collapseWhitespace(
        asString(record.id) || `event_${index + 1}`
      ),
      80
    );
    const id = idRaw || `event_${index + 1}`;
    const characters = normalizeStringList(record.characters, 16, 140);
    const importance = clamp01(asOptionalNumber(record.importance) ?? 0.5);

    events.push({
      id,
      description,
      characters,
      importance,
    });
    if (events.length >= 10) break;
  }

  const changesSource = Array.isArray(root.characterChanges) ? root.characterChanges : [];
  const characterChanges: BookChapterStructuralFactsResult["characterChanges"] = [];
  for (const item of changesSource) {
    const record = asRecord(item);
    if (!record) continue;
    const character = truncateText(
      collapseWhitespace(asString(record.character) || ""),
      140
    );
    const before = truncateText(
      collapseWhitespace(asString(record.before) || ""),
      320
    );
    const after = truncateText(
      collapseWhitespace(asString(record.after) || ""),
      320
    );
    const reason = truncateText(
      collapseWhitespace(asString(record.reason) || ""),
      360
    );
    if (!character || !before || !after || !reason) continue;
    characterChanges.push({
      character,
      before,
      after,
      reason,
    });
    if (characterChanges.length >= 3) break;
  }

  const conflictsSource = Array.isArray(root.conflicts) ? root.conflicts : [];
  const conflicts: BookChapterStructuralFactsResult["conflicts"] = [];
  for (const item of conflictsSource) {
    const record = asRecord(item);
    if (!record) continue;
    const description = truncateText(
      collapseWhitespace(asString(record.description) || ""),
      360
    );
    if (!description) continue;
    const type = normalizeConflictType(record.type);
    const participants = normalizeStringList(record.participants, 16, 140);
    conflicts.push({
      type,
      description,
      participants,
    });
    if (conflicts.length >= 4) break;
  }

  const symbolsSource = Array.isArray(root.symbols) ? root.symbols : [];
  const symbols: BookChapterStructuralFactsResult["symbols"] = [];
  for (const item of symbolsSource) {
    const record = asRecord(item);
    if (!record) continue;
    const entity = truncateText(
      collapseWhitespace(asString(record.entity) || ""),
      140
    );
    const description = truncateText(
      collapseWhitespace(asString(record.description) || ""),
      320
    );
    const context = truncateText(
      collapseWhitespace(asString(record.context) || ""),
      360
    );
    if (!entity || !description || !context) continue;
    symbols.push({
      entity,
      description,
      context,
    });
    if (symbols.length >= 3) break;
  }

  const facts = normalizeStringList(root.facts, 8, 420);

  return {
    events,
    characterChanges,
    conflicts,
    symbols,
    facts,
  };
}

function normalizePatternEvidenceType(value: unknown): BookLiteraryPatternEvidenceType | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "event") return "event";
  if (normalized === "characterchange") return "characterChange";
  if (normalized === "conflict") return "conflict";
  if (normalized === "symbol") return "symbol";
  if (normalized === "fact") return "fact";
  return null;
}

function normalizeBookLiteraryPatternPassPayload(raw: unknown): BookLiteraryPatternPassResult {
  const root = asRecord(raw) || {};
  const source = Array.isArray(root.patterns) ? root.patterns : [];
  const patterns: BookLiteraryPattern[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    const record = asRecord(item);
    if (!record) continue;

    const id =
      truncateText(collapseWhitespace(asString(record.id) || ""), 80) ||
      `p${index + 1}`;
    const name = truncateText(collapseWhitespace(asString(record.name) || ""), 160);
    const core = truncateText(collapseWhitespace(asString(record.core) || ""), 220);
    const whyItMatters = truncateText(
      collapseWhitespace(asString(record.whyItMatters) || ""),
      420
    );
    const evolution = truncateText(
      collapseWhitespace(asString(record.evolution) || ""),
      720
    );
    const strength = clamp01(asOptionalNumber(record.strength) ?? 0.5);
    const evidenceSource = Array.isArray(record.evidence) ? record.evidence : [];
    const evidence: BookLiteraryPatternEvidence[] = [];
    const evidenceSeen = new Set<string>();

    for (const evidenceItem of evidenceSource) {
      const evidenceRecord = asRecord(evidenceItem);
      if (!evidenceRecord) continue;
      const ref = truncateText(
        collapseWhitespace(
          asString(evidenceRecord.ref) || ""
        ),
        260
      );
      if (!ref) continue;

      const type = normalizePatternEvidenceType(evidenceRecord.type);
      if (!type) continue;

      const chapterValue = asOptionalNumber(evidenceRecord.chapter);
      if (chapterValue === null) continue;
      const chapter = Math.min(5000, Math.max(1, Math.floor(chapterValue)));
      const evidenceKey = `${type}|${chapter}|${ref.toLowerCase()}`;
      if (evidenceSeen.has(evidenceKey)) continue;
      evidenceSeen.add(evidenceKey);
      evidence.push({ type, chapter, ref });
      if (evidence.length >= 6) break;
    }

    if (!name || !core || !whyItMatters || !evolution || evidence.length < 3) continue;
    const dedupeKey = `${id.toLowerCase()}|${name.toLowerCase()}|${core.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    patterns.push({
      id,
      name,
      core,
      whyItMatters,
      evidence,
      evolution,
      strength,
    });
    if (patterns.length >= 7) break;
  }

  return {
    patterns,
  };
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

function normalizeActTitle(raw: unknown, orderIndex: number): string {
  const explicit = asString(raw);
  if (!explicit) return `Акт ${orderIndex + 1}`;
  const normalized = truncateText(collapseWhitespace(explicit), 240);
  return normalized || `Акт ${orderIndex + 1}`;
}

function normalizeActSummary(raw: unknown): string {
  const explicit = asString(raw);
  if (!explicit) return "";
  return truncateText(collapseWhitespace(explicit), 1200);
}

function normalizeAppearanceScope(raw: unknown): AppearanceScope {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return "scene";
  if (value === "stable") return "stable";
  if (value === "temporary" || value === "temp") return "temporary";
  if (value === "scene") return "scene";
  if (value.includes("постоян") || value.includes("stable") || value.includes("always")) return "stable";
  if (value.includes("времен") || value.includes("temporary") || value.includes("moment")) return "temporary";
  return "scene";
}

function normalizeAppearanceAttributeKey(raw: unknown): string {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "appearance";
  return truncateText(normalized, 64);
}

function normalizeAppearanceAttributeLabel(raw: unknown, fallbackKey: string): string {
  const explicit = asString(raw);
  if (explicit) return truncateText(collapseWhitespace(explicit), 120);

  const key = fallbackKey.replace(/_/g, " ").trim();
  if (key) return truncateText(key, 120);
  return "Внешность";
}

function normalizeAppearanceValue(raw: unknown): string | null {
  const explicit = asString(raw);
  if (!explicit) return null;
  const normalized = truncateText(collapseWhitespace(explicit), 280);
  return normalized || null;
}

function normalizeAppearanceSummary(raw: unknown): string {
  const explicit = asString(raw);
  if (!explicit) return "";
  return truncateText(collapseWhitespace(explicit), 280);
}

function buildFallbackActPass(input: ActPassInput): ActPassResult {
  if (!input.paragraphs.length) {
    return {
      contentVersion: input.contentVersion,
      acts: [],
    };
  }

  const firstParagraphIndex = input.paragraphs[0].index;
  const lastParagraphIndex = input.paragraphs[input.paragraphs.length - 1].index;

  return {
    contentVersion: input.contentVersion,
    acts: [
      {
        orderIndex: 0,
        title: "Акт 1",
        summary: "",
        paragraphStart: firstParagraphIndex,
        paragraphEnd: lastParagraphIndex,
      },
    ],
  };
}

function normalizeActPassPayload(raw: unknown, input: ActPassInput): ActPassResult {
  const rootRecord = asRecord(raw);
  const rootArray = Array.isArray(raw) ? raw : null;
  const root = rootRecord || {};

  const sourceActs: unknown[] = [];
  const appendItems = (value: unknown) => {
    if (!Array.isArray(value)) return;
    sourceActs.push(...value);
  };

  appendItems(root.acts);
  appendItems(root.segments);
  appendItems(root.items);
  appendItems(root.scenes);
  appendItems((root as Record<string, unknown>)["акты"]);
  appendItems(rootArray);

  if (!input.paragraphs.length) {
    return {
      contentVersion: input.contentVersion,
      acts: [],
    };
  }

  const firstParagraphIndex = input.paragraphs[0].index;
  const lastParagraphIndex = input.paragraphs[input.paragraphs.length - 1].index;

  const parsedActs: Array<{
    title: string;
    summary: string;
    paragraphStart: number;
    paragraphEnd: number;
  }> = [];

  for (let index = 0; index < sourceActs.length; index += 1) {
    const item = asRecord(sourceActs[index]);
    if (!item) continue;

    const paragraphStartRaw =
      asOptionalNumber(item.paragraphStart) ??
      asOptionalNumber(item.startParagraph) ??
      asOptionalNumber(item.start) ??
      asOptionalNumber(item.fromParagraph) ??
      asOptionalNumber(item.from);
    const paragraphEndRaw =
      asOptionalNumber(item.paragraphEnd) ??
      asOptionalNumber(item.endParagraph) ??
      asOptionalNumber(item.end) ??
      asOptionalNumber(item.toParagraph) ??
      asOptionalNumber(item.to);

    if (paragraphStartRaw === null || paragraphEndRaw === null) continue;

    const paragraphStart = Math.floor(paragraphStartRaw);
    const paragraphEnd = Math.floor(paragraphEndRaw);
    parsedActs.push({
      title: normalizeActTitle(item.title ?? item.name ?? item.label, index),
      summary: normalizeActSummary(item.summary ?? item.description ?? item.actionSummary ?? item.actions),
      paragraphStart,
      paragraphEnd,
    });
  }

  if (!parsedActs.length) {
    return buildFallbackActPass(input);
  }

  const sorted = [...parsedActs]
    .filter((act) => Number.isInteger(act.paragraphStart) && Number.isInteger(act.paragraphEnd))
    .sort((left, right) => {
      if (left.paragraphStart !== right.paragraphStart) return left.paragraphStart - right.paragraphStart;
      return left.paragraphEnd - right.paragraphEnd;
    })
    .slice(0, 96);

  let expectedStart = firstParagraphIndex;
  for (const act of sorted) {
    if (act.paragraphStart !== expectedStart) {
      return buildFallbackActPass(input);
    }
    if (act.paragraphEnd < act.paragraphStart) {
      return buildFallbackActPass(input);
    }
    if (act.paragraphStart < firstParagraphIndex || act.paragraphEnd > lastParagraphIndex) {
      return buildFallbackActPass(input);
    }
    expectedStart = act.paragraphEnd + 1;
  }

  if (expectedStart !== lastParagraphIndex + 1) {
    return buildFallbackActPass(input);
  }

  const parsedContentVersion = asOptionalNumber(root.contentVersion);
  const contentVersion =
    parsedContentVersion !== null && Number.isInteger(parsedContentVersion) && parsedContentVersion >= 0
      ? parsedContentVersion
      : input.contentVersion;

  return {
    contentVersion,
    acts: sorted.map((act, index) => ({
      orderIndex: index,
      title: normalizeActTitle(act.title, index),
      summary: normalizeActSummary(act.summary),
      paragraphStart: act.paragraphStart,
      paragraphEnd: act.paragraphEnd,
    })),
  };
}

function normalizeAppearancePassPayload(raw: unknown, input: AppearancePassInput): AppearancePassResult {
  const rootRecord = asRecord(raw);
  const rootArray = Array.isArray(raw) ? raw : null;
  const root = rootRecord || {};

  const candidateByEvidenceId = new Map(input.evidenceCandidates.map((item) => [item.evidenceId, item] as const));
  const allowedCharacterIds = new Set(input.evidenceCandidates.map((item) => item.characterId));
  const knownActOrderIndexes = new Set(input.acts.map((item) => item.orderIndex));

  const sourceObservations: unknown[] = [];
  const appendItems = (value: unknown) => {
    if (!Array.isArray(value)) return;
    sourceObservations.push(...value);
  };

  appendItems(root.observations);
  appendItems(root.items);
  appendItems(root.facts);
  appendItems(root.appearance);
  appendItems((root as Record<string, unknown>)["наблюдения"]);
  appendItems(rootArray);

  type ParsedObservation = {
    characterId: string;
    attributeKey: string;
    attributeLabel: string;
    value: string;
    scope: AppearanceScope;
    actOrderIndex: number | null;
    summary: string;
    confidence: number;
    evidenceIds: string[];
  };

  const parsed: ParsedObservation[] = [];

  for (const item of sourceObservations) {
    const record = asRecord(item);
    if (!record) continue;

    const characterId =
      asString(record.characterId) ||
      asString(record.entityId) ||
      asString(record.personId) ||
      asString(record.subjectId);
    if (!characterId || !allowedCharacterIds.has(characterId)) continue;

    const attributeKey = normalizeAppearanceAttributeKey(
      record.attributeKey ?? record.attribute ?? record.traitKey ?? record.field
    );
    const attributeLabel = normalizeAppearanceAttributeLabel(
      record.attributeLabel ?? record.attribute ?? record.traitLabel ?? record.fieldLabel,
      attributeKey
    );
    const value = normalizeAppearanceValue(record.value ?? record.traitValue ?? record.description ?? record.appearance);
    if (!value) continue;

    const evidenceRaw = record.evidenceIds ?? record.evidence ?? record.proofs ?? record.references;
    const evidenceIds: string[] = [];
    const evidenceSeen = new Set<string>();
    if (Array.isArray(evidenceRaw)) {
      for (const entry of evidenceRaw) {
        const entryRecord = asRecord(entry);
        const evidenceId = asString(entryRecord?.evidenceId ?? entryRecord?.mentionId ?? entryRecord?.id ?? entry);
        if (!evidenceId) continue;
        if (evidenceSeen.has(evidenceId)) continue;
        const candidate = candidateByEvidenceId.get(evidenceId);
        if (!candidate) continue;
        if (candidate.characterId !== characterId) continue;
        evidenceIds.push(evidenceId);
        evidenceSeen.add(evidenceId);
      }
    } else {
      const singleId = asString(evidenceRaw);
      if (singleId) {
        const candidate = candidateByEvidenceId.get(singleId);
        if (candidate && candidate.characterId === characterId) {
          evidenceIds.push(singleId);
          evidenceSeen.add(singleId);
        }
      }
    }

    if (!evidenceIds.length) continue;

    let actOrderIndex = asOptionalNumber(record.actOrderIndex ?? record.actIndex ?? record.act) ?? null;
    if (actOrderIndex !== null) {
      actOrderIndex = Math.floor(actOrderIndex);
      if (!knownActOrderIndexes.has(actOrderIndex)) {
        actOrderIndex = null;
      }
    }

    if (actOrderIndex === null) {
      const candidates = evidenceIds
        .map((id) => candidateByEvidenceId.get(id))
        .filter((entry): entry is AppearanceEvidenceCandidateInput => Boolean(entry));
      const scoreByAct = new Map<number, number>();
      for (const candidate of candidates) {
        if (candidate.actOrderIndex === null || candidate.actOrderIndex < 0) continue;
        scoreByAct.set(candidate.actOrderIndex, (scoreByAct.get(candidate.actOrderIndex) || 0) + 1);
      }
      const bestAct = [...scoreByAct.entries()].sort((left, right) => {
        if (left[1] !== right[1]) return right[1] - left[1];
        return left[0] - right[0];
      })[0];
      actOrderIndex = bestAct ? bestAct[0] : null;
    }

    parsed.push({
      characterId,
      attributeKey,
      attributeLabel,
      value,
      scope: normalizeAppearanceScope(record.scope),
      actOrderIndex,
      summary: normalizeAppearanceSummary(record.summary ?? record.note),
      confidence: clamp01(asOptionalNumber(record.confidence) ?? 0.7),
      evidenceIds: evidenceIds.slice(0, 8),
    });
  }

  const deduped = new Map<string, ParsedObservation>();
  for (const item of parsed) {
    const key = `${item.characterId}:${item.attributeKey}:${item.value.toLowerCase()}:${item.actOrderIndex ?? "none"}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }

    if (item.confidence > existing.confidence) {
      existing.confidence = item.confidence;
    }
    if (!existing.summary && item.summary) {
      existing.summary = item.summary;
    }
    if (existing.scope === "scene" && item.scope !== "scene") {
      existing.scope = item.scope;
    }
    const mergedEvidenceIds = [...existing.evidenceIds, ...item.evidenceIds];
    const seenEvidence = new Set<string>();
    existing.evidenceIds = mergedEvidenceIds.filter((id) => {
      if (seenEvidence.has(id)) return false;
      seenEvidence.add(id);
      return true;
    });
    existing.evidenceIds = existing.evidenceIds.slice(0, 8);
  }

  const parsedContentVersion = asOptionalNumber(root.contentVersion);
  const contentVersion =
    parsedContentVersion !== null && Number.isInteger(parsedContentVersion) && parsedContentVersion >= 0
      ? parsedContentVersion
      : input.contentVersion;

  const observations = [...deduped.values()].sort((left, right) => {
    if (left.characterId !== right.characterId) return left.characterId.localeCompare(right.characterId);
    const leftAct = left.actOrderIndex ?? Number.MAX_SAFE_INTEGER;
    const rightAct = right.actOrderIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftAct !== rightAct) return leftAct - rightAct;
    if (left.attributeLabel !== right.attributeLabel) {
      return left.attributeLabel.localeCompare(right.attributeLabel, "ru", { sensitivity: "base" });
    }
    return left.value.localeCompare(right.value, "ru", { sensitivity: "base" });
  });

  return {
    contentVersion,
    observations: observations.slice(0, 1500).map((item, index) => ({
      orderIndex: index,
      characterId: item.characterId,
      attributeKey: item.attributeKey,
      attributeLabel: item.attributeLabel,
      value: item.value,
      scope: item.scope,
      actOrderIndex: item.actOrderIndex,
      summary: item.summary,
      confidence: clamp01(item.confidence),
      evidenceIds: item.evidenceIds.slice(0, 8),
    })),
  };
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

export async function runBookChapterSummary(
  input: BookChapterSummaryInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterSummaryResult>> {
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || "Без названия главы";
  const chapterText = truncateText(collapseWhitespace(input.chapterText), 6000);

  const prompt = [
    "Ты формируешь краткое summary главы художественной книги.",
    "",
    "Задача:",
    "- Напиши РОВНО 1 предложение на русском языке.",
    "- Максимум 200 символов.",
    "- Только факты из текста главы, без домыслов и оценок.",
    "- Без цитат и без спойлерных формулировок уровня финала книги.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"summary":"..."}',
    "",
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_chapter_summary",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookChapterSummaryPayload(raw.result);
  return {
    result: BookChapterSummaryResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookSummaryFromChapterSummaries(
  input: BookSummaryFromChapterSummariesInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookSummaryFromChapterSummariesResult>> {
  const bookTitle = truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия";
  const author = truncateText(collapseWhitespace(String(input.author || "")), 180) || null;
  const chapterSummaries = input.chapterSummaries
    .map((chapter) => ({
      orderIndex: chapter.orderIndex,
      title: truncateText(collapseWhitespace(chapter.title), 160) || `Глава ${chapter.orderIndex}`,
      summary: truncateText(collapseWhitespace(chapter.summary), 220),
    }))
    .filter((chapter) => chapter.summary.length > 0)
    .slice(0, 240);

  if (!chapterSummaries.length) {
    throw new Error("book_summary requires non-empty chapter summaries");
  }

  const prompt = [
    "Ты формируешь общее краткое summary книги по summary глав.",
    "",
    "Задача:",
    "- Напиши 1-2 предложения на русском языке.",
    "- Максимум 280 символов суммарно.",
    "- Сконцентрируйся на главной сути и динамике книги.",
    "- Только факты из входных summary глав, без домыслов.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"summary":"..."}',
    "",
    `bookTitle: ${JSON.stringify(bookTitle)}`,
    `author: ${JSON.stringify(author)}`,
    `chapterSummaries: ${JSON.stringify(chapterSummaries)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_summary",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookSummaryPayload(raw.result);
  return {
    result: BookSummaryFromChapterSummariesResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookChapterCharacters(
  input: BookChapterCharactersInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterCharactersResult>> {
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || "Без названия главы";
  const chapterText = truncateText(collapseWhitespace(input.chapterText), 6000);

  const prompt = [
    "Ты извлекаешь персонажей из одной главы художественной книги.",
    "",
    "Задача:",
    "- Верни список персонажей, явно присутствующих в тексте главы.",
    "- Для каждого персонажа укажи роль в этой главе.",
    "- mentionCount должен быть целым положительным числом.",
    "- Добавь короткие цитаты/фрагменты только из текста главы (с кратким контекстом).",
    "- Максимум 12 персонажей на главу.",
    "- Максимум 3 цитаты на персонажа.",
    "- Не добавляй домыслы и информацию вне главы.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"characters":[{"name":"...","aliases":["..."],"roleInChapter":"...","mentionCount":1,"quotes":[{"text":"...","context":"..."}]}]}',
    "",
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_chapter_characters",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookChapterCharactersPayload(raw.result);
  return {
    result: BookChapterCharactersResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookCharacterProfileSynthesis(
  input: BookCharacterProfileSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookCharacterProfileSynthesisResult>> {
  const chapterSignals = input.chapterSignals
    .map((signal) => ({
      chapterOrderIndex: signal.chapterOrderIndex,
      chapterTitle: truncateText(collapseWhitespace(signal.chapterTitle), 160) || `Глава ${signal.chapterOrderIndex}`,
      roleInChapter: truncateText(collapseWhitespace(signal.roleInChapter), 180) || "Участник событий",
      quotes: signal.quotes
        .map((quote) => ({
          text: truncateText(collapseWhitespace(quote.text), 220),
          context: truncateText(collapseWhitespace(quote.context), 220),
        }))
        .filter((quote) => quote.text && quote.context)
        .slice(0, 3),
    }))
    .slice(0, 18);

  const payload = {
    bookTitle: truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия",
    bookAuthor: truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null,
    characterName: truncateText(collapseWhitespace(input.characterName), 140) || "Персонаж",
    aliases: normalizeStringList(input.aliases, 16, 140),
    mentionCount: Math.max(1, Math.round(input.mentionCount || 1)),
    firstAppearanceChapterOrder:
      input.firstAppearanceChapterOrder && Number.isFinite(input.firstAppearanceChapterOrder)
        ? Math.max(1, Math.round(input.firstAppearanceChapterOrder))
        : null,
    chapterSignals,
  };

  const prompt = [
    "Ты формируешь профиль персонажа по агрегированным данным из нескольких глав.",
    "",
    "Нужно вернуть 3 поля:",
    "- role: краткая роль персонажа в книге (до 140 символов).",
    "- description: фактическая характеристика персонажа (1-2 предложения, до 360 символов).",
    "- arc: как меняется/раскрывается персонаж по главам (1-2 предложения, до 360 символов).",
    "",
    "Правила:",
    "- Только по входным данным.",
    "- Без домыслов и новых фактов.",
    "- Текст на русском языке.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"role":"...","description":"...","arc":"..."}',
    "",
    `input: ${JSON.stringify(payload)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_character_profile",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookCharacterProfileSynthesisPayload(raw.result, payload);
  return {
    result: BookCharacterProfileSynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookChapterLocations(
  input: BookChapterLocationsInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterLocationsResult>> {
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || "Без названия главы";
  const chapterText = truncateText(collapseWhitespace(input.chapterText), 6000);

  const prompt = [
    "Ты извлекаешь локации из одной главы художественной книги.",
    "",
    "Задача:",
    "- Верни список локаций, явно присутствующих в тексте главы.",
    "- Для каждой локации укажи функцию в этой главе.",
    "- mentionCount должен быть целым положительным числом.",
    "- Добавь короткие цитаты/фрагменты только из текста главы (с кратким контекстом).",
    "- Максимум 12 локаций на главу.",
    "- Максимум 3 цитаты на локацию.",
    "- Не добавляй домыслы и информацию вне главы.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"locations":[{"name":"...","aliases":["..."],"functionInChapter":"...","mentionCount":1,"quotes":[{"text":"...","context":"..."}]}]}',
    "",
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_chapter_locations",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookChapterLocationsPayload(raw.result);
  return {
    result: BookChapterLocationsResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookLocationProfileSynthesis(
  input: BookLocationProfileSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLocationProfileSynthesisResult>> {
  const chapterSignals = input.chapterSignals
    .map((signal) => ({
      chapterOrderIndex: signal.chapterOrderIndex,
      chapterTitle: truncateText(collapseWhitespace(signal.chapterTitle), 160) || `Глава ${signal.chapterOrderIndex}`,
      functionInChapter: truncateText(collapseWhitespace(signal.functionInChapter), 220) || "Важная локация главы",
      quotes: signal.quotes
        .map((quote) => ({
          text: truncateText(collapseWhitespace(quote.text), 220),
          context: truncateText(collapseWhitespace(quote.context), 220),
        }))
        .filter((quote) => quote.text && quote.context)
        .slice(0, 3),
    }))
    .slice(0, 18);

  const payload = {
    bookTitle: truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия",
    bookAuthor: truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null,
    locationName: truncateText(collapseWhitespace(input.locationName), 140) || "Локация",
    aliases: normalizeStringList(input.aliases, 16, 140),
    mentionCount: Math.max(1, Math.round(input.mentionCount || 1)),
    firstAppearanceChapterOrder:
      input.firstAppearanceChapterOrder && Number.isFinite(input.firstAppearanceChapterOrder)
        ? Math.max(1, Math.round(input.firstAppearanceChapterOrder))
        : null,
    chapterSignals,
  };

  const prompt = [
    "Ты формируешь профиль локации по агрегированным данным из нескольких глав.",
    "",
    "Нужно вернуть 2 поля:",
    "- description: фактическое описание локации (1-2 предложения, до 360 символов).",
    "- significance: значение локации в произведении (1-2 предложения, до 360 символов).",
    "",
    "Правила:",
    "- Только по входным данным.",
    "- Без домыслов и новых фактов.",
    "- Текст на русском языке.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"description":"...","significance":"..."}',
    "",
    `input: ${JSON.stringify(payload)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_location_profile",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookLocationProfileSynthesisPayload(raw.result, payload);
  return {
    result: BookLocationProfileSynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookChapterThemes(
  input: BookChapterThemesInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterThemesResult>> {
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || "Без названия главы";
  const chapterText = truncateText(collapseWhitespace(input.chapterText), 6000);

  const prompt = [
    "Ты извлекаешь ключевые темы из одной главы художественной книги.",
    "",
    "Задача:",
    "- Верни список тем, явно проявляющихся в тексте главы.",
    "- Для каждой темы укажи, как она проявляется в этой главе.",
    "- mentionCount должен быть целым положительным числом.",
    "- Добавь короткие цитаты/фрагменты только из текста главы (с кратким контекстом).",
    "- Максимум 12 тем на главу.",
    "- Максимум 3 цитаты на тему.",
    "- Не добавляй домыслы и информацию вне главы.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"themes":[{"name":"...","aliases":["..."],"manifestationInChapter":"...","mentionCount":1,"quotes":[{"text":"...","context":"..."}]}]}',
    "",
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_chapter_themes",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookChapterThemesPayload(raw.result);
  return {
    result: BookChapterThemesResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookThemeProfileSynthesis(
  input: BookThemeProfileSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookThemeProfileSynthesisResult>> {
  const chapterSignals = input.chapterSignals
    .map((signal) => ({
      chapterOrderIndex: signal.chapterOrderIndex,
      chapterTitle: truncateText(collapseWhitespace(signal.chapterTitle), 160) || `Глава ${signal.chapterOrderIndex}`,
      manifestationInChapter:
        truncateText(collapseWhitespace(signal.manifestationInChapter), 220) || "Ключевая тема главы",
      quotes: signal.quotes
        .map((quote) => ({
          text: truncateText(collapseWhitespace(quote.text), 220),
          context: truncateText(collapseWhitespace(quote.context), 220),
        }))
        .filter((quote) => quote.text && quote.context)
        .slice(0, 3),
    }))
    .slice(0, 18);

  const payload = {
    bookTitle: truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия",
    bookAuthor: truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null,
    themeName: truncateText(collapseWhitespace(input.themeName), 140) || "Тема",
    aliases: normalizeStringList(input.aliases, 16, 140),
    mentionCount: Math.max(1, Math.round(input.mentionCount || 1)),
    firstAppearanceChapterOrder:
      input.firstAppearanceChapterOrder && Number.isFinite(input.firstAppearanceChapterOrder)
        ? Math.max(1, Math.round(input.firstAppearanceChapterOrder))
        : null,
    chapterSignals,
  };

  const prompt = [
    "Ты формируешь профиль темы по агрегированным данным из нескольких глав.",
    "",
    "Нужно вернуть 2 поля:",
    "- description: фактическое описание темы (1-2 предложения, до 360 символов).",
    "- development: как тема развивается в произведении (1-2 предложения, до 360 символов).",
    "",
    "Правила:",
    "- Только по входным данным.",
    "- Без домыслов и новых фактов.",
    "- Текст на русском языке.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"description":"...","development":"..."}',
    "",
    `input: ${JSON.stringify(payload)}`,
  ].join("\\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_theme_profile",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookThemeProfileSynthesisPayload(raw.result, payload);
  return {
    result: BookThemeProfileSynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookChapterQuotes(
  input: BookChapterQuotesInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterQuotesResult>> {
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || "Без названия главы";
  const chapterText = truncateText(String(input.chapterText || ""), 16000);

  const prompt = [
    "Ты извлекаешь цитаты из одной главы художественной книги.",
    "",
    "Задача:",
    "- Верни плотную, но чистую сегментацию цитат по тексту главы.",
    "- Цитата должна быть точным фрагментом главы, без перефразирования.",
    "- Для каждой цитаты укажи startChar/endChar в координатах chapterText.",
    "- type выбирай только из: dialogue, monologue, narration, description, reflection, action.",
    "- tags выбирай только из: conflict, relationship, identity, morality, power, freedom, fear, guilt, hope, fate, society, violence, love, death, faith.",
    "- confidence от 0 до 1.",
    "- mentions: кандидаты weak-label (kind только character/theme/location) со span в координатах текста цитаты.",
    "- commentary: короткая фактическая пометка о смысле цитаты.",
    "- Максимум 48 цитат на главу.",
    "- Не добавляй фактов вне текста главы.",
    "",
    "Формат ответа:",
    'Верни только строгий JSON-объект вида {"quotes":[{"text":"...","startChar":0,"endChar":10,"type":"narration","tags":["conflict"],"confidence":0.8,"commentary":"...","mentions":[{"kind":"character","value":"...","normalizedValue":"...","startChar":0,"endChar":4,"confidence":0.8}]}]}',
    "",
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_chapter_quotes",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookChapterQuotesPayload(raw.result, chapterText);
  return {
    result: BookChapterQuotesResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookChapterLiterarySynthesis(
  input: BookChapterLiterarySynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLiterarySynthesisResult>> {
  const bookTitle = truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия";
  const bookAuthor = truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null;
  const chapterTitle = truncateText(collapseWhitespace(input.chapterTitle), 180) || `Глава ${Math.max(1, Math.floor(input.chapterOrderIndex || 1))}`;
  const chapterOrderIndex = Math.max(1, Math.floor(input.chapterOrderIndex || 1));
  const chapterText = truncateText(String(input.chapterText || ""), 12000);

  const sectionKeys = BOOK_LITERARY_SECTION_KEYS.join(", ");
  const prompt = [
    "Ты формируешь литературный анализ только по одной главе художественной книги.",
    "Нельзя использовать знания вне chapterText.",
    "",
    "Нужно вернуть РОВНО 10 разделов с ключами:",
    sectionKeys,
    "",
    "Для каждого раздела верни поля:",
    "- title: название раздела по смыслу ключа.",
    "- summary: 1-2 предложения, до 360 символов.",
    "- bodyMarkdown: 2-5 абзацев анализа по этой главе.",
    "- bullets: 2-6 коротких тезисов.",
    "- evidenceQuoteIds: пустой массив [].",
    "- confidence: число 0..1.",
    "",
    "Критические правила:",
    "1) Только строгий JSON-объект.",
    "2) Корневой ключ sections обязателен.",
    "3) sections должен содержать все 10 ключей.",
    "4) Никаких фактов вне chapterText.",
    "",
    `bookTitle: ${JSON.stringify(bookTitle)}`,
    `bookAuthor: ${JSON.stringify(bookAuthor)}`,
    `chapterOrderIndex: ${chapterOrderIndex}`,
    `chapterTitle: ${JSON.stringify(chapterTitle)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
    maxTokens: resolveBookLiteraryMaxTokens(),
  });

  const normalized = normalizeBookLiterarySynthesisPayload(raw.result);
  return {
    result: BookLiterarySynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

const BOOK_LITERARY_CHAPTER_FACTS_VERTEX_PROFILE = {
  model: "gemini-3.1-flash-lite-preview",
  thinkingLevel: "MINIMAL" as const,
};

const BOOK_LITERARY_PATTERN_PASS_VERTEX_PROFILE = {
  model: "gemini-3.1-pro-preview",
  thinkingLevel: "LOW" as const,
};

const BOOK_LITERARY_FINAL_VERTEX_PROFILE = {
  model: "gemini-3.1-flash-lite-preview",
  thinkingLevel: "MINIMAL" as const,
};

export async function runBookChapterStructuralFacts(
  input: BookChapterStructuralFactsInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookChapterStructuralFactsResult>> {
  const chapterText = truncateText(String(input.chapterText || ""), 12000);

  const prompt = [
    "Ты извлекаешь СТРУКТУРНЫЕ ФАКТЫ из одной главы художественного произведения.",
    "",
    "Это не анализ.",
    "Это не интерпретация.",
    "Это не пересказ всей главы подряд.",
    "Это не попытка объяснить смысл книги.",
    "",
    "Твоя задача — собрать только такие факты, которые потом помогут объяснить книгу на уровне всей истории.",
    "",
    "Можно использовать ТОЛЬКО:",
    "- chapterText",
    "",
    "НЕЛЬЗЯ:",
    "- использовать знания вне chapterText",
    "- придумывать",
    "- подмешивать события из других глав",
    "- писать темы, идеи, мораль, авторскую позицию",
    "- делать \"красивые\" или слишком умные формулировки",
    "- интерпретировать предметы и образы",
    "- использовать слова:",
    "  - \"символизирует\"",
    "  - \"подчеркивает\"",
    "  - \"отражает\"",
    "  - \"демонстрирует\"",
    "  - \"метафора\"",
    "  - \"аллегория\"",
    "  - \"указывает на тему\"",
    "  - \"раскрывает идею\"",
    "",
    "НУЖНО ВЕРНУТЬ ТОЛЬКО СТРОГИЙ JSON:",
    "",
    "{",
    '  "events": [',
    "    {",
    '      "id": "",',
    '      "description": "",',
    '      "characters": [],',
    '      "importance": 0',
    "    }",
    "  ],",
    '  "characterChanges": [',
    "    {",
    '      "character": "",',
    '      "before": "",',
    '      "after": "",',
    '      "reason": ""',
    "    }",
    "  ],",
    '  "conflicts": [',
    "    {",
    '      "type": "external|internal",',
    '      "description": "",',
    '      "participants": []',
    "    }",
    "  ],",
    '  "symbols": [',
    "    {",
    '      "entity": "",',
    '      "description": "",',
    '      "context": ""',
    "    }",
    "  ],",
    '  "facts": []',
    "}",
    "",
    "ПРАВИЛА:",
    "",
    "1. events",
    "- 4–10 событий",
    "- бери только реально важные события главы",
    "- description = коротко, конкретно, только что произошло",
    "- без выводов и без объяснения значения события",
    "- importance = число от 0 до 1",
    "- не дроби одну сцену на много микрособытий",
    "- не добавляй бытовые действия, если они ничего не меняют",
    "",
    "2. characterChanges",
    "- добавляй только если в главе реально меняется:",
    "  - состояние",
    "  - отношение",
    "  - понимание",
    "  - цель",
    "  - уровень страха/уверенности",
    "- before и after должны быть конкретными и наблюдаемыми",
    "- reason должен указывать на конкретное событие внутри главы",
    "- максимум 1–3 изменений",
    "",
    "3. conflicts",
    "- 1–4 конфликта",
    "- только те конфликты, которые явно проявлены в главе",
    "- external = персонаж против персонажа / системы / угрозы",
    "- internal = страх / сомнение / внутренний выбор / сдерживание",
    "- не пиши общо вроде \"борьба добра и зла\"",
    "",
    "4. symbols",
    "- 0–3 элемента",
    "- добавляй только если объект, образ или существо заметно выделены внутри главы и могут пригодиться дальше",
    "- description = что это такое в рамках главы",
    "- context = где и как это появляется",
    "- не объясняй \"что это значит\"",
    "- если не уверен — не добавляй",
    "",
    "5. facts",
    "- 4–8 фактов",
    "- facts должен быть массивом строк",
    "- каждый элемент facts = одна короткая строка с одним конкретным фактом",
    "- без вложенных объектов",
    "- без списков внутри строк",
    "- без повторов событий слово в слово",
    "- это могут быть:",
    "  - новые сведения",
    "  - ограничения",
    "  - связи между персонажами",
    "  - правила мира",
    "  - даты",
    "  - решения",
    "  - статусы",
    "  - обвинения",
    "  - свойства предметов",
    "",
    "6. Стиль",
    "- пиши просто",
    "- пиши конкретно",
    "- без литературоведческого языка",
    "- без морали",
    "- без метафор от себя",
    "- без смешения языков: если вход на русском, весь ответ должен быть на русском",
    "",
    "7. Анти-шум",
    "НЕ ДОБАВЛЯЙ:",
    "- незначительные бытовые детали",
    "- фоновые мелочи",
    "- выводы о книге в целом",
    "- слишком смелые трактовки",
    "- \"символы\", если это просто предмет из сцены без заметной функции",
    "- ничего, что нельзя прямо или почти прямо проверить по тексту главы",
    "",
    "8. Проверка перед ответом",
    "Проверь, что:",
    "- facts — это массив строк",
    "- нигде нет \"[object Object]\"",
    "- events[].description содержит только событие",
    "- symbols не содержат интерпретации",
    "- в ответе нет английского, если chapterText на русском",
    "",
    "Если сомневаешься — выбери более узкую и фактическую формулировку.",
    "",
    "9. Только JSON",
    "- без markdown",
    "- без комментариев",
    "- без пояснений вне структуры",
    "",
    "Входные данные:",
    `bookTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия")}`,
    `bookAuthor: ${JSON.stringify(truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null)}`,
    `chapterOrderIndex: ${Math.max(1, Math.floor(input.chapterOrderIndex || 1))}`,
    `chapterTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.chapterTitle), 220) || `Глава ${Math.max(1, Math.floor(input.chapterOrderIndex || 1))}`)}`,
    `chapterText: ${JSON.stringify(chapterText)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
    vertexModel: BOOK_LITERARY_CHAPTER_FACTS_VERTEX_PROFILE.model,
    vertexThinkingLevel: BOOK_LITERARY_CHAPTER_FACTS_VERTEX_PROFILE.thinkingLevel,
    maxTokens: resolveBookLiteraryMaxTokens(),
  });

  const normalized = normalizeBookChapterStructuralFactsPayload(raw.result);
  return {
    result: BookChapterStructuralFactsResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

function sanitizeBookChapterFactsForLiteraryPrompt(chapterFactsInput: BookLiteraryMergeFactsChapterInput[]) {
  return chapterFactsInput.slice(0, 120).map((chapter) => ({
    chapterOrderIndex: Math.max(1, Math.floor(chapter.chapterOrderIndex || 1)),
    chapterTitle:
      truncateText(collapseWhitespace(chapter.chapterTitle), 160) ||
      `Глава ${Math.max(1, Math.floor(chapter.chapterOrderIndex || 1))}`,
    events: chapter.facts.events
      .slice(0, 10)
      .map((item) => ({
        id: truncateText(collapseWhitespace(item.id), 80),
        description: truncateText(collapseWhitespace(item.description), 280),
        characters: item.characters
          .slice(0, 8)
          .map((value) => truncateText(collapseWhitespace(value), 120))
          .filter((value) => value.length > 0),
        importance: clamp01(item.importance),
      }))
      .filter((item) => item.id.length > 0 && item.description.length > 0),
    characterChanges: chapter.facts.characterChanges
      .slice(0, 3)
      .map((item) => ({
        character: truncateText(collapseWhitespace(item.character), 120),
        before: truncateText(collapseWhitespace(item.before), 220),
        after: truncateText(collapseWhitespace(item.after), 220),
        reason: truncateText(collapseWhitespace(item.reason), 260),
      }))
      .filter((item) => item.character && item.before && item.after && item.reason),
    conflicts: chapter.facts.conflicts
      .slice(0, 4)
      .map((item) => ({
        type: item.type === "internal" ? "internal" : "external",
        description: truncateText(collapseWhitespace(item.description), 260),
        participants: item.participants
          .slice(0, 8)
          .map((value) => truncateText(collapseWhitespace(value), 120))
          .filter((value) => value.length > 0),
      }))
      .filter((item) => item.description.length > 0),
    symbols: chapter.facts.symbols
      .slice(0, 3)
      .map((item) => ({
        entity: truncateText(collapseWhitespace(item.entity), 120),
        description: truncateText(collapseWhitespace(item.description), 220),
        context: truncateText(collapseWhitespace(item.context), 260),
      }))
      .filter((item) => item.entity && item.description && item.context),
    facts: chapter.facts.facts
      .slice(0, 8)
      .map((value) => truncateText(collapseWhitespace(value), 260))
      .filter((value) => value.length > 0),
  }));
}

export async function runBookLiteraryPatternPass(
  input: BookLiteraryPatternPassInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLiteraryPatternPassResult>> {
  const chapterFacts = sanitizeBookChapterFactsForLiteraryPrompt(input.chapterFacts);
  const prompt = [
    "Ты извлекаешь ПАТТЕРНЫ книги из массива chapterFacts.",
    "",
    "Это не финальное объяснение книги.",
    "Это не литературный анализ.",
    "Это промежуточный слой между фактами глав и финальным объяснением.",
    "",
    "Твоя задача — найти не \"темы вообще\", а повторяющиеся смысловые ходы, которые проходят через несколько глав и реально объясняют, как устроена именно эта книга.",
    "",
    "Можно использовать ТОЛЬКО:",
    "- chapterFacts",
    "",
    "НЕЛЬЗЯ:",
    "- использовать знания вне chapterFacts",
    "- придумывать",
    "- писать слишком общо",
    "- писать названия паттернов, которые подходят почти к любой книге",
    "- использовать имена конкретных персонажей в name",
    "- превращать паттерны в моральные выводы",
    "",
    "НУЖНО ВЕРНУТЬ ТОЛЬКО СТРОГИЙ JSON:",
    "",
    "{",
    '  "patterns": [',
    "    {",
    '      "id": "",',
    '      "name": "",',
    '      "core": "",',
    '      "whyItMatters": "",',
    '      "evidence": [',
      "        {",
    '          "type": "event|characterChange|conflict|symbol|fact",',
    '          "chapter": 0,',
    '          "ref": ""',
    "        }",
    "      ],",
    '      "evolution": "",',
    '      "strength": 0',
    "    }",
    "  ]",
    "}",
    "",
    "ПРАВИЛА:",
    "",
    "1. Количество",
    "- 4–7 паттернов",
    "- не меньше 4, если материала достаточно",
    "- выбирай только реально несущие паттерны",
    "",
    "2. Что такое паттерн",
    "Паттерн — это не тема вроде \"дружба\" или \"добро и зло\".",
    "Паттерн — это повторяющийся смысловой ход или разворот, который:",
    "- опирается на несколько глав",
    "- имеет развитие",
    "- помогает объяснить книгу лучше, чем просто пересказ",
    "",
    "Плохие паттерны:",
    "- \"дружба\"",
    "- \"предательство\"",
    "- \"добро и зло\"",
    "- \"страх\"",
    "- \"взросление\"",
    "",
    "Хороший паттерн:",
    "- показывает, ЧТО именно меняется",
    "- имеет конкретную траекторию",
    "- помогает объяснить ключевой механизм книги",
    "",
    "3. Поля",
    "- id: p1, p2, p3 ...",
    "- name: короткое понятное название паттерна без имен персонажей",
    "- core: формула изменения в виде \"X -> Y\"",
    "- whyItMatters: зачем этот паттерн важен для понимания книги",
    "- evidence: конкретные опоры из chapterFacts",
    "- evolution: как этот паттерн развивается по книге",
    "- strength: число от 0 до 1, где 1 = один из центральных паттернов книги",
    "",
    "4. Требования к паттерну",
    "Каждый паттерн должен:",
    "- опираться минимум на 2 главы",
    "- содержать изменение, сдвиг, накопление или разворот",
    "- быть достаточно конкретным для финального объяснения",
    "- объяснять книгу, а не просто красиво звучать",
    "",
    "5. Требования к evidence",
    "- 3–6 опор на паттерн",
    "- опоры должны быть распределены по книге, а не собраны из одного места",
    "- ref = короткое и понятное описание конкретного факта из chapterFacts",
    "- не дублируй один и тот же смысл разными словами",
    "",
    "6. Стиль",
    "- просто",
    "- конкретно",
    "- без академического языка",
    "- без канцелярита",
    "- без морализации",
    "",
    "7. Анти-абстракция",
    "Если паттерн можно вставить почти в любую книгу — он плохой.",
    "Если из паттерна непонятно, ЧТО именно меняется — он плохой.",
    "Если паттерн не объясняет один из ключевых механизмов книги — он слабый.",
    "",
    "8. Полезность для final",
    "Выбирай такие паттерны, из которых потом можно построить понятные разделы:",
    "- что реально происходит",
    "- главный поворот",
    "- как работает история",
    "- важные скрытые детали",
    "- ключевые развороты",
    "",
    "9. Только JSON",
    "- без markdown",
    "- без комментариев",
    "- без пояснений вне структуры",
    "",
    "Вход:",
    `bookTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия")}`,
    `chapterCount: ${Math.max(0, Math.floor(input.chapterCount || 0))}`,
    `chapterFacts: ${JSON.stringify(chapterFacts)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
    vertexModel: BOOK_LITERARY_PATTERN_PASS_VERTEX_PROFILE.model,
    vertexThinkingLevel: BOOK_LITERARY_PATTERN_PASS_VERTEX_PROFILE.thinkingLevel,
    maxTokens: resolveBookLiteraryMaxTokens(),
  });

  const normalized = normalizeBookLiteraryPatternPassPayload(raw.result);
  return {
    result: BookLiteraryPatternPassResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookLiterarySynthesisFromChapterFacts(
  input: BookLiteraryMergeFactsSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLiterarySynthesisResult>> {
  const chapterFacts = sanitizeBookChapterFactsForLiteraryPrompt(input.chapterFacts);
  const patterns = input.patterns
    .slice(0, 7)
    .map((pattern) => ({
      id: truncateText(collapseWhitespace(pattern.id), 80),
      name: truncateText(collapseWhitespace(pattern.name), 160),
      core: truncateText(collapseWhitespace(pattern.core), 220),
      whyItMatters: truncateText(collapseWhitespace(pattern.whyItMatters), 420),
      evidence: pattern.evidence
        .slice(0, 6)
        .map((item) => ({
          type: item.type,
          chapter: Math.min(5000, Math.max(1, Math.floor(item.chapter || 1))),
          ref: truncateText(collapseWhitespace(item.ref), 260),
        }))
        .filter((item) => item.ref.length > 0),
      evolution: truncateText(collapseWhitespace(pattern.evolution), 720),
      strength: clamp01(pattern.strength),
    }))
    .filter((pattern) => pattern.id && pattern.name && pattern.core && pattern.whyItMatters && pattern.evolution);

  const prompt = [
    "Ты объясняешь художественную книгу простым, живым и понятным языком.",
    "",
    "Это не академический анализ.",
    "Это не школьное сочинение.",
    "Это не пересказ по главам.",
    "Это не набор \"уроков жизни\".",
    "",
    "Твоя задача — помочь обычному человеку быстро и ясно понять:",
    "- что в книге на самом деле происходит",
    "- в чем главный смысловой поворот",
    "- почему эта история работает",
    "- какие детали легко пропустить, хотя они очень важны",
    "",
    "Можно использовать ТОЛЬКО:",
    "- chapterFacts",
    "- patterns",
    "",
    "НЕЛЬЗЯ:",
    "- использовать знания вне входных данных",
    "- придумывать",
    "- писать слишком общо",
    "- писать мораль, поучения и универсальные выводы",
    "- писать фразы, которые подойдут почти к любой книге",
    "- использовать академический, сухой или канцелярский язык",
    "- уходить в \"красивые формулировки\" без фактов",
    "",
    "НЕЛЬЗЯ писать такие формулировки:",
    "- \"книга учит\"",
    "- \"мир не делится на черное и белое\"",
    "- \"не суди по внешнему виду\"",
    "- \"истина скрыта\"",
    "- \"герой взрослеет\"",
    "- \"поднимается тема\"",
    "- \"проблема доверия\"",
    "- \"добро и зло\"",
    "- \"моральный выбор\"",
    "- \"смотреть глубже очевидного\"",
    "",
    "ОБЩИЙ ПРИНЦИП:",
    "Не объясняй, какую мораль надо вынести.",
    "Объясняй, что здесь реально происходит и почему это работает.",
    "",
    "ФОРМАТ ОТВЕТА:",
    "Только строгий JSON.",
    "",
    "{",
    '  "sections": {',
    '    "what_is_really_going_on": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "main_idea": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "how_it_works": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "hidden_details": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "characters": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "conflicts": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "structure": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "important_turns": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "takeaways": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    },",
    '    "conclusion": {',
    '      "title": "",',
    '      "summary": "",',
    '      "bodyMarkdown": "",',
    '      "bullets": [],',
    '      "confidence": 0',
    "    }",
    "  }",
    "}",
    "",
    "ТРЕБОВАНИЯ К КАЖДОМУ РАЗДЕЛУ:",
    "- title: короткий и понятный заголовок",
    "- summary: 1–2 предложения, ясно и без абстракций",
    "- bodyMarkdown: 3–6 коротких абзацев",
    "- bullets: 4–7 тезисов",
    "- confidence: число от 0 до 1",
    "",
    "КРИТИЧЕСКИЕ ПРАВИЛА:",
    "",
    "1. Основа ответа — patterns.",
    "Каждый раздел должен строиться на 1–3 patterns и подтверждаться chapterFacts.",
    "",
    "2. Каждый абзац должен содержать:",
    "- конкретное событие, факт, разворот, объект или связь",
    "- что это меняет в понимании книги",
    "- почему это важно для общей картины",
    "",
    "3. Если фразу можно вставить почти в любую книгу — она плохая, перепиши.",
    "",
    "4. Если убрать из абзаца конкретные события, персонажей, предметы или повороты, и текст все равно выглядит \"умным\" — абзац плохой, перепиши.",
    "",
    "5. Не упрощай patterns до пустых слов.",
    "Не:",
    "- \"скрытая угроза\"",
    "- \"сложность истины\"",
    "- \"проблема доверия\"",
    "А:",
    "- кто считался опасным",
    "- кто оказался опасным на самом деле",
    "- какая деталь сначала казалась фоном, а потом стала ключом",
    "",
    "6. Пиши естественно.",
    "Плохой стиль:",
    "- \"персонаж, которого считают опасным\"",
    "- \"объект, воспринимаемый как угрозу\"",
    "Хороший стиль:",
    "- \"все думают, что он опасен\"",
    "- \"с виду это обычная вещь, но позже она оказывается ключевой\"",
    "",
    "7. Не пересказывай книгу подряд.",
    "Бери только те события, которые реально объясняют книгу.",
    "",
    "8. hidden_details",
    "Обязательно включай детали, которые сначала кажутся фоном, но потом оказываются важными.",
    "",
    "9. important_turns",
    "Выделяй только моменты, после которых понимание книги реально меняется.",
    "",
    "10. takeaways",
    "Это не мораль и не \"чему учит книга\".",
    "Это конкретные выводы о том, как устроена именно эта история.",
    "",
    "Плохо:",
    "- \"нужно смотреть глубже\"",
    "- \"нельзя судить по внешности\"",
    "- \"герой взрослеет\"",
    "Хорошо:",
    "- \"главный враг долго оставался рядом и выглядел безобидно\"",
    "- \"официальная версия событий скрывала настоящего предателя\"",
    "- \"герою пришлось самому действовать, потому что взрослые не смогли исправить ситуацию\"",
    "",
    "11. conclusion",
    "Не пиши философский итог и не подводи мораль.",
    "Пиши только:",
    "- что герой понял",
    "- что на самом деле оказалось правдой",
    "- что изменилось к финалу",
    "- чем заканчивается книга на уровне смысла",
    "",
    "12. Не повторяй одну и ту же мысль в разных разделах разными словами.",
    "Если разделы начинают дублировать друг друга — сделай их короче и конкретнее.",
    "",
    "13. Лучше подробнее, чем слишком коротко, но каждый абзац должен оставаться конкретным.",
    "Не раздувай текст ради объема.",
    "",
    "14. Если данных недостаточно для сильного вывода — скажи это прямо, не выдумывай.",
    "",
    "15. Никакого текста вне JSON.",
    "",
    "Вход:",
    `bookTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия")}`,
    `chapterFacts: ${JSON.stringify(chapterFacts)}`,
    `patterns: ${JSON.stringify(patterns)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
    vertexModel: BOOK_LITERARY_FINAL_VERTEX_PROFILE.model,
    vertexThinkingLevel: BOOK_LITERARY_FINAL_VERTEX_PROFILE.thinkingLevel,
  });

  const normalized = normalizeBookLiterarySynthesisPayload(raw.result);
  return {
    result: BookLiterarySynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookLiterarySynthesisFromChapterAnalyses(
  input: BookLiteraryMergeSynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLiterarySynthesisResult>> {
  const chapterAnalyses = input.chapterAnalyses
    .slice(0, 120)
    .map((chapter) => ({
      chapterOrderIndex: Math.max(1, Math.floor(chapter.chapterOrderIndex || 1)),
      chapterTitle:
        truncateText(collapseWhitespace(chapter.chapterTitle), 160) ||
        `Глава ${Math.max(1, Math.floor(chapter.chapterOrderIndex || 1))}`,
      sections: Object.fromEntries(
        BOOK_LITERARY_SECTION_KEYS.map((key) => {
          const section = chapter.sections[key];
          const title =
            truncateText(collapseWhitespace(section?.title || BOOK_LITERARY_SECTION_TITLE_BY_KEY[key]), 120) ||
            BOOK_LITERARY_SECTION_TITLE_BY_KEY[key];
          const summary = truncateText(
            collapseWhitespace(section?.summary || ""),
            260
          );
          const bodyMarkdown = truncateText(
            collapseWhitespace(section?.bodyMarkdown || ""),
            520
          );
          const bullets = (section?.bullets || [])
            .slice(0, 3)
            .map((item) => truncateText(collapseWhitespace(item), 140))
            .filter((item) => item.length > 0);
          const confidence = clamp01(Number(section?.confidence || 0.65));
          return [
            key,
            {
              title,
              summary,
              bodyMarkdown,
              bullets,
              confidence,
            },
          ] as const;
        })
      ) as Record<
        BookLiterarySectionKey,
        {
          title: string;
          summary: string;
          bodyMarkdown: string;
          bullets: string[];
          confidence: number;
        }
      >,
    }));

  const sectionKeys = BOOK_LITERARY_SECTION_KEYS.join(", ");
  const prompt = [
    "Ты объединяешь покапитульный литературный анализ в единый итоговый анализ книги.",
    "Работай только по входным chapterAnalyses, без внешних знаний.",
    "",
    "Нужно вернуть РОВНО 10 разделов с ключами:",
    sectionKeys,
    "",
    "Для каждого раздела верни поля:",
    "- title: название раздела по смыслу ключа.",
    "- summary: 1-2 предложения, до 360 символов.",
    "- bodyMarkdown: 3-8 абзацев, где отражена динамика по книге.",
    "- bullets: 3-8 ключевых тезисов.",
    "- evidenceQuoteIds: пустой массив [].",
    "- confidence: число 0..1.",
    "",
    "Критические правила:",
    "1) Только строгий JSON-объект.",
    "2) Корневой ключ sections обязателен.",
    "3) sections должен содержать все 10 ключей.",
    "4) Не теряй важные различия между главами, если они есть.",
    "",
    `bookTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия")}`,
    `bookAuthor: ${JSON.stringify(truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null)}`,
    `chapterCount: ${Math.max(0, Math.floor(input.chapterCount || 0))}`,
    `chapterAnalyses: ${JSON.stringify(chapterAnalyses)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookLiterarySynthesisPayload(raw.result);
  return {
    result: BookLiterarySynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runBookLiterarySynthesis(
  input: BookLiterarySynthesisInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<BookLiterarySynthesisResult>> {
  const quotes = input.quotes
    .slice(0, 220)
    .map((quote) => ({
      quoteId: quote.quoteId,
      chapterOrderIndex: quote.chapterOrderIndex,
      type: quote.type,
      tags: quote.tags.slice(0, 6),
      confidence: clamp01(quote.confidence),
      text: truncateText(collapseWhitespace(quote.text), 420),
      commentary: truncateText(collapseWhitespace(String(quote.commentary || "")), 220) || null,
      mentions: quote.mentions
        .slice(0, 8)
        .map((mention) => ({
          kind: mention.kind,
          value: truncateText(collapseWhitespace(mention.value), 120),
          confidence: clamp01(mention.confidence),
        }))
        .filter((mention) => mention.value.length > 0),
    }))
    .filter((quote) => quote.text.length > 0);

  if (!quotes.length) {
    throw new Error("book_literary requires non-empty quotes");
  }

  const sectionKeys = BOOK_LITERARY_SECTION_KEYS.join(", ");
  const prompt = [
    "Ты формируешь целостный литературный анализ произведения на русском языке.",
    "Работай строго в режиме quote-only: используй ТОЛЬКО переданные цитаты и метаданные.",
    "Нельзя добавлять факты, которых нет в цитатах.",
    "",
    "Нужно сформировать РОВНО 10 разделов с ключами:",
    sectionKeys,
    "",
    "Для каждого раздела верни объект полей:",
    '- title: человекочитаемый заголовок раздела (по смыслу ключа).',
    '- summary: 1-2 предложения, до 360 символов.',
    '- bodyMarkdown: связный анализ (2-6 абзацев) только по цитатам.',
    '- bullets: 2-6 кратких тезисов (массив строк).',
    '- evidenceQuoteIds: массив quoteId, только из входного списка.',
    '- confidence: число 0..1.',
    "",
    "Критические правила:",
    "1) Верни только строгий JSON-объект.",
    "2) Корневой объект должен иметь ключ sections.",
    "3) sections должен содержать ВСЕ 10 ключей, без пропусков.",
    "4) evidenceQuoteIds не могут содержать неизвестные quoteId.",
    "5) Никаких дополнительных полей вне оговоренного контракта.",
    "",
    `bookTitle: ${JSON.stringify(truncateText(collapseWhitespace(input.bookTitle), 220) || "Без названия")}`,
    `bookAuthor: ${JSON.stringify(truncateText(collapseWhitespace(String(input.bookAuthor || "")), 180) || null)}`,
    `chapterCount: ${Math.max(0, Math.floor(input.chapterCount || 0))}`,
    `quotes: ${JSON.stringify(quotes)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "book_literary",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeBookLiterarySynthesisPayload(raw.result);
  return {
    result: BookLiterarySynthesisResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
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

export async function runActPass(
  input: ActPassInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<ActPassResult>> {
  const paragraphRange =
    input.paragraphs.length > 0
      ? `${input.paragraphs[0].index}..${input.paragraphs[input.paragraphs.length - 1].index}`
      : "empty";
  const paragraphs = input.paragraphs.map((paragraph) => ({
    index: paragraph.index,
    text: truncateText(collapseWhitespace(paragraph.text), 1200),
  }));
  const characterSignals = input.characterSignals.slice(0, 1600).map((signal) => ({
    paragraphIndex: signal.paragraphIndex,
    characterId: signal.characterId,
    canonicalName: signal.canonicalName,
    mentionText: signal.mentionText,
  }));

  const prompt = [
    "You are segmenting a chapter of fiction into sequential acts (containers of actions).",
    "Act means a coherent episode of action (not a formal heading).",
    "",
    "STRICT RULES:",
    "1) Return only strict JSON object with keys: contentVersion, acts.",
    "2) acts[] must be ordered and contiguous by paragraph ranges.",
    "3) First act must start from the first paragraph index.",
    "4) Last act must end at the last paragraph index.",
    "5) No gaps and no overlaps between acts.",
    "6) Each act must include: title, summary, paragraphStart, paragraphEnd.",
    "7) Titles and summaries must be in Russian.",
    "8) title should be concise action label (3-12 words).",
    "9) summary should be 1-2 factual sentences about what happens.",
    "10) Do not output characters/entities arrays; only act boundaries + title + summary.",
    "",
    `contentVersion: ${input.contentVersion}`,
    `paragraphIndexRange: ${paragraphRange}`,
    `paragraphs: ${JSON.stringify(paragraphs)}`,
    `characterSignals: ${JSON.stringify(characterSignals)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "act_pass",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeActPassPayload(raw.result, input);
  return {
    result: ActPassResultSchema.parse(normalized),
    meta: raw.meta,
    debug: raw.debug,
  };
}

export async function runAppearancePass(
  input: AppearancePassInput,
  options?: { timewebModelId?: string | null }
): Promise<StrictJsonCallResult<AppearancePassResult>> {
  const acts = input.acts.slice(0, 160).map((act) => ({
    orderIndex: act.orderIndex,
    title: truncateText(collapseWhitespace(act.title), 240),
    summary: truncateText(collapseWhitespace(act.summary), 320),
    paragraphStart: act.paragraphStart,
    paragraphEnd: act.paragraphEnd,
  }));
  const evidenceCandidates = input.evidenceCandidates.slice(0, 2200).map((candidate) => ({
    evidenceId: candidate.evidenceId,
    characterId: candidate.characterId,
    canonicalName: candidate.canonicalName,
    actOrderIndex: candidate.actOrderIndex,
    actTitle: candidate.actTitle,
    paragraphIndex: candidate.paragraphIndex,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    mentionText: truncateText(collapseWhitespace(candidate.mentionText), 96),
    context: truncateText(collapseWhitespace(candidate.context), 320),
  }));

  const prompt = [
    "You are extracting appearance observations for fiction characters.",
    "Observation means explicit visual details: clothing, face, hair, body, visible condition, distinctive marks.",
    "",
    "STRICT RULES:",
    "1) Return strict JSON object with keys: contentVersion, observations.",
    "2) observation must include: characterId, attributeKey, attributeLabel, value, scope, actOrderIndex, confidence, evidenceIds.",
    "3) characterId must be from provided evidenceCandidates.",
    "4) evidenceIds must reference provided evidenceCandidates only.",
    "5) Do NOT invent any evidence ID.",
    "6) Use only explicit visual facts from context.",
    "7) Do NOT include personality or motives.",
    "8) scope must be one of: stable | temporary | scene.",
    "9) attributeLabel and value must be in Russian.",
    "10) If evidence is weak, skip observation.",
    "11) Keep value concise and factual.",
    "",
    `contentVersion: ${input.contentVersion}`,
    `acts: ${JSON.stringify(acts)}`,
    `evidenceCandidates: ${JSON.stringify(evidenceCandidates)}`,
  ].join("\n");

  const raw = await callStrictJson<unknown>({
    prompt,
    schema: z.any(),
    phase: "appearance_pass",
    timewebModelId: options?.timewebModelId || null,
  });

  const normalized = normalizeAppearancePassPayload(raw.result, input);
  return {
    result: AppearancePassResultSchema.parse(normalized),
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
