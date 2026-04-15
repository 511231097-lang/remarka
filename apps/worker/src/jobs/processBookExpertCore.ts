import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { LocalBlobStore, S3BlobStore, enqueueBookAnalyzerStage, type BlobStore, prisma } from "@remarka/db";
import {
  BOOK_EXPERT_CORE_GROUP_FACETS,
  BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS,
  BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS,
  BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS,
  BOOK_EXPERT_CORE_QUOTE_TAGS,
  BOOK_EXPERT_CORE_QUOTE_TYPES,
  BOOK_EXPERT_CORE_RELATION_FACETS,
  BOOK_EXPERT_CORE_RESOLUTION_STATUSES,
  BOOK_EXPERT_CORE_STAGE_KEYS,
  BOOK_EXPERT_CORE_VERSION,
  BookExpertCoreCharacterSchema,
  BookExpertCoreEntityMentionSchema,
  BookExpertCoreExtractedRefSchema,
  BookExpertCoreGroupSchema,
  BookExpertCoreIncidentSchema,
  type BookExpertCoreLiterarySection,
  BookExpertCoreLiterarySectionKeySchema,
  BookExpertCoreLiterarySectionSchema,
  BookExpertCoreLocationSchema,
  BookExpertCoreQuoteSchema,
  BookExpertCoreRelationCandidateSchema,
  BookExpertCoreSnapshotSchema,
  BookExpertCoreThemeSchema,
  BookExpertCoreWindowScanSchema,
  buildPlainTextFromParsedChapter,
  canonicalizeDocumentContent,
  detectBookFormatFromFileName,
  ensureParsedBookHasChapters,
  normalizeEntityName,
  parseBook,
  type BookExpertCoreIncident,
  type BookExpertCoreRelationCandidate,
  type BookExpertCoreSnapshot,
  type BookExpertCoreStageKey,
  type BookExpertCoreWindowScan,
  type BookFormat,
  type ParsedChapter,
} from "@remarka/contracts";
import {
  completedExecution,
  deferredDependenciesExecution,
  deferredLockExecution,
  retryableFailureExecution,
  RetryableAnalyzerError,
  type AnalyzerExecutionResult,
} from "../analyzerExecution";
import {
  applyStrictJsonAttemptToTaskMetadata,
  type BookAnalyzerTaskMetadata,
  type StrictJsonAttemptLike,
  mergeBookAnalyzerTaskMetadata,
} from "../bookAnalyzerTaskMetadata";
import {
  normalizeLiterarySection,
  normalizeLiterarySectionsRecord,
} from "../bookExpertCoreLiteraryNormalization";
import {
  claimQueuedAnalyzerTaskExecution,
  markBookAnalysisRunning,
  refreshBookAnalysisLifecycle,
} from "../bookAnalysisLifecycle";
import { workerConfig } from "../config";
import { callStrictJson, ExtractionStructuredOutputError } from "../extractionV2";
import { logger } from "../logger";

interface StagePayload {
  bookId: string;
}

type CoreAnalyzerType = BookExpertCoreStageKey;
type LiterarySectionsRecord = Record<LiterarySectionKey, BookExpertCoreLiterarySection>;

interface LoadedBookSource {
  id: string;
  title: string;
  author: string | null;
  fileName: string;
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
}

interface ChapterSource {
  orderIndex: number;
  title: string;
  rawText: string;
}

interface WindowInput {
  windowIndex: number;
  chapterFrom: number;
  chapterTo: number;
  chapters: ChapterSource[];
  text: string;
  textChars: number;
}

interface CandidateEntityAggregate {
  normalizedName: string;
  name: string;
  category: "character" | "theme" | "location" | "group";
  aliases: Set<string>;
  mentionCount: number;
  firstAppearanceChapterOrder: number | null;
  descriptionHints: string[];
  roleHints: string[];
  arcHints: string[];
  motivationHints: string[];
  significanceHints: string[];
  memberHints: Array<{
    value: string;
    normalizedValue: string;
    role: string;
    confidence: number;
  }>;
  rawKindLabels: string[];
  facetHints: Array<{ facet: (typeof BOOK_EXPERT_CORE_GROUP_FACETS)[number]; confidence: number }>;
  anchors: Array<{ chapterOrderIndex: number; snippet: string }>;
  sourceWindows: Set<number>;
}

interface RelationCandidateAggregate {
  id: string;
  fromRef: z.infer<typeof BookExpertCoreExtractedRefSchema>;
  toRef: z.infer<typeof BookExpertCoreExtractedRefSchema>;
  rawTypeLabel: string;
  facet: BookExpertCoreRelationCandidate["facet"];
  facetConfidence: number | null;
  summary: string;
  confidence: number;
  chapterFrom: number;
  chapterTo: number;
  quoteTexts: string[];
  anchors: Array<{ chapterOrderIndex: number; snippet: string }>;
  sourceWindows: Array<{ windowIndex: number; chapterFrom: number; chapterTo: number; chapterCount: number; textChars: number }>;
}

const MAX_PLOT_POINTS = 18;
const MAX_CHARACTERS = 12;
const MAX_THEMES = 10;
const MAX_LOCATIONS = 10;
const MAX_GROUPS = 10;
const MAX_QUOTES = 60;
const MAX_INCIDENTS = 24;
const WINDOW_SCAN_CONCURRENCY = 3;
const QUOTE_MENTION_BATCH_SIZE = 12;
const QUOTE_MENTION_CONCURRENCY = 2;
const RELATION_REFINE_BATCH_SIZE = 6;
const RELATION_REFINE_CONCURRENCY = 2;
const ENTITY_MENTION_BATCH_SIZE = 12;
const ENTITY_MENTION_CONCURRENCY = 2;
const PROFILE_BATCH_SIZE = 4;
const REF_LINK_BATCH_SIZE = 10;
const REF_LINK_CONCURRENCY = 2;
const WINDOW_TARGET_TOKENS = 9_000;
const WINDOW_MAX_TOKENS = 12_000;
const WINDOW_HARD_MAX = 16;
const DEFAULT_BOOK_BRIEF = {
  shortSummary: "Книга проходит расширенный semantic scan.",
  fullSummary: "Core книги ещё собирается. Подробный обзор появится после завершения merge и profile stage.",
  spoilerSummary: "Core книги ещё собирается. Подробный обзор появится после завершения merge и profile stage.",
};

const LooseProfileBatchInputSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { items: input } : input),
  z.object({
    items: z.array(z.unknown()).max(MAX_CHARACTERS),
  })
);
const CharacterProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    role: z.string().trim().max(220).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    arc: z.string().trim().min(1).max(900).optional(),
    motivations: z.array(z.string().trim().min(1).max(220)).max(6).optional(),
    degraded: z.boolean().optional(),
  })
  .passthrough();
const ThemeProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    development: z.string().trim().min(1).max(900).optional(),
    degraded: z.boolean().optional(),
  })
  .passthrough();
const LocationProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    significance: z.string().trim().min(1).max(900).optional(),
    degraded: z.boolean().optional(),
  })
  .passthrough();
const GroupProfilePatchSchema = z
  .object({
    id: z.string().trim().min(1).max(80).optional(),
    normalizedName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(900).optional(),
    significance: z.string().trim().min(1).max(900).optional(),
    degraded: z.boolean().optional(),
  })
  .passthrough();
const CharacterBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(CharacterProfilePatchSchema).max(MAX_CHARACTERS),
  })
);
const ThemeBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(ThemeProfilePatchSchema).max(MAX_THEMES),
  })
);
const LocationBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(LocationProfilePatchSchema).max(MAX_LOCATIONS),
  })
);
const GroupBatchSchema = LooseProfileBatchInputSchema.pipe(
  z.object({
    items: z.array(GroupProfilePatchSchema).max(MAX_GROUPS),
  })
);
const QuoteMentionRefinementMentionSchema = z
  .object({
    kind: z.enum(BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS),
    value: z.string().trim().min(1).max(160),
    candidateCanonicalName: z.string().trim().min(1).max(160).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
const QuoteMentionRefinementItemSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(80),
    mentions: z.array(QuoteMentionRefinementMentionSchema).max(16).default([]),
  })
  .passthrough();
const QuoteMentionRefinementBatchSchema = z.preprocess(
  (input) => {
    if (Array.isArray(input)) return { items: input };
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.items)) return { items: record.items };
    if (Array.isArray(record.quotes)) return { items: record.quotes };
    return input;
  },
  z.object({
    items: z.array(QuoteMentionRefinementItemSchema).max(QUOTE_MENTION_BATCH_SIZE),
  })
);
const RelationRefinementItemSchema = z
  .object({
    fromValue: z.string().trim().min(1).max(160),
    toValue: z.string().trim().min(1).max(160),
    rawTypeLabel: z.string().trim().min(1).max(120),
    facet: z.enum(BOOK_EXPERT_CORE_RELATION_FACETS).nullable().optional(),
    facetConfidence: z.number().min(0).max(1).nullable().optional(),
    summary: z.string().trim().min(1).max(500),
    chapterFrom: z.number().int().min(1),
    chapterTo: z.number().int().min(1),
    quoteIds: z.array(z.string().trim().min(1).max(80)).max(12).optional().default([]),
    snippet: z.string().trim().min(1).max(280),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
const RelationRefinementBatchSchema = z.preprocess(
  (input) => {
    if (Array.isArray(input)) return { items: input };
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.items)) return { items: record.items };
    if (Array.isArray(record.relations)) return { items: record.relations };
    return input;
  },
  z.object({
    items: z.array(RelationRefinementItemSchema).max(24),
  })
);
const EntityMentionRefinementItemSchema = z
  .object({
    entityId: z.string().trim().min(1).max(80),
    chapterOrderIndex: z.number().int().min(1),
    paragraphOrderInChapter: z.number().int().min(1),
    surfaceForm: z.string().trim().min(1).max(160),
    occurrenceIndex: z.number().int().min(1).max(16).optional().default(1),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
const EntityMentionRefinementBatchSchema = z.preprocess(
  (input) => {
    if (Array.isArray(input)) return { items: input };
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.items)) return { items: record.items };
    if (Array.isArray(record.mentions)) return { items: record.mentions };
    return input;
  },
  z.object({
    items: z.array(EntityMentionRefinementItemSchema).max(ENTITY_MENTION_BATCH_SIZE * 6),
  })
);
const RefLinkItemSchema = z
  .object({
    refId: z.string().trim().min(1).max(160),
    candidateCanonicalName: z.string().trim().min(1).max(160).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
const RefLinkBatchSchema = z.preprocess(
  (input) => {
    if (Array.isArray(input)) return { items: input };
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.items)) return { items: record.items };
    if (Array.isArray(record.refs)) return { items: record.refs };
    return input;
  },
  z.object({
    items: z.array(RefLinkItemSchema).max(REF_LINK_BATCH_SIZE),
  })
);

const LiteraryPatternSchema = z.object({
  patterns: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(180),
        summary: z.string().trim().min(1).max(400),
        evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
      })
    )
    .min(1)
    .max(12),
  centralTension: z.string().trim().min(1).max(500),
  interpretiveLens: z.string().trim().min(1).max(500),
});

const LooseLiteraryPatternSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { patterns: input } : input),
  z
    .object({
      patterns: z
        .array(
          z.union([
            z.string().trim().min(1).max(400),
            z
              .object({
                name: z.string().trim().min(1).max(180).optional(),
                title: z.string().trim().min(1).max(180).optional(),
                label: z.string().trim().min(1).max(180).optional(),
                summary: z.string().trim().min(1).max(400).optional(),
                description: z.string().trim().min(1).max(400).optional(),
                evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(8).optional().default([]),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      centralTension: z.string().trim().max(500).optional().default(""),
      interpretiveLens: z.string().trim().max(500).optional().default(""),
    })
    .passthrough()
);

const LooseLiterarySectionPatchSchema = z
  .object({
    key: BookExpertCoreLiterarySectionKeySchema.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
    bodyMarkdown: z.string().trim().min(1).max(6000).optional(),
    bullets: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    confidence: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();

const LiterarySectionsResultSchema = z.object({
  sections: z.object(
    Object.fromEntries(
      BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.map((key) => [key, BookExpertCoreLiterarySectionSchema])
    ) as Record<string, typeof BookExpertCoreLiterarySectionSchema>
  ),
});

const LooseLiterarySectionsResultSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if ("sections" in record) return input;
    return { sections: record };
  },
  z
    .object({
      sections: z.union([
        z.record(z.string(), LooseLiterarySectionPatchSchema),
        z.array(LooseLiterarySectionPatchSchema),
      ]),
    })
    .passthrough()
);

const LooseWindowScanNumberSchema = z.union([z.number(), z.string()]).optional().nullable();
const LooseWindowScanStringArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(z.string().trim().min(1).max(200)).max(16).optional().default([])
);
const LooseIncidentParticipantSchema = z.union([
  z.string().trim().min(1).max(200),
  z
    .object({
      kind: z.string().trim().min(1).max(40).optional(),
      value: z.string().trim().min(1).max(160).optional(),
      name: z.string().trim().min(1).max(160).optional(),
      normalizedValue: z.string().trim().min(1).max(160).optional(),
      role: z.string().trim().min(1).max(120).optional(),
    })
    .passthrough(),
]);
const LooseIncidentFactsSchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z
    .array(
      z.union([
        z.string().trim().min(1).max(260),
        z
          .object({
            fact: z.string().trim().min(1).max(260).optional(),
            text: z.string().trim().min(1).max(260).optional(),
            summary: z.string().trim().min(1).max(260).optional(),
            label: z.string().trim().min(1).max(260).optional(),
          })
          .passthrough(),
      ])
    )
    .max(12)
    .optional()
    .default([])
);

const LooseIncidentParticipantArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(LooseIncidentParticipantSchema).max(16).optional().default([])
);

const LooseIncidentQuoteArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(z.string().trim().min(1).max(1200)).max(8).optional().default([])
);

const LooseGroupMemberSchema = z.union([
  z.string().trim().min(1).max(160),
  z
    .object({
      name: z.string().trim().min(1).max(160).optional(),
      normalizedName: z.string().trim().min(1).max(160).optional(),
      role: z.string().trim().min(1).max(160).optional(),
    })
    .passthrough(),
]);

const LooseGroupMemberArraySchema = z.preprocess(
  (input) => {
    if (input == null) return [];
    if (Array.isArray(input)) return input;
    return [input];
  },
  z.array(LooseGroupMemberSchema).max(16).optional().default([])
);

const LooseRelationCandidateSchema = z.union([
  z.string().trim().min(1).max(260),
  z
    .object({
      fromName: z.string().trim().min(1).max(160).optional(),
      from: z.string().trim().min(1).max(160).optional(),
      fromNormalizedName: z.string().trim().min(1).max(160).optional(),
      toName: z.string().trim().min(1).max(160).optional(),
      to: z.string().trim().min(1).max(160).optional(),
      toNormalizedName: z.string().trim().min(1).max(160).optional(),
      type: z.string().trim().min(1).max(60).optional(),
      summary: z.string().trim().min(1).max(500).optional(),
      chapterFrom: LooseWindowScanNumberSchema,
      chapterTo: LooseWindowScanNumberSchema,
      chapterOrderIndex: LooseWindowScanNumberSchema,
      confidence: LooseWindowScanNumberSchema,
      supportingQuoteTexts: LooseIncidentQuoteArraySchema,
      snippet: z.string().trim().min(1).max(280).optional(),
    })
    .passthrough(),
]);

