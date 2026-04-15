import test from "node:test";
import assert from "node:assert/strict";
import type { BookExpertCoreSnapshot, BookExpertCoreWindowScan } from "@remarka/contracts";
import { __processBookExpertCoreTestUtils } from "./processBookExpertCore";
import { __processBookGraphTestUtils } from "./processBookGraph";

function buildBaseSnapshot(patch: Partial<BookExpertCoreSnapshot>): BookExpertCoreSnapshot {
  return {
    version: 4,
    bookId: "book_demo",
    completedStages: [],
    timingsMs: {},
    bookBrief: {
      shortSummary: "Коротко.",
      fullSummary: "Подробно.",
      spoilerSummary: "Со спойлерами.",
    },
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
    generatedAt: "2026-04-15T00:00:00.000Z",
    ...patch,
  };
}

test("mergeWindowScans keeps raw refs unresolved and preserves explicit group/relation labels", () => {
  const windows: BookExpertCoreWindowScan[] = [
    {
      windowIndex: 1,
      chapterFrom: 1,
      chapterTo: 1,
      textChars: 500,
      summary: "Гарри встречает Рона у Уизли.",
      plotPoints: [],
      characters: [
        {
          name: "Гарри Поттер",
          aliases: ["Гарри"],
          roleHint: "Главный герой",
          traits: [],
          motivations: [],
          arcHint: "Начинает доверять новым союзникам.",
          chapterOrderIndex: 1,
          importance: 0.9,
          snippet: "Гарри приезжает к Уизли.",
        },
        {
          name: "Рон Уизли",
          aliases: ["Рон"],
          roleHint: "Друг Гарри",
          traits: [],
          motivations: [],
          arcHint: "Поддерживает Гарри.",
          chapterOrderIndex: 1,
          importance: 0.85,
          snippet: "Рон рядом с Гарри.",
        },
      ],
      themes: [],
      locations: [],
      groups: [
        {
          name: "Дом Уизли",
          aliases: [],
          rawKindLabel: "дом",
          facet: "household",
          facetConfidence: 0.86,
          description: "Домашний круг Уизли.",
          significanceHint: "Показывает безопасное пространство.",
          members: [
            {
              value: "Рон Уизли",
              normalizedValue: "рон уизли",
              role: "сын",
              confidence: 0.88,
              entityId: null,
              canonicalEntityType: null,
              resolutionStatus: "unresolved",
            },
          ],
          chapterOrderIndex: 1,
          importance: 0.8,
          snippet: "Уизли принимают Гарри.",
        },
      ],
      quotes: [
        {
          chapterOrderIndex: 1,
          startChar: 10,
          endChar: 38,
          text: "Гарри посмотрел на Рона.",
          type: "narration",
          tags: ["relationship"],
          commentary: "Показывает связь героев.",
          mentions: [
            {
              kind: "character",
              value: "Гарри",
              normalizedValue: "гарри",
              entityId: null,
              canonicalEntityType: null,
              resolutionStatus: "unresolved",
              confidence: 0.9,
            },
          ],
          confidence: 0.88,
        },
      ],
      incidents: [],
      relationCandidates: [
        {
          fromRef: {
            value: "Гарри Поттер",
            normalizedValue: "гарри поттер",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.9,
          },
          toRef: {
            value: "Рон Уизли",
            normalizedValue: "рон уизли",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.88,
          },
          rawTypeLabel: "ally",
          facet: "ally",
          facetConfidence: 0.8,
          summary: "Они поддерживают друг друга.",
          confidence: 0.82,
          chapterFrom: 1,
          chapterTo: 1,
          supportingQuoteTexts: [],
          snippet: "Гарри и Рон действуют вместе.",
        },
      ],
    },
  ];

  const merged = __processBookExpertCoreTestUtils.mergeWindowScans("book_demo", windows);
  const group = merged.groups[0];
  const quote = merged.quoteBank[0];
  const relation = merged.relationCandidates[0];

  assert.equal(group.rawKindLabel, "дом");
  assert.equal(group.facet, "household");
  assert.equal(group.members[0]?.entityId, null);
  assert.equal(group.members[0]?.resolutionStatus, "unresolved");
  assert.equal(quote.mentions[0]?.entityId, null);
  assert.equal(quote.mentions[0]?.resolutionStatus, "unresolved");
  assert.equal(relation.rawTypeLabel, "ally");
  assert.equal(relation.fromRef.entityId, null);
  assert.equal(relation.toRef.entityId, null);
});

