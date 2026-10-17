// End-to-end demo (design §10). Needs the backend and the mock running:
//   npm run start:mock    npm run start:backend    npm run demo
// Scenario A shows registration and cancellation; Scenario B shows failure, isolation, recovery
// and duplicate suppression. Every check prints PASS or FAIL; any FAIL makes the exit code 1.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:4000';

const HEALTHY = { failureRate: 0, timeoutRate: 0, failMemberIds: [] };

let failures = 0;

function expect(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
  return ok;
}

const step = (msg) => console.log(`\n> ${msg}`);
const heading = (msg) => console.log(`\n=== ${msg} ===`);

// Calls a backend path, or a full URL (used for the mock). Returns { status, body, ms }.
async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `${BACKEND_URL}${path}`;
  const started = performance.now();
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, ms: Math.round(performance.now() - started) };
}

const mock = (method, path, body) => api(method, `${MOCK_URL}${path}`, body);
const setMock = async (patch) => (await mock('PUT', '/config', patch)).body;

// Polls predicate() every 500 ms until it returns a truthy value or the timeout passes.
async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const notifications = async (workshopId) => (await api('GET', `/workshops/${workshopId}/notifications`)).body;

async function createWorkshop(title) {
  const res = await api('POST', '/workshops', { title, organizerId: 'org-demo' });
  expect(`create workshop "${title}" -> 201`, res.status === 201, `status ${res.status}`);
  return res.body;
}

const register = (workshopId, memberId) =>
  api('POST', `/workshops/${workshopId}/registrations`, { memberId, email: `${memberId}@example.com` });

const summary = (rows) =>
  rows.map((n) => `${n.memberId}/${n.type}=${n.status} attempts=${n.attempts}`).join(', ');

async function scenarioA() {
  heading('Scenario A: registration and cancellation');

  step('Set the mock to healthy');
  await setMock(HEALTHY);

  step('Create a workshop');
  const w = await createWorkshop('Demo A: Intro to Go');

  step('Register m-1, m-2 and m-3');
  for (const m of ['m-1', 'm-2', 'm-3']) {
    const res = await register(w.id, m);
    expect(`register ${m} -> 201`, res.status === 201, `status ${res.status}, ${res.ms}ms`);
  }

  step('Register m-1 again');
  const dup = await register(w.id, 'm-1');
  expect('duplicate registration -> 409 ALREADY_REGISTERED', dup.status === 409 && dup.body?.error?.code === 'ALREADY_REGISTERED', `status ${dup.status}`);
  const afterDup = await notifications(w.id);
  expect('still exactly 3 notifications (no confirmation for the duplicate)', afterDup.length === 3, `${afterDup.length} rows`);

  step('Wait until all 3 confirmations are sent');
  const confirmed = await waitFor(async () => {
    const rows = await notifications(w.id);
    return rows.length === 3 && rows.every((n) => n.status === 'sent') && rows;
  });
  expect('3 confirmations sent', !!confirmed, confirmed ? summary(confirmed) : 'timed out');

  step('Cancel the workshop');
  const cancel = await api('POST', `/workshops/${w.id}/cancel`);
  expect('cancel -> 200 with notificationsQueued: 3', cancel.status === 200 && cancel.body?.notificationsQueued === 3, `status ${cancel.status}, queued ${cancel.body?.notificationsQueued}`);

  step('Register m-4 on the cancelled workshop');
  const late = await register(w.id, 'm-4');
  expect('register after cancel -> 409 WORKSHOP_CANCELLED', late.status === 409 && late.body?.error?.code === 'WORKSHOP_CANCELLED', `status ${late.status}`);
  const afterLate = await notifications(w.id);
  expect('no notification for m-4', !afterLate.some((n) => n.memberId === 'm-4'), `${afterLate.length} rows`);

  step('Wait until the 3 cancellation notices are sent');
  const cancelled = await waitFor(async () => {
    const rows = (await notifications(w.id)).filter((n) => n.type === 'workshop_cancelled');
    return rows.length === 3 && rows.every((n) => n.status === 'sent') && rows;
  });
  expect('3 cancellation notices sent', !!cancelled, cancelled ? summary(cancelled) : 'timed out');

  step("Check the mock's deliveries for this workshop");
  const { body: d } = await mock('GET', '/deliveries');
  const mine = d.deliveries.filter((x) => x.payload?.workshopId === w.id);
  const confirmations = mine.filter((x) => x.payload.type === 'registration_confirmation').length;
  const notices = mine.filter((x) => x.payload.type === 'workshop_cancelled').length;
  console.log(`  mock /deliveries: ${mine.length} for this workshop (${confirmations} confirmations, ${notices} cancellations)`);
  expect('mock holds exactly 3 confirmations and 3 cancellations', confirmations === 3 && notices === 3);
}

