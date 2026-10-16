# design.md — Workshop Registration and Notifications

Implements `specs.md`. Requirement IDs (FR-n, D-n) are referenced throughout.

## 1. Architecture

```
            HTTP                                   HTTP POST /notify
 client ─────────────► Registration Backend ──────────────────────────► Mock Notification Service
                       (Express, :3000)        Idempotency-Key header    (Express, :4000)
                         │          ▲                                      in-memory delivery log
                  1 txn  │          │ poll / claim / update
                         ▼          │
                       PostgreSQL 18 (localhost:5432, db "workshops")
                       workshops | registrations | notifications (outbox)
```

- **Registration Backend**: one Node process with two parts.
  - the **HTTP API** (Express)
  - the **Dispatcher**, a background loop started by the same process
- **Outbox pattern**: the API never calls the mock service. It writes the business change and the notification row(s) in one DB transaction. The Dispatcher delivers the rows later. This one decision covers FR-4, FR-5, FR-6, FR-7 and FR-8.
- **Mock Notification Service**: a separate Node process with in-memory state.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 (ES modules, native `fetch`, `AbortSignal.timeout`, `--env-file`) |
| HTTP | `express` |
| DB driver | `pg` (Pool) |
| DB | PostgreSQL 18, `gen_random_uuid()` (built in) |
| Config | `.env` loaded with `node --env-file=.env` (no dotenv dependency) |
| Logging | `console` with a tagged prefix, e.g. `[api]`, `[dispatcher]`, `[mock]` |

Runtime dependencies are limited to `express` and `pg`.

## 3. Project layout

```
Task2_GDG/
├── package.json              # scripts + deps (single package)
├── .env.example
├── README.md                 # run instructions + reliability explanation (D-3, D-4)
├── backend/
│   ├── migrations/001_init.sql
│   ├── scripts/migrate.js    # creates DB "workshops" if missing, applies SQL
│   └── src/
│       ├── config.js         # reads/validates env
│       ├── db.js             # pg Pool + withTransaction helper
│       ├── app.js            # express app, routes, error handler
│       ├── routes/workshops.js
│       ├── dispatcher.js     # outbox poller/sender
│       └── server.js         # boots app + dispatcher, graceful shutdown
├── mock-notifier/
│   └── src/server.js
└── demo/
    └── demo.js               # scripted scenarios A & B (D-1, D-2)
```

### npm scripts

| Script | Command |
|---|---|
| `migrate` | `node --env-file=.env backend/scripts/migrate.js` |
| `start:backend` | `node --env-file=.env backend/src/server.js` |
| `start:mock` | `node --env-file=.env mock-notifier/src/server.js` |
| `demo` | `node --env-file=.env demo/demo.js` |

## 4. Configuration (`.env.example`)

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | `postgres://postgres:CHANGE_ME@localhost:5432/workshops` | backend | Postgres connection |
| `PORT` | `3000` | backend | API port |
| `NOTIFIER_URL` | `http://localhost:4000/notify` | backend | Mock endpoint |
| `POLL_INTERVAL_MS` | `1000` | dispatcher | Delay between polls |
| `BATCH_SIZE` | `20` | dispatcher | Max rows claimed per poll |
| `REQUEST_TIMEOUT_MS` | `3000` | dispatcher | Per-request timeout to the mock |
| `LEASE_MS` | `30000` | dispatcher | Claim lease. Must be greater than `REQUEST_TIMEOUT_MS`. |
| `BACKOFF_BASE_MS` | `1000` | dispatcher | Base for exponential backoff |
| `BACKOFF_MAX_MS` | `30000` | dispatcher | Backoff cap |
| `MOCK_PORT` | `4000` | mock | Mock port |
| `MOCK_FAILURE_RATE` | `0.2` | mock | Probability of returning 503 |
| `MOCK_TIMEOUT_RATE` | `0.2` | mock | Probability of timing out |
| `MOCK_TIMEOUT_DELAY_MS` | `10000` | mock | How long a "timeout" waits. Must be greater than `REQUEST_TIMEOUT_MS`. |
| `BACKEND_URL` / `MOCK_URL` | `http://localhost:3000` / `http://localhost:4000` | demo | Targets for the demo |

`config.js` checks that the numeric values are valid and refuses to start if `LEASE_MS <= REQUEST_TIMEOUT_MS`.

## 5. Data model (`backend/migrations/001_init.sql`)