test("resolveSnapshotRefs uses exact normalized matches only and leaves unmatched refs unresolved", () => {
  const snapshot = buildBaseSnapshot({
    characters: [
      {
        id: "char_harry",
        name: "Гарри Поттер",
        normalizedName: "гарри поттер",
        aliases: ["Гарри"],
        mentionCount: 3,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
        role: "Главный герой",
        description: "Подросток-волшебник.",
        arc: "Учится доверять другим.",
        motivations: ["Разобраться в происходящем"],
      },
    ],
    quoteBank: [
      {
        id: "quote_1",
        chapterOrderIndex: 1,
        startChar: 0,
        endChar: 20,
        text: "Гарри услышал голос.",
        type: "narration",
        tags: [],
        commentary: null,
        confidence: 0.9,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри услышал голос.", startChar: 0, endChar: 20 }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        mentions: [
          {
            kind: "character",
            value: "Гарри",
            normalizedValue: "гарри",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.82,
          },
          {
            kind: "character",
            value: "Поттер",
            normalizedValue: "поттер",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.5,
          },
        ],
      },
    ],
    groups: [
      {
        id: "group_1",
        name: "Дом друзей",
        normalizedName: "дом друзей",
        aliases: [],
        mentionCount: 1,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Дом друзей", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
        rawKindLabel: "дом",
        facet: "household",
        facetConfidence: 0.8,
        description: "Круг друзей.",
        significance: "Безопасное пространство.",
        members: [
          {
            value: "Гарри",
            normalizedValue: "гарри",
            role: "гость",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.8,
          },
          {
            value: "Поттер",
            normalizedValue: "поттер",
            role: "гость",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.4,
          },
        ],
      },
    ],
    relationCandidates: [
      {
        id: "rel_1",
        fromRef: {
          value: "Гарри",
          normalizedValue: "гарри",
          entityId: null,
          canonicalEntityType: null,
          resolutionStatus: "unresolved",
          confidence: 0.8,
        },
        toRef: {
          value: "Поттер",
          normalizedValue: "поттер",
          entityId: null,
          canonicalEntityType: null,
          resolutionStatus: "unresolved",
          confidence: 0.4,
        },
        rawTypeLabel: "ally",
        facet: "ally",
        facetConfidence: 0.8,
        summary: "Односторонне точная и частично неточная ссылка.",
        confidence: 0.75,
        chapterFrom: 1,
        chapterTo: 1,
        quoteIds: [],
        anchors: [{ chapterOrderIndex: 1, startChar: null, endChar: null, snippet: "Гарри помогает." }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
      },
    ],
  });

  const resolved = __processBookExpertCoreTestUtils.resolveSnapshotRefs(snapshot);

  assert.equal(resolved.quoteBank[0]?.mentions[0]?.entityId, "char_harry");
  assert.equal(resolved.quoteBank[0]?.mentions[0]?.resolutionStatus, "resolved");
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.entityId, null);
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.resolutionStatus, "unresolved");
  assert.equal(resolved.groups[0]?.members[0]?.entityId, "char_harry");
  assert.equal(resolved.groups[0]?.members[1]?.entityId, null);
  assert.equal(resolved.relationCandidates[0]?.fromRef.entityId, "char_harry");
  assert.equal(resolved.relationCandidates[0]?.toRef.entityId, null);
});

