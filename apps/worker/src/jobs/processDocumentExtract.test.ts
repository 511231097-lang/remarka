import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "@remarka/contracts";
import { collectEntityCandidates, orderCandidatesForUpsert } from "./entityCandidates";
import { buildParagraphDiff } from "./paragraphDiff";
import { expandUnambiguousCharacterMentions } from "./mentionExpansion";

describe("processDocumentExtract helpers", () => {
  it("collects location candidates with different refs for same name", () => {
    const extraction: ExtractionResult = {
      entities: [
        {
          entityRef: "loc_city_a",
          type: "location",
          name: "Красноярск",
          summary: "Город в регионе А",
        },
        {
          entityRef: "loc_city_b",
          type: "location",
          name: "Красноярск",
          summary: "Город в регионе Б",
        },
      ],
      mentions: [
        {
          entityRef: "loc_city_a",
          type: "location",
          name: "Красноярск",
          paragraphIndex: 0,
          mentionText: "Красноярск",
        },
        {
          entityRef: "loc_city_b",
          type: "location",
          name: "Красноярск",
          paragraphIndex: 1,
          mentionText: "Красноярск",
        },
      ],
      annotations: [],
      locationContainments: [],
    };

    const candidates = orderCandidatesForUpsert(collectEntityCandidates(extraction));

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.entityRef).sort()).toEqual(["loc_city_a", "loc_city_b"]);
  });

  it("keeps orphan locations when containment is absent", () => {
    const extraction: ExtractionResult = {
      entities: [
        {
          entityRef: "loc_tower",
          type: "location",
          name: "Сторожевая башня",
          summary: "",
        },
      ],
      mentions: [
        {
          entityRef: "loc_tower",
          type: "location",
          name: "Сторожевая башня",
          paragraphIndex: 0,
          mentionText: "Сторожевая башня",
        },
      ],
      annotations: [],
      locationContainments: [],
    };

    const candidates = collectEntityCandidates(extraction);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("location");
    expect(candidates[0].entityRef).toBe("loc_tower");
  });

  it("deduplicates same entityRef across entities and mentions", () => {
    const extraction: ExtractionResult = {
      entities: [
        {
          entityRef: "loc_city",
          type: "location",
          name: "Красноярск",
          summary: "Город на Енисее",
        },
      ],
      mentions: [
        {
          entityRef: "loc_city",
          type: "location",
          name: "Красноярск",
          paragraphIndex: 0,
          mentionText: "Красноярске",
        },
        {
          entityRef: "loc_city",
          type: "location",
          name: "Красноярск",
          paragraphIndex: 1,
          mentionText: "Красноярск",
        },
      ],
      annotations: [
        {
          entityRef: "loc_city",
          paragraphIndex: 0,
          type: "location",
          label: "Город",
          name: "Красноярск",
        },
      ],
      locationContainments: [],
    };

    const candidates = collectEntityCandidates(extraction);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("location");
    expect(candidates[0].summary).toBe("Город на Енисее");
  });

  it("ignores entities without mentions", () => {
    const extraction: ExtractionResult = {
      entities: [
        {
          entityRef: "event_hidden",
          type: "event",
          name: "Тайное событие",
          summary: "Не подтверждено прямым упоминанием",
        },
      ],
      mentions: [],
      annotations: [
        {
          entityRef: "event_hidden",
          paragraphIndex: 0,
          type: "event",
          label: "Подозрительное событие",
          name: "Тайное событие",
        },
      ],
      locationContainments: [],
    };

    const candidates = collectEntityCandidates(extraction);
    expect(candidates).toHaveLength(0);
  });

  it("expands repeated character mentionText across paragraphs when unambiguous", () => {
    const content = [
      "Дом миссис Линд стоял у дороги. Под взглядом миссис Линд даже ручей был тихим.",
      "Потом миссис Линд пошла к соседям.",
    ].join("\n\n");

    const expanded = expandUnambiguousCharacterMentions(content, [
      {
        entityRef: "char_lind",
        type: "character",
        name: "Рейчел Линд",
        paragraphIndex: 1,
        mentionText: "миссис Линд",
      },
    ]);

    const target = expanded.filter(
      (mention) =>
        mention.entityRef === "char_lind" &&
        mention.type === "character" &&
        mention.name === "Рейчел Линд" &&
        mention.mentionText === "миссис Линд"
    );

    expect(target).toHaveLength(3);
    expect(target.map((mention) => mention.paragraphIndex).sort((a, b) => a - b)).toEqual([0, 0, 1]);
  });

  it("does not expand ambiguous mentionText shared by different characters", () => {
    const content = "миссис Линд поговорила с миссис Линд.";

    const expanded = expandUnambiguousCharacterMentions(content, [
      {
        entityRef: "char_lind_1",
        type: "character",
        name: "Рейчел Линд",
        paragraphIndex: 0,
        mentionText: "миссис Линд",
      },
      {
        entityRef: "char_lind_2",
        type: "character",
        name: "Элеонор Линд",
        paragraphIndex: 0,
        mentionText: "миссис Линд",
      },
    ]);

    expect(expanded).toHaveLength(2);
  });

  it("does not auto-expand single-word character mentionText", () => {
    const content = "Рейчел подошла к двери. Рейчел молчала.";

    const expanded = expandUnambiguousCharacterMentions(content, [
      {
        entityRef: "char_lind",
        type: "character",
        name: "Рейчел Линд",
        paragraphIndex: 0,
        mentionText: "Рейчел",
      },
    ]);

    expect(expanded).toHaveLength(1);
  });
});

