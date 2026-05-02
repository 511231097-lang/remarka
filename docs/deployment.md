# Деплой Remarka в продакшен

Раннбук для развёртывания на Timeweb Cloud. Пошагово: первичная настройка двух VPS, домен и TLS, миграция БД и S3, операционные команды.

## 1. Архитектура

```
Cloudflare DNS  ──►  remarka-web (91.186.196.205)
                         │
                         ├─ nginx :443  (TLS, rate-limit, прокси)
                         └─ Next.js :3000 (systemd: remarka-web)
                              │
                              ├──►  Managed Postgres 18 (Timeweb DBaaS, pgvector)
                              ├──►  Timeweb S3 (s3.twcstorage.ru, один bucket)
                              └──►  Vertex AI (Gemini, semantic ranker)

         remarka-worker (private 192.168.0.6, IPv6 для SSH)
                              │
                              └─ Node + tsx (systemd: remarka-worker)
                                   ├──►  Managed Postgres (pg-boss queue)
                                   └──►  Timeweb S3 (артефакты анализа)
```

- **web**: 2 vCPU / 4 GiB RAM / 50 GiB. Принимает HTTP-трафик, отдаёт UI и стрим чата.
- **worker**: 4 vCPU / 8 GiB RAM / 80 GiB. Никаких публичных портов. SSH только через `ProxyJump` через web.
- **Postgres**: managed, c расширениями `vector`, `pg_trgm`, `pg_stat_statements`.
- **S3**: один бакет `<S3_BUCKET>`, две префиксные зоны: `remarka/books/`, `remarka/analysis-artifacts/`.

## 2. Первичная настройка VPS

На каждом сервере (по очереди):

```bash
# С локальной машины — копируем скрипт и unit-файлы.
ssh remarka-web "mkdir -p /root/remarka-deploy"
scp scripts/deploy/setup-vps.sh \
    scripts/deploy/web.service \
    scripts/deploy/worker.service \
    remarka-web:/root/remarka-deploy/

ssh remarka-web "chmod +x /root/remarka-deploy/setup-vps.sh && /root/remarka-deploy/setup-vps.sh web"
```

Аналогично для воркера (`remarka-worker`, role=`worker`).

Скрипт идемпотентен. Что он делает:

1. Ставит Node 20.x LTS (NodeSource), nginx + certbot (только для web), build-essential, postgresql-client-16, ufw, rsync.
2. Создаёт системного пользователя `remarka` (без shell), home `/srv/remarka`.
3. Раскладывает структуру `/srv/remarka/{releases,current,shared/{env,secrets},logs}`.
4. Создаёт пустой `/srv/remarka/shared/env/{web|worker}.env` с правами `0600`.
5. Включает UFW: `22` всегда; `80`+`443` только на web.
6. Кладёт systemd unit, делает `enable` (но не `start` — env ещё пустой).

После прогона env-файл создан пустой. **Не заполняем его руками** — этим занимается deploy через GitHub. См. секцию **6. Env management** ниже про single source of truth.

## 3. Домен, DNS, TLS

1. В Cloudflare добавляем A-запись `<DOMAIN>` → `91.186.196.205` (DNS only, не proxied — иначе certbot HTTP-01 не пройдёт; после получения сертификата можно включить proxy).
2. На web:

```bash
ssh remarka-web bash <<'EOF'
set -euo pipefail
cp /srv/remarka/current/scripts/deploy/nginx.conf.template /etc/nginx/sites-available/remarka
sed -i "s/__DOMAIN__/your.domain.com/g" /etc/nginx/sites-available/remarka
ln -sf /etc/nginx/sites-available/remarka /etc/nginx/sites-enabled/remarka
rm -f /etc/nginx/sites-enabled/default

# Rate-limit zone в http {} — кладём отдельным конфигом.
cat >/etc/nginx/conf.d/00-rate-limits.conf <<'NGX'
limit_req_zone $binary_remote_addr zone=chat_stream:10m rate=20r/m;
NGX

nginx -t
systemctl reload nginx

# TLS.
certbot --nginx -d your.domain.com --non-interactive --agree-tos -m ops@your.domain.com
systemctl reload nginx
EOF
```

