# Single per-user SSE event channel — design

**Записано:** 2026-05-02
**Статус:** Approved 2026-05-02 — реализация в работе на ветке `feat/sse-event-channel`.
**Связанные backlog'и:**
- `docs/backlog.md` → «Баг: loader чата появляется в другом чате» (Quick Fix)
- `docs/backlog.md` → «Chat SSE сохранять между навигацией» (Later / Product Debt)
- `Library.tsx` → short-polling `listAnalyzingBooks` каждые 4 секунды

## 1. Зачем

Сейчас в продукте две разные realtime-механики, каждая со своими граблями:

1. **Chat** — fetch-streaming (`POST /api/books/[bookId]/chat/sessions/[sessionId]/stream`).
   Стрим живёт ровно столько, сколько живёт `BookChat` компонент. При смене сессии loader светится в чужом чате (state глобальный на компонент). При уходе со страницы стрим обрывается, бэкенд продолжает писать, ответ виден только после рефреша.
2. **Analysis status** — `setInterval(4000ms)` в `Library.tsx` дёргает `listAnalyzingBooks()` пока в списке кто-то аналиэируется. Дёргается всегда, даже если ничего не происходит.

Хотим заменить оба механизма на один **долгоживущий per-user SSE channel** — единый поток событий, на который подписан клиент, пока пользователь в приложении.

## 2. Цели и не-цели

**Цели:**
- Закрыть оба бага чата (loader-в-чужом-чате и потеря-стрима-при-навигации).
- Убить short-polling анализа.
- Получить фундамент под будущие realtime-фичи без отдельной инфры (нотификации, прогресс-бар анализа, showcase rebuild done, multi-tab sync).

**Не-цели в этой итерации:**
- Multi-instance scale-out web-приложения (сейчас один web-инстанс).
- Push-нотификации в браузер (отдельный продуктовый вопрос).
- Точный multi-tab sync (best-effort, не обещаем идеально).
- Persistent event log с полным replay'ем (см. §6).

## 3. Архитектура — общая картина

```
┌───────────────────────────────────────────────────────────────────┐
│                           CLIENT (browser)                        │
│                                                                   │
│  EventChannelProvider (mounted at app root, авторизованные        │
│  страницы) ── EventSource("/api/events/stream") ───────────────┐  │
│       │                                                         │  │
│       ├── Subscribers via useEventChannel():                    │  │
│       │     • BookChat              (chat.token, chat.final)    │  │
│       │     • Library               (book.analysis.*)           │  │
│       │     • [future] Showcase, notifications, etc.            │  │
│       └── Auto-reconnect, heartbeat watchdog                    │  │
└─────────────────────────────────────────────────────────────────│──┘
                                                                  │
                              (long-lived HTTP/1.1 SSE)           │
                                                                  │
┌─────────────────────────────────────────────────────────────────▼──┐
│                  WEB process (Next.js, Node)                       │
│                                                                    │
│  /api/events/stream  ──┐                                           │
│                        │                                           │
│  EventBus (in-process) │                                           │
│   • Map<userId, Set<SseClient>>                                    │
│   • emit(userId, event) → fan out to all subscribed sockets        │
│                        │                                           │
│  ┌─────────────────────┴──────────────────────────────────────┐    │
│  │ Sources of events                                          │    │
│  │  • Chat in-flight: bookChatService → bus.emit(...)         │    │
│  │  • Postgres LISTEN "user_events":                          │    │
│  │      single shared pg connection, NOTIFY payload parsed    │    │
│  │      and routed to bus.emit(userId, event)                 │    │
│  └─────────────┬──────────────────────────────────────────────┘    │
└────────────────│───────────────────────────────────────────────────┘
                 │
        NOTIFY user_events, '<json>'
                 │
┌────────────────▼─────────────────────────────────┐
│           WORKER process (analysis, etc.)        │
│                                                  │
│  Жизненный цикл анализа книги, showcase rebuild, │
│  любой другой backend job:                       │
│   pg.query("NOTIFY user_events, $1", payload)    │
│                                                  │
│  Payload = { userId, type, data, ts }            │
└──────────────────────────────────────────────────┘
```

**Ключевая инвариантность:** на один web-процесс — **одна** `LISTEN user_events` connection. Сколько бы ни было онлайн-юзеров, мы держим один pg connection под NOTIFY. Дальше fan-out в памяти. Это снимает риск исчерпания пула (`connection_limit=20` в env).

## 4. Контракт событий

