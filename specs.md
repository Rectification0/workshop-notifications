# specs.md — Workshop Registration and Notifications (GDG Backend Task 2)

Source of truth: `GDG_Backend_Task_2_Workshop_Notifications_Functionality.pdf`.
This spec covers exactly the functionality in that brief. Every requirement below is traced to a section of the brief (§n).

## 1. Purpose (§1)

Build two services:

1. **Registration backend**: organizers create workshops, members register, and organizers cancel workshops.
2. **Mock notification service**: a mock HTTP service. It sometimes returns an error or times out. A successful response means the notification was delivered.

Every successful registration must eventually produce a confirmation. Cancelling a workshop must notify every registered member.

## 2. Decisions made with the user

| Topic | Decision |
|---|---|
| Stack | Node.js 24 + Express (both services) |
| Database | PostgreSQL 18 (already running on `localhost:5432`), new database `workshops` |
| DB access | `pg` (node-postgres) with raw SQL migrations |
| Reliable delivery | Transactional outbox, plus a dispatcher worker that runs inside the backend process |
| Identity | Plain IDs in request bodies, no authentication |
| Duplicate delivery | A stable idempotency key on each notification; the mock service de-duplicates on it |
| Running | Locally via npm scripts (two Node processes) |
| Demonstration | A scripted demo (`npm run demo`) plus a README walkthrough. The backend-restart scenario is manual. |

## 3. Actors

- **Organizer**: creates and cancels workshops. Identified by an `organizerId` string. No auth.
- **Member**: registers for workshops. Identified by a `memberId` string, plus an `email` to address the notification. No auth.

## 4. Functional requirements

### FR-1 Create workshop (§2, §3 Registration)
- An organizer can create a workshop with a `title` and an `organizerId`.
- A new workshop has status `active`.

### FR-2 Register member (§2, §3 Registration)
- A member can register for an `active` workshop by giving `memberId` and `email`.
- Registration fails if:
  - the workshop does not exist (404), or
  - the workshop is cancelled (409), or
  - the request is invalid (400), or
  - the member is already registered for that workshop (FR-3).

### FR-3 One registration per member per workshop (§2, §3 Registration)
- A second registration by the same `memberId` for the same workshop is rejected with 409.
- The database enforces this, so it holds even when two requests arrive at the same time.

### FR-4 Registration does not wait for notification (§2, §3 Registration)
- The registration response is returned as soon as the registration is committed.
- The response never waits for the mock notification service. Registration succeeds even if the mock service is down.

### FR-5 Confirmation for every successful registration, and only those (§2, §3 Notification delivery)
- Every successful registration eventually produces exactly one confirmation notification to the mock service. "Exactly one" means effectively-once: see FR-10.
- A failed registration produces no confirmation. This covers duplicate, validation error, unknown workshop and cancelled workshop.

### FR-6 Survive backend restart (§2, §3 Persistence and recovery)
- Once the registration is saved, its confirmation is still sent even if the backend restarts before delivery. The restart may be a crash or a normal stop.

### FR-7 Retry when the mock service is unavailable (§2, §3 Notification delivery)
- Delivery is retried with backoff when the mock service:
  - returns a non-2xx response, or
  - times out, or
  - cannot be reached.
- Retries continue until a successful response is received. There is no terminal "give up" state, because the brief requires *eventual* delivery.

### FR-8 Failure isolation (§2, §3 Failure isolation)
- A failed delivery to one member never blocks, delays or aborts delivery attempts to other members.

### FR-9 Cancel workshop notifies all registered members (§2, §3 Cancellation)
- An organizer can cancel an `active` workshop.
- Cancelling creates one cancellation notification for every member registered at that time. Each one goes through the same reliable delivery (FR-6, FR-7, FR-8).
- Cancelling a workshop that is already cancelled returns 409 and creates no new notifications.

### FR-10 Duplicate delivery handling (§5, "explain duplicate delivery")
- Each notification has a stable ID. It is sent as the `Idempotency-Key` header and stays the same on every retry.
- The mock service treats a repeated key as already delivered. It returns success without recording the notification a second time.

### FR-11 Mock notification service (§2, §4)
- An HTTP endpoint that accepts a notification and, depending on configuration and randomness, does one of three things:
  - returns success (2xx), which counts as delivered, or
  - returns an error (5xx), or
  - times out (responds only after the backend's request timeout has passed).
- Failure and timeout behaviour can be configured, so failure and recovery can be demonstrated on demand.
- No real email or SMS integration.

## 5. Demonstration and submission requirements (§5)

| ID | Requirement | Satisfied by |
|---|---|---|
| D-1 | Demonstrate registration and workshop cancellation | `npm run demo` (scenario A) |
| D-2 | Demonstrate notification failure and recovery | `npm run demo` (scenario B), plus the README manual restart walkthrough (scenario C) |
| D-3 | Source code and clear run instructions | `README.md` |
| D-4 | Explain how the design handles lost notifications, retries, duplicate delivery and backend restarts | `README.md` section "Reliability design", based on `design.md` §7 |

Two read-only endpoints exist only so the demonstrations (D-1, D-2) can be observed:

- the backend's `GET /workshops/:id/notifications`
- the mock's `GET /deliveries`

## 6. Acceptance criteria

1. `POST /workshops` returns 201 with an `active` workshop.
2. `POST /workshops/:id/registrations` returns 201 quickly, even while the mock is set to fail 100% of requests.
3. Registering the same member twice for the same workshop returns 409. Only one confirmation is ever delivered for that member and workshop.
4. Registering for a missing workshop (404), a cancelled workshop (409), or with an invalid body (400) creates no notification row.
5. With the mock failing 100%, confirmations stay `pending` and `attempts` keeps increasing. After the mock is set healthy, they all become `sent`.
6. Restart test, in this order:
   1. Set the mock to fail 100%.
   2. Register.
   3. Stop the backend.
   4. Set the mock healthy.
   5. Start the backend.

   Result: the confirmation is delivered without any new request.
7. If the mock is set to fail one specific member, notifications to the other members of the same workshop are still delivered.
8. `POST /workshops/:id/cancel` returns 200. Every registered member eventually receives exactly one cancellation notification at the mock.
9. A timed-out request that the mock actually processed, followed by a retry, appears only once in the mock's `GET /deliveries`.

## 7. Out of scope (§6 and "nothing more")

- Real email or SMS integration.
- A frontend.
- Authentication and authorization.
- Workshop editing, deletion, capacity, scheduling or listing.
- Unregistering.
- Message brokers.
- Docker or containerisation.
- Multiple backend instances. The design is safe for them, but they are not required or demonstrated.
- Dead-letter queues or giving up on delivery.
