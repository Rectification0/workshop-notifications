// Reads and validates backend configuration from the environment.
// Fails fast with a clear message: the process exits before anything else starts.

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

function requireUrl(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (!raw) fail(`${name} is not set (copy .env.example to .env)`);
  try {
    new URL(raw);
  } catch {
    fail(`${name} is not a valid URL: ${raw}`);
  }
  return raw;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

const config = {
  databaseUrl: requireUrl('DATABASE_URL'),
  port: positiveInt('PORT', 3000),
  notifierUrl: requireUrl('NOTIFIER_URL', 'http://localhost:4000/notify'),
  pollIntervalMs: positiveInt('POLL_INTERVAL_MS', 1000),
  batchSize: positiveInt('BATCH_SIZE', 20),
  requestTimeoutMs: positiveInt('REQUEST_TIMEOUT_MS', 3000),
  leaseMs: positiveInt('LEASE_MS', 30000),
  backoffBaseMs: positiveInt('BACKOFF_BASE_MS', 1000),
  backoffMaxMs: positiveInt('BACKOFF_MAX_MS', 30000),
};

// A claimed row must not be re-claimed while its request can still be in flight.
if (config.leaseMs <= config.requestTimeoutMs) {
  fail(`LEASE_MS (${config.leaseMs}) must be greater than REQUEST_TIMEOUT_MS (${config.requestTimeoutMs})`);
}
if (config.backoffMaxMs < config.backoffBaseMs) {
  fail(`BACKOFF_MAX_MS (${config.backoffMaxMs}) must be >= BACKOFF_BASE_MS (${config.backoffBaseMs})`);
}

export default Object.freeze(config);
