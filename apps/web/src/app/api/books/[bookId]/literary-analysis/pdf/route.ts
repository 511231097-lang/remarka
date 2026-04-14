import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@remarka/db";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import {
  LITERARY_SECTION_KEYS,
  toBookLiteraryAnalysisDTO,
  type BookLiteraryAnalysisDTO,
  type LiterarySectionKeyDTO,
} from "@/lib/books";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

interface PdfCursor {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  y: number;
}

interface PdfChapterPassSection {
  summary: string;
  bullets: string[];
  confidence: number;
}

interface PdfChapterPass {
  chapterOrderIndex: number;
  chapterTitle: string;
  sections: Record<LiterarySectionKeyDTO, PdfChapterPassSection>;
}

interface PdfChapterFactEvent {
  id: string;
  description: string;
  characters: string[];
  importance: number;
}

interface PdfChapterFactChange {
  character: string;
  before: string;
  after: string;
  reason: string;
}

interface PdfChapterFactConflict {
  type: "external" | "internal";
  description: string;
  participants: string[];
}

interface PdfChapterFactSymbol {
  entity: string;
  description: string;
  context: string;
}

interface PdfChapterFacts {
  chapterOrderIndex: number;
  chapterTitle: string;
  events: PdfChapterFactEvent[];
  characterChanges: PdfChapterFactChange[];
  conflicts: PdfChapterFactConflict[];
  symbols: PdfChapterFactSymbol[];
  facts: string[];
}

interface PdfPattern {
  id: string;
  name: string;
  core: string;
  whyItMatters: string;
  evidence: Array<{
    type: "event" | "characterChange" | "conflict" | "symbol" | "fact";
    chapter: number;
    ref: string;
  }>;
  evolution: string;
  strength: number;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = A4_WIDTH - PAGE_MARGIN * 2;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringLike(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.toLowerCase() === "[object object]") return null;
    return trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const record = asRecord(value);
  if (!record) return null;

  const candidate =
    (typeof record.fact === "string" ? record.fact : null) ||
    (typeof record.text === "string" ? record.text : null) ||
    (typeof record.value === "string" ? record.value : null) ||
    (typeof record.description === "string" ? record.description : null) ||
    (typeof record.ref === "string" ? record.ref : null) ||
    (typeof record.name === "string" ? record.name : null) ||
    (typeof record.title === "string" ? record.title : null) ||
    (typeof record.label === "string" ? record.label : null);

  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === "[object object]") return null;
  return trimmed;
}

function normalizeStringLikeList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = asStringLike(item);
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(text);
    if (out.length >= maxItems) break;
  }

  return out;
}

function createCursor(doc: PDFDocument, font: PDFFont): PdfCursor {
  return {
    doc,
    page: doc.addPage([A4_WIDTH, A4_HEIGHT]),
    font,
    y: A4_HEIGHT - PAGE_MARGIN,
  };
}

function ensureSpace(cursor: PdfCursor, minHeight: number): void {
  if (cursor.y - minHeight >= PAGE_MARGIN) {
    return;
  }
  cursor.page = cursor.doc.addPage([A4_WIDTH, A4_HEIGHT]);
  cursor.y = A4_HEIGHT - PAGE_MARGIN;
}

function addVerticalSpace(cursor: PdfCursor, amount: number): void {
  ensureSpace(cursor, amount);
  cursor.y -= amount;
}

function splitLongWord(word: string, maxWidth: number, font: PDFFont, size: number): string[] {
  const chars = Array.from(word);
  const parts: string[] = [];
  let current = "";

  for (const char of chars) {
    const candidate = current ? `${current}${char}` : char;
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    parts.push(current);
    current = char;
  }

  if (current) parts.push(current);
  return parts;
}

function wrapTextLine(line: string, maxWidth: number, font: PDFFont, size: number): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];

  const out: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    out.push(current);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    const parts = splitLongWord(word, maxWidth, font, size);
    if (parts.length === 0) {
      current = "";
      continue;
    }

    out.push(...parts.slice(0, -1));
    current = parts[parts.length - 1] || "";
  }

  if (current) out.push(current);
  return out;
}

