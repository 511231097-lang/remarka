import { Mark, mergeAttributes } from "@tiptap/core";

export const EntityHighlight = Mark.create({
  name: "entityHighlight",
  inclusive: false,
  spanning: false,

  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (element) => element.getAttribute("class"),
      },
      dataEntityId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-entity-id"),
        renderHTML: (attributes) =>
          attributes.dataEntityId ? { "data-entity-id": attributes.dataEntityId } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "mark[data-entity-id]",
      },
      {
        tag: "mark.entity",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
});

