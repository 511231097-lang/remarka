import { describe, expect, it } from "vitest";
import {
  ActPassResultSchema,
  AppearancePassResultSchema,
  classifyMentionTypeFromAlias,
  ExtractionResultSchema,
  isPronounConfidenceAccepted,
  normalizeAliasType,
  normalizeEntityName,
  resolveMentionOffsets,
  richTextToPlainText,
  splitParagraphs,
} from "@remarka/contracts";

describe("contracts utilities", () => {
  it("normalizes entity names for dedupe", () => {
    expect(normalizeEntityName("  Eren Voss  ")).toBe("eren voss");
    expect(normalizeEntityName("Eren, Voss!")).toBe("eren voss");
  });

  it("normalizes alias type with fallback", () => {
    expect(normalizeAliasType("nickname")).toBe("nickname");
    expect(normalizeAliasType("title")).toBe("title");
    expect(normalizeAliasType("unknown", "descriptor")).toBe("descriptor");
  });

  it("classifies mention type from alias metadata", () => {
    expect(
      classifyMentionTypeFromAlias({
        canonicalName: "Гарри Поттер",
        alias: "Гарри Поттер",
        aliasType: "name",
      })
    ).toBe("named");

    expect(
      classifyMentionTypeFromAlias({
        canonicalName: "Гарри Поттер",
        alias: "директор",
        aliasType: "descriptor",
      })
    ).toBe("descriptor");

    expect(
      classifyMentionTypeFromAlias({
        canonicalName: "Гарри Поттер",
        alias: "Гарри",
        aliasType: "nickname",
      })
    ).toBe("alias");
  });

  it("applies pronoun confidence threshold", () => {
    expect(isPronounConfidenceAccepted(0.9)).toBe(true);
    expect(isPronounConfidenceAccepted(0.899)).toBe(false);
    expect(isPronounConfidenceAccepted(0.88, 0.88)).toBe(true);
  });

  it("splits paragraphs and computes deterministic starts", () => {
    const paragraphs = splitParagraphs("Alpha\n\nBeta line\nnext");

    expect(paragraphs).toEqual([
      { index: 0, text: "Alpha", startOffset: 0 },
      { index: 1, text: "Beta line\nnext", startOffset: 7 },
    ]);
  });

  it("resolves mention offsets from paragraph and mention text", () => {
    const resolved = resolveMentionOffsets("Eren arrived.\n\nThree days later Eren left.", [
      {
        entityRef: "e_char_1",
        type: "character",
        name: "Eren",
        paragraphIndex: 0,
        mentionText: "Eren",
      },
      {
        entityRef: "e_event_1",
        type: "event",
        name: "departure",
        paragraphIndex: 1,
        mentionText: "left",
      },
    ]);

    expect(resolved).toEqual([
      {
        entityRef: "e_char_1",
        paragraphIndex: 0,
        mentionText: "Eren",
        startOffset: 0,
        endOffset: 4,
        sourceText: "Eren",
        type: "character",
        name: "Eren",
      },
      {
        entityRef: "e_event_1",
        paragraphIndex: 1,
        mentionText: "left",
        startOffset: 37,
        endOffset: 41,
        sourceText: "left",
        type: "event",
        name: "departure",
      },
    ]);
  });

  it("prefers whole-word matches before partial substring matches", () => {
    const content = "Кажется, ты задела почку, я опускаю взгляд.";
    const resolved = resolveMentionOffsets(content, [
      {
        entityRef: "e_char_1",
        type: "character",
        name: "Главная героиня",
        paragraphIndex: 0,
        mentionText: "Я",
      },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].startOffset).toBe(content.indexOf("я опускаю"));
    expect(resolved[0].endOffset).toBe(content.indexOf("я опускаю") + 1);
    expect(resolved[0].sourceText).toBe("Я");
  });

  it("falls back to partial substring matching when whole-word search misses", () => {
    const content = "Круг ведьмами замкнулся.";
    const resolved = resolveMentionOffsets(content, [
      {
        entityRef: "e_char_1",
        type: "character",
        name: "Ведьмы",
        paragraphIndex: 0,
        mentionText: "ведьм",
      },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].startOffset).toBe(content.indexOf("ведьмами"));
    expect(resolved[0].endOffset).toBe(content.indexOf("ведьмами") + "ведьм".length);
    expect(resolved[0].sourceText).toBe("ведьм");
  });

  it("validates extraction schema with location containments", () => {
    const parsed = ExtractionResultSchema.parse({
      entities: [
        { entityRef: "loc_krsk", type: "location", name: "Красноярск", summary: "Город в Сибири." },
        { entityRef: "loc_street", type: "location", name: "Улица Карла Маркса", summary: "Локальная точка действия." },
      ],
      mentions: [
        {
          entityRef: "loc_street",
          type: "location",
          name: "Улица Карла Маркса",
          paragraphIndex: 0,
          mentionText: "Карла Маркса",
        },
      ],
      annotations: [
        {
          entityRef: "loc_street",
          paragraphIndex: 0,
          type: "location",
          label: "Локация: Улица Карла Маркса",
          name: "Улица Карла Маркса",
        },
      ],
      locationContainments: [{ childRef: "loc_street", parentRef: "loc_krsk" }],
    });

    expect(parsed.entities).toHaveLength(2);
    expect(parsed.mentions).toHaveLength(1);
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.locationContainments).toHaveLength(1);
  });

  it("validates act-pass schema with ordered ranges", () => {
    const parsed = ActPassResultSchema.parse({
      contentVersion: 3,
      acts: [
        {
          orderIndex: 0,
          title: "Разговор в купе",
          summary: "Герои знакомятся и обсуждают дорогу.",
          paragraphStart: 0,
          paragraphEnd: 4,
        },
        {
          orderIndex: 1,
          title: "Появление нового персонажа",
          summary: "К беседе подключается Гермиона и поездка продолжается.",
          paragraphStart: 5,
          paragraphEnd: 9,
        },
      ],
    });

    expect(parsed.acts).toHaveLength(2);
    expect(parsed.acts[0]?.title).toContain("Разговор");
  });

  it("validates appearance-pass schema with evidence links", () => {
    const parsed = AppearancePassResultSchema.parse({
      contentVersion: 2,
      observations: [
        {
          orderIndex: 0,
          characterId: "char_1",
          attributeKey: "clothing",
          attributeLabel: "Одежда",
          value: "Мятая школьная мантия",
          scope: "scene",
          actOrderIndex: 1,
          summary: "Внешний вид подчеркивает усталость персонажа.",
          confidence: 0.81,
          evidenceIds: ["mention_1", "mention_2"],
        },
      ],
    });

    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]?.attributeKey).toBe("clothing");
    expect(parsed.observations[0]?.evidenceIds).toEqual(["mention_1", "mention_2"]);
  });

  it("rejects legacy location enum values", () => {
    expect(() =>
      ExtractionResultSchema.parse({
        entities: [
          {
            entityRef: "loc_legacy",
            type: "location_city",
            name: "Красноярск",
            summary: "",
          },
        ],
        mentions: [],
        annotations: [],
        locationContainments: [],
      })
    ).toThrow();
  });

  it("converts rich document json into canonical plain text", () => {
    const plain = richTextToPlainText({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Chapter 1" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Eren " },
            { type: "text", marks: [{ type: "bold" }], text: "arrived" },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "point one" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "point two" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(plain).toBe("Chapter 1\n\nEren arrived.\n\npoint one\n\npoint two");
  });
});
