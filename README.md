# Workshop Registration with Reliable Notifications

GDG Backend Task 2. Members register for workshops, and organizers can cancel a workshop. Every successful registration sends one confirmation notification, and every cancellation sends one notice to each registered member. Notifications go to a **mock notification service** that sometimes fails or times out on purpose.

The notifications still arrive when that service is down, slow or restarting, and when the backend itself restarts.

```
            HTTP                                   HTTP POST /notify
 client ─────────────► Registration Backend ──────────────────────────► Mock Notification Service
                       (Express, :3000)        Idempotency-Key header    (Express, :4000)
                         │          ▲                                      in-memory delivery log
                  1 txn  │          │ poll / claim / update
                         ▼          │
                       PostgreSQL (localhost:5432, db "workshops")
                       workshops | registrations | notifications (outbox)
```

- The **backend** never calls the notification service while handling a request. It saves the registration or cancellation and its notification rows in **one database transaction** (the *transactional outbox* pattern).
- A background **dispatcher** in the same process delivers those rows, retries failures with backoff, and recovers after restarts.
- The **mock notification service** is a separate process. Its failure rate, timeout rate and per-member failures can be changed at runtime.

Design documents: [`specs.md`](specs.md) (requirements), [`design.md`](design.md) (design), [`tasks.md`](tasks.md) (implementation plan).

## Prerequisites

- **Node.js 24** or later (`node -v`)
- **PostgreSQL**, version 13 or later; developed on 18. It must be running on `localhost:5432`, and you need the `postgres` user's password.

There are only two runtime dependencies (`express` and `pg`). There is no Docker.

## Setup

```bash
git clone https://github.com/Rectification0/workshop-notifications.git
cd workshop-notifications
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Edit `.env` and replace `CHANGE_ME` in `DATABASE_URL` with your `postgres` password. URL-encode special characters, for example `@` becomes `%40`.

```bash
npm install
npm run migrate               # creates the "workshops" database if missing, then applies the schema
```

You can run `npm run migrate` again safely; it changes nothing that already exists.

## Running

Use two terminals:

```bash
npm run start:mock            # terminal 1: mock notification service on :4000
npm run start:backend         # terminal 2: API + dispatcher on :3000
```

Then, in a third terminal, run the automated demo:

```bash
npm run demo
```

The demo runs Scenario A (registration and cancellation) and Scenario B (failure, isolation, recovery and duplicate suppression). It prints a `PASS` or `FAIL` line for every check, and exits with code 0 only if all checks pass. It takes about 20 seconds.

When it finishes, it restores the mock's config to what it was before the demo. While it runs, the backend and mock terminals show each delivery attempt:

```
[dispatcher] 5f0e… registration_confirmation member=m-1 attempt=2 -> retry in 2213ms (HTTP 503)
[dispatcher] 5f0e… registration_confirmation member=m-1 attempt=3 -> sent
[mock] duplicate key=20133cc2-… member=m-3 type=registration_confirmation
```

Stop either service with **Ctrl+C**. The backend shuts down cleanly: it stops polling, closes the HTTP server, waits for any delivery that is in progress, and closes the database pool.

### Configuration

All settings are in `.env`; see [`.env.example`](.env.example) for every variable and its default. The main ones:

| Variable | Default | Meaning |
|---|---|---|
| `POLL_INTERVAL_MS` | `1000` | Delay between dispatcher polls |
| `REQUEST_TIMEOUT_MS` | `3000` | Per-request timeout when calling the mock |
| `LEASE_MS` | `30000` | How long a claimed row is reserved. Must be greater than `REQUEST_TIMEOUT_MS`. |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `1000` / `30000` | Exponential backoff base and cap |
| `MOCK_FAILURE_RATE` / `MOCK_TIMEOUT_RATE` | `0.2` / `0.2` | The mock's starting failure and timeout probabilities |
| `MOCK_TIMEOUT_DELAY_MS` | `10000` | How long a simulated timeout waits before replying. Must be greater than `REQUEST_TIMEOUT_MS`. |

## API reference

### Backend (`http://localhost:3000`)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `POST` | `/workshops` | `{ "title", "organizerId" }` | `201` workshop with `status: "active"` | `400 VALIDATION_ERROR` |
| `POST` | `/workshops/:id/registrations` | `{ "memberId", "email" }` | `201 { registration, confirmation: { notificationId, status: "pending" } }` | `400 VALIDATION_ERROR`, `404 WORKSHOP_NOT_FOUND`, `409 WORKSHOP_CANCELLED`, `409 ALREADY_REGISTERED` |
| `POST` | `/workshops/:id/cancel` | none | `200 { id, status: "cancelled", cancelledAt, notificationsQueued }` | `404 WORKSHOP_NOT_FOUND`, `409 WORKSHOP_ALREADY_CANCELLED` |
| `GET` | `/workshops/:id/notifications` | none | `200 [{ id, type, memberId, email, status, attempts, lastError, nextAttemptAt, sentAt }]` | `404 WORKSHOP_NOT_FOUND` |

