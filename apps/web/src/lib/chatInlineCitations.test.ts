import test from "node:test";
import assert from "node:assert/strict";
import type { BookQuoteListItemDTO } from "./books";
import { validateInlineCitationAnnotation } from "./chatInlineCitations";

const quoteCards: BookQuoteListItemDTO[] = [
  {
    id: "quote-1",
    chapterOrderIndex: 7,
    startChar: 0,
    endChar: 80,
    text: "В душе его боролись страх и какое-то новое, непривычное спокойствие.",
    type: "reflection",
    tags: ["identity"],
    confidence: 0.91,
    commentary: "Внутренний перелом героя",
    mentions: [],
  },
  {
    id: "quote-2",
    chapterOrderIndex: 8,
    startChar: 0,
    endChar: 64,
    text: "Он видел, как вокруг рушится прежний порядок и открывается иной смысл.",
    type: "narration",
    tags: ["hope"],
    confidence: 0.88,
    commentary: null,
    mentions: [],
  },
];

test("validateInlineCitationAnnotation accepts valid quote-backed anchors", () => {
  const result = validateInlineCitationAnnotation({
    rawAnswer: "Пьер переживает внутренний перелом и начинает видеть другой смысл.",
    annotatedAnswerMarkdown:
      "[Пьер переживает внутренний перелом](cite:a1) и [начинает видеть другой смысл](cite:a2).",
    anchors: [
      { anchorId: "a1", quoteIds: ["quote-1"] },
      { anchorId: "a2", quoteIds: ["quote-2"] },
    ],
    quoteCards,
  });

  assert.ok(result);
  assert.equal(result?.inlineCitations.length, 2);
  assert.equal(result?.inlineCitations[0]?.quotes[0]?.id, "quote-1");
});

test("validateInlineCitationAnnotation rejects unknown quote ids", () => {
  const result = validateInlineCitationAnnotation({
    rawAnswer: "Пьер переживает внутренний перелом.",
    annotatedAnswerMarkdown: "[Пьер переживает внутренний перелом](cite:a1).",
    anchors: [{ anchorId: "a1", quoteIds: ["missing-quote"] }],
    quoteCards,
  });

  assert.equal(result, null);
});

test("validateInlineCitationAnnotation rejects rewritten answers", () => {
  const result = validateInlineCitationAnnotation({
    rawAnswer: "Пьер переживает внутренний перелом.",
    annotatedAnswerMarkdown: "[Пьер окончательно меняется](cite:a1).",
    anchors: [{ anchorId: "a1", quoteIds: ["quote-1"] }],
    quoteCards,
  });

  assert.equal(result, null);
});