const WindowScanModelOutputSchema = z.preprocess(
  (input) => (Array.isArray(input) ? { plotPoints: input } : input),
  z
    .object({
      summary: z.string().trim().max(900).optional().default(""),
      plotPoints: z
        .array(
          z.union([
            z.string().trim().min(1).max(500),
            z
              .object({
                label: z.string().trim().min(1).max(180).optional(),
                name: z.string().trim().min(1).max(180).optional(),
                summary: z.string().trim().min(1).max(500).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      characters: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                aliases: LooseWindowScanStringArraySchema,
                roleHint: z.string().trim().min(1).max(240).optional(),
                role: z.string().trim().min(1).max(240).optional(),
                traits: LooseWindowScanStringArraySchema,
                motivations: LooseWindowScanStringArraySchema,
                arcHint: z.string().trim().min(1).max(320).optional(),
                arc: z.string().trim().min(1).max(320).optional(),
                description: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      themes: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                label: z.string().trim().min(1).max(160).optional(),
                description: z.string().trim().min(1).max(260).optional(),
                developmentHint: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      locations: z
        .array(
          z.union([
            z.string().trim().min(1).max(200),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                label: z.string().trim().min(1).max(160).optional(),
                description: z.string().trim().min(1).max(260).optional(),
                significanceHint: z.string().trim().min(1).max(320).optional(),
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      groups: z
        .array(
          z.union([
            z.string().trim().min(1).max(220),
            z
              .object({
                name: z.string().trim().min(1).max(160).optional(),
                aliases: LooseWindowScanStringArraySchema,
                category: z.string().trim().min(1).max(60).optional(),
                description: z.string().trim().min(1).max(260).optional(),
                significanceHint: z.string().trim().min(1).max(320).optional(),
                members: LooseGroupMemberArraySchema,
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      quotes: z
        .array(
          z.union([
            z.string().trim().min(1).max(1200),
            z
              .object({
                chapterOrderIndex: LooseWindowScanNumberSchema,
                startChar: LooseWindowScanNumberSchema,
                endChar: LooseWindowScanNumberSchema,
                text: z.string().trim().min(1).max(1200).optional(),
                quote: z.string().trim().min(1).max(1200).optional(),
                type: z.string().trim().min(1).max(40).optional(),
                tags: z.array(z.string().trim().min(1).max(60)).max(8).optional().default([]),
                commentary: z.string().trim().max(420).nullable().optional().default(null),
                mentions: z
                  .array(
                    z.union([
                      z.string().trim().min(1).max(160),
                      z
                        .object({
                          kind: z.string().trim().min(1).max(40).optional(),
                          value: z.string().trim().min(1).max(160).optional(),
                          name: z.string().trim().min(1).max(160).optional(),
                          normalizedValue: z.string().trim().min(1).max(160).optional(),
                          confidence: LooseWindowScanNumberSchema,
                        })
                        .passthrough(),
                    ])
                  )
                  .max(16)
                  .optional()
                  .default([]),
                confidence: LooseWindowScanNumberSchema,
              })
              .passthrough(),
          ])
        )
        .max(24)
        .optional()
        .default([]),
      incidents: z
        .array(
          z.union([
            z.string().trim().min(1).max(400),
            z
              .object({
                title: z.string().trim().min(1).max(200).optional(),
                label: z.string().trim().min(1).max(200).optional(),
                summary: z.string().trim().min(1).max(260).optional(),
                chapterFrom: LooseWindowScanNumberSchema,
                chapterTo: LooseWindowScanNumberSchema,
                chapterOrderIndex: LooseWindowScanNumberSchema,
                importance: LooseWindowScanNumberSchema,
                participants: LooseIncidentParticipantArraySchema,
                facts: LooseIncidentFactsSchema,
                consequences: LooseIncidentFactsSchema,
                supportingQuoteTexts: LooseIncidentQuoteArraySchema,
                quotes: LooseIncidentQuoteArraySchema,
                snippet: z.string().trim().min(1).max(280).optional(),
              })
              .passthrough(),
          ])
        )
        .max(16)
        .optional()
        .default([]),
      relationCandidates: z
        .array(
          LooseRelationCandidateSchema
        )
        .max(16)
        .optional()
        .default([]),
    })
    .passthrough()
);

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
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampUnitInterval(value: unknown, fallback: number): number {
  const numeric = coerceNumber(value);
  if (numeric === null) return fallback;
  if (numeric >= 0 && numeric <= 1) return numeric;
  if (numeric > 1 && numeric <= 10) return numeric / 10;
  if (numeric > 10 && numeric <= 100) return numeric / 100;
  return fallback;
}

function clampChapterOrderIndex(value: unknown, window: WindowInput): number {
  const numeric = coerceNumber(value);
  if (numeric === null) return window.chapterFrom;
  return Math.max(window.chapterFrom, Math.min(window.chapterTo, Math.round(numeric)));
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Book expert core processing failed";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
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

function dedupeStrings(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const value = compactWhitespace(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function buildVertexAllowedModels(...tiers: Array<"lite" | "flash" | "pro">): string[] {
  return dedupeStrings(
    tiers.map((tier) => workerConfig.vertex.modelByTier[tier]),
    tiers.length
  );
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string, limit: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = compactWhitespace(keyFn(item)).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function hashId(prefix: string, parts: Array<string | number>): string {
  const hash = createHash("sha1")
    .update(parts.map((part) => String(part)).join("|"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${hash}`;
}

type ExactEntityResolution = {
  entityId: string;
  canonicalEntityType: NonNullable<BookExpertCoreSnapshot["quoteBank"][number]["mentions"][number]["canonicalEntityType"]>;
  normalizedValue: string;
};

function buildExactEntityResolutionIndex(snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">) {
  const ownerCounts = new Map<string, Set<string>>();
  const entries = new Map<string, ExactEntityResolution>();

  const registerOwner = (entityId: string, value: string) => {
    const normalizedValue = normalizeEntityName(value);
    if (!normalizedValue) return;
    const owners = ownerCounts.get(normalizedValue) || new Set<string>();
    owners.add(entityId);
    ownerCounts.set(normalizedValue, owners);
  };

  const registerEntity = (
    type: ExactEntityResolution["canonicalEntityType"],
    entity: { id: string; name: string; aliases: string[] }
  ) => {
    for (const value of [entity.name, ...(entity.aliases || [])]) {
      registerOwner(entity.id, value);
    }
  };

  for (const entity of snapshot.characters) registerEntity("character", entity);
  for (const entity of snapshot.themes) registerEntity("theme", entity);
  for (const entity of snapshot.locations) registerEntity("location", entity);
  for (const entity of snapshot.groups) registerEntity("group", entity);

  const addUniqueEntries = (
    type: ExactEntityResolution["canonicalEntityType"],
    entity: { id: string; name: string; aliases: string[] }
  ) => {
    for (const value of [entity.name, ...(entity.aliases || [])]) {
      const normalizedValue = normalizeEntityName(value);
      if (!normalizedValue || (ownerCounts.get(normalizedValue)?.size || 0) !== 1 || entries.has(normalizedValue)) {
        continue;
      }
      entries.set(normalizedValue, {
        entityId: entity.id,
        canonicalEntityType: type,
        normalizedValue,
      });
    }
  };

  for (const entity of snapshot.characters) addUniqueEntries("character", entity);
  for (const entity of snapshot.themes) addUniqueEntries("theme", entity);
  for (const entity of snapshot.locations) addUniqueEntries("location", entity);
  for (const entity of snapshot.groups) addUniqueEntries("group", entity);

  return entries;
}

function createEmptySnapshot(bookId: string): BookExpertCoreSnapshot {
  return {
    version: BOOK_EXPERT_CORE_VERSION,
    bookId,
    completedStages: [],
    timingsMs: {},
    bookBrief: { ...DEFAULT_BOOK_BRIEF },
    plotSpine: [],
    characters: [],
    themes: [],
    locations: [],
    groups: [],
    entityMentionBank: [],
    quoteBank: [],
    incidents: [],
    relationCandidates: [],
    literarySections: null,
    windowScans: [],
    generatedAt: new Date().toISOString(),
  };
}

function mergeCompletedStages(existing: BookExpertCoreStageKey[], next: BookExpertCoreStageKey): BookExpertCoreStageKey[] {
  const out = new Set<BookExpertCoreStageKey>(existing);
  out.add(next);
  return BOOK_EXPERT_CORE_STAGE_KEYS.filter((stage) => out.has(stage));
}

async function readSnapshot(bookId: string): Promise<BookExpertCoreSnapshot | null> {
  const row = await prisma.bookExpertCore.findUnique({
    where: { bookId },
    select: {
      snapshotJson: true,
    },
  });
  if (!row) return null;
  const parsed = BookExpertCoreSnapshotSchema.safeParse(row.snapshotJson);
  return parsed.success ? parsed.data : null;
}

async function saveSnapshot(bookId: string, snapshot: BookExpertCoreSnapshot): Promise<void> {
  await prisma.bookExpertCore.upsert({
    where: { bookId },
    create: {
      bookId,
      version: snapshot.version,
      snapshotJson: snapshot,
      generatedAt: new Date(snapshot.generatedAt),
    },
    update: {
      version: snapshot.version,
      snapshotJson: snapshot,
      generatedAt: new Date(snapshot.generatedAt),
    },
  });
}

async function updateTaskState(params: {
  bookId: string;
  analyzerType: string;
  state: "queued" | "running" | "completed" | "failed";
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  metadataPatch?: Partial<BookAnalyzerTaskMetadata>;
}) {
  const taskKey = {
    bookId_analyzerType: {
      bookId: params.bookId,
      analyzerType: params.analyzerType as any,
    },
  };
  const existing = params.metadataPatch === undefined
    ? null
    : await prisma.bookAnalyzerTask.findUnique({
        where: taskKey,
        select: {
          metadataJson: true,
        },
      });
  const metadataJson =
    params.metadataPatch === undefined
      ? undefined
      : mergeBookAnalyzerTaskMetadata(existing?.metadataJson, params.metadataPatch);

  await prisma.bookAnalyzerTask.upsert({
    where: taskKey,
    create: {
      bookId: params.bookId,
      analyzerType: params.analyzerType as any,
      state: params.state,
      error: params.error || null,
      startedAt: params.startedAt || null,
      completedAt: params.completedAt || null,
      metadataJson: metadataJson ?? Prisma.JsonNull,
    },
    update: {
      state: params.state,
      error: params.error || null,
      startedAt: params.startedAt === undefined ? undefined : params.startedAt,
      completedAt: params.completedAt === undefined ? undefined : params.completedAt,
      metadataJson: metadataJson === undefined ? undefined : (metadataJson ?? Prisma.JsonNull),
    },
  });
}

async function queueNextStage(bookId: string, analyzerType: CoreAnalyzerType): Promise<void> {
  await enqueueBookAnalyzerStage({
    bookId,
    analyzerType,
    publishEvent: true,
  });
}

const CORE_STAGE_DEPENDENCIES: Partial<Record<CoreAnalyzerType, CoreAnalyzerType>> = {
  core_merge: "core_window_scan",
  core_resolve: "core_merge",
  core_entity_mentions: "core_resolve",
  core_profiles: "core_entity_mentions",
  core_quotes_finalize: "core_profiles",
  core_literary: "core_quotes_finalize",
};

async function loadBookSource(bookId: string): Promise<{ book: LoadedBookSource; chapters: ChapterSource[] }> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      fileName: true,
      storageProvider: true,
      storageKey: true,
      createdAt: true,
    },
  });
  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  const format = resolveUploadFormat(book.fileName);
  if (!format) {
    throw new Error(`Unsupported stored book format: ${book.fileName}`);
  }

  const blobStore = resolveBooksBlobStore(book.storageProvider);
  const bytes = await blobStore.get(book.storageKey);
  const parsedBook = ensureParsedBookHasChapters(
    await parseBook({
      format,
      fileName: book.fileName,
      bytes,
      maxZipUncompressedBytes: workerConfig.imports.maxZipUncompressedBytes,
    })
  );

  const chapters = parsedBook.chapters.map((chapter, index) => ({
    orderIndex: index + 1,
    title: resolveChapterTitle(chapter, index + 1),
    rawText: buildPlainTextFromParsedChapter(chapter),
  }));

  return { book, chapters };
}

function mergeMetadataPatch(
  base: Partial<BookAnalyzerTaskMetadata>,
  patch: Partial<BookAnalyzerTaskMetadata>
): Partial<BookAnalyzerTaskMetadata> {
  return {
    ...base,
    ...patch,
    models: patch.models
      ? dedupeStrings([...(base.models || []), ...patch.models], 8)
      : base.models,
  };
}

function registerStrictJsonAttempt(
  current: Partial<BookAnalyzerTaskMetadata>,
  attempt: StrictJsonAttemptLike
): Partial<BookAnalyzerTaskMetadata> {
  return applyStrictJsonAttemptToTaskMetadata(current, attempt);
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(compactWhitespace(value).length / 4));
}

function buildWindowText(chapters: ChapterSource[]): string {
  return chapters.map((item) => `### Глава ${item.orderIndex}: ${item.title}\n${item.rawText}`).join("\n\n");
}

function mergeSmallestAdjacentWindows(windows: WindowInput[]): WindowInput[] {
  if (windows.length <= WINDOW_HARD_MAX) return windows;
  const next = [...windows];
  while (next.length > WINDOW_HARD_MAX) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < next.length - 1; index += 1) {
      const left = next[index];
      const right = next[index + 1];
      const combinedScore = estimateTextTokens(left.text) + estimateTextTokens(right.text);
      if (combinedScore < bestScore) {
        bestScore = combinedScore;
        bestIndex = index;
      }
    }
    const mergedChapters = [...next[bestIndex].chapters, ...next[bestIndex + 1].chapters];
    const text = buildWindowText(mergedChapters);
    next.splice(bestIndex, 2, {
      windowIndex: bestIndex + 1,
      chapterFrom: mergedChapters[0].orderIndex,
      chapterTo: mergedChapters[mergedChapters.length - 1].orderIndex,
      chapters: mergedChapters,
      text,
      textChars: text.length,
    });
  }
  return next.map((window, index) => ({
    ...window,
    windowIndex: index + 1,
  }));
}

function chunkChaptersIntoWindows(chapters: ChapterSource[]): WindowInput[] {
  const nonEmpty = chapters.filter((chapter) => compactWhitespace(chapter.rawText));
  if (!nonEmpty.length) return [];

  const chapterTokens = nonEmpty.map((chapter) => ({
    chapter,
    tokens: estimateTextTokens(chapter.rawText),
  }));
  const totalTokens = chapterTokens.reduce((sum, item) => sum + item.tokens, 0);
  const desiredWindowCount = Math.max(4, Math.min(12, Math.round(totalTokens / WINDOW_TARGET_TOKENS)));
  const targetTokens = Math.max(4_500, Math.ceil(totalTokens / Math.max(1, desiredWindowCount)));

  const windows: WindowInput[] = [];
  let bucket: ChapterSource[] = [];
  let bucketTokens = 0;

  for (const { chapter, tokens } of chapterTokens) {
    const chapterText = compactWhitespace(chapter.rawText);
    if (!chapterText) continue;

    const nextTokens = bucketTokens + tokens;
    const shouldFlush =
      bucket.length > 0 &&
      (nextTokens > WINDOW_MAX_TOKENS || (bucketTokens >= targetTokens && windows.length + 1 < desiredWindowCount));

    if (shouldFlush) {
      const chapterFrom = bucket[0].orderIndex;
      const chapterTo = bucket[bucket.length - 1].orderIndex;
      const text = buildWindowText(bucket);
      windows.push({
        windowIndex: windows.length + 1,
        chapterFrom,
        chapterTo,
        chapters: bucket,
        text,
        textChars: text.length,
      });
      bucket = [];
      bucketTokens = 0;
    }

    bucket.push(chapter);
    bucketTokens += tokens;
  }

  if (bucket.length > 0) {
    const chapterFrom = bucket[0].orderIndex;
    const chapterTo = bucket[bucket.length - 1].orderIndex;
    const text = buildWindowText(bucket);
    windows.push({
      windowIndex: windows.length + 1,
      chapterFrom,
      chapterTo,
      chapters: bucket,
      text,
      textChars: text.length,
    });
  }

  return mergeSmallestAdjacentWindows(windows).map((window, index) => ({
    ...window,
    windowIndex: index + 1,
  }));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];

  const out = new Array<R>(items.length);
  const safeConcurrency = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await worker(items[index], index);
      }
    })
  );

  return out;
}

function buildWindowScanPrompt(book: LoadedBookSource, window: WindowInput): string {
  return [
    `Книга: ${book.title}${book.author ? ` (${book.author})` : ""}`,
    `Окно: главы ${window.chapterFrom}-${window.chapterTo}`,
    "",
    "Верни один JSON-объект для этого окна книги.",
    "Требования:",
    "1. Используй только материал окна.",
    "2. summary опиши как короткий смысловой снимок этого окна.",
    "3. plotPoints — только реально важные события или повороты.",
    "4. characters/themes/locations — только сущности, которые реально значимы в этом окне.",
    "5. groups — семьи, дома, команды, институции и другие устойчивые коллективы, если они реально представлены в окне.",
    "5a. aliases добавляй только если этот вариант имени или названия прямо встречается в тексте окна.",
    "5b. Для groups заполняй rawKindLabel свободной меткой из текста, а facet указывай только если тип группы явно понятен из окна.",
    "5c. Для groups members перечисляй только явно названных участников окна. Не додумывай состав группы.",
    "6. relationCandidates — только явные связи между сущностями окна; не выводи их по общему знанию о книге.",
    "6a. Для relationCandidates сохраняй rawTypeLabel как свободную метку связи, а facet указывай только если тип связи явно выражен в тексте окна.",
    "7. quotes — только сильные фрагменты, полезные для будущего expert-chat. Не более 24.",
    "7a. Для quotes указывай mentions: какие персонажи, темы или локации прямо названы внутри самой цитаты.",
    "8. incidents — важные сцены или эпизоды этого окна, где есть понятная причинно-следственная цепочка.",
    "9. У incident нужны title, participants, facts, consequences и snippet. facts должны идти по порядку.",
    "10. Для chapterOrderIndex/chapterFrom/chapterTo используй реальные номера глав из окна.",
    "11. Не возвращай windowIndex, textChars: эти поля проставит система.",
    "12. Не придумывай startChar/endChar: если не уверен, верни null.",
    "13. Если для сущности или incident не хватает деталей, дай короткий объект, но не превращай весь ответ в массив строк.",
    "14. Корневой JSON должен быть объектом с ключами summary, plotPoints, characters, themes, locations, groups, quotes, incidents, relationCandidates.",
    "15. Предпочитай компактность и точность, а не полноту любой ценой.",
    "16. relationCandidates возвращай массивом объектов, а не строк. У объекта нужны fromRef, toRef, rawTypeLabel, summary; facet опционален.",
    "",
    "Минимальная форма объекта:",
    '{"summary":"...","plotPoints":[],"characters":[],"themes":[],"locations":[],"groups":[{"name":"...","rawKindLabel":"...","facet":null,"members":[]}],"quotes":[],"incidents":[],"relationCandidates":[{"fromRef":{"value":"...","normalizedValue":"...","confidence":0.8},"toRef":{"value":"...","normalizedValue":"...","confidence":0.8},"rawTypeLabel":"...","facet":null,"summary":"..."}]}',
    "",
    "Текст окна:",
    window.text,
  ].join("\n");
}

function scoreSnippetRelevance(text: string, query: string): number {
  const haystack = normalizeEntityName(text);
  const needles = dedupeStrings(query.split(/\s+/g), 12).map((item) => normalizeEntityName(item)).filter(Boolean);
  if (!needles.length) return 0;
  let score = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) score += needle.length > 4 ? 2 : 1;
  }
  return score;
}

function buildWindowSource(window: BookExpertCoreWindowScan): { windowIndex: number; chapterFrom: number; chapterTo: number; chapterCount: number; textChars: number } {
  return {
    windowIndex: window.windowIndex,
    chapterFrom: window.chapterFrom,
    chapterTo: window.chapterTo,
    chapterCount: Math.max(1, window.chapterTo - window.chapterFrom + 1),
    textChars: window.textChars,
  };
}

function mergeWindowScans(
  bookId: string,
  windowScans: BookExpertCoreWindowScan[]
): Pick<
  BookExpertCoreSnapshot,
  "bookBrief" | "plotSpine" | "characters" | "themes" | "locations" | "groups" | "quoteBank" | "incidents" | "relationCandidates"
> {
  const summaryBits = dedupeStrings(windowScans.map((window) => window.summary), 12);

  const plotPointMap = new Map<string, BookExpertCoreSnapshot["plotSpine"][number]>();
  const characterMap = new Map<string, CandidateEntityAggregate>();
  const themeMap = new Map<string, CandidateEntityAggregate>();
  const locationMap = new Map<string, CandidateEntityAggregate>();
  const groupMap = new Map<string, CandidateEntityAggregate>();
  const quoteMap = new Map<string, BookExpertCoreSnapshot["quoteBank"][number]>();
  const incidentMap = new Map<string, BookExpertCoreIncident>();
  const incidentSupportingQuotes = new Map<string, string[]>();
  const relationMap = new Map<string, RelationCandidateAggregate>();

  const pushAnchor = (target: CandidateEntityAggregate, chapterOrderIndex: number, snippet: string, windowIndex: number) => {
    if (target.anchors.length < 4) {
      target.anchors.push({
        chapterOrderIndex,
        snippet: clampText(snippet, 220),
      });
    }
    target.sourceWindows.add(windowIndex);
  };

  const mergeEntity = (
    map: Map<string, CandidateEntityAggregate>,
    raw: {
      name: string;
      aliases?: string[];
      rawKindLabel?: string | null;
      facet?: (typeof BOOK_EXPERT_CORE_GROUP_FACETS)[number] | null;
      facetConfidence?: number | null;
      roleHint?: string;
      description?: string;
      developmentHint?: string;
      significanceHint?: string;
      arcHint?: string;
      motivations?: string[];
      traits?: string[];
      members?: Array<{ value: string; normalizedValue: string; role: string; confidence: number }>;
      chapterOrderIndex: number;
      snippet: string;
    },
    windowIndex: number,
    kind: "character" | "theme" | "location" | "group"
  ) => {
    const normalizedName = normalizeEntityName(raw.name);
    if (!normalizedName) return;

    const existing =
      map.get(normalizedName) ||
      ({
        normalizedName,
        name: compactWhitespace(raw.name),
        category: kind,
        aliases: new Set<string>(),
        mentionCount: 0,
        firstAppearanceChapterOrder: null,
        descriptionHints: [],
        roleHints: [],
        arcHints: [],
        motivationHints: [],
        significanceHints: [],
        memberHints: [],
        rawKindLabels: [],
        facetHints: [],
        anchors: [],
        sourceWindows: new Set<number>(),
      } satisfies CandidateEntityAggregate);

    existing.mentionCount += 1;
    existing.firstAppearanceChapterOrder =
      existing.firstAppearanceChapterOrder === null
        ? raw.chapterOrderIndex
        : Math.min(existing.firstAppearanceChapterOrder, raw.chapterOrderIndex);
    for (const alias of raw.aliases || []) {
      const value = compactWhitespace(alias);
      if (value) existing.aliases.add(value);
    }
    const descriptionHint =
      kind === "theme"
        ? raw.description || raw.developmentHint || ""
        : kind === "location"
          ? raw.description || raw.significanceHint || ""
          : kind === "group"
            ? raw.description || raw.significanceHint || raw.roleHint || ""
          : raw.description || raw.roleHint || raw.arcHint || "";
    if (descriptionHint) existing.descriptionHints.push(clampText(descriptionHint, 260));
    if (raw.roleHint) existing.roleHints.push(clampText(raw.roleHint, 180));
    if (raw.arcHint) existing.arcHints.push(clampText(raw.arcHint, 220));
    for (const item of raw.motivations || raw.traits || []) {
      const normalized = clampText(item, 160);
      if (normalized) existing.motivationHints.push(normalized);
    }
    if (raw.significanceHint) existing.significanceHints.push(clampText(raw.significanceHint, 220));
    if (kind === "group") {
      const rawKindLabel = compactWhitespace(raw.rawKindLabel || "");
      if (rawKindLabel) existing.rawKindLabels.push(clampText(rawKindLabel, 120));
      if (raw.facet) {
        existing.facetHints.push({
          facet: raw.facet,
          confidence: raw.facetConfidence ?? 0.7,
        });
      }
      for (const member of raw.members || []) {
        const normalizedMemberName = normalizeEntityName(member.normalizedValue || member.value);
        const memberName = compactWhitespace(member.value);
        const role = clampText(member.role || "member", 160);
        if (!normalizedMemberName || !memberName) continue;
        if (!existing.memberHints.some((item) => item.normalizedValue === normalizedMemberName && item.role === role)) {
          existing.memberHints.push({
            normalizedValue: normalizedMemberName,
            value: memberName,
            role,
            confidence: member.confidence,
          });
        }
      }
    }
    pushAnchor(existing, raw.chapterOrderIndex, raw.snippet, windowIndex);
    map.set(normalizedName, existing);
  };

  for (const window of windowScans) {
    const windowSource = buildWindowSource(window);

    for (const plotPoint of window.plotPoints) {
      const key = `${plotPoint.chapterOrderIndex}:${normalizeEntityName(plotPoint.label)}`;
      const existing = plotPointMap.get(key);
      if (!existing) {
        plotPointMap.set(key, {
          id: hashId("plot", [bookId, key]),
          label: clampText(plotPoint.label, 180),
          summary: clampText(plotPoint.summary, 360),
          chapterOrderIndex: plotPoint.chapterOrderIndex,
          importance: plotPoint.importance,
          anchors: [
            {
              chapterOrderIndex: plotPoint.chapterOrderIndex,
              startChar: null,
              endChar: null,
              snippet: clampText(plotPoint.snippet, 220),
            },
          ],
          sourceWindows: [windowSource],
        });
        continue;
      }

      existing.importance = Math.max(existing.importance, plotPoint.importance);
      if (existing.anchors.length < 4) {
        existing.anchors.push({
          chapterOrderIndex: plotPoint.chapterOrderIndex,
          startChar: null,
          endChar: null,
          snippet: clampText(plotPoint.snippet, 220),
        });
      }
      if (existing.sourceWindows.length < 4) {
        existing.sourceWindows.push(windowSource);
      }
      if (existing.summary.length < plotPoint.summary.length) {
        existing.summary = clampText(plotPoint.summary, 360);
      }
    }

    for (const character of window.characters) {
      mergeEntity(characterMap, character, window.windowIndex, "character");
    }
    for (const theme of window.themes) {
      mergeEntity(themeMap, theme, window.windowIndex, "theme");
    }
    for (const location of window.locations) {
      mergeEntity(locationMap, location, window.windowIndex, "location");
    }
    for (const group of window.groups || []) {
      mergeEntity(
        groupMap,
        {
          name: group.name,
          aliases: group.aliases,
          rawKindLabel: group.rawKindLabel,
          facet: group.facet,
          facetConfidence: group.facetConfidence,
          description: group.description,
          significanceHint: group.significanceHint,
          members: group.members.map((member) => ({
            normalizedValue: member.normalizedValue,
            value: member.value,
            role: member.role,
            confidence: member.confidence,
          })),
          chapterOrderIndex: group.chapterOrderIndex,
          snippet: group.snippet,
        },
        window.windowIndex,
        "group"
      );
    }

    for (const quote of window.quotes) {
      const normalizedText = normalizeEntityName(quote.text).slice(0, 280);
      if (!normalizedText) continue;
      const key = `${quote.chapterOrderIndex}:${normalizedText}`;
      const existing = quoteMap.get(key);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, quote.confidence);
        existing.tags = dedupeStrings([...existing.tags, ...(quote.tags || [])], 8) as typeof existing.tags;
        const mentions = [...existing.mentions, ...quote.mentions].sort((left, right) => right.confidence - left.confidence);
        const dedupedMentions = new Map<string, typeof mentions[number]>();
        for (const mention of mentions) {
          const mentionKey = `${mention.kind}:${mention.normalizedValue}`;
          if (!dedupedMentions.has(mentionKey)) {
            dedupedMentions.set(mentionKey, mention);
          }
        }
        existing.mentions = Array.from(dedupedMentions.values()).slice(0, 16);
        continue;
      }

      quoteMap.set(key, {
        id: hashId("quote", [bookId, key]),
        chapterOrderIndex: quote.chapterOrderIndex,
        startChar: typeof quote.startChar === "number" ? Math.max(0, quote.startChar) : 0,
        endChar:
          typeof quote.endChar === "number" && quote.endChar > Number(quote.startChar || 0)
            ? quote.endChar
            : Math.max(1, clampText(quote.text, 1200).length),
        text: clampText(quote.text, 1200),
        type: quote.type,
        tags: dedupeStrings(quote.tags || [], 8) as typeof quote.tags,
        commentary: quote.commentary ? clampText(quote.commentary, 420) : null,
        confidence: quote.confidence,
        mentions: (quote.mentions || []).slice(0, 16),
        anchors: [
          {
            chapterOrderIndex: quote.chapterOrderIndex,
            startChar: typeof quote.startChar === "number" ? Math.max(0, quote.startChar) : null,
            endChar: typeof quote.endChar === "number" ? Math.max(0, quote.endChar) : null,
            snippet: clampText(quote.text, 220),
          },
        ],
        sourceWindows: [windowSource],
      });
    }

    for (const incident of window.incidents) {
      const titleKey = normalizeEntityName(incident.title);
      const factKey = normalizeEntityName(incident.facts[0] || incident.snippet).slice(0, 220);
      const key = `${incident.chapterFrom}:${incident.chapterTo}:${titleKey || factKey}`;
      const existing = incidentMap.get(key);
      const anchor = {
        chapterOrderIndex: incident.chapterFrom,
        startChar: null,
        endChar: null,
        snippet: clampText(incident.snippet, 220),
      };
      const participants = dedupeBy(
        incident.participants.map((participant) => ({
          ...participant,
          entityId: null,
        })),
        (participant) => `${participant.kind}:${participant.normalizedValue}:${participant.role}`,
        12
      );

      if (!existing) {
        incidentMap.set(key, {
          id: hashId("incident", [bookId, key]),
          title: clampText(incident.title, 200),
          chapterFrom: incident.chapterFrom,
          chapterTo: incident.chapterTo,
          importance: incident.importance,
          participants,
          facts: dedupeStrings(incident.facts, 10),
          consequences: dedupeStrings(incident.consequences, 8),
          quoteIds: [],
          anchors: [anchor],
          sourceWindows: [windowSource],
        });
        incidentSupportingQuotes.set(key, dedupeStrings(incident.supportingQuoteTexts || [], 8));
        continue;
      }

      existing.importance = Math.max(existing.importance, incident.importance);
      existing.chapterFrom = Math.min(existing.chapterFrom, incident.chapterFrom);
      existing.chapterTo = Math.max(existing.chapterTo, incident.chapterTo);
      existing.facts = dedupeStrings([...existing.facts, ...incident.facts], 10);
      existing.consequences = dedupeStrings([...existing.consequences, ...incident.consequences], 8);
      existing.participants = dedupeBy(
        [...existing.participants, ...participants],
        (participant) => `${participant.kind}:${participant.normalizedValue}:${participant.role}`,
        12
      );
      if (existing.anchors.length < 4) {
        existing.anchors.push(anchor);
      }
      if (existing.sourceWindows.length < 6) {
        existing.sourceWindows.push(windowSource);
      }
      incidentSupportingQuotes.set(
        key,
        dedupeStrings([...(incidentSupportingQuotes.get(key) || []), ...(incident.supportingQuoteTexts || [])], 8)
      );
    }

    for (const relation of window.relationCandidates || []) {
      const key = [
        normalizeEntityName(relation.fromRef.normalizedValue || relation.fromRef.value),
        normalizeEntityName(relation.toRef.normalizedValue || relation.toRef.value),
        relation.rawTypeLabel,
        relation.chapterFrom,
        relation.chapterTo,
      ].join(":");
      if (!key) continue;
      const anchor = {
        chapterOrderIndex: relation.chapterFrom,
        snippet: clampText(relation.snippet, 220),
      };
      const existing = relationMap.get(key);
      if (!existing) {
        relationMap.set(key, {
          id: hashId("relation_candidate", [bookId, key]),
          fromRef: {
            value: clampText(relation.fromRef.value, 160),
            normalizedValue: relation.fromRef.normalizedValue,
            candidateCanonicalName: relation.fromRef.candidateCanonicalName || null,
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: relation.fromRef.confidence,
          },
          toRef: {
            value: clampText(relation.toRef.value, 160),
            normalizedValue: relation.toRef.normalizedValue,
            candidateCanonicalName: relation.toRef.candidateCanonicalName || null,
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: relation.toRef.confidence,
          },
          rawTypeLabel: clampText(relation.rawTypeLabel, 120),
          facet: relation.facet,
          facetConfidence: relation.facetConfidence,
          summary: clampText(relation.summary, 900),
          confidence: relation.confidence,
          chapterFrom: relation.chapterFrom,
          chapterTo: relation.chapterTo,
          quoteTexts: dedupeStrings(relation.supportingQuoteTexts || [], 8),
          anchors: [anchor],
          sourceWindows: [windowSource],
        });
        continue;
      }
      existing.summary = clampText([existing.summary, relation.summary].join(" "), 900);
      existing.confidence = Math.max(existing.confidence, relation.confidence);
      existing.chapterFrom = Math.min(existing.chapterFrom, relation.chapterFrom);
      existing.chapterTo = Math.max(existing.chapterTo, relation.chapterTo);
      existing.facet = existing.facet || relation.facet;
      existing.facetConfidence = existing.facetConfidence ?? relation.facetConfidence ?? null;
      existing.quoteTexts = dedupeStrings([...existing.quoteTexts, ...(relation.supportingQuoteTexts || [])], 8);
      if (existing.anchors.length < 4) existing.anchors.push(anchor);
      if (existing.sourceWindows.length < 6) existing.sourceWindows.push(windowSource);
    }
  }

  const toSourceWindows = (entry: CandidateEntityAggregate) =>
    Array.from(entry.sourceWindows)
      .sort((left, right) => left - right)
      .slice(0, 6)
      .map((windowIndex) => ({ windowIndex, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 0 }));

  const toCharacterCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("character", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 12),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    profileDegraded: false,
    role: clampText(entry.roleHints[0] || "Ключевой участник сюжетной линии", 180),
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    arc: clampText(dedupeStrings(entry.arcHints, 3).join(" ") || dedupeStrings(entry.descriptionHints, 2).join(" ") || entry.name, 600),
    motivations: dedupeStrings(entry.motivationHints, 6),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: toSourceWindows(entry),
  });

  const toThemeCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("theme", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 8),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    profileDegraded: false,
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    development: clampText(dedupeStrings([...entry.descriptionHints, ...entry.arcHints], 4).join(" ") || entry.name, 600),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: toSourceWindows(entry),
  });

  const toLocationCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("location", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 8),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    profileDegraded: false,
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    significance: clampText(dedupeStrings([...entry.significanceHints, ...entry.descriptionHints], 4).join(" ") || entry.name, 600),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: toSourceWindows(entry),
  });

  const toGroupCard = (entry: CandidateEntityAggregate) => ({
    id: hashId("group", [bookId, entry.normalizedName]),
    name: entry.name,
    normalizedName: entry.normalizedName,
    aliases: dedupeStrings([...entry.aliases], 8),
    mentionCount: entry.mentionCount,
    firstAppearanceChapterOrder: entry.firstAppearanceChapterOrder,
    profileDegraded: false,
    rawKindLabel: entry.rawKindLabels[0] || null,
    facet: entry.facetHints[0]?.facet || null,
    facetConfidence: entry.facetHints[0]?.confidence ?? null,
    description: clampText(dedupeStrings(entry.descriptionHints, 3).join(" ") || entry.name, 600),
    significance: clampText(dedupeStrings([...entry.significanceHints, ...entry.descriptionHints], 4).join(" ") || entry.name, 600),
    members: dedupeBy(entry.memberHints, (item) => `${item.normalizedValue}:${item.role}`, 16).map((item) => ({
      value: item.value,
      normalizedValue: item.normalizedValue,
      candidateCanonicalName: null,
      role: item.role,
      confidence: item.confidence,
      entityId: null,
      canonicalEntityType: null,
      resolutionStatus: "unresolved" as const,
    })),
    anchors: entry.anchors.slice(0, 4).map((anchor) => ({
      chapterOrderIndex: anchor.chapterOrderIndex,
      startChar: null,
      endChar: null,
      snippet: anchor.snippet,
    })),
    sourceWindows: toSourceWindows(entry),
  });

  const plotSpine = Array.from(plotPointMap.values())
    .sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex || right.importance - left.importance)
    .slice(0, MAX_PLOT_POINTS);

  const characters = Array.from(characterMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_CHARACTERS)
    .map(toCharacterCard);

  const themes = Array.from(themeMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_THEMES)
    .map(toThemeCard);

  const locations = Array.from(locationMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_LOCATIONS)
    .map(toLocationCard);

  const groups = Array.from(groupMap.values())
    .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name, "ru"))
    .slice(0, MAX_GROUPS)
    .map(toGroupCard);

  const quoteBank = Array.from(quoteMap.values())
    .sort((left, right) => right.confidence - left.confidence || left.chapterOrderIndex - right.chapterOrderIndex)
    .slice(0, MAX_QUOTES);

  const quoteTextIndex = quoteBank.map((quote) => ({
    id: quote.id,
    chapterOrderIndex: quote.chapterOrderIndex,
    normalizedText: normalizeEntityName(quote.text).slice(0, 320),
  }));
  const incidents = Array.from(incidentMap.entries())
    .map(([key, incident]) => {
      const supportingQuotes = incidentSupportingQuotes.get(key) || [];
      const normalizedSupports = supportingQuotes.map((value) => normalizeEntityName(value)).filter(Boolean);
      const quoteIds = dedupeStrings(
        quoteTextIndex
          .filter((quote) => quote.chapterOrderIndex >= incident.chapterFrom && quote.chapterOrderIndex <= incident.chapterTo)
          .filter((quote) =>
            normalizedSupports.length === 0
              ? incident.anchors.some((anchor) => normalizeEntityName(anchor.snippet).includes(quote.normalizedText.slice(0, 160)))
              : normalizedSupports.some(
                  (support) => quote.normalizedText.includes(support) || support.includes(quote.normalizedText)
                )
          )
          .map((quote) => quote.id),
        12
      );

      return BookExpertCoreIncidentSchema.parse({
        ...incident,
        quoteIds,
        sourceWindows: incident.sourceWindows
          .sort((left, right) => left.windowIndex - right.windowIndex)
          .slice(0, 6),
      });
    })
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance;
      if (left.chapterFrom !== right.chapterFrom) return left.chapterFrom - right.chapterFrom;
      return left.title.localeCompare(right.title, "ru");
    })
    .slice(0, MAX_INCIDENTS);

  const relationCandidates = Array.from(relationMap.values())
    .map((relation) => {
      const normalizedSupports = relation.quoteTexts.map((value) => normalizeEntityName(value)).filter(Boolean);
      const quoteIds = dedupeStrings(
        quoteTextIndex
          .filter((quote) => quote.chapterOrderIndex >= relation.chapterFrom && quote.chapterOrderIndex <= relation.chapterTo)
          .filter((quote) =>
            normalizedSupports.length === 0
              ? relation.anchors.some((anchor) => normalizeEntityName(anchor.snippet).includes(quote.normalizedText.slice(0, 160)))
              : normalizedSupports.some(
                  (support) => quote.normalizedText.includes(support) || support.includes(quote.normalizedText)
                )
          )
          .map((quote) => quote.id),
        12
      );

      return BookExpertCoreRelationCandidateSchema.parse({
        ...relation,
        quoteIds,
        sourceWindows: relation.sourceWindows
          .sort((left, right) => left.windowIndex - right.windowIndex)
          .slice(0, 6),
        anchors: relation.anchors.map((anchor) => ({
          chapterOrderIndex: anchor.chapterOrderIndex,
          startChar: null,
          endChar: null,
          snippet: anchor.snippet,
        })),
      });
    })
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (left.chapterFrom !== right.chapterFrom) return left.chapterFrom - right.chapterFrom;
      return left.summary.localeCompare(right.summary, "ru");
    })
    .slice(0, 48);

  const plotSummaries = plotSpine.slice(0, 6).map((item) => item.summary);
  const bookBrief = {
    shortSummary: clampText(summaryBits[0] || plotSummaries[0] || DEFAULT_BOOK_BRIEF.shortSummary, 320),
    fullSummary: clampText([...summaryBits.slice(0, 4), ...plotSummaries.slice(0, 4)].join(" ") || DEFAULT_BOOK_BRIEF.fullSummary, 1200),
    spoilerSummary: clampText(plotSpine.slice(0, 10).map((item) => item.summary).join(" ") || DEFAULT_BOOK_BRIEF.spoilerSummary, 1600),
  };

  return {
    bookBrief,
    plotSpine,
    characters,
    themes,
    locations,
    groups,
    quoteBank,
    incidents,
    relationCandidates,
  };
}

