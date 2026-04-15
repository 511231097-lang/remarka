import test from "node:test";
import assert from "node:assert/strict";
import { toBookChatMessageDTO } from "./books";

function buildChatMessage(input: {
  role?: "user" | "assistant";
  content: string;
  citationsJson?: unknown;
}) {
  return {
    id: "msg-1",
    role: input.role || "assistant",
    content: input.content,
    citationsJson: input.citationsJson ?? null,
    createdAt: new Date("2026-04-14T10:00:00.000Z"),
    updatedAt: new Date("2026-04-14T10:00:00.000Z"),
    sessionId: "session-1",
  } as Parameters<typeof toBookChatMessageDTO>[0];
}

test("toBookChatMessageDTO parses v7 inline citations, answer items and reference resolution", () => {
  const dto = toBookChatMessageDTO(
    buildChatMessage({
      content: "[Пьер страдает](cite:a1), но продолжает искать смысл.",
      citationsJson: {
        version: 7,
        rawAnswer: "Пьер страдает, но продолжает искать смысл.",
        inlineCitations: [
          {
            anchorId: "a1",
            quotes: [
              {
                id: "quote-1",
                chapterOrderIndex: 12,
                startChar: 0,
                endChar: 42,
                text: "Он почувствовал всю тяжесть внутренней муки.",
                type: "reflection",
                tags: ["theme"],
                confidence: 0.92,
                commentary: "Внутренний кризис Пьера",
                mentions: [],
              },
            ],
          },
        ],
        answerItems: [
          {
            id: "item-1",
            ordinal: 1,
            label: "Пьер страдает",
            summary: "Пьер страдает, но продолжает искать смысл.",
            linkedEntityIds: ["entity-1"],
            linkedEvidenceIds: ["quote-1"],
          },
        ],
        referenceResolution: {
          resolvedEntityIds: ["entity-1"],
          resolvedAnswerItemId: "item-1",
          confidence: "high",
          reason: "follow-up to previous item",
          overrideMode: "followup_item",
          fallbackUsed: false,
        },
      },
    })
  );

  assert.equal(dto.rawAnswer, "Пьер страдает, но продолжает искать смысл.");
  assert.equal(dto.inlineCitations.length, 1);
  assert.equal(dto.inlineCitations[0]?.anchorId, "a1");
  assert.equal(dto.inlineCitations[0]?.quotes[0]?.id, "quote-1");
  assert.equal(dto.answerItems.length, 1);
  assert.equal(dto.answerItems[0]?.id, "item-1");
  assert.equal(dto.referenceResolution?.resolvedAnswerItemId, "item-1");
  assert.equal(dto.referenceResolution?.overrideMode, "followup_item");
});

test("toBookChatMessageDTO keeps legacy v5 messages working", () => {
  const dto = toBookChatMessageDTO(
    buildChatMessage({
      content: "Старый ответ без inline citations.",
      citationsJson: {
        version: 5,
        confidence: "medium",
        citations: [],
      },
    })
  );

  assert.equal(dto.rawAnswer, "Старый ответ без inline citations.");
  assert.deepEqual(dto.inlineCitations, []);
  assert.deepEqual(dto.answerItems, []);
  assert.equal(dto.referenceResolution, null);
  assert.equal(dto.confidence, "medium");
});
