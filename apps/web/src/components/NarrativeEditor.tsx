"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DocumentPayload } from "@remarka/contracts";
import { EMPTY_RICH_TEXT_DOCUMENT } from "@remarka/contracts";
import { EntityMentionDecorations } from "@/lib/editor/EntityMentionDecorations";

interface NarrativeEditorProps {
  richContent: unknown;
  mentions: DocumentPayload["mentions"];
  activeEntityId: string | null;
  activeMentionId: string | null;
  scrollToMentionRequest?: { mentionId: string; token: number } | null;
  debugTag?: string;
  onChange: (richContent: unknown, meta: { userInitiated: boolean }) => void;
}

function clampPosition(position: number, max: number): number {
  return Math.max(0, Math.min(position, max));
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`editor-tool ${active ? "active" : ""}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

export function NarrativeEditor({
  richContent,
  mentions,
  activeEntityId,
  activeMentionId,
  scrollToMentionRequest = null,
  debugTag,
  onChange,
}: NarrativeEditorProps) {
  const syncingRef = useRef(false);
  const lastScrolledMentionRef = useRef<string | null>(null);
  const debugSeqRef = useRef(0);

  const debugLog = useCallback(
    (event: string, payload?: Record<string, unknown>) => {
      if (!debugTag) return;
      debugSeqRef.current += 1;
      console.info(`[remarka][editor:${debugTag}][${debugSeqRef.current}] ${event}`, payload || {});
    },
    [debugTag]
  );

  const serializedExternal = useMemo(
    () => JSON.stringify(richContent || EMPTY_RICH_TEXT_DOCUMENT),
    [richContent]
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      EntityMentionDecorations.configure({
        mentions,
        activeEntityId,
        activeMentionId,
      }),
    ],
    content: richContent || EMPTY_RICH_TEXT_DOCUMENT,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "editor-root",
      },
    },
    onUpdate: ({ editor: editorInstance, transaction }) => {
      if (syncingRef.current) return;
      const userInitiated =
        editorInstance.isFocused &&
        transaction.docChanged &&
        transaction.getMeta("addToHistory") !== false;
      debugLog("onUpdate", {
        userInitiated,
        docChanged: transaction.docChanged,
        focused: editorInstance.isFocused,
        textLength: editorInstance.getText().length,
        externalPlainLength: JSON.stringify(richContent || EMPTY_RICH_TEXT_DOCUMENT).length,
      });
      onChange(editorInstance.getJSON(), {
        userInitiated,
      });
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setMentionDecorations({
      mentions,
      activeEntityId,
      activeMentionId,
    });
    debugLog("setMentionDecorations", {
      mentions: mentions.length,
      activeEntityId,
      activeMentionId,
    });
  }, [editor, mentions, activeEntityId, activeMentionId, debugLog]);

  useEffect(() => {
    if (!editor) return;

    const currentSerialized = JSON.stringify(editor.getJSON());
    if (currentSerialized === serializedExternal) {
      debugLog("sync:skip_equal", {
        currentLength: editor.getText().length,
      });
      return;
    }

    const wasFocused = editor.isFocused;
    const previousSelection = editor.state.selection;

    syncingRef.current = true;
    try {
      debugLog("sync:setContent:start", {
        currentLength: editor.getText().length,
      });
      editor.commands.setContent(richContent || EMPTY_RICH_TEXT_DOCUMENT, false, {
        preserveWhitespace: "full",
      });

      const maxPosition = editor.state.doc.content.size;
      const nextFrom = clampPosition(previousSelection.from, maxPosition);
      const nextTo = clampPosition(previousSelection.to, maxPosition);
      editor.commands.setTextSelection({ from: nextFrom, to: nextTo });

      if (wasFocused) {
        editor.view.focus();
      }
      debugLog("sync:setContent:done", {
        nextLength: editor.getText().length,
        maxPosition,
        nextFrom,
        nextTo,
      });
    } finally {
      syncingRef.current = false;
    }
  }, [editor, richContent, serializedExternal, debugLog]);

  useEffect(() => {
    if (!editor) return;
    if (!scrollToMentionRequest?.mentionId) {
      lastScrolledMentionRef.current = null;
      return;
    }

    const mentionId = scrollToMentionRequest.mentionId;
    const selector = `[data-mention-id="${mentionId}"]`;
    let attempts = 0;
    let cancelled = false;

    const tryScroll = () => {
      if (cancelled) return;
      attempts += 1;

      const target = editor.view.dom.querySelector(selector) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "smooth",
        });
        lastScrolledMentionRef.current = mentionId;
        debugLog("mention:scroll_success", { mentionId, attempts });
        return;
      }

      if (attempts < 10) {
        requestAnimationFrame(tryScroll);
        return;
      }

      debugLog("mention:scroll_not_found", { mentionId });
    };

    if (lastScrolledMentionRef.current === mentionId) {
      lastScrolledMentionRef.current = null;
    }

    requestAnimationFrame(tryScroll);

    return () => {
      cancelled = true;
    };
  }, [editor, scrollToMentionRequest, debugLog]);

  return (
    <div className="editor-surface">
      {editor ? (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 120 }} className="editor-bubble">
          <ToolbarButton
            label="B"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolbarButton
            label="I"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolbarButton
            label="S"
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolbarButton
            label="Code"
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <span className="editor-divider" />
          <ToolbarButton
            label="H1"
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          />
          <ToolbarButton
            label="H2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <ToolbarButton
            label="H3"
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          />
        </BubbleMenu>
      ) : null}

      <EditorContent editor={editor} className="editor-content-host" />
    </div>
  );
}