```sql
CREATE TABLE IF NOT EXISTS workshops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  organizer_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id   UUID NOT NULL REFERENCES workshops(id),
  member_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_registration_member UNIQUE (workshop_id, member_id)      -- FR-3
);

CREATE TABLE IF NOT EXISTS notifications (                               -- the outbox
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),           -- = Idempotency-Key (FR-10)
  type             TEXT NOT NULL CHECK (type IN ('registration_confirmation','workshop_cancelled')),
  registration_id  UUID NOT NULL REFERENCES registrations(id),
  workshop_id      UUID NOT NULL REFERENCES workshops(id),
  member_id        TEXT NOT NULL,
  email            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  attempts         INT  NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  CONSTRAINT uq_notification_per_registration UNIQUE (registration_id, type)  -- never enqueue twice
);

CREATE INDEX IF NOT EXISTS idx_notifications_due
  ON notifications (next_attempt_at) WHERE status = 'pending';
```

Notes:
- There is no `failed` status. Rows remain `pending` until a 2xx is received (FR-7, "eventually").
- `uq_notification_per_registration` makes it impossible for one registration to have two confirmations or two cancellation notices.

`migrate.js`:
1. Connects to the `postgres` maintenance DB.
2. Runs `CREATE DATABASE workshops` if `pg_database` has no row for it.
3. Connects to `workshops` and runs every `migrations/*.sql` in name order.

The SQL is idempotent (`IF NOT EXISTS`), so re-running is safe.

## 6. Backend HTTP API

All bodies are JSON.

Errors use this shape:

```json
{ "error": { "code": "STRING", "message": "human text" } }
```

### 6.1 `POST /workshops` (FR-1)
Request:
```json
{ "title": "Intro to Go", "organizerId": "org-1" }
```

Validation: `title` and `organizerId` must be non-empty strings (after trim). Otherwise: 400 `VALIDATION_ERROR`.

Response 201:
```json
{ "id": "uuid", "title": "...", "organizerId": "org-1", "status": "active", "createdAt": "..." }
```

### 6.2 `POST /workshops/:id/registrations` (FR-2..FR-5)
Request:
```json
{ "memberId": "m-1", "email": "m1@example.com" }
```

Validation:
- `memberId`: non-empty string
- `email`: non-empty string matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- `:id`: a valid UUID. An invalid UUID returns 404.

Transaction (`withTransaction`):
```
SELECT id, status FROM workshops WHERE id = $1 FOR SHARE      -- serialises against cancel
  none        -> ROLLBACK, 404 WORKSHOP_NOT_FOUND
  cancelled   -> ROLLBACK, 409 WORKSHOP_CANCELLED
INSERT INTO registrations (...) RETURNING *
  unique_violation (23505, uq_registration_member) -> ROLLBACK, 409 ALREADY_REGISTERED
INSERT INTO notifications (type='registration_confirmation', registration_id, workshop_id,
                           member_id, email, payload) RETURNING id
COMMIT
```

Response 201 is sent right after COMMIT. It contains no network call (FR-4):
```json
{ "registration": { "id": "...", "workshopId": "...", "memberId": "m-1", "email": "...", "createdAt": "..." },
  "confirmation": { "notificationId": "...", "status": "pending" } }
```

Every failure path rolls back before the notification insert commits, so a failed registration can never produce a confirmation (FR-5).

### 6.3 `POST /workshops/:id/cancel` (FR-9)
Transaction:
```
SELECT id, status FROM workshops WHERE id = $1 FOR UPDATE      -- blocks concurrent registrations
  none       -> 404 WORKSHOP_NOT_FOUND
  cancelled  -> 409 WORKSHOP_ALREADY_CANCELLED
UPDATE workshops SET status='cancelled', cancelled_at=now() WHERE id=$1
INSERT INTO notifications (type, registration_id, workshop_id, member_id, email, payload)
  SELECT 'workshop_cancelled', r.id, r.workshop_id, r.member_id, r.email, <payload>
  FROM registrations r WHERE r.workshop_id = $1
COMMIT
```

The `FOR UPDATE` / `FOR SHARE` lock pair ensures that one of two orders always holds:
- the registration commits first, and the cancel then includes it, or
- the registration runs after the cancel and is rejected with 409.

So no registered member can be missed.

Response 200:
```json
{ "id": "...", "status": "cancelled", "cancelledAt": "...", "notificationsQueued": 3 }
```

### 6.4 `GET /workshops/:id/notifications` (demo observability only, D-1/D-2)
Returns the outbox rows for the workshop, ordered by `created_at`:
```json
[{ "id", "type", "memberId", "email", "status", "attempts", "lastError", "nextAttemptAt", "sentAt" }]
```
Returns 404 if the workshop does not exist.