test("resolveSnapshotRefs can resolve inflected refs only through exact candidateCanonicalName", () => {
  const snapshot = buildBaseSnapshot({
    characters: [
      {
        id: "char_harry",
        name: "Гарри Поттер",
        normalizedName: "гарри поттер",
        aliases: ["Гарри"],
        mentionCount: 2,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри Поттер", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
        role: "Главный герой",
        description: "Подросток-волшебник.",
        arc: "Учится доверять другим.",
        motivations: ["Разобраться в происходящем"],
      },
    ],
    quoteBank: [
      {
        id: "quote_1",
        chapterOrderIndex: 1,
        startChar: 0,
        endChar: 24,
        text: "Гарри Поттеру стало страшно.",
        type: "narration",
        tags: [],
        commentary: null,
        confidence: 0.9,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри Поттеру стало страшно.", startChar: 0, endChar: 24 }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        mentions: [
          {
            kind: "character",
            value: "Гарри Поттеру",
            normalizedValue: "гарри поттеру",
            candidateCanonicalName: "Гарри Поттер",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.84,
          },
          {
            kind: "character",
            value: "Поттеру",
            normalizedValue: "поттеру",
            candidateCanonicalName: null,
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.4,
          },
        ],
      },
    ],
  });

  const resolved = __processBookExpertCoreTestUtils.resolveSnapshotRefs(snapshot);

  assert.equal(resolved.quoteBank[0]?.mentions[0]?.entityId, "char_harry");
  assert.equal(resolved.quoteBank[0]?.mentions[0]?.resolutionStatus, "resolved");
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.entityId, null);
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.resolutionStatus, "unresolved");
});

test("applyQuoteMentionRefinement keeps only surface forms that literally occur in quote text and preserves unresolved refs", () => {
  const snapshot = buildBaseSnapshot({
    characters: [
      {
        id: "char_harry",
        name: "Гарри Поттер",
        normalizedName: "гарри поттер",
        aliases: ["Гарри"],
        mentionCount: 3,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
        role: "Главный герой",
        description: "Подросток-волшебник.",
        arc: "Учится доверять другим.",
        motivations: ["Разобраться в происходящем"],
      },
    ],
    themes: [
      {
        id: "theme_friendship",
        name: "Дружба",
        normalizedName: "дружба",
        aliases: [],
        mentionCount: 1,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Дружба", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
        description: "Тема доверия.",
        development: "Укрепляется по ходу книги.",
      },
    ],
    quoteBank: [
      {
        id: "quote_1",
        chapterOrderIndex: 1,
        startChar: 0,
        endChar: 23,
        text: "Гарри защищает дружбу.",
        type: "narration",
        tags: [],
        commentary: null,
        confidence: 0.9,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри защищает дружбу.", startChar: 0, endChar: 23 }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        mentions: [],
      },
      {
        id: "quote_2",
        chapterOrderIndex: 1,
        startChar: 24,
        endChar: 42,
        text: "Он молчит и ждёт.",
        type: "reflection",
        tags: [],
        commentary: null,
        confidence: 0.8,
        anchors: [{ chapterOrderIndex: 1, snippet: "Он молчит и ждёт.", startChar: 24, endChar: 42 }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        mentions: [
          {
            kind: "theme",
            value: "Дружба",
            normalizedValue: "дружба",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.7,
          },
        ],
      },
    ],
  });

  const refined = __processBookExpertCoreTestUtils.applyQuoteMentionRefinement({
    snapshot,
    refinements: [
      {
        quoteId: "quote_1",
        mentions: [
          { kind: "character", value: "Гарри", confidence: 0.91 },
          { kind: "theme", value: "дружбу", confidence: 0.73 },
          { kind: "character", value: "Рон", confidence: 0.8 },
        ],
      },
      {
        quoteId: "quote_2",
        mentions: [{ kind: "character", value: "Гарри", confidence: 0.9 }],
      },
    ],
  });
  const resolved = __processBookExpertCoreTestUtils.resolveSnapshotRefs({
    ...snapshot,
    quoteBank: refined,
  });

  assert.equal(refined[0]?.mentions.length, 2);
  assert.equal(refined[0]?.mentions[0]?.value, "Гарри");
  assert.equal(refined[0]?.mentions[1]?.value, "дружбу");
  assert.equal(refined[1]?.mentions.length, 0);
  assert.equal(resolved.quoteBank[0]?.mentions[0]?.entityId, "char_harry");
  assert.equal(resolved.quoteBank[0]?.mentions[0]?.resolutionStatus, "resolved");
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.entityId, null);
  assert.equal(resolved.quoteBank[0]?.mentions[1]?.resolutionStatus, "unresolved");
});

