import { z } from "zod";

export const BOOK_EXPERT_CORE_VERSION = 2;

export const BOOK_EXPERT_CORE_STAGE_KEYS = [
  "core_window_scan",
  "core_merge",
  "core_profiles",
  "core_quotes_finalize",
  "core_literary",
] as const;
export type BookExpertCoreStageKey = (typeof BOOK_EXPERT_CORE_STAGE_KEYS)[number];
export const BookExpertCoreStageKeySchema = z.enum(BOOK_EXPERT_CORE_STAGE_KEYS);

export const BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS = [
  "what_is_really_going_on",
  "main_idea",
  "how_it_works",
  "hidden_details",
  "characters",
  "conflicts",
  "structure",
  "important_turns",
  "takeaways",
  "conclusion",
] as const;
export type BookExpertCoreLiterarySectionKey = (typeof BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS)[number];
export const BookExpertCoreLiterarySectionKeySchema = z.enum(BOOK_EXPERT_CORE_LITERARY_SECTION_KEYS);

export const BookExpertCoreEvidenceAnchorSchema = z.object({
  chapterOrderIndex: z.number().int().min(1),
  startChar: z.number().int().min(0).nullable().optional(),
  endChar: z.number().int().min(0).nullable().optional(),
  snippet: z.string().trim().min(1).max(400),
});
export type BookExpertCoreEvidenceAnchor = z.infer<typeof BookExpertCoreEvidenceAnchorSchema>;

export const BookExpertCoreWindowSourceSchema = z.object({
  windowIndex: z.number().int().min(1),
  chapterFrom: z.number().int().min(1),
  chapterTo: z.number().int().min(1),
  chapterCount: z.number().int().min(1),
  textChars: z.number().int().min(0),
});
export type BookExpertCoreWindowSource = z.infer<typeof BookExpertCoreWindowSourceSchema>;

export const BookExpertCorePlotPointSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(180),
  summary: z.string().trim().min(1).max(800),
  chapterOrderIndex: z.number().int().min(1),
  importance: z.number().min(0).max(1),
  anchors: z.array(BookExpertCoreEvidenceAnchorSchema).min(1).max(4),
  sourceWindows: z.array(BookExpertCoreWindowSourceSchema).max(4).default([]),
});
export type BookExpertCorePlotPoint = z.infer<typeof BookExpertCorePlotPointSchema>;

const BookExpertCoreEntityBaseSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  normalizedName: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  mentionCount: z.number().int().min(0),
  firstAppearanceChapterOrder: z.number().int().min(1).nullable(),
  anchors: z.array(BookExpertCoreEvidenceAnchorSchema).max(4).default([]),
  sourceWindows: z.array(BookExpertCoreWindowSourceSchema).max(6).default([]),
});

export const BookExpertCoreCharacterSchema = BookExpertCoreEntityBaseSchema.extend({
  role: z.string().trim().min(1).max(220),
  description: z.string().trim().min(1).max(900),
  arc: z.string().trim().min(1).max(900),
  motivations: z.array(z.string().trim().min(1).max(220)).max(6).default([]),
});
export type BookExpertCoreCharacter = z.infer<typeof BookExpertCoreCharacterSchema>;

export const BookExpertCoreThemeSchema = BookExpertCoreEntityBaseSchema.extend({
  description: z.string().trim().min(1).max(900),
  development: z.string().trim().min(1).max(900),
});
export type BookExpertCoreTheme = z.infer<typeof BookExpertCoreThemeSchema>;

export const BookExpertCoreLocationSchema = BookExpertCoreEntityBaseSchema.extend({
  description: z.string().trim().min(1).max(900),
  significance: z.string().trim().min(1).max(900),
});
export type BookExpertCoreLocation = z.infer<typeof BookExpertCoreLocationSchema>;

export const BOOK_EXPERT_CORE_QUOTE_TYPES = [
  "dialogue",
  "monologue",
  "narration",
  "description",
  "reflection",
  "action",
] as const;
export type BookExpertCoreQuoteType = (typeof BOOK_EXPERT_CORE_QUOTE_TYPES)[number];
export const BookExpertCoreQuoteTypeSchema = z.enum(BOOK_EXPERT_CORE_QUOTE_TYPES);

