import pg from 'pg';
import config from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// An idle client can error (e.g. Postgres restarts); log it instead of crashing the process.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// Runs fn(client) inside BEGIN/COMMIT. Any throw rolls back and is re-thrown.
export async function withTransaction(fn) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Connection is in an unknown state: destroy it rather than return it to the pool.
      releaseError = rollbackErr;
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}
