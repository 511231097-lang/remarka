import { splitParagraphs, type ExtractionMention } from "@remarka/contracts";

function countOccurrencesCaseInsensitive(haystack: string, needle: string): number {
  if (!needle) return 0;

  const source = haystack.toLowerCase();
  const target = needle.toLowerCase();

  let cursor = 0;
  let count = 0;

  while (cursor <= source.length - target.length) {
    const index = source.indexOf(target, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + target.length;
  }

  return count;
}

export function expandUnambiguousCharacterMentions(
  content: string,
  mentions: ExtractionMention[]
): ExtractionMention[] {
  if (!mentions.length) return mentions;

  const paragraphs = splitParagraphs(content);
  if (!paragraphs.length) return mentions;

  const mentionsByText = new Map<
    string,
    {
      entityKeys: Set<string>;
      sample: ExtractionMention;
    }
  >();

  for (const mention of mentions) {
    if (mention.type !== "character") continue;

    const textKey = mention.mentionText.trim().toLowerCase();
    if (!textKey || textKey.length < 3) continue;
    if (!textKey.includes(" ")) continue;

    const entityKey = mention.entityRef;
    const existing = mentionsByText.get(textKey);

    if (!existing) {
      mentionsByText.set(textKey, {
        entityKeys: new Set([entityKey]),
        sample: mention,
      });
      continue;
    }

    existing.entityKeys.add(entityKey);
  }

  const existingCount = new Map<string, number>();
  for (const mention of mentions) {
    const textKey = mention.mentionText.trim().toLowerCase();
    if (!textKey) continue;
    const entityKey = mention.entityRef;
    const key = `${mention.paragraphIndex}::${textKey}::${entityKey}`;
    existingCount.set(key, (existingCount.get(key) ?? 0) + 1);
  }

  const expanded = [...mentions];

  for (const [textKey, aggregate] of mentionsByText) {
    if (aggregate.entityKeys.size !== 1) continue;

    const entityKey = Array.from(aggregate.entityKeys)[0];
    const sample = aggregate.sample;

    for (const paragraph of paragraphs) {
      const occurrenceCount = countOccurrencesCaseInsensitive(paragraph.text, textKey);
      if (!occurrenceCount) continue;

      const existingKey = `${paragraph.index}::${textKey}::${entityKey}`;
      const current = existingCount.get(existingKey) ?? 0;
      const missing = occurrenceCount - current;
      if (missing <= 0) continue;

      for (let i = 0; i < missing; i += 1) {
        expanded.push({
          entityRef: sample.entityRef,
          type: sample.type,
          name: sample.name,
          paragraphIndex: paragraph.index,
          mentionText: sample.mentionText,
        });
      }

      existingCount.set(existingKey, current + missing);
    }
  }

  return expanded;
}
