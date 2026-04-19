export const BOOK_CHAT_TOOL_NAMES = [
  "search_paragraphs_hybrid",
  "search_scenes",
  "get_scene_context",
  "get_paragraph_slice",
] as const;

export type BookChatToolName = (typeof BOOK_CHAT_TOOL_NAMES)[number];

export const DEFAULT_ENABLED_BOOK_CHAT_TOOLS: BookChatToolName[] = [...BOOK_CHAT_TOOL_NAMES];

export const BOOK_CHAT_TOOL_META: Record<
  BookChatToolName,
  {
    label: string;
    description: string;
  }
> = {
  search_paragraphs_hybrid: {
    label: "Поиск абзацев",
    description: "Гибридный поиск по абзацам для факт-чека и точных вопросов.",
  },
  search_scenes: {
    label: "Поиск сцен",
    description: "Гибридный поиск сцен и эпизодов по всей книге.",
  },
  get_scene_context: {
    label: "Контекст сцены",
    description: "Добор соседних сцен и расширенного scene-context.",
  },
  get_paragraph_slice: {
    label: "Срез абзацев",
    description: "Точный текст диапазона абзацев для цитат и проверки формулировки.",
  },
};

export function isBookChatToolName(value: unknown): value is BookChatToolName {
  return BOOK_CHAT_TOOL_NAMES.some((tool) => tool === value);
}