`certbot.timer` уже включён по умолчанию — продление автоматическое.

## 4. Бутстрап Postgres

Один раз, после того как Prisma создаст схему (миграции прокатываются на CI / руками):

```bash
# С web (там стоит psql).
export DATABASE_URL='postgresql://...?sslmode=require'

# 1. Прокатываем миграции.
cd /srv/remarka/current
sudo -u remarka bash -lc "DATABASE_URL='$DATABASE_URL' npm run db:migrate:deploy"

# 2. Расширения + HNSW-индексы.
psql "$DATABASE_URL" -f /srv/remarka/current/scripts/deploy/postgres-bootstrap.sql
```

`postgres-bootstrap.sql` идемпотентен: повторный запуск после миграций не сломает индексы.

## 5. Деплой через GitHub Actions

GitLab-style pipeline в одном workflow `pipeline.yml`:

```
push → build (auto) → migrate (manual) ──┬─→ deploy-web    (manual)
                                         └─→ deploy-worker (manual)
```

В Actions UI один run, граф связан, на каждом manual-этапе кнопка `Review deployments` → `Approve and deploy`. Аппрувы независимые — можно одобрить только `migrate + deploy-web` и пропустить worker.

`release_id` вычисляется в `build` job и пробрасывается в downstream через `needs.build.outputs.release_id`. Нет race-condition на `ls -t` под нагрузкой.

### Обычный flow

```
git push origin main             ← build стартует автоматом
  ↓ (ждём зелёного)
Approve "migrate"                ← если PR содержал миграции
Approve "deploy-web"             ← переключаем web
Approve "deploy-worker"          ← переключаем worker (можно параллельно с web)
```

Если миграций в PR нет — `migrate` всё равно нужно одобрить (no-op на уже мигрированной БД), чтобы цепочка прошла. Альтернативно — после approve всех деплоев можно вообще не апрувить migrate, но тогда deploy не запустятся (они `needs: migrate`). При желании можно сделать migrate опциональной — скажи, перепилю на `if:`-фильтр.

### Setup environments (один раз)

В **Settings → Environments** репо создать три окружения:

| Environment    | Required reviewers | Environment URL          | Назначение                        |
|----------------|-------------------|--------------------------|-----------------------------------|
| `prod-db`      | владелец          | —                        | gate перед миграциями             |
| `prod-web`     | владелец          | `https://remarka.app`    | gate перед деплоем web            |
| `prod-worker`  | владелец          | —                        | gate перед деплоем worker         |

Без этого приёмочные кнопки не появятся, и pipeline застрянет на первом manual-этапе с ошибкой "environment 'prod-db' does not exist".

### Secrets

В Settings → Secrets — **deploy-инфраструктура** (отдельно от runtime env, см. §6):
- `SSH_DEPLOY_KEY` — приватный ключ, парный к `~/.ssh/remarka_deploy.pub`
- `WEB_HOST` — IP или hostname web VPS
- `WORKER_HOST` — IP воркера (доступен через ProxyJump через web)

Все runtime-секреты приложения (`AUTH_SECRET`, `DATABASE_URL`, `VERTEX_API_KEY` и т.д.) — тоже здесь же, но управляются по другому процессу (см. §6).

### Аварийный re-deploy / rollback

Отдельный workflow `redeploy.yml` (manual `workflow_dispatch`) для:
- отката на предыдущий релиз без перезапуска полного пайплайна
- повторного выкатывания после ручного восстановления хоста
- деплоя конкретного `release_id`

Параметры:
- `target`: `web` / `worker` / `both`
- `release_id`: пусто = последний staged релиз на web, иначе явный ID

`redeploy.yml` НЕ запускает миграции на этом пути — `prisma migrate deploy` в этом коде additive-only, и для отката безопаснее предположить «БД уже на нужной схеме, нужно только переключить код». Если на rollback нужны миграции — гоняй полный pipeline.

Использует те же `prod-web` / `prod-worker` environments, поэтому approval-flow идентичный.

### Ручной откат через SSH (если CI недоступен)

```bash
ssh remarka-web 'sudo -u remarka bash -lc "
  PREV=$(ls -1t /srv/remarka/releases | sed -n 2p)
  ln -snfT /srv/remarka/releases/$PREV /srv/remarka/current
" && sudo systemctl restart remarka-web'
```

