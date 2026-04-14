import { z } from "zod";

export const ENTITY_TYPES = ["character", "location", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const EntityTypeSchema = z.enum(ENTITY_TYPES);

export const ANALYSIS_RUN_STATES = ["queued", "running", "completed", "failed", "superseded"] as const;
export type AnalysisRunState = (typeof ANALYSIS_RUN_STATES)[number];
export const AnalysisRunStateSchema = z.enum(ANALYSIS_RUN_STATES);

export const ANALYSIS_RUN_PHASES = [
  "queued",
  "prepass",
  "entity_pass",
  "sweep",
  "mention_completion",
  "act_pass",
  "appearance_pass",
  "apply",
  "completed",
  "failed",
  "superseded",
] as const;
export type AnalysisRunPhase = (typeof ANALYSIS_RUN_PHASES)[number];
export const AnalysisRunPhaseSchema = z.enum(ANALYSIS_RUN_PHASES);

export const MENTION_ROUTINGS = ["deterministic", "patch"] as const;
export type MentionRouting = (typeof MENTION_ROUTINGS)[number];
export const MentionRoutingSchema = z.enum(MENTION_ROUTINGS);

export const MENTION_DECISIONS = ["pending", "accepted", "rejected"] as const;
export type MentionDecisionStatus = (typeof MENTION_DECISIONS)[number];
export const MentionDecisionStatusSchema = z.enum(MENTION_DECISIONS);

export const MENTION_CANDIDATE_TYPES = ["alias", "role", "coreference", "ambiguous"] as const;
export type MentionCandidateType = (typeof MENTION_CANDIDATE_TYPES)[number];
export const MentionCandidateTypeSchema = z.enum(MENTION_CANDIDATE_TYPES);

export const MENTION_TYPES = ["named", "alias", "descriptor", "pronoun"] as const;
export type MentionType = (typeof MENTION_TYPES)[number];
export const MentionTypeSchema = z.enum(MENTION_TYPES);

export const ALIAS_TYPES = ["name", "nickname", "title", "descriptor"] as const;
export type AliasType = (typeof ALIAS_TYPES)[number];
export const AliasTypeSchema = z.enum(ALIAS_TYPES);

export const APPEARANCE_SCOPES = ["stable", "temporary", "scene"] as const;
export type AppearanceScope = (typeof APPEARANCE_SCOPES)[number];
export const AppearanceScopeSchema = z.enum(APPEARANCE_SCOPES);

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

export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/["'`’.,!?;:()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAliasType(value: unknown, fallback: AliasType = "name"): AliasType {
  const raw = String(value || "").trim().toLowerCase();
  const parsed = AliasTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

export function classifyMentionTypeFromAlias(params: {
  canonicalName: string;
  alias: string;
  aliasType: AliasType;
}): MentionType {
  const aliasNormalized = normalizeEntityName(params.alias);
  const canonicalNormalized = normalizeEntityName(params.canonicalName);
  if (aliasNormalized && canonicalNormalized && aliasNormalized === canonicalNormalized) return "named";
  if (params.aliasType === "descriptor" || params.aliasType === "title") return "descriptor";
  return "alias";
}

export function isPronounConfidenceAccepted(confidence: number, threshold = 0.9): boolean {
  if (!Number.isFinite(confidence)) return false;
  if (!Number.isFinite(threshold)) return false;
  return confidence >= threshold;
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

export interface ParagraphSlice {
  index: number;
  text: string;
  startOffset: number;
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

function findNthOccurrence(haystack: string, needle: string, nth: number, options: { wholeWord?: boolean } = {}): number {
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
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
}

export function resolveMentionOffsets<T extends { paragraphIndex: number; mentionText: string; name?: string; fallbackText?: string }>(
  content: string,
  mentions: T[]
): Array<T & ResolvedMentionOffset> {
  const paragraphs = splitParagraphs(content);
  if (!paragraphs.length) return [];

  const occurrenceCounter = new Map<string, number>();
  const resolved: Array<T & ResolvedMentionOffset> = [];

  for (const mention of mentions) {
    const paragraph = paragraphs[mention.paragraphIndex];
    if (!paragraph) continue;

    const mentionText = String(mention.mentionText || "").trim();
    const fallbackText = String(mention.fallbackText || mention.name || "").trim();
    if (!mentionText && !fallbackText) continue;

    const key = `${mention.paragraphIndex}::${mentionText.toLowerCase()}`;
    const seen = occurrenceCounter.get(key) ?? 0;

    let localStart = mentionText ? findNthOccurrence(paragraph.text, mentionText, seen, { wholeWord: true }) : -1;
    let sourceText = mentionText;

    if (localStart === -1 && mentionText) {
      localStart = findNthOccurrence(paragraph.text, mentionText, seen);
    }

    if (localStart === -1 && fallbackText) {
      localStart = findNthOccurrence(paragraph.text, fallbackText, seen, { wholeWord: true });
      sourceText = fallbackText;
    }

    if (localStart === -1 && fallbackText) {
      localStart = findNthOccurrence(paragraph.text, fallbackText, seen);
      sourceText = fallbackText;
    }

    if (localStart === -1) {
      continue;
    }

    occurrenceCounter.set(key, seen + 1);

    resolved.push({
      ...mention,
      paragraphIndex: mention.paragraphIndex,
      startOffset: paragraph.startOffset + localStart,
      endOffset: paragraph.startOffset + localStart + sourceText.length,
      sourceText,
    });
  }

  return resolved;
}

export * from "./bookExpertCore";

export const ExtractionEntitySchema = z
  .object({
    entityRef: z.string().trim().min(1).max(120),
    type: EntityTypeSchema,
    name: z.string().trim().min(1),
    summary: z.string().trim().max(500).optional().default(""),
  })
  .strict();

export const ExtractionMentionSchema = z
  .object({
    entityRef: z.string().trim().min(1).max(120),
    type: EntityTypeSchema,
    name: z.string().trim().min(1),
    paragraphIndex: z.number().int().nonnegative(),
    mentionText: z.string().trim().min(1),
  })
  .strict();

export const ExtractionLocationContainmentSchema = z
  .object({
    childRef: z.string().trim().min(1).max(120),
    parentRef: z.string().trim().min(1).max(120),
  })
  .strict();

export const ExtractionResultSchema = z
  .object({
    entities: z.array(ExtractionEntitySchema).default([]),
    mentions: z.array(ExtractionMentionSchema).default([]),
    annotations: z.array(z.unknown()).default([]),
    locationContainments: z.array(ExtractionLocationContainmentSchema).default([]),
  })
  .strict();

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const NameCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    text: z.string().min(1),
    normalizedText: z.string().min(1),
    chunkId: z.string().min(1).optional(),
    paragraphIndex: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const ChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    text: z.string(),
    paragraphStart: z.number().int().nonnegative(),
    paragraphEnd: z.number().int().nonnegative(),
  })
  .strict();

export const ContextSnippetSchema = z
  .object({
    snippetId: z.string().min(1),
    paragraphIndex: z.number().int().nonnegative(),
    text: z.string().min(1),
    chunkId: z.string().min(1).optional(),
  })
  .strict();

export const PrepassResultSchema = z
  .object({
    contentVersion: z.number().int().nonnegative(),
    paragraphs: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          text: z.string(),
          startOffset: z.number().int().nonnegative(),
        })
        .strict()
    ),
    candidates: z.array(NameCandidateSchema),
    snippets: z.array(ContextSnippetSchema),
    chunks: z.array(ChunkSchema).default([]),
  })
  .strict();

