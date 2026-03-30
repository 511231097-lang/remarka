import { splitParagraphs } from "@remarka/contracts";

const DEFAULT_LCS_CELL_LIMIT = 1_500_000;
const DEFAULT_ANCHOR_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_CHANGED_RATIO = 0.25;
const DEFAULT_MAX_CHANGED_PARAGRAPHS = 30;

type DiffAlgorithm = "none" | "lcs" | "anchor";
type DiffReason = "missing_snapshot" | "low_confidence" | "too_many_changes";

interface IndexPair {
  oldIndex: number;
  newIndex: number;
}

export interface ParagraphDiffOptions {
  lcsCellLimit?: number;
  anchorMinConfidence?: number;
  maxChangedRatio?: number;
  maxChangedParagraphs?: number;
}

export interface ParagraphDiffResult {
  mode: "incremental" | "full";
  algorithm: DiffAlgorithm;
  reason: DiffReason | null;
  confidence: number;
  oldParagraphCount: number;
  newParagraphCount: number;
  changedNewIndices: number[];
  unchangedMap: Array<{ newIndex: number; oldIndex: number }>;
}

function hashParagraph(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

function computeLongestIncreasingSubsequenceIndices(values: number[]): number[] {
  if (!values.length) return [];

  const tails: number[] = [];
  const tailsIndices: number[] = [];
  const previous = new Array(values.length).fill(-1);

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const pos = lowerBound(tails, value);

    if (pos > 0) {
      previous[i] = tailsIndices[pos - 1];
    }

    if (pos === tails.length) {
      tails.push(value);
      tailsIndices.push(i);
    } else {
      tails[pos] = value;
      tailsIndices[pos] = i;
    }
  }

  const result = new Array(tails.length);
  let cursor = tailsIndices[tails.length - 1];

  for (let i = tails.length - 1; i >= 0; i -= 1) {
    result[i] = cursor;
    cursor = previous[cursor];
  }

  return result;
}

