# Remarka — Notes for Claude Code sessions

AI-эксперт по книгам в формате чата. Точность ответов критична для продукта.

## Stack
- **Web**: Next.js 15 + NextAuth (Google OAuth) — `apps/web`
- **Worker**: Node + pg-boss — `apps/worker`
- **DB**: PostgreSQL + pgvector через Prisma — `packages/db`
- **Shared**: `packages/contracts`, `packages/ai`
- **Storage**: MinIO (S3-compatible) для artifacts и books
- **LLM**: Vertex AI (Gemini) по умолчанию; Timeweb / KIA как альтернативы

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

# golden eval (stable measurement, recommended for T1..T7 comparisons)
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
- **Service brain**: `apps/web/src/lib/bookChatService.ts` (~11k lines)
- **Tools**: `apps/web/src/lib/bookChatTools.ts`
- **Analysis pipeline (data prep)**: `apps/worker/src/analysisPipeline.npz.ts`

The chat uses a hybrid retriever (pgvector semantic + lexical RRF fusion + Vertex Ranking rerank), a small planner LLM that decides `toolPolicy` and search queries, then a main Gemini call with tool-use over the planned queries.

Known weaknesses being worked on (T1..T7 plan):
- Tool descriptions overlap → planner picks wrong tool ~43% of the time
- `toolPolicy="required"` forced on every "book question" → over-search
- Evidence formatted as raw JSON for the LLM (not markdown)
- No alias-expansion using `BookEntityAlias` (already populated by analysis)
- Scenes lack `contextSummary` — Anthropic-style contextual retrieval missing
- Paragraph embeddings have no hierarchical context injection

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

- Active branch lives in `improve/rag-T<N>-<slug>` per the T1..T7 plan
- One Edit task = one branch = one PR
- Do not commit `tmp-*` scripts at repo root or `.next/`, `.pgdata-local/`, `node_modules/`
- Default `main` is the merge target

## Что НЕ делать

- Не использовать regex/keyword-эвристики для **смысловых** решений (тип вопроса, нужен ли поиск, какая тема). Семантические решения переносим в существующие LLM-вызовы (planner / main). Regex остаётся для парсинга output, валидации UUID/email, безопасности.
- Не запускать `tsc`/`npm` напрямую с Windows-стороны — будет "Maximum call stack size exceeded" из-за UNC.
- Не делать checkpoint-resume / hierarchical chunking / replace-embedding-model в текущей итерации — это backlog, не quick wins.
- Не добавлять HyDE — для precision-first продукта риск галлюцинаций > выигрыш recall.
