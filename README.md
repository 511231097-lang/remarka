# Remarka MVP

Editor-first AI narrative structure editor.

## Stack

- Next.js 15 (`apps/web`)
- Node worker + pg-boss (`apps/worker`)
- PostgreSQL + Prisma (`packages/db`)
- Shared contracts/utilities (`packages/contracts`)
- Timeweb OpenAI-compatible extraction pipeline

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
- `TIMEWEB_API_TOKEN`
- `TIMEWEB_PROXY_SOURCE`
- `TIMEWEB_EXTRACT_ACCESS_ID`
- `TIMEWEB_EXTRACT_MODEL`

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

2. Fill `TIMEWEB_*` values in `.env.docker`.

3. Start all services:

```bash
npm run docker:up
```

4. Open [http://localhost:3000](http://localhost:3000).

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
  - worker extracts entities/mentions/annotations via Timeweb/OpenAI-compatible API.
  - stale-version protection (`contentVersion`, `lastAnalyzedVersion`).
  - basic dedupe (`projectId + type + normalizedName`).
- SSE status endpoint: `GET /api/projects/:projectId/stream`.