function wrapMultilineText(text: string, maxWidth: number, font: PDFFont, size: number): string[] {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      continue;
    }
    out.push(...wrapTextLine(trimmed, maxWidth, font, size));
  }

  return out.length > 0 ? out : [""];
}

function drawWrappedText(
  cursor: PdfCursor,
  text: string,
  options: { size: number; lineHeight: number; color?: ReturnType<typeof rgb> }
): void {
  const lines = wrapMultilineText(text, CONTENT_WIDTH, cursor.font, options.size);
  const color = options.color || rgb(0.16, 0.16, 0.18);

  for (const line of lines) {
    if (!line) {
      addVerticalSpace(cursor, options.lineHeight);
      continue;
    }

    ensureSpace(cursor, options.lineHeight + 2);
    cursor.page.drawText(line, {
      x: PAGE_MARGIN,
      y: cursor.y - options.size,
      size: options.size,
      font: cursor.font,
      color,
    });
    cursor.y -= options.lineHeight;
  }
}

function toPlainText(markdown: string): string {
  return markdown
    .replace(/\r/g, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeFileName(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "analysis";
  return normalized.slice(0, 80);
}

function parseChapterPassesFromSectionsJson(sectionsJson: unknown): {
  pipeline: string | null;
  chapterPassCount: number | null;
  chapterPasses: PdfChapterPass[];
} {
  const root = asRecord(sectionsJson) || {};
  const pipelineRaw = String(root.pipeline || "").trim();
  const pipeline = pipelineRaw || null;

  const countRaw = Number(root.chapterPassCount);
  const chapterPassCount = Number.isFinite(countRaw) && countRaw >= 0 ? Math.floor(countRaw) : null;

  const source = Array.isArray(root.chapterPasses) ? root.chapterPasses : [];
  const chapterPasses: PdfChapterPass[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const item = asRecord(source[index]);
    if (!item) continue;

    const orderRaw = Number(item.chapterOrderIndex ?? item.orderIndex ?? index + 1);
    const chapterOrderIndex = Number.isFinite(orderRaw) && orderRaw > 0 ? Math.floor(orderRaw) : index + 1;
    const chapterTitleRaw = String(item.chapterTitle ?? item.title ?? "").trim();
    const chapterTitle = chapterTitleRaw || `Глава ${chapterOrderIndex}`;

    const sectionsSource = asRecord(item.sections) || {};
    const sections = Object.fromEntries(
      LITERARY_SECTION_KEYS.map((key) => {
        const sectionRecord = asRecord(sectionsSource[key]) || {};
        const summary = String(sectionRecord.summary || "").trim();
        const bullets = Array.isArray(sectionRecord.bullets)
          ? sectionRecord.bullets
              .map((bullet) => String(bullet || "").trim())
              .filter((bullet) => bullet.length > 0)
              .slice(0, 8)
          : [];
        const confidenceRaw = Number(sectionRecord.confidence);
        const confidence = Number.isFinite(confidenceRaw) ? clamp01(confidenceRaw) : 0.65;
        return [key, { summary, bullets, confidence } satisfies PdfChapterPassSection] as const;
      })
    ) as Record<LiterarySectionKeyDTO, PdfChapterPassSection>;

    chapterPasses.push({
      chapterOrderIndex,
      chapterTitle,
      sections,
    });
  }

  chapterPasses.sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex);
  return {
    pipeline,
    chapterPassCount,
    chapterPasses,
  };
}

function parseChapterFactsFromSectionsJson(sectionsJson: unknown): {
  chapterFactsCount: number | null;
  chapterFacts: PdfChapterFacts[];
} {
  const root = asRecord(sectionsJson) || {};
  const countRaw = Number(root.chapterFactsCount);
  const chapterFactsCount = Number.isFinite(countRaw) && countRaw >= 0 ? Math.floor(countRaw) : null;

  const source = Array.isArray(root.chapterFacts) ? root.chapterFacts : [];
  const chapterFacts: PdfChapterFacts[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const item = asRecord(source[index]);
    if (!item) continue;

    const orderRaw = Number(item.chapterOrderIndex ?? item.orderIndex ?? index + 1);
    const chapterOrderIndex = Number.isFinite(orderRaw) && orderRaw > 0 ? Math.floor(orderRaw) : index + 1;
    const chapterTitleRaw = String(item.chapterTitle ?? item.title ?? "").trim();
    const chapterTitle = chapterTitleRaw || `Глава ${chapterOrderIndex}`;

    const eventsSource = Array.isArray(item.events) ? item.events : [];
    const events: PdfChapterFactEvent[] = [];
    for (let eventIndex = 0; eventIndex < eventsSource.length; eventIndex += 1) {
      const eventRecord = asRecord(eventsSource[eventIndex]);
      if (!eventRecord) continue;
      const id = String(eventRecord.id ?? `event_${eventIndex + 1}`).trim() || `event_${eventIndex + 1}`;
      const description = String(eventRecord.description || "").trim();
      if (!description) continue;
      const characters = normalizeStringLikeList(eventRecord.characters, 16);
      const importanceRaw = Number(eventRecord.importance);
      const importance = Number.isFinite(importanceRaw) ? clamp01(importanceRaw) : 0.5;
      events.push({ id, description, characters, importance });
      if (events.length >= 64) break;
    }

    const changesSource = Array.isArray(item.characterChanges) ? item.characterChanges : [];
    const characterChanges: PdfChapterFactChange[] = [];
    for (const changeValue of changesSource) {
      const changeRecord = asRecord(changeValue);
      if (!changeRecord) continue;
      const character = String(changeRecord.character || "").trim();
      const before = String(changeRecord.before || "").trim();
      const after = String(changeRecord.after || "").trim();
      const reason = String(changeRecord.reason || "").trim();
      if (!character || !before || !after || !reason) continue;
      characterChanges.push({ character, before, after, reason });
      if (characterChanges.length >= 64) break;
    }

    const conflictsSource = Array.isArray(item.conflicts) ? item.conflicts : [];
    const conflicts: PdfChapterFactConflict[] = [];
    for (const conflictValue of conflictsSource) {
      const conflictRecord = asRecord(conflictValue);
      if (!conflictRecord) continue;
      const typeRaw = String(conflictRecord.type || "").trim().toLowerCase();
      const type = typeRaw === "internal" ? "internal" : "external";
      const description = String(conflictRecord.description || "").trim();
      if (!description) continue;
      const participants = normalizeStringLikeList(conflictRecord.participants, 16);
      conflicts.push({ type, description, participants });
      if (conflicts.length >= 64) break;
    }

    const symbolsSource = Array.isArray(item.symbols) ? item.symbols : [];
    const symbols: PdfChapterFactSymbol[] = [];
    for (const symbolValue of symbolsSource) {
      const symbolRecord = asRecord(symbolValue);
      if (!symbolRecord) continue;
      const entity = String(symbolRecord.entity || "").trim();
      const description = String(symbolRecord.description || "").trim();
      const context = String(symbolRecord.context || "").trim();
      if (!entity || !description || !context) continue;
      symbols.push({ entity, description, context });
      if (symbols.length >= 64) break;
    }

    const facts = normalizeStringLikeList(item.facts, 128);

    chapterFacts.push({
      chapterOrderIndex,
      chapterTitle,
      events,
      characterChanges,
      conflicts,
      symbols,
      facts,
    });
  }

  chapterFacts.sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex);
  return {
    chapterFactsCount,
    chapterFacts,
  };
}

