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

## Running the Eval

### Single run (cheap, exploratory)

```bash
npm run eval:chat-regression -- --golden
```

Writes `evals/results/golden-{ISO_DATE}.json`. If no previous golden/baseline result exists, it also creates `evals/results/baseline-{ISO_DATE}.json`.

### Stable measurements (recommended for comparing T-tasks)

```bash
npm run eval:chat-regression -- --golden --runs 3 --warmup
```

- `--runs N` — repeats the full pass `N` times. Per-run reports are saved as `golden-{ISO}-run-1.json`, `golden-{ISO}-run-2.json`, … An averaged summary `golden-{ISO}-averaged.json` includes mean / min / max / spread / std for each key metric, plus the list of per-run report paths under `runReports`.
- `--warmup` — runs an extra pass first whose results are discarded. Use this to prime in-memory caches (corpus / search results) before measurement.
- The averaged report is what gets compared against the baseline and used for regression checks. Per-run files are kept for diffing variance.

### Determinism

Whenever `--golden` is set, the eval forces `BOOK_CHAT_EVAL_DETERMINISTIC=1`, which lowers the main-chat `temperature` to `0` for the duration of the run. The production temperature is unchanged. To opt out (e.g. to reproduce production-like noise), pass `--no-deterministic`. Note: planner and rerank already run at `temperature=0` in production, so this flag only affects the main answer generation.

### Refreshing the Baseline

To intentionally refresh the baseline:
1. Archive or remove the existing `evals/results/baseline-*.json` and any `evals/results/golden-*.json` files you don't want considered.
2. Rerun the command (preferably with `--runs 3 --warmup` so the new baseline is averaged).
3. The freshest `baseline-*.json` will be picked up on the next run.

### Output Reference

| File | When written | Contents |
| --- | --- | --- |
| `golden-{ISO}.json` | every run when `--runs 1` | full `EvalReport` (single pass) |
| `golden-{ISO}-run-N.json` | every run when `--runs > 1` | `EvalReport` for that pass |
| `golden-{ISO}-averaged.json` | when `--runs > 1` | `EvalReport` with averaged `overall` + `stability` block (mean/min/max/spread/std per metric) + `runReports` paths |
| `baseline-{ISO}.json` | only if no baseline existed when the eval started | copy of the averaged report (or single-run report if `--runs 1`) |
