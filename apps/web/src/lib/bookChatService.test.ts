import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoExpandedParagraphSlicePlans,
  buildEvidenceFragmentsFromSceneBounds,
  filterParagraphHitsAgainstCoverage,
  uniquifyRerankRecordIds,
  type AutoContextSceneBounds,
  type AutoExpandableParagraphHit,
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

test("filterParagraphHitsAgainstCoverage drops hits already inside slice ranges", () => {
  const hits = [
    { chapterId: "ch-1", paragraphIndex: 5 },   // inside slice 3-10 → drop
    { chapterId: "ch-1", paragraphIndex: 12 },  // outside → keep
    { chapterId: "ch-1", paragraphIndex: 50 },  // outside → keep
    { chapterId: "ch-2", paragraphIndex: 5 },   // different chapter, slice doesn't apply → keep
  ];
  const slices = [{ chapterId: "ch-1", paragraphStart: 3, paragraphEnd: 10 }];
  const groups: Array<{ chapterId: string; paragraphStart: number; paragraphEnd: number }> = [];

  const result = filterParagraphHitsAgainstCoverage(hits, slices, groups);
  assert.deepEqual(
    result.map((hit) => `${hit.chapterId}:${hit.paragraphIndex}`),
    ["ch-1:12", "ch-1:50", "ch-2:5"]
  );
});

test("filterParagraphHitsAgainstCoverage drops hits inside group ranges too", () => {
  const hits = [
    { chapterId: "ch-1", paragraphIndex: 22 },  // inside group 20-25 → drop
    { chapterId: "ch-1", paragraphIndex: 30 },  // outside → keep
  ];
  const slices: Array<{ chapterId: string; paragraphStart: number; paragraphEnd: number }> = [];
  const groups = [{ chapterId: "ch-1", paragraphStart: 20, paragraphEnd: 25 }];

  const result = filterParagraphHitsAgainstCoverage(hits, slices, groups);
  assert.deepEqual(
    result.map((hit) => hit.paragraphIndex),
    [30]
  );
});

test("filterParagraphHitsAgainstCoverage returns all hits when no coverage exists", () => {
  const hits = [
    { chapterId: "ch-1", paragraphIndex: 1 },
    { chapterId: "ch-1", paragraphIndex: 2 },
  ];
  assert.equal(filterParagraphHitsAgainstCoverage(hits, [], []).length, 2);
});
