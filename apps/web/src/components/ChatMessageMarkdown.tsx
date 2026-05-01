"use client";

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BookChatInlineCitationAnchorDTO, BookQuoteTypeDTO } from "@/lib/books";

export interface ParagraphRange {
  start: number;
  end?: number;
}

export interface RefCiteFragment extends ParagraphRange {
  chapterOrderIndex: number;
}

export interface RefCiteRange {
  chapterOrderIndex: number;
  /** One or more paragraph ranges within the chapter. Always ≥1 entry. */
  paragraphRanges: ParagraphRange[];
  /** One or more paragraph ranges with chapter attached. Always ≥1 entry. */
  fragments: RefCiteFragment[];
}

interface ChatMessageMarkdownProps {
  content: string;
  className?: string;
  inlineCitations?: BookChatInlineCitationAnchorDTO[];
  /** Called when user clicks a `[chN:pM]` ref-id badge in the markdown. */
  onRefCite?: (ref: RefCiteRange) => void;
}

interface DesktopTooltipPosition {
  top: number;
  left: number;
  width: number;
}

function repairLegacyChatFormatting(content: string): string {
  let text = String(content || "").replace(/\r\n?/g, "\n").trim();

  // Older chat messages were saved after whitespace compaction, so markdown
  // lists collapsed into a single paragraph.
  if (!text.includes("\n") && /(?:^|\s)1\.\s/.test(text) && /(?:^|\s)2\.\s/.test(text)) {
    text = text
      .replace(/:\s+(?=1\.\s)/g, ":\n\n")
      .replace(/([.!?])\s+(?=\d+\.\s)/g, "$1\n")
      .replace(/\s+(?=\*\*Экспертный комментарий:\*\*)/g, "\n\n");
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Convert raw `[chN:pM]`, `[chN:pM-pK]`, `[chN:pA-pB, pC-pD]`,
 * `[chN:pA, chK:pB]` etc. ref-id tokens that the model emits in answers
 * into clickable markdown links so the renderer can intercept them as small
 * badges. The `(?!\()` lookahead skips already-formed markdown links.
 *
 * Inside the `(ref:...)` URL we strip whitespace so the URL is space-free.
 */
function injectRefCiteLinks(text: string): string {
  return text.replace(/\[([^\]\n]*\bch\d+:p\d+[^\]\n]*)\](?!\()/g, (match, rawBody) => {
    const segments = String(rawBody || "")
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (!segments.length) return match;

    const refs: Array<{ chapter: string; paragraph: string; display: string; explicitChapter: boolean }> = [];
    let currentChapter: string | null = null;
    for (const segment of segments) {
      const parsed = segment.match(/^(?:ch(\d+):)?(p\d+(?:-p\d+)?)$/);
      if (!parsed) return match;
      const explicitChapter = Boolean(parsed[1]);
      if (parsed[1]) currentChapter = parsed[1];
      if (!currentChapter) return match;
      const paragraph = parsed[2] || "";
      refs.push({
        chapter: currentChapter,
        paragraph,
        display: explicitChapter ? `ch${currentChapter}:${paragraph}` : paragraph,
        explicitChapter,
      });
    }

    const display = refs.map((ref, index) => (index === 0 && !ref.explicitChapter ? `ch${ref.chapter}:${ref.paragraph}` : ref.display)).join(", ");
    const cleanRefs = refs
      .map((ref, index) => (index === 0 || ref.explicitChapter ? `ch${ref.chapter}:${ref.paragraph}` : ref.paragraph))
      .join(",");
    return `[${display}](ref:${cleanRefs})`;
  });
}

function parseRefCite(href: string): RefCiteRange | null {
  if (!href.startsWith("ref:")) return null;
  const body = href.slice("ref:".length);
  const segments = String(body || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fragments: RefCiteFragment[] = [];
  let currentChapter: number | null = null;
  for (const segment of segments) {
    const rm = segment.match(/^(?:ch(\d+):)?p(\d+)(?:-p(\d+))?$/);
    if (!rm) continue;
    if (rm[1]) {
      currentChapter = Number.parseInt(rm[1], 10);
    }
    if (!Number.isFinite(currentChapter) || currentChapter == null || currentChapter < 1) continue;
    const start = Number.parseInt(rm[2] || "0", 10);
    if (!Number.isFinite(start) || start < 1) continue;
    const endRaw = rm[3] ? Number.parseInt(rm[3], 10) : NaN;
    // Drop reversed ranges like p10-p3 — they would highlight nothing and
    // produce a misleading "10–3" label in the reader chip.
    if (Number.isFinite(endRaw) && endRaw < start) continue;
    fragments.push({
      chapterOrderIndex: currentChapter,
      start,
      end: Number.isFinite(endRaw) ? endRaw : undefined,
    });
  }
  if (!fragments.length) return null;
  const chapterOrderIndex = fragments[0]!.chapterOrderIndex;
  return {
    chapterOrderIndex,
    paragraphRanges: fragments
      .filter((fragment) => fragment.chapterOrderIndex === chapterOrderIndex)
      .map(({ start, end }) => ({ start, end })),
    fragments,
  };
}

function resolveQuoteTypeLabel(type: BookQuoteTypeDTO): string {
  if (type === "dialogue") return "Диалог";
  if (type === "monologue") return "Монолог";
  if (type === "narration") return "Наррация";
  if (type === "description") return "Описание";
  if (type === "reflection") return "Размышление";
  return "Действие";
}

function useSupportsHover(): boolean {
  const [supportsHover, setSupportsHover] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setSupportsHover(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return supportsHover;
}

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted;
}

function resolveDesktopTooltipPosition(params: {
  triggerRect: DOMRect;
  viewportWidth: number;
  viewportHeight: number;
  cardHeight: number;
}): DesktopTooltipPosition {
  const margin = 16;
  const width = Math.min(384, Math.max(280, params.viewportWidth - margin * 2));
  const spaceBelow = params.viewportHeight - params.triggerRect.bottom - margin;
  const placeAbove = spaceBelow < params.cardHeight + 8 && params.triggerRect.top > spaceBelow;
  const top = placeAbove
    ? Math.max(margin, params.triggerRect.top - params.cardHeight - 8)
    : Math.min(params.viewportHeight - margin - params.cardHeight, params.triggerRect.bottom + 8);
  const left = Math.min(
    Math.max(margin, params.triggerRect.left + params.triggerRect.width / 2 - width / 2),
    params.viewportWidth - margin - width
  );

  return { top, left, width };
}

function InlineCitationCard(props: { citation: BookChatInlineCitationAnchorDTO }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-2xl shadow-black/15">
      <div className="text-[11px] text-muted-foreground">Цитаты-основания</div>
      <div className="mt-2 space-y-2.5">
        {props.citation.quotes.slice(0, 3).map((quote) => (
          <div key={quote.id} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5">
            <div className="text-[11px] text-muted-foreground">
              Глава {quote.chapterOrderIndex} · {resolveQuoteTypeLabel(quote.type)}
            </div>
            <div className="mt-1 text-sm leading-6 text-foreground">{quote.text}</div>
            {quote.commentary ? (
              <div className="mt-1.5 text-[12px] leading-5 text-muted-foreground">{quote.commentary}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function DesktopInlineCitationTrigger(props: {
  citation: BookChatInlineCitationAnchorDTO;
  children: ReactNode;
}) {
  const mounted = useMounted();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<DesktopTooltipPosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === "undefined") return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    if (typeof window === "undefined") {
      setOpen(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 90);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    if (!mounted || !open || typeof window === "undefined" || !triggerRef.current) return;

    const nextPosition = resolveDesktopTooltipPosition({
      triggerRect: triggerRef.current.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cardHeight: cardRef.current?.offsetHeight || 260,
    });

    setPosition((current) => {
      if (
        current &&
        current.top === nextPosition.top &&
        current.left === nextPosition.left &&
        current.width === nextPosition.width
      ) {
        return current;
      }
      return nextPosition;
    });
  }, [mounted, open]);

  useEffect(() => {
    clearCloseTimer();
    return () => clearCloseTimer();
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!mounted || !open) return;

    const handleLayout = () => updatePosition();
    updatePosition();
    window.addEventListener("resize", handleLayout);
    window.addEventListener("scroll", handleLayout, true);
    return () => {
      window.removeEventListener("resize", handleLayout);
      window.removeEventListener("scroll", handleLayout, true);
    };
  }, [mounted, open, updatePosition]);

  return (
    <>
      <span ref={triggerRef} className="inline-block align-baseline">
        <button
          type="button"
          className="cursor-help text-inherit underline decoration-dotted underline-offset-4 hover:text-primary"
          onMouseEnter={() => {
            clearCloseTimer();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          onFocus={() => {
            clearCloseTimer();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          aria-expanded={open}
        >
          {props.children}
        </button>
      </span>
      {mounted && open && position
        ? createPortal(
            <div
              ref={cardRef}
              className="fixed z-50 text-left"
              style={{ top: position.top, left: position.left, width: position.width }}
              onMouseEnter={clearCloseTimer}
              onMouseLeave={scheduleClose}
            >
              <InlineCitationCard citation={props.citation} />
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function MobileInlineCitationTrigger(props: {
  citation: BookChatInlineCitationAnchorDTO;
  children: ReactNode;
}) {
  const mounted = useMounted();
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className="inline">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="text-inherit underline decoration-dotted underline-offset-4"
          aria-expanded={open}
        >
          {props.children}
        </button>
      </span>
      {mounted && open
        ? createPortal(
            <span className="fixed inset-0 z-50">
              <button
                type="button"
                aria-label="Закрыть цитаты"
                className="absolute inset-0 bg-black/25"
                onClick={() => setOpen(false)}
              />
              <span className="absolute inset-x-4 bottom-4 block max-h-[70vh] overflow-y-auto">
                <InlineCitationCard citation={props.citation} />
              </span>
            </span>,
            document.body
          )
        : null}
    </>
  );
}

function InlineCitationTrigger(props: {
  anchorId: string;
  inlineCitations: BookChatInlineCitationAnchorDTO[];
  children: ReactNode;
}) {
  const citation = props.inlineCitations.find((item) => item.anchorId === props.anchorId) || null;
  const supportsHover = useSupportsHover();

  if (!citation) return <>{props.children}</>;

  if (supportsHover) {
    return <DesktopInlineCitationTrigger citation={citation}>{props.children}</DesktopInlineCitationTrigger>;
  }

  return <MobileInlineCitationTrigger citation={citation}>{props.children}</MobileInlineCitationTrigger>;
}

export function ChatMessageMarkdown({
  content,
  className,
  inlineCitations = [],
  onRefCite,
}: ChatMessageMarkdownProps) {
  const value = injectRefCiteLinks(repairLegacyChatFormatting(content));
  if (!value) return null;

  const components: Components = {
    a: ({ href, children, node: _node, ...props }) => {
      if (typeof href === "string" && href.startsWith("cite:")) {
        return (
          <InlineCitationTrigger anchorId={href.slice("cite:".length)} inlineCitations={inlineCitations}>
            {children}
          </InlineCitationTrigger>
        );
      }

      if (typeof href === "string" && href.startsWith("ref:")) {
        const ref = parseRefCite(href);
        if (!ref) {
          return (
            <span className="chat-ref-badge chat-ref-badge--inert">
              {children}
            </span>
          );
        }
        const rangesLabel = ref.paragraphRanges
          .map((r) => (r.end ? `${r.start}–${r.end}` : `${r.start}`))
          .join(", ");
        return (
          <button
            type="button"
            className="chat-ref-badge"
            onClick={() => onRefCite?.(ref)}
            title={`Открыть главу ${ref.chapterOrderIndex}, параграф ${rangesLabel}`}
          >
            {children}
          </button>
        );
      }

      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    },
  };

  const urlTransform = (url: string) => {
    if (url.startsWith("cite:") || url.startsWith("ref:")) return url;
    return defaultUrlTransform(url);
  };

  return (
    <div
      className={[
        "leading-relaxed break-words",
        "[&_p]:mb-3 [&_p:last-child]:mb-0",
        "[&_ul]:mb-3 [&_ul:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:mb-3 [&_ol:last-child]:mb-0 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:mb-1 [&_li:last-child]:mb-0",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.92em]",
        "[&_button]:font-inherit",
        className || "",
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
