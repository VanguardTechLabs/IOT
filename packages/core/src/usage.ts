import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { db, getPool } from './db/index.js';
import { plans, usageCounters, users } from './db/schema.js';
import { createLogger } from './logger.js';

const log = createLogger('usage');

/**
 * Monthly data allowance.
 *
 * Each plan may write a fixed number of telemetry rows per calendar month.
 * `min_interval_s` says how fast a device MAY report; this is what actually caps
 * total usage, and it is the limit a customer notices.
 *
 * Agreed behaviour: warn at 80%, and at 100% stop accepting new telemetry until
 * the next month. Stored history stays readable and the panel keeps working —
 * nobody loses data or access, they just stop adding to it.
 */

/** First day of the current month, UTC, as the `date` column stores it. */
export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Redis key holding "this user is over quota".
 *
 * The check runs on every single uplink, so it cannot be a database round trip.
 * The writer sets this when a flush crosses the limit and clears it when a new
 * month starts; the TTL is a backstop so a lost clear cannot block someone
 * indefinitely.
 */
function blockedKey(userId: string): string {
  return `pulse:quota:blocked:${userId}`;
}

const BLOCK_TTL_S = 40 * 24 * 3600; // comfortably longer than any month

export async function isOverQuota(redis: Redis, userId: string): Promise<boolean> {
  try {
    return (await redis.exists(blockedKey(userId))) === 1;
  } catch (err) {
    // A Redis failure must not stop telemetry. Failing open loses a little
    // enforcement accuracy; failing closed would take the whole platform down.
    log.warn({ err: (err as Error).message }, 'quota check failed, allowing');
    return false;
  }
}

export async function setOverQuota(redis: Redis, userId: string, over: boolean): Promise<void> {
  try {
    if (over) await redis.set(blockedKey(userId), '1', 'EX', BLOCK_TTL_S);
    else await redis.del(blockedKey(userId));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not update quota flag');
  }
}

export interface UsageSnapshot {
  month: string;
  datapoints: number;
  limit: number;
  /** 0–1, capped at 1 so a UI meter never overflows. */
  fraction: number;
  warned: boolean;
  blocked: boolean;
}

/** What the account page shows. Reads the counter, never the hypertable. */
export async function getUsage(userId: string): Promise<UsageSnapshot> {
  const month = currentMonth();

  const rows = await db
    .select({
      datapoints: usageCounters.datapoints,
      warnedAt: usageCounters.warnedAt,
      blockedAt: usageCounters.blockedAt,
      limit: plans.monthlyDatapoints,
    })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .leftJoin(
      usageCounters,
      and(eq(usageCounters.userId, users.id), eq(usageCounters.month, month)),
    )
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error('user not found');

  const datapoints = Number(row.datapoints ?? 0);
  const limit = Number(row.limit);

  return {
    month,
    datapoints,
    limit,
    fraction: limit > 0 ? Math.min(1, datapoints / limit) : 0,
    warned: row.warnedAt !== null,
    blocked: row.blockedAt !== null,
  };
}

export interface QuotaOutcome {
  userId: string;
  datapoints: number;
  limit: number;
  /** True only on the flush that crosses 80%, so a warning is sent once. */
  justWarned: boolean;
  /** True only on the flush that crosses 100%. */
  justBlocked: boolean;
  over: boolean;
}

const WARN_AT = 0.8;

/**
 * Adds this flush's rows to the month's counter and reports where that leaves
 * each user.
 *
 * One statement for all users in the batch. The `justWarned` / `justBlocked`
 * flags come from setting warned_at / blocked_at only when they are still null,
 * so crossing a threshold is reported exactly once however many flushes follow.
 */
export async function recordUsage(
  counts: Map<string, number>,
  now = new Date(),
): Promise<QuotaOutcome[]> {
  if (counts.size === 0) return [];
  const month = currentMonth(now);

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 0;
  for (const [userId, points] of counts) {
    const b = i * 2;
    placeholders.push(`($${b + 1}::uuid, $${b + 2}::bigint)`);
    values.push(userId, points);
    i += 1;
  }
  values.push(month);
  const monthParam = `$${values.length}`;

  // The raw pool rather than db.execute: this is a parameterised statement, and
  // drizzle's execute() takes the SQL only.
  const { rows } = await getPool().query<{
    user_id: string;
    datapoints: string | number;
    limit_points: string | number;
    warned_now: boolean;
    blocked_now: boolean;
  }>(
    `
      WITH batch(user_id, points) AS (VALUES ${placeholders.join(',')}),
      upserted AS (
        INSERT INTO usage_counters (user_id, month, datapoints, updated_at)
        SELECT b.user_id, ${monthParam}::date, b.points, now() FROM batch b
        ON CONFLICT (user_id, month) DO UPDATE
          SET datapoints = usage_counters.datapoints + EXCLUDED.datapoints,
              updated_at = now()
        RETURNING user_id, datapoints, warned_at, blocked_at
      )
      SELECT u.user_id,
             u.datapoints,
             p.monthly_datapoints AS limit_points,
             (u.warned_at  IS NULL AND u.datapoints >= p.monthly_datapoints * ${WARN_AT}) AS warned_now,
             (u.blocked_at IS NULL AND u.datapoints >= p.monthly_datapoints)              AS blocked_now
        FROM upserted u
        JOIN users usr ON usr.id = u.user_id
        JOIN plans p   ON p.id  = usr.plan_id
    `,
    values,
  );

  const outcomes: QuotaOutcome[] = rows.map((r) => {
    const datapoints = Number(r.datapoints);
    const limit = Number(r.limit_points);
    return {
      userId: r.user_id,
      datapoints,
      limit,
      justWarned: r.warned_now === true,
      justBlocked: r.blocked_now === true,
      over: datapoints >= limit,
    };
  });

  // Stamp the thresholds so each is reported once and never again this month.
  const warned = outcomes.filter((o) => o.justWarned).map((o) => o.userId);
  const blocked = outcomes.filter((o) => o.justBlocked).map((o) => o.userId);

  if (warned.length > 0) {
    await db
      .update(usageCounters)
      .set({ warnedAt: now })
      .where(and(eq(usageCounters.month, month), sql`${usageCounters.userId} = ANY(${warned})`));
  }
  if (blocked.length > 0) {
    await db
      .update(usageCounters)
      .set({ blockedAt: now })
      .where(and(eq(usageCounters.month, month), sql`${usageCounters.userId} = ANY(${blocked})`));
  }

  return outcomes;
}