function resolveExtractedRef<TRef extends z.infer<typeof BookExpertCoreExtractedRefSchema>>(
  ref: TRef,
  exactMatches: Map<string, ExactEntityResolution>
): TRef {
  const normalizedValue = normalizeEntityName(ref.normalizedValue || ref.value);
  const normalizedCandidateCanonicalName = normalizeEntityName(ref.candidateCanonicalName || "");
  const match =
    (normalizedValue ? exactMatches.get(normalizedValue) : undefined) ||
    (normalizedCandidateCanonicalName ? exactMatches.get(normalizedCandidateCanonicalName) : undefined);
  if (!match) {
    return {
      ...ref,
      normalizedValue,
      candidateCanonicalName: ref.candidateCanonicalName || null,
      entityId: null,
      canonicalEntityType: null,
      resolutionStatus: "unresolved",
    };
  }
  return {
    ...ref,
    normalizedValue,
    candidateCanonicalName: ref.candidateCanonicalName || null,
    entityId: match.entityId,
    canonicalEntityType: match.canonicalEntityType,
    resolutionStatus: "resolved",
  };
}

function resolveSnapshotRefs(current: BookExpertCoreSnapshot): Pick<BookExpertCoreSnapshot, "quoteBank" | "incidents" | "groups" | "relationCandidates"> {
  const exactMatches = buildExactEntityResolutionIndex(current);
  return {
    quoteBank: current.quoteBank.map((quote) =>
      BookExpertCoreQuoteSchema.parse({
        ...quote,
        mentions: quote.mentions.map((mention) => resolveExtractedRef(mention, exactMatches)),
      })
    ),
    incidents: current.incidents.map((incident) =>
      BookExpertCoreIncidentSchema.parse({
        ...incident,
        participants: incident.participants.map((participant) => resolveExtractedRef(participant, exactMatches)),
      })
    ),
    groups: current.groups.map((group) =>
      BookExpertCoreGroupSchema.parse({
        ...group,
        members: group.members.map((member) => resolveExtractedRef(member, exactMatches)),
      })
    ),
    relationCandidates: current.relationCandidates.map((relation) =>
      BookExpertCoreRelationCandidateSchema.parse({
        ...relation,
        fromRef: resolveExtractedRef(relation.fromRef, exactMatches),
        toRef: resolveExtractedRef(relation.toRef, exactMatches),
      })
    ),
  };
}

function buildProfilesPrompt(params: {
  kind: "characters" | "themes" | "locations" | "groups";
  book: LoadedBookSource;
  bookBrief: BookExpertCoreSnapshot["bookBrief"];
  plotSpine: BookExpertCoreSnapshot["plotSpine"];
  items: Array<Record<string, unknown>>;
}): string {
  const label =
    params.kind === "characters"
      ? "персонажей"
      : params.kind === "themes"
        ? "тем"
        : params.kind === "locations"
          ? "локаций"
          : "групп и коллективов";
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    `Собери narrative patch для карточек ${label} по уже агрегированному semantic core.`,
    "Требования:",
    "1. Не придумывай новых сущностей и не удаляй существующие.",
    "2. Верни только items с идентификатором (id или normalizedName) и narrative-полями для патча.",
    "3. Ориентируйся только на локальный evidence pack каждого item.",
    "4. Если evidence weak, не пиши общие фразы вроде «заметный участник событий». Верни краткое factual-описание и degraded=true.",
    "5. Если evidence strong, пиши коротко, конкретно, без академической воды и без литературного мусора.",
    "6. Поля description/development/arc/significance должны быть полезны для expert-chat и опираться на evidence pack.",
    "7. motivations для персонажей — только то, что реально следует из evidence, не более 6 пунктов.",
    "8. Не добавляй aliases, members, facets, rawKindLabel, relation types, quote mentions или новые сущности.",
    "9. Для groups разрешены только description и significance как narrative overlay.",
    "10. Корневой JSON: {\"items\":[{\"id\":\"...\",\"description\":\"...\",\"degraded\":false}]}",
    "",
    `Book brief: ${JSON.stringify(params.bookBrief)}`,
    `Plot spine: ${JSON.stringify(params.plotSpine.slice(0, 6))}`,
    `Входные кандидаты ${label}: ${JSON.stringify(params.items)}`,
  ].join("\n");
}

function buildCanonicalEntityCatalog(snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">) {
  return [
    ...snapshot.characters.map((item) => ({
      id: item.id,
      type: "character" as const,
      canonicalName: item.name,
      normalizedName: item.normalizedName,
      aliases: item.aliases.slice(0, 8),
    })),
    ...snapshot.themes.map((item) => ({
      id: item.id,
      type: "theme" as const,
      canonicalName: item.name,
      normalizedName: item.normalizedName,
      aliases: item.aliases.slice(0, 8),
    })),
    ...snapshot.locations.map((item) => ({
      id: item.id,
      type: "location" as const,
      canonicalName: item.name,
      normalizedName: item.normalizedName,
      aliases: item.aliases.slice(0, 8),
    })),
    ...snapshot.groups.map((item) => ({
      id: item.id,
      type: "group" as const,
      canonicalName: item.name,
      normalizedName: item.normalizedName,
      aliases: item.aliases.slice(0, 8),
    })),
  ];
}

