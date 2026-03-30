import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { buildMentionDecorations } from "../editor/mentionDecorations";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    hardBreak: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
    text: { group: "inline" },
  },
});

describe("mention decorations", () => {
  it("maps plain text offsets to doc ranges", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Alpha Beta")]),
      schema.node("paragraph", null, [schema.text("Gamma Delta")]),
    ]);

    const decorations = buildMentionDecorations(
      doc,
      [
        {
          id: "m1",
          entityId: "e1",
          paragraphIndex: 0,
          startOffset: 6,
          endOffset: 10,
          sourceText: "Beta",
          entity: {
            id: "e1",
            type: "character",
            name: "Beta",
          },
        },
      ],
      "e1",
      "m1",
      (from, to, attrs) => ({ from, to, attrs }) as any
    ) as unknown as Array<{ from: number; to: number; attrs: Record<string, string> }>;

    expect(decorations).toHaveLength(1);
    expect(decorations[0].from).toBeLessThan(decorations[0].to);
    expect(doc.textBetween(decorations[0].from, decorations[0].to)).toBe("Beta");
    expect(decorations[0].attrs.class).toContain("entity-active");
    expect(decorations[0].attrs.class).toContain("entity-mention-selected");
    expect(decorations[0].attrs["data-entity-id"]).toBe("e1");
    expect(decorations[0].attrs["data-mention-id"]).toBe("m1");
  });

  it("stays aligned after canonicalization of trailing spaces and 3+ line breaks", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("A "),
        schema.node("hardBreak"),
        schema.node("hardBreak"),
        schema.node("hardBreak"),
        schema.text("B"),
      ]),
    ]);

    const decorations = buildMentionDecorations(
      doc,
      [
        {
          id: "m2",
          entityId: "e2",
          paragraphIndex: 0,
          startOffset: 3,
          endOffset: 4,
          sourceText: "B",
          entity: {
            id: "e2",
            type: "event",
            name: "B",
          },
        },
      ],
      null,
      null,
      (from, to, attrs) => ({ from, to, attrs }) as any
    ) as unknown as Array<{ from: number; to: number; attrs: Record<string, string> }>;

    expect(decorations).toHaveLength(1);
    expect(doc.textBetween(decorations[0].from, decorations[0].to)).toBe("B");
  });
});
