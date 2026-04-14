import path from "node:path";
import { LocalBlobStore, S3BlobStore, type BlobStore, prisma } from "@remarka/db";
import {
  buildPlainTextFromParsedChapter,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  normalizeEntityName,
  parseBook,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import {
  runBookChapterQuotes,
  type BookQuoteMentionKind,
  type BookQuoteTag,
  type BookQuoteType,
} from "../extractionV2";
import { logger } from "../logger";
import { getArtifactBlobStore } from "../artifactStore";

interface ProcessBookQuotesPayload {
  bookId: string;
}

interface QuoteMentionCandidate {
  kind: BookQuoteMentionKind;
  value: string;
  normalizedValue: string;
  startChar: number;
  endChar: number;
  confidence: number;
}

interface QuoteCandidate {
  chapterOrderIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  type: BookQuoteType;
  tags: BookQuoteTag[];
  confidence: number;
  commentary: string | null;
  mentions: QuoteMentionCandidate[];
}

const MAX_QUOTES_PER_CHAPTER = 40;
const MAX_TAGS_PER_QUOTE = 8;
const MAX_MENTIONS_PER_QUOTE = 16;
const MAX_QUOTE_TEXT_CHARS = 1200;
const MAX_COMMENTARY_CHARS = 420;
const OVERLAP_THRESHOLD = 0.35;
const DROP_SAMPLE_LIMIT_PER_REASON = 3;

const QUOTE_DROP_REASONS = [
  "empty_text",
  "sentence_count_out_of_range",
  "offset_not_resolved",
  "invalid_span",
  "dedup",
  "overlap",
  "chapter_limit",
] as const;
type QuoteDropReason = (typeof QUOTE_DROP_REASONS)[number];

interface MentionNormalizationAnalytics {
  inputMentions: number;
  persistedMentions: number;
  droppedMissingValue: number;
  droppedDuplicate: number;
  droppedByLimit: number;
}

interface ChapterTagAnalytics {
  inputUnique: number;
  persistedTags: number;
  droppedByLimit: number;
}

type QuoteOffsetResolutionMode =
  | "hint_match"
  | "exact_case"
  | "exact_lower"
  | "normalized_strict"
  | "normalized_loose";

interface OffsetResolutionAnalytics {
  hint_match: number;
  exact_case: number;
  exact_lower: number;
  normalized_strict: number;
  normalized_loose: number;
  unresolved: number;
}

interface SentenceOverflowAnalytics {
  overLimitQuotes: number;
  recoveredQuotes: number;
  unrecoveredQuotes: number;
  windowsTried: number;
}

interface ChapterQuoteAnalytics {
  chapterOrderIndex: number;
  chapterTitle: string;
  chapterTextLength: number;
  skippedEmptyChapterText: boolean;
  debugArtifactStorageKey: string | null;
  extractedQuotes: number;
  validatedQuotes: number;
  dedupCandidates: number;
  persistedQuotes: number;
  dropped: Record<QuoteDropReason, number>;
  offsetResolution: OffsetResolutionAnalytics;
  sentenceOverflow: SentenceOverflowAnalytics;
  mentions: MentionNormalizationAnalytics;
  tags: ChapterTagAnalytics;
}

interface QuoteDropSample {
  chapterOrderIndex: number;
  reason: QuoteDropReason;
  textSnippet: string;
  sentenceCount: number | null;
  hintedStart: number | null;
  hintedEnd: number | null;
}

interface RunQuotesAnalytics {
  chaptersTotal: number;
  chaptersProcessed: number;
  chaptersSkippedEmpty: number;
  debugArtifactsPersisted: number;
  debugArtifactsFailed: number;
  extractedQuotes: number;
  validatedQuotes: number;
  dedupCandidates: number;
  persistedQuotes: number;
  dropped: Record<QuoteDropReason, number>;
  offsetResolution: OffsetResolutionAnalytics;
  sentenceOverflow: SentenceOverflowAnalytics;
  mentions: MentionNormalizationAnalytics;
  tags: ChapterTagAnalytics;
  chapterStats: ChapterQuoteAnalytics[];
  dropSamples: Record<QuoteDropReason, QuoteDropSample[]>;
}

interface QuotesChapterDebugArtifact {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  provider: string;
}

function resolveUploadFormat(fileName: string): BookFormat | null {
  const detected = detectBookFormatFromFileName(fileName);
  if (detected) return detected;
  if (String(fileName || "").toLowerCase().endsWith(".zip")) return "fb2_zip";
  return null;
}

function resolveChapterTitle(chapter: ParsedChapter, orderIndex: number): string {
  const title = String(chapter.title || "").trim();
  return title || `Глава ${orderIndex}`;
}

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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book quotes processing failed";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/["'`’.,!?;:()[\]{}\-–—«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countSentences(text: string): number {
  const normalized = compactWhitespace(text);
  if (!normalized) return 0;
  const matches = normalized.match(/[.!?…]+/g);
  if (!matches || matches.length === 0) return 1;
  return matches.length;
}

interface SentenceChunk {
  startChar: number;
  endChar: number;
}

