import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  db,
  getPool,
  getUserPlan,
  pickResolution,
  tables,
  type Resolution,
  type VariableType,
} from '@pulse/core';
import { parse, uuidParam } from '../lib/http.js';
import { requireOwnedDevice } from './devices.js';
import { requireOwnedVariable } from './variables.js';

const rangeSchema = z.object({
  from: z.union([z.string(), z.number()]).optional(),
  to: z.union([z.string(), z.number()]).optional(),
  maxPoints: z.coerce.number().int().min(10).max(5000).optional().default(600),
});

function parseInstant(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const relative = /^-(\d+)([smhd])$/.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as 's' | 'm' | 'h' | 'd';
    const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return Date.now() - amount * factor;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SeriesPoint {
  t: number;
  v: number | null;
  min?: number | null;
  max?: number | null;
  s?: string | null;
}

export async function querySeries(opts: {
  variableId: string;
  type: VariableType;
  fromMs: number;
  toMs: number;
  maxPoints: number;
}): Promise<{ resolution: Resolution; points: SeriesPoint[] }> {
  const { variableId, type, fromMs, toMs, maxPoints } = opts;
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const pool = getPool();

  // Text variables have no meaningful average, so they always read raw.
  const resolution: Resolution = type === 'string' ? 'raw' : pickResolution(fromMs, toMs);

  if (resolution === 'raw') {
    // time_bucket on the raw table keeps the payload bounded even for a dense
    // window, and LTTB-style decimation is unnecessary once buckets are uniform.
    const bucketMs = Math.max(1000, Math.floor((toMs - fromMs) / maxPoints));
    if (type === 'string') {
      const { rows } = await pool.query<{ t: Date; s: string | null }>(
        `SELECT ts AS t, value_text AS s
           FROM telemetry
          WHERE variable_id = $1 AND ts >= $2 AND ts <= $3
          ORDER BY ts DESC
          LIMIT $4`,
        [variableId, from, to, maxPoints],
      );
      return {
        resolution,
        points: rows.reverse().map((r) => ({ t: r.t.getTime(), v: null, s: r.s })),
      };
    }
    const { rows } = await pool.query<{ t: Date; v: number | null; mn: number | null; mx: number | null }>(
      `SELECT time_bucket(make_interval(secs => $4::double precision / 1000), ts) AS t,
              avg(value_num) AS v,
              min(value_num) AS mn,
              max(value_num) AS mx
         FROM telemetry
        WHERE variable_id = $1 AND ts >= $2 AND ts <= $3
        GROUP BY 1
        ORDER BY 1`,
      [variableId, from, to, bucketMs],
    );
    return {
      resolution,
      points: rows.map((r) => ({ t: r.t.getTime(), v: r.v, min: r.mn, max: r.mx })),
    };
  }

  const view = resolution === '1m' ? 'telemetry_1m' : 'telemetry_1h';
  // Re-bucket rather than LIMIT. A bare `ORDER BY bucket LIMIT n` returns the
  // OLDEST n buckets, so a 24 h window (1440 one-minute buckets, maxPoints 600)
  // used to stop plotting ~10 h in, and a 30-day window silently dropped its
  // newest days. Widening the bucket keeps the whole range and honours maxPoints.
  const viewBucketMs = resolution === '1m' ? 60_000 : 3_600_000;
  const rollupBucketMs = Math.max(viewBucketMs, Math.floor((toMs - fromMs) / maxPoints));
  const { rows } = await pool.query<{ t: Date; v: number | null; mn: number | null; mx: number | null }>(
    `SELECT time_bucket(make_interval(secs => $4::double precision / 1000), bucket) AS t,
            avg(avg_value) AS v,
            min(min_value) AS mn,
            max(max_value) AS mx
       FROM ${view}
      WHERE variable_id = $1 AND bucket >= $2 AND bucket <= $3
      GROUP BY 1
      ORDER BY 1`,
    [variableId, from, to, rollupBucketMs],
  );
  return {
    resolution,
    points: rows.map((r) => ({ t: r.t.getTime(), v: r.v, min: r.mn, max: r.mx })),
  };
}

export const telemetryRoutes: FastifyPluginAsync = async (app) => {
  /** Instant dashboard load: every current value for a device in one round trip. */
  app.get('/devices/:id/state', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const device = await requireOwnedDevice(auth.id, id);

    const rows = await db
      .select({
        variableId: tables.variables.id,
        key: tables.variables.key,
        label: tables.variables.label,
        type: tables.variables.type,
        unit: tables.variables.unit,
        writable: tables.variables.writable,
        color: tables.variables.color,
        // Needed by any client rendering a control: without the range there is
        // no way to distinguish a relay from a 0-255 setpoint, and guessing
        // wrong means writing 47 to something that only understands 0 and 1.
        minValue: tables.variables.minValue,
        maxValue: tables.variables.maxValue,
        ts: tables.variableState.ts,
        valueNum: tables.variableState.valueNum,
        valueText: tables.variableState.valueText,
      })
      .from(tables.variables)
      .leftJoin(tables.variableState, eq(tables.variableState.variableId, tables.variables.id))
      .where(eq(tables.variables.deviceId, id))
      .orderBy(tables.variables.sortOrder);

    return { device, state: rows };
  });

  app.get('/variables/:id/series', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const query = parse(rangeSchema, req.query);
    const variable = await requireOwnedVariable(auth.id, id);
    const plan = await getUserPlan(auth.id);

    const toMs = parseInstant(query.to, Date.now());
    const retentionFloor = Date.now() - plan.retentionDays * 86_400_000;
    const fromMs = Math.max(parseInstant(query.from, toMs - 3_600_000), retentionFloor);

    const result = await querySeries({
      variableId: id,
      type: variable.type as VariableType,
      fromMs,
      toMs: Math.max(toMs, fromMs + 1000),
      maxPoints: query.maxPoints,
    });

    return {
      variable: { id: variable.id, key: variable.key, label: variable.label, type: variable.type, unit: variable.unit, color: variable.color },
      from: fromMs,
      to: toMs,
      ...result,
    };
  });

  /** Multi-series fetch so a dashboard renders in one request instead of nine. */
  app.get('/devices/:id/series', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const query = parse(
      rangeSchema.extend({ variableIds: z.string().optional() }),
      req.query,
    );
    await requireOwnedDevice(auth.id, id);
    const plan = await getUserPlan(auth.id);

    const wanted = query.variableIds ? new Set(query.variableIds.split(',').map((s) => s.trim())) : null;
    const variables = (
      await db
        .select({
          id: tables.variables.id,
          key: tables.variables.key,
          label: tables.variables.label,
          type: tables.variables.type,
          unit: tables.variables.unit,
          color: tables.variables.color,
        })
        .from(tables.variables)
        .where(eq(tables.variables.deviceId, id))
        .orderBy(tables.variables.sortOrder)
    ).filter((v) => !wanted || wanted.has(v.id));

    const toMs = parseInstant(query.to, Date.now());
    const retentionFloor = Date.now() - plan.retentionDays * 86_400_000;
    const fromMs = Math.max(parseInstant(query.from, toMs - 3_600_000), retentionFloor);

    // Bounded fan-out. A device can carry 16+ variables and the pool holds 12
    // connections, so an unbounded Promise.all would let one dashboard load
    // monopolise the pool and stall every other request behind it.
    const series = await mapWithLimit(variables, 4, async (variable) => ({
      variable,
      ...(await querySeries({
        variableId: variable.id,
        type: variable.type as VariableType,
        fromMs,
        toMs: Math.max(toMs, fromMs + 1000),
        maxPoints: query.maxPoints,
      })),
    }));

    return { from: fromMs, to: toMs, series };
  });
};
