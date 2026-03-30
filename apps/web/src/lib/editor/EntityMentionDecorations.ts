import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { DocumentPayload } from "@remarka/contracts";
import { buildMentionDecorations } from "@/lib/editor/mentionDecorations";

type MentionItem = DocumentPayload["mentions"][number];

interface MentionDecorationMeta {
  mentions: MentionItem[];
  activeEntityId: string | null;
  activeMentionId: string | null;
}

const mentionDecorationsKey = new PluginKey<MentionDecorationMeta>("entityMentionDecorations");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mentionDecorations: {
      setMentionDecorations: (payload: MentionDecorationMeta) => ReturnType;
    };
  }
}

export const EntityMentionDecorations = Extension.create<{
  mentions: MentionItem[];
  activeEntityId: string | null;
  activeMentionId: string | null;
}>({
  name: "entityMentionDecorations",

  addOptions() {
    return {
      mentions: [],
      activeEntityId: null,
      activeMentionId: null,
    };
  },

  addCommands() {
    return {
      setMentionDecorations:
        (payload: MentionDecorationMeta) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          dispatch(tr.setMeta(mentionDecorationsKey, payload));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const initialState: MentionDecorationMeta = {
      mentions: this.options.mentions,
      activeEntityId: this.options.activeEntityId,
      activeMentionId: this.options.activeMentionId,
    };

    return [
      new Plugin<MentionDecorationMeta>({
        key: mentionDecorationsKey,
        state: {
          init: () => initialState,
          apply: (tr, prev) => tr.getMeta(mentionDecorationsKey) || prev,
        },
        props: {
          decorations: (state) => {
            const current = mentionDecorationsKey.getState(state) || initialState;
            const decorations = buildMentionDecorations(
              state.doc,
              current.mentions,
              current.activeEntityId,
              current.activeMentionId,
              (from, to, attrs) => Decoration.inline(from, to, attrs)
            );

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