async function scenarioB() {
  heading('Scenario B: failure, isolation, recovery and duplicate suppression');

  step('Take the mock down (failureRate: 1)');
  await setMock({ ...HEALTHY, failureRate: 1 });

  step('Create a workshop and register m-1 and m-2');
  const w = await createWorkshop('Demo B: Distributed Systems');
  for (const m of ['m-1', 'm-2']) {
    const res = await register(w.id, m);
    expect(`register ${m} -> 201 while the mock is down`, res.status === 201, `${res.ms}ms`);
    expect(`register ${m} responded without waiting for the mock`, res.ms < 1000, `${res.ms}ms`);
  }

  step('Wait for retries: notifications stay pending, attempts grow, lastError is HTTP 503');
  const retrying = await waitFor(async () => {
    const rows = await notifications(w.id);
    return rows.length === 2 && rows.every((n) => n.status === 'pending' && n.attempts >= 2 && n.lastError === 'HTTP 503') && rows;
  });
  expect('both pending with attempts >= 2 and lastError HTTP 503', !!retrying, retrying ? summary(retrying) : 'timed out');

  step('Make the mock healthy, except for m-2 (failMemberIds: ["m-2"])');
  await setMock({ ...HEALTHY, failMemberIds: ['m-2'] });
  const isolated = await waitFor(async () => {
    const rows = await notifications(w.id);
    const byMember = Object.fromEntries(rows.map((n) => [n.memberId, n]));
    return byMember['m-1']?.status === 'sent' && rows;
  });
  const m2 = isolated?.find((n) => n.memberId === 'm-2');
  expect('m-1 sent', !!isolated, isolated ? summary(isolated) : 'timed out');
  expect('m-2 still pending (its failure did not block m-1)', m2?.status === 'pending', m2 ? `m-2 ${m2.status}, lastError ${m2.lastError}` : '');

  step('Clear failMemberIds and wait for m-2 to recover');
  await setMock({ failMemberIds: [] });
  const recovered = await waitFor(async () => {
    const rows = await notifications(w.id);
    return rows.every((n) => n.status === 'sent') && rows;
  }, 45000); // m-2's backoff may have grown towards the 30s cap (+ jitter)
  expect('m-2 sent after recovery', !!recovered, recovered ? summary(recovered) : 'timed out');

  step('Duplicate suppression: the mock processes m-3 but replies too late (timeoutRate: 1)');
  await setMock({ failureRate: 0, timeoutRate: 1 });
  const reg = await register(w.id, 'm-3');
  expect('register m-3 -> 201', reg.status === 201, `status ${reg.status}`);
  const key = reg.body?.confirmation?.notificationId;

  const timedOut = await waitFor(async () => {
    const n = (await notifications(w.id)).find((x) => x.id === key);
    return n && n.attempts >= 1 && n.status === 'pending' && n.lastError?.startsWith('timeout') && n;
  });
  expect('first attempt timed out and m-3 is pending', !!timedOut, timedOut ? `attempts ${timedOut.attempts}, lastError ${timedOut.lastError}` : 'timed out');

  step('Make the mock healthy and wait for the retry');
  await setMock(HEALTHY);
  const delivered = await waitFor(async () => {
    const n = (await notifications(w.id)).find((x) => x.id === key);
    return n?.status === 'sent' && n;
  });
  expect('m-3 sent after retry', !!delivered, delivered ? `attempts ${delivered.attempts}` : 'timed out');

  const { body: d } = await mock('GET', '/deliveries');
  const copies = d.deliveries.filter((x) => x.key === key).length;
  expect(`mock /deliveries holds exactly one entry for key ${key}`, copies === 1, `${copies} entries`);
}

async function main() {
  console.log(`Backend: ${BACKEND_URL}   Mock: ${MOCK_URL}`);
  let original;
  try {
    original = (await mock('GET', '/config')).body;
    await api('GET', '/workshops/00000000-0000-0000-0000-000000000000/notifications'); // reachability check
  } catch (err) {
    console.error(`Cannot reach the backend or the mock (${err.cause?.code ?? err.message}). Start both first:`);
    console.error('  npm run start:mock\n  npm run start:backend');
    process.exitCode = 1;
    return;
  }

  try {
    await scenarioA();
    await scenarioB();
  } catch (err) {
    expect('demo ran without errors', false, err.stack ?? err.message);
  } finally {
    await setMock(original).catch((err) => console.error(`Could not restore the mock config: ${err.message}`));
    console.log(`\nMock config restored: ${JSON.stringify(original)}`);
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
}

await main();
