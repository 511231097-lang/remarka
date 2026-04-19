import {
  BOOK_PIPELINE_STAGE_KEYS,
} from "@/lib/books";
import type {
  BookAnalysisViewKeyDTO,
  BookAnalyzerStateDTO,
  BookAnalyzerStatusDTO,
  BookCapabilitySnapshotDTO,
  BookChatModeDTO,
  BookChatReadinessDTO,
  BookChatReadinessStageDTO,
  BookPipelineStageKeyDTO,
} from "@/lib/books";
import { canUseMvpBookChat } from "@/lib/bookCapabilitySnapshot";

export const CHAT_READINESS_STAGE_ORDER = [...BOOK_PIPELINE_STAGE_KEYS] as const;

export type ChatReadinessStageKey = (typeof CHAT_READINESS_STAGE_ORDER)[number];

const CHAT_READINESS_STAGE_LABELS: Record<ChatReadinessStageKey, string> = {
  ingest_normalize: "Нормализация source layer",
  structural_pass: "Структурный проход",
  local_extraction_mentions: "Наблюдения: сущности",
  local_extraction_quotes: "Наблюдения: цитаты",
  local_extraction_events: "Наблюдения: события",
  local_extraction_relations: "Наблюдения: отношения",
  local_extraction_time_location: "Наблюдения: время и локации",
  validation_pass: "Валидация observations",
  entity_resolution: "Канонические сущности",
  scene_assembly: "Сборка сцен",
  event_timeline: "События и таймлайн",
  relation_aggregation: "Агрегация отношений",
  summary_synthesis: "Канонические summary",
  index_build: "Read layer и индексы",
  repair: "Repair и финальная проверка",
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
    requiredForFast: key === "index_build" || key === "repair",
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
    ingest_normalize: createEmptyAnalyzerStatus(),
    structural_pass: createEmptyAnalyzerStatus(),
    local_extraction_mentions: createEmptyAnalyzerStatus(),
    local_extraction_quotes: createEmptyAnalyzerStatus(),
    local_extraction_events: createEmptyAnalyzerStatus(),
    local_extraction_relations: createEmptyAnalyzerStatus(),
    local_extraction_time_location: createEmptyAnalyzerStatus(),
    validation_pass: createEmptyAnalyzerStatus(),
    entity_resolution: createEmptyAnalyzerStatus(),
    scene_assembly: createEmptyAnalyzerStatus(),
    event_timeline: createEmptyAnalyzerStatus(),
    relation_aggregation: createEmptyAnalyzerStatus(),
    summary_synthesis: createEmptyAnalyzerStatus(),
    index_build: createEmptyAnalyzerStatus(),
    repair: createEmptyAnalyzerStatus(),
  };
}

export function createEmptyAnalysisViews(): Record<BookAnalysisViewKeyDTO, BookAnalyzerStatusDTO> {
  return {
    source: createEmptyAnalyzerStatus(),
    observations: createEmptyAnalyzerStatus(),
    canonical: createEmptyAnalyzerStatus(),
    read_layer: createEmptyAnalyzerStatus(),
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

  return out;
}

export function buildAnalysisViews(params: {
  analyzers: Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>;
  presence: BookChatArtifactPresence;
}): Record<BookAnalysisViewKeyDTO, BookAnalyzerStatusDTO> {
  const out = createEmptyAnalysisViews();

  out.source = markCompletedIfPresent(cloneStatus(params.analyzers.ingest_normalize), params.presence.paragraphs);
  out.observations = markCompletedIfPresent(
    cloneStatus(params.analyzers.validation_pass),
    params.presence.entities || params.presence.quotes || params.presence.evidence
  );
  out.canonical = markCompletedIfPresent(
    cloneStatus(params.analyzers.summary_synthesis),
    params.presence.scenes || params.presence.entities || params.presence.events || params.presence.summaries
  );
  out.read_layer = markCompletedIfPresent(
    cloneStatus(params.analyzers.index_build),
    params.presence.evidence || params.presence.summaries
  );

  return out;
}

export function buildBookChatReadiness(
  analyzers: Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>,
  capabilitySnapshot?: BookCapabilitySnapshotDTO
): BookChatReadinessDTO {
  const stages = CHAT_READINESS_STAGE_ORDER.map((key) => buildStage(key, analyzers[key]));
  const allCompleted = stages.every((stage) => isAnalyzerCompleted(stage.state));
  const hasFailure = stages.some((stage) => isAnalyzerFailed(stage.state));
  const hasPending = stages.some((stage) => isAnalyzerPending(stage.state));
  const hasMissing = stages.some((stage) => stage.state === "not_requested");

  if (capabilitySnapshot && canUseMvpBookChat(capabilitySnapshot)) {
    return {
      mode: capabilitySnapshot.analysisState === "completed" ? "fast" : "degraded",
      canChat: true,
      summary:
        capabilitySnapshot.analysisState === "completed"
          ? "MVP-чат доступен: сущности, присутствие и доказательные фрагменты включены. Scene/timeline/relation слои пока выключены."
          : "MVP-чат уже доступен, но анализ еще идет. Отвечаем только через entity/presence/evidence/passages и честно показываем ограничения.",
      stages,
    };
  }

  if (hasPending || hasMissing) {
    return {
      mode: "indexing",
      canChat: false,
      summary: "Строим evidence-first data layer: source, observations, canonical graph и read layer. MVP-чат включится, когда будут готовы entity/presence/evidence tools.",
      stages,
    };
  }

  if (allCompleted || hasFailure) {
    return {
      mode: hasFailure ? "degraded" : "indexing",
      canChat: false,
      summary: hasFailure
        ? "Evidence-first pipeline завершен с ошибками. Чат остается выключенным, пока MVP tool set не станет надежным."
        : "Evidence-first pipeline собран, но MVP tool set еще не стал надежным для чата.",
      stages,
    };
  }

  return {
    mode: "degraded",
    canChat: false,
    summary: "Evidence-first pipeline еще не переведен в чатовый runtime.",
    stages,
  };
}

export function mapReadinessToChatMode(mode: BookChatReadinessDTO["mode"]): BookChatModeDTO {
  if (mode === "expert") return "expert";
  if (mode === "degraded") return "degraded";
  return "fast";
}
