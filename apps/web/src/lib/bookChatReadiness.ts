import {
  BOOK_PIPELINE_STAGE_KEYS,
} from "@/lib/books";
import type {
  BookAnalysisViewKeyDTO,
  BookAnalyzerStateDTO,
  BookAnalyzerStatusDTO,
  BookChatModeDTO,
  BookChatReadinessDTO,
  BookChatReadinessStageDTO,
  BookPipelineStageKeyDTO,
} from "@/lib/books";

export const CHAT_READINESS_STAGE_ORDER = [...BOOK_PIPELINE_STAGE_KEYS] as const;

export type ChatReadinessStageKey = (typeof CHAT_READINESS_STAGE_ORDER)[number];

const CHAT_READINESS_STAGE_LABELS: Record<ChatReadinessStageKey, string> = {
  core_window_scan: "Семантическое извлечение",
  core_merge: "Сборка semantic core",
  core_resolve: "Канонический resolve",
  core_entity_mentions: "Явные упоминания сущностей",
  core_profiles: "Профили сущностей",
  core_quotes_finalize: "Нормализация цитат",
  core_literary: "Литературный слой",
  chat_index: "Чатовый индекс",
  canonical_text: "Канонический текст",
  scene_build: "Сцены книги",
  entity_graph: "Граф сущностей",
  event_relation_graph: "Граф событий и связей",
  summary_store: "Иерархия summary",
  evidence_store: "Опоры и доказательства",
  text_index: "Текстовый индекс",
  quote_store: "Цитаты",
};

const PENDING_STATES = new Set<BookAnalyzerStateDTO>(["queued", "running"]);
const EMPTY_STATUS = Object.freeze({
  state: "not_requested",
  error: null,
  startedAt: null,
  completedAt: null,
} satisfies BookAnalyzerStatusDTO);

export interface BookChatArtifactPresence {
  paragraphs: boolean;
  sentences: boolean;
  scenes: boolean;
  entities: boolean;
  events: boolean;
  summaries: boolean;
  evidence: boolean;
  quotes: boolean;
}

export function createEmptyAnalyzerStatus(): BookAnalyzerStatusDTO {
  return { ...EMPTY_STATUS };
}

export function isAnalyzerPending(state: BookAnalyzerStateDTO): boolean {
  return PENDING_STATES.has(state);
}

export function isAnalyzerCompleted(state: BookAnalyzerStateDTO): boolean {
  return state === "completed";
}

export function isAnalyzerFailed(state: BookAnalyzerStateDTO): boolean {
  return state === "failed";
}

function cloneStatus(status?: BookAnalyzerStatusDTO | null): BookAnalyzerStatusDTO {
  if (!status) return createEmptyAnalyzerStatus();
  return {
    state: status.state,
    error: status.error,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
  };
}

function buildStage(
  key: ChatReadinessStageKey,
  status: BookAnalyzerStatusDTO,
  overrides?: Partial<BookChatReadinessStageDTO>
): BookChatReadinessStageDTO {
  return {
    key,
    label: CHAT_READINESS_STAGE_LABELS[key],
    state: status.state,
    requiredForFast: key === "scene_build" || key === "entity_graph" || key === "summary_store" || key === "text_index",
    error: status.error,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    ...overrides,
  };
}

function markCompletedIfPresent(status: BookAnalyzerStatusDTO, present: boolean): BookAnalyzerStatusDTO {
  if (!present) return cloneStatus(status);
  if (status.state === "failed" || status.state === "running" || status.state === "queued") return cloneStatus(status);
  return {
    state: "completed",
    error: null,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
  };
}

export function createEmptyPipelineAnalyzers(): Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO> {
  return {
    core_window_scan: createEmptyAnalyzerStatus(),
    core_merge: createEmptyAnalyzerStatus(),
    core_resolve: createEmptyAnalyzerStatus(),
    core_entity_mentions: createEmptyAnalyzerStatus(),
    core_profiles: createEmptyAnalyzerStatus(),
    core_quotes_finalize: createEmptyAnalyzerStatus(),
    core_literary: createEmptyAnalyzerStatus(),
    chat_index: createEmptyAnalyzerStatus(),
    canonical_text: createEmptyAnalyzerStatus(),
    scene_build: createEmptyAnalyzerStatus(),
    entity_graph: createEmptyAnalyzerStatus(),
    event_relation_graph: createEmptyAnalyzerStatus(),
    summary_store: createEmptyAnalyzerStatus(),
    evidence_store: createEmptyAnalyzerStatus(),
    text_index: createEmptyAnalyzerStatus(),
    quote_store: createEmptyAnalyzerStatus(),
  };
}