function buildQuoteMentionCandidateCatalog(snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations">) {
  return {
    characters: snapshot.characters.map((item) => ({
      canonicalName: item.name,
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
    themes: snapshot.themes.map((item) => ({
      canonicalName: item.name,
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
    locations: snapshot.locations.map((item) => ({
      canonicalName: item.name,
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
  };
}

function chunkIntoBatches<T>(items: T[], batchSize: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  for (let index = 0; index < items.length; index += safeBatchSize) {
    out.push(items.slice(index, index + safeBatchSize));
  }
  return out;
}

function computeResolvedRate(resolvedCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return clampUnitInterval(resolvedCount / totalCount, 0);
}

function splitCoreParagraphs(chapter: ChapterSource): Array<{
  chapterOrderIndex: number;
  paragraphOrderInChapter: number;
  text: string;
}> {
  const normalized = canonicalizeDocumentContent(chapter.rawText || "");
  const out: Array<{ chapterOrderIndex: number; paragraphOrderInChapter: number; text: string }> = [];
  let cursor = 0;
  let paragraphOrderInChapter = 1;
  while (cursor < normalized.length) {
    while (cursor < normalized.length && /\n/.test(normalized[cursor])) cursor += 1;
    if (cursor >= normalized.length) break;
    const start = cursor;
    while (cursor < normalized.length) {
      const isBoundary = normalized[cursor] === "\n" && normalized[cursor + 1] === "\n";
      if (isBoundary) break;
      cursor += 1;
    }
    const end = cursor;
    const text = compactWhitespace(normalized.slice(start, end));
    if (text) {
      out.push({
        chapterOrderIndex: chapter.orderIndex,
        paragraphOrderInChapter,
        text,
      });
      paragraphOrderInChapter += 1;
    }
    while (cursor < normalized.length && /\n/.test(normalized[cursor])) cursor += 1;
  }
  return out;
}

function quoteTextContainsSurfaceForm(quoteText: string, surfaceForm: string): boolean {
  const haystack = compactWhitespace(quoteText).toLocaleLowerCase("ru");
  const needle = compactWhitespace(surfaceForm).toLocaleLowerCase("ru");
  if (!haystack || !needle) return false;
  return haystack.includes(needle);
}

function buildEntityMentionRefinementPrompt(params: {
  book: LoadedBookSource;
  catalog: ReturnType<typeof buildCanonicalEntityCatalog>;
  paragraphs: Array<{ chapterOrderIndex: number; paragraphOrderInChapter: number; text: string }>;
}): string {
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    "Извлеки explicit entity mentions из paragraph batch.",
    "Правила:",
    "1. Возвращай только mentions для сущностей из переданного каталога.",
    "2. surfaceForm должен буквально присутствовать в тексте paragraph.",
    "3. occurrenceIndex — порядковый номер literal occurrence surfaceForm внутри paragraph, начиная с 1.",
    "4. Не выводи coreference, местоимения, догадки по роли или фамилии.",
    "5. Если не уверен, пропусти mention.",
    "6. Корневой JSON: {\"items\":[{\"entityId\":\"...\",\"chapterOrderIndex\":1,\"paragraphOrderInChapter\":2,\"surfaceForm\":\"...\",\"occurrenceIndex\":1,\"confidence\":0.8}]}",
    "",
    `Catalog: ${JSON.stringify(params.catalog)}`,
    `Paragraphs: ${JSON.stringify(params.paragraphs)}`,
  ].join("\n");
}

function buildRefLinkPrompt(params: {
  book: LoadedBookSource;
  catalog: ReturnType<typeof buildCanonicalEntityCatalog>;
  refs: Array<Record<string, unknown>>;
}): string {
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    "Подбери canonical entity только для unresolved refs.",
    "Правила:",
    "1. Выбирай candidateCanonicalName только из переданного каталога canonical entities.",
    "2. Если уверенного соответствия нет, candidateCanonicalName должен быть null.",
    "3. Не создавай новые сущности и не используй общий канон вне книги.",
    "4. Ориентируйся только на сам ref и его локальный context.",
    "5. Корневой JSON: {\"items\":[{\"refId\":\"...\",\"candidateCanonicalName\":\"...\",\"confidence\":0.8}]}",
    "",
    `Catalog: ${JSON.stringify(params.catalog)}`,
    `Refs: ${JSON.stringify(params.refs)}`,
  ].join("\n");
}

function buildQuoteMentionRefinementPrompt(params: {
  book: LoadedBookSource;
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations">;
  quotes: Array<Pick<BookExpertCoreSnapshot["quoteBank"][number], "id" | "chapterOrderIndex" | "text" | "commentary" | "mentions">>;
}): string {
  const catalog = buildQuoteMentionCandidateCatalog(params.snapshot);
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    "Уточни mentions для уже извлечённых цитат.",
    "Правила:",
    "1. Для каждой цитаты верни mentions только для тех персонажей, тем или локаций, которые прямо названы в тексте самой цитаты.",
    "2. Используй только surface forms, которые буквально присутствуют внутри текста цитаты.",
    "3. Не расширяй короткое имя до полного. Если в цитате написано «Гарри», value должно быть «Гарри», а не «Гарри Поттер».",
    "4. Для каждого mention укажи candidateCanonicalName только если это один из переданных canonicalName и ты уверен, что literal form ссылается именно на него.",
    "5. Если уверенного canonical target нет, candidateCanonicalName должен быть null.",
    "6. Ориентируйся только на переданный каталог candidates и сам текст цитаты. Не выводи mentions из commentary, главы или общего знания о книге.",
    "7. Если в цитате нет явных mentions из каталога, верни пустой массив.",
    "8. Не возвращай spans, normalizedValue, entityId или новые сущности.",
    "9. Корневой JSON: {\"items\":[{\"quoteId\":\"...\",\"mentions\":[{\"kind\":\"character\",\"value\":\"...\",\"candidateCanonicalName\":\"Гарри Поттер\",\"confidence\":0.8}]}]}",
    "",
    `Candidates: ${JSON.stringify(catalog)}`,
    `Quotes: ${JSON.stringify(
      params.quotes.map((quote) => ({
        quoteId: quote.id,
        chapterOrderIndex: quote.chapterOrderIndex,
        text: quote.text,
        commentary: quote.commentary,
        currentMentions: quote.mentions.map((mention) => ({
          kind: mention.kind,
          value: mention.value,
        })),
      }))
    )}`,
  ].join("\n");
}

function applyQuoteMentionRefinement(params: {
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "quoteBank">;
  refinements: Array<z.infer<typeof QuoteMentionRefinementItemSchema>>;
}): BookExpertCoreSnapshot["quoteBank"] {
  const canonicalNameSet = new Set(
    [
      ...params.snapshot.characters.map((item) => item.name),
      ...params.snapshot.themes.map((item) => item.name),
      ...params.snapshot.locations.map((item) => item.name),
    ].map((item) => compactWhitespace(item))
  );
  const refinementMap = new Map<string, z.infer<typeof QuoteMentionRefinementItemSchema>>();
  for (const item of params.refinements) {
    const quoteId = compactWhitespace(item.quoteId);
    if (!quoteId || refinementMap.has(quoteId)) continue;
    refinementMap.set(quoteId, item);
  }

  return params.snapshot.quoteBank.map((quote) => {
    const refinement = refinementMap.get(quote.id);
    const mergedMentions: BookExpertCoreSnapshot["quoteBank"][number]["mentions"] = [];
    const pushMention = (input: {
      kind: (typeof BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS)[number];
      value: string;
      candidateCanonicalName?: string | null;
      confidence: number;
    }) => {
      const kind = input.kind;
      const value = compactWhitespace(input.value);
      const normalizedValue = normalizeEntityName(value);
      const candidateCanonicalName = canonicalNameSet.has(compactWhitespace(input.candidateCanonicalName || ""))
        ? compactWhitespace(input.candidateCanonicalName || "")
        : null;
      if (!value || !normalizedValue) return;
      if (!quoteTextContainsSurfaceForm(quote.text, value)) return;
      mergedMentions.push({
        kind,
        value,
        normalizedValue,
        candidateCanonicalName,
        entityId: null,
        canonicalEntityType: null,
        resolutionStatus: "unresolved" as const,
        confidence: clampUnitInterval(input.confidence, 0.72),
      });
    };

    for (const mention of quote.mentions) {
      pushMention({
        kind: mention.kind,
        value: mention.value,
        candidateCanonicalName: mention.candidateCanonicalName,
        confidence: mention.confidence,
      });
    }
    for (const mention of refinement?.mentions || []) {
      pushMention({
        kind: mention.kind,
        value: mention.value,
        candidateCanonicalName: mention.candidateCanonicalName,
        confidence: clampUnitInterval(mention.confidence, 0.72),
      });
    }

    const dedupedMentions = new Map<string, (typeof mergedMentions)[number]>();
    for (const mention of [...mergedMentions].sort((left, right) => right.confidence - left.confidence)) {
      const key = `${mention.kind}:${mention.normalizedValue}`;
      if (!dedupedMentions.has(key)) {
        dedupedMentions.set(key, mention);
      }
    }

    return BookExpertCoreQuoteSchema.parse({
      ...quote,
      mentions: Array.from(dedupedMentions.values()).slice(0, 16),
    });
  });
}

async function refineQuoteBankMentions(params: {
  book: LoadedBookSource;
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "quoteBank">;
  onAttempt?: ((attempt: StrictJsonAttemptLike) => void | Promise<void>) | null;
}): Promise<BookExpertCoreSnapshot["quoteBank"]> {
  if (params.snapshot.quoteBank.length === 0) {
    return params.snapshot.quoteBank;
  }

  const batches = chunkIntoBatches(params.snapshot.quoteBank, QUOTE_MENTION_BATCH_SIZE);
  const refinements = await mapWithConcurrency(batches, QUOTE_MENTION_CONCURRENCY, async (quotes, batchIndex) => {
    const call = await callStrictJson({
      phase: "book_core_quote_mentions",
      prompt: buildQuoteMentionRefinementPrompt({
        book: params.book,
        snapshot: params.snapshot,
        quotes,
      }),
      schema: QuoteMentionRefinementBatchSchema,
      allowedModels: buildVertexAllowedModels("lite", "flash"),
      disableGlobalFallback: true,
      maxAttempts: 2,
      vertexModel: workerConfig.vertex.modelByTier.lite,
      vertexThinkingLevel: "MINIMAL",
      maxTokens: 2200,
      onAttempt: params.onAttempt || undefined,
    });
    logger.info(
      {
        bookId: params.book.id,
        analyzerType: "core_quotes_finalize",
        stage: "quote_mentions",
        batchIndex: batchIndex + 1,
        batchSize: quotes.length,
        provider: call.meta.provider,
        model: call.meta.model,
        latencyMs: call.meta.latencyMs,
        promptTokens: call.meta.usage?.promptTokens ?? null,
        completionTokens: call.meta.usage?.completionTokens ?? null,
      },
      "Book expert core quote mentions refined"
    );
    return call.result.items;
  });

  return applyQuoteMentionRefinement({
    snapshot: params.snapshot,
    refinements: refinements.flat(),
  });
}

function normalizeEntityMentionBank(params: {
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">;
  mentions: Array<z.infer<typeof EntityMentionRefinementItemSchema>>;
  paragraphs: Array<{ chapterOrderIndex: number; paragraphOrderInChapter: number; text: string }>;
}): BookExpertCoreSnapshot["entityMentionBank"] {
  const entityIdSet = new Set(buildCanonicalEntityCatalog(params.snapshot).map((item) => item.id));
  const paragraphMap = new Map<string, { chapterOrderIndex: number; paragraphOrderInChapter: number; text: string }>(
    params.paragraphs.map((paragraph) => [`${paragraph.chapterOrderIndex}:${paragraph.paragraphOrderInChapter}`, paragraph] as const)
  );
  const deduped = new Map<string, BookExpertCoreSnapshot["entityMentionBank"][number]>();

  for (const mention of params.mentions) {
    const entityId = compactWhitespace(mention.entityId);
    if (!entityIdSet.has(entityId)) continue;
    const key = `${mention.chapterOrderIndex}:${mention.paragraphOrderInChapter}`;
    const paragraph = paragraphMap.get(key);
    if (!paragraph) continue;
    const surfaceForm = compactWhitespace(mention.surfaceForm);
    if (!surfaceForm || !paragraph.text.includes(surfaceForm)) continue;
    const occurrenceIndex = Math.max(1, Math.floor(Number(mention.occurrenceIndex) || 1));
    const id = hashId("entity_mention", [
      entityId,
      mention.chapterOrderIndex,
      mention.paragraphOrderInChapter,
      surfaceForm,
      occurrenceIndex,
    ]);
    const normalized = BookExpertCoreEntityMentionSchema.parse({
      id,
      entityId,
      chapterOrderIndex: mention.chapterOrderIndex,
      paragraphOrderInChapter: mention.paragraphOrderInChapter,
      surfaceForm,
      occurrenceIndex,
      confidence: clampUnitInterval(mention.confidence, 0.72),
    });
    const existing = deduped.get(normalized.id);
    if (!existing || normalized.confidence > existing.confidence) {
      deduped.set(normalized.id, normalized);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
    if (left.paragraphOrderInChapter !== right.paragraphOrderInChapter) return left.paragraphOrderInChapter - right.paragraphOrderInChapter;
    return left.entityId.localeCompare(right.entityId);
  });
}

async function extractEntityMentionBank(params: {
  book: LoadedBookSource;
  chapters: ChapterSource[];
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">;
  onAttempt?: ((attempt: StrictJsonAttemptLike) => void | Promise<void>) | null;
}): Promise<BookExpertCoreSnapshot["entityMentionBank"]> {
  const catalog = buildCanonicalEntityCatalog(params.snapshot);
  if (catalog.length === 0) return [];

  const paragraphs = params.chapters.flatMap((chapter) => splitCoreParagraphs(chapter));
  if (paragraphs.length === 0) return [];

  const runBatch = async (
    batch: Array<{ chapterOrderIndex: number; paragraphOrderInChapter: number; text: string }>,
    batchLabel: string
  ): Promise<BookExpertCoreSnapshot["entityMentionBank"]> => {
    try {
      const call = await callStrictJson({
        phase: "book_core_entity_mentions",
        prompt: buildEntityMentionRefinementPrompt({
          book: params.book,
          catalog,
          paragraphs: batch,
        }),
        schema: EntityMentionRefinementBatchSchema,
        allowedModels: buildVertexAllowedModels("lite", "flash"),
        disableGlobalFallback: true,
        maxAttempts: 2,
        vertexModel: workerConfig.vertex.modelByTier.lite,
        vertexThinkingLevel: "MINIMAL",
        maxTokens: 2600,
        onAttempt: params.onAttempt || undefined,
      });
      logger.info(
        {
          bookId: params.book.id,
          analyzerType: "core_entity_mentions",
          batchIndex: batchLabel,
          batchSize: batch.length,
          provider: call.meta.provider,
          model: call.meta.model,
          latencyMs: call.meta.latencyMs,
          promptTokens: call.meta.usage?.promptTokens ?? null,
          completionTokens: call.meta.usage?.completionTokens ?? null,
        },
        "Book expert core entity mentions refined"
      );
      return normalizeEntityMentionBank({
        snapshot: params.snapshot,
        mentions: call.result.items,
        paragraphs: batch,
      });
    } catch (error) {
      const recoverableEmptyOutput =
        error instanceof ExtractionStructuredOutputError &&
        (error.finishReason === "length" || error.message.includes("empty response"));
      if (!recoverableEmptyOutput) {
        throw error;
      }

      if (batch.length <= 1) {
        logger.warn(
          {
            bookId: params.book.id,
            analyzerType: "core_entity_mentions",
            batchIndex: batchLabel,
            batchSize: batch.length,
            finishReason: error.finishReason,
            error: error.message,
          },
          "Book expert core entity mentions batch returned empty structured output; dropping minimal batch as degraded"
        );
        return [];
      }

      const midpoint = Math.ceil(batch.length / 2);
      const left = batch.slice(0, midpoint);
      const right = batch.slice(midpoint);
      logger.warn(
        {
          bookId: params.book.id,
          analyzerType: "core_entity_mentions",
          batchIndex: batchLabel,
          batchSize: batch.length,
          splitLeft: left.length,
          splitRight: right.length,
          finishReason: error.finishReason,
        },
        "Book expert core entity mentions batch exceeded output budget; retrying with smaller batches"
      );
      const [leftMentions, rightMentions] = await Promise.all([
        runBatch(left, `${batchLabel}.1`),
        runBatch(right, `${batchLabel}.2`),
      ]);
      return [...leftMentions, ...rightMentions];
    }
  };

  const batches = chunkIntoBatches(paragraphs, ENTITY_MENTION_BATCH_SIZE);
  const results = await mapWithConcurrency(batches, ENTITY_MENTION_CONCURRENCY, async (batch, batchIndex) =>
    runBatch(batch, String(batchIndex + 1))
  );

  return normalizeEntityMentionBank({
    snapshot: params.snapshot,
    mentions: results.flat(),
    paragraphs,
  });
}

async function linkSnapshotUnresolvedRefs(params: {
  book: LoadedBookSource;
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups" | "incidents" | "relationCandidates">;
  onAttempt?: ((attempt: StrictJsonAttemptLike) => void | Promise<void>) | null;
}): Promise<Pick<BookExpertCoreSnapshot, "groups" | "incidents" | "relationCandidates">> {
  const catalog = buildCanonicalEntityCatalog(params.snapshot);
  if (catalog.length === 0) {
    return {
      groups: params.snapshot.groups,
      incidents: params.snapshot.incidents,
      relationCandidates: params.snapshot.relationCandidates,
    };
  }

  const unresolvedRefs: Array<Record<string, unknown>> = [];
  for (const group of params.snapshot.groups) {
    group.members.forEach((member, index) => {
      if (member.resolutionStatus === "resolved") return;
      unresolvedRefs.push({
        refId: `group:${group.id}:member:${index}`,
        refType: "group_member",
        groupName: group.name,
        context: `${group.description} ${group.significance}`.trim(),
        value: member.value,
        normalizedValue: member.normalizedValue,
        role: member.role,
      });
    });
  }
  for (const incident of params.snapshot.incidents) {
    incident.participants.forEach((participant, index) => {
      if (participant.resolutionStatus === "resolved") return;
      unresolvedRefs.push({
        refId: `incident:${incident.id}:participant:${index}`,
        refType: "incident_participant",
        context: `${incident.title} ${incident.facts.join(" ")} ${incident.consequences.join(" ")}`.trim(),
        value: participant.value,
        normalizedValue: participant.normalizedValue,
        role: participant.role,
      });
    });
  }
  for (const relation of params.snapshot.relationCandidates) {
    if (relation.fromRef.resolutionStatus !== "resolved") {
      unresolvedRefs.push({
        refId: `relation:${relation.id}:from`,
        refType: "relation_from",
        context: `${relation.rawTypeLabel} ${relation.summary} ${relation.anchors[0]?.snippet || ""}`.trim(),
        value: relation.fromRef.value,
        normalizedValue: relation.fromRef.normalizedValue,
      });
    }
    if (relation.toRef.resolutionStatus !== "resolved") {
      unresolvedRefs.push({
        refId: `relation:${relation.id}:to`,
        refType: "relation_to",
        context: `${relation.rawTypeLabel} ${relation.summary} ${relation.anchors[0]?.snippet || ""}`.trim(),
        value: relation.toRef.value,
        normalizedValue: relation.toRef.normalizedValue,
      });
    }
  }

  if (unresolvedRefs.length === 0) {
    return {
      groups: params.snapshot.groups,
      incidents: params.snapshot.incidents,
      relationCandidates: params.snapshot.relationCandidates,
    };
  }

  const batches = chunkIntoBatches(unresolvedRefs, REF_LINK_BATCH_SIZE);
  const linked = await mapWithConcurrency(batches, REF_LINK_CONCURRENCY, async (refs, batchIndex) => {
    const call = await callStrictJson({
      phase: "book_core_ref_link",
      prompt: buildRefLinkPrompt({
        book: params.book,
        catalog,
        refs,
      }),
      schema: RefLinkBatchSchema,
      allowedModels: buildVertexAllowedModels("lite", "flash"),
      disableGlobalFallback: true,
      maxAttempts: 2,
      vertexModel: workerConfig.vertex.modelByTier.lite,
      vertexThinkingLevel: "MINIMAL",
      maxTokens: 1800,
      onAttempt: params.onAttempt || undefined,
    });
    logger.info(
      {
        bookId: params.book.id,
        analyzerType: "core_resolve",
        stage: "ref_link",
        batchIndex: batchIndex + 1,
        batchSize: refs.length,
        provider: call.meta.provider,
        model: call.meta.model,
        latencyMs: call.meta.latencyMs,
      },
      "Book expert core unresolved refs linked"
    );
    return call.result.items;
  });

  const canonicalNameSet = new Set(catalog.map((item) => item.canonicalName));
  const linkMap = new Map(
    linked
      .flat()
      .map((item) => [compactWhitespace(item.refId), canonicalNameSet.has(compactWhitespace(item.candidateCanonicalName || "")) ? compactWhitespace(item.candidateCanonicalName || "") : null] as const)
      .filter(([refId]) => Boolean(refId))
  );

  return {
    groups: params.snapshot.groups.map((group) => ({
      ...group,
      members: group.members.map((member, index) => ({
        ...member,
        candidateCanonicalName: linkMap.get(`group:${group.id}:member:${index}`) ?? member.candidateCanonicalName ?? null,
      })),
    })),
    incidents: params.snapshot.incidents.map((incident) => ({
      ...incident,
      participants: incident.participants.map((participant, index) => ({
        ...participant,
        candidateCanonicalName: linkMap.get(`incident:${incident.id}:participant:${index}`) ?? participant.candidateCanonicalName ?? null,
      })),
    })),
    relationCandidates: params.snapshot.relationCandidates.map((relation) => ({
      ...relation,
      fromRef: {
        ...relation.fromRef,
        candidateCanonicalName: linkMap.get(`relation:${relation.id}:from`) ?? relation.fromRef.candidateCanonicalName ?? null,
      },
      toRef: {
        ...relation.toRef,
        candidateCanonicalName: linkMap.get(`relation:${relation.id}:to`) ?? relation.toRef.candidateCanonicalName ?? null,
      },
    })),
  };
}

function buildRelationCandidateCatalog(snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">) {
  return {
    characters: snapshot.characters.map((item) => ({
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
    themes: snapshot.themes.map((item) => ({
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
    locations: snapshot.locations.map((item) => ({
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
    groups: snapshot.groups.map((item) => ({
      name: item.name,
      aliases: item.aliases.slice(0, 8),
    })),
  };
}

function buildRelationRefinementViews(
  snapshot: Pick<BookExpertCoreSnapshot, "incidents" | "quoteBank" | "relationCandidates">
) {
  const sortedIncidents = [...snapshot.incidents].sort((left, right) => {
    if (right.importance !== left.importance) return right.importance - left.importance;
    if (left.chapterFrom !== right.chapterFrom) return left.chapterFrom - right.chapterFrom;
    return left.title.localeCompare(right.title, "ru");
  });
  const incidentBatches = chunkIntoBatches(sortedIncidents, RELATION_REFINE_BATCH_SIZE);
  return incidentBatches
    .map((incidents) => {
      const chapterFrom = Math.min(...incidents.map((item) => item.chapterFrom));
      const chapterTo = Math.max(...incidents.map((item) => item.chapterTo));
      const incidentQuoteIds = dedupeStrings(incidents.flatMap((item) => item.quoteIds), 24);
      const quoteSet = new Set(incidentQuoteIds);
      const quotes = snapshot.quoteBank
        .filter(
          (quote) =>
            quoteSet.has(quote.id) ||
            (quote.chapterOrderIndex >= chapterFrom &&
              quote.chapterOrderIndex <= chapterTo &&
              quote.mentions.length > 0)
        )
        .slice(0, 12);
      const existingRelations = snapshot.relationCandidates
        .filter((relation) => relation.chapterFrom <= chapterTo && relation.chapterTo >= chapterFrom)
        .slice(0, 8);
      return {
        chapterFrom,
        chapterTo,
        incidents,
        quotes,
        existingRelations,
      };
    })
    .filter((view) => view.incidents.length > 0 && (view.quotes.length > 0 || view.existingRelations.length > 0));
}

function buildRelationRefinementPrompt(params: {
  book: LoadedBookSource;
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups">;
  view: ReturnType<typeof buildRelationRefinementViews>[number];
}): string {
  const catalog = buildRelationCandidateCatalog(params.snapshot);
  return [
    `Книга: ${params.book.title}${params.book.author ? ` (${params.book.author})` : ""}`,
    `Уточни explicit relationCandidates для диапазона глав ${params.view.chapterFrom}-${params.view.chapterTo}.`,
    "Правила:",
    "1. Возвращай только явные pairwise relations, которые прямо поддержаны incidents, quote ids и текстами цитат из входа.",
    "2. fromValue и toValue должны быть взяты только из catalog surface forms. Используй только exact surface form из catalog, без новых имён и без нормализации.",
    "3. Если сущности просто участвуют в одной сцене, но тип их связи не выражен явно, не возвращай relation.",
    "4. rawTypeLabel оставляй свободной короткой меткой на языке книги.",
    "5. facet выбирай из точного списка enum ids: ally, family, romance, conflict, authority, dependence, rivalry, mirror, symbolic_association.",
    "6. Если evidence явно показывает один из этих типов, facet не должен быть null.",
    "7. Ставь facet=null только если связь explicit, но не укладывается в enum ids выше.",
    "8. Примеры: союзники/друзья/поддерживают друг друга -> ally; семейная связь -> family; открытый конфликт/вражда -> conflict; наставник/учитель/начальник/официальная власть -> authority; зависимость/подчинённость/нуждается в -> dependence; соперники -> rivalry; отражают друг друга как параллель или контраст -> mirror; символически связаны через идею/образ -> symbolic_association.",
    "9. Не используй rawTypeLabel вместо facet. rawTypeLabel может быть 'союзники' или 'наставник', а facet должен быть соответствующим enum id.",
    "10. quoteIds выбирай только из переданного списка quotes.",
    "11. Не используй знания о серии, мире или книге вне переданных incidents и quotes.",
    "12. Корневой JSON: {\"items\":[{\"fromValue\":\"...\",\"toValue\":\"...\",\"rawTypeLabel\":\"...\",\"facet\":\"ally\",\"summary\":\"...\",\"chapterFrom\":1,\"chapterTo\":1,\"quoteIds\":[\"quote_...\"],\"snippet\":\"...\",\"confidence\":0.8}]}",
    "",
    `Catalog: ${JSON.stringify(catalog)}`,
    `Incidents: ${JSON.stringify(
      params.view.incidents.map((incident) => ({
        title: incident.title,
        chapterFrom: incident.chapterFrom,
        chapterTo: incident.chapterTo,
        participants: incident.participants.map((participant) => ({
          kind: participant.kind,
          value: participant.value,
          normalizedValue: participant.normalizedValue,
          resolutionStatus: participant.resolutionStatus,
        })),
        facts: incident.facts,
        consequences: incident.consequences,
        quoteIds: incident.quoteIds,
        anchors: incident.anchors,
      }))
    )}`,
    `Quotes: ${JSON.stringify(
      params.view.quotes.map((quote) => ({
        id: quote.id,
        chapterOrderIndex: quote.chapterOrderIndex,
        text: quote.text,
        commentary: quote.commentary,
        mentions: quote.mentions.map((mention) => ({
          kind: mention.kind,
          value: mention.value,
          normalizedValue: mention.normalizedValue,
          resolutionStatus: mention.resolutionStatus,
        })),
      }))
    )}`,
    `Existing relation candidates: ${JSON.stringify(
      params.view.existingRelations.map((relation) => ({
        fromValue: relation.fromRef.value,
        toValue: relation.toRef.value,
        rawTypeLabel: relation.rawTypeLabel,
        facet: relation.facet,
        chapterFrom: relation.chapterFrom,
        chapterTo: relation.chapterTo,
        quoteIds: relation.quoteIds,
        summary: relation.summary,
      }))
    )}`,
  ].join("\n");
}

function applyRelationCandidateRefinement(params: {
  snapshot: Pick<BookExpertCoreSnapshot, "characters" | "themes" | "locations" | "groups" | "quoteBank" | "relationCandidates">;
  refinements: Array<z.infer<typeof RelationRefinementItemSchema>>;
}): BookExpertCoreSnapshot["relationCandidates"] {
  const exactMatches = buildExactEntityResolutionIndex(params.snapshot);
  const quoteIdSet = new Set(params.snapshot.quoteBank.map((quote) => quote.id));
  const relationFacetSet = new Set<string>(BOOK_EXPERT_CORE_RELATION_FACETS);
  const map = new Map<string, BookExpertCoreSnapshot["relationCandidates"][number]>();

  const mergeRelation = (relation: BookExpertCoreSnapshot["relationCandidates"][number]) => {
    const key = [
      normalizeEntityName(relation.fromRef.normalizedValue || relation.fromRef.value),
      normalizeEntityName(relation.toRef.normalizedValue || relation.toRef.value),
      relation.rawTypeLabel,
      relation.chapterFrom,
      relation.chapterTo,
    ].join(":");
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(
        key,
        BookExpertCoreRelationCandidateSchema.parse({
          ...relation,
          quoteIds: dedupeStrings(relation.quoteIds, 12),
          anchors: relation.anchors.slice(0, 4),
          sourceWindows: relation.sourceWindows.slice(0, 6),
        })
      );
      return;
    }

    map.set(
      key,
      BookExpertCoreRelationCandidateSchema.parse({
        ...existing,
        summary: clampText(dedupeStrings([existing.summary, relation.summary], 2).join(" "), 900),
        confidence: Math.max(existing.confidence, relation.confidence),
        chapterFrom: Math.min(existing.chapterFrom, relation.chapterFrom),
        chapterTo: Math.max(existing.chapterTo, relation.chapterTo),
        facet: existing.facet || relation.facet,
        facetConfidence:
          typeof existing.facetConfidence === "number" ? existing.facetConfidence : relation.facetConfidence ?? null,
        quoteIds: dedupeStrings([...existing.quoteIds, ...relation.quoteIds], 12),
        anchors: dedupeBy(
          [...existing.anchors, ...relation.anchors],
          (anchor) => `${anchor.chapterOrderIndex}:${anchor.snippet}`,
          4
        ),
        sourceWindows: dedupeBy(
          [...existing.sourceWindows, ...relation.sourceWindows],
          (source) => `${source.windowIndex}:${source.chapterFrom}:${source.chapterTo}`,
          6
        ),
      })
    );
  };

  for (const relation of params.snapshot.relationCandidates) {
    mergeRelation(relation);
  }

  for (const refinement of params.refinements) {
    const fromValue = clampText(refinement.fromValue, 160);
    const toValue = clampText(refinement.toValue, 160);
    const fromNormalizedValue = normalizeEntityName(fromValue || "");
    const toNormalizedValue = normalizeEntityName(toValue || "");
    if (!fromValue || !toValue || !fromNormalizedValue || !toNormalizedValue) continue;
    if (!exactMatches.has(fromNormalizedValue) || !exactMatches.has(toNormalizedValue)) continue;
    if (fromNormalizedValue === toNormalizedValue) continue;

    const rawTypeLabel = clampText(refinement.rawTypeLabel, 120);
    const summary = clampText(refinement.summary, 500);
    const snippet = clampText(refinement.snippet, 280);
    if (!rawTypeLabel || !summary || !snippet) continue;

    const facetRaw = compactWhitespace(String(refinement.facet || "")).toLowerCase();
    const facet = relationFacetSet.has(facetRaw)
      ? (facetRaw as (typeof BOOK_EXPERT_CORE_RELATION_FACETS)[number])
      : null;
    const chapterFrom = Math.max(1, Math.min(refinement.chapterFrom, refinement.chapterTo));
    const chapterTo = Math.max(chapterFrom, Math.max(refinement.chapterFrom, refinement.chapterTo));

    mergeRelation({
      id: hashId("relation_candidate", [params.snapshot.quoteBank.length, fromNormalizedValue, toNormalizedValue, rawTypeLabel, chapterFrom, chapterTo]),
      fromRef: {
        value: fromValue,
        normalizedValue: fromNormalizedValue,
        candidateCanonicalName: null,
        entityId: null,
        canonicalEntityType: null,
        resolutionStatus: "unresolved",
        confidence: 0.78,
      },
      toRef: {
        value: toValue,
        normalizedValue: toNormalizedValue,
        candidateCanonicalName: null,
        entityId: null,
        canonicalEntityType: null,
        resolutionStatus: "unresolved",
        confidence: 0.78,
      },
      rawTypeLabel,
      facet,
      facetConfidence:
        facet || refinement.facetConfidence != null ? clampUnitInterval(refinement.facetConfidence, 0.72) : null,
      summary,
      confidence: clampUnitInterval(refinement.confidence, 0.76),
      chapterFrom,
      chapterTo,
      quoteIds: dedupeStrings((refinement.quoteIds || []).filter((quoteId) => quoteIdSet.has(quoteId)), 12),
      anchors: [
        {
          chapterOrderIndex: chapterFrom,
          startChar: null,
          endChar: null,
          snippet,
        },
      ],
      sourceWindows: [],
    });
  }

  return Array.from(map.values())
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (left.chapterFrom !== right.chapterFrom) return left.chapterFrom - right.chapterFrom;
      return left.summary.localeCompare(right.summary, "ru");
    })
    .slice(0, 48);
}

async function refineRelationCandidates(params: {
  book: LoadedBookSource;
  snapshot: Pick<
    BookExpertCoreSnapshot,
    "characters" | "themes" | "locations" | "groups" | "quoteBank" | "incidents" | "relationCandidates"
  >;
  onAttempt?: ((attempt: StrictJsonAttemptLike) => void | Promise<void>) | null;
}): Promise<BookExpertCoreSnapshot["relationCandidates"]> {
  const views = buildRelationRefinementViews(params.snapshot);
  if (views.length === 0) {
    return params.snapshot.relationCandidates;
  }

  const refinements = await mapWithConcurrency(views, RELATION_REFINE_CONCURRENCY, async (view, batchIndex) => {
    const call = await callStrictJson({
      phase: "book_core_relations",
      prompt: buildRelationRefinementPrompt({
        book: params.book,
        snapshot: params.snapshot,
        view,
      }),
      schema: RelationRefinementBatchSchema,
      allowedModels: buildVertexAllowedModels("lite", "flash"),
      disableGlobalFallback: true,
      maxAttempts: 2,
      vertexModel: workerConfig.vertex.modelByTier.lite,
      vertexThinkingLevel: "MINIMAL",
      maxTokens: 2400,
      onAttempt: params.onAttempt || undefined,
    });
    logger.info(
      {
        bookId: params.book.id,
        analyzerType: "core_resolve",
        stage: "relations",
        batchIndex: batchIndex + 1,
        incidentCount: view.incidents.length,
        quoteCount: view.quotes.length,
        provider: call.meta.provider,
        model: call.meta.model,
        latencyMs: call.meta.latencyMs,
        promptTokens: call.meta.usage?.promptTokens ?? null,
        completionTokens: call.meta.usage?.completionTokens ?? null,
      },
      "Book expert core relations refined"
    );
    return call.result.items;
  });

  return applyRelationCandidateRefinement({
    snapshot: params.snapshot,
    refinements: refinements.flat(),
  });
}

function buildLiteraryPatternPrompt(snapshot: BookExpertCoreSnapshot): string {
  return [
    `Книга: ${snapshot.bookId}`,
    "Построй argument map для literary synthesis на основе готового semantic core.",
    "Нужны только те паттерны, которые реально поддержаны incidents, plot spine, entity cards и quote bank.",
    "Можно вернуть либо массив паттернов, либо объект с patterns/centralTension/interpretiveLens.",
    "Для паттерна достаточно name/summary/evidenceQuoteIds. Если не уверен, не заполняй лишние поля.",
    `Book brief: ${JSON.stringify(snapshot.bookBrief)}`,
    `Incidents: ${JSON.stringify(snapshot.incidents.slice(0, 18))}`,
    `Plot spine: ${JSON.stringify(snapshot.plotSpine.slice(0, 16))}`,
    `Characters: ${JSON.stringify(snapshot.characters.slice(0, 10))}`,
    `Themes: ${JSON.stringify(snapshot.themes.slice(0, 10))}`,
    `Locations: ${JSON.stringify(snapshot.locations.slice(0, 8))}`,
    `Groups: ${JSON.stringify(snapshot.groups.slice(0, 8))}`,
    `Relations: ${JSON.stringify(snapshot.relationCandidates.slice(0, 12))}`,
    `Quote bank: ${JSON.stringify(snapshot.quoteBank.slice(0, 24))}`,
  ].join("\n");
}

function buildLiterarySectionsPrompt(snapshot: BookExpertCoreSnapshot, patternMap: z.infer<typeof LiteraryPatternSchema>): string {
  return [
    "На основе semantic core и argument map собери полный literary analysis книги.",
    "Требования:",
    "1. Верни все 10 разделов.",
    "2. Допустим partial patch: можно вернуть только sections с теми полями, которые ты уверен заполнить качественно.",
    "3. Каждый раздел должен быть конкретен и опираться на incidents, plot spine, themes, characters и quotes.",
    "4. bodyMarkdown должен быть компактным, пригодным для UI.",
    "5. evidenceQuoteIds выбирай только из переданного quote bank.",
    "6. Не используй внешнее знание о книге.",
    `Book brief: ${JSON.stringify(snapshot.bookBrief)}`,
    `Pattern map: ${JSON.stringify(patternMap)}`,
    `Incidents: ${JSON.stringify(snapshot.incidents.slice(0, 18))}`,
    `Plot spine: ${JSON.stringify(snapshot.plotSpine.slice(0, 16))}`,
    `Characters: ${JSON.stringify(snapshot.characters.slice(0, 10))}`,
    `Themes: ${JSON.stringify(snapshot.themes.slice(0, 10))}`,
    `Groups: ${JSON.stringify(snapshot.groups.slice(0, 8))}`,
    `Relations: ${JSON.stringify(snapshot.relationCandidates.slice(0, 12))}`,
    `Quote bank: ${JSON.stringify(snapshot.quoteBank.slice(0, 32))}`,
  ].join("\n");
}

function normalizeWindowScan(window: WindowInput, result: z.infer<typeof WindowScanModelOutputSchema>): BookExpertCoreWindowScan {
  const quoteTypeSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_TYPES);
  const quoteTagSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_TAGS);
  const mentionKindSet = new Set<string>(BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS);
  const incidentParticipantKindSet = new Set<string>(BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS);
  const groupFacetSet = new Set<string>(BOOK_EXPERT_CORE_GROUP_FACETS);
  const relationFacetSet = new Set<string>(BOOK_EXPERT_CORE_RELATION_FACETS);

  const normalizeStringList = (items: string[] | undefined, limit: number, maxChars: number): string[] =>
    dedupeStrings(
      Array.isArray(items)
        ? items.map((item) => clampText(item, maxChars)).filter(Boolean)
        : [],
      limit
    );
  const normalizeIncidentFactList = (items: Array<string | Record<string, unknown>> | undefined, limit: number): string[] =>
    dedupeStrings(
      Array.isArray(items)
        ? items
            .map((item) => {
              if (typeof item === "string") return clampText(item, 260);
              const record = item || {};
              return clampText(
                String(
                  record.fact ||
                    record.text ||
                    record.summary ||
                    record.label ||
                    ""
                ),
                260
              );
            })
            .filter(Boolean)
        : [],
      limit
    );
  const splitEventStatements = (value: string, limit: number): string[] =>
    dedupeStrings(
      compactWhitespace(value)
        .split(/(?<=[.!?;])\s+|(?:\s+[-–]\s+)/u)
        .map((item) => clampText(item, 260))
        .filter(Boolean),
      limit
    );
  const normalizeIncidentParticipants = (items: Array<string | Record<string, unknown>> | undefined) =>
    dedupeBy(
      Array.isArray(items)
        ? items
            .map((item) => {
              if (typeof item === "string") {
                const value = clampText(item, 160);
                const normalizedValue = normalizeEntityName(value);
                if (!value || !normalizedValue) return null;
                return {
                  kind: "unknown" as const,
                  value,
                  normalizedValue,
                  candidateCanonicalName: null,
                  role: "participant",
                  confidence: 0.7,
                  entityId: null,
                  canonicalEntityType: null,
                  resolutionStatus: "unresolved" as const,
                };
              }

              const kindRaw = String(item.kind || "").trim().toLowerCase();
              const value = clampText(String(item.value || item.name || item.normalizedValue || ""), 160);
              const normalizedValue = normalizeEntityName(String(item.normalizedValue || value || ""));
              if (!value || !normalizedValue) return null;
              return {
                kind: (
                  incidentParticipantKindSet.has(kindRaw) ? kindRaw : "unknown"
                ) as BookExpertCoreIncident["participants"][number]["kind"],
                value,
                normalizedValue,
                candidateCanonicalName: null,
                role: clampText(String(item.role || "participant"), 120),
                confidence: 0.7,
                entityId: null,
                canonicalEntityType: null,
                resolutionStatus: "unresolved" as const,
              };
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        : [],
      (item) => `${item.kind}:${item.normalizedValue}:${item.role}`,
      12
    );

  const plotPoints = (result.plotPoints || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const text = clampText(item, 500);
        if (!text) return null;
        return {
          label: clampText(text, 180),
          summary: text,
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.4, 0.72 - index * 0.05),
          snippet: clampText(text, 280),
        };
      }

      const label = clampText(item.label || item.name || item.summary || "", 180);
      const summary = clampText(item.summary || item.label || item.name || "", 500);
      if (!label || !summary) return null;
      return {
        label,
        summary,
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.72 - index * 0.05)),
        snippet: clampText(item.snippet || summary, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const characters = (result.characters || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          aliases: [],
          roleHint: "Заметный участник событий этого фрагмента",
          traits: [],
          motivations: [],
          arcHint: "Его роль заметна в пределах этого окна книги.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.7 - index * 0.04),
          snippet: name,
        };
      }

      const name = clampText(item.name || "", 160);
      if (!name) return null;
      const roleHint = clampText(item.roleHint || item.role || item.description || "Заметный участник событий этого фрагмента", 240);
      const arcHint = clampText(item.arcHint || item.arc || item.description || roleHint, 320);
      return {
        name,
        aliases: normalizeStringList(item.aliases, 8, 160),
        roleHint,
        traits: normalizeStringList(item.traits, 6, 160),
        motivations: normalizeStringList(item.motivations, 6, 160),
        arcHint,
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.7 - index * 0.04)),
        snippet: clampText(item.snippet || item.description || roleHint, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 16);

  const themes = (result.themes || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          description: name,
          developmentHint: "Тема заметно проявляется в этом фрагменте.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.66 - index * 0.05),
          snippet: name,
        };
      }

      const name = clampText(item.name || item.label || "", 160);
      if (!name) return null;
      const description = clampText(item.description || name, 260);
      return {
        name,
        description,
        developmentHint: clampText(item.developmentHint || description, 320),
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.66 - index * 0.05)),
        snippet: clampText(item.snippet || description, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const locations = (result.locations || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          description: name,
          significanceHint: "Локация заметна в событиях этого фрагмента.",
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.66 - index * 0.05),
          snippet: name,
        };
      }

      const name = clampText(item.name || item.label || "", 160);
      if (!name) return null;
      const description = clampText(item.description || name, 260);
      return {
        name,
        description,
        significanceHint: clampText(item.significanceHint || description, 320),
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.66 - index * 0.05)),
        snippet: clampText(item.snippet || description, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const groups = (result.groups || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const name = clampText(item, 160);
        if (!name) return null;
        return {
          name,
          aliases: [],
          rawKindLabel: null,
          facet: null,
          facetConfidence: null,
          description: name,
          significanceHint: "Значимая группа или коллектив этого фрагмента.",
          members: [],
          chapterOrderIndex: window.chapterFrom,
          importance: Math.max(0.35, 0.64 - index * 0.04),
          snippet: name,
        };
      }

      const name = clampText(item.name || "", 160);
      if (!name) return null;
      const groupRecord = item as Record<string, unknown>;
      const rawKindLabel = clampText(String(groupRecord.rawKindLabel || item.category || ""), 120) || null;
      const facetRaw = String(groupRecord.facet || item.category || "").trim().toLowerCase();
      return {
        name,
        aliases: normalizeStringList(item.aliases, 8, 160),
        rawKindLabel,
        facet: (groupFacetSet.has(facetRaw) ? facetRaw : null) as (typeof BOOK_EXPERT_CORE_GROUP_FACETS)[number] | null,
        facetConfidence:
          groupFacetSet.has(facetRaw) || groupRecord.facetConfidence != null
            ? clampUnitInterval(groupRecord.facetConfidence, 0.7)
            : null,
        description: clampText(item.description || name, 260),
        significanceHint: clampText(item.significanceHint || item.description || name, 320),
        members: (Array.isArray(item.members) ? item.members : [])
          .map((member) => {
            if (typeof member === "string") {
              const memberName = clampText(member, 160);
              const normalizedName = normalizeEntityName(memberName);
              if (!memberName || !normalizedName) return null;
              return {
                value: memberName,
                normalizedValue: normalizedName,
                candidateCanonicalName: null,
                role: "member",
                confidence: 0.7,
                entityId: null,
                canonicalEntityType: null,
                resolutionStatus: "unresolved" as const,
              };
            }
            const memberName = clampText(String(member.name || member.normalizedName || ""), 160);
            const normalizedName = normalizeEntityName(String(member.normalizedName || memberName || ""));
            if (!memberName || !normalizedName) return null;
            return {
              value: memberName,
              normalizedValue: normalizedName,
              candidateCanonicalName: null,
              role: clampText(String(member.role || "member"), 160),
              confidence: 0.7,
              entityId: null,
              canonicalEntityType: null,
              resolutionStatus: "unresolved" as const,
            };
          })
          .filter((member): member is NonNullable<typeof member> => Boolean(member))
          .slice(0, 16),
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        importance: clampUnitInterval(item.importance, Math.max(0.35, 0.64 - index * 0.04)),
        snippet: clampText(item.snippet || item.description || name, 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const quotes = (result.quotes || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const text = clampText(item, 1200);
        if (!text) return null;
        return {
          chapterOrderIndex: window.chapterFrom,
          startChar: null,
          endChar: null,
          text,
          type: "dialogue" as const,
          tags: [],
          commentary: null,
          mentions: [],
          confidence: Math.max(0.45, 0.72 - index * 0.03),
        };
      }

      const text = clampText(item.text || item.quote || "", 1200);
      if (!text) return null;
      const normalizedType = String(item.type || "").trim().toLowerCase();
      const normalizedTags = Array.isArray(item.tags)
        ? item.tags
            .map((tag) => String(tag || "").trim().toLowerCase())
            .filter((tag): tag is (typeof BOOK_EXPERT_CORE_QUOTE_TAGS)[number] => quoteTagSet.has(tag))
        : [];
      const mentions = Array.isArray(item.mentions)
        ? item.mentions
            .map((mention) => {
              if (typeof mention === "string") return null;
              const kind = String(mention.kind || "").trim().toLowerCase();
              const value = clampText(mention.value || mention.name || mention.normalizedValue || "", 160);
              const normalizedValue = normalizeEntityName(mention.normalizedValue || value);
              if (!mentionKindSet.has(kind) || !value || !normalizedValue) return null;
              return {
                kind: kind as (typeof BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS)[number],
                value,
                normalizedValue,
                candidateCanonicalName: null,
                entityId: null,
                canonicalEntityType: null,
                resolutionStatus: "unresolved" as const,
                confidence: clampUnitInterval(mention.confidence, 0.7),
              };
            })
            .filter((mention): mention is NonNullable<typeof mention> => Boolean(mention))
            .slice(0, 16)
        : [];
      return {
        chapterOrderIndex: clampChapterOrderIndex(item.chapterOrderIndex, window),
        startChar: coerceNumber(item.startChar),
        endChar: coerceNumber(item.endChar),
        text,
        type: (quoteTypeSet.has(normalizedType) ? normalizedType : "dialogue") as (typeof BOOK_EXPERT_CORE_QUOTE_TYPES)[number],
        tags: dedupeStrings(normalizedTags, 8) as (typeof BOOK_EXPERT_CORE_QUOTE_TAGS)[number][],
        commentary: item.commentary ? clampText(item.commentary, 420) : null,
        mentions,
        confidence: clampUnitInterval(item.confidence, Math.max(0.45, 0.72 - index * 0.03)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 24);

  const incidents = (result.incidents || [])
    .map((item, index) => {
      if (typeof item === "string") {
        const fact = clampText(item, 260);
        if (!fact) return null;
        return {
          title: clampText(fact, 200),
          chapterFrom: window.chapterFrom,
          chapterTo: window.chapterTo,
          importance: Math.max(0.45, 0.74 - index * 0.05),
          participants: [],
          facts: [fact],
          consequences: [],
          supportingQuoteTexts: [],
          snippet: clampText(fact, 280),
        };
      }

      const title = clampText(String(item.title || item.label || item.summary || ""), 200);
      const facts = normalizeIncidentFactList(item.facts, 10);
      const consequences = normalizeIncidentFactList(item.consequences, 8);
      const snippet = clampText(String(item.snippet || facts[0] || item.summary || title || ""), 280);
      if ((!title && facts.length === 0) || !snippet) return null;
      const chapterFrom = clampChapterOrderIndex(item.chapterFrom || item.chapterOrderIndex, window);
      const chapterTo = clampChapterOrderIndex(item.chapterTo || item.chapterOrderIndex || chapterFrom, window);
      return {
        title: title || clampText(facts[0] || snippet, 200),
        chapterFrom: Math.min(chapterFrom, chapterTo),
        chapterTo: Math.max(chapterFrom, chapterTo),
        importance: clampUnitInterval(item.importance, Math.max(0.45, 0.74 - index * 0.05)),
        participants: normalizeIncidentParticipants(item.participants),
        facts: facts.length > 0 ? facts : [clampText(snippet, 260)],
        consequences,
        supportingQuoteTexts: dedupeStrings(
          [...(Array.isArray(item.supportingQuoteTexts) ? item.supportingQuoteTexts : []), ...(Array.isArray(item.quotes) ? item.quotes : [])]
            .map((value) => clampText(String(value || ""), 1200))
            .filter(Boolean),
          8
        ),
        snippet,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 12);

  const fallbackIncidents =
    incidents.length === 0
      ? plotPoints
          .slice(0, 3)
          .map((plotPoint, index) => {
            const statements = splitEventStatements(plotPoint.summary, 4);
            const facts = statements.slice(0, Math.max(1, Math.min(3, statements.length)));
            const consequences = statements.slice(facts.length);
            const supportingQuoteTexts = quotes
              .filter((quote) => quote.chapterOrderIndex === plotPoint.chapterOrderIndex)
              .slice(0, 2)
              .map((quote) => quote.text);
            return {
              title: clampText(plotPoint.label, 200),
              chapterFrom: plotPoint.chapterOrderIndex,
              chapterTo: plotPoint.chapterOrderIndex,
              importance: clampUnitInterval(plotPoint.importance, Math.max(0.45, 0.68 - index * 0.04)),
              participants: [],
              facts: facts.length > 0 ? facts : [clampText(plotPoint.summary, 260)],
              consequences,
              supportingQuoteTexts: dedupeStrings(supportingQuoteTexts, 8),
              snippet: clampText(plotPoint.snippet || plotPoint.summary, 280),
            };
          })
          .filter((item) => Boolean(item.title && item.snippet))
      : [];

  const relationCandidates = (result.relationCandidates || [])
    .map((item, index) => {
      // Some model outputs still collapse relations into plain strings. Keep the
      // scan valid and drop those degraded items instead of failing the whole book.
      if (typeof item === "string") return null;
      const fromRecord = item.fromRef && typeof item.fromRef === "object" ? (item.fromRef as Record<string, unknown>) : item;
      const toRecord = item.toRef && typeof item.toRef === "object" ? (item.toRef as Record<string, unknown>) : item;
      const fromValue = clampText(String(fromRecord.value || fromRecord.name || item.fromName || item.from || ""), 160);
      const toValue = clampText(String(toRecord.value || toRecord.name || item.toName || item.to || ""), 160);
      const fromNormalizedValue = normalizeEntityName(
        String(fromRecord.normalizedValue || item.fromNormalizedName || fromValue || "")
      );
      const toNormalizedValue = normalizeEntityName(
        String(toRecord.normalizedValue || item.toNormalizedName || toValue || "")
      );
      if (!fromValue || !toValue || !fromNormalizedValue || !toNormalizedValue) return null;
      const rawTypeLabel = clampText(String((item as Record<string, unknown>).rawTypeLabel || item.type || ""), 120);
      if (!rawTypeLabel) return null;
      const facetRaw = String((item as Record<string, unknown>).facet || item.type || "").trim().toLowerCase();
      const chapterFrom = clampChapterOrderIndex(item.chapterFrom || item.chapterOrderIndex, window);
      const chapterTo = clampChapterOrderIndex(item.chapterTo || item.chapterOrderIndex || chapterFrom, window);
      return {
        fromRef: {
          value: fromValue,
          normalizedValue: fromNormalizedValue,
          candidateCanonicalName: null,
          entityId: null,
          canonicalEntityType: null,
          resolutionStatus: "unresolved" as const,
          confidence: clampUnitInterval(fromRecord.confidence, 0.7),
        },
        toRef: {
          value: toValue,
          normalizedValue: toNormalizedValue,
          candidateCanonicalName: null,
          entityId: null,
          canonicalEntityType: null,
          resolutionStatus: "unresolved" as const,
          confidence: clampUnitInterval(toRecord.confidence, 0.7),
        },
        rawTypeLabel,
        facet: (relationFacetSet.has(facetRaw) ? facetRaw : null) as (typeof BOOK_EXPERT_CORE_RELATION_FACETS)[number] | null,
        facetConfidence:
          relationFacetSet.has(facetRaw) || (item as Record<string, unknown>).facetConfidence != null
            ? clampUnitInterval((item as Record<string, unknown>).facetConfidence, 0.7)
            : null,
        summary: clampText(String(item.summary || item.snippet || `${fromValue} и ${toValue}`), 500),
        confidence: clampUnitInterval(item.confidence, Math.max(0.45, 0.7 - index * 0.03)),
        chapterFrom: Math.min(chapterFrom, chapterTo),
        chapterTo: Math.max(chapterFrom, chapterTo),
        supportingQuoteTexts: dedupeStrings(
          (Array.isArray(item.supportingQuoteTexts) ? item.supportingQuoteTexts : [])
            .map((value) => clampText(String(value || ""), 1200))
            .filter(Boolean),
          8
        ),
        snippet: clampText(String(item.snippet || item.summary || `${fromValue} и ${toValue}`), 280),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 16);

  const summary =
    clampText(
      result.summary ||
        plotPoints[0]?.summary ||
        (window.chapterFrom === window.chapterTo
          ? `Смысловой снимок главы ${window.chapterFrom}.`
          : `Смысловой снимок глав ${window.chapterFrom}-${window.chapterTo}.`),
      900
    ) || `Смысловой снимок глав ${window.chapterFrom}-${window.chapterTo}.`;

  return {
    windowIndex: window.windowIndex,
    chapterFrom: window.chapterFrom,
    chapterTo: window.chapterTo,
    textChars: window.textChars,
    summary,
    plotPoints,
    characters,
    themes,
    locations,
    groups,
    quotes,
    incidents: incidents.length > 0 ? incidents : fallbackIncidents,
    relationCandidates,
  };
}

type CharacterProfilePatch = z.infer<typeof CharacterProfilePatchSchema>;
type ThemeProfilePatch = z.infer<typeof ThemeProfilePatchSchema>;
type LocationProfilePatch = z.infer<typeof LocationProfilePatchSchema>;
type GroupProfilePatch = z.infer<typeof GroupProfilePatchSchema>;
type LiteraryPatternMap = z.infer<typeof LiteraryPatternSchema>;
type LiterarySectionKey = (typeof BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS)[number];

const LITERARY_SECTION_TITLES: Record<(typeof BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS)[number], string> = {
  what_is_really_going_on: "Что на самом деле происходит",
  main_idea: "Главная идея",
  how_it_works: "Как это работает",
  hidden_details: "Скрытые детали",
  characters: "Персонажи",
  conflicts: "Конфликты",
  structure: "Структура",
  important_turns: "Важные повороты",
  takeaways: "Ключевые выводы",
  conclusion: "Вывод",
};

function resolvePatchMatchKey(input: { id?: string; normalizedName?: string; name?: string }): { id: string; normalizedName: string } {
  return {
    id: String(input.id || "").trim(),
    normalizedName: normalizeEntityName(input.normalizedName || input.name || ""),
  };
}

function mergeCharacterProfilePatches(
  items: BookExpertCoreSnapshot["characters"],
  patches: CharacterProfilePatch[]
): BookExpertCoreSnapshot["characters"] {
  const byId = new Map<string, CharacterProfilePatch>();
  const byNormalizedName = new Map<string, CharacterProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    const has = (field: string) => Object.prototype.hasOwnProperty.call(patch, field);
    return {
      ...item,
      profileDegraded: patch.degraded ?? item.profileDegraded,
      role: has("role") ? clampText(patch.role || "", 220) : item.role,
      description: has("description") ? clampText(patch.description || "", 900) : item.description,
      arc: has("arc") ? clampText(patch.arc || "", 900) : item.arc,
      motivations: has("motivations")
        ? dedupeStrings((patch.motivations || []).map((value) => clampText(value, 220)).filter(Boolean), 6)
        : item.motivations,
    };
  });
}

function mergeThemeProfilePatches(
  items: BookExpertCoreSnapshot["themes"],
  patches: ThemeProfilePatch[]
): BookExpertCoreSnapshot["themes"] {
  const byId = new Map<string, ThemeProfilePatch>();
  const byNormalizedName = new Map<string, ThemeProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    const has = (field: string) => Object.prototype.hasOwnProperty.call(patch, field);
    return {
      ...item,
      profileDegraded: patch.degraded ?? item.profileDegraded,
      description: has("description") ? clampText(patch.description || "", 900) : item.description,
      development: has("development") ? clampText(patch.development || "", 900) : item.development,
    };
  });
}

function mergeLocationProfilePatches(
  items: BookExpertCoreSnapshot["locations"],
  patches: LocationProfilePatch[]
): BookExpertCoreSnapshot["locations"] {
  const byId = new Map<string, LocationProfilePatch>();
  const byNormalizedName = new Map<string, LocationProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    const has = (field: string) => Object.prototype.hasOwnProperty.call(patch, field);
    return {
      ...item,
      profileDegraded: patch.degraded ?? item.profileDegraded,
      description: has("description") ? clampText(patch.description || "", 900) : item.description,
      significance: has("significance") ? clampText(patch.significance || "", 900) : item.significance,
    };
  });
}

function mergeGroupProfilePatches(
  items: BookExpertCoreSnapshot["groups"],
  patches: GroupProfilePatch[]
): BookExpertCoreSnapshot["groups"] {
  const byId = new Map<string, GroupProfilePatch>();
  const byNormalizedName = new Map<string, GroupProfilePatch>();
  for (const patch of patches) {
    const key = resolvePatchMatchKey(patch);
    if (key.id) byId.set(key.id, patch);
    if (key.normalizedName) byNormalizedName.set(key.normalizedName, patch);
  }
  return items.map((item) => {
    const patch = byId.get(item.id) || byNormalizedName.get(item.normalizedName);
    if (!patch) return item;
    const has = (field: string) => Object.prototype.hasOwnProperty.call(patch, field);
    return {
      ...item,
      profileDegraded: patch.degraded ?? item.profileDegraded,
      description: has("description") ? clampText(patch.description || "", 900) : item.description,
      significance: has("significance") ? clampText(patch.significance || "", 900) : item.significance,
    };
  });
}

function buildProfileEvidencePack(params: {
  kind: "characters" | "themes" | "locations" | "groups";
  item:
    | BookExpertCoreSnapshot["characters"][number]
    | BookExpertCoreSnapshot["themes"][number]
    | BookExpertCoreSnapshot["locations"][number]
    | BookExpertCoreSnapshot["groups"][number];
  snapshot: BookExpertCoreSnapshot;
  sceneOrderById: Map<string, number>;
}): Record<string, unknown> {
  const name = params.item.name;
  const normalizedName = params.item.normalizedName;
  const quoteMatches = params.snapshot.quoteBank
    .filter((quote) =>
      quote.mentions.some((mention) => mention.entityId === params.item.id || mention.normalizedValue === normalizedName)
    )
    .slice(0, 4)
    .map((quote) => ({
      id: quote.id,
      text: quote.text,
      commentary: quote.commentary,
      confidence: quote.confidence,
    }));
  const relationMatches = params.snapshot.relationCandidates
    .filter((relation) => relation.fromRef.entityId === params.item.id || relation.toRef.entityId === params.item.id)
    .slice(0, 4)
    .map((relation) => ({
      rawTypeLabel: relation.rawTypeLabel,
      facet: relation.facet,
      summary: relation.summary,
      chapterFrom: relation.chapterFrom,
      chapterTo: relation.chapterTo,
    }));
  const incidentMatches = params.snapshot.incidents
    .filter((incident) => incident.participants.some((participant) => participant.entityId === params.item.id))
    .slice(0, 4)
    .map((incident) => ({
      title: incident.title,
      facts: incident.facts.slice(0, 3),
      consequences: incident.consequences.slice(0, 2),
      chapterFrom: incident.chapterFrom,
      chapterTo: incident.chapterTo,
    }));
  const sourceWindowIndexes = params.item.sourceWindows.map((window) => window.windowIndex).slice(0, 6);
  const evidenceWeak =
    quoteMatches.length === 0 &&
    relationMatches.length === 0 &&
    incidentMatches.length === 0;

  return {
    id: params.item.id,
    normalizedName,
    name,
    type: params.kind,
    mentionStats: {
      mentionCount: params.item.mentionCount,
      firstAppearanceChapterOrder: params.item.firstAppearanceChapterOrder,
      firstSceneOrder:
        typeof params.item.firstAppearanceChapterOrder === "number"
          ? params.sceneOrderById.get(`chapter:${params.item.firstAppearanceChapterOrder}`) || null
          : null,
      lastSceneOrder:
        params.item.anchors.length > 0
          ? params.sceneOrderById.get(`chapter:${params.item.anchors[params.item.anchors.length - 1]?.chapterOrderIndex || 0}`) || null
          : null,
    },
    anchors: params.item.anchors.slice(0, 4),
    quotes: quoteMatches,
    relations: relationMatches,
    incidents: incidentMatches,
    sourceWindowIndexes,
    evidenceWeak,
  };
}

function buildEvidenceSentence(label: string, values: string[], limit = 3): string {
  const parts = dedupeStrings(values.map((value) => clampText(value, 220)).filter(Boolean), limit);
  if (parts.length === 0) return "";
  return `${label}: ${parts.join("; ")}.`;
}

function readEvidenceTexts(evidencePack: Record<string, unknown>) {
  const anchors = Array.isArray(evidencePack.anchors) ? evidencePack.anchors : [];
  const incidents = Array.isArray(evidencePack.incidents) ? evidencePack.incidents : [];
  const relations = Array.isArray(evidencePack.relations) ? evidencePack.relations : [];
  const quotes = Array.isArray(evidencePack.quotes) ? evidencePack.quotes : [];

  const anchorSnippets = anchors
    .map((item) =>
      typeof item === "object" && item && "snippet" in item ? clampText(String((item as { snippet?: string }).snippet || ""), 220) : ""
    )
    .filter(Boolean);
  const incidentTitles = incidents
    .map((item) =>
      typeof item === "object" && item && "title" in item ? clampText(String((item as { title?: string }).title || ""), 180) : ""
    )
    .filter(Boolean);
  const incidentFacts = incidents.flatMap((item) =>
    typeof item === "object" && item && "facts" in item && Array.isArray((item as { facts?: unknown[] }).facts)
      ? (item as { facts?: unknown[] }).facts!.map((value) => clampText(String(value || ""), 220)).filter(Boolean)
      : []
  );
  const incidentConsequences = incidents.flatMap((item) =>
    typeof item === "object" && item && "consequences" in item && Array.isArray((item as { consequences?: unknown[] }).consequences)
      ? (item as { consequences?: unknown[] }).consequences!.map((value) => clampText(String(value || ""), 220)).filter(Boolean)
      : []
  );
  const relationSummaries = relations
    .map((item) =>
      typeof item === "object" && item && "summary" in item ? clampText(String((item as { summary?: string }).summary || ""), 220) : ""
    )
    .filter(Boolean);
  const quoteNotes = quotes
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const commentary = "commentary" in item ? String((item as { commentary?: string }).commentary || "") : "";
      const text = "text" in item ? String((item as { text?: string }).text || "") : "";
      return clampText(commentary || text, 220);
    })
    .filter(Boolean);

  return {
    anchorSnippets,
    incidentTitles,
    incidentFacts,
    incidentConsequences,
    relationSummaries,
    quoteNotes,
  };
}

function buildDeterministicProfilePatch(
  kind: "characters" | "themes" | "locations" | "groups",
  item:
    | BookExpertCoreSnapshot["characters"][number]
    | BookExpertCoreSnapshot["themes"][number]
    | BookExpertCoreSnapshot["locations"][number]
    | BookExpertCoreSnapshot["groups"][number],
  evidencePack: Record<string, unknown>
) {
  const evidence = readEvidenceTexts(evidencePack);
  const hasEvidence =
    evidence.anchorSnippets.length > 0 ||
    evidence.incidentTitles.length > 0 ||
    evidence.incidentFacts.length > 0 ||
    evidence.incidentConsequences.length > 0 ||
    evidence.relationSummaries.length > 0 ||
    evidence.quoteNotes.length > 0;

  if (!hasEvidence) {
    if (kind === "characters") {
      return {
        id: item.id,
        role: "",
        description: item.name,
        arc: "",
        motivations: [],
        degraded: true,
      };
    }
    if (kind === "themes") {
      return {
        id: item.id,
        description: item.name,
        development: "",
        degraded: true,
      };
    }
    return {
      id: item.id,
      description: item.name,
      significance: "",
      degraded: true,
    };
  }

  const lead =
    evidence.anchorSnippets[0] ||
    evidence.quoteNotes[0] ||
    evidence.incidentFacts[0] ||
    evidence.incidentTitles[0] ||
    item.name;

  const description = clampText(
    [
      lead,
      buildEvidenceSentence("Эпизоды", evidence.incidentTitles),
      buildEvidenceSentence("Опорные факты", evidence.incidentFacts),
      kind === "characters" || kind === "groups" ? buildEvidenceSentence("Связи", evidence.relationSummaries, 2) : "",
    ]
      .filter(Boolean)
      .join(" "),
    900
  ) || item.name;

  if (kind === "characters") {
    const role = clampText(
      [
        evidence.relationSummaries[0] || "",
        evidence.incidentTitles[0] ? `Линия проявляется через эпизод «${evidence.incidentTitles[0]}».` : "",
      ]
        .filter(Boolean)
        .join(" "),
      220
    ) || "";

    const arc = clampText(
      [
        buildEvidenceSentence("Развитие", evidence.incidentFacts),
        buildEvidenceSentence("Последствия", evidence.incidentConsequences, 2),
        buildEvidenceSentence("Цитаты", evidence.quoteNotes, 2),
      ]
        .filter(Boolean)
        .join(" "),
      900
    ) || description;

    return {
      id: item.id,
      role,
      description,
      arc,
      motivations: [],
      degraded: true,
    };
  }

  if (kind === "themes") {
    return {
      id: item.id,
      description,
      development:
        clampText(
          [
            buildEvidenceSentence("Развитие", evidence.incidentConsequences.length > 0 ? evidence.incidentConsequences : evidence.incidentFacts),
            buildEvidenceSentence("Цитатные маркеры", evidence.quoteNotes, 2),
          ]
            .filter(Boolean)
            .join(" "),
          900
        ) || description,
      degraded: true,
    };
  }

  return {
    id: item.id,
    description,
    significance:
      clampText(
        [
          buildEvidenceSentence("Значение", evidence.incidentConsequences.length > 0 ? evidence.incidentConsequences : evidence.relationSummaries),
          buildEvidenceSentence("Цитатные маркеры", evidence.quoteNotes, 2),
        ]
          .filter(Boolean)
          .join(" "),
        900
      ) || description,
    degraded: true,
  };
}

function pickEvidenceQuoteIds(snapshot: BookExpertCoreSnapshot, queries: string[], limit: number): string[] {
  const scored = snapshot.quoteBank
    .map((quote) => {
      const corpus = [quote.text, quote.commentary || "", quote.tags.join(" "), quote.mentions.map((item) => item.value).join(" ")].join(" ");
      const score =
        queries.reduce((sum, query) => sum + scoreSnippetRelevance(corpus, query), 0) +
        Math.round(quote.confidence * 10);
      return {
        id: quote.id,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const positive = scored.filter((item) => item.score > 0).slice(0, limit).map((item) => item.id);
  if (positive.length >= limit) return positive;
  return dedupeStrings([...positive, ...snapshot.quoteBank.slice(0, limit).map((item) => item.id)], limit);
}

function buildDeterministicPatternMap(snapshot: BookExpertCoreSnapshot): LiteraryPatternMap {
  const patterns = [
    ...snapshot.incidents.slice(0, 4).map((incident) => ({
      name: incident.title,
      summary: clampText([...incident.facts.slice(0, 2), ...incident.consequences.slice(0, 1)].join(" "), 400),
      evidenceQuoteIds: dedupeStrings(incident.quoteIds, 3),
    })),
    ...snapshot.themes.slice(0, 4).map((theme) => ({
      name: theme.name,
      summary: clampText(theme.development || theme.description, 400),
      evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [theme.name, theme.description, theme.development], 3),
    })),
    ...snapshot.plotSpine.slice(0, 4).map((plotPoint) => ({
      name: plotPoint.label,
      summary: clampText(plotPoint.summary, 400),
      evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [plotPoint.label, plotPoint.summary], 3),
    })),
  ];
  const dedupedPatterns = Array.from(
    patterns.reduce((acc, pattern) => {
      const key = normalizeEntityName(pattern.name);
      if (key && !acc.has(key)) {
        acc.set(key, pattern);
      }
      return acc;
    }, new Map<string, LiteraryPatternMap["patterns"][number]>()).values()
  )
    .filter((item) => item.name && item.summary)
    .slice(0, 8);
  const centralTension = clampText(
    [
      snapshot.incidents[0]?.facts[0] || "",
      snapshot.plotSpine[0]?.summary || "",
      snapshot.plotSpine[1]?.summary || "",
      snapshot.themes[0]?.development || snapshot.themes[0]?.description || "",
    ]
      .filter(Boolean)
      .join(" "),
    500
  ) || DEFAULT_BOOK_BRIEF.fullSummary;
  const interpretiveLens = clampText(
    [
      snapshot.bookBrief.shortSummary,
      snapshot.themes.slice(0, 3).map((item) => item.name).join(", "),
      snapshot.characters[0]?.name ? `Через линию ${snapshot.characters[0].name}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    500
  ) || snapshot.bookBrief.shortSummary;
  return LiteraryPatternSchema.parse({
    patterns: dedupedPatterns.length > 0
      ? dedupedPatterns
      : [
          {
            name: snapshot.plotSpine[0]?.label || "Ключевой сюжетный конфликт",
            summary: snapshot.plotSpine[0]?.summary || snapshot.bookBrief.shortSummary,
            evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [snapshot.bookBrief.shortSummary], 3),
          },
        ],
    centralTension,
    interpretiveLens,
  });
}

function normalizeLiteraryPatternMap(
  snapshot: BookExpertCoreSnapshot,
  result: z.infer<typeof LooseLiteraryPatternSchema>
): LiteraryPatternMap {
  const quoteIdSet = new Set(snapshot.quoteBank.map((quote) => quote.id));
  const normalizedPatterns = (result.patterns || [])
    .map((item) => {
      if (typeof item === "string") {
        const summary = clampText(item, 400);
        if (!summary) return null;
        return {
          name: clampText(item, 180),
          summary,
          evidenceQuoteIds: pickEvidenceQuoteIds(snapshot, [summary], 3),
        };
      }
      const name = clampText(item.name || item.title || item.label || item.summary || item.description || "", 180);
      const summary = clampText(item.summary || item.description || name, 400);
      if (!name || !summary) return null;
      const evidenceQuoteIds = dedupeStrings(
        (item.evidenceQuoteIds || []).filter((quoteId) => quoteIdSet.has(quoteId)),
        8
      );
      return {
        name,
        summary,
        evidenceQuoteIds: evidenceQuoteIds.length > 0 ? evidenceQuoteIds : pickEvidenceQuoteIds(snapshot, [name, summary], 3),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (normalizedPatterns.length === 0) {
    return buildDeterministicPatternMap(snapshot);
  }

  const fallback = buildDeterministicPatternMap(snapshot);
  const dedupedPatterns = Array.from(
    [...normalizedPatterns, ...fallback.patterns].reduce((acc, pattern) => {
      const key = normalizeEntityName(pattern.name);
      if (key && !acc.has(key)) {
        acc.set(key, {
          name: clampText(pattern.name, 180),
          summary: clampText(pattern.summary, 400),
          evidenceQuoteIds: dedupeStrings(pattern.evidenceQuoteIds, 8),
        });
      }
      return acc;
    }, new Map<string, LiteraryPatternMap["patterns"][number]>()).values()
  ).slice(0, 8);

  return LiteraryPatternSchema.parse({
    patterns: dedupedPatterns,
    centralTension: clampText(result.centralTension || fallback.centralTension, 500),
    interpretiveLens: clampText(result.interpretiveLens || fallback.interpretiveLens, 500),
  });
}

function resolveLiterarySectionKey(value: string): LiterarySectionKey | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const direct = BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.find((key) => key === normalized);
  if (direct) return direct;
  const collapsed = normalized.replace(/_/g, "");
  return (
    BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.find((key) => key.replace(/_/g, "") === collapsed) ||
    null
  );
}

function buildSectionBodyMarkdown(summary: string, bullets: string[], extra: string[]): string {
  return (
    clampMarkdown(
      [
        clampText(summary, 500),
        ...extra.map((item) => clampText(item, 600)).filter(Boolean),
        bullets.length > 0 ? bullets.map((item) => `- ${clampText(item, 220)}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      6000
    ) || clampText(summary, 500)
  );
}

function buildDeterministicLiterarySections(
  snapshot: BookExpertCoreSnapshot,
  patternMap: LiteraryPatternMap
): LiterarySectionsRecord {
  const topPatterns = patternMap.patterns.slice(0, 6);
  const topPlot = snapshot.plotSpine.slice(0, 6);
  const topIncidents = snapshot.incidents.slice(0, 4);
  const topThemes = snapshot.themes.slice(0, 4);
  const topCharacters = snapshot.characters.slice(0, 4);
  const bulletsByKey: Record<LiterarySectionKey, string[]> = {
    what_is_really_going_on: dedupeStrings([patternMap.centralTension, ...topIncidents.map((item) => item.title), ...topPatterns.map((item) => item.name)], 5),
    main_idea: dedupeStrings(topThemes.map((item) => `${item.name}: ${item.description}`), 5),
    how_it_works: dedupeStrings([...topIncidents.map((item) => `${item.title}: ${item.facts[0] || ""}`), ...topPlot.map((item) => `${item.label}: ${item.summary}`)], 5),
    hidden_details: dedupeStrings(snapshot.quoteBank.slice(0, 4).map((item) => item.commentary || item.text), 4),
    characters: dedupeStrings(topCharacters.map((item) => `${item.name}: ${item.arc}`), 5),
    conflicts: dedupeStrings([patternMap.centralTension, ...topCharacters.map((item) => `${item.name}: ${item.role}`)], 5),
    structure: dedupeStrings(topPlot.map((item) => `Глава ${item.chapterOrderIndex}: ${item.label}`), 5),
    important_turns: dedupeStrings([...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.summary)], 5),
    takeaways: dedupeStrings(topThemes.map((item) => item.development || item.description), 5),
    conclusion: dedupeStrings([snapshot.bookBrief.shortSummary, patternMap.interpretiveLens], 4),
  };
  const summaryByKey: Record<LiterarySectionKey, string> = {
    what_is_really_going_on: clampText(patternMap.centralTension, 500),
    main_idea: clampText([snapshot.bookBrief.shortSummary, topThemes.map((item) => item.name).join(", ")].filter(Boolean).join(" "), 500),
    how_it_works: clampText([...topIncidents.slice(0, 2).map((item) => item.facts[0] || item.title), ...topPlot.slice(0, 3).map((item) => item.summary)].join(" "), 500),
    hidden_details: clampText(topPatterns.map((item) => item.summary).join(" "), 500),
    characters: clampText(topCharacters.map((item) => `${item.name}: ${item.arc}`).join(" "), 500),
    conflicts: clampText([patternMap.centralTension, ...topThemes.map((item) => item.name)].join(" "), 500),
    structure: clampText(topPlot.map((item) => `${item.chapterOrderIndex}. ${item.label}`).join(" "), 500),
    important_turns: clampText([...topIncidents.slice(0, 2).map((item) => item.title), ...topPlot.slice(0, 4).map((item) => item.summary)].join(" "), 500),
    takeaways: clampText(topThemes.map((item) => item.development || item.description).join(" "), 500),
    conclusion: clampText([snapshot.bookBrief.fullSummary, patternMap.interpretiveLens].join(" "), 500),
  };
  const evidenceQueriesByKey: Record<LiterarySectionKey, string[]> = {
    what_is_really_going_on: [patternMap.centralTension, ...topIncidents.map((item) => item.title), ...topPatterns.map((item) => item.name)],
    main_idea: [...topThemes.map((item) => item.name), snapshot.bookBrief.shortSummary],
    how_it_works: [...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.label)],
    hidden_details: topPatterns.map((item) => item.summary),
    characters: topCharacters.map((item) => item.name),
    conflicts: [patternMap.centralTension, ...topCharacters.map((item) => item.name)],
    structure: topPlot.map((item) => item.label),
    important_turns: [...topIncidents.map((item) => item.title), ...topPlot.map((item) => item.summary)],
    takeaways: topThemes.map((item) => item.name),
    conclusion: [snapshot.bookBrief.fullSummary, patternMap.interpretiveLens],
  };
  const sections = Object.fromEntries(
    BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS.map((key) => {
      const evidenceQuoteIds = pickEvidenceQuoteIds(snapshot, evidenceQueriesByKey[key], 4);
      const summary = summaryByKey[key] || snapshot.bookBrief.shortSummary;
      return [
        key,
        {
          key,
          title: LITERARY_SECTION_TITLES[key],
          summary,
          bodyMarkdown: buildSectionBodyMarkdown(summary, bulletsByKey[key], [
            patternMap.interpretiveLens,
            topPatterns.map((item) => item.summary).slice(0, 2).join(" "),
          ]),
          bullets: bulletsByKey[key].slice(0, 5),
          evidenceQuoteIds,
          confidence: 0.58,
        },
      ];
    })
  ) as LiterarySectionsRecord;
  return sections;
}

function pickTopRelevantItems<T>(
  items: T[],
  queries: string[],
  limit: number,
  toCorpus: (item: T) => string
): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      score: queries.reduce((sum, query) => sum + scoreSnippetRelevance(toCorpus(item), query), 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter((item, index) => index < limit && (item.score > 0 || index === 0))
    .map((item) => item.item);
}

function buildLiterarySectionStageView(params: {
  snapshot: BookExpertCoreSnapshot;
  patternMap: LiteraryPatternMap;
  fallbackSections: LiterarySectionsRecord;
  sectionKey: LiterarySectionKey;
}) {
  const { snapshot, patternMap, fallbackSections, sectionKey } = params;
  const scaffold = fallbackSections[sectionKey];
  const queries = dedupeStrings(
    [
      scaffold.title,
      scaffold.summary,
      ...scaffold.bullets,
      patternMap.centralTension,
      patternMap.interpretiveLens,
      ...patternMap.patterns.slice(0, 6).map((item) => `${item.name} ${item.summary}`),
    ],
    16
  );
  const relevantPatterns = pickTopRelevantItems(
    patternMap.patterns.slice(0, 8),
    queries,
    4,
    (item) => `${item.name} ${item.summary} ${item.evidenceQuoteIds.join(" ")}`
  );
  const relevantIncidents = pickTopRelevantItems(
    snapshot.incidents.slice(0, 18),
    queries,
    5,
    (item) => `${item.title} ${item.facts.join(" ")} ${item.consequences.join(" ")}`
  );
  const relevantPlot = pickTopRelevantItems(
    snapshot.plotSpine.slice(0, 16),
    queries,
    5,
    (item) => `${item.label} ${item.summary}`
  );
  const relevantCharacters = pickTopRelevantItems(
    snapshot.characters.slice(0, 12),
    queries,
    sectionKey === "characters" || sectionKey === "conflicts" ? 6 : 4,
    (item) => `${item.name} ${item.role} ${item.description} ${item.arc}`
  );
  const relevantThemes = pickTopRelevantItems(
    snapshot.themes.slice(0, 10),
    queries,
    sectionKey === "main_idea" || sectionKey === "takeaways" ? 6 : 4,
    (item) => `${item.name} ${item.description} ${item.development}`
  );
  const relevantLocations = pickTopRelevantItems(
    snapshot.locations.slice(0, 8),
    queries,
    3,
    (item) => `${item.name} ${item.description} ${item.significance}`
  );
  const quoteIds = dedupeStrings(
    [
      ...scaffold.evidenceQuoteIds,
      ...relevantPatterns.flatMap((item) => item.evidenceQuoteIds),
      ...relevantIncidents.flatMap((item) => item.quoteIds),
    ],
    8
  );
  const relevantQuotes = snapshot.quoteBank.filter((quote) => quoteIds.includes(quote.id)).slice(0, 8);

  return {
    scaffold,
    relevantPatterns,
    relevantIncidents,
    relevantPlot,
    relevantCharacters,
    relevantThemes,
    relevantLocations,
    relevantQuotes,
  };
}

function buildLiterarySectionPrompt(params: {
  snapshot: BookExpertCoreSnapshot;
  patternMap: LiteraryPatternMap;
  fallbackSections: LiterarySectionsRecord;
  sectionKey: LiterarySectionKey;
}): string {
  const view = buildLiterarySectionStageView(params);
  return [
    "Собери один раздел literary analysis по уже готовому semantic core.",
    "Верни только один JSON-объект с полями title, summary, bodyMarkdown, bullets, evidenceQuoteIds, confidence.",
    "Требования:",
    "1. Пиши только про текущий раздел.",
    "2. Не используй внешнее знание о книге.",
    "3. Держи summary и bullets компактными и конкретными.",
    "4. bodyMarkdown должен быть пригоден для UI и не повторять бессмысленно одно и то же.",
    "5. evidenceQuoteIds можно выбирать только из переданного quote bank.",
    "6. Если данных мало, опирайся на scaffold и снижай confidence вместо выдумывания.",
    "",
    `Section key: ${params.sectionKey}`,
    `Section title: ${LITERARY_SECTION_TITLES[params.sectionKey]}`,
    `Book brief: ${JSON.stringify(params.snapshot.bookBrief)}`,
    `Interpretive lens: ${JSON.stringify({
      centralTension: params.patternMap.centralTension,
      interpretiveLens: params.patternMap.interpretiveLens,
    })}`,
    `Scaffold: ${JSON.stringify(view.scaffold)}`,
    `Relevant patterns: ${JSON.stringify(view.relevantPatterns)}`,
    `Relevant incidents: ${JSON.stringify(view.relevantIncidents)}`,
    `Relevant plot points: ${JSON.stringify(view.relevantPlot)}`,
    `Relevant characters: ${JSON.stringify(view.relevantCharacters)}`,
    `Relevant themes: ${JSON.stringify(view.relevantThemes)}`,
    `Relevant locations: ${JSON.stringify(view.relevantLocations)}`,
    `Relevant quote bank: ${JSON.stringify(view.relevantQuotes)}`,
  ].join("\n");
}

function normalizeLiterarySections(
  snapshot: BookExpertCoreSnapshot,
  patternMap: LiteraryPatternMap,
  result: z.infer<typeof LooseLiterarySectionsResultSchema>
): LiterarySectionsRecord {
  const fallbackSections = buildDeterministicLiterarySections(snapshot, patternMap);
  const sectionPatches = result.sections;
  const entries: Array<readonly [string, z.infer<typeof LooseLiterarySectionPatchSchema>]> = Array.isArray(sectionPatches)
    ? sectionPatches.map((item) => [String(item.key || item.title || ""), item] as const)
    : (Object.entries(sectionPatches) as Array<readonly [string, z.infer<typeof LooseLiterarySectionPatchSchema>]>);
  const quoteIdSet = new Set(snapshot.quoteBank.map((quote) => quote.id));
  for (const [rawKey, patch] of entries) {
    const key = resolveLiterarySectionKey(String(patch.key || rawKey || patch.title || ""));
    if (!key) continue;
    const currentSection = fallbackSections[key];
    if (!currentSection) continue;
    fallbackSections[key] = normalizeLiterarySection(currentSection, {
      ...patch,
      key,
      evidenceQuoteIds: patch.evidenceQuoteIds
        ? dedupeStrings(patch.evidenceQuoteIds.filter((quoteId) => quoteIdSet.has(quoteId)), 10)
        : currentSection.evidenceQuoteIds,
      confidence: clampUnitInterval(patch.confidence, currentSection.confidence),
    });
  }
  return normalizeLiterarySectionsRecord(
    LiterarySectionsResultSchema.parse({
      sections: fallbackSections,
    }).sections as LiterarySectionsRecord
  );
}

function buildSnapshotWithStage(params: {
  bookId: string;
  previous: BookExpertCoreSnapshot | null;
  stage: BookExpertCoreStageKey;
  durationMs: number;
  patch: Partial<BookExpertCoreSnapshot>;
}): BookExpertCoreSnapshot {
  const base = params.previous || createEmptySnapshot(params.bookId);
  return BookExpertCoreSnapshotSchema.parse({
    ...base,
    version: BOOK_EXPERT_CORE_VERSION,
    ...params.patch,
    completedStages: mergeCompletedStages(base.completedStages, params.stage),
    timingsMs: {
      ...base.timingsMs,
      [params.stage]: Math.max(0, Math.floor(params.durationMs)),
    },
    generatedAt: new Date().toISOString(),
  });
}

function findQuoteOffsets(chapters: ChapterSource[], chapterOrderIndex: number, text: string): { startChar: number; endChar: number } {
  const chapter = chapters.find((item) => item.orderIndex === chapterOrderIndex);
  if (!chapter) {
    return { startChar: 0, endChar: Math.max(1, text.length) };
  }

  const exact = chapter.rawText.indexOf(text);
  if (exact >= 0) {
    return {
      startChar: exact,
      endChar: exact + text.length,
    };
  }

  const normalizedNeedle = normalizeEntityName(text);
  const normalizedChapter = normalizeEntityName(chapter.rawText);
  const normalizedIndex = normalizedChapter.indexOf(normalizedNeedle);
  if (normalizedIndex >= 0) {
    return {
      startChar: normalizedIndex,
      endChar: normalizedIndex + text.length,
    };
  }

  return { startChar: 0, endChar: Math.max(1, text.length) };
}

async function persistProfiles(bookId: string, snapshot: BookExpertCoreSnapshot): Promise<void> {
  await prisma.$transaction(async (tx: any) => {
    await tx.book.update({
      where: { id: bookId },
      data: {
        summary: snapshot.bookBrief.shortSummary,
      },
    });

    await tx.bookCharacter.deleteMany({ where: { bookId } });
    await tx.bookTheme.deleteMany({ where: { bookId } });
    await tx.bookLocation.deleteMany({ where: { bookId } });

    if (snapshot.characters.length > 0) {
      await tx.bookCharacter.createMany({
        data: snapshot.characters.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          role: item.role,
          description: item.description,
          arc: item.arc,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }

    if (snapshot.themes.length > 0) {
      await tx.bookTheme.createMany({
        data: snapshot.themes.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: item.description,
          development: item.development,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }

    if (snapshot.locations.length > 0) {
      await tx.bookLocation.createMany({
        data: snapshot.locations.map((item) => ({
          id: item.id,
          bookId,
          name: item.name,
          normalizedName: item.normalizedName,
          description: item.description,
          significance: item.significance,
          mentionCount: item.mentionCount,
          firstAppearanceChapterOrder: item.firstAppearanceChapterOrder,
        })),
      });
    }
  });
}

async function persistQuotes(bookId: string, snapshot: BookExpertCoreSnapshot, chapters: ChapterSource[]): Promise<void> {
  const characterIds = new Map(snapshot.characters.map((item) => [item.normalizedName, item.id] as const));
  const themeIds = new Map(snapshot.themes.map((item) => [item.normalizedName, item.id] as const));
  const locationIds = new Map(snapshot.locations.map((item) => [item.normalizedName, item.id] as const));

  await prisma.$transaction(async (tx: any) => {
    await tx.bookCharacterQuote.deleteMany({
      where: {
        character: {
          bookId,
        },
      },
    });
    await tx.bookThemeQuote.deleteMany({
      where: {
        theme: {
          bookId,
        },
      },
    });
    await tx.bookLocationQuote.deleteMany({
      where: {
        location: {
          bookId,
        },
      },
    });
    await tx.bookQuoteTagLink.deleteMany({
      where: {
        quote: {
          bookId,
        },
      },
    });
    await tx.bookQuoteMention.deleteMany({
      where: {
        quote: {
          bookId,
        },
      },
    });
    await tx.bookQuote.deleteMany({ where: { bookId } });

    if (snapshot.quoteBank.length > 0) {
      await tx.bookQuote.createMany({
        data: snapshot.quoteBank.map((quote) => {
          const offsets = findQuoteOffsets(chapters, quote.chapterOrderIndex, quote.text);
          return {
            id: quote.id,
            bookId,
            chapterOrderIndex: quote.chapterOrderIndex,
            startChar: offsets.startChar,
            endChar: offsets.endChar,
            text: quote.text,
            type: quote.type,
            confidence: quote.confidence,
            commentary: quote.commentary,
          };
        }),
      });

      const tagRows = snapshot.quoteBank.flatMap((quote) =>
        quote.tags.map((tag) => ({
          quoteId: quote.id,
          tag,
        }))
      );
      if (tagRows.length > 0) {
        await tx.bookQuoteTagLink.createMany({ data: tagRows });
      }

      const mentionRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions.map((mention, index) => ({
          id: hashId("mention", [quote.id, mention.kind, mention.normalizedValue, index]),
          quoteId: quote.id,
          // Canonical entity ids are resolved in semantic core, but BookEntity rows are materialized later.
          // Persist mentions first and backfill entityId in entity_graph after entities exist.
          entityId: null,
          kind: mention.kind,
          value: mention.value,
          normalizedValue: mention.normalizedValue,
          resolutionStatus: mention.resolutionStatus,
          startChar: 0,
          endChar: Math.max(1, mention.value.length),
          confidence: mention.confidence,
        }))
      );
      if (mentionRows.length > 0) {
        await tx.bookQuoteMention.createMany({ data: mentionRows });
      }

      const characterQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "character")
          .map((mention, index) => {
            const characterId =
              mention.entityId ||
              characterIds.get(normalizeEntityName(mention.candidateCanonicalName || "")) ||
              characterIds.get(mention.normalizedValue);
            if (!characterId) return null;
            return {
              id: hashId("character_quote", [quote.id, characterId, index]),
              bookCharacterId: characterId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (characterQuoteRows.length > 0) {
        await tx.bookCharacterQuote.createMany({ data: characterQuoteRows });
      }

      const themeQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "theme")
          .map((mention, index) => {
            const themeId =
              mention.entityId ||
              themeIds.get(normalizeEntityName(mention.candidateCanonicalName || "")) ||
              themeIds.get(mention.normalizedValue);
            if (!themeId) return null;
            return {
              id: hashId("theme_quote", [quote.id, themeId, index]),
              bookThemeId: themeId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (themeQuoteRows.length > 0) {
        await tx.bookThemeQuote.createMany({ data: themeQuoteRows });
      }

      const locationQuoteRows = snapshot.quoteBank.flatMap((quote) =>
        quote.mentions
          .filter((mention) => mention.kind === "location")
          .map((mention, index) => {
            const locationId =
              mention.entityId ||
              locationIds.get(normalizeEntityName(mention.candidateCanonicalName || "")) ||
              locationIds.get(mention.normalizedValue);
            if (!locationId) return null;
            return {
              id: hashId("location_quote", [quote.id, locationId, index]),
              bookLocationId: locationId,
              chapterOrderIndex: quote.chapterOrderIndex,
              text: quote.text,
              context: quote.commentary || quote.text,
            };
          })
          .filter(Boolean)
      );
      if (locationQuoteRows.length > 0) {
        await tx.bookLocationQuote.createMany({ data: locationQuoteRows });
      }
    }
  });
}

async function runStage(params: {
  analyzerType: CoreAnalyzerType;
  bookId: string;
  handler: (ctx: {
    book: LoadedBookSource;
    chapters: ChapterSource[];
    snapshot: BookExpertCoreSnapshot | null;
    startedAt: Date;
  }) => Promise<{
    snapshot: BookExpertCoreSnapshot;
    nextStage?: CoreAnalyzerType | null;
    metadataPatch?: Partial<BookAnalyzerTaskMetadata>;
  }>;
}): Promise<AnalyzerExecutionResult> {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    throw new Error(`Invalid ${params.analyzerType} payload: bookId is required`);
  }

  try {
    const snapshotBefore = await readSnapshot(bookId);
    const dependency = CORE_STAGE_DEPENDENCIES[params.analyzerType];
    if (dependency) {
      const dependencyTask = await prisma.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: dependency as any,
          },
        },
        select: { state: true },
      });
      if (dependencyTask?.state !== "completed") {
        const reason = `Book expert core stage ${params.analyzerType} deferred until dependency ${dependency} completes`;
        await updateTaskState({
          bookId,
          analyzerType: params.analyzerType,
          state: "queued",
          error: null,
          startedAt: null,
          completedAt: null,
          metadataPatch: {
            deferredReason: reason,
            lastReason: reason,
          },
        });
        logger.info(
          {
            bookId,
            analyzerType: params.analyzerType,
            dependency,
            dependencyState: dependencyTask?.state || "missing",
            completedStages: snapshotBefore?.completedStages || [],
          },
          "Book expert core stage deferred until dependency task completes"
        );
        return deferredDependenciesExecution(reason, workerConfig.outbox.deferredDependenciesDelayMs);
      }
    }
    if (snapshotBefore?.completedStages.includes(params.analyzerType)) {
      const task = await prisma.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId,
            analyzerType: params.analyzerType as any,
          },
        },
        select: { state: true },
      });
      if (task?.state === "completed") {
        return completedExecution(`Book expert core stage ${params.analyzerType} already completed`);
      }
    }

    const startedAt = new Date();
    const claim = await claimQueuedAnalyzerTaskExecution({
      bookId,
      analyzerType: params.analyzerType,
      startedAt,
    });
    if (claim === "completed") {
      return completedExecution(`Book expert core stage ${params.analyzerType} already completed`);
    }
    if (claim === "running") {
      return deferredLockExecution(
        `Book expert core stage ${params.analyzerType} deferred because task is already running`,
        workerConfig.outbox.deferredLockDelayMs
      );
    }

    await markBookAnalysisRunning(bookId, startedAt);
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "running",
      error: null,
      startedAt,
      completedAt: null,
      metadataPatch: {
        deferredReason: null,
        lastReason: null,
      },
    });

    const { book, chapters } = await loadBookSource(bookId);
    const result = await params.handler({
      book,
      chapters,
      snapshot: snapshotBefore,
      startedAt,
    });

    await saveSnapshot(bookId, result.snapshot);
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "completed",
      error: null,
      startedAt,
      completedAt: new Date(),
      metadataPatch: mergeMetadataPatch(result.metadataPatch || {}, {
        deferredReason: null,
      }),
    });

    if (params.analyzerType === "core_literary") {
      logger.info(
        {
          bookId,
          upload_to_expert_ms: Math.max(0, Date.now() - book.createdAt.getTime()),
          timingsMs: result.snapshot.timingsMs,
          completedStages: result.snapshot.completedStages,
        },
        "Book expert core completed"
      );
    } else {
      logger.info(
        {
          bookId,
          analyzerType: params.analyzerType,
          upload_to_fast_ms:
            params.analyzerType === "core_window_scan" ? Math.max(0, Date.now() - book.createdAt.getTime()) : null,
          window_count: result.snapshot.windowScans.length || null,
          timingsMs: result.snapshot.timingsMs,
          completedStages: result.snapshot.completedStages,
        },
        "Book expert core stage completed"
      );
    }

    if (result.nextStage) {
      await queueNextStage(bookId, result.nextStage);
    }

    if (params.analyzerType === "core_quotes_finalize") {
      await enqueueBookAnalyzerStage({
        bookId,
        analyzerType: "quote_store",
        publishEvent: true,
      });
    }

    if (params.analyzerType === "core_literary") {
      await enqueueBookAnalyzerStage({
        bookId,
        analyzerType: "summary_store",
        publishEvent: true,
      });
    }

    await refreshBookAnalysisLifecycle(bookId);

    return completedExecution();
  } catch (error) {
    const message = safeErrorMessage(error);
    if (error instanceof RetryableAnalyzerError) {
      await updateTaskState({
        bookId,
        analyzerType: params.analyzerType,
        state: "queued",
        error: null,
        startedAt: null,
        completedAt: null,
        metadataPatch: {
          deferredReason: message,
          lastReason: message,
        },
      });
      return retryableFailureExecution(
        message,
        error.availableAt instanceof Date
          ? Math.max(1_000, error.availableAt.getTime() - Date.now())
          : workerConfig.outbox.retryableFailureDelayMs
      );
    }
    await updateTaskState({
      bookId,
      analyzerType: params.analyzerType,
      state: "failed",
      error: message,
      completedAt: new Date(),
      metadataPatch: {
        deferredReason: null,
        lastReason: message,
        lastValidationError: message,
      },
    });
    await prisma.book.updateMany({
      where: { id: bookId },
      data: {
        analysisState: "failed",
        analysisError: message,
        analysisCompletedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function processBookCoreWindowScan(payload: StagePayload) {
  return runStage({
    analyzerType: "core_window_scan",
    bookId: payload.bookId,
    handler: async ({ book, chapters, snapshot, startedAt }) => {
      const windows = chunkChaptersIntoWindows(chapters);
      if (windows.length === 0) {
        throw new Error("Book has no non-empty chapters for semantic core window scan");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};

      const scans = await mapWithConcurrency(windows, WINDOW_SCAN_CONCURRENCY, async (window) => {
        const call = await callStrictJson({
          phase: "book_core_window_scan",
          prompt: buildWindowScanPrompt(book, window),
          schema: WindowScanModelOutputSchema,
          allowedModels: [workerConfig.vertex.modelByTier.lite],
          disableGlobalFallback: true,
          maxAttempts: 2,
          vertexModel: workerConfig.vertex.modelByTier.lite,
          vertexThinkingLevel: "MINIMAL",
          maxTokens: 3200,
          onAttempt: (attempt) => {
            metadataPatch = registerStrictJsonAttempt(metadataPatch, {
              model: attempt.model,
              usage: attempt.usage,
              error: attempt.error,
              success: attempt.success,
            });
          },
        });
        logger.info(
          {
            bookId: book.id,
            analyzerType: "core_window_scan",
            windowIndex: window.windowIndex,
            chapterFrom: window.chapterFrom,
            chapterTo: window.chapterTo,
            provider: call.meta.provider,
            model: call.meta.model,
            latencyMs: call.meta.latencyMs,
            promptTokens: call.meta.usage?.promptTokens ?? null,
            completionTokens: call.meta.usage?.completionTokens ?? null,
          },
          "Book expert core window scanned"
        );
        return normalizeWindowScan(window, call.result);
      });

      const merged = mergeWindowScans(book.id, scans);
      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: snapshot,
        stage: "core_window_scan",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          windowScans: scans,
          ...merged,
        },
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_merge",
        metadataPatch,
      };
    },
  });
}

export async function processBookCoreMerge(payload: StagePayload) {
  return runStage({
    analyzerType: "core_merge",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current || current.windowScans.length === 0) {
        throw new Error("core_merge requires completed window scans");
      }

      const merged = mergeWindowScans(book.id, current.windowScans);
      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_merge",
        durationMs: Date.now() - startedAt.getTime(),
        patch: merged,
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_resolve",
      };
    },
  });
}

