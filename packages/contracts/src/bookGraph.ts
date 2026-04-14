import { z } from "zod";

export const BOOK_CHAT_GRAPH_STAGE_KEYS = [
  "canonical_text",
  "scene_build",
  "entity_graph",
  "event_relation_graph",
  "summary_store",
  "evidence_store",
  "text_index",
  "quote_store",
] as const;

export type BookChatGraphStageKey = (typeof BOOK_CHAT_GRAPH_STAGE_KEYS)[number];
export const BookChatGraphStageKeySchema = z.enum(BOOK_CHAT_GRAPH_STAGE_KEYS);

export const BOOK_CHAT_PLAN_INTENTS = [
  "character",
  "event",
  "scene",
  "chapter",
  "compare",
  "analysis",
  "retelling",
  "quote_proof",
  "social",
] as const;

export const BOOK_CHAT_PLAN_SCOPES = ["scene", "chapter", "full_book", "unknown"] as const;
export const BOOK_CHAT_PLAN_DEPTHS = ["fast", "deep"] as const;
export const BOOK_CHAT_ANSWER_MODES = [
  "factual",
  "explain",
  "compare",
  "retell_scene",
  "retell_chapter",
  "deep_analysis",
  "answer_with_proof",
] as const;
export const BOOK_CHAT_STATE_ACTIONS = ["keep", "narrow", "reset"] as const;

export type BookChatPlanIntent = (typeof BOOK_CHAT_PLAN_INTENTS)[number];
export type BookChatPlanScope = (typeof BOOK_CHAT_PLAN_SCOPES)[number];
export type BookChatPlanDepth = (typeof BOOK_CHAT_PLAN_DEPTHS)[number];
export type BookChatAnswerMode = (typeof BOOK_CHAT_ANSWER_MODES)[number];
export type BookChatStateAction = (typeof BOOK_CHAT_STATE_ACTIONS)[number];

export const BookChatTurnStateSchema = z
  .object({
    activeEntityIds: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
    activeSceneIds: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    activeEventIds: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    activeRelationIds: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    lastIntent: z.enum(BOOK_CHAT_PLAN_INTENTS).nullable().default(null),
    lastScope: z.enum(BOOK_CHAT_PLAN_SCOPES).nullable().default(null),
    lastAnswerMode: z.enum(BOOK_CHAT_ANSWER_MODES).nullable().default(null),
    lastCompareSet: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
    pronounAnchors: z.record(z.string(), z.string().trim().min(1).max(80)).default({}),
    sectionContext: z.string().trim().min(1).max(80).nullable().default(null),
    lastUserQuestion: z.string().trim().min(1).max(600).nullable().default(null),
  })
  .strict();

export type BookChatTurnState = z.infer<typeof BookChatTurnStateSchema>;

export const BookChatPlanSchema = z
  .object({
    intent: z.enum(BOOK_CHAT_PLAN_INTENTS),
    targets: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
    scope: z.enum(BOOK_CHAT_PLAN_SCOPES),
    timeRef: z.string().trim().min(1).max(160).nullable().default(null),
    depth: z.enum(BOOK_CHAT_PLAN_DEPTHS),
    needQuote: z.boolean().default(false),
    answerMode: z.enum(BOOK_CHAT_ANSWER_MODES),
    lane: z.enum(BOOK_CHAT_PLAN_DEPTHS),
    stateAction: z.enum(BOOK_CHAT_STATE_ACTIONS),
  })
  .strict();

export type BookChatPlan = z.infer<typeof BookChatPlanSchema>;

export const BookChatAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(12000),
  })
  .strict();

export type BookChatAnswer = z.infer<typeof BookChatAnswerSchema>;

export const BookChatVerifierResultSchema = z
  .object({
    passed: z.boolean(),
    missingFactIds: z.array(z.string().trim().min(1).max(120)).max(24).default([]),
    strippedClaims: z.array(z.string().trim().min(1).max(300)).max(16).default([]),
  })
  .strict();

export type BookChatVerifierResult = z.infer<typeof BookChatVerifierResultSchema>;
