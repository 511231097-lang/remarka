"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DocumentPayload } from "@remarka/contracts";
import { EMPTY_RICH_TEXT_DOCUMENT } from "@remarka/contracts";
import { EntityMentionDecorations } from "@/lib/editor/EntityMentionDecorations";

interface NarrativeEditorProps {
  richContent: unknown;
  mentions: DocumentPayload["mentions"];
  editable?: boolean;
  activeEntityId: string | null;
  activeMentionId: string | null;
  scrollToMentionRequest?: { mentionId: string; token: number } | null;
  debugTag?: string;
  onMentionOpenEntity?: (payload: { mentionId: string; entityId: string }) => void;
  onChange: (richContent: unknown, meta: { userInitiated: boolean }) => void;
}

function clampPosition(position: number, max: number): number {
  return Math.max(0, Math.min(position, max));
}

type MentionItem = DocumentPayload["mentions"][number];

interface MentionTooltipState {
  mentionId: string;
  entityId: string;
  entityName: string;
  left: number;
  top: number;
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
  editable = true,
  activeEntityId,
  activeMentionId,
  scrollToMentionRequest = null,
  debugTag,
  onMentionOpenEntity,
  onChange,
}: NarrativeEditorProps) {
  const syncingRef = useRef(false);
  const lastScrolledMentionRef = useRef<string | null>(null);
  const debugSeqRef = useRef(0);
  const hideTooltipTimerRef = useRef<number | null>(null);
  const isTooltipHoveredRef = useRef(false);
  const mentionsRef = useRef<DocumentPayload["mentions"]>(mentions);
  const [mentionTooltip, setMentionTooltip] = useState<MentionTooltipState | null>(null);

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
  const mentionsById = useMemo(() => {
    const map = new Map<string, MentionItem>();
    mentions.forEach((mention) => map.set(mention.id, mention));
    return map;
  }, [mentions]);
  const mentionsSignature = useMemo(
    () =>
      mentions
        .map((mention) =>
          [
            mention.id,
            mention.entityId,
            mention.paragraphIndex,
            mention.startOffset,
            mention.endOffset,
            mention.sourceText,
            mention.entity.type,
          ].join(":")
        )
        .join("|"),
    [mentions]
  );

  useEffect(() => {
    mentionsRef.current = mentions;
  }, [mentions]);

  const clearHideTooltipTimer = useCallback(() => {
    if (hideTooltipTimerRef.current !== null) {
      window.clearTimeout(hideTooltipTimerRef.current);
      hideTooltipTimerRef.current = null;
    }
  }, []);

  const scheduleTooltipHide = useCallback(() => {
    clearHideTooltipTimer();
    hideTooltipTimerRef.current = window.setTimeout(() => {
      if (isTooltipHoveredRef.current) return;
      setMentionTooltip(null);
    }, 140);
  }, [clearHideTooltipTimer]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      EntityMentionDecorations,
    ],
    content: richContent || EMPTY_RICH_TEXT_DOCUMENT,
    editable,
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
  }, []);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    editor.commands.setMentionDecorations({
      mentions: mentionsRef.current,
      activeEntityId,
      activeMentionId,
    });
    debugLog("setMentionDecorations", {
      mentions: mentions.length,
      activeEntityId,
      activeMentionId,
    });
  }, [editor, mentionsSignature, activeEntityId, activeMentionId, debugLog]);

  useEffect(() => {
    if (!editor) return;

    const currentSerialized = JSON.stringify(editor.getJSON());
    if (currentSerialized === serializedExternal) {
      debugLog("sync:skip_equal", {
        currentLength: editor.getText().length,
      });
      return;
    }

    // While user is actively typing, keep editor state authoritative and
    // avoid external setContent rewrites that can shift decoration anchors.
    if (editor.isFocused) {
      debugLog("sync:skip_focused", {
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

  useEffect(() => {
    if (!editor) return;

    const editorDom = editor.view.dom as HTMLElement;
    const scrollHost = editorDom.closest(".editor-content-host") as HTMLElement | null;

    const getMentionElement = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof HTMLElement)) return null;
      return target.closest("[data-mention-id][data-entity-id]") as HTMLElement | null;
    };

    const showMentionTooltip = (mentionElement: HTMLElement) => {
      const mentionId = mentionElement.dataset.mentionId?.trim() || "";
      if (!mentionId) return;
      const mention = mentionsById.get(mentionId);
      if (!mention) return;

      const rect = mentionElement.getBoundingClientRect();
      const left = Math.min(Math.max(rect.left + rect.width / 2, 16), window.innerWidth - 16);
      const top = Math.min(rect.bottom + 8, window.innerHeight - 12);

      setMentionTooltip({
        mentionId: mention.id,
        entityId: mention.entityId,
        entityName: mention.entity.name,
        left,
        top,
      });
    };

    const handleMouseOver = (event: MouseEvent) => {
      const mentionElement = getMentionElement(event.target);
      if (!mentionElement) return;
      clearHideTooltipTimer();
      showMentionTooltip(mentionElement);
    };

    const handleMouseMove = (event: MouseEvent) => {
      const mentionElement = getMentionElement(event.target);
      if (!mentionElement) return;
      showMentionTooltip(mentionElement);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const mentionElement = getMentionElement(event.target);
      if (!mentionElement) return;

      const related = event.relatedTarget;
      if (related instanceof HTMLElement && related.closest(".mention-hover-tooltip")) {
        return;
      }

      scheduleTooltipHide();
    };

    const handleScroll = () => {
      setMentionTooltip(null);
    };

    editorDom.addEventListener("mouseover", handleMouseOver);
    editorDom.addEventListener("mousemove", handleMouseMove);
    editorDom.addEventListener("mouseout", handleMouseOut);
    scrollHost?.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      editorDom.removeEventListener("mouseover", handleMouseOver);
      editorDom.removeEventListener("mousemove", handleMouseMove);
      editorDom.removeEventListener("mouseout", handleMouseOut);
      scrollHost?.removeEventListener("scroll", handleScroll);
    };
  }, [editor, mentionsById, clearHideTooltipTimer, scheduleTooltipHide]);

  useEffect(() => {
    if (!mentionTooltip) return;
    if (mentionsById.has(mentionTooltip.mentionId)) return;
    setMentionTooltip(null);
  }, [mentionTooltip, mentionsById]);

  useEffect(
    () => () => {
      clearHideTooltipTimer();
    },
    [clearHideTooltipTimer]
  );

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

      {mentionTooltip ? (
        <div
          className="mention-hover-tooltip"
          style={{ left: mentionTooltip.left, top: mentionTooltip.top }}
          onMouseEnter={() => {
            isTooltipHoveredRef.current = true;
            clearHideTooltipTimer();
          }}
          onMouseLeave={() => {
            isTooltipHoveredRef.current = false;
            scheduleTooltipHide();
          }}
        >
          <div className="mention-hover-caption">{mentionTooltip.entityName}</div>
          <button
            className="mention-hover-link"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onMentionOpenEntity?.({
                mentionId: mentionTooltip.mentionId,
                entityId: mentionTooltip.entityId,
              });
              setMentionTooltip(null);
            }}
          >
            Подробнее
          </button>
        </div>
      ) : null}

      <EditorContent editor={editor} className="editor-content-host" />
    </div>
  );
}