function parsePatternsFromSectionsJson(sectionsJson: unknown): PdfPattern[] {
  const root = asRecord(sectionsJson) || {};
  const source = Array.isArray(root.patterns) ? root.patterns : [];
  const patterns: PdfPattern[] = [];

  const normalizeEvidenceType = (
    rawType: unknown
  ): "event" | "characterChange" | "conflict" | "symbol" | "fact" | null => {
    const value = String(rawType || "").trim().toLowerCase();
    if (value === "event") return "event";
    if (value === "characterchange") return "characterChange";
    if (value === "conflict") return "conflict";
    if (value === "symbol") return "symbol";
    if (value === "fact") return "fact";
    return null;
  };

  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    const record = asRecord(item);
    if (!record) continue;

    const id = String(record.id || `pattern_${index + 1}`).trim() || `pattern_${index + 1}`;
    const name = String(record.name || "").trim();
    const core = String(record.core || record.description || "").trim();
    const whyItMatters = String(record.whyItMatters || "").trim();
    const evolution = String(record.evolution || "").trim();
    const strengthRaw = Number(record.strength);
    const strength = Number.isFinite(strengthRaw) ? clamp01(strengthRaw) : 0.5;
    if (!name || !core || !whyItMatters || !evolution) continue;

    const evidenceSource = Array.isArray(record.evidence) ? record.evidence : [];
    const evidence: PdfPattern["evidence"] = [];

    for (const evidenceValue of evidenceSource) {
      const evidenceRecord = asRecord(evidenceValue);
      if (!evidenceRecord) continue;
      const ref = String(evidenceRecord.ref || "").trim();
      if (!ref) continue;
      const type = normalizeEvidenceType(evidenceRecord.type);
      if (!type) continue;
      const chapterRaw = Number(evidenceRecord.chapter);
      if (!Number.isFinite(chapterRaw) || chapterRaw < 1) continue;
      const chapter = Math.min(5000, Math.max(1, Math.floor(chapterRaw)));
      evidence.push({ type, chapter, ref });
      if (evidence.length >= 16) break;
    }

    patterns.push({
      id,
      name,
      core,
      whyItMatters,
      evidence,
      evolution,
      strength,
    });
    if (patterns.length >= 12) break;
  }

  return patterns;
}

