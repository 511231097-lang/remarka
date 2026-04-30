"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { BookPreviewStage } from "./BookGalleryCard";
import { getBookChapterContent } from "@/lib/booksClient";
import type { BookChapterContentDTO, BookCoreDTO } from "@/lib/books";

export interface ReaderParagraphRange {
  start: number;
  end?: number;
}

export interface ReaderCite {
  /** Snippet text from the book to highlight inside the chapter. Optional — use either snippet or paragraphRanges. */
  snippet?: string;
  /** Chapter order index where the snippet lives. Required to fetch text. */
  chapterOrderIndex: number;
  /**
   * Optional paragraph ranges to highlight (model's `[chN:pM-pK, pA-pB]` refs).
   * Multiple ranges are shown all-highlighted; the user can navigate between
   * them via fragment-jump buttons in the modal foot.
   */
  paragraphRanges?: ReaderParagraphRange[];
  /** Optional human label like "Глава 5" or evidence kind. */
  label?: string | null;
}

interface BookReaderProps {
  open: boolean;
  book: BookCoreDTO | null;
  cite: ReaderCite | null;
  onClose: () => void;
}

const PARAGRAPH_SPLIT = /\n\s*\n+/;

/**
 * Tokenize a paragraph and find the snippet inside (substring match, case-insensitive
 * on whitespace-normalized comparison). If found, return the slices; otherwise null.
 */
function locateSnippet(paragraph: string, snippet: string):
  | { before: string; match: string; after: string }
  | null
{
  const trimmedSnippet = snippet.trim();
  if (!trimmedSnippet) return null;

  const direct = paragraph.indexOf(trimmedSnippet);
  if (direct >= 0) {
    return {
      before: paragraph.slice(0, direct),
      match: paragraph.slice(direct, direct + trimmedSnippet.length),
      after: paragraph.slice(direct + trimmedSnippet.length),
    };
  }

  // Try a normalized comparison (collapse whitespace) — index-mapping is approximate
  const normalize = (s: string) => s.replace(/\s+/g, " ");
  const normalizedParagraph = normalize(paragraph);
  const normalizedSnippet = normalize(trimmedSnippet);
  const idx = normalizedParagraph.indexOf(normalizedSnippet);
  if (idx < 0) return null;

  // Walk both strings, mapping normalized index back to paragraph index
  let originalIdx = 0;
  let normalizedIdx = 0;
  while (normalizedIdx < idx && originalIdx < paragraph.length) {
    const ch = paragraph[originalIdx];
    if (/\s/.test(ch)) {
      // Skip extra whitespace beyond the first
      while (originalIdx + 1 < paragraph.length && /\s/.test(paragraph[originalIdx + 1])) {
        originalIdx++;
      }
      normalizedIdx++; // counts as single space
    } else {
      normalizedIdx++;
    }
    originalIdx++;
  }

  // Now find the end by walking until we've seen normalizedSnippet.length normalized chars
  let endIdx = originalIdx;
  let consumed = 0;
  while (consumed < normalizedSnippet.length && endIdx < paragraph.length) {
    const ch = paragraph[endIdx];
    if (/\s/.test(ch)) {
      while (endIdx + 1 < paragraph.length && /\s/.test(paragraph[endIdx + 1])) {
        endIdx++;
      }
      consumed++;
    } else {
      consumed++;
    }
    endIdx++;
  }

  return {
    before: paragraph.slice(0, originalIdx),
    match: paragraph.slice(originalIdx, endIdx),
    after: paragraph.slice(endIdx),
  };
}

/** Returns the index of the range that contains paragraphIndex, or -1. */
function findRangeIndex(ranges: readonly ReaderParagraphRange[], paragraphIndex: number): number {
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    if (paragraphIndex >= r.start && paragraphIndex <= (r.end ?? r.start)) return i;
  }
  return -1;
}

interface ParagraphRenderProps {
  paragraph: string;
  paragraphIndex: number | null;
  snippet: string | null;
  paragraphRanges: readonly ReaderParagraphRange[] | null;
  /** Index of the currently focused fragment — its first paragraph gets the scroll ref. */
  activeFragmentIndex: number;
  fragmentRefs: React.MutableRefObject<Array<HTMLSpanElement | null>>;
  /** Per-render flag for snippet path so only the first match gets highlighted. */
  alreadyHighlighted: React.MutableRefObject<boolean>;
  /** Per-render set of fragment indices that have already had their first paragraph attached. */
  attachedFragments: React.MutableRefObject<Set<number>>;
}