function computeLcsPairs(oldHashes: string[], newHashes: string[]): IndexPair[] {
  const oldCount = oldHashes.length;
  const newCount = newHashes.length;

  if (!oldCount || !newCount) return [];

  const width = newCount + 1;
  const dp = new Uint32Array((oldCount + 1) * width);

  for (let i = 1; i <= oldCount; i += 1) {
    for (let j = 1; j <= newCount; j += 1) {
      const current = i * width + j;
      if (oldHashes[i - 1] === newHashes[j - 1]) {
        dp[current] = dp[(i - 1) * width + (j - 1)] + 1;
      } else {
        const top = dp[(i - 1) * width + j];
        const left = dp[i * width + (j - 1)];
        dp[current] = top >= left ? top : left;
      }
    }
  }

  const pairs: IndexPair[] = [];
  let i = oldCount;
  let j = newCount;

  while (i > 0 && j > 0) {
    if (oldHashes[i - 1] === newHashes[j - 1]) {
      pairs.push({ oldIndex: i - 1, newIndex: j - 1 });
      i -= 1;
      j -= 1;
      continue;
    }

    const top = dp[(i - 1) * width + j];
    const left = dp[i * width + (j - 1)];
    if (top >= left) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return pairs.reverse();
}

function computeAnchorPairs(oldParagraphs: string[], newParagraphs: string[]): IndexPair[] {
  const oldHashes = oldParagraphs.map(hashParagraph);
  const newHashes = newParagraphs.map(hashParagraph);

  const oldByHash = new Map<string, number[]>();
  const newByHash = new Map<string, number[]>();

  for (let i = 0; i < oldHashes.length; i += 1) {
    const hash = oldHashes[i];
    const bucket = oldByHash.get(hash) || [];
    bucket.push(i);
    oldByHash.set(hash, bucket);
  }

  for (let i = 0; i < newHashes.length; i += 1) {
    const hash = newHashes[i];
    const bucket = newByHash.get(hash) || [];
    bucket.push(i);
    newByHash.set(hash, bucket);
  }

  const candidates: IndexPair[] = [];

  for (const [hash, oldIndices] of oldByHash) {
    if (oldIndices.length !== 1) continue;
    const newIndices = newByHash.get(hash);
    if (!newIndices || newIndices.length !== 1) continue;

    const oldIndex = oldIndices[0];
    const newIndex = newIndices[0];

    if (oldParagraphs[oldIndex] !== newParagraphs[newIndex]) continue;
    candidates.push({ oldIndex, newIndex });
  }

  if (!candidates.length) return [];

  candidates.sort((a, b) => a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
  const lisIndices = computeLongestIncreasingSubsequenceIndices(candidates.map((pair) => pair.newIndex));
  return lisIndices.map((index) => candidates[index]);
}

function toUnchangedMap(pairs: IndexPair[]) {
  return pairs
    .map((pair) => ({ newIndex: pair.newIndex, oldIndex: pair.oldIndex }))
    .sort((a, b) => a.newIndex - b.newIndex);
}

function toChangedIndices(newCount: number, unchangedMap: Array<{ newIndex: number; oldIndex: number }>): number[] {
  const unchanged = new Set(unchangedMap.map((entry) => entry.newIndex));
  const changed: number[] = [];

  for (let i = 0; i < newCount; i += 1) {
    if (!unchanged.has(i)) {
      changed.push(i);
    }
  }

  return changed;
}

function toFullResult(
  params: Omit<ParagraphDiffResult, "mode" | "reason"> & { reason: DiffReason }
): ParagraphDiffResult {
  return {
    ...params,
    mode: "full",
    reason: params.reason,
  };
}

export function buildParagraphDiff(
  previousContent: string | null | undefined,
  nextContent: string,
  options: ParagraphDiffOptions = {}
): ParagraphDiffResult {
  const oldParagraphs = splitParagraphs(previousContent || "").map((paragraph) => paragraph.text);
  const newParagraphs = splitParagraphs(nextContent).map((paragraph) => paragraph.text);
  const oldCount = oldParagraphs.length;
  const newCount = newParagraphs.length;

  if (!oldCount) {
    return {
      mode: "full",
      algorithm: "none",
      reason: "missing_snapshot",
      confidence: 0,
      oldParagraphCount: oldCount,
      newParagraphCount: newCount,
      changedNewIndices: Array.from({ length: newCount }, (_, index) => index),
      unchangedMap: [],
    };
  }

  const lcsCellLimit = options.lcsCellLimit ?? DEFAULT_LCS_CELL_LIMIT;
  const anchorMinConfidence = options.anchorMinConfidence ?? DEFAULT_ANCHOR_MIN_CONFIDENCE;
  const maxChangedRatio = options.maxChangedRatio ?? DEFAULT_MAX_CHANGED_RATIO;
  const maxChangedParagraphs = options.maxChangedParagraphs ?? DEFAULT_MAX_CHANGED_PARAGRAPHS;

  const algorithm: DiffAlgorithm =
    oldCount * newCount <= lcsCellLimit ? "lcs" : "anchor";

  const pairs =
    algorithm === "lcs"
      ? computeLcsPairs(oldParagraphs.map(hashParagraph), newParagraphs.map(hashParagraph))
      : computeAnchorPairs(oldParagraphs, newParagraphs);

  const unchangedMap = toUnchangedMap(pairs);
  const changedNewIndices = toChangedIndices(newCount, unchangedMap);
  const confidence = pairs.length / Math.max(oldCount, newCount, 1);

  const baseResult = {
    algorithm,
    confidence,
    oldParagraphCount: oldCount,
    newParagraphCount: newCount,
    changedNewIndices,
    unchangedMap,
  };

  if (algorithm === "anchor" && confidence < anchorMinConfidence) {
    return toFullResult({
      ...baseResult,
      reason: "low_confidence",
    });
  }

  if (changedNewIndices.length > maxChangedParagraphs) {
    return toFullResult({
      ...baseResult,
      reason: "too_many_changes",
    });
  }

  const changedRatio = newCount > 0 ? changedNewIndices.length / newCount : 0;
  if (changedRatio > maxChangedRatio) {
    return toFullResult({
      ...baseResult,
      reason: "too_many_changes",
    });
  }

  return {
    ...baseResult,
    mode: "incremental",
    reason: null,
  };
}
