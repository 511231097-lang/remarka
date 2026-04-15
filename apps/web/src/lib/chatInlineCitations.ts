import type { BookChatInlineCitationAnchorDTO, BookQuoteListItemDTO } from "@/lib/books";

export interface InlineAnnotationCandidate {
  anchorId: string;
  quoteIds: string[];
}

function normalizeModelAnswerWhitespace(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractInlineCiteReferences(markdown: string): Array<{ anchorId: string; text: string }> {
  const pattern = /\[([^\]]+)\]\(cite:([A-Za-z0-9_-]{1,40})\)/g;
  const out: Array<{ anchorId: string; text: string }> = [];
  for (const match of markdown.matchAll(pattern)) {
    const text = normalizeModelAnswerWhitespace(String(match[1] || ""));
    const anchorId = String(match[2] || "").trim();
    if (!text || !anchorId) continue;
    out.push({ anchorId, text });
  }
  return out;
}

function stripInlineCiteMarkdown(markdown: string): string {
  return String(markdown || "").replace(/\[([^\]]+)\]\(cite:[A-Za-z0-9_-]{1,40}\)/g, "$1");
}

export function validateInlineCitationAnnotation(params: {
  rawAnswer: string;
  annotatedAnswerMarkdown: string;
  anchors: InlineAnnotationCandidate[];
  quoteCards: BookQuoteListItemDTO[];
}): { annotatedAnswerMarkdown: string; inlineCitations: BookChatInlineCitationAnchorDTO[] } | null {
  const rawAnswer = normalizeModelAnswerWhitespace(params.rawAnswer);
  const annotatedAnswerMarkdown = normalizeModelAnswerWhitespace(params.annotatedAnswerMarkdown);
  if (!rawAnswer || !annotatedAnswerMarkdown) return null;

  const plainAnnotated = normalizeModelAnswerWhitespace(stripInlineCiteMarkdown(annotatedAnswerMarkdown));
  if (plainAnnotated !== rawAnswer) return null;

  const refs = extractInlineCiteReferences(annotatedAnswerMarkdown);
  if (refs.length === 0) return null;
  if (refs.some((ref) => ref.text.length < 2 || ref.text.length > 96)) return null;

  const quoteById = new Map(params.quoteCards.map((quote) => [quote.id, quote] as const));
  const anchorMap = new Map<string, BookChatInlineCitationAnchorDTO>();

  for (const anchor of params.anchors) {
    const anchorId = String(anchor.anchorId || "").trim();
    if (!anchorId || anchorMap.has(anchorId)) return null;

    const quoteIds = Array.from(new Set((anchor.quoteIds || []).map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 3);
    if (quoteIds.length === 0) return null;

    const quotes: BookQuoteListItemDTO[] = [];
    for (const quoteId of quoteIds) {
      const quote = quoteById.get(quoteId);
      if (!quote) return null;
      quotes.push(quote);
    }

    anchorMap.set(anchorId, {
      anchorId,
      quotes,
    });
  }

  if (anchorMap.size === 0) return null;

  const usedAnchorIds = Array.from(new Set(refs.map((item) => item.anchorId)));
  if (usedAnchorIds.some((anchorId) => !anchorMap.has(anchorId))) return null;

  const inlineCitations = usedAnchorIds
    .map((anchorId) => anchorMap.get(anchorId))
    .filter((item): item is BookChatInlineCitationAnchorDTO => Boolean(item));

  if (inlineCitations.length !== usedAnchorIds.length) return null;

  return {
    annotatedAnswerMarkdown,
    inlineCitations,
  };
}
