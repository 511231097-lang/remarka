import type { EntityType } from "@remarka/contracts";

export const ENTITY_TYPE_LABELS_RU: Record<EntityType, string> = {
  character: "Персонажи",
  location: "Локации",
  event: "События",
  time_marker: "Временные маркеры",
};

export const ENTITY_TYPE_SHORT_RU: Record<EntityType, string> = {
  character: "Персонаж",
  location: "Локация",
  event: "Событие",
  time_marker: "Время",
};

export const ENTITY_TYPE_OPTIONS: Array<{ value: EntityType; label: string }> = [
  { value: "character", label: "Персонажи" },
  { value: "event", label: "События" },
  { value: "time_marker", label: "Временные маркеры" },
  { value: "location", label: "Локации" },
];

export function formatAnalysisStatusRu(status: string) {
  if (status === "queued") return "Анализ в очереди";
  if (status === "running") return "Идет анализ";
  if (status === "completed") return "Анализ завершен";
  if (status === "failed") return "Ошибка анализа";
  return "Ожидание";
}
