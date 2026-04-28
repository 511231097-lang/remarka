import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoExpandedParagraphSlicePlans,
  buildEvidenceFragmentsFromSceneBounds,
  buildHeuristicChatPreplan,
  decideCompiledAnswerRuntime,
  deriveCitationsFromEvidencePack,
  pickEvidenceCoverage,
  uniquifyRerankRecordIds,
  type AutoContextSceneBounds,
  type AutoExpandableParagraphHit,
  type ChatPreplan,
  type EvidenceGroup,
  type EvidencePack,
} from "./bookChatService";

function hit(paragraphIndex: number, overrides: Partial<AutoExpandableParagraphHit> = {}): AutoExpandableParagraphHit {
  return {
    chapterId: "chapter-17",
    chapterOrderIndex: 17,
    chapterTitle: "Глава 17",
    paragraphIndex,
    sceneIndex: null,
    score: 1,
    ...overrides,
  };
}

test("buildAutoExpandedParagraphSlicePlans expands dense chapter hits with margin", () => {
  const plans = buildAutoExpandedParagraphSlicePlans({
    hits: [37, 39, 41, 45, 47, 51, 56].map((paragraphIndex) => hit(paragraphIndex)),
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.chapterId, "chapter-17");
  assert.equal(plans[0]?.paragraphStart, 31);
  assert.equal(plans[0]?.paragraphEnd, 62);
  assert.equal(plans[0]?.hitCount, 7);
});

test("buildAutoExpandedParagraphSlicePlans ignores scattered hits without a dense cluster", () => {
  const plans = buildAutoExpandedParagraphSlicePlans({
    hits: [
      hit(3),
      hit(58),
      hit(140),
      hit(9, { chapterId: "chapter-4", chapterOrderIndex: 4 }),
      hit(220, { chapterId: "chapter-9", chapterOrderIndex: 9 }),
    ],
  });

  assert.deepEqual(plans, []);
});

test("buildAutoExpandedParagraphSlicePlans trims clusters to max paragraph width", () => {
  const plans = buildAutoExpandedParagraphSlicePlans({
    hits: [10, 20, 30].map((paragraphIndex) => hit(paragraphIndex)),
    margin: 20,
    maxSliceParagraphs: 24,
  });

  assert.equal(plans.length, 1);
  assert.equal((plans[0]?.paragraphEnd ?? 0) - (plans[0]?.paragraphStart ?? 0) + 1, 24);
  assert.ok((plans[0]?.paragraphStart ?? 0) <= 10);
  assert.ok((plans[0]?.paragraphEnd ?? 0) >= 30);
});

test("buildAutoExpandedParagraphSlicePlans constrains compact same-scene clusters to scene bounds", () => {
  const sceneBoundsByRef = new Map<string, AutoContextSceneBounds>([
    [
      "chapter-17:4",
      {
        chapterId: "chapter-17",
        sceneIndex: 4,
        paragraphStart: 8,
        paragraphEnd: 14,
      },
    ],
  ]);

  const plans = buildAutoExpandedParagraphSlicePlans({
    hits: [10, 11, 12].map((paragraphIndex) => hit(paragraphIndex, { sceneIndex: 4 })),
    sceneBoundsByRef,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.paragraphStart, 8);
  assert.equal(plans[0]?.paragraphEnd, 14);
});

test("buildAutoExpandedParagraphSlicePlans adds continuation slice for large same-scene clusters", () => {
  const sceneBoundsByRef = new Map<string, AutoContextSceneBounds>([
    [
      "chapter-17:1",
      {
        chapterId: "chapter-17",
        sceneIndex: 1,
        paragraphStart: 1,
        paragraphEnd: 120,
      },
    ],
  ]);

  const plans = buildAutoExpandedParagraphSlicePlans({
    hits: [20, 35, 47].map((paragraphIndex) => hit(paragraphIndex, { sceneIndex: 1 })),
    sceneBoundsByRef,
    maxSliceParagraphs: 48,
  });

  assert.equal(plans.length, 2);
  assert.equal(plans[0]?.reason, "clustered_hits");
  assert.equal(plans[0]?.paragraphStart, 14);
  assert.equal(plans[0]?.paragraphEnd, 53);
  assert.equal(plans[1]?.reason, "scene_continuation");
  assert.equal(plans[1]?.paragraphStart, 54);
  assert.equal(plans[1]?.paragraphEnd, 101);
});

test("buildEvidenceFragmentsFromSceneBounds creates overlapping small windows inside scenes", () => {
  const paragraphDocs = Array.from({ length: 9 }, (_, index) => {
    const paragraphIndex = index + 1;
    const terms = [`абзац${paragraphIndex}`];
    return {
      chapterId: "chapter-1",
      chapterOrderIndex: 1,
      chapterTitle: "Глава 1",
      paragraphIndex,
      sceneIndex: 2,
      text: `Абзац ${paragraphIndex}`,
      normalized: `абзац${paragraphIndex}`,
      termFrequency: new Map(terms.map((term) => [term, 1])),
      uniqueTerms: terms,
      termCount: terms.length,
    };
  });
  const fragments = buildEvidenceFragmentsFromSceneBounds({
    bookId: "book-1",
    paragraphDocs,
    sceneBoundsByRef: new Map([
      [
        "chapter-1:2",
        {
          sceneId: "scene-2",
          chapterId: "chapter-1",
          sceneIndex: 2,
          paragraphStart: 1,
          paragraphEnd: 9,
        },
      ],
    ]),
    windowParagraphs: 5,
    overlapParagraphs: 2,
  });

  assert.deepEqual(
    fragments.map((fragment) => `${fragment.paragraphStart}-${fragment.paragraphEnd}`),
    ["1-5", "4-8", "5-9"]
  );
  assert.ok(fragments.every((fragment) => fragment.sceneId === "scene-2"));
});

function evidenceGroup(index: number, overrides: Partial<EvidenceGroup> = {}): EvidenceGroup {
  const chapterOrderIndex = overrides.chapterOrderIndex ?? Math.ceil(index / 2);
  const paragraphStart = overrides.paragraphStart ?? index * 10;
  const paragraphEnd = overrides.paragraphEnd ?? paragraphStart + 2;
  return {
    id: overrides.id ?? `ev-${index}`,
    chapterId: overrides.chapterId ?? `chapter-${chapterOrderIndex}`,
    chapterOrderIndex,
    chapterTitle: overrides.chapterTitle ?? `Глава ${chapterOrderIndex}`,
    sceneId: overrides.sceneId ?? `scene-${Math.ceil(index / 2)}`,
    sceneIndex: overrides.sceneIndex ?? Math.ceil(index / 2),
    sceneTitle: overrides.sceneTitle,
    paragraphStart,
    paragraphEnd,
    paragraphs:
      overrides.paragraphs ??
      [
        {
          paragraphIndex: paragraphStart,
          text: `Фрагмент ${index}`,
        },
      ],
    text: overrides.text ?? `Фрагмент ${index}`,
    score: overrides.score ?? 1 - index / 100,
    confidence: overrides.confidence ?? "high",
    matchedBy: overrides.matchedBy ?? ["semantic", "rerank"],
    matchedSubquery: overrides.matchedSubquery,
  };
}

function preplan(overrides: Partial<ChatPreplan> = {}): ChatPreplan {
  return {
    route: "grounded_answer",
    model: "pro",
    complexity: "hard",
    answerMode: "chronology",
    retrieval: {
      query: "главная цепочка",
      subqueries: ["часть A", "часть B"],
      order: "chronological",
      topK: 14,
      useScenes: true,
      evidenceBudget: "large",
    },
    slots: [],
    ...overrides,
  };
}

function evidencePack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  const group = evidenceGroup(1);
  return {
    schemaVersion: "compiled-evidence-v1",
    route: "grounded_answer",
    complexity: "medium",
    answerMode: "explanation",
    order: "relevance",
    budget: "medium",
    query: "вопрос",
    subqueries: [],
    groups: [group],
    slots: [],
    blocks: [{ label: "вопрос", groups: [group] }],
    metrics: {
      groupCount: 1,
      evidenceChars: group.text.length,
      sceneBoostUsed: false,
      rerank: {
        enabled: false,
        used: false,
        candidateCount: 0,
        returned: 0,
        model: null,
        latencyMs: 0,
      },
      chapterDistribution: { ch1: 1 },
      sceneDistribution: { "ch1:sc1": 1 },
    },
    ...overrides,
  };
}

test("buildHeuristicChatPreplan keeps simple fact on light model", () => {
  const plan = buildHeuristicChatPreplan({
    userQuestion: "Как зовут друга Гарри?",
    scenesReady: true,
  });

  assert.equal(plan.route, "grounded_answer");
  assert.equal(plan.model, "lite");
  assert.equal(plan.complexity, "simple");
  assert.equal(plan.retrieval.evidenceBudget, "small");
});

test("buildHeuristicChatPreplan escalates chronology questions to pro", () => {
  const plan = buildHeuristicChatPreplan({
    userQuestion:
      "Как дневник Тома Реддла постепенно завоёвывает доверие Джинни, и через какую цепочку событий это приводит к открытию Тайной комнаты?",
    scenesReady: true,
  });

  assert.equal(plan.model, "pro");
  assert.equal(plan.answerMode, "chronology");
  assert.equal(plan.retrieval.order, "chronological");
  assert.equal(plan.retrieval.evidenceBudget, "large");
});

test("buildHeuristicChatPreplan creates clue slots for basilisk-style synthesis", () => {
  const plan = buildHeuristicChatPreplan({
    userQuestion:
      "По каким разрозненным признакам можно вывести, что чудовище — василиск, и как связаны пауки, трубы, петухи и окаменение?",
    scenesReady: true,
  });

  assert.equal(plan.answerMode, "clue_synthesis");
  assert.deepEqual(
    plan.slots.map((slot) => slot.id),
    ["spiders", "pipes", "roosters", "petrification"]
  );
});

test("buildHeuristicChatPreplan creates row slots for attack sequence questions", () => {
  const plan = buildHeuristicChatPreplan({
    userQuestion:
      "Восстанови точную последовательность нападений: кто пострадал, при каких обстоятельствах и почему никто не погиб?",
    scenesReady: true,
  });

  assert.equal(plan.answerMode, "table_sequence");
  assert.deepEqual(
    plan.slots.map((slot) => slot.id),
    ["mrs_norris", "colin", "justin_nick", "hermione_penelope"]
  );
});

test("decideCompiledAnswerRuntime keeps simple complete answers pack-only", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "lite",
      complexity: "simple",
      answerMode: "fact",
      retrieval: {
        query: "факт",
        subqueries: [],
        order: "relevance",
        topK: 6,
        useScenes: true,
        evidenceBudget: "small",
      },
    }),
    evidencePack: evidencePack({
      complexity: "simple",
      answerMode: "fact",
      budget: "small",
    }),
  });

  assert.equal(runtime.model, "lite");
  assert.deepEqual(runtime.repairTools, []);
  assert.equal(runtime.maxToolCalls, 0);
});