Build хранит **5 последних** релизов — есть запас на быстрый откат.

Ручной деплой (если CI лежит):

```bash
# Локально.
npm ci && npm run web:build
rsync -azv --delete \
  --exclude=node_modules --exclude=.git --exclude=.next/cache --exclude=evals \
  ./ remarka-web:/srv/remarka/releases/manual-$(date -u +%Y%m%d-%H%M%S)/

# На web.
ssh remarka-web bash <<'EOF'
RELEASE=$(ls -1t /srv/remarka/releases | head -1)
chown -R remarka:remarka /srv/remarka/releases/$RELEASE
sudo -u remarka bash -lc "cd /srv/remarka/releases/$RELEASE && npm ci --omit=dev && npm run db:generate"
ln -snfT /srv/remarka/releases/$RELEASE /srv/remarka/current
systemctl restart remarka-web
EOF
```

> **Note on Next.js standalone**: `apps/web/next.config.mjs` уже выставляет `output: 'standalone'`. systemd unit (`web.service`) ожидает standalone-сборку и запускает `.next/standalone/apps/web/server.js`.

## 6. Env management — single source of truth

Раньше env-файлы (`/srv/remarka/shared/env/web.env`, `worker.env`) редактировались
руками через SSH. Это породило все классические проблемы: дрифт между средами,
никакого audit trail, ротация — это «зайди по SSH в три часа ночи и не опечатайся».

Теперь источник правды — **GitHub** (Repository-level Secrets и Variables).
Deploy-pipeline на каждом запуске **рендерит** env-файл из шаблона и пушит на VPS.
SSH-edit на VPS бессмысленен — следующий деплой перепишет.

### Архитектура

```
GitHub Repository                            VPS
────────────────                             ────────────────
secrets.AUTH_SECRET ──┐                      /srv/remarka/shared/env/web.env
secrets.DATABASE_URL  │                      ▲
vars.NEXTAUTH_URL     │   envsubst           │  scp + install -m 600
vars.BOOK_CHAT_TOP_K  ├────►  pipeline.yml ──┘  (deploy-web step)
... (~80 names)       │   render step
                      │
scripts/deploy/web.env.template  ←── шаблон с ${PLACEHOLDERS}
```

**Шаблоны:**
- `scripts/deploy/web.env.template`
- `scripts/deploy/worker.env.template`

В шаблонах все имена переменных сразу видны (без чтения pipeline.yml).
Когда добавляется новая env-переменная:
1. Добавить в нужный template как `KEY=${KEY}`.
2. Добавить в env-блок render-step'а в `pipeline.yml` (`KEY: ${{ secrets.KEY }}` или `${{ vars.KEY }}`).
3. Завести в GitHub UI (`Settings → Secrets` или `Settings → Variables`).

### Что секрет, что переменная

**Секреты (Settings → Secrets — sensitive, скрыты в логах):**
- `AUTH_SECRET`, `DATABASE_URL`, `INTERNAL_WORKER_TOKEN`
- `VERTEX_API_KEY`, `VERTEX_RANKING_KEYFILE_JSON` (multi-line JSON keyfile)
- `BOOKS_S3_ACCESS_KEY_ID`, `BOOKS_S3_SECRET_ACCESS_KEY`
- `ARTIFACTS_S3_ACCESS_KEY_ID`, `ARTIFACTS_S3_SECRET_ACCESS_KEY`
- `YANDEX_CLIENT_SECRET`, `CAPTCHA_SECRET_KEY`

**Переменные (Settings → Variables — конфиг, видны в plain text):**
- `NEXTAUTH_URL`, `NEXT_PUBLIC_*` (публичные)
- `YANDEX_CLIENT_ID` (semi-public, OAuth client id)
- Все `BOOK_CHAT_*`, `ANALYSIS_*`, `VERTEX_*` (модели/лимиты/флаги — не sensitive)
- Все `BOOKS_S3_*`, `ARTIFACTS_S3_*` кроме access/secret keys (endpoint/bucket/region — public info)
- `IMPORT_BLOB_DIR`, `OUTBOX_*`, `SHOWCASE_*` и пр. — runtime-tuning