describe("paragraph diff", () => {
  it("does not mark tail as changed when paragraph inserted at beginning", () => {
    const diff = buildParagraphDiff("A\n\nB\n\nC", "X\n\nA\n\nB\n\nC");

    expect(diff.mode).toBe("incremental");
    expect(diff.changedNewIndices).toEqual([0]);
    expect(diff.unchangedMap).toEqual([
      { newIndex: 1, oldIndex: 0 },
      { newIndex: 2, oldIndex: 1 },
      { newIndex: 3, oldIndex: 2 },
    ]);
  });

  it("marks exactly one changed paragraph for local edit", () => {
    const diff = buildParagraphDiff("A\n\nB\n\nC\n\nD\n\nE", "A\n\nB2\n\nC\n\nD\n\nE");

    expect(diff.mode).toBe("incremental");
    expect(diff.changedNewIndices).toEqual([1]);
  });

  it("switches to anchor mode for large documents", () => {
    const oldParagraphs = Array.from({ length: 1300 }, (_, index) => `P-${index}`).join("\n\n");
    const newParagraphs = Array.from({ length: 1301 }, (_, index) =>
      index === 650 ? "INSERTED" : `P-${index > 650 ? index - 1 : index}`
    ).join("\n\n");

    const diff = buildParagraphDiff(oldParagraphs, newParagraphs);

    expect(diff.algorithm).toBe("anchor");
    expect(diff.mode).toBe("incremental");
    expect(diff.changedNewIndices).toEqual([650]);
  });

  it("falls back to full when anchor confidence is low", () => {
    const oldParagraphs = Array.from({ length: 1300 }, () => "same").join("\n\n");
    const newParagraphs = Array.from({ length: 1300 }, () => "same").join("\n\n");

    const diff = buildParagraphDiff(oldParagraphs, newParagraphs);

    expect(diff.algorithm).toBe("anchor");
    expect(diff.mode).toBe("full");
    expect(diff.reason).toBe("low_confidence");
  });

  it("falls back to full when more than 30 paragraphs changed", () => {
    const oldParagraphs = Array.from({ length: 40 }, (_, index) => `P-${index}`).join("\n\n");
    const newParagraphs = Array.from({ length: 40 }, (_, index) =>
      index < 31 ? `UPDATED-${index}` : `P-${index}`
    ).join("\n\n");

    const diff = buildParagraphDiff(oldParagraphs, newParagraphs);

    expect(diff.mode).toBe("full");
    expect(diff.reason).toBe("too_many_changes");
    expect(diff.changedNewIndices.length).toBeGreaterThan(30);
  });

  it("falls back to full when more than 25% of paragraphs changed", () => {
    const oldParagraphs = Array.from({ length: 20 }, (_, index) => `P-${index}`).join("\n\n");
    const newParagraphs = Array.from({ length: 20 }, (_, index) =>
      index < 6 ? `UPDATED-${index}` : `P-${index}`
    ).join("\n\n");

    const diff = buildParagraphDiff(oldParagraphs, newParagraphs);

    expect(diff.mode).toBe("full");
    expect(diff.reason).toBe("too_many_changes");
    expect(diff.changedNewIndices).toHaveLength(6);
  });
});
