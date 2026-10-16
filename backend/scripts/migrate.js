// Creates the target database if missing, then applies backend/migrations/*.sql in name order.
// Every migration is idempotent (IF NOT EXISTS), so re-running is safe.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const log = (msg) => console.log(`[migrate] ${msg}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[migrate] DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function ensureDatabase() {
  const target = new URL(databaseUrl);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!dbName) throw new Error('DATABASE_URL must include a database name');

  const maintenance = new URL(databaseUrl);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount > 0) {
      log(`database "${dbName}" already exists`);
    } else {
      // Identifiers cannot be parameterised; escape for safety.
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
      log(`created database "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

async function applyMigrations() {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

try {
  await ensureDatabase();
  await applyMigrations();
  log('done');
} catch (err) {
  console.error(`[migrate] failed: ${err.message}`);
  process.exit(1);
}