test("decideCompiledAnswerRuntime enables bounded repair for missing required evidence", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "clue_synthesis",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "clue_synthesis",
      slots: [
        {
          slotId: "roosters",
          title: "Петухи",
          required: true,
          role: "clue",
          coverage: "low",
          missingAnchors: ["петухи", "василиск"],
          groups: [],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "pro");
  assert.deepEqual(runtime.repairTools, ["search_evidence", "read_passages"]);
  assert.equal(runtime.maxToolCalls, 2);
  assert.ok(runtime.reasons.includes("low_or_missing_required_evidence"));
});

test("decideCompiledAnswerRuntime does not repair medium slots for semantic missing anchors", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "clue_synthesis",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "clue_synthesis",
      slots: [
        {
          slotId: "exoneration",
          title: "Доказательство невиновности",
          required: true,
          role: "clue",
          coverage: "medium",
          missingAnchors: ["невиновность", "логика"],
          groups: [evidenceGroup(1)],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "lite");
  assert.deepEqual(runtime.repairTools, []);
  assert.equal(runtime.maxToolCalls, 0);
});

test("decideCompiledAnswerRuntime keeps cheap read repair for literal missing anchors near existing groups", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "table_sequence",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "table_sequence",
      slots: [
        {
          slotId: "row",
          title: "Строка",
          required: true,
          role: "row",
          coverage: "medium",
          missingAnchors: ["Гермиона"],
          groups: [evidenceGroup(1)],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "pro");
  assert.deepEqual(runtime.repairTools, ["read_passages"]);
  assert.equal(runtime.maxToolCalls, 1);
});