function splitSentenceChunks(text: string): SentenceChunk[] {
  const value = String(text || "");
  const chunks: SentenceChunk[] = [];
  const length = value.length;
  let cursor = 0;

  const skipWhitespace = (index: number): number => {
    let next = index;
    while (next < length && /\s/u.test(value[next])) next += 1;
    return next;
  };

  while (cursor < length) {
    cursor = skipWhitespace(cursor);
    if (cursor >= length) break;

    const sentenceStart = cursor;
    while (cursor < length && !/[.!?…]/u.test(value[cursor])) {
      cursor += 1;
    }

    if (cursor < length && /[.!?…]/u.test(value[cursor])) {
      while (cursor < length && /[.!?…]/u.test(value[cursor])) {
        cursor += 1;
      }
      while (cursor < length && /["'»”’)\]]/u.test(value[cursor])) {
        cursor += 1;
      }
    }

    let sentenceEnd = cursor;
    while (sentenceEnd > sentenceStart && /\s/u.test(value[sentenceEnd - 1])) {
      sentenceEnd -= 1;
    }

    if (sentenceEnd > sentenceStart) {
      chunks.push({ startChar: sentenceStart, endChar: sentenceEnd });
    }
  }

  return chunks;
}

function stripWrappingQuotes(text: string): string {
  return String(text || "")
    .replace(/^["'«»„“”]+/, "")
    .replace(/["'«»„“”]+$/, "")
    .trim();
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (!haystack || !needle) return positions;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    positions.push(index);
    cursor = index + 1;
  }
  return positions;
}

function normalizeOffsetSearchChar(char: string, stripPunctuation: boolean): string {
  if (/\s/u.test(char)) return " ";

  if (char === "…" || char === "⋯") {
    return stripPunctuation ? "" : "...";
  }

  if (/[‐‑‒–—―−]/u.test(char)) {
    return stripPunctuation ? "" : "-";
  }

  if (/["'`‘’‚‛“”„‟«»]/u.test(char)) {
    return stripPunctuation ? "" : "\"";
  }

  const lowered = char.toLowerCase();
  const normalized = lowered.normalize("NFKD").replace(/\p{M}+/gu, "");

  if (normalized === "ё") return "е";
  if (stripPunctuation && /[.,!?;:()[\]{}]/u.test(normalized)) return "";

  return normalized;
}

function normalizeOffsetSearchNeedle(value: string, stripPunctuation: boolean): string {
  const text = String(value || "");
  let out = "";
  let pendingSpace = false;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charLength = char.length;
    const normalized = normalizeOffsetSearchChar(char, stripPunctuation);

    for (const normalizedChar of normalized) {
      if (/\s/u.test(normalizedChar)) {
        pendingSpace = true;
        continue;
      }

      if (pendingSpace && out.length > 0) {
        out += " ";
      }
      pendingSpace = false;
      out += normalizedChar;
    }

    index += charLength;
  }

  return out.trim();
}

function normalizeOffsetSearchSource(value: string, stripPunctuation: boolean): { text: string; indexMap: number[] } {
  const source = String(value || "");
  let text = "";
  const indexMap: number[] = [];
  let pendingSpace = false;
  let pendingSpaceSourceIndex = 0;

  for (let index = 0; index < source.length; ) {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charLength = char.length;
    const normalized = normalizeOffsetSearchChar(char, stripPunctuation);

    for (const normalizedChar of normalized) {
      if (/\s/u.test(normalizedChar)) {
        if (!pendingSpace) {
          pendingSpace = true;
          pendingSpaceSourceIndex = index;
        }
        continue;
      }

      if (pendingSpace && text.length > 0) {
        text += " ";
        indexMap.push(pendingSpaceSourceIndex);
      }
      pendingSpace = false;
      text += normalizedChar;
      indexMap.push(index);
    }

    index += charLength;
  }

  if (text.length !== indexMap.length) {
    return { text: "", indexMap: [] };
  }

  return { text, indexMap };
}

function originalCharLengthAt(value: string, offset: number): number {
  const codePoint = value.codePointAt(offset);
  if (codePoint === undefined) return 1;
  return codePoint > 0xffff ? 2 : 1;
}

function findOffsetsByNormalizedSearch(params: {
  chapterText: string;
  candidates: string[];
  hintedStart: number;
}): Array<{ startChar: number; endChar: number; score: number; mode: "normalized_strict" | "normalized_loose" }> {
  const chapterText = String(params.chapterText || "");
  if (!chapterText) return [];

  const strictSource = normalizeOffsetSearchSource(chapterText, false);
  const looseSource = normalizeOffsetSearchSource(chapterText, true);
  const hintedStart = Number.isInteger(params.hintedStart) ? params.hintedStart : -1;

  if (!strictSource.text && !looseSource.text) return [];

  const out: Array<{ startChar: number; endChar: number; score: number; mode: "normalized_strict" | "normalized_loose" }> = [];
  const seen = new Set<string>();

  const pushMatch = (
    startChar: number,
    endChar: number,
    penalty: number,
    mode: "normalized_strict" | "normalized_loose"
  ) => {
    if (!Number.isFinite(startChar) || !Number.isFinite(endChar) || endChar <= startChar) return;
    const key = `${startChar}:${endChar}`;
    if (seen.has(key)) return;
    seen.add(key);
    const baseScore = hintedStart >= 0 ? Math.abs(startChar - hintedStart) : startChar;
    out.push({ startChar, endChar, score: baseScore + penalty, mode });
  };

  const collectMatches = (
    source: { text: string; indexMap: number[] },
    needle: string,
    penalty: number,
    mode: "normalized_strict" | "normalized_loose"
  ) => {
    if (!source.text || !needle) return;
    const hits = findAllOccurrences(source.text, needle);
    for (const hit of hits) {
      const normalizedEnd = hit + needle.length - 1;
      if (hit < 0 || normalizedEnd < hit) continue;
      if (hit >= source.indexMap.length || normalizedEnd >= source.indexMap.length) continue;

      const startOriginal = source.indexMap[hit];
      const endOriginalIndex = source.indexMap[normalizedEnd];
      const endOriginal = endOriginalIndex + originalCharLengthAt(chapterText, endOriginalIndex);
      pushMatch(startOriginal, endOriginal, penalty, mode);
    }
  };

  for (const candidate of params.candidates) {
    const strictNeedle = normalizeOffsetSearchNeedle(candidate, false);
    if (strictNeedle.length >= 6) {
      collectMatches(strictSource, strictNeedle, 50, "normalized_strict");
    }

    const looseNeedle = normalizeOffsetSearchNeedle(candidate, true);
    if (looseNeedle.length >= 10) {
      collectMatches(looseSource, looseNeedle, 150, "normalized_loose");
    }
  }

  return out;
}

function resolveQuoteOffsets(params: {
  chapterText: string;
  quoteText: string;
  hintedStart: number;
  hintedEnd: number;
}): { startChar: number; endChar: number; mode: QuoteOffsetResolutionMode } | null {
  const chapterText = String(params.chapterText || "");
  const quoteText = compactWhitespace(params.quoteText);
  if (!chapterText || !quoteText) return null;

  const chapterLength = chapterText.length;
  const hintedStart = Number.isInteger(params.hintedStart) ? params.hintedStart : -1;
  const hintedEnd = Number.isInteger(params.hintedEnd) ? params.hintedEnd : -1;

  if (hintedStart >= 0 && hintedEnd > hintedStart && hintedEnd <= chapterLength) {
    const segment = chapterText.slice(hintedStart, hintedEnd);
    if (normalizeSearchText(segment) === normalizeSearchText(quoteText)) {
      return { startChar: hintedStart, endChar: hintedEnd, mode: "hint_match" };
    }
  }

  const candidates = Array.from(
    new Set([
      quoteText,
      stripWrappingQuotes(quoteText),
      stripWrappingQuotes(quoteText).replace(/["'«»„“”]/g, ""),
    ])
  )
    .map((value) => value.trim())
    .filter((value) => value.length >= 6);

  const chapterLower = chapterText.toLowerCase();

  type Match = { startChar: number; endChar: number; score: number; mode: QuoteOffsetResolutionMode };
  const matchesBySpan = new Map<string, Match>();

  const pushMatch = (match: Match) => {
    if (
      !Number.isFinite(match.startChar) ||
      !Number.isFinite(match.endChar) ||
      match.endChar <= match.startChar
    ) {
      return;
    }

    const key = `${match.startChar}:${match.endChar}`;
    const existing = matchesBySpan.get(key);
    if (!existing) {
      matchesBySpan.set(key, match);
      return;
    }

    if (match.score < existing.score) {
      matchesBySpan.set(key, match);
      return;
    }

    if (
      match.score === existing.score &&
      OFFSET_MODE_PRIORITY[match.mode] < OFFSET_MODE_PRIORITY[existing.mode]
    ) {
      matchesBySpan.set(key, match);
    }
  };

  for (const candidate of candidates) {
    const exact = findAllOccurrences(chapterText, candidate);
    for (const start of exact) {
      const end = start + candidate.length;
      const score = hintedStart >= 0 ? Math.abs(start - hintedStart) : start;
      pushMatch({ startChar: start, endChar: end, score, mode: "exact_case" });
    }

    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate !== candidate) {
      const lowered = findAllOccurrences(chapterLower, lowerCandidate);
      for (const start of lowered) {
        const end = start + lowerCandidate.length;
        const score = hintedStart >= 0 ? Math.abs(start - hintedStart) : start;
        pushMatch({ startChar: start, endChar: end, score, mode: "exact_lower" });
      }
    }
  }

  const normalizedMatches = findOffsetsByNormalizedSearch({
    chapterText,
    candidates,
    hintedStart,
  });
  for (const match of normalizedMatches) {
    pushMatch(match);
  }

  const matches = Array.from(matchesBySpan.values());
  if (!matches.length) return null;

  matches.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    if (left.startChar !== right.startChar) return left.startChar - right.startChar;
    if (OFFSET_MODE_PRIORITY[left.mode] !== OFFSET_MODE_PRIORITY[right.mode]) {
      return OFFSET_MODE_PRIORITY[left.mode] - OFFSET_MODE_PRIORITY[right.mode];
    }
    return right.endChar - left.endChar;
  });

  return matches[0];
}

function overlapRatio(
  left: { startChar: number; endChar: number },
  right: { startChar: number; endChar: number }
): number {
  const overlap = Math.min(left.endChar, right.endChar) - Math.max(left.startChar, right.startChar);
  if (overlap <= 0) return 0;
  const leftLength = Math.max(1, left.endChar - left.startChar);
  const rightLength = Math.max(1, right.endChar - right.startChar);
  return overlap / Math.min(leftLength, rightLength);
}

function createDropCounters(): Record<QuoteDropReason, number> {
  return {
    empty_text: 0,
    sentence_count_out_of_range: 0,
    offset_not_resolved: 0,
    invalid_span: 0,
    dedup: 0,
    overlap: 0,
    chapter_limit: 0,
  };
}

function createMentionAnalytics(): MentionNormalizationAnalytics {
  return {
    inputMentions: 0,
    persistedMentions: 0,
    droppedMissingValue: 0,
    droppedDuplicate: 0,
    droppedByLimit: 0,
  };
}

function createTagAnalytics(): ChapterTagAnalytics {
  return {
    inputUnique: 0,
    persistedTags: 0,
    droppedByLimit: 0,
  };
}

function createOffsetResolutionAnalytics(): OffsetResolutionAnalytics {
  return {
    hint_match: 0,
    exact_case: 0,
    exact_lower: 0,
    normalized_strict: 0,
    normalized_loose: 0,
    unresolved: 0,
  };
}

function createSentenceOverflowAnalytics(): SentenceOverflowAnalytics {
  return {
    overLimitQuotes: 0,
    recoveredQuotes: 0,
    unrecoveredQuotes: 0,
    windowsTried: 0,
  };
}

function registerOffsetResolution(params: {
  chapterAnalytics: ChapterQuoteAnalytics;
  runAnalytics: RunQuotesAnalytics;
  mode: QuoteOffsetResolutionMode | null;
}) {
  const { chapterAnalytics, runAnalytics, mode } = params;
  if (!mode) {
    chapterAnalytics.offsetResolution.unresolved += 1;
    runAnalytics.offsetResolution.unresolved += 1;
    return;
  }

  chapterAnalytics.offsetResolution[mode] += 1;
  runAnalytics.offsetResolution[mode] += 1;
}

const OFFSET_MODE_PRIORITY: Record<QuoteOffsetResolutionMode, number> = {
  hint_match: 0,
  exact_case: 1,
  exact_lower: 2,
  normalized_strict: 3,
  normalized_loose: 4,
};

interface SentenceOverflowRecoveryResult {
  recovered: boolean;
  windowsTried: number;
  text: string | null;
  sentenceCount: number | null;
  resolvedOffsets: { startChar: number; endChar: number; mode: QuoteOffsetResolutionMode } | null;
  sourceStartChar: number | null;
  sourceEndChar: number | null;
}

function recoverSentenceOverflowQuote(params: {
  chapterText: string;
  quoteText: string;
  hintedStart: number;
  hintedEnd: number;
}): SentenceOverflowRecoveryResult {
  const quoteText = String(params.quoteText || "").trim();
  if (!quoteText) {
    return {
      recovered: false,
      windowsTried: 0,
      text: null,
      sentenceCount: null,
      resolvedOffsets: null,
      sourceStartChar: null,
      sourceEndChar: null,
    };
  }

  const chunks = splitSentenceChunks(quoteText);
  if (chunks.length <= 3) {
    return {
      recovered: false,
      windowsTried: 0,
      text: null,
      sentenceCount: null,
      resolvedOffsets: null,
      sourceStartChar: null,
      sourceEndChar: null,
    };
  }

  const candidates: Array<{
    text: string;
    sentenceCount: number;
    order: number;
    sourceStartChar: number;
    sourceEndChar: number;
  }> = [];
  const seen = new Set<string>();
  let order = 0;

  for (const windowSize of [3, 2, 1]) {
    if (chunks.length < windowSize) continue;
    for (let index = 0; index <= chunks.length - windowSize; index += 1) {
      const startChar = chunks[index].startChar;
      const endChar = chunks[index + windowSize - 1].endChar;
      const text = quoteText.slice(startChar, endChar).trim();
      if (!text || text.length < 6) continue;

      const dedupKey = normalizeSearchText(text);
      if (!dedupKey || seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      candidates.push({
        text,
        sentenceCount: windowSize,
        order: order++,
        sourceStartChar: startChar,
        sourceEndChar: endChar,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      recovered: false,
      windowsTried: 0,
      text: null,
      sentenceCount: null,
      resolvedOffsets: null,
      sourceStartChar: null,
      sourceEndChar: null,
    };
  }

  const hintedStart =
    Number.isInteger(params.hintedStart) && params.hintedStart >= 0 ? params.hintedStart : -1;
  let best: {
    text: string;
    sentenceCount: number;
    resolvedOffsets: { startChar: number; endChar: number; mode: QuoteOffsetResolutionMode };
    windowsTried: number;
    sourceStartChar: number;
    sourceEndChar: number;
    rank: number;
  } | null = null;

  for (const candidate of candidates) {
    const resolved = resolveQuoteOffsets({
      chapterText: params.chapterText,
      quoteText: candidate.text,
      hintedStart: params.hintedStart,
      hintedEnd: params.hintedEnd,
    });
    if (!resolved) continue;

    const distance = hintedStart >= 0 ? Math.abs(resolved.startChar - hintedStart) : resolved.startChar;
    const rank =
      distance +
      OFFSET_MODE_PRIORITY[resolved.mode] * 400 +
      (3 - candidate.sentenceCount) * 120 +
      candidate.order;

    if (!best || rank < best.rank) {
      best = {
        text: candidate.text,
        sentenceCount: candidate.sentenceCount,
        resolvedOffsets: resolved,
        windowsTried: candidates.length,
        sourceStartChar: candidate.sourceStartChar,
        sourceEndChar: candidate.sourceEndChar,
        rank,
      };
    }
  }

  if (!best) {
    return {
      recovered: false,
      windowsTried: candidates.length,
      text: null,
      sentenceCount: null,
      resolvedOffsets: null,
      sourceStartChar: null,
      sourceEndChar: null,
    };
  }

  return {
    recovered: true,
    windowsTried: best.windowsTried,
    text: best.text,
    sentenceCount: best.sentenceCount,
    resolvedOffsets: best.resolvedOffsets,
    sourceStartChar: best.sourceStartChar,
    sourceEndChar: best.sourceEndChar,
  };
}

function createDropSampleBuckets(): Record<QuoteDropReason, QuoteDropSample[]> {
  return {
    empty_text: [],
    sentence_count_out_of_range: [],
    offset_not_resolved: [],
    invalid_span: [],
    dedup: [],
    overlap: [],
    chapter_limit: [],
  };
}

function sumDropCounters(counters: Record<QuoteDropReason, number>): number {
  return QUOTE_DROP_REASONS.reduce((total, reason) => total + counters[reason], 0);
}

function clampSnippet(value: string, maxChars = 160): string {
  return clampText(value, maxChars);
}

function registerDrop(params: {
  chapterAnalytics: ChapterQuoteAnalytics;
  runAnalytics: RunQuotesAnalytics;
  reason: QuoteDropReason;
  sample: Omit<QuoteDropSample, "reason">;
}): void {
  const { chapterAnalytics, runAnalytics, reason, sample } = params;
  chapterAnalytics.dropped[reason] += 1;
  runAnalytics.dropped[reason] += 1;

  const bucket = runAnalytics.dropSamples[reason];
  if (bucket.length >= DROP_SAMPLE_LIMIT_PER_REASON) return;
  bucket.push({
    ...sample,
    reason,
  });
}

function resolveBooksBlobStore(storageProviderRaw: string): BlobStore {
  const storageProvider = String(storageProviderRaw || "").trim().toLowerCase();

  if (storageProvider === "s3") {
    const bucket = String(workerConfig.books.s3.bucket || "").trim();
    if (!bucket) {
      throw new Error("BOOKS_S3_BUCKET is required to read s3 book blobs");
    }

    return new S3BlobStore({
      bucket,
      region: workerConfig.books.s3.region,
      endpoint: workerConfig.books.s3.endpoint || undefined,
      keyPrefix: workerConfig.books.s3.keyPrefix,
      forcePathStyle: workerConfig.books.s3.forcePathStyle,
      credentials:
        workerConfig.books.s3.accessKeyId && workerConfig.books.s3.secretAccessKey
          ? {
              accessKeyId: workerConfig.books.s3.accessKeyId,
              secretAccessKey: workerConfig.books.s3.secretAccessKey,
              sessionToken: workerConfig.books.s3.sessionToken || undefined,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir: workerConfig.books.localDir,
    provider: "local",
  });
}

async function persistChapterQuotesDebugArtifact(params: {
  store: BlobStore;
  bookId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chapterTextLength: number;
  extractedQuotes: number;
  modelPayload: {
    meta: unknown;
    debug: unknown;
  };
}): Promise<QuotesChapterDebugArtifact> {
  const prefix = path.posix.join("books", params.bookId, "analyzers", "quotes");
  const fileName = `chapter-${String(params.chapterOrderIndex).padStart(4, "0")}-model-debug.json`;
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      {
        phase: "book_chapter_quotes",
        recordedAt: new Date().toISOString(),
        bookId: params.bookId,
        chapterOrderIndex: params.chapterOrderIndex,
        chapterTitle: params.chapterTitle,
        chapterTextLength: params.chapterTextLength,
        extractedQuotes: params.extractedQuotes,
        output: params.modelPayload,
      },
      null,
      2
    )
  );

  const persisted = await params.store.put({
    bytes,
    fileName,
    prefix,
  });

  return {
    storageKey: persisted.storageKey,
    sizeBytes: persisted.sizeBytes,
    sha256: persisted.sha256,
    provider: persisted.provider,
  };
}

function normalizeMentionCandidates(
  input: QuoteMentionCandidate[],
  quoteText: string
): { mentions: QuoteMentionCandidate[]; analytics: MentionNormalizationAnalytics } {
  const normalized: QuoteMentionCandidate[] = [];
  const seen = new Set<string>();
  const quoteLength = quoteText.length;
  const analytics = createMentionAnalytics();
  analytics.inputMentions = input.length;

  for (const mention of input) {
    const value = clampText(mention.value, 140);
    const normalizedValue = clampText(mention.normalizedValue || normalizeEntityName(value) || "", 140);
    if (!value || !normalizedValue) {
      analytics.droppedMissingValue += 1;
      continue;
    }

    let startChar = Math.max(0, Math.floor(mention.startChar));
    let endChar = Math.max(startChar + 1, Math.floor(mention.endChar));
    startChar = Math.min(startChar, Math.max(0, quoteLength - 1));
    endChar = Math.min(Math.max(startChar + 1, endChar), quoteLength);

    const key = `${mention.kind}:${normalizedValue}:${startChar}:${endChar}`;
    if (seen.has(key)) {
      analytics.droppedDuplicate += 1;
      continue;
    }
    seen.add(key);

    normalized.push({
      kind: mention.kind,
      value,
      normalizedValue,
      startChar,
      endChar,
      confidence: clamp01(mention.confidence),
    });

    if (normalized.length >= MAX_MENTIONS_PER_QUOTE) break;
  }

  analytics.persistedMentions = normalized.length;
  analytics.droppedByLimit = Math.max(
    0,
    analytics.inputMentions - analytics.persistedMentions - analytics.droppedMissingValue - analytics.droppedDuplicate
  );

  return {
    mentions: normalized,
    analytics,
  };
}

function remapMentionsToQuoteWindow(
  input: QuoteMentionCandidate[],
  sourceStartChar: number,
  sourceEndChar: number
): QuoteMentionCandidate[] {
  const out: QuoteMentionCandidate[] = [];
  const windowLength = Math.max(1, sourceEndChar - sourceStartChar);

  for (const mention of input) {
    const startRaw = Math.floor(Number(mention.startChar));
    const endRaw = Math.floor(Number(mention.endChar));
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;

    const startChar = Math.max(0, startRaw);
    const endChar = Math.max(startChar + 1, endRaw);
    const overlapStart = Math.max(startChar, sourceStartChar);
    const overlapEnd = Math.min(endChar, sourceEndChar);
    if (overlapEnd <= overlapStart) continue;

    out.push({
      ...mention,
      startChar: Math.max(0, overlapStart - sourceStartChar),
      endChar: Math.min(windowLength, Math.max(1, overlapEnd - sourceStartChar)),
    });
  }

  return out;
}

export async function processBookQuotes(payload: ProcessBookQuotesPayload) {
  const bookId = String(payload.bookId || "").trim();
  if (!bookId) {
    throw new Error("Invalid book quotes payload: bookId is required");
  }

  const lockKey = `book-analyzer:quotes:${bookId}`;
  const lockRows =
    await prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked`;
  const locked = Boolean(lockRows?.[0]?.locked);
  if (!locked) return;

  try {
    const existingBook = await prisma.book.findUnique({
      where: { id: bookId },
      include: {
        analyzerTasks: {
          where: {
            analyzerType: "quotes",
          },
          select: {
            state: true,
          },
          take: 1,
        },
      },
    });
    if (!existingBook) return;

    const existingTaskState = existingBook.analyzerTasks[0]?.state || null;
    if (existingTaskState === "completed") {
      const existingQuotesCount = await prisma.bookQuote.count({
        where: { bookId },
      });
      if (existingQuotesCount > 0) {
        return;
      }
    }

    const startedAt = new Date();
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "quotes",
        },
      },
      create: {
        bookId,
        analyzerType: "quotes",
        state: "running",
        error: null,
        startedAt,
        completedAt: null,
      },
      update: {
        state: "running",
        error: null,
        startedAt,
        completedAt: null,
      },
    });

    const format = resolveUploadFormat(existingBook.fileName);
    if (!format) {
      throw new Error(`Unsupported stored book format: ${existingBook.fileName}`);
    }

    const blobStore = resolveBooksBlobStore(existingBook.storageProvider);
    const bytes = await blobStore.get(existingBook.storageKey);
    const parsedBook = ensureParsedBookHasChapters(
      await parseBook({
        format,
        fileName: existingBook.fileName,
        bytes,
        maxZipUncompressedBytes: workerConfig.imports.maxZipUncompressedBytes,
      })
    );
    const artifactStore = getArtifactBlobStore();

    const runAnalytics: RunQuotesAnalytics = {
      chaptersTotal: parsedBook.chapters.length,
      chaptersProcessed: 0,
      chaptersSkippedEmpty: 0,
      debugArtifactsPersisted: 0,
      debugArtifactsFailed: 0,
      extractedQuotes: 0,
      validatedQuotes: 0,
      dedupCandidates: 0,
      persistedQuotes: 0,
      dropped: createDropCounters(),
      offsetResolution: createOffsetResolutionAnalytics(),
      sentenceOverflow: createSentenceOverflowAnalytics(),
      mentions: createMentionAnalytics(),
      tags: createTagAnalytics(),
      chapterStats: [],
      dropSamples: createDropSampleBuckets(),
    };

    const quotesForPersist: QuoteCandidate[] = [];

    for (let index = 0; index < parsedBook.chapters.length; index += 1) {
      const parsedChapter = parsedBook.chapters[index];
      const chapterOrderIndex = index + 1;
      const chapterTitle = resolveChapterTitle(parsedChapter, chapterOrderIndex);
      const chapterText = buildPlainTextFromParsedChapter(parsedChapter);
      const chapterAnalytics: ChapterQuoteAnalytics = {
        chapterOrderIndex,
        chapterTitle,
        chapterTextLength: chapterText.length,
        skippedEmptyChapterText: false,
        debugArtifactStorageKey: null,
        extractedQuotes: 0,
        validatedQuotes: 0,
        dedupCandidates: 0,
        persistedQuotes: 0,
        dropped: createDropCounters(),
        offsetResolution: createOffsetResolutionAnalytics(),
        sentenceOverflow: createSentenceOverflowAnalytics(),
        mentions: createMentionAnalytics(),
        tags: createTagAnalytics(),
      };

      if (!compactWhitespace(chapterText)) {
        chapterAnalytics.skippedEmptyChapterText = true;
        runAnalytics.chaptersSkippedEmpty += 1;
        runAnalytics.chapterStats.push(chapterAnalytics);
        logger.info(
          {
            bookId,
            chapterOrderIndex,
            chapterTitle,
            chapterTextLength: chapterText.length,
          },
          "Book chapter quotes skipped: empty chapter text"
        );
        continue;
      }
      runAnalytics.chaptersProcessed += 1;

      const chapterQuotesCall = await runBookChapterQuotes({
        chapterTitle,
        chapterText,
      });

      chapterAnalytics.extractedQuotes = chapterQuotesCall.result.quotes.length;
      runAnalytics.extractedQuotes += chapterQuotesCall.result.quotes.length;

      let chapterDebugArtifact: QuotesChapterDebugArtifact | null = null;
      if (artifactStore) {
        try {
          chapterDebugArtifact = await persistChapterQuotesDebugArtifact({
            store: artifactStore,
            bookId,
            chapterOrderIndex,
            chapterTitle,
            chapterTextLength: chapterText.length,
            extractedQuotes: chapterQuotesCall.result.quotes.length,
            modelPayload: {
              meta: chapterQuotesCall.meta,
              debug: chapterQuotesCall.debug,
            },
          });
          chapterAnalytics.debugArtifactStorageKey = chapterDebugArtifact.storageKey;
          runAnalytics.debugArtifactsPersisted += 1;
        } catch (error) {
          runAnalytics.debugArtifactsFailed += 1;
          logger.warn(
            {
              err: error,
              bookId,
              chapterOrderIndex,
            },
            "Book chapter quotes debug artifact persistence failed"
          );
        }
      }

      logger.info(
        {
          bookId,
          chapterOrderIndex,
          provider: chapterQuotesCall.meta.provider,
          model: chapterQuotesCall.meta.model,
          attempt: chapterQuotesCall.meta.attempt,
          finishReason: chapterQuotesCall.meta.finishReason,
          startedAt: chapterQuotesCall.meta.startedAt,
          completedAt: chapterQuotesCall.meta.completedAt,
          latencyMs: chapterQuotesCall.meta.latencyMs,
          promptTokens: chapterQuotesCall.meta.usage?.promptTokens ?? null,
          completionTokens: chapterQuotesCall.meta.usage?.completionTokens ?? null,
          totalTokens: chapterQuotesCall.meta.usage?.totalTokens ?? null,
          extractedQuotes: chapterQuotesCall.result.quotes.length,
          debugArtifact: chapterDebugArtifact
            ? {
                provider: chapterDebugArtifact.provider,
                storageKey: chapterDebugArtifact.storageKey,
                sizeBytes: chapterDebugArtifact.sizeBytes,
                sha256: chapterDebugArtifact.sha256,
              }
            : null,
        },
        "Book chapter quotes generated"
      );

      const dedupByText = new Map<string, QuoteCandidate>();

      for (const extractedQuote of chapterQuotesCall.result.quotes) {
        const rawText = String(extractedQuote.text || "");
        const text = clampText(extractedQuote.text, MAX_QUOTE_TEXT_CHARS);
        if (!text) {
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "empty_text",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(rawText),
              sentenceCount: null,
              hintedStart: Number.isInteger(extractedQuote.startChar) ? extractedQuote.startChar : null,
              hintedEnd: Number.isInteger(extractedQuote.endChar) ? extractedQuote.endChar : null,
            },
          });
          continue;
        }

        let normalizedText = text;
        let sentenceCount = countSentences(normalizedText);
        let resolvedOffsets: ReturnType<typeof resolveQuoteOffsets> | null = null;
        let recoveredSourceStartChar: number | null = null;
        let recoveredSourceEndChar: number | null = null;

        if (sentenceCount > 3) {
          chapterAnalytics.sentenceOverflow.overLimitQuotes += 1;
          runAnalytics.sentenceOverflow.overLimitQuotes += 1;

          const recovery = recoverSentenceOverflowQuote({
            chapterText,
            quoteText: normalizedText,
            hintedStart: extractedQuote.startChar,
            hintedEnd: extractedQuote.endChar,
          });
          chapterAnalytics.sentenceOverflow.windowsTried += recovery.windowsTried;
          runAnalytics.sentenceOverflow.windowsTried += recovery.windowsTried;

          if (
            recovery.recovered &&
            recovery.text &&
            recovery.sentenceCount !== null &&
            recovery.resolvedOffsets &&
            recovery.sourceStartChar !== null &&
            recovery.sourceEndChar !== null
          ) {
            normalizedText = recovery.text;
            sentenceCount = recovery.sentenceCount;
            resolvedOffsets = recovery.resolvedOffsets;
            recoveredSourceStartChar = recovery.sourceStartChar;
            recoveredSourceEndChar = recovery.sourceEndChar;
            chapterAnalytics.sentenceOverflow.recoveredQuotes += 1;
            runAnalytics.sentenceOverflow.recoveredQuotes += 1;
          } else {
            chapterAnalytics.sentenceOverflow.unrecoveredQuotes += 1;
            runAnalytics.sentenceOverflow.unrecoveredQuotes += 1;
          }
        }

        if (sentenceCount < 1 || sentenceCount > 3) {
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "sentence_count_out_of_range",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(normalizedText),
              sentenceCount,
              hintedStart: Number.isInteger(extractedQuote.startChar) ? extractedQuote.startChar : null,
              hintedEnd: Number.isInteger(extractedQuote.endChar) ? extractedQuote.endChar : null,
            },
          });
          continue;
        }

        if (!resolvedOffsets) {
          resolvedOffsets = resolveQuoteOffsets({
            chapterText,
            quoteText: normalizedText,
            hintedStart: extractedQuote.startChar,
            hintedEnd: extractedQuote.endChar,
          });
        }
        if (!resolvedOffsets) {
          registerOffsetResolution({
            chapterAnalytics,
            runAnalytics,
            mode: null,
          });
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "offset_not_resolved",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(normalizedText),
              sentenceCount,
              hintedStart: Number.isInteger(extractedQuote.startChar) ? extractedQuote.startChar : null,
              hintedEnd: Number.isInteger(extractedQuote.endChar) ? extractedQuote.endChar : null,
            },
          });
          continue;
        }

        registerOffsetResolution({
          chapterAnalytics,
          runAnalytics,
          mode: resolvedOffsets.mode,
        });

        const startChar = Math.max(0, Math.floor(resolvedOffsets.startChar));
        const endChar = Math.max(startChar + 1, Math.floor(resolvedOffsets.endChar));
        if (endChar <= startChar) {
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "invalid_span",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(normalizedText),
              sentenceCount,
              hintedStart: startChar,
              hintedEnd: endChar,
            },
          });
          continue;
        }

        chapterAnalytics.validatedQuotes += 1;
        runAnalytics.validatedQuotes += 1;

        const uniqueTags = Array.from(new Set(extractedQuote.tags));
        const tags = uniqueTags.slice(0, MAX_TAGS_PER_QUOTE);
        const droppedTagsByLimit = Math.max(0, uniqueTags.length - tags.length);
        chapterAnalytics.tags.inputUnique += uniqueTags.length;
        chapterAnalytics.tags.persistedTags += tags.length;
        chapterAnalytics.tags.droppedByLimit += droppedTagsByLimit;
        runAnalytics.tags.inputUnique += uniqueTags.length;
        runAnalytics.tags.persistedTags += tags.length;
        runAnalytics.tags.droppedByLimit += droppedTagsByLimit;
        const commentaryRaw = clampText(extractedQuote.commentary || "", MAX_COMMENTARY_CHARS);
        const remappedMentionsInput =
          recoveredSourceStartChar !== null && recoveredSourceEndChar !== null
            ? remapMentionsToQuoteWindow(
                extractedQuote.mentions,
                recoveredSourceStartChar,
                recoveredSourceEndChar
              )
            : extractedQuote.mentions;
        const mentionNormalization = normalizeMentionCandidates(remappedMentionsInput, normalizedText);
        chapterAnalytics.mentions.inputMentions += mentionNormalization.analytics.inputMentions;
        chapterAnalytics.mentions.persistedMentions += mentionNormalization.analytics.persistedMentions;
        chapterAnalytics.mentions.droppedMissingValue += mentionNormalization.analytics.droppedMissingValue;
        chapterAnalytics.mentions.droppedDuplicate += mentionNormalization.analytics.droppedDuplicate;
        chapterAnalytics.mentions.droppedByLimit += mentionNormalization.analytics.droppedByLimit;
        runAnalytics.mentions.inputMentions += mentionNormalization.analytics.inputMentions;
        runAnalytics.mentions.persistedMentions += mentionNormalization.analytics.persistedMentions;
        runAnalytics.mentions.droppedMissingValue += mentionNormalization.analytics.droppedMissingValue;
        runAnalytics.mentions.droppedDuplicate += mentionNormalization.analytics.droppedDuplicate;
        runAnalytics.mentions.droppedByLimit += mentionNormalization.analytics.droppedByLimit;

        const candidate: QuoteCandidate = {
          chapterOrderIndex,
          startChar,
          endChar,
          text: normalizedText,
          type: extractedQuote.type,
          tags,
          confidence: clamp01(extractedQuote.confidence),
          commentary: commentaryRaw || null,
          mentions: mentionNormalization.mentions,
        };

        const dedupKey = `${chapterOrderIndex}:${normalizeSearchText(text)}`;
        const existing = dedupByText.get(dedupKey);
        if (!existing) {
          dedupByText.set(dedupKey, candidate);
          continue;
        }

        registerDrop({
          chapterAnalytics,
          runAnalytics,
          reason: "dedup",
          sample: {
            chapterOrderIndex,
            textSnippet: clampSnippet(candidate.text),
            sentenceCount,
            hintedStart: candidate.startChar,
            hintedEnd: candidate.endChar,
          },
        });

        if (
          candidate.confidence > existing.confidence ||
          (candidate.confidence === existing.confidence && candidate.text.length > existing.text.length)
        ) {
          dedupByText.set(dedupKey, candidate);
        }
      }

      const chapterCandidates = Array.from(dedupByText.values()).sort((left, right) => {
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        const leftLength = left.endChar - left.startChar;
        const rightLength = right.endChar - right.startChar;
        if (rightLength !== leftLength) return rightLength - leftLength;
        return left.startChar - right.startChar;
      });
      chapterAnalytics.dedupCandidates = chapterCandidates.length;
      runAnalytics.dedupCandidates += chapterCandidates.length;

      const nonOverlapping: QuoteCandidate[] = [];
      for (const candidate of chapterCandidates) {
        if (nonOverlapping.length >= MAX_QUOTES_PER_CHAPTER) {
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "chapter_limit",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(candidate.text),
              sentenceCount: countSentences(candidate.text),
              hintedStart: candidate.startChar,
              hintedEnd: candidate.endChar,
            },
          });
          continue;
        }

        const blocked = nonOverlapping.some(
          (accepted) => overlapRatio(accepted, candidate) > OVERLAP_THRESHOLD
        );
        if (blocked) {
          registerDrop({
            chapterAnalytics,
            runAnalytics,
            reason: "overlap",
            sample: {
              chapterOrderIndex,
              textSnippet: clampSnippet(candidate.text),
              sentenceCount: countSentences(candidate.text),
              hintedStart: candidate.startChar,
              hintedEnd: candidate.endChar,
            },
          });
          continue;
        }
        nonOverlapping.push(candidate);
      }

      chapterAnalytics.persistedQuotes = nonOverlapping.length;
      runAnalytics.persistedQuotes += nonOverlapping.length;

      nonOverlapping
        .sort((left, right) => {
          if (left.startChar !== right.startChar) return left.startChar - right.startChar;
          return left.endChar - right.endChar;
        })
        .forEach((quote) => {
          quotesForPersist.push(quote);
        });

      runAnalytics.chapterStats.push(chapterAnalytics);
      logger.info(
        {
          bookId,
          chapterOrderIndex,
          chapterTitle,
          chapterTextLength: chapterAnalytics.chapterTextLength,
          extractedQuotes: chapterAnalytics.extractedQuotes,
          validatedQuotes: chapterAnalytics.validatedQuotes,
          dedupCandidates: chapterAnalytics.dedupCandidates,
          persistedQuotes: chapterAnalytics.persistedQuotes,
          debugArtifactStorageKey: chapterAnalytics.debugArtifactStorageKey,
          droppedTotal: sumDropCounters(chapterAnalytics.dropped),
          dropped: chapterAnalytics.dropped,
          offsetResolution: chapterAnalytics.offsetResolution,
          sentenceOverflow: chapterAnalytics.sentenceOverflow,
          mentions: chapterAnalytics.mentions,
          tags: chapterAnalytics.tags,
        },
        "Book chapter quotes normalized"
      );
    }

    await prisma.$transaction(async (tx: any) => {
      const completedAt = new Date();

      await tx.bookQuote.deleteMany({
        where: { bookId },
      });

      for (const quote of quotesForPersist) {
        await tx.bookQuote.create({
          data: {
            bookId,
            chapterOrderIndex: quote.chapterOrderIndex,
            startChar: quote.startChar,
            endChar: quote.endChar,
            text: quote.text,
            type: quote.type,
            confidence: quote.confidence,
            commentary: quote.commentary,
            ...(quote.tags.length > 0
              ? {
                  tags: {
                    create: quote.tags.map((tag) => ({ tag })),
                  },
                }
              : {}),
            ...(quote.mentions.length > 0
              ? {
                  mentions: {
                    create: quote.mentions.map((mention) => ({
                      kind: mention.kind,
                      value: mention.value,
                      normalizedValue: mention.normalizedValue,
                      startChar: mention.startChar,
                      endChar: mention.endChar,
                      confidence: mention.confidence,
                    })),
                  },
                }
              : {}),
          },
        });
      }

      await tx.bookAnalyzerTask.upsert({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "quotes",
          },
        },
        create: {
          bookId,
          analyzerType: "quotes",
          state: "completed",
          error: null,
          startedAt,
          completedAt,
        },
        update: {
          state: "completed",
          error: null,
          startedAt,
          completedAt,
        },
      });

      const literaryTask = await tx.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: "literary",
          },
        },
        select: {
          state: true,
        },
      });

      if (!literaryTask || literaryTask.state === "failed") {
        await tx.bookAnalyzerTask.upsert({
          where: {
            bookId_analyzerType: {
              bookId,
              analyzerType: "literary",
            },
          },
          create: {
            bookId,
            analyzerType: "literary",
            state: "queued",
            error: null,
            startedAt: null,
            completedAt: null,
          },
          update: {
            state: "queued",
            error: null,
            startedAt: null,
            completedAt: null,
          },
        });

        await tx.outbox.create({
          data: {
            aggregateType: "book",
            aggregateId: bookId,
            eventType: "book.analyzer.requested",
            payloadJson: {
              bookId,
              analyzerType: "literary",
            },
          },
        });
      }
    });

    logger.info(
      {
        bookId,
        quotesPersisted: quotesForPersist.length,
        chaptersTotal: runAnalytics.chaptersTotal,
        chaptersProcessed: runAnalytics.chaptersProcessed,
        chaptersSkippedEmpty: runAnalytics.chaptersSkippedEmpty,
        debugArtifactsPersisted: runAnalytics.debugArtifactsPersisted,
        debugArtifactsFailed: runAnalytics.debugArtifactsFailed,
        extractedQuotes: runAnalytics.extractedQuotes,
        validatedQuotes: runAnalytics.validatedQuotes,
        dedupCandidates: runAnalytics.dedupCandidates,
        persistedQuotes: runAnalytics.persistedQuotes,
        persistedQuotesMismatch: runAnalytics.persistedQuotes !== quotesForPersist.length,
        droppedTotal: sumDropCounters(runAnalytics.dropped),
        dropped: runAnalytics.dropped,
        offsetResolution: runAnalytics.offsetResolution,
        sentenceOverflow: runAnalytics.sentenceOverflow,
        mentions: runAnalytics.mentions,
        tags: runAnalytics.tags,
        chapterStats: runAnalytics.chapterStats.map((chapter) => ({
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          chapterTextLength: chapter.chapterTextLength,
          skippedEmptyChapterText: chapter.skippedEmptyChapterText,
          debugArtifactStorageKey: chapter.debugArtifactStorageKey,
          extractedQuotes: chapter.extractedQuotes,
          validatedQuotes: chapter.validatedQuotes,
          dedupCandidates: chapter.dedupCandidates,
          persistedQuotes: chapter.persistedQuotes,
          droppedTotal: sumDropCounters(chapter.dropped),
          dropped: chapter.dropped,
          offsetResolution: chapter.offsetResolution,
          sentenceOverflow: chapter.sentenceOverflow,
        })),
        dropSamples: runAnalytics.dropSamples,
      },
      "Book quotes analysis completed"
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    await prisma.bookAnalyzerTask.upsert({
      where: {
        bookId_analyzerType: {
          bookId,
          analyzerType: "quotes",
        },
      },
      create: {
        bookId,
        analyzerType: "quotes",
        state: "failed",
        error: message,
        startedAt: null,
        completedAt: new Date(),
      },
      update: {
        state: "failed",
        error: message,
        completedAt: new Date(),
      },
    });
    throw error;
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)`;
  }
}
