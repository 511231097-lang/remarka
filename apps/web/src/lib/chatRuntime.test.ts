import test from "node:test";
import assert from "node:assert/strict";
import { BookChatTurnStateSchema } from "@remarka/contracts";
import { __chatRuntimeTestUtils } from "./chatRuntime";

test("buildAnswerItems keeps top-level answer structure addressable", () => {
  const answer = [
    "Вот основные причины:",
    "",
    "* **Дискредитация Артура Уизли:** Люциус хотел ударить по семье Уизли.",
    "* **Открытие Тайной комнаты:** Он рассчитывал посеять хаос в Хогвартсе.",
    "* **Избавление от компромата:** Дневник был опасным тёмным артефактом.",
  ].join("\n");

  const items = __chatRuntimeTestUtils.buildAnswerItems({
    answer,
    focusEntities: [
      {
        id: "lucius",
        kind: "character",
        name: "Люциус Малфой",
        normalizedName: "люциус малфой",
        summary: "Отец Драко и сторонник чистоты крови.",
        mentionCount: 12,
      },
    ],
    evidence: [
      {
        kind: "summary_artifact",
        sourceId: "artifact-1",
        label: "О книге",
        snippet: "Люциус Малфой подбрасывает дневник Джинни Уизли.",
        chapterOrderIndex: null,
        score: 0.9,
      },
    ],
  });

  assert.equal(items.length, 3);
  assert.equal(items[2]?.ordinal, 3);
  assert.match(items[2]?.summary || "", /компромата/i);
  assert.deepEqual(items[0]?.linkedEntityIds, ["lucius"]);
});

test("resolveConversationEntityIds prefers resolved refs over previous active ids", () => {
  const state = BookChatTurnStateSchema.parse({
    activeEntityIds: ["lockhart"],
  });

  const preferred = __chatRuntimeTestUtils.resolveConversationEntityIds({
    referenceResolution: {
      resolvedEntityIds: ["lucius"],
      resolvedAnswerItemId: "item-2",
      confidence: "high",
      reason: "follow-up to previous answer",
      overrideMode: "followup_item",
      fallbackUsed: false,
    },
    turnState: state,
  });

  const fallback = __chatRuntimeTestUtils.resolveConversationEntityIds({
    referenceResolution: {
      resolvedEntityIds: [],
      resolvedAnswerItemId: null,
      confidence: "low",
      reason: null,
      overrideMode: "none",
      fallbackUsed: true,
    },
    turnState: state,
  });

  assert.deepEqual(preferred, ["lucius"]);
  assert.deepEqual(fallback, ["lockhart"]);
});

test("buildAnswerPrompt enforces book-only scope for unresolved targets", () => {
  const prompts = __chatRuntimeTestUtils.buildAnswerPrompt({
    question: "Кто такой Сириус Блэк?",
    staticContext: {
      title: "Гарри Поттер и Тайная комната",
      author: "Дж. К. Роулинг",
      bookBrief: null,
      chatMode: "fast",
      readinessSummary: "",
    },
    plan: {
      intent: "character",
      targets: ["Сириус Блэк"],
      scope: "full_book",
      scopeMode: "book_only",
      timeRef: null,
      depth: "fast",
      needQuote: false,
      answerMode: "factual",
      lane: "fast",
      stateAction: "keep",
    },
    plannerContext: {
      sectionKey: null,
      entryContext: "full_chat",
      state: BookChatTurnStateSchema.parse({}),
      recentUserTurns: [],
      referenceResolution: null,
      resolvedAnswerItem: null,
    },
    bundle: {
      directEvidence: [],
      contextEvidence: [],
      citations: [],
      quoteCards: [],
      usedSources: [],
      requiredFacts: [],
      focusEntities: [],
      activeSceneIds: [],
      activeEventIds: [],
      activeRelationIds: [],
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
    },
    targetResolution: {
      focusEntities: [],
      unresolvedTargets: ["Сириус Блэк"],
    },
  });

  assert.match(prompts.systemPrompt, /только на основе материалов этой книги/i);
  assert.match(prompts.systemPrompt, /не добавляй сведения из других книг/i);
  assert.match(prompts.systemPrompt, /Ненайденные цели в материалах этой книги: Сириус Блэк/i);

  const payload = JSON.parse(prompts.userPrompt) as {
    scopeMode: string;
    unresolvedTargets: string[];
    constraints: { allowMetaOutsideBook: boolean };
  };

  assert.equal(payload.scopeMode, "book_only");
  assert.deepEqual(payload.unresolvedTargets, ["Сириус Блэк"]);
  assert.equal(payload.constraints.allowMetaOutsideBook, false);
});

