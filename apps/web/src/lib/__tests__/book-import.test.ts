import JSZip from "jszip";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  BookImportError,
  buildPlainTextFromParsedChapter,
  buildRichContentFromParsedChapter,
  detectBookFormatFromFileName,
  extractSingleFb2FromZip,
  inferBookTitleFromFileName,
  parseBook,
  parseFb2BookFromXml,
} from "@remarka/contracts";

const SIMPLE_FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <book-title>Test Book</book-title>
      <author>
        <first-name>Иван</first-name>
        <last-name>Иванов</last-name>
      </author>
      <annotation>
        <p>Описание книги</p>
      </annotation>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>Глава первая</p></title>
      <p>Это <strong>важный</strong> текст.</p>
    </section>
    <section>
      <title><p>Глава вторая</p></title>
      <p>Продолжение.</p>
    </section>
  </body>
</FictionBook>`;

const NESTED_FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <body>
    <section>
      <title><p>Глава 1</p></title>
      <p>Начало.</p>
      <section>
        <title><p>Подглава</p></title>
        <p>Вложенный текст.</p>
      </section>
    </section>
  </body>
</FictionBook>`;

function bytesFromAscii(value: string): number[] {
  return Array.from(Buffer.from(value, "ascii"));
}

function cp1251BytesForWord(word: "Тест" | "Привет"): number[] {
  if (word === "Тест") return [0xd2, 0xe5, 0xf1, 0xf2];
  return [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];
}

function buildCp1251Fb2Bytes(): Uint8Array {
  return Uint8Array.from([
    ...bytesFromAscii('<?xml version="1.0" encoding="windows-1251"?>\n'),
    ...bytesFromAscii("<FictionBook>\n"),
    ...bytesFromAscii("  <description><title-info><book-title>"),
    ...cp1251BytesForWord("Тест"),
    ...bytesFromAscii("</book-title></title-info></description>\n"),
    ...bytesFromAscii("  <body><section><title><p>"),
    ...cp1251BytesForWord("Тест"),
    ...bytesFromAscii("</p></title><p>"),
    ...cp1251BytesForWord("Привет"),
    ...bytesFromAscii("</p></section></body>\n"),
    ...bytesFromAscii("</FictionBook>"),
  ]);
}

describe("book import parser", () => {
  it("detects supported formats from file names", () => {
    expect(detectBookFormatFromFileName("book.fb2")).toBe("fb2");
    expect(detectBookFormatFromFileName("book.fb2.zip")).toBe("fb2_zip");
    expect(detectBookFormatFromFileName("book.zip")).toBeNull();
  });

  it("infers title from filename", () => {
    expect(inferBookTitleFromFileName("The_Book.fb2.zip")).toBe("The Book");
  });

  it("parses simple fb2 into chapters and metadata", () => {
    const parsed = parseFb2BookFromXml(SIMPLE_FB2);
    expect(parsed.metadata.title).toBe("Test Book");
    expect(parsed.metadata.author).toBe("Иван Иванов");
    expect(parsed.metadata.annotation).toBe("Описание книги");
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0]?.title).toBe("Глава первая");
  });

  it("keeps nested section as heading inside the same chapter", () => {
    const parsed = parseFb2BookFromXml(NESTED_FB2);
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.title).toBe("Глава 1");
    expect(parsed.chapters[0]?.blocks.some((item) => item.type === "heading")).toBe(true);
  });

  it("throws on invalid xml", () => {
    expect(() => parseFb2BookFromXml("<broken")).toThrowError(BookImportError);
  });

  it("respects windows-1251 encoding declaration", async () => {
    const parsed = await parseBook({
      format: "fb2",
      fileName: "book.fb2",
      bytes: buildCp1251Fb2Bytes(),
    });

    expect(parsed.metadata.title).toBe("Тест");
    expect(parsed.chapters[0]?.title).toBe("Тест");
    expect(buildPlainTextFromParsedChapter(parsed.chapters[0]!)).toContain("Привет");
  });
});

describe("fb2 zip extraction", () => {
  it("extracts a single fb2 from zip", async () => {
    const zip = new JSZip();
    zip.file("book.fb2", SIMPLE_FB2);
    const archive = await zip.generateAsync({ type: "uint8array" });

    const extracted = await extractSingleFb2FromZip(archive);
    expect(extracted.fileName).toBe("book.fb2");
    expect(extracted.xml).toContain("<FictionBook");
  });

  it("throws when zip contains no fb2", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "hello");
    const archive = await zip.generateAsync({ type: "uint8array" });

    await expect(extractSingleFb2FromZip(archive)).rejects.toMatchObject({
      code: "FB2_ZIP_NO_FB2",
    });
  });

  it("throws when zip contains multiple fb2 files", async () => {
    const zip = new JSZip();
    zip.file("a.fb2", SIMPLE_FB2);
    zip.file("b.fb2", SIMPLE_FB2);
    const archive = await zip.generateAsync({ type: "uint8array" });

    await expect(extractSingleFb2FromZip(archive)).rejects.toMatchObject({
      code: "FB2_ZIP_MULTIPLE_FB2",
    });
  });

  it("throws when extracted file exceeds max size", async () => {
    const zip = new JSZip();
    zip.file("book.fb2", `${SIMPLE_FB2}\n${"a".repeat(4096)}`);
    const archive = await zip.generateAsync({ type: "uint8array" });

    await expect(
      extractSingleFb2FromZip(archive, {
        maxUncompressedBytes: 512,
      })
    ).rejects.toMatchObject({
      code: "FB2_ZIP_TOO_LARGE",
    });
  });
});

describe("parsed chapter mapping", () => {
  it("maps parsed chapter to rich document and plain text", () => {
    const chapter = {
      title: "Глава",
      blocks: [
        {
          type: "heading" as const,
          level: 2,
          inlines: [{ text: "Заголовок", marks: [] }],
        },
        {
          type: "paragraph" as const,
          inlines: [{ text: "Простой текст", marks: ["italic" as const] }],
        },
      ],
    };

    const rich = buildRichContentFromParsedChapter(chapter);
    const plain = buildPlainTextFromParsedChapter(chapter);

    expect(rich).toMatchObject({
      type: "doc",
      content: [{ type: "heading" }, { type: "paragraph" }],
    });
    expect(plain).toBe("Заголовок\n\nПростой текст");
  });
});
