# Remarka MVP

Editor-first AI narrative structure editor.

## Stack

- Next.js 15 (`apps/web`)
- Node worker + pg-boss (`apps/worker`)
- PostgreSQL + Prisma (`packages/db`)
- Shared contracts/utilities (`packages/contracts`)
- Provider-based extraction pipeline (Vertex AI by default)

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure env files:

```bash
cp packages/db/.env.example packages/db/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
```

3. Set required variables (minimum):

- `DATABASE_URL`
- `EXTRACT_LLM_PROVIDER` (`timeweb`, `kia`, or `vertex`)

If `EXTRACT_LLM_PROVIDER=timeweb`:
- `TIMEWEB_API_TOKEN`
- `TIMEWEB_PROXY_SOURCE`
- `TIMEWEB_EXTRACT_ACCESS_ID`
- `TIMEWEB_EXTRACT_MODEL`

If `EXTRACT_LLM_PROVIDER=kia`:
- `KIA_API_KEY`
- `KIA_CHAT_BASE_URL` (default `https://api.kie.ai/gemini-3-flash/v1`)
- `KIA_GEMINI_MODEL` (default `gemini-3-flash-openai`)

If `EXTRACT_LLM_PROVIDER=vertex`:
- `VERTEX_API_KEY`
- `VERTEX_EXTRACT_MODEL` (default `gemini-3.1-flash-lite-preview`)
- Optional `VERTEX_BASE_URL` (default `https://aiplatform.googleapis.com`)

Optional run artifacts storage:
- `ANALYSIS_ARTIFACTS_ENABLED` (`true` by default)
- `ARTIFACTS_STORAGE_PROVIDER` (`local` or `s3`)

If `ARTIFACTS_STORAGE_PROVIDER=s3`:
- `ARTIFACTS_S3_BUCKET`
- `ARTIFACTS_S3_REGION` (default `us-east-1`)
- Optional `ARTIFACTS_S3_ENDPOINT`
- Optional `ARTIFACTS_S3_KEY_PREFIX`
- Optional `ARTIFACTS_S3_FORCE_PATH_STYLE`
- `ARTIFACTS_S3_ACCESS_KEY_ID`
- `ARTIFACTS_S3_SECRET_ACCESS_KEY`
- Optional `ARTIFACTS_S3_SESSION_TOKEN`

Docker compose includes MinIO for S3-compatible artifact storage.

4. Generate Prisma client and apply migrations:

```bash
npm run db:generate
npm run db:migrate
```

5. Start web and worker in separate terminals:

```bash
npm run web:dev
```

```bash
npm run worker:dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker compose

1. Copy docker env template:

```bash
cp .env.docker.example .env.docker
```

2. Fill provider values in `.env.docker`:
   - `TIMEWEB_*` when `EXTRACT_LLM_PROVIDER=timeweb`
   - `KIA_*` when `EXTRACT_LLM_PROVIDER=kia`
   - `VERTEX_*` when `EXTRACT_LLM_PROVIDER=vertex`
   - Artifact storage defaults to MinIO (`ARTIFACTS_STORAGE_PROVIDER=s3`, endpoint `http://minio:9000`)

3. Start all services:

```bash
npm run docker:up
```

4. Open [http://localhost:3000](http://localhost:3000).

MinIO console: [http://localhost:9001](http://localhost:9001).

Useful commands:

```bash
npm run docker:logs
npm run docker:down
```

## Implemented MVP flows

- Projects list + new project creation.
- Project workspace with tabs:
  - `Document`: editor + inline highlights + margin notes + autosave + async analysis status.
  - `Entities`: grouped entity list, search, type filter.
- Entity details page with summary and mention links.
- Background extraction pipeline:
  - `PUT /api/projects/:projectId/document` saves content and enqueues `document.extract`.
  - worker extracts entities/mentions/annotations via configured provider (Vertex by default).
  - stale-version protection (`contentVersion`, `lastAnalyzedVersion`).
  - basic dedupe (`projectId + type + normalizedName`).
- SSE status endpoint: `GET /api/projects/:projectId/stream`.
