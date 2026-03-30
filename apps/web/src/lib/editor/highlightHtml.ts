import type { DocumentPayload } from "@remarka/contracts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToEditorHtml(
  content: string,
  mentions: DocumentPayload["mentions"],
  activeEntityId: string | null
): string {
  const sorted = [...mentions].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

  let cursor = 0;
  let composed = "";

  for (const mention of sorted) {
    const start = mention.startOffset;
    const end = mention.endOffset;

    if (start < cursor || end <= start || end > content.length) {
      continue;
    }

    composed += escapeHtml(content.slice(cursor, start));

    const rawMentionText = content.slice(start, end);
    const mentionText = escapeHtml(rawMentionText);
    const classes = [
      "entity",
      mention.entity.type,
      activeEntityId && mention.entityId === activeEntityId ? "active" : "",
    ]
      .filter(Boolean)
      .join(" ");

    composed += `<mark class="${classes}" data-entity-id="${mention.entityId}">${mentionText}</mark>`;
    cursor = end;
  }

  composed += escapeHtml(content.slice(cursor));

  const normalized = composed.length ? composed : "";
  const paragraphs = normalized.split(/\n\n/);

  return paragraphs
    .map((paragraph) => {
      const withBreaks = paragraph.replace(/\n/g, "<br />");
      return `<p>${withBreaks || "<br />"}</p>`;
    })
    .join("");
}

export function extractEditorText(raw: string): string {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}