### 6.5 Payloads sent to the mock
```json
{ "notificationId": "<outbox id>", "type": "registration_confirmation" | "workshop_cancelled",
  "memberId": "m-1", "email": "m1@example.com", "workshopId": "...",
  "message": "You are registered for \"Intro to Go\"." | "Workshop \"Intro to Go\" has been cancelled." }
```
The `payload` column stores this object when the row is created. The Dispatcher sends it exactly as stored.

### 6.6 Error handling
- An Express error middleware maps known errors (an `AppError` class with `status` and `code`) to their response.
- Malformed JSON returns 400 `VALIDATION_ERROR`.
- Anything else returns 500 `INTERNAL_ERROR` and is logged.

## 7. Dispatcher (outbox delivery) — FR-5..FR-8, FR-10

### 7.1 Loop
- Started by `server.js` after the HTTP server starts listening.
- Runs one tick immediately at startup, which recovers any backlog left before a restart (FR-6).
- After each tick finishes, it schedules the next one with `setTimeout(POLL_INTERVAL_MS)`, so ticks never overlap.

### 7.2 Claim (one statement, atomic)
```sql
UPDATE notifications
SET locked_until = now() + ($LEASE_MS || ' milliseconds')::interval
WHERE id IN (
  SELECT id FROM notifications
  WHERE status = 'pending'
    AND next_attempt_at <= now()
    AND (locked_until IS NULL OR locked_until < now())
  ORDER BY next_attempt_at
  LIMIT $BATCH_SIZE
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```
- The lease means a row is not picked up again while it is being sent.
- If the process dies mid-send, the lease expires and the row is claimed again. A crash never strands a row.
- `SKIP LOCKED` would also keep multiple instances safe, but running multiple instances is out of scope.

### 7.3 Send (failure isolation, FR-8)
- All claimed rows are sent concurrently with `Promise.allSettled`.
- Each send has its own `try/catch` and its own DB update.
- One slow, failing or timing-out member never affects another. A timeout costs at most `REQUEST_TIMEOUT_MS`, and only for that row.

Each request:
```
fetch(NOTIFIER_URL, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': row.id },
  body: JSON.stringify(row.payload),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
```

### 7.4 Outcome
- **2xx**: the notification is delivered.
  ```sql
  UPDATE notifications SET status='sent', sent_at=now(), attempts=attempts+1,
         locked_until=NULL, last_error=NULL WHERE id=$1
  ```
- **Non-2xx, timeout (AbortError/TimeoutError), or network error**: retry later.
  ```sql
  UPDATE notifications SET attempts=attempts+1, last_error=$2,
         next_attempt_at = now() + $3::interval, locked_until=NULL WHERE id=$1
  ```
  - delay = `min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^attempts)`, plus up to 20% random jitter
  - `last_error` examples: `HTTP 503`, `timeout after 3000ms`, `ECONNREFUSED`
- The mock only produces 2xx, 5xx and timeouts, so every non-2xx response is treated as retryable.
- If the DB update itself fails, the error is logged and the row stays leased. When the lease expires the row is retried, so it is never lost.

### 7.5 Shutdown
On `SIGINT` or `SIGTERM`, `server.js` does the following in order:
1. Stops scheduling new ticks.
2. Closes the HTTP server.
3. Waits for the in-flight tick to finish.
4. Ends the pool.

A hard kill is also safe, because of the lease (§7.2).

## 8. Mock Notification Service (FR-11, FR-10)

In-memory state:
- `deliveries`: a `Map<idempotencyKey, {receivedAt, payload}>`
- `config`: `{ failureRate, timeoutRate, timeoutDelayMs, failMemberIds: string[] }`, initialised from env

### `POST /notify`
1. If the `Idempotency-Key` header is missing: 400. (This is a contract check, not a delivery failure.)
2. **If the key is already in `deliveries`**: 200 `{ "status": "delivered", "duplicate": true }`. Nothing is recorded again (FR-10).
3. **If `payload.memberId` is in `failMemberIds`**: 503. Used for the deterministic failure-isolation demo.
4. Roll `r = Math.random()`:
   - **`r < failureRate`**: 503 `{ "error": "simulated failure" }`. Nothing is recorded.
   - **`r < failureRate + timeoutRate`**: **record the delivery, then wait `timeoutDelayMs` before replying 200.**
     - The backend has already given up waiting by then, so it will retry.
     - This simulates "processed but the acknowledgement was lost", which demonstrates duplicate suppression.
   - **Otherwise**: record the delivery and return 200 `{ "status": "delivered" }`.