test("relation refinement only keeps exact catalog surfaces and resolves endpoints by exact normalized match", () => {
  const snapshot = buildBaseSnapshot({
    characters: [
      {
        id: "char_harry",
        name: "Гарри Поттер",
        normalizedName: "гарри поттер",
        aliases: ["Гарри"],
        mentionCount: 4,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        role: "Главный герой",
        description: "Подросток-волшебник.",
        arc: "Учится доверять друзьям.",
        motivations: ["Понять происходящее"],
      },
      {
        id: "char_ron",
        name: "Рон Уизли",
        normalizedName: "рон уизли",
        aliases: ["Рон"],
        mentionCount: 4,
        firstAppearanceChapterOrder: 1,
        anchors: [{ chapterOrderIndex: 1, snippet: "Рон", startChar: null, endChar: null }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        role: "Друг Гарри",
        description: "Поддерживает Гарри.",
        arc: "Становится надёжнее.",
        motivations: ["Помочь другу"],
      },
    ],
    quoteBank: [
      {
        id: "quote_1",
        chapterOrderIndex: 1,
        startChar: 0,
        endChar: 31,
        text: "Гарри и Рон держатся вместе.",
        type: "narration",
        tags: ["relationship"],
        commentary: null,
        confidence: 0.92,
        anchors: [{ chapterOrderIndex: 1, snippet: "Гарри и Рон держатся вместе.", startChar: 0, endChar: 31 }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
        mentions: [
          {
            kind: "character",
            value: "Гарри",
            normalizedValue: "гарри",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.9,
          },
          {
            kind: "character",
            value: "Рон",
            normalizedValue: "рон",
            entityId: null,
            canonicalEntityType: null,
            resolutionStatus: "unresolved",
            confidence: 0.9,
          },
        ],
      },
    ],
    relationCandidates: [],
  });

  const refined = __processBookExpertCoreTestUtils.applyRelationCandidateRefinement({
    snapshot,
    refinements: [
      {
        fromValue: "Гарри",
        toValue: "Рон",
        rawTypeLabel: "дружеская поддержка",
        facet: "ally",
        facetConfidence: 0.88,
        summary: "Гарри и Рон действуют как союзники.",
        chapterFrom: 1,
        chapterTo: 1,
        quoteIds: ["quote_1"],
        snippet: "Гарри и Рон держатся вместе.",
        confidence: 0.86,
      },
      {
        fromValue: "Гарри",
        toValue: "Поттеры",
        rawTypeLabel: "семья",
        facet: "family",
        facetConfidence: 0.8,
        summary: "Неверная связь без catalog surface.",
        chapterFrom: 1,
        chapterTo: 1,
        quoteIds: ["quote_1"],
        snippet: "Гарри и Рон держатся вместе.",
        confidence: 0.7,
      },
    ],
  });
  const resolved = __processBookExpertCoreTestUtils.resolveSnapshotRefs({
    ...snapshot,
    relationCandidates: refined,
  });

  assert.equal(refined.length, 1);
  assert.equal(refined[0]?.rawTypeLabel, "дружеская поддержка");
  assert.equal(refined[0]?.facet, "ally");
  assert.deepEqual(refined[0]?.quoteIds, ["quote_1"]);
  assert.equal(resolved.relationCandidates[0]?.fromRef.entityId, "char_harry");
  assert.equal(resolved.relationCandidates[0]?.fromRef.resolutionStatus, "resolved");
  assert.equal(resolved.relationCandidates[0]?.toRef.entityId, "char_ron");
  assert.equal(resolved.relationCandidates[0]?.toRef.resolutionStatus, "resolved");
});

test("coalesceEntitySources keeps explicit group metadata without backend-inferred category", () => {
  const sources = __processBookGraphTestUtils.coalesceEntitySources({
    bookId: "book_demo",
    expertCore: buildBaseSnapshot({
      characters: [
        {
          id: "char_harry",
          name: "Гарри Поттер",
          normalizedName: "гарри поттер",
          aliases: ["Гарри"],
          mentionCount: 3,
          firstAppearanceChapterOrder: 1,
          anchors: [{ chapterOrderIndex: 1, snippet: "Гарри", startChar: null, endChar: null }],
          sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
          role: "Главный герой",
          description: "Подросток-волшебник.",
          arc: "Учится доверять другим.",
          motivations: ["Разобраться в происходящем"],
        },
      ],
      groups: [
        {
          id: "group_circle",
          name: "Круг Феникса",
          normalizedName: "круг феникса",
          aliases: [],
          mentionCount: 2,
          firstAppearanceChapterOrder: 1,
          anchors: [{ chapterOrderIndex: 1, snippet: "Круг Феникса", startChar: null, endChar: null }],
          sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
          rawKindLabel: "круг",
          facet: null,
          facetConfidence: null,
          description: "Коллектив союзников.",
          significance: "Объединяет персонажей.",
          members: [
            {
              value: "Гарри Поттер",
              normalizedValue: "гарри поттер",
              role: "участник",
              entityId: "char_harry",
              canonicalEntityType: "character",
              resolutionStatus: "resolved",
              confidence: 0.8,
            },
          ],
        },
      ],
    }),
  });

  const group = sources.find((item) => item.type === "group");
  assert.ok(group);
  assert.equal(group?.metadataJson?.rawKindLabel, "круг");
  assert.equal(group?.metadataJson?.groupFacet, null);
  assert.equal(Array.isArray(group?.metadataJson?.members), true);
  assert.deepEqual(group?.metadataJson?.sourceWindowIndexes, [1]);
});

test("deterministic degraded profile patch is built from evidence pack instead of generic card fields", () => {
  const patch = __processBookExpertCoreTestUtils.buildDeterministicProfilePatch(
    "characters",
    {
      id: "char_harry",
      name: "Гарри Поттер",
      normalizedName: "гарри поттер",
      aliases: ["Гарри"],
      mentionCount: 10,
      firstAppearanceChapterOrder: 1,
      anchors: [{ chapterOrderIndex: 1, snippet: "Гарри слышит голос в стене.", startChar: null, endChar: null }],
      sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
      role: "Заметный участник событий этого фрагмента",
      description: "Его роль заметна в пределах этого окна книги.",
      arc: "Его роль заметна в пределах этого окна книги.",
      motivations: ["Разобраться в происходящем"],
      profileDegraded: false,
    },
    {
      anchors: [{ snippet: "Гарри слышит голос в стене." }],
      incidents: [
        {
          title: "Голос в коридоре",
          facts: ["Гарри снова слышит таинственный голос."],
          consequences: ["Это усиливает подозрения вокруг Тайной комнаты."],
        },
      ],
      relations: [{ summary: "Линия Гарри связана с расследованием и подозрениями." }],
      quotes: [{ text: "Гарри Поттеру нельзя возвращаться в «Хогвартс»." }],
    }
  );

  assert.equal(patch.degraded, true);
  assert.equal(patch.role?.includes("Заметный участник событий"), false);
  assert.equal(patch.description?.includes("Голос в коридоре"), true);
  assert.equal(patch.arc?.includes("Тайной комнаты"), true);
});

test("deterministic degraded profile patch stays minimal when evidence pack is empty", () => {
  const patch = __processBookExpertCoreTestUtils.buildDeterministicProfilePatch(
    "characters",
    {
      id: "char_meshchanin",
      name: "Мещанин",
      normalizedName: "мещанин",
      aliases: [],
      mentionCount: 0,
      firstAppearanceChapterOrder: 3,
      anchors: [],
      sourceWindows: [{ windowIndex: 3, chapterFrom: 3, chapterTo: 3, chapterCount: 1, textChars: 50 }],
      role: "Заметный участник событий этого фрагмента",
      description: "Его роль заметна в пределах этого окна книги.",
      arc: "Его роль заметна в пределах этого окна книги.",
      motivations: [],
      profileDegraded: false,
    },
    {}
  );

  assert.equal(patch.role, "");
  assert.equal(patch.description, "Мещанин");
  assert.equal(patch.arc, "");
  assert.equal(patch.degraded, true);
});

test("mergeCharacterProfilePatches preserves explicit empty fallback fields instead of keeping stale generic values", () => {
  const merged = __processBookExpertCoreTestUtils.mergeCharacterProfilePatches(
    [
      {
        id: "char_meshchanin",
        name: "Мещанин",
        normalizedName: "мещанин",
        aliases: [],
        mentionCount: 2,
        firstAppearanceChapterOrder: 3,
        anchors: [],
        sourceWindows: [{ windowIndex: 3, chapterFrom: 3, chapterTo: 3, chapterCount: 1, textChars: 50 }],
        role: "Персонаж Мещанин",
        description: "Мещанин",
        arc: "Мещанин",
        motivations: [],
        profileDegraded: false,
      },
    ],
    [
      {
        id: "char_meshchanin",
        role: "",
        description: "Мещанин",
        arc: "",
        motivations: [],
        degraded: true,
      },
    ]
  );

  assert.equal(merged[0]?.role, "");
  assert.equal(merged[0]?.arc, "");
  assert.equal(merged[0]?.description, "Мещанин");
  assert.equal(merged[0]?.profileDegraded, true);
});

test("coalesceEntitySources character summary prefers descriptive fields over role labels", () => {
  const sources = __processBookGraphTestUtils.coalesceEntitySources({
    bookId: "book_demo",
    expertCore: buildBaseSnapshot({
      characters: [
        {
          id: "char_harry",
          name: "Гарри Поттер",
          normalizedName: "гарри поттер",
          aliases: ["Гарри"],
          mentionCount: 3,
          firstAppearanceChapterOrder: 1,
          anchors: [{ chapterOrderIndex: 1, snippet: "Гарри", startChar: null, endChar: null }],
          sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
          role: "Ролевая метка",
          description: "Гарри слышит голос в стене.",
          arc: "Его линия ведёт к расследованию Тайной комнаты.",
          motivations: [],
          profileDegraded: true,
        },
      ],
    }),
  });

  const character = sources.find((item) => item.type === "character");
  assert.ok(character);
  assert.equal(character?.summary.startsWith("Гарри слышит голос в стене."), true);
});

test("normalizeWindowScan tolerates degraded string relation candidates without inventing canonical structure", () => {
  const normalized = __processBookExpertCoreTestUtils.normalizeWindowScan(
    {
      windowIndex: 1,
      chapterFrom: 1,
      chapterTo: 1,
      chapters: [
        {
          orderIndex: 1,
          title: "Глава 1",
          rawText: "Гарри и Рон спорят, а затем мирятся.",
        },
      ],
      textChars: 1200,
      text: "Гарри и Рон спорят, а затем мирятся.",
    },
    {
      summary: "Гарри и Рон взаимодействуют.",
      plotPoints: [],
      characters: ["Гарри Поттер", "Рон Уизли"],
      themes: [],
      locations: [],
      groups: [],
      quotes: [],
      incidents: [],
      relationCandidates: ["Гарри Поттер и Рон Уизли (друзья)"],
    }
  );

  assert.equal(normalized.relationCandidates.length, 0);
  assert.equal(normalized.characters.length, 2);
});

test("buildRelationEdgeRows materializes only resolved canonical relations with explicit facet", () => {
  const rows = __processBookGraphTestUtils.buildRelationEdgeRows({
    bookId: "book_demo",
    sceneIdByChapter: new Map([
      [1, "scene_1"],
      [2, "scene_2"],
    ]),
    relationCandidates: [
      {
        id: "rel_1",
        fromRef: {
          value: "Гарри Поттер",
          normalizedValue: "гарри поттер",
          entityId: "char_harry",
          canonicalEntityType: "character",
          resolutionStatus: "resolved",
          confidence: 0.9,
        },
        toRef: {
          value: "Рон Уизли",
          normalizedValue: "рон уизли",
          entityId: "char_ron",
          canonicalEntityType: "character",
          resolutionStatus: "resolved",
          confidence: 0.88,
        },
        rawTypeLabel: "ally",
        facet: "ally",
        facetConfidence: 0.8,
        summary: "Они действуют вместе.",
        confidence: 0.7,
        chapterFrom: 1,
        chapterTo: 1,
        quoteIds: ["quote_1"],
        anchors: [{ chapterOrderIndex: 1, startChar: null, endChar: null, snippet: "Гарри и Рон вместе." }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
      },
      {
        id: "rel_2",
        fromRef: {
          value: "Гарри Поттер",
          normalizedValue: "гарри поттер",
          entityId: "char_harry",
          canonicalEntityType: "character",
          resolutionStatus: "resolved",
          confidence: 0.9,
        },
        toRef: {
          value: "Неизвестный",
          normalizedValue: "неизвестный",
          entityId: null,
          canonicalEntityType: null,
          resolutionStatus: "unresolved",
          confidence: 0.4,
        },
        rawTypeLabel: "ally",
        facet: "ally",
        facetConfidence: 0.8,
        summary: "Не должен материализоваться.",
        confidence: 0.7,
        chapterFrom: 1,
        chapterTo: 1,
        quoteIds: [],
        anchors: [{ chapterOrderIndex: 1, startChar: null, endChar: null, snippet: "Неизвестный рядом." }],
        sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 100 }],
      },
      {
        id: "rel_3",
        fromRef: {
          value: "Гарри Поттер",
          normalizedValue: "гарри поттер",
          entityId: "char_harry",
          canonicalEntityType: "character",
          resolutionStatus: "resolved",
          confidence: 0.9,
        },
        toRef: {
          value: "Рон Уизли",
          normalizedValue: "рон уизли",
          entityId: "char_ron",
          canonicalEntityType: "character",
          resolutionStatus: "resolved",
          confidence: 0.88,
        },
        rawTypeLabel: "дружба",
        facet: null,
        facetConfidence: null,
        summary: "Без facet не должен материализоваться.",
        confidence: 0.7,
        chapterFrom: 2,
        chapterTo: 2,
        quoteIds: [],
        anchors: [{ chapterOrderIndex: 2, startChar: null, endChar: null, snippet: "Они дружат." }],
        sourceWindows: [{ windowIndex: 2, chapterFrom: 2, chapterTo: 2, chapterCount: 1, textChars: 100 }],
      },
    ],
  });

  assert.equal(rows.size, 1);
  const relation = [...rows.values()][0];
  assert.equal(relation.type, "ally");
  assert.equal(relation.fromEntityId, "char_harry");
  assert.equal(relation.toEntityId, "char_ron");
  assert.equal(relation.metadataJson?.rawTypeLabel, "ally");
});

test("buildResolvedQuoteMentionAssignments returns only resolved mention backfills with explicit status", () => {
  const assignments = __processBookGraphTestUtils.buildResolvedQuoteMentionAssignments(
    buildBaseSnapshot({
      quoteBank: [
        {
          id: "quote_1",
          chapterOrderIndex: 1,
          startChar: 0,
          endChar: 20,
          text: "Гарри посмотрел на Рона.",
          type: "narration",
          tags: [],
          commentary: "",
          confidence: 0.9,
          anchors: [{ chapterOrderIndex: 1, snippet: "Гарри посмотрел на Рона.", startChar: 0, endChar: 24 }],
          sourceWindows: [{ windowIndex: 1, chapterFrom: 1, chapterTo: 1, chapterCount: 1, textChars: 120 }],
          mentions: [
            {
              kind: "character",
              value: "Гарри",
              normalizedValue: "гарри",
              entityId: "character_harry",
              canonicalEntityType: "character",
              resolutionStatus: "resolved",
              confidence: 0.82,
            },
            {
              kind: "character",
              value: "Рон",
              normalizedValue: "рон",
              entityId: null,
              canonicalEntityType: null,
              resolutionStatus: "unresolved",
              confidence: 0.5,
            },
          ],
        },
      ],
    })
  );

  assert.deepEqual(assignments, [
    {
      id: assignments[0]?.id,
      entityId: "character_harry",
      resolutionStatus: "resolved",
    },
  ]);
  assert.match(assignments[0]?.id || "", /^mention_[a-f0-9]{20}$/);
});

test("filterBackfillableQuoteMentionAssignments keeps only assignments whose entities are already materialized", () => {
  const result = __processBookGraphTestUtils.filterBackfillableQuoteMentionAssignments(
    [
      {
        id: "mention_1",
        entityId: "character_harry",
        resolutionStatus: "resolved",
      },
      {
        id: "mention_2",
        entityId: "location_hogwarts",
        resolutionStatus: "resolved",
      },
    ],
    ["location_hogwarts"]
  );

  assert.deepEqual(result, {
    assignments: [
      {
        id: "mention_2",
        entityId: "location_hogwarts",
        resolutionStatus: "resolved",
      },
    ],
    skippedMissingEntities: 1,
  });
});

test("materializeEntityMentions anchors only literal explicit mentions from entityMentionBank", () => {
  const rows = __processBookGraphTestUtils.materializeEntityMentions({
    bookId: "book_demo",
    chapters: [
      {
        id: "chapter_1",
        orderIndex: 1,
        title: "Глава 1",
        rawText: "Гарри подошёл к окну.",
        summary: null,
      },
    ],
    paragraphs: [
      {
        id: "paragraph_1",
        bookId: "book_demo",
        chapterId: "chapter_1",
        sceneId: "scene_1",
        orderIndex: 1,
        orderInChapter: 1,
        startChar: 0,
        endChar: 22,
        text: "Гарри подошёл к окну.",
      },
    ],
    entityMentionBank: [
      {
        id: "mention_1",
        entityId: "char_harry",
        chapterOrderIndex: 1,
        paragraphOrderInChapter: 1,
        surfaceForm: "Гарри",
        occurrenceIndex: 1,
        confidence: 0.9,
      },
      {
        id: "mention_2",
        entityId: "char_harry",
        chapterOrderIndex: 1,
        paragraphOrderInChapter: 1,
        surfaceForm: "Поттер",
        occurrenceIndex: 1,
        confidence: 0.7,
      },
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.entityId, "char_harry");
  assert.equal(rows[0]?.sceneId, "scene_1");
  assert.equal(rows[0]?.sourceText, "Гарри");
});

test("summary_store waits for core_literary and event_relation_graph before materializing summaries", () => {
  assert.deepEqual(__processBookGraphTestUtils.graphStageDependencies.summary_store, [
    "scene_build",
    "entity_graph",
    "event_relation_graph",
    "core_literary",
  ]);
});

test("entity_graph waits for core_profiles so BookMention and entity summaries consume explicit mention/profile stages", () => {
  assert.deepEqual(__processBookGraphTestUtils.graphStageDependencies.entity_graph, [
    "scene_build",
    "core_profiles",
  ]);
});
