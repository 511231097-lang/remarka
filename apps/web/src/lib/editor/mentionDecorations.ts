import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import type { DocumentPayload } from "@remarka/contracts";

type MentionItem = DocumentPayload["mentions"][number];

interface CharRecord {
  char: string;
  docPos: number | null;
}

function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char);
}

function separatorRecords(separator: string): CharRecord[] {
  return separator.split("").map((char) => ({
    char,
    docPos: null,
  }));
}

function trimRecordEdges(records: CharRecord[]): CharRecord[] {
  if (!records.length) return [];

  let start = 0;
  let end = records.length;

  while (start < end && isWhitespaceChar(records[start].char)) start += 1;
  while (end > start && isWhitespaceChar(records[end - 1].char)) end -= 1;

  return records.slice(start, end);
}

function joinRecordParts(parts: CharRecord[][], separator: string): CharRecord[] {
  const kept = parts.filter((part) => part.length > 0);
  if (!kept.length) return [];

  const joined: CharRecord[] = [];
  kept.forEach((part, index) => {
    if (index > 0 && separator) {
      joined.push(...separatorRecords(separator));
    }
    joined.push(...part);
  });

  return joined;
}

function extractNodeRecords(node: ProseMirrorNode, nodePos: number): CharRecord[] {
  if (node.type.name === "text") {
    const text = node.text || "";
    return text.split("").map((char, index) => ({
      char,
      docPos: nodePos + index,
    }));
  }

  if (node.type.name === "hardBreak") {
    return [{ char: "\n", docPos: nodePos }];
  }

  const childParts: CharRecord[][] = [];
  node.forEach((child, offset) => {
    const childPos = nodePos + offset + (child.isText || child.type.name === "hardBreak" ? 0 : 1);
    childParts.push(extractNodeRecords(child, childPos));
  });

  if (node.type.name === "bulletList" || node.type.name === "orderedList") {
    return joinRecordParts(
      childParts.map((part) => trimRecordEdges(part)),
      "\n\n"
    );
  }

  return childParts.flat();
}

function normalizeCanonicalRecords(records: CharRecord[]): CharRecord[] {
  if (!records.length) return [];

  // Equivalent to: split('\\n').map(line => line.replace(/[\\t ]+$/g, '')).join('\\n')
  const withoutLineTrailingSpaces: CharRecord[] = [];
  let lineStartIndex = 0;
  for (const record of records) {
    if (record.char === "\n") {
      while (withoutLineTrailingSpaces.length > lineStartIndex) {
        const tail = withoutLineTrailingSpaces[withoutLineTrailingSpaces.length - 1];
        if (tail.char !== " " && tail.char !== "\t") break;
        withoutLineTrailingSpaces.pop();
      }

      withoutLineTrailingSpaces.push(record);
      lineStartIndex = withoutLineTrailingSpaces.length;
      continue;
    }

    withoutLineTrailingSpaces.push(record);
  }

  while (withoutLineTrailingSpaces.length > lineStartIndex) {
    const tail = withoutLineTrailingSpaces[withoutLineTrailingSpaces.length - 1];
    if (tail.char !== " " && tail.char !== "\t") break;
    withoutLineTrailingSpaces.pop();
  }

  // Equivalent to String.trim()
  const trimmed = trimRecordEdges(withoutLineTrailingSpaces);
  if (!trimmed.length) return [];

  // Equivalent to replace(/\\n{3,}/g, '\\n\\n')
  const collapsed: CharRecord[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const current = trimmed[index];
    if (current.char !== "\n") {
      collapsed.push(current);
      continue;
    }

    let end = index;
    while (end < trimmed.length && trimmed[end].char === "\n") end += 1;
    const keep = Math.min(2, end - index);
    for (let i = 0; i < keep; i += 1) {
      collapsed.push(trimmed[index + i]);
    }
    index = end - 1;
  }

  return collapsed;
}

function buildCanonicalOffsetMap(doc: ProseMirrorNode): Array<number | null> {
  const blockParts: CharRecord[][] = [];
  doc.forEach((child, offset) => {
    const childPos = offset + (child.isText || child.type.name === "hardBreak" ? 0 : 1);
    blockParts.push(trimRecordEdges(extractNodeRecords(child, childPos)));
  });

  const joined = joinRecordParts(blockParts, "\n\n");
  const normalized = normalizeCanonicalRecords(joined);
  return normalized.map((entry) => entry.docPos);
}

function resolveBoundaryToDocPos(offset: number, offsetMap: Array<number | null>): number | null {
  if (!offsetMap.length) return null;

  const firstMapped = offsetMap.find((value): value is number => value !== null);
  const lastMapped = [...offsetMap].reverse().find((value): value is number => value !== null);

  if (firstMapped === undefined || lastMapped === undefined) {
    return null;
  }

  if (offset <= 0) {
    return firstMapped;
  }

  if (offset >= offsetMap.length) {
    return lastMapped + 1;
  }

  for (let index = offset; index < offsetMap.length; index += 1) {
    const mapped = offsetMap[index];
    if (mapped !== null) {
      return mapped;
    }
  }

  for (let index = Math.min(offset - 1, offsetMap.length - 1); index >= 0; index -= 1) {
    const mapped = offsetMap[index];
    if (mapped !== null) {
      return mapped + 1;
    }
  }

  return null;
}

export function buildMentionDecorations(
  doc: ProseMirrorNode,
  mentions: MentionItem[],
  activeEntityId: string | null,
  activeMentionId: string | null,
  makeDecoration: (from: number, to: number, attrs: Record<string, string>) => Decoration
): Decoration[] {
  const offsetMap = buildCanonicalOffsetMap(doc);
  if (!offsetMap.length || !mentions.length) return [];

  const sortedMentions = [...mentions].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  const decorations: Decoration[] = [];

  for (const mention of sortedMentions) {
    if (mention.endOffset <= mention.startOffset) continue;

    const from = resolveBoundaryToDocPos(mention.startOffset, offsetMap);
    const to = resolveBoundaryToDocPos(mention.endOffset, offsetMap);
    if (from === null || to === null || to <= from) continue;

    const classes = [
      "entity-highlight",
      `entity-${mention.entity.type}`,
      activeEntityId && mention.entityId === activeEntityId ? "entity-active" : "",
      activeMentionId && mention.id === activeMentionId ? "entity-mention-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    decorations.push(
      makeDecoration(from, to, {
        class: classes,
        "data-entity-id": mention.entityId,
        "data-mention-id": mention.id,
      })
    );
  }

  return decorations;
}