async function loadFontBytes(): Promise<Uint8Array> {
  const candidates = [
    path.join(process.cwd(), "src", "assets", "fonts", "LiberationSans-Regular.ttf"),
    path.join(process.cwd(), "apps", "web", "src", "assets", "fonts", "LiberationSans-Regular.ttf"),
  ];

  for (const filePath of candidates) {
    try {
      return await readFile(filePath);
    } catch {
      // Try next candidate.
    }
  }

  throw new Error("PDF font file not found");
}

function drawSection(cursor: PdfCursor, index: number, section: BookLiteraryAnalysisDTO["sections"][keyof BookLiteraryAnalysisDTO["sections"]]): void {
  drawWrappedText(cursor, `${index + 1}. ${section.title}`, {
    size: 16,
    lineHeight: 21,
    color: rgb(0.07, 0.07, 0.09),
  });
  addVerticalSpace(cursor, 6);

  drawWrappedText(cursor, "Кратко", {
    size: 12,
    lineHeight: 16,
    color: rgb(0.11, 0.11, 0.13),
  });
  drawWrappedText(cursor, toPlainText(section.summary), {
    size: 11,
    lineHeight: 15,
  });
  addVerticalSpace(cursor, 4);

  if (section.bullets.length > 0) {
    drawWrappedText(cursor, "Ключевые тезисы", {
      size: 12,
      lineHeight: 16,
      color: rgb(0.11, 0.11, 0.13),
    });
    for (const bullet of section.bullets) {
      drawWrappedText(cursor, `• ${toPlainText(bullet)}`, {
        size: 11,
        lineHeight: 15,
      });
    }
    addVerticalSpace(cursor, 4);
  }

  drawWrappedText(cursor, "Разбор", {
    size: 12,
    lineHeight: 16,
    color: rgb(0.11, 0.11, 0.13),
  });
  drawWrappedText(cursor, toPlainText(section.bodyMarkdown), {
    size: 11,
    lineHeight: 15,
  });

  if (section.evidenceQuoteIds.length > 0) {
    addVerticalSpace(cursor, 3);
    drawWrappedText(cursor, `Цитат-оснований: ${section.evidenceQuoteIds.length}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.35, 0.35, 0.38),
    });
  }

  addVerticalSpace(cursor, 14);
}

function drawChapterPasses(
  cursor: PdfCursor,
  chapterPasses: PdfChapterPass[],
  sectionTitleByKey: Record<LiterarySectionKeyDTO, string>
): void {
  if (chapterPasses.length === 0) return;

  drawWrappedText(cursor, "Покапитульный анализ (debug)", {
    size: 18,
    lineHeight: 24,
    color: rgb(0.07, 0.07, 0.09),
  });
  addVerticalSpace(cursor, 8);

  for (const chapter of chapterPasses) {
    drawWrappedText(cursor, `Глава ${chapter.chapterOrderIndex}: ${chapter.chapterTitle}`, {
      size: 14,
      lineHeight: 19,
      color: rgb(0.1, 0.1, 0.12),
    });
    addVerticalSpace(cursor, 4);

    for (const key of LITERARY_SECTION_KEYS) {
      const section = chapter.sections[key];
      if (!section.summary && section.bullets.length === 0) continue;

      const confidencePercent = Math.round(clamp01(section.confidence) * 100);
      const header = `${sectionTitleByKey[key]} (${confidencePercent}%)`;
      drawWrappedText(
        cursor,
        section.summary ? `• ${header}: ${toPlainText(section.summary)}` : `• ${header}`,
        {
          size: 10,
          lineHeight: 13,
          color: rgb(0.16, 0.16, 0.18),
        }
      );

      for (const bullet of section.bullets) {
        drawWrappedText(cursor, `- ${toPlainText(bullet)}`, {
          size: 10,
          lineHeight: 13,
          color: rgb(0.26, 0.26, 0.28),
        });
      }
    }

    addVerticalSpace(cursor, 8);
  }
}

function drawChapterFacts(cursor: PdfCursor, chapterFacts: PdfChapterFacts[]): void {
  if (chapterFacts.length === 0) return;

  drawWrappedText(cursor, "Покапитульные структурные факты (debug)", {
    size: 18,
    lineHeight: 24,
    color: rgb(0.07, 0.07, 0.09),
  });
  addVerticalSpace(cursor, 8);

  for (const chapter of chapterFacts) {
    drawWrappedText(cursor, `Глава ${chapter.chapterOrderIndex}: ${chapter.chapterTitle}`, {
      size: 14,
      lineHeight: 19,
      color: rgb(0.1, 0.1, 0.12),
    });
    addVerticalSpace(cursor, 4);

    if (chapter.events.length > 0) {
      drawWrappedText(cursor, "События:", {
        size: 11,
        lineHeight: 15,
        color: rgb(0.12, 0.12, 0.14),
      });
      for (const event of chapter.events.slice(0, 16)) {
        const importancePercent = Math.round(clamp01(event.importance) * 100);
        const characters = event.characters.length > 0 ? ` [${event.characters.join(", ")}]` : "";
        drawWrappedText(cursor, `• (${importancePercent}%) ${toPlainText(event.description)}${characters}`, {
          size: 10,
          lineHeight: 13,
          color: rgb(0.18, 0.18, 0.2),
        });
      }
    }

    if (chapter.characterChanges.length > 0) {
      drawWrappedText(cursor, "Изменения персонажей:", {
        size: 11,
        lineHeight: 15,
        color: rgb(0.12, 0.12, 0.14),
      });
      for (const change of chapter.characterChanges.slice(0, 12)) {
        drawWrappedText(
          cursor,
          `• ${change.character}: ${toPlainText(change.before)} -> ${toPlainText(change.after)} (причина: ${toPlainText(change.reason)})`,
          {
            size: 10,
            lineHeight: 13,
            color: rgb(0.18, 0.18, 0.2),
          }
        );
      }
    }

    if (chapter.conflicts.length > 0) {
      drawWrappedText(cursor, "Конфликты:", {
        size: 11,
        lineHeight: 15,
        color: rgb(0.12, 0.12, 0.14),
      });
      for (const conflict of chapter.conflicts.slice(0, 12)) {
        const participants = conflict.participants.length > 0 ? ` [${conflict.participants.join(", ")}]` : "";
        drawWrappedText(
          cursor,
          `• (${conflict.type}) ${toPlainText(conflict.description)}${participants}`,
          {
            size: 10,
            lineHeight: 13,
            color: rgb(0.18, 0.18, 0.2),
          }
        );
      }
    }

    if (chapter.symbols.length > 0) {
      drawWrappedText(cursor, "Символы/образы:", {
        size: 11,
        lineHeight: 15,
        color: rgb(0.12, 0.12, 0.14),
      });
      for (const symbol of chapter.symbols.slice(0, 12)) {
        drawWrappedText(
          cursor,
          `• ${toPlainText(symbol.entity)}: ${toPlainText(symbol.description)} (контекст: ${toPlainText(symbol.context)})`,
          {
            size: 10,
            lineHeight: 13,
            color: rgb(0.18, 0.18, 0.2),
          }
        );
      }
    }

    if (chapter.facts.length > 0) {
      drawWrappedText(cursor, "Важные факты:", {
        size: 11,
        lineHeight: 15,
        color: rgb(0.12, 0.12, 0.14),
      });
      for (const fact of chapter.facts.slice(0, 16)) {
        drawWrappedText(cursor, `• ${toPlainText(fact)}`, {
          size: 10,
          lineHeight: 13,
          color: rgb(0.18, 0.18, 0.2),
        });
      }
    }

    addVerticalSpace(cursor, 8);
  }
}

function drawPatterns(cursor: PdfCursor, patterns: PdfPattern[]): void {
  if (patterns.length === 0) return;

  drawWrappedText(cursor, "Паттерны книги (debug)", {
    size: 18,
    lineHeight: 24,
    color: rgb(0.07, 0.07, 0.09),
  });
  addVerticalSpace(cursor, 8);

  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    drawWrappedText(cursor, `${index + 1}. ${toPlainText(pattern.name)} (${toPlainText(pattern.id)})`, {
      size: 13,
      lineHeight: 18,
      color: rgb(0.1, 0.1, 0.12),
    });

    drawWrappedText(cursor, `Ядро: ${toPlainText(pattern.core)}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.16, 0.16, 0.18),
    });

    const strengthPercent = Math.round(clamp01(pattern.strength) * 100);
    drawWrappedText(cursor, `Сила: ${strengthPercent}%`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.16, 0.16, 0.18),
    });

    drawWrappedText(cursor, `Почему важно: ${toPlainText(pattern.whyItMatters)}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.16, 0.16, 0.18),
    });

    if (pattern.evidence.length > 0) {
      drawWrappedText(cursor, "Основания:", {
        size: 10,
        lineHeight: 14,
        color: rgb(0.2, 0.2, 0.22),
      });
      for (const evidenceItem of pattern.evidence.slice(0, 8)) {
        drawWrappedText(cursor, `• (${evidenceItem.type}, гл. ${evidenceItem.chapter}) ${toPlainText(evidenceItem.ref)}`, {
          size: 10,
          lineHeight: 13,
          color: rgb(0.25, 0.25, 0.27),
        });
      }
    }

    drawWrappedText(cursor, `Эволюция: ${toPlainText(pattern.evolution)}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.18, 0.18, 0.2),
    });
    addVerticalSpace(cursor, 7);
  }
}

