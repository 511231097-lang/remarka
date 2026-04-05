import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { z } from "zod";

export const BOOK_FORMATS = ["fb2", "fb2_zip"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];
export const BookFormatSchema = z.enum(BOOK_FORMATS);

export const PROJECT_IMPORT_STATES = ["queued", "running", "completed", "failed"] as const;
export type ProjectImportState = (typeof PROJECT_IMPORT_STATES)[number];
export const ProjectImportStateSchema = z.enum(PROJECT_IMPORT_STATES);

export const PROJECT_IMPORT_STAGES = [
  "queued",
  "loading_source",
  "parsing",
  "persisting",
  "scheduling_analysis",
  "completed",
  "failed",
] as const;
export type ProjectImportStage = (typeof PROJECT_IMPORT_STAGES)[number];
export const ProjectImportStageSchema = z.enum(PROJECT_IMPORT_STAGES);

export const IMPORT_ANALYSIS_MODEL_IDS = [
  "462a2c83-7b99-4eb8-b73a-284a98547ec0",
  "a438cea2-68e0-4a3b-81cf-bd5f5aac7510",
  "a87eb84d-06a9-4216-8d2e-57c3f25a21d1",
] as const;
export type ImportAnalysisModelId = (typeof IMPORT_ANALYSIS_MODEL_IDS)[number];
export const ImportAnalysisModelIdSchema = z.enum(IMPORT_ANALYSIS_MODEL_IDS);

export const IMPORT_ANALYSIS_MODEL_OPTIONS: Array<{
  id: ImportAnalysisModelId;
  code: "grok" | "qwen" | "flash";
  label: string;
}> = [
  {
    id: "462a2c83-7b99-4eb8-b73a-284a98547ec0",
    code: "grok",
    label: "Grok",
  },
  {
    id: "a438cea2-68e0-4a3b-81cf-bd5f5aac7510",
    code: "qwen",
    label: "Qwen",
  },
  {
    id: "a87eb84d-06a9-4216-8d2e-57c3f25a21d1",
    code: "flash",
    label: "Flash",
  },
];

export function normalizeImportAnalysisModelId(value: unknown): ImportAnalysisModelId | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = ImportAnalysisModelIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function getImportAnalysisModelLabel(modelId: string | null | undefined): string | null {
  const normalized = normalizeImportAnalysisModelId(modelId);
  if (!normalized) return null;
  return IMPORT_ANALYSIS_MODEL_OPTIONS.find((item) => item.id === normalized)?.label || null;
}

export const ParsedInlineMarkSchema = z.enum(["bold", "italic"]);
export type ParsedInlineMark = z.infer<typeof ParsedInlineMarkSchema>;

export const ParsedInlineSchema = z
  .object({
    text: z.string(),
    marks: z.array(ParsedInlineMarkSchema).default([]),
  })
  .strict();
export type ParsedInline = z.infer<typeof ParsedInlineSchema>;

export const ParsedBlockSchema = z
  .object({
    type: z.enum(["heading", "paragraph", "subtitle", "quote", "poem"]),
    level: z.number().int().min(1).max(6).optional(),
    inlines: z.array(ParsedInlineSchema).default([]),
  })
  .strict();
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;

export const ParsedChapterSchema = z
  .object({
    title: z.string().trim().min(1),
    blocks: z.array(ParsedBlockSchema).default([]),
  })
  .strict();
export type ParsedChapter = z.infer<typeof ParsedChapterSchema>;

export const ParsedBookSchema = z
  .object({
    format: BookFormatSchema,
    metadata: z
      .object({
        title: z.string().trim().optional(),
        author: z.string().trim().optional(),
        annotation: z.string().trim().optional(),
      })
      .strict(),
    chapters: z.array(ParsedChapterSchema).default([]),
  })
  .strict();
export type ParsedBook = z.infer<typeof ParsedBookSchema>;

export const ProjectImportPayloadSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    format: BookFormatSchema,
    state: ProjectImportStateSchema,
    stage: ProjectImportStageSchema,
    error: z.string().nullable(),
    chapterCount: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    selectedModelId: ImportAnalysisModelIdSchema.nullable(),
    selectedModelLabel: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ProjectImportPayload = z.infer<typeof ProjectImportPayloadSchema>;

export interface BookParseInput {
  format: BookFormat;
  fileName: string;
  bytes: Uint8Array;
  maxZipUncompressedBytes?: number;
}

export interface BookParser {
  parse(input: BookParseInput): Promise<ParsedBook>;
}

export class BookImportError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BookImportError";
    this.code = code;
  }
}