function ReaderParagraph({
  paragraph,
  paragraphIndex,
  snippet,
  paragraphRanges,
  activeFragmentIndex,
  fragmentRefs,
  alreadyHighlighted,
  attachedFragments,
}: ParagraphRenderProps) {
  // Range-based highlight: highlight every paragraph that falls into ANY range,
  // and attach the per-fragment scroll ref to the first paragraph of each range.
  if (paragraphRanges && paragraphRanges.length > 0 && paragraphIndex != null) {
    const fragmentIndex = findRangeIndex(paragraphRanges, paragraphIndex);
    if (fragmentIndex >= 0) {
      const isFirstInFragment = !attachedFragments.current.has(fragmentIndex);
      if (isFirstInFragment) attachedFragments.current.add(fragmentIndex);
      const isActive = fragmentIndex === activeFragmentIndex;
      return (
        <p className="reader-para">
          <span
            ref={
              isFirstInFragment
                ? (el) => {
                    fragmentRefs.current[fragmentIndex] = el;
                  }
                : undefined
            }
            className={`reader-mark ${isActive ? "reader-mark--active" : ""}`}
          >
            {paragraph}
          </span>
        </p>
      );
    }
  }

  // Snippet-based highlight: substring match within a paragraph (single)
  if (snippet && !alreadyHighlighted.current) {
    const located = locateSnippet(paragraph, snippet);
    if (located) {
      alreadyHighlighted.current = true;
      return (
        <p className="reader-para">
          {located.before}
          <span
            ref={(el) => {
              fragmentRefs.current[0] = el;
            }}
            className="reader-mark"
          >
            {located.match}
          </span>
          {located.after}
        </p>
      );
    }
  }

  return <p className="reader-para">{paragraph}</p>;
}

