import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";

test("ChatMessageMarkdown renders cite links as inline triggers", () => {
  const html = renderToStaticMarkup(
    <ChatMessageMarkdown
      content="[Внутренний перелом](cite:a1) меняет траекторию героя."
      inlineCitations={[
        {
          anchorId: "a1",
          quotes: [
            {
              id: "quote-1",
              chapterOrderIndex: 4,
              startChar: 0,
              endChar: 42,
              text: "Он уже не мог думать, как прежде.",
              type: "reflection",
              tags: ["identity"],
              confidence: 0.9,
              commentary: null,
              mentions: [],
            },
          ],
        },
      ]}
    />
  );

  assert.match(html, /<button[^>]*>Внутренний перелом<\/button>/);
  assert.doesNotMatch(html, /href="cite:a1"/);
});

test("ChatMessageMarkdown leaves cite text plain when inline citations are missing", () => {
  const html = renderToStaticMarkup(
    <ChatMessageMarkdown content="[Внутренний перелом](cite:a1) меняет траекторию героя." inlineCitations={[]} />
  );

  assert.match(html, /Внутренний перелом/);
  assert.doesNotMatch(html, /<button/);
});
