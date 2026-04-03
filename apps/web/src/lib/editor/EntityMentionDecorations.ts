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

interface MentionDecorationState extends MentionDecorationMeta {
  decorations: DecorationSet;
}

const mentionDecorationsKey = new PluginKey<MentionDecorationState>("entityMentionDecorations");

function buildDecorationSet(
  doc: Parameters<typeof buildMentionDecorations>[0],
  payload: MentionDecorationMeta
): DecorationSet {
  const decorations = buildMentionDecorations(
    doc,
    payload.mentions,
    payload.activeEntityId,
    payload.activeMentionId,
    (from, to, attrs) => Decoration.inline(from, to, attrs)
  );

  return DecorationSet.create(doc, decorations);
}

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
    const initialPayload: MentionDecorationMeta = {
      mentions: this.options.mentions,
      activeEntityId: this.options.activeEntityId,
      activeMentionId: this.options.activeMentionId,
    };

    return [
      new Plugin<MentionDecorationState>({
        key: mentionDecorationsKey,
        state: {
          init: (_, state) => ({
            ...initialPayload,
            decorations: buildDecorationSet(state.doc, initialPayload),
          }),
          apply: (tr, prev, _oldState, newState) => {
            const meta = tr.getMeta(mentionDecorationsKey) as MentionDecorationMeta | undefined;
            if (meta) {
              return {
                ...meta,
                decorations: buildDecorationSet(newState.doc, meta),
              };
            }

            if (!tr.docChanged) {
              return prev;
            }

            return {
              ...prev,
              decorations: prev.decorations.map(tr.mapping, tr.doc),
            };
          },
        },
        props: {
          decorations: (state) => {
            const current = mentionDecorationsKey.getState(state);
            if (!current) return DecorationSet.empty;

            // Safety fallback: if mapped decorations become empty unexpectedly,
            // rebuild directly from mention offsets to keep highlights visible.
            if (current.mentions.length > 0 && current.decorations.find().length === 0) {
              return buildDecorationSet(state.doc, current);
            }

            return current.decorations;
          },
        },
      }),
    ];
  },
});