test("decideCompiledAnswerRuntime allows search repair for progressive reveal literal gaps", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "progressive_reveal",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "progressive_reveal",
      slots: [
        {
          slotId: "chain",
          title: "Цепочка событий",
          required: true,
          role: "clue",
          coverage: "medium",
          missingAnchors: ["дневник"],
          groups: [evidenceGroup(1)],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "pro");
  assert.deepEqual(runtime.repairTools, ["search_evidence", "read_passages"]);
  assert.equal(runtime.maxToolCalls, 2);
});

test("decideCompiledAnswerRuntime allows search repair for clue synthesis literal gaps", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "clue_synthesis",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "clue_synthesis",
      slots: [
        {
          slotId: "mechanism",
          title: "Механизм",
          required: true,
          role: "clue",
          coverage: "medium",
          missingAnchors: ["окаменение"],
          groups: [evidenceGroup(1)],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "pro");
  assert.deepEqual(runtime.repairTools, ["search_evidence", "read_passages"]);
  assert.equal(runtime.maxToolCalls, 2);
});

test("decideCompiledAnswerRuntime allows search repair for decisive literal gaps", () => {
  const runtime = decideCompiledAnswerRuntime({
    fallbackChatModel: "fallback-model",
    preplan: preplan({
      model: "pro",
      complexity: "hard",
      answerMode: "clue_synthesis",
    }),
    evidencePack: evidencePack({
      complexity: "hard",
      answerMode: "clue_synthesis",
      slots: [
        {
          slotId: "decisive",
          title: "Решающее доказательство",
          required: true,
          role: "decisive",
          coverage: "medium",
          missingAnchors: ["дневник"],
          groups: [evidenceGroup(1)],
        },
      ],
    }),
  });

  assert.equal(runtime.model, "pro");
  assert.deepEqual(runtime.repairTools, ["search_evidence", "read_passages"]);
  assert.equal(runtime.maxToolCalls, 2);
});