test("buildAnswerPrompt isolates external meta only when explicitly allowed", () => {
  const prompts = __chatRuntimeTestUtils.buildAnswerPrompt({
    question: "Кто такой Сириус Блэк в более широком каноне?",
    staticContext: {
      title: "Гарри Поттер и Тайная комната",
      author: "Дж. К. Роулинг",
      bookBrief: null,
      chatMode: "fast",
      readinessSummary: "",
    },
    plan: {
      intent: "character",
      targets: ["Сириус Блэк"],
      scope: "full_book",
      scopeMode: "book_plus_meta",
      timeRef: null,
      depth: "fast",
      needQuote: false,
      answerMode: "factual",
      lane: "fast",
      stateAction: "keep",
    },
    plannerContext: {
      sectionKey: null,
      entryContext: "full_chat",
      state: BookChatTurnStateSchema.parse({}),
      recentUserTurns: [],
      referenceResolution: null,
      resolvedAnswerItem: null,
    },
    bundle: {
      directEvidence: [],
      contextEvidence: [],
      citations: [],
      quoteCards: [],
      usedSources: [],
      requiredFacts: [],
      focusEntities: [],
      activeSceneIds: [],
      activeEventIds: [],
      activeRelationIds: [],
      bundleStats: { scenes: 0, events: 0, relations: 0, summaries: 0, quotes: 0, rawSpans: 0 },
    },
    targetResolution: {
      focusEntities: [],
      unresolvedTargets: ["Сириус Блэк"],
    },
  });

  assert.match(prompts.systemPrompt, /Сначала дай ответ строго в рамках этой книги/i);
  assert.match(prompts.systemPrompt, /Вне рамок этой книги/i);

  const payload = JSON.parse(prompts.userPrompt) as {
    scopeMode: string;
    constraints: { allowMetaOutsideBook: boolean };
  };

  assert.equal(payload.scopeMode, "book_plus_meta");
  assert.equal(payload.constraints.allowMetaOutsideBook, true);
});

test("buildPlannerPrompts requires explicit targets and supports meta mode", () => {
  const prompts = __chatRuntimeTestUtils.buildPlannerPrompts({
    question: "Слушай, а ты можешь хотя бы сказать когда появился Сириус Блек в книгах?",
    staticContext: {
      title: "Гарри Поттер и Тайная комната",
      author: "Дж. К. Роулинг",
      bookBrief: null,
      chatMode: "fast",
      readinessSummary: "",
    },
    plannerContext: {
      sectionKey: null,
      entryContext: "full_chat",
      state: BookChatTurnStateSchema.parse({}),
      recentUserTurns: [],
      referenceResolution: null,
      resolvedAnswerItem: null,
    },
  });

  assert.match(prompts.systemPrompt, /targets не оставляй пустым/i);
  assert.match(prompts.systemPrompt, /scopeMode=book_plus_meta/i);
  assert.match(prompts.systemPrompt, /явно просит контекст шире этой книги/i);

  const payload = JSON.parse(prompts.userPrompt) as {
    outputShape: { scopeMode: string; targets: string[] };
    examples: Array<{ question: string; result: { scopeMode: string; targets: string[]; intent: string } }>;
  };

  assert.equal(payload.outputShape.scopeMode, "book_only | book_plus_meta");
  assert.deepEqual(payload.outputShape.targets, ["short target from current user ask"]);

  const siriusExample = payload.examples.find((item) => /Сириус Блек/i.test(item.question));
  assert.ok(siriusExample);
  assert.equal(siriusExample?.result.scopeMode, "book_plus_meta");
  assert.deepEqual(siriusExample?.result.targets, ["Сириус Блек"]);
});

test("buildPlannerPrompts routes closing messages to social", () => {
  const prompts = __chatRuntimeTestUtils.buildPlannerPrompts({
    question: "Но ты уже ответил на этот вопрос, больше не надо)",
    staticContext: {
      title: "Гарри Поттер и Тайная комната",
      author: "Дж. К. Роулинг",
      bookBrief: null,
      chatMode: "fast",
      readinessSummary: "",
    },
    plannerContext: {
      sectionKey: null,
      entryContext: "full_chat",
      state: BookChatTurnStateSchema.parse({}),
      recentUserTurns: ["Спасибо)"],
      referenceResolution: null,
      resolvedAnswerItem: null,
    },
  });

  assert.match(prompts.systemPrompt, /social используй только если текущая реплика не просит ответа по книге/i);
  assert.match(prompts.systemPrompt, /благодарность, завершение разговора, короткое подтверждение/i);

  const payload = JSON.parse(prompts.userPrompt) as {
    examples: Array<{ question: string; result: { intent: string; targets: string[] } }>;
  };

  const closingExample = payload.examples.find((item) => /больше не надо/i.test(item.question));
  assert.ok(closingExample);
  assert.equal(closingExample?.result.intent, "social");
  assert.deepEqual(closingExample?.result.targets, []);
});
