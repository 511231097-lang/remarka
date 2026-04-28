import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { z } from "zod";

export const BOOK_FORMATS = ["fb2", "fb2_zip", "epub", "pdf"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];
export const BookFormatSchema = z.enum(BOOK_FORMATS);

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

function parseXmlDocument(source: string, errorCode: string, errorMessage: string): Document {
  const xml = String(source || "").trim();
  if (!xml) {
    throw new BookImportError(errorCode, errorMessage);
  }

  return new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: () => undefined,
    },
  }).parseFromString(xml, "text/xml");
}

function localElementName(element: Element): string {
  return localNameOf(element);
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

function zipDirname(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function normalizeZipPath(path: string): string {
  const parts = String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

function resolveZipHref(baseFilePath: string, href: string): string {
  const cleanHref = decodeURIComponent(String(href || "").split("#")[0] || "");
  if (!cleanHref) return "";
  if (cleanHref.startsWith("/")) return normalizeZipPath(cleanHref.slice(1));
  const base = zipDirname(baseFilePath);
  return normalizeZipPath(base ? `${base}/${cleanHref}` : cleanHref);
}

function extensionlessNameFromPath(path: string): string {
  const base = String(path || "").replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "").replace(/[._-]+/g, " ").trim();
}

function firstElementByLocalNameDeep(node: Node | null, name: string): Element | null {
  if (!node) return null;
  const target = name.trim().toLowerCase();
  if ((node as any).nodeType === 1 && localNameOf(node) === target) {
    return node as unknown as Element;
  }

  const children = (node as any).childNodes;
  if (!children) return null;
  for (let index = 0; index < children.length; index += 1) {
    const found = firstElementByLocalNameDeep(children[index] as Node, target);
    if (found) return found;
  }
  return null;
}

function childTextByAnyLocalName(node: Node | null, names: string[]): string {
  for (const name of names) {
    const value = textFromElement(firstChildByLocalName(node, name));
    if (value) return value;
  }
  return "";
}

function parseHtmlBlocks(root: Element | null): ParsedBlock[] {
  if (!root) return [];
  const blocks: ParsedBlock[] = [];

  function pushBlockFromElement(element: Element, type: ParsedBlock["type"], level?: number) {
    const inlines = inlineFromElement(element);
    if (!inlines.length || !normalizeWhitespace(inlines.map((inline) => inline.text).join(""))) return;
    blocks.push({
      type,
      ...(level ? { level } : {}),
      inlines,
    });
  }

  function walk(element: Element) {
    const local = localElementName(element);
    if (["script", "style", "nav", "head"].includes(local)) return;

    const headingMatch = local.match(/^h([1-6])$/);
    if (headingMatch) {
      pushBlockFromElement(element, "heading", Number(headingMatch[1]));
      return;
    }

    if (["title", "subtitle"].includes(local)) {
      pushBlockFromElement(element, "subtitle", 2);
      return;
    }

    if (["p", "li"].includes(local)) {
      pushBlockFromElement(element, "paragraph");
      return;
    }

    if (["blockquote", "q"].includes(local)) {
      pushBlockFromElement(element, "quote");
      return;
    }

    if (["pre"].includes(local)) {
      pushBlockFromElement(element, "poem");
      return;
    }

    for (const child of childElements(element)) {
      walk(child);
    }
  }

  walk(root);
  return blocks;
}

function titleFromBlocks(blocks: ParsedBlock[], fallback: string): string {
  for (const block of blocks) {
    if (block.type !== "heading" && block.type !== "subtitle") continue;
    const title = normalizeWhitespace(block.inlines.map((inline) => inline.text).join(""));
    if (title) return title;
  }
  return normalizeWhitespace(fallback) || "Глава";
}

export async function parseEpubBook(bytes: Uint8Array): Promise<ParsedBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new BookImportError("EPUB_INVALID", "Invalid EPUB archive");
  }

  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) {
    throw new BookImportError("EPUB_CONTAINER_MISSING", "EPUB container.xml is missing");
  }

  const containerXml = await containerEntry.async("text");
  const containerDoc = parseXmlDocument(containerXml, "EPUB_CONTAINER_INVALID", "Invalid EPUB container.xml");
  const rootfile = firstElementByLocalNameDeep(containerDoc as unknown as Node, "rootfile");
  const opfPath = String(rootfile?.getAttribute("full-path") || "").trim();
  if (!opfPath) {
    throw new BookImportError("EPUB_OPF_MISSING", "EPUB package document is missing");
  }

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) {
    throw new BookImportError("EPUB_OPF_MISSING", "EPUB package document is missing");
  }

  const opfXml = await opfEntry.async("text");
  const opfDoc = parseXmlDocument(opfXml, "EPUB_OPF_INVALID", "Invalid EPUB package document");
  const packageNode = firstElementByLocalNameDeep(opfDoc as unknown as Node, "package");
  const metadataNode = firstChildByLocalName(packageNode, "metadata");
  const manifestNode = firstChildByLocalName(packageNode, "manifest");
  const spineNode = firstChildByLocalName(packageNode, "spine");

  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of childrenByLocalName(manifestNode, "item")) {
    const id = String(item.getAttribute("id") || "").trim();
    const href = String(item.getAttribute("href") || "").trim();
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      mediaType: String(item.getAttribute("media-type") || "").trim().toLowerCase(),
    });
  }

  const spineIds = childrenByLocalName(spineNode, "itemref")
    .map((item) => String(item.getAttribute("idref") || "").trim())
    .filter(Boolean);
  if (!spineIds.length) {
    throw new BookImportError("EPUB_SPINE_EMPTY", "EPUB spine is empty");
  }

  const chapters: ParsedChapter[] = [];
  for (const idref of spineIds) {
    const item = manifest.get(idref);
    if (!item) continue;
    const mediaType = item.mediaType;
    const isHtml =
      mediaType.includes("html") ||
      /\.x?html?$/i.test(item.href);
    if (!isHtml) continue;

    const chapterPath = resolveZipHref(opfPath, item.href);
    const chapterEntry = zip.file(chapterPath);
    if (!chapterEntry) continue;

    const html = await chapterEntry.async("text");
    const doc = parseXmlDocument(html, "EPUB_CHAPTER_INVALID", `Invalid EPUB chapter: ${chapterPath}`);
    const body = firstElementByLocalNameDeep(doc as unknown as Node, "body") || firstElementByLocalNameDeep(doc as unknown as Node, "html");
    const blocks = parseHtmlBlocks(body);
    if (!blocks.length) continue;

    chapters.push({
      title: titleFromBlocks(blocks, extensionlessNameFromPath(chapterPath) || `Глава ${chapters.length + 1}`),
      blocks,
    });
  }

  if (!chapters.length) {
    throw new BookImportError("EPUB_TEXT_EMPTY", "EPUB does not contain readable text");
  }

  const metadata = {
    title: childTextByAnyLocalName(metadataNode, ["title"]) || undefined,
    author: childTextByAnyLocalName(metadataNode, ["creator", "author"]) || undefined,
    annotation: childTextByAnyLocalName(metadataNode, ["description", "annotation"]) || undefined,
  };

  const normalized = ParsedBookSchema.safeParse({
    format: "epub",
    metadata,
    chapters,
  });
  if (!normalized.success) {
    throw new BookImportError("EPUB_NORMALIZE_FAILED", "Failed to normalize parsed EPUB content");
  }
  return normalized.data;
}

