import { z } from "zod";

export const ENTITY_TYPES = [
  "character",
  "location",
  "event",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export const LOCATION_ENTITY_TYPES = ["location"] as const;
export type LocationEntityType = (typeof LOCATION_ENTITY_TYPES)[number];
export const LocationEntityTypeSchema = z.enum(LOCATION_ENTITY_TYPES);

export const ANALYSIS_STATUSES = ["idle", "queued", "running", "completed", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);

export const RichTextDocumentSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.any()).optional(),
  })
  .passthrough();

export type RichTextDocument = z.infer<typeof RichTextDocumentSchema>;

export const EMPTY_RICH_TEXT_DOCUMENT: RichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function extractRichNodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";

  const typedNode = node as {
    type?: string;
    text?: string;
    content?: unknown[];
  };

  const nodeType = String(typedNode.type || "");
  if (nodeType === "text") return String(typedNode.text || "");
  if (nodeType === "hardBreak") return "\n";

  const children = Array.isArray(typedNode.content) ? typedNode.content : [];
  if (!children.length) return "";

  if (nodeType === "bulletList" || nodeType === "orderedList") {
    const items = children
      .map((child) => extractRichNodeText(child))
      .map((text) => text.trim())
      .filter(Boolean);

    return items.join("\n\n");
  }

  return children.map((child) => extractRichNodeText(child)).join("");
}

export function richTextToPlainText(richContent: unknown): string {
  const parsed = RichTextDocumentSchema.safeParse(richContent);
  if (!parsed.success) return "";

  const blocks = Array.isArray(parsed.data.content) ? parsed.data.content : [];
  const parts = blocks
    .map((block) => extractRichNodeText(block))
    .map((text) => text.trim())
    .filter(Boolean);

  return canonicalizeDocumentContent(parts.join("\n\n"));
}

export const ExtractionEntitySchema = z
  .object({
    entityRef: z.string().trim().min(1).max(120),
    type: EntityTypeSchema,
    name: z.string().trim().min(1),
    summary: z.string().trim().max(500).optional().default(""),
  })
  .strict();

export const ExtractionMentionSchema = z.object({
  entityRef: z.string().trim().min(1).max(120),
  type: EntityTypeSchema,
  name: z.string().trim().min(1),
  paragraphIndex: z.number().int().nonnegative(),
  mentionText: z.string().trim().min(1),
});

export const ExtractionAnnotationSchema = z.object({
  entityRef: z.string().trim().min(1).max(120).optional(),
  paragraphIndex: z.number().int().nonnegative(),
  type: EntityTypeSchema,
  label: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).optional(),
});

export const ExtractionLocationContainmentSchema = z.object({
  childRef: z.string().trim().min(1).max(120),
  parentRef: z.string().trim().min(1).max(120),
});