export function createEmptyAnalysisViews(): Record<BookAnalysisViewKeyDTO, BookAnalyzerStatusDTO> {
  return {
    summary: createEmptyAnalyzerStatus(),
    characters: createEmptyAnalyzerStatus(),
    themes: createEmptyAnalyzerStatus(),
    locations: createEmptyAnalyzerStatus(),
    quotes: createEmptyAnalyzerStatus(),
    literary: createEmptyAnalyzerStatus(),
  };
}

export function normalizePipelineAnalyzers(params: {
  analyzers: Partial<Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>>;
  presence: BookChatArtifactPresence;
}): Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO> {
  const out = createEmptyPipelineAnalyzers();
  for (const key of Object.keys(out) as BookPipelineStageKeyDTO[]) {
    out[key] = cloneStatus(params.analyzers[key]);
  }

  out.canonical_text = markCompletedIfPresent(out.canonical_text, params.presence.paragraphs && params.presence.sentences);
  out.scene_build = markCompletedIfPresent(out.scene_build, params.presence.scenes);
  out.entity_graph = markCompletedIfPresent(out.entity_graph, params.presence.entities);
  out.event_relation_graph = markCompletedIfPresent(out.event_relation_graph, params.presence.events);
  out.summary_store = markCompletedIfPresent(out.summary_store, params.presence.summaries);
  out.evidence_store = markCompletedIfPresent(out.evidence_store, params.presence.evidence);
  out.text_index = markCompletedIfPresent(out.text_index, params.presence.scenes);
  out.quote_store = markCompletedIfPresent(out.quote_store, params.presence.quotes);

  return out;
}

export function buildAnalysisViews(params: {
  analyzers: Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>;
  presence: BookChatArtifactPresence;
}): Record<BookAnalysisViewKeyDTO, BookAnalyzerStatusDTO> {
  const out = createEmptyAnalysisViews();

  out.summary = markCompletedIfPresent(cloneStatus(params.analyzers.summary_store), params.presence.summaries);
  out.characters = markCompletedIfPresent(cloneStatus(params.analyzers.entity_graph), params.presence.entities);
  out.themes = markCompletedIfPresent(cloneStatus(params.analyzers.entity_graph), params.presence.entities);
  out.locations = markCompletedIfPresent(cloneStatus(params.analyzers.entity_graph), params.presence.entities);
  out.quotes = markCompletedIfPresent(cloneStatus(params.analyzers.quote_store), params.presence.quotes);
  out.literary = markCompletedIfPresent(cloneStatus(params.analyzers.summary_store), params.presence.summaries);

  return out;
}

export function buildBookChatReadiness(analyzers: Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>): BookChatReadinessDTO {
  const stages = CHAT_READINESS_STAGE_ORDER.map((key) => buildStage(key, analyzers[key]));
  const fastStages = stages.filter((stage) => stage.requiredForFast);
  const canChat = fastStages.every((stage) => isAnalyzerCompleted(stage.state));
  const allCompleted = stages.every((stage) => isAnalyzerCompleted(stage.state));
  const hasFailure = stages.some((stage) => isAnalyzerFailed(stage.state));
  const hasPending = stages.some((stage) => isAnalyzerPending(stage.state));
  const hasMissing = stages.some((stage) => stage.state === "not_requested");

  if (!canChat) {
    return {
      mode: "indexing",
      canChat: false,
      summary: "Строим сценовую структуру, граф сущностей и быстрый текстовый индекс. Чат откроется автоматически, как только будет готов fast lane.",
      stages,
    };
  }

  if (allCompleted) {
    return {
      mode: "expert",
      canChat: true,
      summary: "Экспертный режим готов: сцены, граф, summary-слой, доказательства и цитаты доступны.",
      stages,
    };
  }

  if (hasFailure) {
    return {
      mode: "degraded",
      canChat: true,
      summary: "Чат работает в fast lane, но часть graph/expert stages собрана с ошибками.",
      stages,
    };
  }

  if (hasPending || hasMissing) {
    return {
      mode: "fast",
      canChat: true,
      summary: "Fast lane готов. Глубокий graph и слой доказательств продолжают собираться в фоне.",
      stages,
    };
  }

  return {
    mode: "degraded",
    canChat: true,
    summary: "Чат доступен, но часть graph-слоя пока недоступна.",
    stages,
  };
}

export function mapReadinessToChatMode(mode: BookChatReadinessDTO["mode"]): BookChatModeDTO {
  if (mode === "expert") return "expert";
  if (mode === "degraded") return "degraded";
  return "fast";
}