function normalizePdfTextItems(items: Array<{ str?: unknown }>): string {
  const chunks = items
    .map((item) => String(item?.str || "").trim())
    .filter(Boolean);
  return canonicalizeContent(chunks.join(" "));
}

function classifyPdfLoadError(error: unknown): BookImportError {
  const name = String((error as { name?: unknown })?.name || "");
  const message = String((error as { message?: unknown })?.message || "");
  const code = String((error as { code?: unknown })?.code || "");
  const combined = `${name} ${message} ${code}`.toLowerCase();

  if (combined.includes("password") || combined.includes("encrypted")) {
    return new BookImportError("PDF_PASSWORD_PROTECTED", "PDF защищен паролем. Загрузите файл без пароля.");
  }

  return new BookImportError("PDF_INVALID", "Не удалось прочитать PDF. Проверьте, что файл не поврежден и является PDF-документом.");
}

export async function parsePdfBook(bytes: Uint8Array, fileName: string): Promise<ParsedBook> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const cwd = process.cwd().replace(/\\/g, "/");
  const workspaceRoot = cwd.endsWith("/apps/web") ? cwd.slice(0, -"/apps/web".length) : cwd;
  const workerPath = `${workspaceRoot}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`;
  pdfjs.GlobalWorkerOptions.workerSrc = `file://${workerPath.startsWith("/") ? "" : "/"}${workerPath}`;

  let pdf: any;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    } as any);
    pdf = await task.promise;
  } catch (error) {
    throw classifyPdfLoadError(error);
  }

  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info || {}) as { Title?: unknown; Author?: unknown; Subject?: unknown };
  const chapters: ParsedChapter[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = normalizePdfTextItems((textContent.items || []) as Array<{ str?: unknown }>);
      if (!pageText) continue;
      chapters.push({
        title: `Страница ${pageNumber}`,
        blocks: [
          {
            type: "paragraph",
            inlines: [{ text: pageText, marks: [] }],
          },
        ],
      });
    }
  } catch (error) {
    const message = String((error as { message?: unknown })?.message || "");
    throw new BookImportError(
      "PDF_TEXT_EXTRACT_FAILED",
      message ? `Не удалось извлечь текст из PDF: ${message}` : "Не удалось извлечь текст из PDF."
    );
  }

  if (!chapters.length) {
    throw new BookImportError("PDF_TEXT_EMPTY", "В PDF не найден извлекаемый текст. Загрузите PDF с текстовым слоем, не скан.");
  }

  const metadata = {
    title: normalizeWhitespace(String(info.Title || "")) || inferBookTitleFromFileName(fileName) || undefined,
    author: normalizeWhitespace(String(info.Author || "")) || undefined,
    annotation: normalizeWhitespace(String(info.Subject || "")) || undefined,
  };

  const normalized = ParsedBookSchema.safeParse({
    format: "pdf",
    metadata,
    chapters,
  });
  if (!normalized.success) {
    throw new BookImportError("PDF_NORMALIZE_FAILED", "Failed to normalize parsed PDF content");
  }
  return normalized.data;
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

  if (input.format === "epub") {
    return parseEpubBook(input.bytes);
  }

  if (input.format === "pdf") {
    return parsePdfBook(input.bytes, input.fileName);
  }

  throw new BookImportError("UNSUPPORTED_FORMAT", `Unsupported book format: ${input.format}`);
}

export function detectBookFormatFromFileName(fileName: string): BookFormat | null {
  const normalized = String(fileName || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.endsWith(".fb2.zip")) return "fb2_zip";
  if (normalized.endsWith(".fb2")) return "fb2";
  if (normalized.endsWith(".epub")) return "epub";
  if (normalized.endsWith(".pdf")) return "pdf";
  return null;
}

export function inferBookTitleFromFileName(fileName: string): string {
  const normalized = String(fileName || "").trim();
  if (!normalized) return "";

  const withoutDirs = normalized.replace(/\\/g, "/").split("/").pop() || normalized;
  const noExt = withoutDirs.replace(/\.(?:fb2(?:\.zip)?|epub|pdf)$/i, "");

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