export function BookReader({ open, book, cite, onClose }: BookReaderProps) {
  const [chapter, setChapter] = useState<BookChapterContentDTO | null>(null);
  const [orderIndex, setOrderIndex] = useState<number | null>(null);
  const [activeFragmentIndex, setActiveFragmentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fragmentRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Reset orderIndex + activeFragmentIndex when cite changes
  useEffect(() => {
    if (open && cite) {
      setOrderIndex(cite.chapterOrderIndex);
      setActiveFragmentIndex(0);
    }
  }, [open, cite]);

  // Fetch chapter content when orderIndex changes
  useEffect(() => {
    if (!open || !book || orderIndex == null) return;
    let active = true;
    setLoading(true);
    setError(null);
    getBookChapterContent(book.id, orderIndex)
      .then((data) => {
        if (!active) return;
        setChapter(data);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить главу");
        setChapter(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, book, orderIndex]);

  // Scroll to active fragment after content renders.
  useEffect(() => {
    if (!open || !chapter) return;
    const t = setTimeout(() => {
      const sc = scrollRef.current;
      const el = fragmentRefs.current[activeFragmentIndex];
      if (sc && el) {
        const y = el.offsetTop - sc.clientHeight / 2 + el.clientHeight / 2;
        sc.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
      } else if (sc) {
        sc.scrollTo({ top: 0 });
      }
    }, 80);
    return () => clearTimeout(t);
  }, [
    open,
    chapter,
    activeFragmentIndex,
    cite?.snippet,
    cite?.paragraphRanges,
  ]);

  // Keyboard nav: Esc / arrows. Arrows navigate chapters; Alt+arrows navigate
  // fragments within the chapter when there are multiple highlight ranges.
  const goPrevChapter = useCallback(() => {
    setOrderIndex((current) => (current == null || current <= 1 ? current : current - 1));
  }, []);
  // Upper bound for chapter navigation: prefer the freshly-fetched
  // `chapter.totalChapters` (authoritative), but fall back to the book's
  // `chapterCount` while the chapter is still loading or after a fetch
  // error. Without this fallback, ArrowRight could increment unbounded
  // and trigger repeated 404/400 fetches before the first chapter lands.
  const maxChapter = chapter?.totalChapters ?? book?.chapterCount ?? null;
  const goNextChapter = useCallback(() => {
    setOrderIndex((current) => {
      if (current == null) return current;
      if (maxChapter != null && current >= maxChapter) return current;
      return current + 1;
    });
  }, [maxChapter]);

  const ranges = cite?.paragraphRanges ?? null;
  const fragmentCount = ranges?.length ?? 0;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Alt+←/→ → fragment navigation if multiple ranges available
      if (e.altKey && fragmentCount > 1) {
        if (e.key === "ArrowRight") {
          setActiveFragmentIndex((i) => Math.min(fragmentCount - 1, i + 1));
        } else if (e.key === "ArrowLeft") {
          setActiveFragmentIndex((i) => Math.max(0, i - 1));
        }
        return;
      }
      if (e.key === "ArrowRight") goNextChapter();
      else if (e.key === "ArrowLeft") goPrevChapter();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, goNextChapter, goPrevChapter, fragmentCount]);

  // Prefer BookParagraph[] if available — preserves stable paragraphIndex for [chN:pM] refs.
  // Fallback: split rawText by blank lines.
  const paragraphs = useMemo<{ paragraphIndex: number | null; text: string }[]>(() => {
    if (!chapter) return [];
    if (chapter.paragraphs && chapter.paragraphs.length > 0) {
      return chapter.paragraphs.map((p) => ({ paragraphIndex: p.paragraphIndex, text: p.text }));
    }
    return String(chapter.rawText || "")
      .split(PARAGRAPH_SPLIT)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text) => ({ paragraphIndex: null, text }));
  }, [chapter]);

  if (!open || !book || !mounted) return null;

  const isHighlightChapter = chapter && cite && chapter.orderIndex === cite.chapterOrderIndex;
  const snippetForChapter = isHighlightChapter ? cite.snippet || null : null;
  const rangesForChapter = isHighlightChapter && ranges && ranges.length > 0 ? ranges : null;

  // Per-render flag — only the first matching paragraph (snippet path) gets highlighted.
  const alreadyHighlighted = { current: false };
  // Per-render set — track which fragment indices already had their scroll ref attached.
  const attachedFragments = { current: new Set<number>() };
  // Reset the fragment refs on each render so stale refs don't linger across chapters.
  fragmentRefs.current = [];

  const totalChapters = maxChapter;
  const canPrevChapter = orderIndex != null && orderIndex > 1;
  const canNextChapter = orderIndex != null && totalChapters != null && orderIndex < totalChapters;
  const showFragmentNav = (rangesForChapter?.length ?? 0) > 1;

  const formatRangeLabel = (r: ReaderParagraphRange) =>
    r.end ? `${r.start}–${r.end}` : `${r.start}`;

  return createPortal(
    <div className="reader-root" role="dialog" aria-modal="true" aria-label={`Чтение: ${book.title}`}>
      <div className="reader-backdrop" onClick={onClose} />
      <div className="reader-window">
        <div className="reader-head">
          <div className="row-sm" style={{ minWidth: 0 }}>
            <div style={{ flexShrink: 0, width: 28 }}><BookPreviewStage book={book} size="sm" /></div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: 14,
                  lineHeight: 1.2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {book.title}
              </div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>
                {chapter ? `Глава ${chapter.orderIndex} · ${chapter.title}` : `Глава ${orderIndex ?? ""}`}
              </div>
            </div>
          </div>
          <div className="row-sm">
            <div className="mono" style={{ color: "var(--ink-muted)", marginRight: 6 }}>
              {snippetForChapter || rangesForChapter ? "Ремарка нашла цитату" : "Чтение"}
            </div>
            <button type="button" className="reader-close" onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="reader-scroll">
          <div className="reader-page">
            <div className="reader-pageno">
              — {chapter ? `Глава ${chapter.orderIndex}` : "загрузка"} —
            </div>

            {loading && !chapter ? (
              <p className="reader-para muted" style={{ textIndent: 0, color: "var(--ink-muted)" }}>
                Загружаем текст главы…
              </p>
            ) : null}

            {error ? (
              <p className="reader-para" style={{ textIndent: 0, color: "var(--mark)" }}>
                {error}
              </p>
            ) : null}

            {!loading && !error && paragraphs.length === 0 && chapter ? (
              <p className="reader-para muted" style={{ textIndent: 0, color: "var(--ink-muted)" }}>
                Текст главы недоступен.
              </p>
            ) : null}

            {paragraphs.map((p, idx) => (
              <ReaderParagraph
                key={idx}
                paragraph={p.text}
                paragraphIndex={p.paragraphIndex}
                snippet={snippetForChapter}
                paragraphRanges={rangesForChapter}
                activeFragmentIndex={activeFragmentIndex}
                fragmentRefs={fragmentRefs}
                alreadyHighlighted={alreadyHighlighted}
                attachedFragments={attachedFragments}
              />
            ))}

            {chapter ? (
              <div className="reader-pageno" style={{ marginTop: 36 }}>· · ·</div>
            ) : null}
          </div>
        </div>

        <div className="reader-foot">
          <button
            type="button"
            className="btn btn-plain btn-sm"
            onClick={goPrevChapter}
            disabled={!canPrevChapter}
            style={{ opacity: canPrevChapter ? 1 : 0.5 }}
          >
            <ChevronLeft size={14} />
            {orderIndex != null && orderIndex > 1 ? `Глава ${orderIndex - 1}` : "—"}
          </button>

          {showFragmentNav && rangesForChapter ? (
            <div className="reader-fragment-nav">
              <span className="mono" style={{ color: "var(--ink-muted)" }}>Фрагменты:</span>
              {rangesForChapter.map((r, i) => (
                <button
                  key={`${r.start}-${r.end ?? r.start}-${i}`}
                  type="button"
                  className={`reader-fragment-chip ${i === activeFragmentIndex ? "is-active" : ""}`}
                  onClick={() => setActiveFragmentIndex(i)}
                  title={`Параграф ${formatRangeLabel(r)}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          ) : (
            <div className="mono" style={{ color: "var(--ink-muted)" }}>
              {snippetForChapter || rangesForChapter
                ? "Найденный фрагмент подсвечен"
                : "Свободное чтение"}
            </div>
          )}

          <button
            type="button"
            className="btn btn-plain btn-sm"
            onClick={goNextChapter}
            disabled={!canNextChapter}
            style={{ opacity: canNextChapter ? 1 : 0.5 }}
          >
            {orderIndex != null && totalChapters != null && orderIndex < totalChapters
              ? `Глава ${orderIndex + 1}`
              : "—"}
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