export const BOOK_EXPERT_CORE_QUOTE_TAGS = [
  "conflict",
  "relationship",
  "identity",
  "morality",
  "power",
  "freedom",
  "fear",
  "guilt",
  "hope",
  "fate",
  "society",
  "violence",
  "love",
  "death",
  "faith",
] as const;
export type BookExpertCoreQuoteTag = (typeof BOOK_EXPERT_CORE_QUOTE_TAGS)[number];
export const BookExpertCoreQuoteTagSchema = z.enum(BOOK_EXPERT_CORE_QUOTE_TAGS);

export const BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS = ["character", "theme", "location"] as const;
export type BookExpertCoreQuoteMentionKind = (typeof BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS)[number];
export const BookExpertCoreQuoteMentionKindSchema = z.enum(BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS);

export const BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS = [
  ...BOOK_EXPERT_CORE_QUOTE_MENTION_KINDS,
  "unknown",
] as const;
export type BookExpertCoreIncidentParticipantKind = (typeof BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS)[number];
export const BookExpertCoreIncidentParticipantKindSchema = z.enum(BOOK_EXPERT_CORE_INCIDENT_PARTICIPANT_KINDS);

export const BookExpertCoreQuoteMentionSchema = z.object({
  kind: BookExpertCoreQuoteMentionKindSchema,
  value: z.string().trim().min(1).max(160),
  normalizedValue: z.string().trim().min(1).max(160),
  confidence: z.number().min(0).max(1),
});
export type BookExpertCoreQuoteMention = z.infer<typeof BookExpertCoreQuoteMentionSchema>;

export const BookExpertCoreIncidentParticipantSchema = z.object({
  kind: BookExpertCoreIncidentParticipantKindSchema,
  value: z.string().trim().min(1).max(160),
  normalizedValue: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(120),
  entityId: z.string().trim().min(1).max(80).nullable().default(null),
});
export type BookExpertCoreIncidentParticipant = z.infer<typeof BookExpertCoreIncidentParticipantSchema>;

export const BookExpertCoreIncidentSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  chapterFrom: z.number().int().min(1),
  chapterTo: z.number().int().min(1),
  importance: z.number().min(0).max(1),
  participants: z.array(BookExpertCoreIncidentParticipantSchema).max(12).default([]),
  facts: z.array(z.string().trim().min(1).max(260)).min(1).max(10),
  consequences: z.array(z.string().trim().min(1).max(260)).max(8).default([]),
  quoteIds: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  anchors: z.array(BookExpertCoreEvidenceAnchorSchema).min(1).max(4),
  sourceWindows: z.array(BookExpertCoreWindowSourceSchema).max(6).default([]),
});
export type BookExpertCoreIncident = z.infer<typeof BookExpertCoreIncidentSchema>;

export const BookExpertCoreQuoteSchema = z.object({
  id: z.string().trim().min(1).max(80),
  chapterOrderIndex: z.number().int().min(1),
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  text: z.string().trim().min(1).max(1400),
  type: BookExpertCoreQuoteTypeSchema,
  tags: z.array(BookExpertCoreQuoteTagSchema).max(8).default([]),
  commentary: z.string().trim().max(600).nullable().default(null),
  confidence: z.number().min(0).max(1),
  mentions: z.array(BookExpertCoreQuoteMentionSchema).max(16).default([]),
  anchors: z.array(BookExpertCoreEvidenceAnchorSchema).max(2).default([]),
  sourceWindows: z.array(BookExpertCoreWindowSourceSchema).max(4).default([]),
});
export type BookExpertCoreQuote = z.infer<typeof BookExpertCoreQuoteSchema>;

export const BookExpertCoreLiterarySectionSchema = z.object({
  key: BookExpertCoreLiterarySectionKeySchema,
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  bodyMarkdown: z.string().trim().min(1).max(6000),
  bullets: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
  evidenceQuoteIds: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  confidence: z.number().min(0).max(1),
});
export type BookExpertCoreLiterarySection = z.infer<typeof BookExpertCoreLiterarySectionSchema>;

export const BookExpertCoreWindowIncidentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  chapterFrom: z.number().int().min(1),
  chapterTo: z.number().int().min(1),
  importance: z.number().min(0).max(1),
  participants: z.array(BookExpertCoreIncidentParticipantSchema).max(12).default([]),
  facts: z.array(z.string().trim().min(1).max(260)).min(1).max(10),
  consequences: z.array(z.string().trim().min(1).max(260)).max(8).default([]),
  supportingQuoteTexts: z.array(z.string().trim().min(1).max(1200)).max(8).default([]),
  snippet: z.string().trim().min(1).max(280),
});
export type BookExpertCoreWindowIncident = z.infer<typeof BookExpertCoreWindowIncidentSchema>;

export const BookExpertCoreWindowScanSchema = z.object({
  windowIndex: z.number().int().min(1),
  chapterFrom: z.number().int().min(1),
  chapterTo: z.number().int().min(1),
  textChars: z.number().int().min(0),
  summary: z.string().trim().min(1).max(900),
  plotPoints: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(180),
        summary: z.string().trim().min(1).max(500),
        chapterOrderIndex: z.number().int().min(1),
        importance: z.number().min(0).max(1),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(12),
  characters: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        aliases: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
        roleHint: z.string().trim().min(1).max(240),
        traits: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
        motivations: z.array(z.string().trim().min(1).max(160)).max(6).default([]),
        arcHint: z.string().trim().min(1).max(320),
        chapterOrderIndex: z.number().int().min(1),
        importance: z.number().min(0).max(1),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(16),
  themes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(260),
        developmentHint: z.string().trim().min(1).max(320),
        chapterOrderIndex: z.number().int().min(1),
        importance: z.number().min(0).max(1),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(12),
  locations: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(260),
        significanceHint: z.string().trim().min(1).max(320),
        chapterOrderIndex: z.number().int().min(1),
        importance: z.number().min(0).max(1),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(12),
  quotes: z
    .array(
      z.object({
        chapterOrderIndex: z.number().int().min(1),
        startChar: z.number().int().min(0).nullable().default(null),
        endChar: z.number().int().min(0).nullable().default(null),
        text: z.string().trim().min(1).max(1200),
        type: BookExpertCoreQuoteTypeSchema,
        tags: z.array(BookExpertCoreQuoteTagSchema).max(8).default([]),
        commentary: z.string().trim().max(420).nullable().default(null),
        mentions: z.array(BookExpertCoreQuoteMentionSchema).max(16).default([]),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(24),
  incidents: z.array(BookExpertCoreWindowIncidentSchema).max(12).default([]),
});
export type BookExpertCoreWindowScan = z.infer<typeof BookExpertCoreWindowScanSchema>;

export const BookExpertCoreSnapshotSchema = z.object({
  version: z.number().int().min(1),
  bookId: z.string().trim().min(1),
  completedStages: z.array(BookExpertCoreStageKeySchema).default([]),
  timingsMs: z.record(z.string(), z.number().int().min(0)).default({}),
  bookBrief: z.object({
    shortSummary: z.string().trim().min(1).max(320),
    fullSummary: z.string().trim().min(1).max(1400),
    spoilerSummary: z.string().trim().min(1).max(1800),
  }),
  plotSpine: z.array(BookExpertCorePlotPointSchema).max(24),
  characters: z.array(BookExpertCoreCharacterSchema).max(16),
  themes: z.array(BookExpertCoreThemeSchema).max(12),
  locations: z.array(BookExpertCoreLocationSchema).max(12),
  quoteBank: z.array(BookExpertCoreQuoteSchema).max(80),
  incidents: z.array(BookExpertCoreIncidentSchema).max(32).default([]),
  literarySections: z.record(BookExpertCoreLiterarySectionKeySchema, BookExpertCoreLiterarySectionSchema).nullable().default(null),
  windowScans: z.array(BookExpertCoreWindowScanSchema).max(48).default([]),
  generatedAt: z.string().datetime(),
});
export type BookExpertCoreSnapshot = z.infer<typeof BookExpertCoreSnapshotSchema>;
