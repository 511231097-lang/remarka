# Remarka — Notes for Claude Code sessions

AI-эксперт по книгам в формате чата. Точность ответов критична для продукта.

## Stack
- **Web**: Next.js 15 + NextAuth (Google OAuth) — `apps/web`
- **Worker**: Node + pg-boss — `apps/worker`
- **DB**: PostgreSQL + pgvector через Prisma — `packages/db`
- **Shared**: `packages/contracts`, `packages/ai`
- **Storage**: MinIO (S3-compatible) для artifacts и books, Timeweb S3 на проде
- **LLM**: Vertex AI (Gemini 3.x) — единственный провайдер. Альтернативы (Timeweb / KIA) были удалены в PR #13 как мёртвые эксперименты.

## Environment

The repo lives in **WSL2 Ubuntu** at `/home/west/Documents/myb/remarka`. Claude Code is running on the Windows side and reaches the project via the `\\wsl$\Ubuntu\...` UNC share.

**Always run `node`, `npm`, `npx`, `tsx`, `docker compose`, `prisma`, `git` (when it touches submodules / hooks) through WSL.** Do not invoke them through the Windows-side `node`/`npm` — `npm` chokes on UNC paths with "Maximum call stack size exceeded", and `node_modules/.bin/*` are installed inside WSL only.

### Command pattern

```bash
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && <your command>"
```

Examples:

```bash
# typecheck
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && npx tsc --noEmit -p apps/web/tsconfig.json"

# unit tests
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && npm run test:unit"

# golden eval (single run, cheap)
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && npm run eval:chat-regression -- --golden"

# golden eval (stable measurement, recommended для cost/quality сравнений между итерациями)
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && npm run eval:chat-regression -- --golden --runs 3 --warmup"

# bring up infra (db + minio) only — eval and dev run on host node
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && docker compose up -d db minio"

# full prod-like compose
wsl.exe -d Ubuntu -e bash -lc "cd /home/west/Documents/myb/remarka && npm run docker:up"
```

Read/Glob/Grep tools are fine to use directly with relative paths — file IO over UNC works. Only process spawning needs the WSL wrapper.

## RAG / Chat — domain context

This is the highest-value surface of the product. The flow is documented in detail in conversation history; key files:

- **Frontend chat UI**: `apps/web/src/components/BookChat.tsx`
- **Stream API route**: `apps/web/src/app/api/books/[bookId]/chat/sessions/[sessionId]/stream/route.ts`
- **Service brain**: `apps/web/src/lib/bookChatService.ts` (~8k lines после чистки PR #5)
- **Tools**: `apps/web/src/lib/bookChatTools.ts`
- **Analysis pipeline (data prep)**: `apps/worker/src/analysisPipeline.npz.ts`

The chat uses a hybrid retriever (pgvector semantic + lexical RRF fusion + Vertex Ranking rerank), a small planner LLM that decides `toolPolicy` and search queries, then a main Gemini call with tool-use over the planned queries.

### RAG audit & план

Полный аудит — `docs/research/rag-audit-2026-04-30.md`. Что закрыто и что в backlog'е:

**Уже сделано:**
- Markdown-formatted evidence (был raw JSON в LLM)
- History compaction with hysteresis (`BookChatThread.compactedHistory*`)
- Anti-jailbreak hardening через `<thread-summary>` XML wrapper
- `compileEvidencePack` subtree удалён целиком (~3,977 строк) в PR #5
- Per-step LLM metrics с `cachedInputTokens` + `thoughtsTokens`
- Paragraph-hits dedupe (drop хитов уже покрытых evidence-группами) + slice budget 18k → 8k
- `selectedTools` user-control убран (закрывает QUALITY #1 другим путём)
- Vertex 2.5-flash тестировали → откатили (галлюцинации на сложных цепочках)

**Backlog (приоритет ROI):**
- **TOP — Tighten Pro-tier router в planner prompt** (`bookChatService.ts:3398-3401`). Сейчас слишком часто рутит на Pro; ужесточить до `complexity=hard AND multi-group`. **Главная экономическая ручка: −30 до −47% LLM-стоимости.**
- **Gate `search_scenes`** когда `complexity=simple` — закрывает T3 over-search.
- **Alias expansion** — модель `BookEntityAlias` была удалена в PR #15 (никогда не наполнялась). Если возьмёмся — нужно сначала восстановить таблицу или взять alias-источник из `BookEntity` показывающего characters/aliases в анализе.
- **Scene `contextSummary`** (Anthropic-style contextual retrieval) — большой трек, требует доработки analysis pipeline.
- **Paragraph hierarchical context injection** — большой трек, требует переэмбеддинга всех книг.

## Eval / Golden Set

Located in `evals/golden-set/`. Three books, 45 questions across 5 categories (factual, chain, comparison, character, theme).

- Single run baseline: ~$0.13 (HP only) / ~$0.67 (with Капитанская дочка). The Pushkin book degrades retrieval ~30%, which is exactly why it's in the set.
- Stable measurement: `--runs 3 --warmup`. Saves per-run reports plus an averaged summary with `stability` block (mean / min / max / spread / std) per metric.
- Determinism: `--golden` implies `BOOK_CHAT_EVAL_DETERMINISTIC=1` which forces main-chat `temperature: 0` for the run. Production behaviour unchanged. Override with `--no-deterministic`.
- Baseline file lives at `evals/results/baseline-*.json` — picked up automatically (latest mtime). To refresh, archive the old baseline and rerun.

See `evals/golden-set/README.md` for the full reference.

## Docker

- `docker-compose.yml` — full prod-like (web + worker + db + minio)
- `docker-compose.dev.yml` — overrides for hot-reload dev
- `.env.docker` is required (template in `.env.docker.example`)

For golden eval, you usually only need `db` + `minio` containers. Web and worker can run on host node, which is faster to iterate.

## Git / Branching

- Branch naming свободное (`feat/...`, `fix/...`, `chore/...`, `improve/rag-...`)
- One Edit task = one branch = one PR
- Do not commit `tmp-*` scripts at repo root or `.next/`, `.pgdata-local/`, `node_modules/`
- Default `main` is the merge target

## CI / Deploy

Pipeline collapsed into `pipeline.yml` после PR #11 (см. `docs/deployment.md`):

```
push → build (auto) → migrate (manual) ──┬─→ deploy-web    (manual)
                                         └─→ deploy-worker (manual)
```

`migrate` / `deploy-*` — manual gates через GitHub Environments (`prod-db` / `prod-web` / `prod-worker`) с required reviewers. На push сборка идёт сама, но прод не трогается до approve. Аварийный re-deploy без rebuild — `redeploy.yml`.

## Что НЕ делать

- Не использовать regex/keyword-эвристики для **смысловых** решений (тип вопроса, нужен ли поиск, какая тема). Семантические решения переносим в существующие LLM-вызовы (planner / main). Regex остаётся для парсинга output, валидации UUID/email, безопасности.
- Не запускать `tsc`/`npm` напрямую с Windows-стороны — будет "Maximum call stack size exceeded" из-за UNC.
- Не делать checkpoint-resume / hierarchical chunking / replace-embedding-model в текущей итерации — это backlog, не quick wins.
- Не добавлять HyDE — для precision-first продукта риск галлюцинаций > выигрыш recall.
