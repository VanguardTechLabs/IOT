import { Redis } from 'ioredis';
import { env } from './env.js';

export const CHANNELS = {
  telemetry: 'pulse:rt:telemetry',
  status: 'pulse:rt:status',
  variable: 'pulse:rt:variable',
  command: 'pulse:rt:command',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Per-device fan-out for WebSocket-connected devices (MQTT devices get the broker topic). */
export const downlinkChannel = (deviceKey: string) => `pulse:dn:${deviceKey}`;

export function createRedis(role = 'client'): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `pulse:${role}`,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on('error', (err: Error) => console.error(`[redis:${role}]`, err.message));
  return client;
}

let publisher: Redis | null = null;

export function getPublisher(): Redis {
  if (!publisher) publisher = createRedis('pub');
  return publisher;
}

export async function publish<T>(channel: Channel, payload: T): Promise<void> {
  await getPublisher().publish(channel, JSON.stringify(payload));
}

/** Fixed-window burst guard. Returns false once a device exceeds `limit` in `windowS`. */
export async function consumeBurstToken(
  redis: Redis,
  deviceId: string,
  limit: number,
  windowS: number,
): Promise<boolean> {
  const key = `pulse:burst:${deviceId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowS);
  return count <= limit;
}
