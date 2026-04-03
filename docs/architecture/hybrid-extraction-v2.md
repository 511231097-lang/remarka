# Hybrid Extraction v2 (No Backward Compatibility)

## 1) Scope

This document fixes the target architecture for the v2 extraction cutover.

- Backward compatibility is intentionally removed.
- Legacy extraction models and `analysisStatus` document flow are deprecated.
- v1 incremental paragraph-diff mode is removed.
- v2 run model is authoritative: every save creates a new `AnalysisRun`.

## 2) End-to-End Pipeline

```text
Python preprocessor -> LLM entity-pass (strict schema)
-> deterministic alias sweep -> LLM patch windows
-> atomic apply per window -> finalize snapshot/quality flags
```

### Phase A: `prepass`

Input:
- `content`
- `contentVersion`

Executor:
- Python sidecar (`apps/preprocessor`, FastAPI)

Output (`POST /prepass`):
- `paragraphs[]` (index/text/startOffset)
- `candidates[]` (name-like candidates, normalized forms)
- `snippets[]` (context packages for entity-pass)

Failure policy:
- Sidecar failure fails the run (`state=failed`, `phase=failed`).
- No silent fallback to legacy logic.

### Phase B: `entity_pass`

Input:
- prepass payload
- known project entities and aliases
- `contentVersion`

Executor:
- LLM with strict JSON schema (`EntityPassResultSchema`)

Output:
- candidate entities with `link_existing` or `create_new`
- observed aliases and evidence

Constraints:
- strict schema parse is required
- `event` entities are feature-gated (`ENABLE_EVENT_EXTRACTION=false` by default)

### Phase C: `sweep`

Executor:
- deterministic backend pass over full document

Operation:
- build alias registry (canonical + aliases)
- whole-word match sweep over full content
- create `MentionCandidate`
- accept deterministic single-owner spans directly to `Mention`
- route ambiguous spans to patch windows (`routing=patch`)

### Phase D: `mention_completion`

Executor:
- LLM patching by windows

Rules:
- LLM can operate only on provided `candidateId`
- no offsets/spans in model output
- operations limited to:
  - `accept_candidate`
  - `reject_candidate`
  - `link_candidate`
  - `create_entity_and_link`
  - `set_location_parent`

### Phase E: `apply`

Executor:
- transactional apply per patch window

Rules:
- each window applies in an independent DB transaction
- one invalid op => entire window rollback
- window decision is still persisted in `PatchDecision` (`applied=false`, `validationError`)

## 3) Run State Machine

```text
queued
  -> prepass
  -> entity_pass
  -> sweep
  -> mention_completion
  -> apply
  -> completed

Any phase -> failed
Any phase -> superseded
```

Terminal states:
- `completed`
- `failed`
- `superseded`

## 4) Strict Version Gate

Apply is allowed only if both match:
- `Document.currentRunId == runId`
- `Document.contentVersion == run.contentVersion`

If gate fails:
- run is treated as stale and transitions to `superseded`
- stale run results are not treated as current snapshot

## 5) Persistence Model (v2)

Core tables:
- `Project`
- `Chapter`
- `Document`
- `LocationContainment`
- `AnalysisRun`
- `Entity`
- `EntityAlias`
- `MentionCandidate`
- `Mention`
- `PatchDecision`
- `Outbox`

DB notes:
- destructive migration removes legacy extraction tables
- `pg_trgm` enabled
- trigram index on `EntityAlias.normalizedAlias`

## 6) Save/Queue Orchestration

On `PUT document`:
- save document content and increment `contentVersion`
- create `AnalysisRun`
- supersede older queued/running runs for same document
- write `Outbox` event (`analysis.run.requested`) in same transaction

Web layer does not enqueue jobs directly.
Worker consumes only outbox events.

## 7) Public API Contracts

### `PUT /api/projects/:projectId/document?chapter=:chapterId`

Input:
- body: `{ richContent }`
- header: `If-Match` (required by client-side optimistic save flow)
- header: optional `Idempotency-Key`

Output:
- `{ runId, contentVersion, runState, snapshotAvailable, snapshot?, qualityFlags? }`

### `GET /api/projects/:projectId/document?chapter=:chapterId`

Output:
- `{ run, snapshot, qualityFlags }`

### `GET /api/projects/:projectId/stream?chapter=:chapterId`

SSE events:
- `run_started`
- `phase_changed`
- `snapshot_updated`
- `completed`
- `failed`
- `superseded`

## 8) Operational Defaults

- `ENABLE_EVENT_EXTRACTION=false`
- full-document processing on every run
- no incremental paragraph-diff mode

## 9) Cutover Notes

- migration is destructive for derived extraction data
- historical extraction artifacts are intentionally dropped
- outbox reindex events are created for existing non-empty documents
