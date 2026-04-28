import test from "node:test";
import assert from "node:assert/strict";
import type { BookExpertCoreLiterarySection } from "@remarka/contracts";
import { normalizeLiterarySection } from "./bookExpertCoreLiteraryNormalization";

test("normalizeLiterarySection clamps long bullets and keeps schema-valid markdown", () => {
  const current: BookExpertCoreLiterarySection = {
    key: "conclusion",
    title: "Вывод",
    summary: "Короткий вывод.",
    bodyMarkdown: "Короткий вывод.",
    bullets: ["Первый пункт."],
    evidenceQuoteIds: ["q1"],
    confidence: 0.5,
  };

  const normalized = normalizeLiterarySection(current, {
    summary: `  ${"Очень длинное summary ".repeat(40)}  `,
    bodyMarkdown: `${"Строка body.\n".repeat(1200)}`,
    bullets: [
      `${"Очень длинный bullet ".repeat(30)}`,
      "Короткий bullet",
      "Короткий bullet",
    ],
    evidenceQuoteIds: ["q1", "q1", "q2"],
    confidence: 2,
  });

  assert.ok(normalized.summary.length <= 500);
  assert.ok(normalized.bodyMarkdown.length <= 6000);
  assert.equal(normalized.bullets.length, 2);
  assert.ok(normalized.bullets[0].length <= 240);
  assert.deepEqual(normalized.evidenceQuoteIds, ["q1", "q2"]);
  assert.equal(normalized.confidence, 1);
});