export async function processBookCoreResolve(payload: StagePayload) {
  return runStage({
    analyzerType: "core_resolve",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_resolve requires semantic core snapshot");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};
      const baseResolved = resolveSnapshotRefs(current);
      let resolved = baseResolved;

      try {
        const resolvedSnapshot = BookExpertCoreSnapshotSchema.parse({
          ...current,
          ...baseResolved,
        });
        const refinedRelationCandidates = await refineRelationCandidates({
          book,
          snapshot: resolvedSnapshot,
          onAttempt: async (attempt) => {
            metadataPatch = registerStrictJsonAttempt(metadataPatch, {
              ...attempt,
              error: attempt.error || undefined,
            });
          },
        });
        const linkedSnapshot = await linkSnapshotUnresolvedRefs({
          book,
          snapshot: {
            ...resolvedSnapshot,
            relationCandidates: refinedRelationCandidates,
          },
          onAttempt: async (attempt) => {
            metadataPatch = registerStrictJsonAttempt(metadataPatch, {
              ...attempt,
              error: attempt.error || undefined,
            });
          },
        });
        resolved = resolveSnapshotRefs({
          ...resolvedSnapshot,
          incidents: linkedSnapshot.incidents,
          groups: linkedSnapshot.groups,
          relationCandidates: linkedSnapshot.relationCandidates,
        });
      } catch (error) {
        const reason = safeErrorMessage(error);
        metadataPatch = mergeMetadataPatch(metadataPatch, {
          degraded: true,
          fallbackKind: "resolved_relation_candidates",
          lastReason: reason,
          lastValidationError: reason,
        });
        logger.warn(
          {
            bookId: book.id,
            analyzerType: "core_resolve",
            reason,
          },
          "Book expert core relation refinement degraded to resolved snapshot"
        );
      }

      const membershipTotal = resolved.groups.reduce((sum, group) => sum + group.members.length, 0);
      const membershipResolved = resolved.groups.reduce(
        (sum, group) => sum + group.members.filter((member) => member.resolutionStatus === "resolved").length,
        0
      );

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_resolve",
        durationMs: Date.now() - startedAt.getTime(),
        patch: resolved,
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_entity_mentions",
        metadataPatch: mergeMetadataPatch(metadataPatch, {
          resolvedMembershipRate: computeResolvedRate(membershipResolved, membershipTotal),
        }),
      };
    },
  });
}