- Errors have the shape `{ "error": { "code", "message" } }`.
- The `GET .../notifications` endpoint is read-only. It exists only so you can watch delivery during the demos.

### Mock notification service (`http://localhost:4000`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/notify` | Receives a notification. It requires an `Idempotency-Key` header and returns `400` without one. A key it has already delivered returns `200 { duplicate: true }` and is not recorded again. Otherwise it returns `503` (simulated failure, or the member is in `failMemberIds`), "times out" (records the delivery but replies only after `timeoutDelayMs`), or returns `200`. |
| `GET` | `/deliveries` | `{ count, deliveries: [{ key, receivedAt, payload }] }`, with one entry per unique key |
| `GET` | `/config` | The current `{ failureRate, timeoutRate, timeoutDelayMs, failMemberIds }` |
| `PUT` | `/config` | Partial update of any of the fields above. The rates are clamped to `[0, 1]`. |

## Scenario C: backend restart (manual)

This walkthrough shows that a notification queued before a backend restart is delivered afterwards, with no new request. Start the mock and the backend as described in [Running](#running), and run the commands below from a third terminal.

**1. Take the mock down**, so nothing can be delivered:

```bash
curl -X PUT localhost:4000/config -H "Content-Type: application/json" -d '{"failureRate":1,"timeoutRate":0}'
```
```powershell
Invoke-RestMethod -Method Put -Uri http://localhost:4000/config -ContentType 'application/json' -Body '{"failureRate":1,"timeoutRate":0}'
```

**2. Create a workshop and register a member.** The registration returns `201` straight away even though the mock is down.

```bash
curl -X POST localhost:3000/workshops -H "Content-Type: application/json" -d '{"title":"Restart demo","organizerId":"org-1"}'
# copy the "id" from the response:
WID=<workshop id>
curl -X POST localhost:3000/workshops/$WID/registrations -H "Content-Type: application/json" -d '{"memberId":"m-1","email":"m1@example.com"}'
curl localhost:3000/workshops/$WID/notifications      # status "pending", attempts growing, lastError "HTTP 503"
```
```powershell
$w = Invoke-RestMethod -Method Post -Uri http://localhost:3000/workshops -ContentType 'application/json' -Body '{"title":"Restart demo","organizerId":"org-1"}'
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/workshops/$($w.id)/registrations" -ContentType 'application/json' -Body '{"memberId":"m-1","email":"m1@example.com"}'
Invoke-RestMethod -Uri "http://localhost:3000/workshops/$($w.id)/notifications"
```

**3. Stop the backend** with **Ctrl+C** in its terminal. The confirmation is still `pending` in Postgres.

**4. Make the mock healthy** while the backend is down:

```bash
curl -X PUT localhost:4000/config -H "Content-Type: application/json" -d '{"failureRate":0,"timeoutRate":0}'
```
```powershell
Invoke-RestMethod -Method Put -Uri http://localhost:4000/config -ContentType 'application/json' -Body '{"failureRate":0,"timeoutRate":0}'
```

**5. Start the backend again** with `npm run start:backend`. It logs the backlog, and its first tick delivers it:

```
[server] startup backlog: 1 pending notification(s)
[dispatcher] … registration_confirmation member=m-1 attempt=N -> sent
```

If the backend was killed in the middle of a send rather than between sends, the row is delivered once its lease expires, after at most `LEASE_MS` (30 s).

**6. Confirm the delivery:**

```bash
curl localhost:3000/workshops/$WID/notifications      # status "sent"
curl localhost:4000/deliveries                         # the notification id appears once
```
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/workshops/$($w.id)/notifications"
(Invoke-RestMethod -Uri http://localhost:4000/deliveries).deliveries
```

> In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` or the `Invoke-RestMethod` commands instead.

## Reliability design

This section answers the brief's four questions: lost notifications, retries, duplicate delivery and backend restarts.

### How are lost notifications prevented?

- The notification row is written in the **same database transaction** as the registration or cancellation that causes it. Either both are committed or neither is, so a registration can never be saved without its confirmation, or the other way round.
- The API never calls the notification service, so a slow or failing service cannot cause a notification to be dropped.
- A row is marked `sent` **only after a 2xx response**. A crash, timeout, network error or 5xx leaves it `pending`, and it will be tried again.
- Cancellation inserts one `workshop_cancelled` row per registration using a single `INSERT … SELECT`. A registration locks the workshop row `FOR SHARE` and a cancellation locks it `FOR UPDATE`, so a registration racing a cancellation either:
  - commits first, and the cancellation includes it, or
  - runs after the cancellation, and is rejected with `409`.

### How are retries handled?

- Any non-2xx response, timeout (`AbortSignal.timeout(REQUEST_TIMEOUT_MS)`) or connection error reschedules the row.
- The delay is `min(BACKOFF_MAX_MS, BACKOFF_BASE_MS × 2^attempts)` plus up to 20% random jitter, so retries from many rows don't arrive at the same moment.
- `attempts` and `last_error` are recorded on every try, and you can see them through `GET /workshops/:id/notifications`.
- Delivery keeps retrying until it succeeds. An outage of the notification service only **delays** notifications; it never drops them.

### How is duplicate delivery handled?

- Some duplicate *sending* cannot be avoided. If a request times out, the backend can't tell whether the service processed it, so it has to retry.
- Each notification's UUID is sent as the **`Idempotency-Key`** header, and the key is the same on every retry. The service records each key once, and answers a repeat with `200 { duplicate: true }` without recording it again. The member therefore receives each notification effectively once.
- Duplicate *queueing* is prevented by database constraints:
  - `UNIQUE (workshop_id, member_id)` stops a member registering twice; the second attempt gets `409 ALREADY_REGISTERED` and no notification.
  - `UNIQUE (registration_id, type)` stops the same notification being queued twice.
  - A second cancellation is rejected with `409` and queues nothing.

### What happens when the backend restarts?

- All delivery state is in Postgres, not in memory.
- On startup, the dispatcher polls immediately and delivers the backlog. You can try this with [Scenario C](#scenario-c-backend-restart-manual).
- The dispatcher claims rows with an atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, which sets a lease (`locked_until`). If the process dies in the middle of a send, the lease expires and the row is claimed and sent again. If the earlier send had in fact got through, the idempotency key turns the resend into a harmless duplicate.
- A graceful shutdown (Ctrl+C or SIGTERM) waits for in-progress sends to finish. A hard kill is also safe, because of the lease.

### Failure isolation

- Each notification is an independent row, with its own HTTP request, its own timeout and its own status update. Each batch is sent concurrently using `Promise.allSettled`.
- If one member's notifications keep failing, only that member's row is rescheduled. Other members' notifications in the same workshop, even in the same batch, are delivered normally. Scenario B demonstrates this using `failMemberIds`.

### Failed registrations

- Every rejected registration (`400`, `404`, `409`) is rolled back before the notification insert is committed.
- So a failed registration **never** produces a confirmation notification.

## Known limitations

- **The mock's state is in memory.** Restarting the mock clears both its delivery log and its record of keys it has already seen. A notification that is retried across a mock restart could then be recorded a second time. A real provider would store idempotency keys durably.
- **No ordering between a member's notifications.** A member's confirmation and their cancellation notice are delivered independently. If the confirmation is still being retried when the workshop is cancelled, the cancellation notice may arrive first.
- **No dead-letter queue.** By design, delivery retries forever, with backoff capped at `BACKOFF_MAX_MS`. A notification the service rejects permanently would be retried indefinitely. This is acceptable here because the mock only returns 2xx, 5xx or a timeout.
- **One backend instance.** The claim query (`SKIP LOCKED` plus leases) is safe with several instances, but running more than one is out of scope and has not been demonstrated.