function normalizeWhitespace(value: string): string {
  return String(value || "")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

function canonicalizeContent(content: string): string {
  const normalized = String(content || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trim();

  return normalized.replace(/\n{3,}/g, "\n\n");
}

function localNameOf(node: Node | null): string {
  if (!node) return "";
  const direct = (node as any).localName;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const nodeName = String((node as any).nodeName || "");
  if (!nodeName) return "";
  const value = nodeName.includes(":") ? nodeName.split(":").pop() || "" : nodeName;
  return value.trim().toLowerCase();
}

function childElements(node: Node | null): Element[] {
  if (!node || !(node as any).childNodes) return [];
  const children = (node as any).childNodes;
  const result: Element[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as Node;
    if ((child as any).nodeType === 1) {
      result.push(child as unknown as Element);
    }
  }

  return result;
}

function childrenByLocalName(node: Node | null, name: string): Element[] {
  const target = name.trim().toLowerCase();
  return childElements(node).filter((child) => localNameOf(child) === target);
}

function firstChildByLocalName(node: Node | null, name: string): Element | null {
  const target = name.trim().toLowerCase();
  return childElements(node).find((child) => localNameOf(child) === target) || null;
}

function firstByPath(node: Node | null, path: string[]): Element | null {
  let current: Element | null = (node as unknown as Element) || null;
  for (const segment of path) {
    current = firstChildByLocalName(current, segment);
    if (!current) return null;
  }
  return current;
}

function textNodeValue(node: Node | null): string {
  if (!node) return "";
  return String((node as any).nodeValue || "");
}

function marksKey(marks: ParsedInlineMark[]): string {
  return [...marks].sort().join(",");
}

function pushInline(out: ParsedInline[], text: string, marks: ParsedInlineMark[]) {
  if (!text) return;
  const nextMarks = [...new Set(marks)].sort() as ParsedInlineMark[];
  const prev = out[out.length - 1];
  if (prev && marksKey(prev.marks) === marksKey(nextMarks)) {
    prev.text += text;
    return;
  }

  out.push({
    text,
    marks: nextMarks,
  });
}

function collectInline(node: Node | null, marks: ParsedInlineMark[] = [], out: ParsedInline[] = []): ParsedInline[] {
  if (!node) return out;

  const nodeType = (node as any).nodeType;
  if (nodeType === 3) {
    pushInline(out, textNodeValue(node), marks);
    return out;
  }

  if (nodeType !== 1) {
    return out;
  }

  const local = localNameOf(node);
  const nextMarks = [...marks];

  if (["strong", "b"].includes(local)) {
    nextMarks.push("bold");
  }
  if (["emphasis", "em", "i"].includes(local)) {
    nextMarks.push("italic");
  }
  if (["empty-line", "br"].includes(local)) {
    pushInline(out, "\n", marks);
    return out;
  }

  const children = childElements(node);
  if (!children.length && (node as any).childNodes) {
    const rawChildren = (node as any).childNodes;
    for (let index = 0; index < rawChildren.length; index += 1) {
      collectInline(rawChildren[index] as Node, nextMarks, out);
    }
    return out;
  }

  const rawChildren = (node as any).childNodes;
  for (let index = 0; index < rawChildren.length; index += 1) {
    collectInline(rawChildren[index] as Node, nextMarks, out);
  }

  return out;
}

function normalizeInlines(inlines: ParsedInline[]): ParsedInline[] {
  const result: ParsedInline[] = [];
  for (const item of inlines) {
    if (!item.text) continue;
    const marks = [...new Set(item.marks)].sort() as ParsedInlineMark[];
    const previous = result[result.length - 1];
    if (previous && marksKey(previous.marks) === marksKey(marks)) {
      previous.text += item.text;
      continue;
    }
    result.push({ text: item.text, marks });
  }
  return result;
}

function textFromElement(element: Element | null): string {
  if (!element) return "";
  const inlines = normalizeInlines(collectInline(element));
  return normalizeWhitespace(inlines.map((item) => item.text).join(""));
}

function inlineFromElement(element: Element | null): ParsedInline[] {
  if (!element) return [];
  const inlines = normalizeInlines(collectInline(element));

  return inlines
    .map((item) => ({ ...item, text: item.text.replace(/\r\n?/g, "\n") }))
    .filter((item) => item.text.length > 0);
}

function sectionTitle(section: Element | null): string {
  const title = firstChildByLocalName(section, "title");
  if (!title) return "";
  const paragraphs = childrenByLocalName(title, "p").map((item) => textFromElement(item)).filter(Boolean);
  if (paragraphs.length) return normalizeWhitespace(paragraphs.join(" "));
  return textFromElement(title);
}

function poemInlineFromElement(poem: Element): ParsedInline[] {
  const stanzas = childrenByLocalName(poem, "stanza");
  const lines: string[] = [];

  if (stanzas.length) {
    stanzas.forEach((stanza, stanzaIndex) => {
      const stanzaLines = childrenByLocalName(stanza, "v")
        .map((line) => textFromElement(line))
        .filter(Boolean);
      lines.push(...stanzaLines);
      if (stanzaIndex < stanzas.length - 1 && stanzaLines.length) {
        lines.push("");
      }
    });
  } else {
    lines.push(
      ...childrenByLocalName(poem, "v")
        .map((line) => textFromElement(line))
        .filter(Boolean)
    );
  }

  if (!lines.length) {
    lines.push(
      ...childrenByLocalName(poem, "p")
        .map((line) => textFromElement(line))
        .filter(Boolean)
    );
  }

  return lines.length ? [{ text: lines.join("\n"), marks: [] }] : [];
}

function parseSectionBlocks(section: Element, nestedLevel: number): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  for (const child of childElements(section)) {
    const local = localNameOf(child);

    if (local === "title") {
      continue;
    }

    if (local === "section") {
      const title = sectionTitle(child);
      if (title) {
        blocks.push({
          type: "heading",
          level: Math.max(2, Math.min(6, nestedLevel)),
          inlines: [{ text: title, marks: [] }],
        });
      }
      blocks.push(...parseSectionBlocks(child, nestedLevel + 1));
      continue;
    }

    if (local === "p") {
      const inlines = inlineFromElement(child);
      if (inlines.length) {
        blocks.push({ type: "paragraph", inlines });
      }
      continue;
    }

    if (local === "subtitle") {
      const inlines = inlineFromElement(child);
      if (inlines.length) {
        blocks.push({ type: "subtitle", inlines, level: Math.max(2, Math.min(6, nestedLevel)) });
      }
      continue;
    }

    if (local === "cite" || local === "epigraph") {
      const quoteLines = childrenByLocalName(child, "p")
        .map((item) => inlineFromElement(item))
        .filter((item) => item.length)
        .map((parts) => parts.map((part) => part.text).join(""))
        .filter(Boolean);
      if (quoteLines.length) {
        blocks.push({
          type: "quote",
          inlines: [{ text: quoteLines.join("\n"), marks: [] }],
        });
      }
      continue;
    }

    if (local === "poem") {
      const inlines = poemInlineFromElement(child);
      if (inlines.length) {
        blocks.push({ type: "poem", inlines });
      }
      continue;
    }
  }

  return blocks;
}

function parseFb2BodyToChapters(body: Element | null): ParsedChapter[] {
  if (!body) return [];

  const sections = childrenByLocalName(body, "section");
  if (!sections.length) {
    const blocks: ParsedBlock[] = [];
    for (const child of childElements(body)) {
      const local = localNameOf(child);
      if (local === "title") continue;
      if (local === "p") {
        const inlines = inlineFromElement(child);
        if (inlines.length) {
          blocks.push({ type: "paragraph", inlines });
        }
      }
    }

    if (!blocks.length) {
      return [];
    }

    return [
      {
        title: "Глава 1",
        blocks,
      },
    ];
  }

  return sections.map((section, index) => {
    const title = sectionTitle(section) || `Глава ${index + 1}`;
    const blocks = parseSectionBlocks(section, 2);
    return {
      title,
      blocks,
    };
  });
}

function parseAnnotation(titleInfo: Element | null): string {
  const annotationNode = firstChildByLocalName(titleInfo, "annotation");
  if (!annotationNode) return "";

  const paragraphs = childrenByLocalName(annotationNode, "p").map((item) => textFromElement(item)).filter(Boolean);
  if (paragraphs.length) {
    return paragraphs.join("\n\n");
  }

  return textFromElement(annotationNode);
}

function parseAuthor(titleInfo: Element | null): string {
  const author = firstChildByLocalName(titleInfo, "author");
  if (!author) return "";

  const parts = [
    textFromElement(firstChildByLocalName(author, "first-name")),
    textFromElement(firstChildByLocalName(author, "middle-name")),
    textFromElement(firstChildByLocalName(author, "last-name")),
    textFromElement(firstChildByLocalName(author, "nickname")),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return normalizeWhitespace(parts.join(" "));
}

function resolveMainBody(root: Element): Element | null {
  const bodies = childrenByLocalName(root, "body");
  if (!bodies.length) return null;

  const main = bodies.find((body) => {
    const name = String(body.getAttribute("name") || "").trim().toLowerCase();
    return name !== "notes";
  });

  return main || bodies[0] || null;
}

export function parseFb2BookFromXml(xml: string): ParsedBook {
  const source = String(xml || "").trim();
  if (!source) {
    throw new BookImportError("FB2_EMPTY", "FB2 file is empty");
  }

  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: () => undefined,
    },
  }).parseFromString(source, "text/xml");

  const root = firstChildByLocalName(document as unknown as Element, "fictionbook");
  if (!root) {
    throw new BookImportError("FB2_PARSE_FAILED", "Unable to parse FB2 XML");
  }

  const titleInfo = firstByPath(root, ["description", "title-info"]);
  const mainBody = resolveMainBody(root);

  const metadata = {
    title: textFromElement(firstChildByLocalName(titleInfo, "book-title")) || undefined,
    author: parseAuthor(titleInfo) || undefined,
    annotation: parseAnnotation(titleInfo) || undefined,
  };

  const chapters = parseFb2BodyToChapters(mainBody);
  const normalized = ParsedBookSchema.safeParse({
    format: "fb2",
    metadata,
    chapters,
  });

  if (!normalized.success) {
    throw new BookImportError("FB2_NORMALIZE_FAILED", "Failed to normalize parsed FB2 content");
  }

  return normalized.data;
}