export type PrepassResult = z.infer<typeof PrepassResultSchema>;

export const ActSegmentSchema = z
  .object({
    orderIndex: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(240),
    summary: z.string().max(1200).default(""),
    paragraphStart: z.number().int().nonnegative(),
    paragraphEnd: z.number().int().nonnegative(),
  })
  .strict();

export type ActSegment = z.infer<typeof ActSegmentSchema>;

export const ActPassResultSchema = z
  .object({
    contentVersion: z.number().int().nonnegative(),
    acts: z.array(ActSegmentSchema),
  })
  .strict();

export type ActPassResult = z.infer<typeof ActPassResultSchema>;

export const AppearanceObservationSchema = z
  .object({
    orderIndex: z.number().int().nonnegative(),
    characterId: z.string().min(1),
    attributeKey: z.string().trim().min(1).max(64),
    attributeLabel: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(280),
    scope: AppearanceScopeSchema.default("scene"),
    actOrderIndex: z.number().int().nonnegative().nullable().optional(),
    summary: z.string().max(280).default(""),
    confidence: z.number().min(0).max(1).default(0.7),
    evidenceIds: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict();

export type AppearanceObservation = z.infer<typeof AppearanceObservationSchema>;

export const AppearancePassResultSchema = z
  .object({
    contentVersion: z.number().int().nonnegative(),
    observations: z.array(AppearanceObservationSchema),
  })
  .strict();

export type AppearancePassResult = z.infer<typeof AppearancePassResultSchema>;

export const EntityPassAliasSchema = z
  .object({
    alias: z.string().min(1),
    normalizedAlias: z.string().min(1),
    aliasType: AliasTypeSchema.default("name"),
    observed: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const EntityPassEntitySchema = z
  .object({
    tempEntityId: z.string().min(1),
    type: EntityTypeSchema,
    canonicalName: z.string().min(1),
    normalizedName: z.string().min(1),
    summary: z.string().default(""),
    resolution: z
      .object({
        action: z.enum(["link_existing", "create_new"]),
        existingEntityId: z.string().nullable(),
      })
      .strict(),
    aliases: z.array(EntityPassAliasSchema),
    evidence: z.array(
      z
        .object({
          snippetId: z.string().min(1),
          quote: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict();

export const EntityPassResultSchema = z
  .object({
    contentVersion: z.number().int().nonnegative(),
    entities: z.array(EntityPassEntitySchema),
  })
  .strict();

export type EntityPassResult = z.infer<typeof EntityPassResultSchema>;

export const PatchWindowOpSchema = z
  .object({
    op: z.enum(["accept_candidate", "reject_candidate", "link_candidate", "create_entity_and_link", "set_location_parent"]),
    candidateId: z.string().min(1),
    entityId: z.string().nullable(),
    confidence: z.number().min(0).max(1).optional(),
    newEntity: z
      .object({
        type: EntityTypeSchema,
        canonicalName: z.string().min(1),
        normalizedName: z.string().min(1),
      })
      .nullable()
      .optional(),
    parentLocationId: z.string().nullable().optional(),
  })
  .strict();

export const PatchWindowsResultSchema = z
  .object({
    runId: z.string().min(1),
    contentVersion: z.number().int().nonnegative(),
    windows: z.array(
      z
        .object({
          windowKey: z.string().min(1),
          ops: z.array(PatchWindowOpSchema),
        })
        .strict()
    ),
  })
  .strict();

export type PatchWindowsResult = z.infer<typeof PatchWindowsResultSchema>;

export const EntityAliasPayloadSchema = z
  .object({
    entityId: z.string(),
    alias: z.string().min(1),
    normalizedAlias: z.string().min(1),
    aliasType: AliasTypeSchema,
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
    observed: z.boolean(),
  })
  .strict();

export type EntityAliasPayload = z.infer<typeof EntityAliasPayloadSchema>;

export const MentionCandidatePayloadSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    documentId: z.string(),
    contentVersion: z.number().int().nonnegative(),
    paragraphIndex: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    sourceText: z.string(),
    candidateType: MentionCandidateTypeSchema,
    routing: MentionRoutingSchema,
    decisionStatus: MentionDecisionStatusSchema,
    confidence: z.number().min(0).max(1),
    conflictGroupId: z.string().nullable(),
    entityHintId: z.string().nullable(),
  })
  .strict();

export type MentionCandidatePayload = z.infer<typeof MentionCandidatePayloadSchema>;

export const PatchWindowDecisionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    windowKey: z.string(),
    inputCandidateIds: z.array(z.string()),
    model: z.string(),
    applied: z.boolean(),
    validationError: z.string().nullable(),
    responseHashSha256: z.string().nullable().optional(),
    responseBytes: z.number().int().nullable().optional(),
  })
  .strict();

export type PatchWindowDecision = z.infer<typeof PatchWindowDecisionSchema>;

export const QualityFlagsSchema = z
  .object({
    isPatched: z.boolean(),
    patchBudgetReached: z.boolean(),
    uncertainCountRemaining: z.number().int().nonnegative(),
    eligibleCoverage: z.number().min(0).max(1),
    hasConflicts: z.boolean(),
  })
  .strict();

export type QualityFlags = z.infer<typeof QualityFlagsSchema>;

export const SnapshotMentionSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    mentionType: MentionTypeSchema,
    paragraphIndex: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    sourceText: z.string(),
    confidence: z.number().min(0).max(1),
    entity: z
      .object({
        id: z.string(),
        type: EntityTypeSchema,
        name: z.string(),
      })
      .strict(),
  })
  .strict();

export const DocumentSnapshotSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    chapterId: z.string(),
    content: z.string(),
    richContent: RichTextDocumentSchema,
    contentVersion: z.number().int().nonnegative(),
    mentions: z.array(SnapshotMentionSchema),
    updatedAt: z.string(),
  })
  .strict();

export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

export const DocumentPayloadSchema = DocumentSnapshotSchema;
export type DocumentPayload = DocumentSnapshot;

export const AnalysisRunPayloadSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    documentId: z.string(),
    chapterId: z.string(),
    contentVersion: z.number().int().nonnegative(),
    state: AnalysisRunStateSchema,
    phase: AnalysisRunPhaseSchema,
    error: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    qualityFlags: QualityFlagsSchema.nullable(),
  })
  .strict();

export type AnalysisRunPayload = z.infer<typeof AnalysisRunPayloadSchema>;

export const DocumentViewResponseSchema = z
  .object({
    run: AnalysisRunPayloadSchema.nullable(),
    snapshot: DocumentSnapshotSchema,
    qualityFlags: QualityFlagsSchema.nullable(),
  })
  .strict();

export type DocumentViewResponse = z.infer<typeof DocumentViewResponseSchema>;

export const PutDocumentResponseSchema = z
  .object({
    runId: z.string(),
    contentVersion: z.number().int().nonnegative(),
    runState: AnalysisRunStateSchema,
    snapshotAvailable: z.boolean(),
    snapshot: DocumentSnapshotSchema.nullable(),
    qualityFlags: QualityFlagsSchema.nullable(),
  })
  .strict();

export type PutDocumentResponse = z.infer<typeof PutDocumentResponseSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export * from "./bookImport";
export * from "./bookExpertCore";
export * from "./bookGraph";
