import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { MultipartUploadError, parseStreamingMultipart } from "./streamingMultipart";

test("parseStreamingMultipart writes uploaded files to temp files", async () => {
  const formData = new FormData();
  formData.set("title", " Test book ");
  formData.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");

  const request = new Request("http://local.test/upload", {
    method: "POST",
    body: formData,
  });

  const upload = await parseStreamingMultipart(request, {
    fileFieldNames: ["file"],
    maxFiles: 1,
    maxFileSizeBytes: 1024,
    tempPrefix: "remarka-streaming-multipart-test",
  });

  const tempPath = upload.files[0]?.tempPath;
  try {
    assert.ok(tempPath);
    assert.equal(upload.fields.get("title")?.[0], " Test book ");
    assert.equal(upload.files.length, 1);
    assert.equal(upload.files[0].fieldName, "file");
    assert.equal(upload.files[0].fileName, "hello.txt");
    assert.equal(upload.files[0].mimeType, "text/plain");
    assert.equal(upload.files[0].sizeBytes, 5);
    assert.equal(await fs.readFile(tempPath, "utf8"), "hello");
  } finally {
    await upload.cleanup();
  }

  await assert.rejects(() => fs.stat(tempPath), { code: "ENOENT" });
});

test("parseStreamingMultipart rejects files above the configured limit", async () => {
  const formData = new FormData();
  formData.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");

  const request = new Request("http://local.test/upload", {
    method: "POST",
    body: formData,
  });

  await assert.rejects(
    () =>
      parseStreamingMultipart(request, {
        fileFieldNames: ["file"],
        maxFiles: 1,
        maxFileSizeBytes: 3,
        tempPrefix: "remarka-streaming-multipart-test",
      }),
    (error) => error instanceof MultipartUploadError && error.status === 413,
  );
});

test("parseStreamingMultipart preserves the extension on Cyrillic filenames", async () => {
  // Regression: the previous ASCII-only sanitizer collapsed the whole
  // Cyrillic prefix into a single "-", which the leading-[-.] strip then
  // removed together with the dot, leaving e.g. "fb2" without extension.
  // detectBookFormatFromFileName() then returned null and uploads of any
  // Russian-named book were rejected with HTTP 415 "Unsupported format".
  const formData = new FormData();
  formData.append(
    "file",
    new Blob(["x"], { type: "application/octet-stream" }),
    "Гарри Поттер и Узник Азкабана.fb2"
  );

  const request = new Request("http://local.test/upload", {
    method: "POST",
    body: formData,
  });

  const upload = await parseStreamingMultipart(request, {
    fileFieldNames: ["file"],
    maxFiles: 1,
    maxFileSizeBytes: 1024,
    tempPrefix: "remarka-streaming-multipart-test",
  });

  try {
    const sanitized = upload.files[0]?.fileName ?? "";
    assert.ok(sanitized.endsWith(".fb2"), `expected sanitized name to end with .fb2, got ${sanitized}`);
    assert.match(sanitized, /[\p{L}]/u, "expected sanitized name to retain at least some letters");
  } finally {
    await upload.cleanup();
  }
});