async function buildAnalysisPdf(params: {
  bookTitle: string;
  bookAuthor: string | null;
  analysis: BookLiteraryAnalysisDTO;
  pipeline: string | null;
  chapterPassCount: number | null;
  chapterPasses: PdfChapterPass[];
  chapterFactsCount: number | null;
  chapterFacts: PdfChapterFacts[];
  patterns: PdfPattern[];
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const fontBytes = await loadFontBytes();
  const font = await pdfDoc.embedFont(fontBytes);
  const cursor = createCursor(pdfDoc, font);

  drawWrappedText(cursor, "Литературный анализ произведения", {
    size: 20,
    lineHeight: 26,
    color: rgb(0.06, 0.06, 0.08),
  });
  addVerticalSpace(cursor, 4);

  drawWrappedText(cursor, params.bookTitle, {
    size: 16,
    lineHeight: 22,
    color: rgb(0.1, 0.1, 0.12),
  });

  if (params.bookAuthor && params.bookAuthor.trim()) {
    addVerticalSpace(cursor, 2);
    drawWrappedText(cursor, `Автор: ${params.bookAuthor.trim()}`, {
      size: 11,
      lineHeight: 15,
      color: rgb(0.28, 0.28, 0.31),
    });
  }

  const exportedAt = new Date().toLocaleString("ru-RU", { timeZone: "UTC" });
  drawWrappedText(cursor, `Сформировано: ${exportedAt} (UTC)`, {
    size: 10,
    lineHeight: 14,
    color: rgb(0.38, 0.38, 0.41),
  });

  if (params.pipeline) {
    drawWrappedText(cursor, `Pipeline: ${params.pipeline}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.38, 0.38, 0.41),
    });
  }

  const debugCount =
    params.chapterFactsCount ??
    params.chapterPassCount ??
    (params.chapterFacts.length > 0 ? params.chapterFacts.length : params.chapterPasses.length);
  if (debugCount > 0) {
    drawWrappedText(cursor, `Покапитульных блоков: ${debugCount}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.38, 0.38, 0.41),
    });
  }

  if (params.patterns.length > 0) {
    drawWrappedText(cursor, `Паттернов: ${params.patterns.length}`, {
      size: 10,
      lineHeight: 14,
      color: rgb(0.38, 0.38, 0.41),
    });
  }

  addVerticalSpace(cursor, 14);

  const sectionTitleByKey = Object.fromEntries(
    LITERARY_SECTION_KEYS.map((key) => [key, params.analysis.sections[key].title])
  ) as Record<LiterarySectionKeyDTO, string>;

  if (params.chapterFacts.length > 0) {
    drawChapterFacts(cursor, params.chapterFacts);
  } else {
    drawChapterPasses(cursor, params.chapterPasses, sectionTitleByKey);
  }

  drawPatterns(cursor, params.patterns);

  drawWrappedText(cursor, "Итоговый анализ (UI)", {
    size: 18,
    lineHeight: 24,
    color: rgb(0.07, 0.07, 0.09),
  });
  addVerticalSpace(cursor, 8);

  const orderedSections = LITERARY_SECTION_KEYS.map((key) => params.analysis.sections[key]);
  orderedSections.forEach((section, index) => drawSection(cursor, index, section));

  const pages = pdfDoc.getPages();
  const pageCount = pages.length;
  for (let i = 0; i < pageCount; i += 1) {
    const page = pages[i];
    const pageLabel = `${i + 1}/${pageCount}`;
    const width = font.widthOfTextAtSize(pageLabel, 9);
    page.drawText(pageLabel, {
      x: A4_WIDTH - PAGE_MARGIN - width,
      y: PAGE_MARGIN / 2,
      size: 9,
      font,
      color: rgb(0.45, 0.45, 0.48),
    });
  }

  return pdfDoc.save();
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      isPublic: true,
      ownerUserId: true,
    },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const analysis = await prisma.bookLiteraryAnalysis.findUnique({
    where: { bookId },
    select: {
      bookId: true,
      sectionsJson: true,
      updatedAt: true,
    },
  });

  if (!analysis) {
    return NextResponse.json({ error: "Literary analysis not found" }, { status: 404 });
  }

  try {
    const dto = toBookLiteraryAnalysisDTO(analysis);
    const chapterDebug = parseChapterPassesFromSectionsJson(analysis.sectionsJson);
    const chapterFactsDebug = parseChapterFactsFromSectionsJson(analysis.sectionsJson);
    const patternsDebug = parsePatternsFromSectionsJson(analysis.sectionsJson);
    const pdfBytes = await buildAnalysisPdf({
      bookTitle: book.title,
      bookAuthor: book.author,
      analysis: dto,
      pipeline: chapterDebug.pipeline,
      chapterPassCount: chapterDebug.chapterPassCount,
      chapterPasses: chapterDebug.chapterPasses,
      chapterFactsCount: chapterFactsDebug.chapterFactsCount,
      chapterFacts: chapterFactsDebug.chapterFacts,
      patterns: patternsDebug,
    });
    const bodyBytes = new Uint8Array(pdfBytes);

    const fileBase = sanitizeFileName(book.title);
    const utf8Name = encodeURIComponent(`${fileBase}-analysis.pdf`);
    return new Response(bodyBytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="analysis-${book.id}.pdf"; filename*=UTF-8''${utf8Name}`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