5. Every outcome is logged as `[mock] <outcome> key=<id> member=<memberId> type=<type>`.

### Demo/control endpoints
- `GET /deliveries`: the recorded deliveries (one entry per unique key) plus a count.
- `GET /config`: returns the current config.
- `PUT /config`: partial update of `failureRate`, `timeoutRate`, `timeoutDelayMs` and `failMemberIds`.
  - Rates are clamped to `[0, 1]`.
  - The demo uses it for "down" (`failureRate: 1`), "healthy" (`failureRate: 0, timeoutRate: 0`) and per-member failure.

State is in memory because this is a mock. Restarting the mock clears its dedupe log. This is documented in the README.

## 9. Reliability explanation (source for README D-4)

| Concern | How it is handled |
|---|---|
| **Lost notifications** | The notification row is committed in the **same transaction** as the registration or cancellation. There is no window where one is saved and the other is not. A row is marked `sent` only after a 2xx, so a crash, timeout or error can never lose it. |
| **Retries** | Any non-2xx, timeout or connection error reschedules the row with capped exponential backoff and jitter. Delivery keeps retrying until it succeeds, which gives *eventual* delivery. Mock outages only delay notifications. |
| **Duplicate delivery** | At-least-once sending is unavoidable, because a timeout may hide a successful delivery. Each row's UUID is sent as `Idempotency-Key` on every attempt, and the mock records each key once and acknowledges repeats. Duplicate *enqueueing* is prevented by `UNIQUE(registration_id, type)` and by the unique registration constraint. |
| **Backend restarts** | The pending state lives in Postgres, not in memory. On startup the dispatcher immediately polls and delivers the backlog. Rows that were mid-send when the process died are claimed again once their lease expires. |
| **Failure isolation** | Each notification is an independent row with its own send, its own timeout and its own status update (`Promise.allSettled`). One member's failures only change that member's `next_attempt_at`. |
| **Failed registrations** | Every rejection path rolls back before commit, so no notification row exists for them. |

## 10. Demo script (`demo/demo.js`) — D-1, D-2

The script uses plain `fetch` and prints a readable step log. It polls `GET /workshops/:id/notifications` until a condition is met or 30 s pass.

**Scenario A — registration and cancellation (D-1, FR-1..FR-5, FR-9)**
1. Set the mock to healthy.
2. Create a workshop.
3. Register `m-1`, `m-2` and `m-3`. Each returns 201.
4. Register `m-1` again. Expect 409, and no new notification.
5. Wait until all 3 confirmations are `sent`.
6. Cancel the workshop. Expect `notificationsQueued: 3`.
7. Register `m-4` on the cancelled workshop. Expect 409, and no notification.
8. Wait until the 3 cancellation notices are `sent`.
9. Print the mock's `/deliveries` count for this workshop.

**Scenario B — failure, isolation and recovery (D-2, FR-7, FR-8, FR-10)**
1. Set the mock to `failureRate: 1`, so it is down.
2. Create a workshop and register `m-1` and `m-2`.
3. Show that the registration responses came back immediately, while the notifications are `pending` with `attempts` increasing and `lastError: HTTP 503`.
4. Set the mock to healthy, but with `failMemberIds: ["m-2"]`.
5. Wait until `m-1` is `sent` while `m-2` is still `pending`. This is failure isolation.
6. Clear `failMemberIds`, wait until `m-2` is `sent`, and print the attempt counts. This is recovery.
7. Duplicate suppression:
   1. Set `timeoutRate: 1` and `failureRate: 0`.
   2. Register `m-3`.
   3. Wait for at least 1 failed attempt (the timeout).
   4. Set the mock to healthy.
   5. Wait until `m-3` is `sent`.
   6. Show that the mock's `/deliveries` holds exactly one entry for that key.
8. Restore the mock config to its starting values.

**Scenario C — backend restart (manual, README; FR-6)**
1. Run `PUT /config` to set `failureRate` to 1.
2. Register a member, and see the confirmation `pending`.
3. Stop the backend with Ctrl+C.
4. Run `PUT /config` to make the mock healthy.
5. Start the backend.
6. The startup tick delivers the confirmation. See it `sent`, and see it in the mock's `/deliveries`.

The README gives exact `curl` commands, with PowerShell `Invoke-RestMethod` equivalents.