Все события — best-effort signals. **Источник правды — БД и REST API**, событие говорит «иди обнови / показать прогресс».

### 4.1 Конверт

```ts
interface UserEvent<T = unknown> {
  id: string;        // ULID, для Last-Event-ID resume (см. §6)
  type: EventType;   // см. §4.2
  ts: string;        // ISO8601, момент эмита на сервере
  data: T;           // payload по типу
}
```

### 4.2 Типы событий (стартовый набор)

| `type`                   | Источник | Когда | `data` | Замещает |
|---|---|---|---|---|
| `chat.token`             | web (in-process из bookChatService) | На каждый дельта-токен | `{ sessionId, text }` | текущий `event: token` per-message stream |
| `chat.status`            | web | Смена статуса (`Ищу параграфы` и т.п.) | `{ sessionId, text }` | `event: status` |
| `chat.tool`              | web | Вызов tool / получение результата | `{ sessionId, kind: "call"\|"result", toolName }` | (в существующем стриме покрывается через status) |
| `chat.final`             | web | Сообщение полностью записано в БД | `{ sessionId, messageId }` | `event: final` (минус полные fields — клиент рефетчит из REST) |
| `chat.error`             | web | Ошибка генерации | `{ sessionId, error, code? }` | `event: error` |
| `chat.snapshot`          | web | На SSE-connect, если есть активная генерация | `{ sessionId, accumulated, status, startedAt }` | (новый — для page reload) |
| `book.analysis.progress` | worker → NOTIFY | Прогресс анализа (опционально, для будущего progress UI) | `{ bookId, phase, pct? }` | (новый) |
| `book.analysis.done`     | worker → NOTIFY | Анализ завершён (успех или ошибка) | `{ bookId, status: "ready"\|"failed" }` | poll'инг `Library` |

### 4.3 Принципы

- `chat.final` отдаёт **только** `sessionId + messageId`. Полный объект сообщения клиент дочитывает из REST `getBookChatMessages` — это убирает дублирование контракта между REST и SSE.
- `book.analysis.done` не несёт обновлённую карточку книги. Клиент дёргает `listAnalyzingBooks` + `listBooks` — это дешевле, чем тащить весь DTO через NOTIFY (Postgres NOTIFY имеет лимит ~8KB на payload).

## 5. Серверная часть

### 5.1 Эндпоинт `/api/events/stream`

```
GET /api/events/stream
   Authorization: session cookie (NextAuth)
   Headers:
     Accept: text/event-stream
     Last-Event-ID: <id>  (optional, при reconnect)
   Response:
     Content-Type: text/event-stream
     Connection: keep-alive
     Cache-Control: no-cache, no-transform
     X-Accel-Buffering: no   (отключаем nginx буферизацию)
```

Жизненный цикл соединения:

1. Резолвим `userId` из сессии. Если нет сессии — `401`.
2. Создаём `SseClient { id, userId, controller, lastEventId }`, регистрируем в `EventBus`.
3. Если пришёл `Last-Event-ID`: пока **пусто** (см. §6) — отдаём только новые события начиная с момента подключения.
4. Шлём `: connected\n\n` (комментарий, не event) — клиент знает что подписка живая.
5. Каждые **25 секунд** шлём heartbeat `: ping <ts>\n\n`. Если client отвалился — `controller.enqueue` бросит, ловим, удаляем из `EventBus`.
6. На `request.signal.aborted` (TCP close) — удаляем из `EventBus`, `controller.close()`.

Один файл: `apps/web/src/app/api/events/stream/route.ts`. Ничего больше.

### 5.2 EventBus (in-process)

```ts
// apps/web/src/lib/events/bus.ts
type Listener = (event: UserEvent) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void { ... }

  emit(userId: string, event: UserEvent): void {
    for (const l of this.listeners.get(userId) ?? []) {
      try { l(event); } catch { /* listener crash != bus crash */ }
    }
  }
}

export const eventBus = new EventBus();
```

