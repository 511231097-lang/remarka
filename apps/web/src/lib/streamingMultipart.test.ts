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
