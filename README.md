# Remarka (Reset UI + Auth)

Target-UI rollout with Google Auth on `apps/web`, while preserving worker/agent extraction pipeline.

## Stack

- Next.js 15 (`apps/web`)
- Auth.js / NextAuth + Google OAuth (`apps/web`)
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

3. Set required variables:

Web (`apps/web/.env.local`):
- `DATABASE_URL`
- `AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_URL` (for local: `http://localhost:3000`)
- `IMPORT_BLOB_DIR` (for uploaded Book files, default `/tmp/remarka-imports`)
- `IMPORT_MAX_FILE_BYTES` (upload size limit, default `26214400`)
- `IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES` (zip safety limit, default `52428800`)

Worker (`apps/worker/.env`):
- `EXTRACT_LLM_PROVIDER` (`timeweb`, `kia`, or `vertex`)
- provider-specific credentials (`TIMEWEB_*`, `KIA_*`, `VERTEX_*`)

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
   - Book source files are stored in a separate MinIO bucket (`BOOKS_STORAGE_PROVIDER=s3`, `BOOKS_S3_BUCKET=remarka-books`)

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

## Current web routes

Public:
- `/`
- `/signin`

Protected (requires session):
- `/explore`, `/library`, `/favorites`, `/plans`, `/profile`, `/upload`
- `/book/:bookId` + nested routes (`characters`, `themes`, `locations`, `quotes`, `search`, etc.)

API:
- `/api/auth/[...nextauth]`
- `/api/books` (`GET`, `POST`)
- `/api/books/:bookId` (`GET`, `PATCH`, `DELETE`)
- `/api/books/:bookId/chapters` (`GET`)

## Worker/agent pipeline

Worker/extraction pipeline is preserved as-is (`apps/worker`, `apps/preprocessor`, `packages/contracts`, `packages/db`):
- outbox-driven event processing
- import pipeline (`project.import.requested`)
- extraction pipeline (`analysis.run.requested`)
