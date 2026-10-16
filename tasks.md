# tasks.md — Implementation Plan

Implements `specs.md` using `design.md`. Do the tasks in order. Each task lists the requirements it covers and how to check that it is done.

## T0 — Prerequisites
- [x] Confirm Node 24 and PostgreSQL 18 are available (service `postgresql-x64-18` is running on `localhost:5432`).
- [x] Get the password for the `postgres` user. It goes into `.env`.

**Done when:** `node -v` shows v24.x, and you can connect to Postgres with the credentials.

## T1 — Project scaffold (design §3, §4)
- [x] Create `package.json`:
  - `"type": "module"`
  - `"engines": { "node": ">=24" }`
  - dependencies: `express`, `pg`
  - scripts: `migrate`, `start:backend`, `start:mock`, `demo`
- [x] Create `.env.example` with every variable in design §4.
- [x] Copy it to `.env` (not committed) and fill in `DATABASE_URL`.
- [x] Create the directory layout from design §3.
- [x] Run `npm install`.

**Done when:** `npm install` succeeds.

## T2 — Database schema and migration (design §5) — FR-3, FR-5, FR-6
- [x] Write `backend/migrations/001_init.sql` exactly as in design §5. It covers:
  - the tables
  - `uq_registration_member`
  - `uq_notification_per_registration`
  - the partial index
- [x] Write `backend/scripts/migrate.js`:
  - create the `workshops` DB if it is missing (via the `postgres` DB)
  - apply the `*.sql` files in name order
  - log each step
- [x] Run `npm run migrate` twice.

**Done when:** both runs succeed, and the tables exist in DB `workshops`.

## T3 — Backend config and DB helpers (design §4, §6.6)
- [x] `config.js`:
  - read env and convert numbers
  - validate the values, failing fast with a clear message
  - enforce `LEASE_MS > REQUEST_TIMEOUT_MS`
- [x] `db.js`:
  - a `pg.Pool` built from `DATABASE_URL`
  - `withTransaction(fn)`: BEGIN, then `fn(client)`, then COMMIT. On any throw, ROLLBACK. Always release the client.
- [x] Define the `AppError(status, code, message)` class.

**Done when:** the backend refuses to start when `DATABASE_URL` is missing.

## T4 — Express app and workshop creation (design §6.1, §6.6) — FR-1
- [x] `app.js`:
  - `express.json()`
  - mount the routes
  - error middleware: `AppError` → its own status and code, malformed JSON → 400, anything else → 500 and logged
- [x] `POST /workshops`: validate the body, insert the row, return 201 with the camelCase body.

**Done when:**
- a valid request returns 201 with `status: "active"`
- a missing `title` returns 400

## T5 — Registration endpoint (design §6.2) — FR-2, FR-3, FR-4, FR-5
- [x] Validate `memberId`, `email` and the UUID in `:id`. An invalid UUID returns 404.
- [x] Inside `withTransaction`:
  - `SELECT ... FOR SHARE`
  - 404 if the workshop is missing, 409 `WORKSHOP_CANCELLED` if it is cancelled
  - insert the registration
  - map `23505` on `uq_registration_member` to 409 `ALREADY_REGISTERED`
  - insert the `registration_confirmation` outbox row with the payload from design §6.5
- [x] Return 201 right after commit, with `registration` and `confirmation`. Make no outbound HTTP call.

**Done when:**
- a valid request returns 201
- a repeat returns 409
- an unknown workshop returns 404
- `notifications` has exactly one row per successful registration and none for failed ones

## T6 — Cancellation endpoint (design §6.3) — FR-9
- [ ] Inside `withTransaction`:
  - `SELECT ... FOR UPDATE`
  - 404 if the workshop is missing, 409 `WORKSHOP_ALREADY_CANCELLED` if it is already cancelled
  - set the workshop to `cancelled`
  - run `INSERT ... SELECT` to add one `workshop_cancelled` row per registration
- [ ] Return 200 with `notificationsQueued`.

**Done when:**
- with N registrations, cancelling queues N rows
- a second cancel returns 409 and adds no rows
- registering after the cancel returns 409

## T7 — Notifications read endpoint (design §6.4) — D-1, D-2 observability
- [ ] `GET /workshops/:id/notifications`: 404 if the workshop is unknown. Otherwise return the rows in the camelCase shape, ordered by `created_at`.

**Done when:** it returns the rows created in T5 and T6.

## T8 — Dispatcher (design §7) — FR-5, FR-6, FR-7, FR-8, FR-10
- [ ] `dispatcher.js` exports `start()` and `stop()`:
  - `start()` runs a tick immediately, then schedules ticks one after another with `setTimeout` (no overlap)
  - `stop()` cancels the timer and awaits the in-flight tick