function normalizeXmlEncodingLabel(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  if (!normalized) return "";
  if (normalized === "utf8") return "utf-8";
  if (normalized === "cp1251" || normalized === "windows1251" || normalized === "win-1251") {
    return "windows-1251";
  }

  return normalized;
}

function decodeWithEncoding(bytes: Uint8Array, encoding: string, fatal = false): string | null {
  const normalizedEncoding = normalizeXmlEncodingLabel(encoding);
  if (!normalizedEncoding) return null;

  try {
    return new TextDecoder(normalizedEncoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function detectXmlDeclaredEncoding(bytes: Uint8Array): string | null {
  const previewLength = Math.min(bytes.byteLength, 2048);
  const previewBytes = bytes.slice(0, previewLength);
  const preview = new TextDecoder("latin1", { fatal: false }).decode(previewBytes);
  const match = preview.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  if (!match?.[1]) return null;
  const normalized = normalizeXmlEncodingLabel(match[1]);
  return normalized || null;
}

function replacementRatio(value: string): number {
  const text = String(value || "");
  if (!text) return 0;

  let replacements = 0;
  for (const char of text) {
    if (char === "\uFFFD") replacements += 1;
  }

  return replacements / text.length;
}

function looksLikeFb2Xml(value: string): boolean {
  return /<\s*fictionbook(?:\s|>)/i.test(String(value || ""));
}

export function decodeFb2XmlBytes(bytes: Uint8Array): string {
  const declaredEncoding = detectXmlDeclaredEncoding(bytes);
  if (declaredEncoding) {
    const declaredDecoded = decodeWithEncoding(bytes, declaredEncoding, false);
    if (declaredDecoded !== null) {
      return declaredDecoded;
    }
  }

  const utf8Strict = decodeWithEncoding(bytes, "utf-8", true);
  if (utf8Strict !== null) {
    return utf8Strict;
  }

  const utf8Loose = decodeWithEncoding(bytes, "utf-8", false) || "";
  if (replacementRatio(utf8Loose) <= 0.002) {
    return utf8Loose;
  }

  const windows1251 = decodeWithEncoding(bytes, "windows-1251", false);
  if (windows1251 !== null && looksLikeFb2Xml(windows1251)) {
    return windows1251;
  }

  if (windows1251 !== null) {
    return windows1251;
  }

  return utf8Loose;
}

export async function extractSingleFb2FromZip(
  bytes: Uint8Array,
  options: { maxUncompressedBytes?: number } = {}
): Promise<{ fileName: string; xml: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new BookImportError("FB2_ZIP_INVALID", "Invalid zip archive");
  }

  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .filter((entry) => entry.name.toLowerCase().endsWith(".fb2"));

  if (!entries.length) {
    throw new BookImportError("FB2_ZIP_NO_FB2", "Zip archive must contain one .fb2 file");
  }

  if (entries.length > 1) {
    throw new BookImportError("FB2_ZIP_MULTIPLE_FB2", "Zip archive must contain only one .fb2 file");
  }

  const entry = entries[0];
  const uncompressedBytes = await entry.async("uint8array");
  const maxUncompressedBytes = Math.max(1024, Number(options.maxUncompressedBytes || 50 * 1024 * 1024));

  if (uncompressedBytes.byteLength > maxUncompressedBytes) {
    throw new BookImportError("FB2_ZIP_TOO_LARGE", "Uncompressed FB2 exceeds allowed size");
  }

  const xml = decodeFb2XmlBytes(uncompressedBytes);
  return {
    fileName: entry.name,
    xml,
  };
}

export async function parseBook(input: BookParseInput): Promise<ParsedBook> {
  if (input.format === "fb2") {
    const xml = decodeFb2XmlBytes(input.bytes);
    return parseFb2BookFromXml(xml);
  }

  if (input.format === "fb2_zip") {
    const extracted = await extractSingleFb2FromZip(input.bytes, {
      maxUncompressedBytes: input.maxZipUncompressedBytes,
    });

    const parsed = parseFb2BookFromXml(extracted.xml);
    return {
      ...parsed,
      format: "fb2_zip",
      metadata: {
        ...parsed.metadata,
      },
    };
  }

  throw new BookImportError("UNSUPPORTED_FORMAT", `Unsupported book format: ${input.format}`);
}

export function detectBookFormatFromFileName(fileName: string): BookFormat | null {
  const normalized = String(fileName || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.endsWith(".fb2.zip")) return "fb2_zip";
  if (normalized.endsWith(".fb2")) return "fb2";
  return null;
}

export function inferBookTitleFromFileName(fileName: string): string {
  const normalized = String(fileName || "").trim();
  if (!normalized) return "";

  const withoutDirs = normalized.replace(/\\/g, "/").split("/").pop() || normalized;
  const noExt = withoutDirs.replace(/\.fb2(?:\.zip)?$/i, "");

  return noExt
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapMarks(marks: ParsedInlineMark[]): Array<{ type: "bold" | "italic" }> | undefined {
  if (!marks.length) return undefined;
  const unique = [...new Set(marks)];

  const mapped = unique
    .map((mark) => {
      if (mark === "bold") {
        return { type: "bold" as const };
      }
      if (mark === "italic") {
        return { type: "italic" as const };
      }
      return null;
    })
    .filter((item): item is { type: "bold" | "italic" } => Boolean(item));

  return mapped.length ? mapped : undefined;
}

function inlineToRichNodes(inlines: ParsedInline[]): any[] {
  const nodes: any[] = [];

  for (const inline of inlines) {
    const text = String(inline.text || "");
    if (!text) continue;

    const marks = mapMarks(inline.marks || []);
    const parts = text.split("\n");

    parts.forEach((part, index) => {
      if (part) {
        nodes.push({
          type: "text",
          text: part,
          ...(marks ? { marks } : {}),
        });
      }

      if (index < parts.length - 1) {
        nodes.push({ type: "hardBreak" });
      }
    });
  }

  return nodes;
}

function paragraphNode(inlines: ParsedInline[]): any {
  const content = inlineToRichNodes(inlines);
  return content.length
    ? {
        type: "paragraph",
        content,
      }
    : {
        type: "paragraph",
      };
}

export function buildRichContentFromParsedChapter(chapter: ParsedChapter): unknown {
  const parsed = ParsedChapterSchema.parse(chapter);
  const content: any[] = [];

  for (const block of parsed.blocks) {
    if (block.type === "heading" || block.type === "subtitle") {
      const headingContent = inlineToRichNodes(block.inlines);
      content.push({
        type: "heading",
        attrs: {
          level: Math.max(1, Math.min(6, Number(block.level || (block.type === "subtitle" ? 3 : 2)))),
        },
        ...(headingContent.length ? { content: headingContent } : {}),
      });
      continue;
    }

    if (block.type === "quote") {
      content.push({
        type: "blockquote",
        content: [paragraphNode(block.inlines)],
      });
      continue;
    }

    content.push(paragraphNode(block.inlines));
  }

  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

function plainTextFromInlines(inlines: ParsedInline[]): string {
  return inlines.map((inline) => inline.text).join("");
}

export function buildPlainTextFromParsedChapter(chapter: ParsedChapter): string {
  const parsed = ParsedChapterSchema.parse(chapter);
  const parts = parsed.blocks
    .map((block) => plainTextFromInlines(block.inlines))
    .map((value) => value.trim())
    .filter(Boolean);

  return canonicalizeContent(parts.join("\n\n"));
}

export function ensureParsedBookHasChapters(book: ParsedBook): ParsedBook {
  const parsed = ParsedBookSchema.parse(book);
  if (parsed.chapters.length) return parsed;

  return {
    ...parsed,
    chapters: [
      {
        title: "Глава 1",
        blocks: [{ type: "paragraph", inlines: [{ text: "", marks: [] }] }],
      },
    ],
  };
}