Singleton на процесс. Используется и SSE-роутом (для регистрации client'а), и chat-сервисом (для эмита токенов).

### 5.3 Postgres LISTEN bridge

```ts
// apps/web/src/lib/events/listenBridge.ts
//
// Запускается один раз при старте web-процесса.
// Держит ОДИН pg client в режиме LISTEN, при NOTIFY парсит payload и
// диспатчит в eventBus.
//
// Reconnect: при дисконнекте pg client — exponential backoff,
// при восстановлении переподписка LISTEN.

export async function startUserEventsListener(): Promise<void> {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("LISTEN user_events");
  client.on("notification", (msg) => {
    if (msg.channel !== "user_events" || !msg.payload) return;
    try {
      const parsed = JSON.parse(msg.payload) as { userId: string } & UserEvent;
      eventBus.emit(parsed.userId, parsed);
    } catch { /* malformed payload — log & drop */ }
  });
  client.on("error", (err) => { /* log + reconnect schedule */ });
}
```

Вызывается из `instrumentation.ts` Next.js (стандартный способ запустить что-то один раз на старте процесса).

### 5.4 Worker → NOTIFY

В `packages/db/src` добавляем helper `notifyUserEvent(userId, event)`. Worker пишет:

```ts
await prisma.$executeRawUnsafe(
  "SELECT pg_notify('user_events', $1)",
  JSON.stringify({ userId, ...event })
);
```

Лимит 8000 байт на payload — в наших событиях легко укладываемся.

**Альтернатива через outbox-таблицу** не нужна для этой итерации: события best-effort, потеря при crash не критична (источник правды — БД, клиент рефетчит). Если когда-то появится требование «гарантированная доставка push-уведомлений» — добавим durable layer.

## 6. Reconnect, Last-Event-ID и in-flight chat snapshot

`EventSource` API авто-реконнектит сам. При reconnect отправляет `Last-Event-ID` хедером.

### 6.1 Игнорируем `Last-Event-ID`

В phase 1 не делаем durable event log. Клиент на reconnect получает только новые события и **REST-refetch'ит state**:
- BookChat → `getBookChatMessages(sessionId)` если есть active session.
- Library → `listAnalyzingBooks()` + `listBooks()`.

Если когда-то появится use-case «юзер закрыл laptop на час и хочет пропущенные нотификации» — добавим `UserEvent` таблицу с TTL. Сейчас over-engineering.

### 6.2 In-flight chat snapshot — **обязательно для phase 2**

Когда юзер refresh'ит страницу посреди генерации ответа, REST-refetch покажет user-message без assistant-message (он ещё не дописан в БД). Без snapshot'а юзер увидит «дырку» — пропадёт всё что уже было сгенерировано до reload, новые токены придут только с момента подписки.

**Решение:** web-процесс держит `Map<userId, Map<sessionId, InFlightChat>>`:

```ts
interface InFlightChat {
  accumulated: string;      // весь текст что уже улетел в chat.token
  status: string;           // последний chat.status
  startedAt: Date;
  abortController: AbortController;
}
```

- При старте генерации (POST `/messages` → fire-and-forget) запись добавляется.
- На каждый `chat.token` accumulated дописывается.
- При `chat.final` / `chat.error` запись удаляется.
- При SSE-connect, если у юзера есть активные генерации, сервер шлёт `chat.snapshot` per session **до** обычных live-токенов:

```ts
{
  type: "chat.snapshot",
  data: { sessionId, accumulated, status, startedAt }
}
```

Клиент на `chat.snapshot` восстанавливает streaming-buffer = accumulated, подписывается на `chat.token` для продолжения. UX-эффект: после F5 пользователь видит **всё что уже было напечатано** + продолжение в реалтайме.

При process crash Map теряется → пользователь после reload видит пустой ответ → watchdog (см. §11 phase 4) пометит pending message как failed → REST-refetch покажет ошибку. Acceptable degradation для phase 1.

## 7. Клиентская часть

### 7.1 Provider

```tsx
// apps/web/src/lib/events/EventChannelProvider.tsx
"use client";

interface ChannelContextValue {
  subscribe<T>(type: EventType, handler: (event: UserEvent<T>) => void): () => void;
  // на 'connected' — подписчики могут заресетить локальный state и сделать REST refetch
  onReconnect(handler: () => void): () => void;
  status: "idle" | "connected" | "reconnecting" | "error";
}

export function EventChannelProvider({ children }: { children: ReactNode }) {
  // useRef<EventSource>, регистр listener'ов, status state
  ...
}

export function useEventChannel(): ChannelContextValue { ... }
```

Mount: внутри auth-aware layout (после того, как мы знаем что юзер залогинен). Anonymous страницы (лендинг, /signin) **без** провайдера — нет смысла открывать SSE для гостя.

### 7.2 Подписчики

**BookChat:**

```ts
useEffect(() => {
  if (!activeSessionId) return;
  const off = subscribe("chat.token", (event) => {
    if (event.data.sessionId !== activeSessionId) return;
    // append delta to streaming buffer for this session
  });
  // ... chat.status, chat.final, chat.error
  return off;
}, [activeSessionId, subscribe]);
```

Поскольку streaming buffer теперь живёт в provider/zustand store по `sessionId`, при смене активной сессии:
- Loader не светится в чужом чате (фильтр по `sessionId`).
- Стрим продолжается в фоне (provider не размонтируется).
- Возврат в чат → видим in-flight состояние.

**Library:**

```ts
useEffect(() => {
  const off = subscribe("book.analysis.done", () => {
    void refetchAnalyzing();
    void refetchLibrary();
  });
  return off;
}, [subscribe]);
```

`setInterval(4000)` удаляется. Возможный fallback: если событие не прилетело за N минут — refetch один раз (защита от пропуска события из-за crash worker'а).

### 7.3 Send-message API

Старый `POST /stream` отдаёт всё inline через response body. Перепиливаем на:

```
POST /api/books/[bookId]/chat/sessions/[sessionId]/messages
   body: { message: string }
   response: 202 Accepted, { sessionId, optimisticUserMessageId }

Tokens, status, final → приходят через /api/events/stream.
```

Бэкенд внутри POST'а:
1. Проверяет access, валидирует input.
2. Создаёт user-message в БД (transactional).
3. **Запускает `streamBookChatThreadReply` как fire-and-forget** — НЕ ждёт окончания внутри handler'а, сразу отвечает 202.
4. `streamBookChatThreadReply` пушит токены в `eventBus.emit(userId, ...)`.
5. По завершении пишет assistant-message в БД и эмитит `chat.final`.

**Важный edge-case:** если процесс умирает посреди генерации — assistant-message может остаться в БД в pending-состоянии (или вообще не записанным). Нужно:
- В `BookChatThread` уже есть pending-сообщения, посмотреть на текущую логику.
- Watchdog (раз в 5 минут): pending старше 10 минут → помечаем `failed`.

### 7.4 Abort

Сейчас юзер может нажать Stop в `BookChat` → AbortController отменяет fetch → backend через `request.signal` останавливает LLM.

В новой схеме fetch завершается за миллисекунды (POST 202), останавливать нечего. Нужен отдельный endpoint:

```
POST /api/books/[bookId]/chat/sessions/[sessionId]/abort
   → ставит флажок в in-process registry; bookChatService проверяет на каждом step.
```

In-memory registry `Map<sessionId, AbortController>`. При process crash registry теряется — пользовательский Stop становится no-op после рестарта, но на тот момент LLM-вызов уже всё равно отвалится (process down).

## 8. Инфраструктурные требования

### 8.1 nginx (deploy script)

```nginx
location /api/events/stream {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 24h;          # default 60s — убьёт SSE
  proxy_send_timeout 24h;
}
```

Существующий chat-стрим уже работает (значит nginx-настройки в целом ОК), но `proxy_read_timeout` для долгого idle нужно проверить.

### 8.2 systemd

`LimitNOFILE=65536` в unit-файле web. Default 1024 → упрёмся при тысяче коннекшенов.

### 8.3 Postgres

NOTIFY/LISTEN — встроенная фича, никаких миграций или новых таблиц **не нужно**.

## 9. Производительность — расчётные числа

Цели: 1000 MAU, 5-50 параллельно онлайн, peak ~100.

| Параметр | На 100 онлайн | На 1000 онлайн |
|---|---|---|
| Memory (idle SSE) | ~3 MB | ~30 MB |
| FD на web | 100 + LISTEN + др. | 1000 + LISTEN + др. |
| PG connections | **1 LISTEN** + transient | **1 LISTEN** + transient |
| NOTIFY throughput | tens/sec | hundreds/sec |
| CPU (heartbeat fan-out) | <0.1% | ~1% |

NOTIFY масштабируется до тысяч событий в секунду на одной машине Postgres. Bottleneck сейчас — **не SSE**.

## 10. Риски и митигация

| Риск | Митигация |
|---|---|
| LISTEN-connection падает (network blip) | Reconnect with exponential backoff. На время падения события теряются — клиенты на reconnect делают REST refetch. |
| Memory leak в EventBus (забытые listener'ы) | Все subscribe возвращают `unsubscribe`, тестируем cleanup в unit-тестах + WeakRef для подстраховки. |
| NOTIFY payload >8KB | Строго: только metadata + IDs, никакого DTO. Lint-правило/code review. |
| Один user открыл 50 вкладок — 50 SSE | Нормально, ~50KB памяти. Если станет проблемой — лимит N коннекшенов на user, новые вкладки получают 503. |
| Worker процесс шлёт NOTIFY быстрее, чем клиенты успевают читать | EventBus drop'ает на полный buffer (`controller.enqueue` бросит). Клиент на reconnect рефетчит. |
| Deploy: рестарт web рвёт все SSE | EventSource auto-reconnect. Клиенты на reconnect рефетчат state. UX-эффект: при деплое все увидят кратковременный "переподключение". Acceptable. |

## 11. Миграционный план (фазы)

### Phase 1 — Infra (1-2 дня)

- [ ] `apps/web/src/lib/events/types.ts` — типы событий, конверт.
- [ ] `apps/web/src/lib/events/bus.ts` — in-process EventBus.
- [ ] `apps/web/src/lib/events/listenBridge.ts` — pg LISTEN, reconnect.
- [ ] `apps/web/src/instrumentation.ts` (или дополнить) — старт LISTEN bridge.
- [ ] `apps/web/src/app/api/events/stream/route.ts` — SSE endpoint.
- [ ] `apps/web/src/lib/events/EventChannelProvider.tsx` — клиентский provider.
- [ ] Mount provider в `(protected)/layout.tsx`.
- [ ] Unit-тесты на bus + bridge.
- [ ] Smoke: вручную NOTIFY из psql, видим в DevTools EventStream.

### Phase 2 — Chat migration (2-3 дня)

- [ ] Новый endpoint `POST /api/books/[bookId]/chat/sessions/[sessionId]/messages` (202 + fire-and-forget).
- [ ] Endpoint abort.
- [ ] Watchdog для pending assistant-messages.
- [ ] `BookChat` подписывается на `chat.*` events, streaming buffer перенесён в provider/store.
- [ ] Старый `/stream` endpoint оставляем feature-flag'ом ENV `BOOK_CHAT_LEGACY_STREAM=true` на rollback (одну неделю), потом удаляем.
- [ ] Smoke на golden eval (`npm run eval:chat-regression -- --golden`) — убедиться что метрики не просели.

### Phase 3 — Analysis events (1 день)

- [ ] В worker'е: при изменении статуса анализа → `pg_notify('user_events', ...)`.
- [ ] `Library` подписывается на `book.analysis.done`, удаляем `setInterval`.
- [ ] Fallback: если событие не прилетело за 5 минут с момента старта анализа → один разовый refetch.

### Phase 4 — Cleanup (0.5 дня)

- [ ] Удаляем `BOOK_CHAT_LEGACY_STREAM` flag и старый stream endpoint.
- [ ] Удаляем `streamBookChatMessage` client helper, старый `streamingMultipart` (если он только про чат).
- [ ] Документируем pattern в `docs/` для future event types.

**Общая оценка:** 4-6 рабочих дней.

## 12. Решения по открытым вопросам (apply)

Зафиксировано на ревью 2026-05-02:

1. **Provider монтируем в `(protected)/layout.tsx`.** Anonymous страницы без SSE — для гостей реалтайм не нужен.
2. **Abort через REST** в phase 1. Multi-instance не делаем сейчас.
3. **Watchdog для pending assistant-messages — в worker'е.** Логично рядом с `ANALYSIS_WATCHDOG_INTERVAL_MS`, единая точка для всех «зависших» сущностей.
4. **Метрики нужны с phase 1.** Минимум: `sse_active_connections`, `events_emitted_total{type}`, `events_dropped_total{reason}`, `notify_received_total`, `bus_dispatch_duration_ms`. Логируем pino-структурой как в worker'е.
5. **Local dev — через docker compose**, не `next dev`. Hot-reload web-процесса из docker не происходит → LISTEN connection живёт сколько живёт контейнер.

**Ключевое требование, добавленное на ревью:** «после обновления страницы должно цеплять и продолжать всё что было до этого» → реализуется через `chat.snapshot` (см. §6.2).

---

## Решения, принятые на этапе обсуждения

- **Не делаем durable event log в phase 1.** События — best-effort, источник правды БД. Усложнение инфры окупится только когда появится реальный use-case (например, push-нотификации с гарантией доставки).
- **Не уносим chat LLM call в worker.** Остаётся в web-процессе, просто отвязан от lifecycle HTTP-запроса. Перенос в worker — отдельный архитектурный шаг с большими последствиями (стоимость, latency, scale-out).
- **Не делаем Redis pubsub в phase 1.** Один web-инстанс, in-process fan-out достаточно. Redis добавляем когда захотим горизонтальный scale.