test("uniquifyRerankRecordIds preserves first ids and rewrites duplicates", () => {
  assert.deepEqual(uniquifyRerankRecordIds(["ev1", "ev2", "ev1", "", "ev2", "ev1"]), [
    "ev1",
    "ev2",
    "ev1__dup_1_2",
    "record_3",
    "ev2__dup_1_4",
    "ev1__dup_2_5",
  ]);
});

test("pickEvidenceCoverage keeps at least one group per subquery and sorts chronology", () => {
  const selected = pickEvidenceCoverage({
    preplan: preplan(),
    groups: [
      evidenceGroup(5, { matchedSubquery: "часть B", chapterOrderIndex: 5, paragraphStart: 20, paragraphEnd: 22 }),
      evidenceGroup(1, { matchedSubquery: "часть A", chapterOrderIndex: 2, paragraphStart: 30, paragraphEnd: 32 }),
      evidenceGroup(2, { matchedSubquery: "часть B", chapterOrderIndex: 3, paragraphStart: 10, paragraphEnd: 12 }),
    ],
  });

  assert.ok(selected.some((group) => group.matchedSubquery === "часть A"));
  assert.ok(selected.some((group) => group.matchedSubquery === "часть B"));
  assert.deepEqual(
    selected.map((group) => `${group.chapterOrderIndex}:${group.paragraphStart}`),
    ["2:30", "3:10", "5:20"]
  );
});

test("deriveCitationsFromEvidencePack uses evidence groups instead of tool capture", () => {
  const group = evidenceGroup(1, {
    chapterOrderIndex: 7,
    sceneIndex: 2,
    paragraphStart: 42,
    paragraphEnd: 45,
    matchedSubquery: "улика",
  });
  const pack: EvidencePack = {
    schemaVersion: "compiled-evidence-v1",
    route: "grounded_answer",
    complexity: "medium",
    answerMode: "explanation",
    order: "relevance",
    budget: "medium",
    query: "вопрос",
    subqueries: ["улика"],
    groups: [group],
    slots: [],
    blocks: [{ label: "улика", groups: [group] }],
    metrics: {
      groupCount: 1,
      evidenceChars: group.text.length,
      sceneBoostUsed: false,
      rerank: {
        enabled: true,
        used: true,
        candidateCount: 1,
        returned: 1,
        model: "test-reranker",
        latencyMs: 1,
      },
      chapterDistribution: { ch7: 1 },
      sceneDistribution: { "ch7:sc2": 1 },
    },
  };

  assert.deepEqual(deriveCitationsFromEvidencePack(pack), [
    {
      chapterOrderIndex: 7,
      sceneIndex: 2,
      paragraphStart: 42,
      paragraphEnd: 45,
      reason: "Evidence for: улика",
    },
  ]);
});
