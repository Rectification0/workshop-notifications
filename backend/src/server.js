// Backend entry point: starts the HTTP API, then the outbox dispatcher, and shuts both down cleanly.
import config from './config.js';
import { pool } from './db.js';
import { app } from './app.js';
import * as dispatcher from './dispatcher.js';

const log = (msg) => console.log(`[server] ${msg}`);

// Rows left pending by a previous run (crash, Ctrl+C, notifier outage) are delivered by the
// dispatcher's first tick; logging the count makes that recovery visible. This query also fails
// fast if the database is unreachable.
let backlog;
try {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE status = 'pending'`);
  backlog = rows[0].n;
} catch (err) {
  console.error(`[server] cannot reach the database: ${err.message}`);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  log(`listening on http://localhost:${config.port}`);
  log(`startup backlog: ${backlog} pending notification(s)`);
  dispatcher.start();
});

server.on('error', (err) => {
  console.error(`[server] ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    log(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  log(`${signal} received, shutting down`);

  // stop() halts scheduling right away; the in-flight tick is awaited after the server closes.
  // A hard kill is also safe: leased rows are re-claimed once their lease expires.
  const dispatcherStopped = dispatcher.stop();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  try {
    await serverClosed;
    await dispatcherStopped;
    await pool.end();
    log('shutdown complete');
    // Let the process exit on its own once fetch's keep-alive sockets close: calling
    // process.exit() while they are closing can trip a libuv assertion on Windows.
    // The unref'd timer only forces the exit if something unexpected keeps the loop alive.
    setTimeout(() => process.exit(0), 10_000).unref();
  } catch (err) {
    console.error(`[server] error during shutdown: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
