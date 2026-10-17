// Mock Notification Service: stands in for an email/SMS provider. Depending on its config and a
// random roll it delivers, fails (503) or "times out" (delivers, but replies too late). It
// de-duplicates on the Idempotency-Key header, so a retried notification is only recorded once.
// All state is in memory; restarting the mock clears it.
import express from 'express';

function fail(message) {
  console.error(`[mock] ${message}`);
  process.exit(1);
}

function envNumber(name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

const port = envNumber('MOCK_PORT', 4000, { min: 1, max: 65535, integer: true });

const config = {
  failureRate: envNumber('MOCK_FAILURE_RATE', 0.2, { max: 1 }),
  timeoutRate: envNumber('MOCK_TIMEOUT_RATE', 0.2, { max: 1 }),
  timeoutDelayMs: envNumber('MOCK_TIMEOUT_DELAY_MS', 10000, { min: 1, integer: true }),
  failMemberIds: [],
};

// idempotencyKey -> { receivedAt, payload }
const deliveries = new Map();

const log = (outcome, key, payload) =>
  console.log(`[mock] ${outcome} key=${key} member=${payload?.memberId} type=${payload?.type}`);

function record(key, payload) {
  deliveries.set(key, { receivedAt: new Date().toISOString(), payload });
}

const app = express();
app.use(express.json());

app.post('/notify', (req, res) => {
  const key = req.get('Idempotency-Key');
  const payload = req.body;

  // 1. Contract check, not a delivery failure.
  if (!key) {
    log('rejected (missing Idempotency-Key)', key, payload);
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  // 2. Already delivered: acknowledge again without recording a second copy.
  if (deliveries.has(key)) {
    log('duplicate', key, payload);
    return res.status(200).json({ status: 'delivered', duplicate: true });
  }

  // 3. Deterministic per-member failure, for the isolation demo.
  if (config.failMemberIds.includes(payload?.memberId)) {
    log('failed (failMemberIds)', key, payload);
    return res.status(503).json({ error: 'simulated failure for member' });
  }

  // 4. Random behaviour.
  const r = Math.random();
  if (r < config.failureRate) {
    log('failed (simulated)', key, payload);
    return res.status(503).json({ error: 'simulated failure' });
  }
  if (r < config.failureRate + config.timeoutRate) {
    // Processed, but the acknowledgement arrives after the backend has given up: it will retry,
    // and the retry is answered as a duplicate.
    record(key, payload);
    log(`delivered, replying after ${config.timeoutDelayMs}ms (simulated timeout)`, key, payload);
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) res.status(200).json({ status: 'delivered' });
    }, config.timeoutDelayMs);
    return;
  }

  record(key, payload);
  log('delivered', key, payload);
  res.status(200).json({ status: 'delivered' });
});

app.get('/deliveries', (req, res) => {
  const list = [...deliveries].map(([key, d]) => ({ key, ...d }));
  res.json({ count: list.length, deliveries: list });
});

app.get('/config', (req, res) => res.json(config));

// Partial update. Rates are clamped to [0, 1]; values of the wrong type are rejected.
app.put('/config', (req, res) => {
  const body = req.body ?? {};
  const next = {};
  for (const name of ['failureRate', 'timeoutRate']) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'number' || !Number.isFinite(body[name])) {
      return res.status(400).json({ error: `${name} must be a number` });
    }
    next[name] = Math.min(1, Math.max(0, body[name]));
  }
  if (body.timeoutDelayMs !== undefined) {
    if (!Number.isInteger(body.timeoutDelayMs) || body.timeoutDelayMs <= 0) {
      return res.status(400).json({ error: 'timeoutDelayMs must be a positive integer' });
    }
    next.timeoutDelayMs = body.timeoutDelayMs;
  }
  if (body.failMemberIds !== undefined) {
    if (!Array.isArray(body.failMemberIds) || !body.failMemberIds.every((m) => typeof m === 'string')) {
      return res.status(400).json({ error: 'failMemberIds must be an array of strings' });
    }
    next.failMemberIds = [...body.failMemberIds];
  }
  Object.assign(config, next);
  console.log(`[mock] config updated: ${JSON.stringify(config)}`);
  res.json(config);
});

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error('[mock] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app
  .listen(port, () => console.log(`[mock] listening on http://localhost:${port} config=${JSON.stringify(config)}`))
  .on('error', (err) => fail(err.message));
