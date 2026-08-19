import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, waitForDatabase, closeDatabase } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('migrate');

// dist/db/migrate.js -> packages/core/migrations
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const NO_TX = '-- pulse:no-transaction';
const SPLIT = '-- pulse:split';

/** Arbitrary but fixed: "PULS" as an int32, namespacing this lock to Pulse. */
const MIGRATION_LOCK_ID = 1347634515;

export async function runMigrations(): Promise<void> {
  await waitForDatabase();
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // The API and the ingest worker boot together and both migrate. A session-level
  // advisory lock serialises them, so the second one waits and then finds every
  // file already applied instead of racing to run the same DDL twice.
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

  try {
    await applyPending(pool);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    lockClient.release();
  }
}

async function applyPending(pool: ReturnType<typeof getPool>): Promise<void> {
  // Read the applied set *after* taking the lock — reading it earlier would let a
  // racing process apply a file between the read and the write.
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    log.info({ file }, 'applying migration');

    try {
      if (sql.includes(NO_TX)) {
        // TimescaleDB refuses continuous aggregates and a few policy calls inside a
        // transaction block, so those files run statement-by-statement.
        const statements = sql
          .split(SPLIT)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      } else {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      }
      log.info({ file }, 'migration applied');
    } catch (err) {
      if (!sql.includes(NO_TX)) await client.query('ROLLBACK').catch(() => undefined);
      log.error({ file, err: (err as Error).message }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  log.info({ count: files.length }, 'database up to date');
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  runMigrations()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err: err.message }, 'migrations aborted');
      process.exit(1);
    });
}
