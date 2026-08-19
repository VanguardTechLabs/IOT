import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { CHANNELS, consumeBurstToken, publish } from '../redis.js';
import {
  castValue,
  flatUplinkSchema,
  uplinkSchema,
  type TelemetryPoint,
  type Transport,
} from '../types.js';
import { registry, type CachedDevice, type DeviceRegistry } from './registry.js';
import { TelemetryWriter } from './writer.js';

const log = createLogger('ingest');

export interface IngestOutcome {
  accepted: number;
  rejected: Array<{ key: string; reason: string }>;
  throttled?: boolean;
}

export interface IngestEngineOptions {
  redis: Redis;
  writer?: TelemetryWriter;
  registry?: DeviceRegistry;
}

/** Accepts both `{ ts, v: {...} }` and a flat `{ key: value }` object. */
export function parseUplink(raw: unknown): { ts?: number; values: Record<string, unknown> } | null {
  const nested = uplinkSchema.safeParse(raw);
  if (nested.success) return { ts: nested.data.ts, values: nested.data.v };
  const flat = flatUplinkSchema.safeParse(raw);
  if (flat.success && !('v' in (flat.data as object))) return { values: flat.data };
  return null;
}

/** Devices without an RTC send garbage timestamps; only trust ones near now. */
export function resolveTimestamp(ts: number | undefined, now: number): Date {
  if (ts === undefined || !Number.isFinite(ts)) return new Date(now);
  const ms = ts > 1e12 ? ts : ts * 1000;
  const drift = Math.abs(now - ms);
  // Accept up to 24 h in the past (buffered offline data) and 5 min in the future.
  if (ms > now + 5 * 60_000 || drift > 24 * 60 * 60_000) return new Date(now);
  return new Date(ms);
}

export class IngestEngine {
  readonly writer: TelemetryWriter;
  private readonly registry: DeviceRegistry;
  private readonly redis: Redis;

  constructor(opts: IngestEngineOptions) {
    this.redis = opts.redis;
    this.writer = opts.writer ?? new TelemetryWriter();
    this.registry = opts.registry ?? registry;
  }

  async resolveDevice(deviceKey: string): Promise<CachedDevice | null> {
    return this.registry.getByKey(deviceKey);
  }

  /**
   * Validate, cast, buffer and fan out one uplink message.
   * Never throws — a malformed payload from one device must not stall the stream.
   */
  async handleUplink(
    device: CachedDevice,
    payload: unknown,
    transport: Transport,
    forcedKey?: string,
  ): Promise<IngestOutcome> {
    if (!device.enabled) return { accepted: 0, rejected: [{ key: '*', reason: 'device disabled' }] };

    const allowed = await consumeBurstToken(
      this.redis,
      device.id,
      env.INGEST_BURST_LIMIT,
      env.INGEST_BURST_WINDOW_S,
    );
    if (!allowed) {
      return { accepted: 0, rejected: [{ key: '*', reason: 'rate limited' }], throttled: true };
    }

    let parsed = forcedKey
      ? { ts: undefined as number | undefined, values: { [forcedKey]: payload } as Record<string, unknown> }
      : parseUplink(payload);

    if (!parsed) return { accepted: 0, rejected: [{ key: '*', reason: 'invalid payload' }] };

    const now = Date.now();
    const ts = resolveTimestamp(parsed.ts, now);
    const rejected: Array<{ key: string; reason: string }> = [];
    const points: TelemetryPoint[] = [];

    for (const [key, raw] of Object.entries(parsed.values)) {
      if (key === 'ts') continue;
      const variable =
        device.variables.get(key) ??
        (await this.registry.ensureVariable(device, key, raw as string | number | boolean | null));

      if (!variable) {
        rejected.push({ key, reason: 'unknown variable' });
        continue;
      }

      const cast = castValue(variable.type, raw as string | number | boolean | null);
      if (!cast.ok) {
        rejected.push({ key, reason: cast.reason });
        continue;
      }

      this.writer.enqueue({
        ts,
        variableId: variable.id,
        deviceId: device.id,
        num: cast.num,
        text: cast.text,
      });

      points.push({
        variableId: variable.id,
        key: variable.key,
        type: variable.type,
        ts: ts.getTime(),
        num: cast.num,
        text: cast.text,
      });
    }

    if (points.length > 0) {
      this.writer.tally(device.id, points.length, transport, ts);
      await publish(CHANNELS.telemetry, {
        deviceId: device.id,
        userId: device.userId,
        points,
      });
    }

    if (rejected.length > 0) {
      log.debug({ device: device.deviceKey, rejected }, 'uplink partially rejected');
    }

    return { accepted: points.length, rejected };
  }

  async stop(): Promise<void> {
    await this.writer.stop();
  }
}