export async function processBookCoreEntityMentions(payload: StagePayload) {
  return runStage({
    analyzerType: "core_entity_mentions",
    bookId: payload.bookId,
    handler: async ({ book, chapters, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_entity_mentions requires semantic core snapshot");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};
      const runExtraction = async () =>
        extractEntityMentionBank({
          book,
          chapters,
          snapshot: current,
          onAttempt: (attempt) => {
            metadataPatch = registerStrictJsonAttempt(metadataPatch, {
              model: attempt.model,
              usage: attempt.usage,
              error: attempt.error,
              success: attempt.success,
            });
          },
        });

      let entityMentionBank = await runExtraction();
      const entityCount =
        current.characters.length +
        current.themes.length +
        current.locations.length +
        current.groups.length;
      if (entityCount > 0 && entityMentionBank.length === 0) {
        metadataPatch = mergeMetadataPatch(metadataPatch, {
          degraded: true,
          fallbackKind: "entity_mentions_retry",
          lastReason: "Entity mention bank was empty after first pass",
        });
        entityMentionBank = await runExtraction();
      }

      const entityIdsWithMentions = new Set(entityMentionBank.map((mention) => mention.entityId));
      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_entity_mentions",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          entityMentionBank,
        },
      });

      return {
        snapshot: nextSnapshot,
        nextStage: "core_profiles",
        metadataPatch: mergeMetadataPatch(metadataPatch, {
          entityMentionCount: entityMentionBank.length,
          entitiesWithMentionsRate: computeResolvedRate(entityIdsWithMentions.size, entityCount),
        }),
      };
    },
  });
}