- [ ] Tick: run the atomic claim query from design §7.2, then send every row with `Promise.allSettled`.
- [ ] Send:
  - `fetch` with the `Idempotency-Key: row.id` header and the stored `payload`
  - `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
- [ ] Success (2xx): mark the row `sent`.
- [ ] Anything else: run the retry update from design §7.4, with exponential backoff, jitter and the cap. Record `last_error`.
- [ ] Catch and log DB errors per row, so a single failure never rejects the tick. The lease covers recovery.
- [ ] Log each attempt, e.g. `[dispatcher] <id> <type> member=<m> attempt=<n> -> sent | retry in <ms> (<error>)`.

**Done when:** with the mock stopped:
- the rows stay `pending`
- `attempts` grows and `next_attempt_at` spaces out
- starting the mock delivers them

## T9 — Server bootstrap and shutdown (design §7.1, §7.5) — FR-6
- [ ] `server.js` starts the Express server, then `dispatcher.start()`.
- [ ] On SIGINT or SIGTERM:
  - stop the dispatcher
  - close the server
  - `pool.end()`
  - exit
- [ ] Log the startup backlog as the number of pending rows.

**Done when:** after a Ctrl+C and restart, pending rows are delivered without any new request.

## T10 — Mock Notification Service (design §8) — FR-10, FR-11
- [ ] `mock-notifier/src/server.js`: Express app on `MOCK_PORT`, with in-memory `deliveries` and `config` taken from env.
- [ ] `POST /notify`, in this order:
  1. missing key → 400
  2. key already delivered → 200 `duplicate: true`
  3. member in `failMemberIds` → 503
  4. random roll:
     - failure → 503, nothing recorded
     - timeout → record, then reply 200 after `timeoutDelayMs`
     - otherwise → record and reply 200
- [ ] `GET /deliveries`, `GET /config`, and `PUT /config` (partial update, rates clamped to [0, 1]).
- [ ] Log every outcome.

**Done when:**
- with `failureRate: 1` it always returns 503
- with `timeoutRate: 1` the backend logs timeouts, but `/deliveries` holds the key once
- a repeated key returns `duplicate: true`

## T11 — Demo script (design §10) — D-1, D-2
- [ ] `demo/demo.js` includes:
  - helpers: `api(method, path, body)` and `waitFor(predicate, timeoutMs=30000)`, which polls every 500 ms
  - an `expect` that prints PASS or FAIL and sets a non-zero exit code on failure
- [ ] Scenario A (registration and cancellation) and Scenario B (failure, isolation, recovery and duplicate suppression), exactly as in design §10.
- [ ] Always restore the mock config at the end, using `finally`.

**Done when:** `npm run demo` (with the backend and mock running) prints all PASS and exits 0.

## T12 — README (design §9, §10) — D-3, D-4
- [ ] Prerequisites: Node 24 and PostgreSQL. Setup: copy `.env.example` to `.env`, set the password, run `npm install` and `npm run migrate`.
- [ ] Running: `npm run start:mock` and `npm run start:backend` in two terminals, then `npm run demo`.
- [ ] An API reference table covering the backend endpoints and the mock endpoints.
- [ ] Scenario C manual restart walkthrough, with `curl` and PowerShell `Invoke-RestMethod` commands.
- [ ] A "Reliability design" section that answers the brief's four questions (lost notifications, retries, duplicate delivery, backend restarts), taken from design §9. Also add a short note on failure isolation and on failed registrations.
- [ ] Known limitations:
  - the mock's state is in memory
  - a confirmation and a cancellation notice for the same member are independent, so their arrival order is not guaranteed

**Done when:** someone new can follow the README from a clean checkout to a passing demo.

## T13 — Final verification against the specs
Run through specs.md §6 acceptance criteria 1–9 and tick each one:
- [ ] AC1 Create workshop
- [ ] AC2 Register while the mock is down still returns 201 quickly
- [ ] AC3 Duplicate registration gives 409, with a single confirmation
- [ ] AC4 404 / 409 / 400 registrations create no notification
- [ ] AC5 Pending rows retry, then all are `sent` once the mock is healthy
- [ ] AC6 Restart recovery (Scenario C)
- [ ] AC7 Per-member failure isolation
- [ ] AC8 Cancellation notifies everyone exactly once
- [ ] AC9 Timeout plus retry gives a single delivery at the mock
- [ ] Confirm nothing outside specs.md §7 (out of scope) was added.
