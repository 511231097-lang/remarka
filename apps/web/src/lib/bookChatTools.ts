export const BOOK_CHAT_TOOL_NAMES = [
  "search_paragraphs_hybrid",
  "search_scenes",
  "get_scene_context",
  "get_paragraph_slice",
] as const;

export type BookChatToolName = (typeof BOOK_CHAT_TOOL_NAMES)[number];

// Scene tools (search_scenes, get_scene_context) drive the hybrid scene
// search: vector probe over BookSceneEmbedding ⨝ BookAnalysisScene plus a
// lexical pass plus Vertex Ranker. Disabled by default during the canonical-
// graph V2 transition (commit 18d7b11), but the transition is over — V2
// graph models were dropped in PR #15 and bookAnalysisStatus.ts now
// synthesizes counts from BookAnalysisScene, so capabilities resolve
// correctly without the V2 read-layer tables. Default back to enabled.
//
// Kill-switch: set BOOK_CHAT_SCENE_TOOLS_ENABLED=false to disable
// (matches the original env name but with the polarity flipped).
export const BOOK_CHAT_SCENE_TOOLS_ENABLED = String(process.env.BOOK_CHAT_SCENE_TOOLS_ENABLED || "")
  .trim()
  .toLowerCase() !== "false";

export const DEFAULT_ENABLED_BOOK_CHAT_TOOLS: BookChatToolName[] = BOOK_CHAT_SCENE_TOOLS_ENABLED
  ? [...BOOK_CHAT_TOOL_NAMES]
  : ["search_paragraphs_hybrid", "get_paragraph_slice"];

export const BOOK_CHAT_TOOL_META: Record<
  BookChatToolName,
  {
    label: string;
    description: string;
  }
> = {
  search_paragraphs_hybrid: {
    label: "Поиск абзацев",
    description: "Гибридный поиск по абзацам; hits дают навигацию, primary evidence slices дают главный контекст.",
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