export async function processBookCoreProfiles(payload: StagePayload) {
  return runStage({
    analyzerType: "core_profiles",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_profiles requires semantic core snapshot");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};
      let fallbackUsed = false;
      const scenes = await prisma.bookScene.findMany({
        where: { bookId: book.id },
        select: {
          orderIndex: true,
          chapter: { select: { orderIndex: true } },
        },
        orderBy: [{ orderIndex: "asc" }],
      });
      const sceneOrderByChapter = new Map<string, number>();
      for (const scene of scenes) {
        const key = `chapter:${scene.chapter.orderIndex}`;
        if (!sceneOrderByChapter.has(key)) {
          sceneOrderByChapter.set(key, scene.orderIndex);
        }
      }

      const buildFallbackPatch = (
        kind: "characters" | "themes" | "locations" | "groups",
        item:
          | BookExpertCoreSnapshot["characters"][number]
          | BookExpertCoreSnapshot["themes"][number]
          | BookExpertCoreSnapshot["locations"][number]
          | BookExpertCoreSnapshot["groups"][number],
        evidencePack: Record<string, unknown>
      ) => buildDeterministicProfilePatch(kind, item, evidencePack);

      const refineProfiles = async <TPatch extends { id?: string; normalizedName?: string; name?: string; degraded?: boolean }, TItem extends { id: string; normalizedName: string; name: string }>(params: {
        kind: "characters" | "themes" | "locations" | "groups";
        items: TItem[];
        schema: z.ZodType<{ items: TPatch[] }, z.ZodTypeDef, unknown>;
        merge: (items: TItem[], patches: TPatch[]) => TItem[];
        maxTokens: number;
      }): Promise<TItem[]> => {
        if (params.items.length === 0) return [];
        const evidenceItems = params.items.map((item) => ({
          item,
          evidencePack: buildProfileEvidencePack({
            kind: params.kind,
            item: item as never,
            snapshot: current,
            sceneOrderById: sceneOrderByChapter,
          }),
        }));

        let patches: TPatch[] = evidenceItems
          .filter((entry) => Boolean(entry.evidencePack.evidenceWeak))
          .map((entry) => buildFallbackPatch(params.kind, entry.item as never, entry.evidencePack) as unknown as TPatch);

        const strongItems = evidenceItems.filter((entry) => !entry.evidencePack.evidenceWeak);
        const runProfilePass = async (items: typeof strongItems) => {
          const batches = chunkIntoBatches(items, PROFILE_BATCH_SIZE);
          for (const batch of batches) {
            try {
              const result = await callStrictJson({
                phase: "book_core_profiles",
                prompt: buildProfilesPrompt({
                  kind: params.kind,
                  book,
                  bookBrief: current.bookBrief,
                  plotSpine: current.plotSpine,
                  items: batch.map((entry) => ({
                    id: entry.item.id,
                    normalizedName: entry.item.normalizedName,
                    name: entry.item.name,
                    evidence: entry.evidencePack,
                  })),
                }),
                schema: params.schema,
                allowedModels: buildVertexAllowedModels("lite", "flash"),
                disableGlobalFallback: true,
                maxAttempts: 1,
                vertexModel: workerConfig.vertex.modelByTier.lite,
                vertexThinkingLevel: null,
                maxTokens: params.maxTokens,
                onAttempt: (attempt) => {
                  metadataPatch = registerStrictJsonAttempt(metadataPatch, {
                    model: attempt.model,
                    usage: attempt.usage,
                    error: attempt.error,
                    success: attempt.success,
                  });
                },
              });
              logger.info(
                {
                  bookId: book.id,
                  analyzerType: "core_profiles",
                  kind: params.kind,
                  batchSize: batch.length,
                  selected_model: result.meta.model,
                  llm_attempt_count: result.meta.attempt,
                  fallback_used: false,
                  latencyMs: result.meta.latencyMs,
                },
                "Book expert core profiles refined"
              );
              patches = patches.concat(result.result.items);
            } catch (error) {
              fallbackUsed = true;
              metadataPatch = mergeMetadataPatch(metadataPatch, {
                degraded: true,
                fallbackKind: "evidence_backed_profiles",
                lastReason: safeErrorMessage(error),
                lastValidationError: safeErrorMessage(error),
              });
              logger.warn(
                {
                  bookId: book.id,
                  analyzerType: "core_profiles",
                  kind: params.kind,
                  batchSize: batch.length,
                  error: safeErrorMessage(error),
                },
                "Book expert core profiles batch failed, falling back to factual profile patches"
              );
              patches = patches.concat(batch.map((entry) => buildFallbackPatch(params.kind, entry.item as never, entry.evidencePack) as unknown as TPatch));
            }
          }
        };

        await runProfilePass(strongItems);
        let mergedItems = params.merge(params.items, patches);
        let degradedRate = computeResolvedRate(
          mergedItems.filter((item) => "profileDegraded" in item && Boolean((item as { profileDegraded?: boolean }).profileDegraded)).length,
          mergedItems.length
        );

        if (strongItems.length > 0 && degradedRate > 0.5) {
          const degradedStrongItems = strongItems.filter((entry) =>
            mergedItems.some((item) => item.id === entry.item.id && "profileDegraded" in item && Boolean((item as { profileDegraded?: boolean }).profileDegraded))
          );
          if (degradedStrongItems.length > 0) {
            await runProfilePass(degradedStrongItems);
            mergedItems = params.merge(params.items, patches);
            degradedRate = computeResolvedRate(
              mergedItems.filter((item) => "profileDegraded" in item && Boolean((item as { profileDegraded?: boolean }).profileDegraded)).length,
              mergedItems.length
            );
          }
        }

        return mergedItems;
      };

      const [charactersItems, themesItems, locationsItems, groupsItems] = await Promise.all([
        refineProfiles({
          kind: "characters",
          items: current.characters,
          schema: CharacterBatchSchema,
          merge: mergeCharacterProfilePatches,
          maxTokens: 2200,
        }),
        refineProfiles({
          kind: "themes",
          items: current.themes,
          schema: ThemeBatchSchema,
          merge: mergeThemeProfilePatches,
          maxTokens: 2000,
        }),
        refineProfiles({
          kind: "locations",
          items: current.locations,
          schema: LocationBatchSchema,
          merge: mergeLocationProfilePatches,
          maxTokens: 2000,
        }),
        refineProfiles({
          kind: "groups",
          items: current.groups,
          schema: GroupBatchSchema,
          merge: mergeGroupProfilePatches,
          maxTokens: 2000,
        }),
      ]);

      const profileSnapshot = BookExpertCoreSnapshotSchema.parse({
        ...current,
        characters: charactersItems,
        themes: themesItems,
        locations: locationsItems,
        groups: groupsItems,
      });

      await persistProfiles(book.id, profileSnapshot);

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_profiles",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          characters: profileSnapshot.characters,
          themes: profileSnapshot.themes,
          locations: profileSnapshot.locations,
          groups: profileSnapshot.groups,
        },
      });

      const allProfiles = [
        ...profileSnapshot.characters,
        ...profileSnapshot.themes,
        ...profileSnapshot.locations,
        ...profileSnapshot.groups,
      ];
      const degradedEntitySummaryRate = computeResolvedRate(
        allProfiles.filter((item) => item.profileDegraded).length,
        allProfiles.length
      );

      return {
        snapshot: nextSnapshot,
        nextStage: "core_quotes_finalize",
        metadataPatch: mergeMetadataPatch(
          fallbackUsed
            ? mergeMetadataPatch(metadataPatch, {
                degraded: true,
                fallbackKind: "evidence_backed_profiles",
              })
            : metadataPatch,
          {
            degradedEntitySummaryRate,
          }
        ),
      };
    },
  });
}

