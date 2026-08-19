import { getPool } from '../db/index.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { CHANNELS, publish } from '../redis.js';

const log = createLogger('presence');

export async function setOnline(deviceId: string, online: boolean, transport?: string): Promise<void> {
  const { rows } = await getPool().query<{
    user_id: string;
    online: boolean;
    last_seen_at: Date | null;
    message_count: number;
    point_count: number;
  }>(
    `UPDATE devices
        SET online = $2,
            last_seen_at = CASE WHEN $2 THEN now() ELSE last_seen_at END,
            last_transport = COALESCE($3, last_transport),
            updated_at = now()
      WHERE id = $1
      RETURNING user_id, online, last_seen_at, message_count, point_count`,
    [deviceId, online, transport ?? null],
  );

  const row = rows[0];
  if (!row) return;

  await publish(CHANNELS.status, {
    deviceId,
    userId: row.user_id,
    online: row.online,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    messageCount: row.message_count,
    pointCount: row.point_count,
    transport,
  });
}

/**
 * Marks devices offline once they miss several reporting cycles.
 *
 * The LWT covers a clean broker disconnect, but a device that loses power mid-cycle,
 * or one that speaks HTTP and has no session at all, only shows up as silence.
 * The grace window is derived from each device's own interval so a 3 s sensor is
 * flagged quickly while a 5 min one is not flapped offline.
 */
export async function sweepOfflineDevices(): Promise<number> {
  const { rows } = await getPool().query<{
    id: string;
    user_id: string;
    last_seen_at: Date | null;
    message_count: number;
    point_count: number;
  }>(
    `UPDATE devices
        SET online = false, updated_at = now()
      WHERE online = true
        AND (
          last_seen_at IS NULL
          OR last_seen_at < now() - make_interval(secs => GREATEST(interval_s * $1::int, $2::int)::double precision)
        )
      RETURNING id, user_id, last_seen_at, message_count, point_count`,
    [env.DEVICE_OFFLINE_GRACE_MULTIPLIER, env.DEVICE_OFFLINE_MIN_GRACE_S],
  );

  for (const row of rows) {
    await publish(CHANNELS.status, {
      deviceId: row.id,
      userId: row.user_id,
      online: false,
      lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      messageCount: row.message_count,
      pointCount: row.point_count,
    });
  }

  if (rows.length > 0) log.info({ count: rows.length }, 'devices marked offline');
  return rows.length;
}
