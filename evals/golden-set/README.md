# Golden Chat Evaluation Set

This directory contains manually curated book-chat questions for `npm run eval:chat-regression -- --golden`.

## Structure

- `books/{bookId}.meta.json` stores the DB snapshot used for the golden set.
- `questions/{bookId}.jsonl` stores one JSON question record per line.

Question records use this shape:

```json
{"id":"q-001","bookId":"...","question":"...","category":"factual","expectedParagraphIds":["..."],"expectedKeywords":["..."],"minRecallK":5,"expectedFirstTool":"search_paragraphs"}
```

`expectedParagraphIds` must be `BookParagraph.id` values from the same DB snapshot. The eval maps those IDs to stable `chapterId:paragraphIndex` refs before scoring retrieval.

## Adding Questions

1. Pick a completed analysis run for the target book.
2. Ask the current chat the candidate question.
3. If the answer is correct, record the supporting paragraph IDs from the cited evidence. If it is not correct, inspect the book text/search results manually and record the correct paragraph IDs.
4. Add concise `expectedKeywords` that should appear in a correct final answer.
5. Set `expectedFirstTool` only when the first tool is part of the manual expectation. For the current Harry Potter golden set this is `search_paragraphs`.

Do not use automatic LLM labeling for this set.

## Updating Baseline

Run:

```bash
npm run eval:chat-regression -- --golden
```

The command writes `evals/results/golden-{ISO_DATE}.json`. If no previous golden/baseline result exists, it also creates `evals/results/baseline-{ISO_DATE}.json`. To intentionally refresh the baseline, remove or archive the old baseline/result files, then rerun the command and keep the new `baseline-*` file.