Полный авторитативный список — `scripts/deploy/{web,worker}.env.template` и render-step в `.github/workflows/pipeline.yml`.

### Bootstrap (один раз)

Перенести текущие значения с VPS в GitHub:

```bash
# Локально, требует gh + SSH доступ к remarka-web/remarka-worker
./scripts/deploy/sync-env-to-github.sh --dry-run    # сначала проверить
./scripts/deploy/sync-env-to-github.sh              # реально запушить
```

Скрипт:
1. Тянет `web.env` и `worker.env` с обоих хостов.
2. Каждое `KEY=VALUE` пушит как secret или variable согласно списку в скрипте.
3. Идемпотентен — повторный запуск переписывает существующие.

После него — отдельно отправить Vertex JSON-keyfile (если используется ranker):

```bash
ssh remarka-web sudo cat /srv/remarka/shared/secrets/vertex-ranking.json | \
  gh secret set VERTEX_RANKING_KEYFILE_JSON --body -
```

Deploy-pipeline после этого имеет всё что нужно — на ближайшем pushe-or-rerun он рендерит env-файлы по новой и кладёт на VPS.

### Изменение значения

Любая env-переменная (секрет или variable):

1. **Settings → Secrets / Variables** в репо.
2. Жмёшь Update, вводишь новое значение.
3. **Re-run pipeline** (`gh workflow run pipeline.yml` или Actions UI).
4. Approve `migrate` (если он трогает то что нужно), `deploy-web`, `deploy-worker`.
5. Web/Worker рестартят с обновлёнными env'ами.

Никакого SSH. Audit trail в GitHub history (видно кто/когда менял).

