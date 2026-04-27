import test from "node:test";
import assert from "node:assert/strict";
import {
  createChapterFirstSceneSegments,
  parseSearchUnitSegmentationResponse,
  parseSceneSegmentationV2Response,
  type ParagraphBlock,
} from "./analysisPipeline.npz";

function paragraphs(count: number, text = "Короткий абзац."): ParagraphBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    text,
  }));
}

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "scene-segmentation-v2",
    segment: {
      chapterId: "chapter-1",
      chapterOrderIndex: 2,
      paragraphStart: 1,
      paragraphEnd: 4,
    },
    scenes: [
      {
        paragraphStart: 1,
        paragraphEnd: 2,
        sceneCard: "Первая сцена.",
        participants: ["Аня"],
        mentionedEntities: ["дом"],
        locationHints: ["комната"],
        timeHints: [],
        eventLabels: ["разговор"],
        facts: ["Аня говорит в комнате."],
        evidenceSpans: [{ label: "разговор", paragraphStart: 1, paragraphEnd: 2 }],
        confidence: 0.8,
      },
      {
        paragraphStart: 3,
        paragraphEnd: 4,
        sceneCard: "Вторая сцена.",
        participants: ["Борис"],
        mentionedEntities: [],
        locationHints: [],
        timeHints: ["вечер"],
        eventLabels: ["переход"],
        facts: ["Борис появляется вечером."],
        evidenceSpans: [{ label: "появление", paragraphStart: 3, paragraphEnd: 4 }],
        confidence: 0.7,
      },
    ],
    ...overrides,
  };
}

test("createChapterFirstSceneSegments keeps small chapters as one chapter segment", () => {
  const segments = createChapterFirstSceneSegments({
    paragraphs: paragraphs(3),
    maxInputTokens: 10000,
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.chunkStartParagraph, 1);
  assert.equal(segments[0]?.chunkEndParagraph, 3);
});

test("createChapterFirstSceneSegments splits oversized chapters by technical budget", () => {
  const segments = createChapterFirstSceneSegments({
    paragraphs: paragraphs(8, "x".repeat(120)),
    maxInputTokens: 3100,
  });

  assert.ok(segments.length > 1);
  assert.equal(segments[0]?.chunkStartParagraph, 1);
  assert.equal(segments[segments.length - 1]?.chunkEndParagraph, 8);
  for (let index = 1; index < segments.length; index += 1) {
    assert.equal(segments[index]?.chunkStartParagraph, (segments[index - 1]?.chunkEndParagraph || 0) + 1);
  }
});

test("parseSceneSegmentationV2Response accepts contiguous global paragraph scenes", () => {
  const parsed = parseSceneSegmentationV2Response({
    content: JSON.stringify(validResponse()),
    chapterId: "chapter-1",
    chapterOrderIndex: 2,
    segmentStartParagraph: 1,
    segmentEndParagraph: 4,
  });

  assert.equal(parsed.scenes.length, 2);
  assert.deepEqual(
    parsed.boundaries.map((boundary) => boundary.betweenParagraphs),
    [[2, 3]]
  );
  assert.equal(parsed.scenes[0]?.evidenceSpans[0]?.paragraphStart, 1);
});

test("parseSceneSegmentationV2Response rejects gaps", () => {
  const response = validResponse({
    scenes: [
      { ...validResponse().scenes[0], paragraphStart: 1, paragraphEnd: 2 },
      { ...validResponse().scenes[1], paragraphStart: 4, paragraphEnd: 4 },
    ],
  });

  assert.throws(
    () =>
      parseSceneSegmentationV2Response({
        content: JSON.stringify(response),
        chapterId: "chapter-1",
        chapterOrderIndex: 2,
        segmentStartParagraph: 1,
        segmentEndParagraph: 4,
      }),
    /contiguous/
  );
});

test("parseSceneSegmentationV2Response rejects overlaps", () => {
  const response = validResponse({
    scenes: [
      { ...validResponse().scenes[0], paragraphStart: 1, paragraphEnd: 3 },
      { ...validResponse().scenes[1], paragraphStart: 3, paragraphEnd: 4 },
    ],
  });

  assert.throws(
    () =>
      parseSceneSegmentationV2Response({
        content: JSON.stringify(response),
        chapterId: "chapter-1",
        chapterOrderIndex: 2,
        segmentStartParagraph: 1,
        segmentEndParagraph: 4,
      }),
    /contiguous/
  );
});

test("parseSceneSegmentationV2Response rejects out-of-range local indexes", () => {
  const response = validResponse({
    segment: {
      chapterId: "chapter-1",
      chapterOrderIndex: 2,
      paragraphStart: 10,
      paragraphEnd: 13,
    },
  });

  assert.throws(
    () =>
      parseSceneSegmentationV2Response({
        content: JSON.stringify(response),
        chapterId: "chapter-1",
        chapterOrderIndex: 2,
        segmentStartParagraph: 10,
        segmentEndParagraph: 13,
      }),
    /outside segment range/
  );
});

test("parseSearchUnitSegmentationResponse accepts contiguous TSV search units", () => {
  const parsed = parseSearchUnitSegmentationResponse({
    content: [
      "1\t2\tАня приходит к дому.\tАня подходит к двери; Аня стучит\tАня; дом; дверь",
      "3\t4\tБорис открывает дверь и объясняет задержку.\tБорис открывает; Борис объясняет задержку\tБорис; задержка",
    ].join("\n"),
    segmentStartParagraph: 1,
    segmentEndParagraph: 4,
  });

  assert.equal(parsed.scenes.length, 2);
  assert.deepEqual(
    parsed.boundaries.map((boundary) => boundary.betweenParagraphs),
    [[2, 3]]
  );
  assert.equal(parsed.scenes[0]?.sceneCard, "Аня приходит к дому.");
  assert.deepEqual(parsed.scenes[0]?.facts, ["Аня подходит к двери", "Аня стучит"]);
  assert.deepEqual(parsed.scenes[0]?.mentionedEntities, ["Аня", "дом", "дверь"]);
});

test("parseSearchUnitSegmentationResponse repairs small gaps", () => {
  const parsed = parseSearchUnitSegmentationResponse({
    content: [
      "1\t2\tАня приходит к дому.\tАня подходит к двери\tАня; дом",
      "4\t4\tБорис открывает дверь.\tБорис открывает\tБорис",
    ].join("\n"),
    segmentStartParagraph: 1,
    segmentEndParagraph: 4,
  });

  assert.equal(parsed.scenes.length, 2);
  assert.equal(parsed.scenes[0]?.paragraphEnd, 3);
  assert.equal(parsed.scenes[1]?.paragraphStart, 4);
});

test("parseSearchUnitSegmentationResponse repairs overlaps", () => {
  const parsed = parseSearchUnitSegmentationResponse({
    content: [
      "1\t3\tАня приходит к дому.\tАня подходит к двери\tАня; дом",
      "3\t4\tБорис открывает дверь.\tБорис открывает\tБорис",
    ].join("\n"),
    segmentStartParagraph: 1,
    segmentEndParagraph: 4,
  });

  assert.equal(parsed.scenes.length, 2);
  assert.equal(parsed.scenes[0]?.paragraphEnd, 3);
  assert.equal(parsed.scenes[1]?.paragraphStart, 4);
});

test("parseSearchUnitSegmentationResponse rejects empty beats", () => {
  assert.throws(
    () =>
      parseSearchUnitSegmentationResponse({
        content: "1\t4\tАня приходит к дому.\t\tАня; дом",
        segmentStartParagraph: 1,
        segmentEndParagraph: 4,
      }),
    /beats/
  );
});
