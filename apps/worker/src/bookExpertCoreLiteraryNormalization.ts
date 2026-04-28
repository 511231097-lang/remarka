import {
  BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS,
  BookExpertCoreLiterarySectionSchema,
  type BookExpertCoreLiterarySection,
  type BookExpertCoreLiterarySectionKey,
} from "@remarka/contracts";

function compactWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(value: string, maxChars: number): string {
  const text = compactWhitespace(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function clampMarkdown(value: string, maxChars: number): string {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function dedupeStrings(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = compactWhitespace(item);
    if (!normalized || seen.has(normalized)) continue;
    out.push(normalized);
    seen.add(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function clampConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(0, Math.min(1, fallback));
  return Math.max(0, Math.min(1, parsed));
}

export function normalizeLiterarySection(
  current: BookExpertCoreLiterarySection,
  patch: Partial<BookExpertCoreLiterarySection>
): BookExpertCoreLiterarySection {
  const summary = clampText(patch.summary || current.summary, 500) || clampText(current.summary, 500);
  const bullets = dedupeStrings(
    (patch.bullets || current.bullets || []).map((item) => clampText(item, 240)).filter(Boolean),
    8
  );
  const bodyMarkdown =
    clampMarkdown(patch.bodyMarkdown || current.bodyMarkdown, 6000) ||
    clampMarkdown(
      [
        summary,
        bullets.length > 0 ? bullets.map((item) => `- ${clampText(item, 220)}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      6000
    ) ||
    summary;

  return BookExpertCoreLiterarySectionSchema.parse({
    ...current,
    key: current.key,
    title: clampText(patch.title || current.title, 160) || current.title,
    summary,
    bodyMarkdown,
    bullets,
    evidenceQuoteIds: dedupeStrings(
      (patch.evidenceQuoteIds || current.evidenceQuoteIds || []).map((item) => clampText(item, 80)).filter(Boolean),
      10
    ),
    confidence: clampConfidence(patch.confidence, current.confidence),
  });
}

export function normalizeLiterarySectionsRecord(
  sections: Record<BookExpertCoreLiterarySectionKey, BookExpertCoreLiterarySection>
): Record<BookExpertCoreLiterarySectionKey, BookExpertCoreLiterarySection> {
  const normalized = {} as Record<BookExpertCoreLiterarySectionKey, BookExpertCoreLiterarySection>;

  for (const key of BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS) {
    normalized[key] = normalizeLiterarySection(sections[key], {});
  }

  return normalized;
}