**Важные моменты:**
- `AUTH_SECRET` — ротация **разлогинит всех** (JWT'ки невалидны). Координируй с пользователями.
- `DATABASE_URL` — если меняешь хост/credentials, помни что migrate использует значение из этого secret напрямую, deploy-web/worker рендерит env-файл (web/worker рестартуют с новым URL'ом). Schema на новом хосте должна уже существовать.
- `INTERNAL_WORKER_TOKEN` — должен совпадать на web и worker. Раз в одном месте лежит — рендерится одинаково в оба env-файла, ОК.
- Если render-step падает с «Unresolved placeholders» — значит template ссылается на имя, которое отсутствует в env-блоке pipeline.yml ИЛИ в GitHub UI. Сообщение покажет конкретное имя.

### Резервный путь — ручной SSH-edit

Если CI лежит и срочно нужно поменять env (incident response):

```bash
ssh remarka-web 'sudo -u remarka nano /srv/remarka/shared/env/web.env'
ssh remarka-web 'systemctl restart remarka-web'
```

⚠️ Изменение перезапишется на следующем deploy. Сразу после восстановления CI — обновить значение в GitHub.

---

## 7. Миграция данных из dev (docker compose) в прод

### 6.1 Postgres

```bash
# Локально, против dev compose.
PGPASSWORD=postgres pg_dump -h localhost -p 5432 -U postgres remarka \
  --no-owner --no-acl --format=custom \
  -f /tmp/remarka-dev.dump

# Restore в managed PG.
pg_restore --no-owner --no-acl --clean --if-exists \
  -d "$DATABASE_URL" /tmp/remarka-dev.dump
```

Если в managed PG уже прошла `prisma migrate deploy` и есть пустые таблицы — лучше дампить только данные:

```bash
pg_dump --data-only --disable-triggers --format=custom -f /tmp/remarka-data.dump ...
```

### 6.2 S3 (MinIO → Timeweb S3)

Через `mc` (MinIO client):

```bash
mc alias set dev    http://localhost:9000 minioadmin minioadmin
mc alias set prod   https://s3.twcstorage.ru <S3_ACCESS_KEY> <S3_SECRET>

mc mirror --overwrite dev/remarka-books             prod/<S3_BUCKET>/remarka/books/
mc mirror --overwrite dev/remarka-analysis-artifacts prod/<S3_BUCKET>/remarka/analysis-artifacts/
```

Альтернатива через `aws s3 sync` — работает, но Timeweb S3 требует path-style, поэтому всегда `--endpoint-url=https://s3.twcstorage.ru` и `AWS_S3_FORCE_PATH_STYLE=true`.

## 8. Эксплуатация

### Логи

```bash
# Web.
ssh remarka-web 'journalctl -u remarka-web -f'

# Worker (через jump).
ssh remarka-worker 'journalctl -u remarka-worker -f'

# Только последние 200 строк, без follow.
ssh remarka-web 'journalctl -u remarka-web -n 200 --no-pager'

# Nginx.
ssh remarka-web 'tail -f /var/log/nginx/access.log /var/log/nginx/error.log'
```

### Рестарт

```bash
ssh remarka-web    'systemctl restart remarka-web'
ssh remarka-worker 'systemctl restart remarka-worker'
```

### Откат на предыдущий релиз

```bash
ssh remarka-web bash <<'EOF'
cd /srv/remarka/releases
ls -1t | head -5            # посмотреть, что есть
PREV=$(ls -1t | sed -n '2p') # второй сверху = предыдущий
ln -snfT /srv/remarka/releases/$PREV /srv/remarka/current
systemctl restart remarka-web
EOF
```

### Изменение env

`/srv/remarka/shared/env/{web,worker}.env` загружается systemd через `EnvironmentFile`. После правок:

```bash
ssh remarka-web 'sudo -u remarka nano /srv/remarka/shared/env/web.env'
ssh remarka-web 'systemctl restart remarka-web'
```

`daemon-reload` нужен только при изменении самого `.service` файла.

### Смена релизов вручную (smoke deploy)

Сначала `WEB_HOST=staging` через `workflow_dispatch` с `target=web` — это пушит без касания воркера. Если ок — потом `target=both`.

## 9. Troubleshooting

| Симптом | Проверка | Действие |
|---|---|---|
| 502 от nginx | `systemctl status remarka-web`, `curl -fsS http://127.0.0.1:3000/api/health` | Если node не запущен — `journalctl -u remarka-web -n 100`, обычно env-проблема. |
| `EADDRINUSE :3000` после рестарта | `ss -ltnp \| grep 3000` | Старый процесс не отжил `RestartSec`. Подождать или `systemctl reset-failed remarka-web`. |
| Чат-стрим режется на ~60s | `proxy_read_timeout` в nginx | Должно быть `600s` на `^/api/books/.+/chat/sessions/.+/stream$`. Перепроверить `nginx -T`. |
| `vector` extension missing | `psql -c "\dx"` | Прогнать `postgres-bootstrap.sql` ещё раз; если managed PG не даёт — открыть тикет Timeweb. |
| HNSW не используется в плане | `EXPLAIN (ANALYZE, BUFFERS) SELECT ...` | `SET enable_seqscan = OFF;` чтобы убедиться, что индекс жив. Если recall падает — поднять `ef_search` для сессии: `SET hnsw.ef_search = 100;`. |
| Вертекс ranker 401 | `cat /srv/remarka/shared/secrets/vertex-ranking.json` | Ключ протух / SA не имеет роли `discoveryengine.editor`. Перевыпустить и пересохранить. |
| Worker зависает на анализе | `journalctl -u remarka-worker -f`, `psql ... "SELECT * FROM \"BookAnalysisRun\" WHERE state='running' ORDER BY \"updatedAt\";"` | Watchdog должен сам отметить stale — `ANALYSIS_WATCHDOG_INTERVAL_MS=60000`. Если нет, `systemctl restart remarka-worker`. |
| Деплой завис на `npm ci` | `df -h /srv/remarka` | Возможно забили диск старыми релизами — workflow держит 3, но при ручных деплоях надо чистить руками. |
| HTTP-01 challenge fail | Cloudflare proxy включён | Выключить оранжевую тучку до выпуска сертификата, потом включить обратно (Full Strict). |

## 10. Что осталось вручную

- Переменная `INTERNAL_WORKER_TOKEN` должна совпадать на web и worker — сгенерируйте один раз и положите в оба env.
- `NEXTAUTH_URL` должен указывать на тот же домен, что и в Yandex ID OAuth client → Redirect URI `https://<DOMAIN>/api/auth/callback/yandex`.
