import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';
import { to as copyTo } from 'pg-copy-streams';
import { eq } from 'drizzle-orm';
import { db, getPool, getUserPlan, isValidTimeZone, tables } from '@pulse/core';
import { badRequest, parse, uuidParam } from '../lib/http.js';
import { requireOwnedDevice } from './devices.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const exportSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  variableIds: z.string().optional(),
  /**
   * wide — one column per variable, one row per reporting cycle (the default)
   * long — one row per reading, with a `variable` column
   *
   * Wide is what a spreadsheet user expects and what the client asked for. It is
   * only possible because the wire contract sends every variable in one message,
   * so all of a cycle's values share a single timestamp and GROUP BY ts produces
   * exactly one row per cycle rather than a sparse grid.
   */
  format: z.enum(['wide', 'long']).optional().default('wide'),
});

/** Renders a stored value back to its wire form, whatever the declared type. */
const VALUE_EXPR = `CASE v.type
                 WHEN 'string' THEN t.value_text
                 WHEN 'bool'   THEN CASE WHEN t.value_num >= 0.5 THEN '1' ELSE '0' END
                 WHEN 'int'    THEN trunc(t.value_num)::bigint::text
                 ELSE t.value_num::text
               END`;

/**
 * Quotes a variable key as a SQL identifier for the wide header row.
 * variableKeySchema already forbids a double quote, so the doubling below is
 * belt-and-braces — but this string is interpolated into a COPY statement, which
 * takes no bind parameters, so it does not get to rely on that.
 */
function quoteIdent(key: string): string {
  return `"${key.replace(/"/g, '""')}"`;
}

/** The three columns every wide export starts with. */
const FIXED_COLUMNS = ['timestamp_utc', 'timestamp_local', 'timezone'];

/**
 * A variable may legitimately be called "timezone". Postgres is happy to emit two
 * columns with the same header, so the CSV would not error — it would just be
 * quietly ambiguous in a spreadsheet. Suffix the variable's column instead.
 */
function csvColumnName(key: string): string {
  return FIXED_COLUMNS.includes(key.toLowerCase()) ? `${key}_value` : key;
}

/** COPY does not take bind parameters, so every interpolated value is validated first. */
function assertUuid(value: string): string {
  if (!UUID_RE.test(value)) throw badRequest(`invalid id: ${value}`);
  return value;
}

function assertInstant(value: string | undefined, fallback: number): string {
  const ms = value === undefined ? fallback : Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(`invalid date: ${value}`);
  return new Date(ms).toISOString();
}

export const exportRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Streams straight out of Postgres with COPY, so a 30-day export never
   * materialises in Node's heap regardless of how many rows it covers.
   */
  app.get('/devices/:id/export.csv', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const query = parse(exportSchema, req.query);
    const device = await requireOwnedDevice(auth.id, id);
    const plan = await getUserPlan(auth.id);

    const toIso = assertInstant(query.to, Date.now());
    const retentionFloor = Date.now() - plan.retentionDays * 86_400_000;
    const requestedFrom = Date.parse(assertInstant(query.from, Date.now() - 86_400_000));
    const fromIso = new Date(Math.max(requestedFrom, retentionFloor)).toISOString();

    const requested = (query.variableIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(assertUuid);

    // Keys are needed for the wide header, so select them either way and let the
    // database decide which of the requested ids actually belong to this device.
    const all = await db
      .select({ id: tables.variables.id, key: tables.variables.key })
      .from(tables.variables)
      .where(eq(tables.variables.deviceId, id))
      .orderBy(tables.variables.sortOrder);

    const columns =
      requested.length > 0 ? all.filter((v) => requested.includes(v.id)) : all;

    if (columns.length === 0) throw badRequest('This device has no variables to export');

    const ids = columns.map((v) => v.id);

    // Re-validated here even though the write path already checked it: this value is
    // interpolated into a COPY statement, which cannot take bind parameters.
    const tz = isValidTimeZone(device.timezone) ? device.timezone : 'UTC';

    const idList = ids.map((v) => `'${v}'::uuid`).join(',');
    const where = `
         WHERE t.device_id = '${assertUuid(id)}'::uuid
           AND t.variable_id IN (${idList})
           AND t.ts >= '${fromIso}'::timestamptz
           AND t.ts <= '${toIso}'::timestamptz`;

    // One column per variable. A cycle writes every variable at the same instant,
    // so grouping by ts gives one row per cycle; max() is just the aggregate that
    // picks the single non-null value each CASE produces.
    const pivot = columns
      .map((v) => `               max(CASE WHEN t.variable_id = '${v.id}'::uuid THEN ${VALUE_EXPR} END) AS ${quoteIdent(csvColumnName(v.key))}`)
      .join(',\n');

    const sql =
      query.format === 'long'
        ? `
      COPY (
        SELECT to_char(t.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_utc,
               to_char(t.ts AT TIME ZONE '${tz}', 'YYYY-MM-DD HH24:MI:SS')        AS timestamp_local,
               '${tz}'  AS timezone,
               v.key    AS variable,
               v.label  AS label,
               v.unit   AS unit,
               ${VALUE_EXPR} AS value
          FROM telemetry t
          JOIN variables v ON v.id = t.variable_id
          ${where}
         ORDER BY t.ts
      ) TO STDOUT WITH (FORMAT csv, HEADER true)
    `
        : `
      COPY (
        SELECT to_char(t.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_utc,
               to_char(t.ts AT TIME ZONE '${tz}', 'YYYY-MM-DD HH24:MI:SS')        AS timestamp_local,
               '${tz}'  AS timezone,
${pivot}
          FROM telemetry t
          JOIN variables v ON v.id = t.variable_id
          ${where}
         GROUP BY t.ts
         ORDER BY t.ts
      ) TO STDOUT WITH (FORMAT csv, HEADER true)
    `;

    const slug = device.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device';
    const filename = `${slug}_${fromIso.slice(0, 10)}_${toIso.slice(0, 10)}.csv`;

    const client = await getPool().connect();
    let broken = false;
    try {
      const stream = client.query(copyTo(sql));
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      await pipeline(stream, reply.raw);
    } catch (err) {
      // A COPY aborted part-way (client disconnect, query error) leaves the
      // connection mid-protocol. Returning it to the pool would hand the next
      // request a session that answers with the remainder of this CSV.
      broken = true;
      req.log.error({ err: (err as Error).message }, 'csv export failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500);
      reply.raw.end();
    } finally {
      client.release(broken);
    }
  });
};
