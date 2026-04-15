# Book Pipeline Runbook

## Purpose
Manual benchmark and incident runbook for the stabilized large-book pipeline. The goal is not perfect literary output on every step; the goal is a stable, observable pipeline that finishes, requeues safely, and degrades without losing the whole book.

## Benchmark Set
1. `Война и мир`
   Baseline for size and multi-part structure.
2. `Властелин колец`
   Stresses entity disambiguation, titles, aliases, and long-running arcs.
3. `Сильмариллион`
   Worst-case model pressure: dense names, high ambiguity, low redundancy.
4. `Преступление и наказание`
   Real UX case for report, chat, and markdown rendering.

## Before You Start
1. Apply DB migrations and regenerate Prisma client.
2. Start `web`, `worker`, `migrate`, `db`, and `minio` with Docker.
3. Confirm `http://127.0.0.1:3000` returns `200 OK`.
4. Clear any obviously stale `running` analyzer tasks or let the watchdog requeue them.

## Useful Commands
```bash
npm run db:generate
npm --prefix apps/worker run test
npm --prefix apps/worker run typecheck
npm --prefix apps/worker run requeue:book-analyzer -- <bookId> all
docker compose up --build -d web worker migrate
docker compose ps
```

## Expected Pipeline Behavior
- Deferred stages stay in `queued` and get re-run automatically through `Outbox.availableAt`.
- Lock contention does not lose work.
- Retryable failures back off and retry instead of silently disappearing.
- `core_literary` may end as `completed + degraded`, but should not fail the whole book because of long bullets, empty model output, or malformed JSON.
- `Book Report` should show attempts, models, degradation, fallback kind, and any saved token usage for stages that recorded metadata.

## Verification Checklist By Book
### Война и мир
- `event_relation_graph`, `evidence_store`, and `core_literary` all reach terminal states.
- No analyzer task remains stuck in `queued` after dependencies complete.
- `core_literary` is allowed to be `degraded`, but `book.analysisState` must not remain `failed` because of literary section validation.

### Властелин колец
- Key characters and locations remain separate in graph/chat retrieval.
- No obvious collapse from titles or partial alias overlap.
- If canonicalization skips ambiguous merges, that is acceptable and preferred over destructive merging.

### Сильмариллион
- Pipeline terminates without infinite retry/defer loops.
- Report surfaces degraded stages when model output is weak.
- Book still reaches a usable completed state with core graph, summary artifacts, quotes, and literary sections.

### Преступление и наказание
- Chat works after full analysis.
- `Отчет` shows chat token usage and saved model names.
- Existing chat markdown remains readable and list formatting does not collapse into a single paragraph.

## Spot Checks
1. Open the book overview and confirm prior chats are visible.
2. Open a chat by URL with `sessionId` and confirm the composer is pinned to the bottom.
3. Open `Отчет` and inspect:
   - failed vs running vs completed step counts
   - degraded badges
   - fallback kind
   - attempts
   - saved model / token data where available
4. If a stage is stale, use `requeue:book-analyzer` and verify the report updates after retry.

## Incident Triage
### Stage stuck in `queued`
- Check the report for `deferredReason`.
- Check `Outbox` for a pending `book.analyzer.requested` entry with `availableAt <= now()`.
- Requeue with `npm --prefix apps/worker run requeue:book-analyzer -- <bookId> <stage>`.

### Stage stuck in `running`
- Wait for the stale-task watchdog window.
- If it does not recover, requeue manually and inspect worker logs for lock contention or repeated retries.

### `core_literary` degraded
- Verify the book still reached `completed`.
- Inspect `fallbackKind` and `lastReason` in `Отчете`.
- This is acceptable unless the sections are empty or the book remains in failed state.

### Suspicious entity merge
- Inspect character mentions and aliases in the project graph.
- Prefer keeping separate entities over manual forced merge unless there is direct alias evidence or repeated cross-scene evidence.