export const ExtractionResultSchema = z.object({
  entities: z.array(ExtractionEntitySchema).default([]),
  mentions: z.array(ExtractionMentionSchema).default([]),
  annotations: z.array(ExtractionAnnotationSchema).default([]),
  locationContainments: z.array(ExtractionLocationContainmentSchema).default([]),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractionEntity = z.infer<typeof ExtractionEntitySchema>;
export type ExtractionMention = z.infer<typeof ExtractionMentionSchema>;
export type ExtractionAnnotation = z.infer<typeof ExtractionAnnotationSchema>;
export type ExtractionLocationContainment = z.infer<typeof ExtractionLocationContainmentSchema>;

export interface ParagraphSlice {
  index: number;
  text: string;
  startOffset: number;
}

export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/["'`’.,!?;:()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeDocumentContent(content: string): string {
  const normalized = String(content || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trim();

  return normalized.replace(/\n{3,}/g, "\n\n");
}

export function splitParagraphs(content: string): ParagraphSlice[] {
  const normalized = canonicalizeDocumentContent(content);
  if (!normalized) return [];

  const parts = normalized.split(/\n\n/);
  let offset = 0;

  return parts.map((text, index) => {
    const slice: ParagraphSlice = {
      index,
      text,
      startOffset: offset,
    };

    offset += text.length + 2;
    return slice;
  });
}

function isWordBoundaryChar(value: string): boolean {
  return /[\p{L}\p{N}\p{M}]/u.test(value);
}

function isWholeWordMatch(haystack: string, start: number, length: number): boolean {
  const before = start > 0 ? haystack[start - 1] : "";
  const after = start + length < haystack.length ? haystack[start + length] : "";
  return (!before || !isWordBoundaryChar(before)) && (!after || !isWordBoundaryChar(after));
}

function findNthOccurrence(
  haystack: string,
  needle: string,
  nth: number,
  options: { wholeWord?: boolean } = {}
): number {
  if (!needle) return -1;
  const haystackLower = haystack.toLowerCase();
  const needleLower = needle.toLowerCase();
  let cursor = 0;
  let seen = 0;

  while (cursor <= haystack.length) {
    const found = haystackLower.indexOf(needleLower, cursor);
    if (found === -1) return -1;

    cursor = found + Math.max(needle.length, 1);
    if (options.wholeWord && !isWholeWordMatch(haystack, found, needle.length)) {
      continue;
    }

    if (seen === nth) {
      return found;
    }

    seen += 1;
  }

  return -1;
}

export interface ResolvedMentionOffset {
  entityRef: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  type: EntityType;
  name: string;
}

export function resolveMentionOffsets(content: string, mentions: ExtractionMention[]): ResolvedMentionOffset[] {
  const paragraphs = splitParagraphs(content);
  if (!paragraphs.length) return [];

  const occurrenceCounter = new Map<string, number>();
  const resolved: ResolvedMentionOffset[] = [];

  for (const mention of mentions) {
    const paragraph = paragraphs[mention.paragraphIndex];
    if (!paragraph) continue;

    const key = `${mention.paragraphIndex}::${mention.mentionText.toLowerCase()}`;
    const seen = occurrenceCounter.get(key) ?? 0;

    let localStart = findNthOccurrence(paragraph.text, mention.mentionText, seen, { wholeWord: true });
    let sourceText = mention.mentionText;

    if (localStart === -1) {
      localStart = findNthOccurrence(paragraph.text, mention.mentionText, seen);
    }

    if (localStart === -1) {
      localStart = findNthOccurrence(paragraph.text, mention.name, seen, { wholeWord: true });
      sourceText = mention.name;
    }

    if (localStart === -1) {
      localStart = findNthOccurrence(paragraph.text, mention.name, seen);
      sourceText = mention.name;
    }

    if (localStart === -1) {
      continue;
    }

    occurrenceCounter.set(key, seen + 1);

    resolved.push({
      entityRef: mention.entityRef,
      paragraphIndex: mention.paragraphIndex,
      startOffset: paragraph.startOffset + localStart,
      endOffset: paragraph.startOffset + localStart + sourceText.length,
      sourceText,
      type: mention.type,
      name: mention.name,
    });
  }

  return resolved;
}

export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DocumentPayloadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  chapterId: z.string(),
  content: z.string(),
  richContent: RichTextDocumentSchema,
  contentVersion: z.number().int().nonnegative(),
  analysisStatus: AnalysisStatusSchema,
  lastAnalyzedVersion: z.number().int().nullable(),
  mentions: z.array(
    z.object({
      id: z.string(),
      entityId: z.string(),
      paragraphIndex: z.number().int().nonnegative(),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
      sourceText: z.string(),
      entity: z.object({
        id: z.string(),
        type: EntityTypeSchema,
        name: z.string(),
      }),
    })
  ),
  annotations: z.array(
    z.object({
      id: z.string(),
      paragraphIndex: z.number().int().nonnegative(),
      label: z.string(),
      type: EntityTypeSchema,
      entityId: z.string().nullable(),
      entity: z
        .object({
          id: z.string(),
          type: EntityTypeSchema,
          name: z.string(),
        })
        .nullable(),
    })
  ),
});

export type DocumentPayload = z.infer<typeof DocumentPayloadSchema>;
