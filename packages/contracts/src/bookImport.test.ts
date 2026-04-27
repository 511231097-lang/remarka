import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  BookImportError,
  detectBookFormatFromFileName,
  inferBookTitleFromFileName,
  parseBook,
} from "./bookImport";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function buildEpubFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>EPUB Fixture</dc:title>
        <dc:creator>Fixture Author</dc:creator>
        <dc:description>Fixture annotation</dc:description>
      </metadata>
      <manifest>
        <item id="chapter-1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="chapter-2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="chapter-1"/>
        <itemref idref="chapter-2"/>
      </spine>
    </package>`
  );
  zip.file(
    "OEBPS/chapter1.xhtml",
    `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <body>
        <h1>Chapter One</h1>
        <p>First paragraph with <em>italic</em> text.</p>
      </body>
    </html>`
  );
  zip.file(
    "OEBPS/chapter2.xhtml",
    `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
      <body>
        <h2>Chapter Two</h2>
        <p>Second paragraph.</p>
        <blockquote>Quoted line.</blockquote>
      </body>
    </html>`
  );
  return zip.generateAsync({ type: "uint8array" });
}

function pdfString(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdfFixture(params: { text?: string; title?: string; author?: string }): Uint8Array {
  const pageText = String(params.text || "");
  const stream = pageText
    ? `BT
/F1 18 Tf
72 720 Td
(${pdfString(pageText)}) Tj
ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>
stream
${stream}
endstream`,
    `<< /Title (${pdfString(params.title || "")}) /Author (${pdfString(params.author || "")}) >>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n 
`;
  }
  pdf += `trailer
<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>
startxref
${xrefOffset}
%%EOF`;
  return bytes(pdf);
}

test("detectBookFormatFromFileName supports FB2, FB2 ZIP, EPUB and PDF", () => {
  assert.equal(detectBookFormatFromFileName("book.fb2"), "fb2");
  assert.equal(detectBookFormatFromFileName("book.fb2.zip"), "fb2_zip");
  assert.equal(detectBookFormatFromFileName("book.epub"), "epub");
  assert.equal(detectBookFormatFromFileName("book.pdf"), "pdf");
  assert.equal(detectBookFormatFromFileName("book.txt"), null);
  assert.equal(inferBookTitleFromFileName("folder/my-book.epub"), "my book");
  assert.equal(inferBookTitleFromFileName("folder/my-book.pdf"), "my book");
});

test("parseBook reads EPUB metadata and spine chapters", async () => {
  const parsed = await parseBook({
    format: "epub",
    fileName: "fixture.epub",
    bytes: await buildEpubFixture(),
  });

  assert.equal(parsed.format, "epub");
  assert.equal(parsed.metadata.title, "EPUB Fixture");
  assert.equal(parsed.metadata.author, "Fixture Author");
  assert.equal(parsed.metadata.annotation, "Fixture annotation");
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.chapters[0].title, "Chapter One");
  assert.equal(parsed.chapters[1].blocks.some((block) => block.type === "quote"), true);
});

test("parseBook reads PDF text layer and metadata", async () => {
  const parsed = await parseBook({
    format: "pdf",
    fileName: "fallback-title.pdf",
    bytes: buildPdfFixture({
      title: "PDF Fixture",
      author: "PDF Author",
      text: "Hello PDF text",
    }),
  });

  assert.equal(parsed.format, "pdf");
  assert.equal(parsed.metadata.title, "PDF Fixture");
  assert.equal(parsed.metadata.author, "PDF Author");
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].title, "Страница 1");
  assert.match(parsed.chapters[0].blocks[0].inlines[0].text, /Hello PDF text/);
});

test("parseBook rejects PDF without extractable text", async () => {
  await assert.rejects(
    () =>
      parseBook({
        format: "pdf",
        fileName: "scan.pdf",
        bytes: buildPdfFixture({ title: "Scan" }),
      }),
    (error) => error instanceof BookImportError && error.code === "PDF_TEXT_EMPTY"
  );
});

test("parseBook rejects invalid PDF bytes with a PDF_INVALID code", async () => {
  await assert.rejects(
    () =>
      parseBook({
        format: "pdf",
        fileName: "broken.pdf",
        bytes: new TextEncoder().encode("not a pdf"),
      }),
    (error) => error instanceof BookImportError && error.code === "PDF_INVALID"
  );
});
