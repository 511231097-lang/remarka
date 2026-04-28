// Contextual paragraph re-embed: rewrites BookParagraphEmbedding for one book
// using enriched source text (chapter title + scene card + participants +
// paragraph text). Used as a one-off T7 experiment before deciding whether
// to wire it into the analysis pipeline.
//
// Usage:
//   npm run worker:reembed:contextual -- --book-id <bookId>
//
// Pre-requisite: book has BookAnalysisScene rows (i.e. analysis ran).
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@remarka/db";
import { createVertexClient } from "@remarka/ai";

const PGVECTOR_EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_BATCH_SIZE = 250;
const EMBEDDING_INSERT_BATCH_SIZE = 100;
const PARAGRAPH_EMBEDDING_VERSION = Math.max(
  1,
  Number.parseInt(String(process.env.PARAGRAPH_EMBEDDING_VERSION || "1"), 10) || 1
);

function serializePgVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length !== PGVECTOR_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimensions mismatch: got ${Array.isArray(vector) ? vector.length : 0}, expected ${PGVECTOR_EMBEDDING_DIMENSIONS}`
    );
  }
  return `[${vector
    .map((value) => {
      const normalized = Number(value);
      return Number.isFinite(normalized) ? normalized.toString() : "0";
    })
    .join(",")}]`;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function parseStringArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseArgs(argv: string[]): { bookId: string; dryRun: boolean } {
  let bookId = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] || "";
    const next = argv[i + 1] || "";
    if (token === "--book-id" && next) {
      bookId = next.trim();
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
    }
  }
  if (!bookId) {
    throw new Error("Missing --book-id <id>");
  }
  return { bookId, dryRun };
}

function buildEnrichedSourceText(params: {
  chapterTitle: string;
  sceneCard: string;
  participants: string[];
  mentionedEntities: string[];
  paragraphText: string;
}): string {
  // Variant 2: chapter + sceneCard only (no participants, no mentionedEntities).
  // The entity lists turned out to be noisy and pushed correct paragraphs out
  // of top-5 in variant 1, so we drop them here.
  const lines: string[] = [];
  if (params.chapterTitle) {
    lines.push(`Глава: ${params.chapterTitle}`);
  }
  if (params.sceneCard) {
    lines.push(`Сцена: ${params.sceneCard}`);
  }
  if (lines.length) lines.push("");
  lines.push(params.paragraphText.trim());
  return lines.join("\n");
}

async function main() {
  const { bookId, dryRun } = parseArgs(process.argv.slice(2));

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, title: true },
  });
  if (!book) throw new Error(`Book not found: ${bookId}`);

  const chapters = await prisma.bookChapter.findMany({
    where: { bookId },
    select: { id: true, orderIndex: true, title: true },
    orderBy: { orderIndex: "asc" },
  });
  const chapterById = new Map(chapters.map((row) => [row.id, row]));

  const paragraphs = await prisma.bookParagraph.findMany({
    where: { bookId },
    select: {
      id: true,
      chapterId: true,
      chapterOrderIndex: true,
      paragraphIndex: true,
      text: true,
    },
    orderBy: [{ chapterOrderIndex: "asc" }, { paragraphIndex: "asc" }],
  });
  if (!paragraphs.length) throw new Error(`No paragraphs for book ${bookId}`);

  const scenes = await prisma.bookAnalysisScene.findMany({
    where: { bookId },
    select: {
      chapterId: true,
      paragraphStart: true,
      paragraphEnd: true,
      sceneCard: true,
      sceneSummary: true,
      participantsJson: true,
      mentionedEntitiesJson: true,
    },
  });

  type SceneCtx = {
    chapterId: string;
    paragraphStart: number;
    paragraphEnd: number;
    sceneCard: string;
    participants: string[];
    mentionedEntities: string[];
  };
  const scenesByChapter = new Map<string, SceneCtx[]>();
  for (const row of scenes) {
    const arr = scenesByChapter.get(row.chapterId) || [];
    arr.push({
      chapterId: row.chapterId,
      paragraphStart: Number(row.paragraphStart || 0),
      paragraphEnd: Number(row.paragraphEnd || 0),
      sceneCard: String(row.sceneCard || row.sceneSummary || "").trim(),
      participants: parseStringArray(row.participantsJson),
      mentionedEntities: parseStringArray(row.mentionedEntitiesJson),
    });
    scenesByChapter.set(row.chapterId, arr);
  }

  function findSceneFor(chapterId: string, paragraphIndex: number): SceneCtx | undefined {
    const arr = scenesByChapter.get(chapterId);
    if (!arr) return undefined;
    return arr.find((s) => paragraphIndex >= s.paragraphStart && paragraphIndex <= s.paragraphEnd);
  }

  const enriched = paragraphs.map((p) => {
    const chapter = chapterById.get(p.chapterId);
    const scene = findSceneFor(p.chapterId, p.paragraphIndex);
    const sourceText = buildEnrichedSourceText({
      chapterTitle: chapter?.title || "",
      sceneCard: scene?.sceneCard || "",
      participants: scene?.participants || [],
      mentionedEntities: scene?.mentionedEntities || [],
      paragraphText: p.text || "",
    });
    return {
      paragraphId: p.id,
      bookId,
      chapterId: p.chapterId,
      paragraphIndex: p.paragraphIndex,
      sourceText,
      sourceTextHash: sha256Hex(sourceText),
      hasSceneContext: Boolean(scene),
    };
  });

  const stats = {
    paragraphs: paragraphs.length,
    chapters: chapters.length,
    scenes: scenes.length,
    paragraphsWithScene: enriched.filter((row) => row.hasSceneContext).length,
    paragraphsWithoutScene: enriched.filter((row) => !row.hasSceneContext).length,
    avgEnrichedLen: Math.round(
      enriched.reduce((s, r) => s + r.sourceText.length, 0) / Math.max(1, enriched.length)
    ),
    sample: enriched.slice(0, 1).map((r) => r.sourceText.slice(0, 400)),
  };
  process.stdout.write(`Stats: ${JSON.stringify(stats, null, 2)}\n`);

  if (dryRun) {
    process.stdout.write(`(dry-run) Skipping embedding + DB writes.\n`);
    return;
  }

  const client = createVertexClient();
  if (!client.config.apiKey) {
    throw new Error("VERTEX_API_KEY is not configured");
  }

  process.stdout.write(`Embedding ${enriched.length} paragraphs (batch=${EMBEDDING_BATCH_SIZE})...\n`);
  const embedStart = Date.now();
  const response = await client.embeddings.createBatch({
    texts: enriched.map((row) => row.sourceText),
    taskType: "RETRIEVAL_DOCUMENT",
    batchSize: EMBEDDING_BATCH_SIZE,
  });
  const embedMs = Date.now() - embedStart;
  if (response.vectors.length !== enriched.length) {
    throw new Error(
      `Vector count mismatch: got ${response.vectors.length}, expected ${enriched.length}`
    );
  }
  process.stdout.write(
    `Embedded in ${embedMs}ms, input_tokens=${response.usage.input_tokens || 0}\n`
  );

  process.stdout.write(`Deleting old BookParagraphEmbedding for book...\n`);
  const deleted = await prisma.$executeRaw(
    Prisma.sql`DELETE FROM "BookParagraphEmbedding" WHERE "bookId" = ${bookId}`
  );
  process.stdout.write(`  deleted ${deleted} rows\n`);

  process.stdout.write(`Inserting enriched embeddings (version=${PARAGRAPH_EMBEDDING_VERSION})...\n`);
  const now = new Date();
  const rows = enriched.map((item, index) => {
    const vector = response.vectors[index] || [];
    const vectorLiteral = serializePgVectorLiteral(vector);
    return Prisma.sql`(
      ${crypto.randomUUID()},
      ${item.bookId},
      ${item.chapterId},
      ${item.paragraphId},
      ${item.paragraphIndex},
      ${client.config.embeddingModel},
      ${PARAGRAPH_EMBEDDING_VERSION},
      ${"RETRIEVAL_DOCUMENT"},
      ${vector.length},
      ${item.sourceText},
      ${item.sourceTextHash},
      ${now},
      ${now},
      CAST(${vectorLiteral} AS vector(768))
    )`;
  });
  for (const batch of chunkArray(rows, EMBEDDING_INSERT_BATCH_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "BookParagraphEmbedding" (
          "id",
          "bookId",
          "chapterId",
          "paragraphId",
          "paragraphIndex",
          "embeddingModel",
          "embeddingVersion",
          "taskType",
          "dimensions",
          "sourceText",
          "sourceTextHash",
          "createdAt",
          "updatedAt",
          "vector"
        )
        VALUES ${Prisma.join(batch)}
      `
    );
  }

  process.stdout.write(`Done. Inserted ${rows.length} contextual embeddings.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      // ignore
    }
  });
