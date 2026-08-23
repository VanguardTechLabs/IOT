import { getPool } from '../db/index.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { CHANNELS, publish } from '../redis.js';
import type { StatusEvent } from '../types.js';

const log = createLogger('writer');

export interface PendingRow {
  ts: Date;
  variableId: string;
  deviceId: string;
  num: number | null;
  text: string | null;
}

interface DeviceTally {
  messages: number;
  points: number;
  lastSeen: Date;
  transport: string;
}

/**
 * Buffers telemetry and flushes it as a handful of multi-row statements.
 *
 * At the contracted worst case (100 devices x 9 variables every 3 s = 300 rows/s)
 * a row-at-a-time insert would mean 300 round trips per second plus 300 state
 * upserts. Batching collapses that to ~5 statements per second, which is what
 * makes a single modest VPS enough.
 */
export class TelemetryWriter {
  private rows: PendingRow[] = [];
  private latest = new Map<string, PendingRow>();
  private tallies = new Map<string, DeviceTally>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;

  public droppedRows = 0;
  public writtenRows = 0;

  constructor(
    private readonly flushMs = env.INGEST_FLUSH_MS,
    private readonly flushRows = env.INGEST_FLUSH_ROWS,
    private readonly maxBuffer = 100_000,
  ) {}

  enqueue(row: PendingRow): void {
    if (this.rows.length >= this.maxBuffer) {
      // The database is unreachable or hopelessly behind. Shedding the oldest data
      // keeps the process alive and the newest values correct.
      this.rows.splice(0, Math.floor(this.maxBuffer / 10));
      this.droppedRows += Math.floor(this.maxBuffer / 10);
    }
    this.rows.push(row);
    // Newest-wins, matching the `variable_state.ts <= EXCLUDED.ts` guard in write().
    // Keeping the last row to *arrive* would let a delayed packet overwrite a newer
    // reading inside the same batch, where the SQL guard can no longer see it.
    const prev = this.latest.get(row.variableId);
    if (!prev || row.ts.getTime() >= prev.ts.getTime()) this.latest.set(row.variableId, row);
    this.schedule();
  }

  tally(deviceId: string, points: number, transport: string, at: Date): void {
    const current = this.tallies.get(deviceId);
    if (current) {
      current.messages += 1;
      current.points += points;
      current.lastSeen = at;
      current.transport = transport;
    } else {
      this.tallies.set(deviceId, { messages: 1, points, lastSeen: at, transport });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    // `!this.flushing` is load-bearing, not an optimisation. flush() returns early
    // while a write is in flight and calls schedule() on its way out; without this
    // guard the two recurse synchronously — no await separates them — and a write
    // slower than (flushRows / ingest rate) blows the stack and kills the process.
    // The .finally() below re-arms the flush as soon as the in-flight write lands.
    if (!this.flushing && this.rows.length >= this.flushRows) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      // A write is already in flight. Anything buffered since it started needs a
      // pass of its own, otherwise a trailing burst would sit until the next
      // enqueue happens to re-arm the timer.
      if (!this.stopped && (this.rows.length > 0 || this.tallies.size > 0)) this.schedule();
      return this.flushing;
    }
    if (this.rows.length === 0 && this.tallies.size === 0) return;

    const rows = this.rows;
    const latest = this.latest;
    const tallies = this.tallies;
    this.rows = [];
    this.latest = new Map();
    this.tallies = new Map();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.flushing = this.write(rows, latest, tallies).finally(() => {
      this.flushing = null;
      if (this.rows.length > 0 || this.tallies.size > 0) this.schedule();
    });
    return this.flushing;
  }

