import { describe, expect, it } from "vitest";
import {
  ExtractionResultSchema,
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
        entityRef: "e_time_1",
        type: "time_marker",
        name: "Three days later",
        paragraphIndex: 1,
        mentionText: "Three days later",
      },
    ]);

    expect(resolved).toEqual([
      {
        entityRef: "e_char_1",
        paragraphIndex: 0,
        startOffset: 0,
        endOffset: 4,
        sourceText: "Eren",
        type: "character",
        name: "Eren",
      },
      {
        entityRef: "e_time_1",
        paragraphIndex: 1,
        startOffset: 15,
        endOffset: 31,
        sourceText: "Three days later",
        type: "time_marker",
        name: "Three days later",
      },
    ]);
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
