import { z } from "zod";

export const BOOK_EXPERT_CORE_VERSION = 4;

export const BOOK_EXPERT_CORE_STAGE_KEYS = [
  "core_window_scan",
  "core_merge",
  "core_resolve",
  "core_entity_mentions",
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
  profileDegraded: z.boolean().optional(),
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

export const BOOK_EXPERT_CORE_GROUP_FACETS = [
  "family",
  "household",
  "team",
  "institution",
  "collective",
] as const;
export type BookExpertCoreGroupFacet = (typeof BOOK_EXPERT_CORE_GROUP_FACETS)[number];
export const BookExpertCoreGroupFacetSchema = z.enum(BOOK_EXPERT_CORE_GROUP_FACETS);

export const BOOK_EXPERT_CORE_RESOLUTION_STATUSES = ["resolved", "unresolved"] as const;
export type BookExpertCoreResolutionStatus = (typeof BOOK_EXPERT_CORE_RESOLUTION_STATUSES)[number];
export const BookExpertCoreResolutionStatusSchema = z.enum(BOOK_EXPERT_CORE_RESOLUTION_STATUSES);

export const BOOK_EXPERT_CORE_RESOLVED_ENTITY_TYPES = ["character", "theme", "location", "group"] as const;
export type BookExpertCoreResolvedEntityType = (typeof BOOK_EXPERT_CORE_RESOLVED_ENTITY_TYPES)[number];
export const BookExpertCoreResolvedEntityTypeSchema = z.enum(BOOK_EXPERT_CORE_RESOLVED_ENTITY_TYPES);

export const BookExpertCoreExtractedRefSchema = z.object({
  value: z.string().trim().min(1).max(160),
  normalizedValue: z.string().trim().min(1).max(160),
  candidateCanonicalName: z.string().trim().min(1).max(160).nullable().optional(),
  entityId: z.string().trim().min(1).max(80).nullable().default(null),
  canonicalEntityType: BookExpertCoreResolvedEntityTypeSchema.nullable().default(null),
  resolutionStatus: BookExpertCoreResolutionStatusSchema.default("unresolved"),
  confidence: z.number().min(0).max(1),
});
export type BookExpertCoreExtractedRef = z.infer<typeof BookExpertCoreExtractedRefSchema>;

export const BookExpertCoreGroupMemberSchema = BookExpertCoreExtractedRefSchema.extend({
  role: z.string().trim().min(1).max(160),
});
export type BookExpertCoreGroupMember = z.infer<typeof BookExpertCoreGroupMemberSchema>;

export const BookExpertCoreGroupSchema = BookExpertCoreEntityBaseSchema.extend({
  rawKindLabel: z.string().trim().min(1).max(120).nullable().default(null),
  facet: BookExpertCoreGroupFacetSchema.nullable().default(null),
  facetConfidence: z.number().min(0).max(1).nullable().default(null),
  description: z.string().trim().min(1).max(900),
  significance: z.string().trim().min(1).max(900),
  members: z.array(BookExpertCoreGroupMemberSchema).max(16).default([]),
});
export type BookExpertCoreGroup = z.infer<typeof BookExpertCoreGroupSchema>;

export const BOOK_EXPERT_CORE_RELATION_FACETS = [
  "ally",
  "family",
  "romance",
  "conflict",
  "authority",
  "dependence",
  "rivalry",
  "mirror",
  "symbolic_association",
] as const;
export type BookExpertCoreRelationFacet = (typeof BOOK_EXPERT_CORE_RELATION_FACETS)[number];
export const BookExpertCoreRelationFacetSchema = z.enum(BOOK_EXPERT_CORE_RELATION_FACETS);

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

export const BookExpertCoreQuoteMentionSchema = BookExpertCoreExtractedRefSchema.extend({
  kind: BookExpertCoreQuoteMentionKindSchema,
});
export type BookExpertCoreQuoteMention = z.infer<typeof BookExpertCoreQuoteMentionSchema>;

export const BookExpertCoreIncidentParticipantSchema = BookExpertCoreExtractedRefSchema.extend({
  kind: BookExpertCoreIncidentParticipantKindSchema,
  role: z.string().trim().min(1).max(120),
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

export const BookExpertCoreRelationCandidateSchema = z.object({
  id: z.string().trim().min(1).max(80),
  fromRef: BookExpertCoreExtractedRefSchema,
  toRef: BookExpertCoreExtractedRefSchema,
  rawTypeLabel: z.string().trim().min(1).max(120),
  facet: BookExpertCoreRelationFacetSchema.nullable().default(null),
  facetConfidence: z.number().min(0).max(1).nullable().default(null),
  summary: z.string().trim().min(1).max(900),
  confidence: z.number().min(0).max(1),
  chapterFrom: z.number().int().min(1),
  chapterTo: z.number().int().min(1),
  quoteIds: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  anchors: z.array(BookExpertCoreEvidenceAnchorSchema).min(1).max(4),
  sourceWindows: z.array(BookExpertCoreWindowSourceSchema).max(6).default([]),
});
export type BookExpertCoreRelationCandidate = z.infer<typeof BookExpertCoreRelationCandidateSchema>;

export const BookExpertCoreEntityMentionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  entityId: z.string().trim().min(1).max(80),
  chapterOrderIndex: z.number().int().min(1),
  paragraphOrderInChapter: z.number().int().min(1),
  surfaceForm: z.string().trim().min(1).max(160),
  occurrenceIndex: z.number().int().min(1).max(16),
  confidence: z.number().min(0).max(1),
});
export type BookExpertCoreEntityMention = z.infer<typeof BookExpertCoreEntityMentionSchema>;

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
  groups: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        aliases: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
        rawKindLabel: z.string().trim().min(1).max(120).nullable().optional().default(null),
        facet: BookExpertCoreGroupFacetSchema.nullable().optional().default(null),
        facetConfidence: z.number().min(0).max(1).nullable().optional().default(null),
        description: z.string().trim().min(1).max(260),
        significanceHint: z.string().trim().min(1).max(320),
        members: z.array(BookExpertCoreGroupMemberSchema).max(16).default([]),
        chapterOrderIndex: z.number().int().min(1),
        importance: z.number().min(0).max(1),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(12)
    .default([]),
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
  relationCandidates: z
    .array(
      z.object({
        fromRef: BookExpertCoreExtractedRefSchema,
        toRef: BookExpertCoreExtractedRefSchema,
        rawTypeLabel: z.string().trim().min(1).max(120),
        facet: BookExpertCoreRelationFacetSchema.nullable().optional().default(null),
        facetConfidence: z.number().min(0).max(1).nullable().optional().default(null),
        summary: z.string().trim().min(1).max(500),
        confidence: z.number().min(0).max(1),
        chapterFrom: z.number().int().min(1),
        chapterTo: z.number().int().min(1),
        supportingQuoteTexts: z.array(z.string().trim().min(1).max(1200)).max(8).default([]),
        snippet: z.string().trim().min(1).max(280),
      })
    )
    .max(16)
    .default([]),
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
  groups: z.array(BookExpertCoreGroupSchema).max(16).default([]),
  entityMentionBank: z.array(BookExpertCoreEntityMentionSchema).max(12000).default([]),
  quoteBank: z.array(BookExpertCoreQuoteSchema).max(80),
  incidents: z.array(BookExpertCoreIncidentSchema).max(32).default([]),
  relationCandidates: z.array(BookExpertCoreRelationCandidateSchema).max(48).default([]),
  literarySections: z.record(BookExpertCoreLiterarySectionKeySchema, BookExpertCoreLiterarySectionSchema).nullable().default(null),
  windowScans: z.array(BookExpertCoreWindowScanSchema).max(48).default([]),
  generatedAt: z.string().datetime(),
});
export type BookExpertCoreSnapshot = z.infer<typeof BookExpertCoreSnapshotSchema>;