  private async write(
    rows: PendingRow[],
    latest: Map<string, PendingRow>,
    tallies: Map<string, DeviceTally>,
  ): Promise<void> {
    const pool = getPool();
    const client = await pool.connect();
    // Published only after COMMIT — the panel must never be told about presence
    // that a rollback then discards.
    let statusEvents: StatusEvent[] = [];
    try {
      await client.query('BEGIN');

      if (rows.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        rows.forEach((r, i) => {
          const b = i * 5;
          placeholders.push(`($${b + 1},$${b + 2}::uuid,$${b + 3}::uuid,$${b + 4},$${b + 5})`);
          values.push(r.ts, r.variableId, r.deviceId, r.num, r.text);
        });
        await client.query(
          `INSERT INTO telemetry (ts, variable_id, device_id, value_num, value_text)
           VALUES ${placeholders.join(',')}`,
          values,
        );
      }

      if (latest.size > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let i = 0;
        for (const r of latest.values()) {
          const b = i * 5;
          placeholders.push(`($${b + 1}::uuid,$${b + 2}::uuid,$${b + 3},$${b + 4},$${b + 5})`);
          values.push(r.variableId, r.deviceId, r.ts, r.num, r.text);
          i += 1;
        }
        // Guard against an out-of-order packet overwriting a newer reading.
        await client.query(
          `INSERT INTO variable_state (variable_id, device_id, ts, value_num, value_text)
           VALUES ${placeholders.join(',')}
           ON CONFLICT (variable_id) DO UPDATE
             SET ts = EXCLUDED.ts,
                 device_id = EXCLUDED.device_id,
                 value_num = EXCLUDED.value_num,
                 value_text = EXCLUDED.value_text
           WHERE variable_state.ts <= EXCLUDED.ts`,
          values,
        );
      }

      if (tallies.size > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let i = 0;
        for (const [deviceId, t] of tallies) {
          const b = i * 5;
          placeholders.push(`($${b + 1}::uuid,$${b + 2}::bigint,$${b + 3}::bigint,$${b + 4}::timestamptz,$${b + 5})`);
          values.push(deviceId, t.messages, t.points, t.lastSeen, t.transport);
          i += 1;
        }
        const updated = await client.query<{
          id: string;
          user_id: string;
          online: boolean;
          last_seen_at: Date | null;
          message_count: string | number;
          point_count: string | number;
          last_transport: string | null;
        }>(
          `UPDATE devices d
              SET message_count = d.message_count + v.messages,
                  point_count   = d.point_count + v.points,
                  last_seen_at  = GREATEST(COALESCE(d.last_seen_at, v.last_seen), v.last_seen),
                  last_transport = v.transport,
                  online = true
             FROM (VALUES ${placeholders.join(',')}) AS v(device_id, messages, points, last_seen, transport)
            WHERE d.id = v.device_id
        RETURNING d.id, d.user_id, d.online, d.last_seen_at, d.message_count, d.point_count,
                  d.last_transport`,
          values,
        );

        // Presence and the counters used to move only in the database. The panel
        // patches them from CHANNELS.status, which was published solely by the
        // presence helpers — so on a page left open, "last seen" drifted to
        // "12 minutes ago" while tiles kept flashing new values, and an HTTP
        // device swept offline never came back until a reload.
        //
        // The tallies map only holds devices that reported during this flush, so
        // this publishes at the uplink rate, not once per row.
        statusEvents = updated.rows.map((r) => ({
          deviceId: r.id,
          userId: r.user_id,
          online: r.online,
          lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
          messageCount: Number(r.message_count),
          pointCount: Number(r.point_count),
          transport: r.last_transport ?? undefined,
        }));
      }

      await client.query('COMMIT');
      this.writtenRows += rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.droppedRows += rows.length;
      statusEvents = [];
      log.error({ err: (err as Error).message, rows: rows.length }, 'telemetry flush failed');
    } finally {
      client.release();
    }

    // Outside the try/finally so the connection is already back in the pool, and
    // individually caught: a Redis hiccup must degrade the live panel, never the
    // write path that just succeeded.
    for (const event of statusEvents) {
      await publish(CHANNELS.status, event).catch((err) =>
        log.debug({ err: (err as Error).message }, 'status publish failed'),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Two passes: the first awaits any in-flight write, the second drains whatever
    // was buffered while that write was running.
    await this.flush();
    await this.flush();
  }

  stats() {
    return { buffered: this.rows.length, written: this.writtenRows, dropped: this.droppedRows };
  }
}