export async function processBookCoreQuotesFinalize(payload: StagePayload) {
  return runStage({
    analyzerType: "core_quotes_finalize",
    bookId: payload.bookId,
    handler: async ({ book, chapters, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_quotes_finalize requires semantic core snapshot");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};
      let quoteSnapshot = current;

      try {
        const runQuoteRefinement = async (snapshotForRun: typeof current) => {
          const refinedQuoteBank = await refineQuoteBankMentions({
            book,
            snapshot: snapshotForRun,
            onAttempt: (attempt) => {
              metadataPatch = registerStrictJsonAttempt(metadataPatch, {
                model: attempt.model,
                usage: attempt.usage,
                error: attempt.error,
                success: attempt.success,
              });
            },
          });
          const resolved = resolveSnapshotRefs({
            ...snapshotForRun,
            quoteBank: refinedQuoteBank,
          });
          return BookExpertCoreSnapshotSchema.parse({
            ...snapshotForRun,
            quoteBank: resolved.quoteBank,
          });
        };

        quoteSnapshot = await runQuoteRefinement(current);
        const mentionTotal = quoteSnapshot.quoteBank.reduce((sum, quote) => sum + quote.mentions.length, 0);
        const mentionResolved = quoteSnapshot.quoteBank.reduce(
          (sum, quote) => sum + quote.mentions.filter((mention) => mention.resolutionStatus === "resolved").length,
          0
        );
        if (mentionTotal > 0 && computeResolvedRate(mentionResolved, mentionTotal) < 0.35) {
          metadataPatch = mergeMetadataPatch(metadataPatch, {
            degraded: true,
            fallbackKind: "quote_refinement_retry",
            lastReason: "Resolved quote mention rate below safe baseline after first pass",
          });
          quoteSnapshot = await runQuoteRefinement(quoteSnapshot);
        }
      } catch (error) {
        metadataPatch = mergeMetadataPatch(metadataPatch, {
          degraded: true,
          fallbackKind: "window_quote_mentions",
          lastReason: safeErrorMessage(error),
          lastValidationError: safeErrorMessage(error),
        });
        logger.warn(
          {
            bookId: book.id,
            analyzerType: "core_quotes_finalize",
            error: safeErrorMessage(error),
            fallback_used: true,
          },
          "Book expert core quote mention refinement failed, keeping window-scan mentions"
        );
      }

      await persistProfiles(book.id, quoteSnapshot);
      await persistQuotes(book.id, quoteSnapshot, chapters);

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_quotes_finalize",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          quoteBank: quoteSnapshot.quoteBank,
        },
      });

      const quoteMentionTotal = quoteSnapshot.quoteBank.reduce((sum, quote) => sum + quote.mentions.length, 0);
      const quoteMentionResolved = quoteSnapshot.quoteBank.reduce(
        (sum, quote) => sum + quote.mentions.filter((mention) => mention.resolutionStatus === "resolved").length,
        0
      );

      return {
        snapshot: nextSnapshot,
        nextStage: "core_literary",
        metadataPatch: mergeMetadataPatch(metadataPatch, {
          resolvedQuoteMentionRate: computeResolvedRate(quoteMentionResolved, quoteMentionTotal),
        }),
      };
    },
  });
}

export async function processBookCoreLiterary(payload: StagePayload) {
  return runStage({
    analyzerType: "core_literary",
    bookId: payload.bookId,
    handler: async ({ book, snapshot, startedAt }) => {
      const current = snapshot || (await readSnapshot(book.id));
      if (!current) {
        throw new Error("core_literary requires semantic core snapshot");
      }
      if (current.quoteBank.length === 0) {
        throw new Error("core_literary requires quote bank");
      }

      let metadataPatch: Partial<BookAnalyzerTaskMetadata> = {};
      let patternMap: LiteraryPatternMap;
      let patternFallbackUsed = false;
      try {
        const patternMapCall = await callStrictJson({
          phase: "book_core_literary_pattern",
          prompt: buildLiteraryPatternPrompt(current),
          schema: LooseLiteraryPatternSchema,
          allowedModels: buildVertexAllowedModels("lite", "flash"),
          disableGlobalFallback: true,
          maxAttempts: 1,
          vertexModel: workerConfig.vertex.modelByTier.lite,
          vertexThinkingLevel: null,
          maxTokens: 2200,
          onAttempt: (attempt) => {
            metadataPatch = registerStrictJsonAttempt(metadataPatch, {
              model: attempt.model,
              usage: attempt.usage,
              error: attempt.error,
              success: attempt.success,
            });
          },
        });
        patternMap = normalizeLiteraryPatternMap(current, patternMapCall.result);
        logger.info(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "pattern",
            selected_model: patternMapCall.meta.model,
            llm_attempt_count: patternMapCall.meta.attempt,
            fallback_used: false,
            latencyMs: patternMapCall.meta.latencyMs,
          },
          "Book expert core literary pattern map built"
        );
      } catch (error) {
        patternFallbackUsed = true;
        metadataPatch = mergeMetadataPatch(metadataPatch, {
          degraded: true,
          fallbackKind: "deterministic_pattern_map",
          lastReason: safeErrorMessage(error),
          lastValidationError: safeErrorMessage(error),
        });
        logger.warn(
          {
            bookId: book.id,
            analyzerType: "core_literary",
            stage: "pattern",
            error: safeErrorMessage(error),
            fallback_used: true,
          },
          "Book expert core literary pattern map failed, using deterministic fallback"
        );
        patternMap = buildDeterministicPatternMap(current);
      }

      const fallbackSections: LiterarySectionsRecord = normalizeLiterarySectionsRecord(
        buildDeterministicLiterarySections(current, patternMap)
      );
      const quoteIdSet = new Set(current.quoteBank.map((quote) => quote.id));
      const sectionFallbackKeys: LiterarySectionKey[] = [];
      const literarySections: LiterarySectionsRecord = { ...fallbackSections };

      for (const sectionKey of BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS) {
        try {
          const sectionCall = await callStrictJson({
            phase: "book_core_literary_synthesis",
            prompt: buildLiterarySectionPrompt({
              snapshot: current,
              patternMap,
              fallbackSections,
              sectionKey,
            }),
            schema: LooseLiterarySectionPatchSchema,
            allowedModels: buildVertexAllowedModels("lite", "flash"),
            disableGlobalFallback: true,
            maxAttempts: 1,
            vertexModel: workerConfig.vertex.modelByTier.lite,
            vertexThinkingLevel: null,
            maxTokens: Math.min(1_800, workerConfig.vertex.literaryMaxTokens),
            onAttempt: (attempt) => {
              metadataPatch = registerStrictJsonAttempt(metadataPatch, {
                model: attempt.model,
                usage: attempt.usage,
                error: attempt.error,
                success: attempt.success,
              });
            },
          });

          literarySections[sectionKey] = normalizeLiterarySection(fallbackSections[sectionKey], {
            key: sectionKey,
            title: sectionCall.result.title,
            summary: sectionCall.result.summary,
            bodyMarkdown: sectionCall.result.bodyMarkdown,
            bullets: sectionCall.result.bullets,
            evidenceQuoteIds: dedupeStrings(
              (sectionCall.result.evidenceQuoteIds || []).filter((quoteId) => quoteIdSet.has(quoteId)),
              10
            ),
            confidence: clampUnitInterval(sectionCall.result.confidence, fallbackSections[sectionKey].confidence),
          });

          logger.info(
            {
              bookId: book.id,
              analyzerType: "core_literary",
              stage: "section",
              sectionKey,
              selected_model: sectionCall.meta.model,
              llm_attempt_count: sectionCall.meta.attempt,
              fallback_used: false,
              latencyMs: sectionCall.meta.latencyMs,
              pattern_fallback_used: patternFallbackUsed,
            },
            "Book expert core literary section built"
          );
        } catch (error) {
          sectionFallbackKeys.push(sectionKey);
          metadataPatch = mergeMetadataPatch(metadataPatch, {
            degraded: true,
            fallbackKind: patternFallbackUsed ? "deterministic_pattern_and_sections" : "deterministic_sections",
            lastReason: safeErrorMessage(error),
            lastValidationError: safeErrorMessage(error),
          });
          logger.warn(
            {
              bookId: book.id,
              analyzerType: "core_literary",
              stage: "section",
              sectionKey,
              error: safeErrorMessage(error),
              fallback_used: true,
              pattern_fallback_used: patternFallbackUsed,
            },
            "Book expert core literary section failed, using deterministic fallback"
          );
          literarySections[sectionKey] = fallbackSections[sectionKey];
        }
      }

      const normalizedSections = normalizeLiterarySectionsRecord(literarySections);

      const nextSnapshot = buildSnapshotWithStage({
        bookId: book.id,
        previous: current,
        stage: "core_literary",
        durationMs: Date.now() - startedAt.getTime(),
        patch: {
          literarySections: normalizedSections,
        },
      });

      await prisma.bookLiteraryAnalysis.upsert({
        where: { bookId: book.id },
        create: {
          bookId: book.id,
          sectionsJson: normalizedSections,
        },
        update: {
          sectionsJson: normalizedSections,
        },
      });

      return {
        snapshot: nextSnapshot,
        nextStage: null,
        metadataPatch: mergeMetadataPatch(metadataPatch, {
          degraded: patternFallbackUsed || sectionFallbackKeys.length > 0,
          fallbackKind:
            sectionFallbackKeys.length > 0
              ? patternFallbackUsed
                ? "deterministic_pattern_and_sections"
                : "deterministic_sections"
              : patternFallbackUsed
                ? "deterministic_pattern_map"
                : metadataPatch.fallbackKind,
          lastReason:
            sectionFallbackKeys.length > 0
              ? `Literary fallback used for sections: ${sectionFallbackKeys.join(", ")}`
              : metadataPatch.lastReason,
        }),
      };
    },
  });
}

export const __processBookExpertCoreTestUtils = {
  mergeWindowScans,
  normalizeWindowScan,
  resolveSnapshotRefs,
  applyQuoteMentionRefinement,
  applyRelationCandidateRefinement,
  buildDeterministicProfilePatch,
  mergeCharacterProfilePatches,
};
