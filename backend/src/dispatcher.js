// Outbox dispatcher: claims due notification rows, sends each one to the notification service,
// and records the outcome. A row is only marked 'sent' after a 2xx; anything else is retried
// with capped exponential backoff, forever, so every queued notification is eventually delivered.
import config from './config.js';
import { pool } from './db.js';

const log = (msg) => console.log(`[dispatcher] ${msg}`);

let running = false;
let timer = null;
let inFlight = null;

// Atomically lease up to BATCH_SIZE due rows. SKIP LOCKED keeps concurrent claimers apart, and the
// lease stops a row being re-claimed mid-send; if this process dies, the lease expires and the row
// is picked up again.
const CLAIM_SQL = `
  UPDATE notifications
  SET locked_until = now() + $1 * interval '1 millisecond'
  WHERE id IN (
    SELECT id FROM notifications
    WHERE status = 'pending'
      AND next_attempt_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY next_attempt_at
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, type, member_id, payload, attempts`;

const MARK_SENT_SQL = `
  UPDATE notifications
  SET status = 'sent', sent_at = now(), attempts = attempts + 1, locked_until = NULL, last_error = NULL
  WHERE id = $1`;

const MARK_RETRY_SQL = `
  UPDATE notifications
  SET attempts = attempts + 1, last_error = $2,
      next_attempt_at = now() + $3 * interval '1 millisecond', locked_until = NULL
  WHERE id = $1`;

// min(max, base * 2^previousAttempts), plus up to 20% jitter so retries don't arrive in lockstep.
function backoffMs(previousAttempts) {
  const base = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** previousAttempts);
  return Math.round(base + Math.random() * base * 0.2);
}

function describeError(err) {
  if (err.name === 'TimeoutError') return `timeout after ${config.requestTimeoutMs}ms`;
  // Undici reports connection failures as "fetch failed" with the real reason in err.cause.
  return err.cause?.code ?? err.cause?.message ?? err.message;
}

// Returns null on successful delivery, or a short error description.
async function send(row) {
  try {
    const res = await fetch(config.notifierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': row.id },
      body: JSON.stringify(row.payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    await res.arrayBuffer(); // drain the body so the connection can be reused
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return describeError(err);
  }
}

// Each row is delivered and recorded independently, so one member's failure never affects another.
async function deliver(row) {
  const attempt = row.attempts + 1;
  const prefix = `${row.id} ${row.type} member=${row.member_id} attempt=${attempt}`;
  const error = await send(row);
  try {
    if (error === null) {
      await pool.query(MARK_SENT_SQL, [row.id]);
      log(`${prefix} -> sent`);
    } else {
      const delay = backoffMs(row.attempts);
      await pool.query(MARK_RETRY_SQL, [row.id, error, delay]);
      log(`${prefix} -> retry in ${delay}ms (${error})`);
    }
  } catch (dbErr) {
    // The row keeps its lease and is retried once the lease expires, so nothing is lost.
    console.error(`[dispatcher] ${prefix} -> could not record outcome: ${dbErr.message}`);
  }
}

async function tick() {
  let rows;
  try {
    ({ rows } = await pool.query(CLAIM_SQL, [config.leaseMs, config.batchSize]));
  } catch (err) {
    console.error(`[dispatcher] claim failed: ${err.message}`);
    return;
  }
  await Promise.allSettled(rows.map(deliver));
}

async function loop() {
  timer = null;
  inFlight = tick();
  await inFlight;
  inFlight = null;
  // The next tick is scheduled only after this one finishes, so ticks never overlap.
  if (running) timer = setTimeout(loop, config.pollIntervalMs);
}

// Runs a tick immediately (delivering any backlog left from before a restart), then keeps polling.
export function start() {
  if (running) return;
  running = true;
  log(`started (poll ${config.pollIntervalMs}ms, batch ${config.batchSize}, timeout ${config.requestTimeoutMs}ms)`);
  loop();
}

// Stops scheduling ticks and waits for the in-flight one, if any, to finish.
export async function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) await inFlight;
  log('stopped');
}
