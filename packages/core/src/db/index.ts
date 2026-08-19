import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

// `bigint` and `numeric` come back as strings by default; telemetry counters and
// aggregates are always safely within Number range here, so parse them eagerly.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

let poolRef: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!poolRef) {
    poolRef = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: Number.parseInt(process.env.PG_POOL_MAX ?? '12', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: process.env.SERVICE_NAME ?? 'pulse',
    });
    poolRef.on('error', (err) => {
      // Idle-client errors must not crash the process; the pool reconnects.
      console.error('[pg] idle client error', err.message);
    });
  }
  return poolRef;
}

export type Database = NodePgDatabase<typeof schema>;

let drizzleRef: Database | null = null;

function getDb(): Database {
  if (!drizzleRef) drizzleRef = drizzle(getPool(), { schema, casing: 'snake_case' });
  return drizzleRef;
}

/**
 * Lazily constructed so that importing this package for its pure helpers — casting,
 * type inference, credential hashing, the test suite — does not require a
 * DATABASE_URL or open a connection pool. The first actual query builds both.
 */
export const db: Database = new Proxy({} as Database, {
  get: (_target, prop) => {
    const instance = getDb() as unknown as Record<string | symbol, unknown>;
    const value = instance[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(instance) : value;
  },
});

export async function waitForDatabase(retries = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await getPool().query('SELECT 1');
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function closeDatabase(): Promise<void> {
  if (poolRef) {
    await poolRef.end();
    poolRef = null;
  }
}

export * as tables from './schema.js';
export { schema };
