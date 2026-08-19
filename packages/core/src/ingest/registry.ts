import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { db, getPool } from '../db/index.js';
import { devices, variables } from '../db/schema.js';
import { publish, getPublisher, CHANNELS } from '../redis.js';
import { inferType, variableKeySchema, type VariableType } from '../types.js';

export interface CachedVariable {
  id: string;
  key: string;
  type: VariableType;
  writable: boolean;
}

export interface CachedDevice {
  id: string;
  userId: string;
  deviceKey: string;
  tokenHash: string;
  tokenSalt: string;
  enabled: boolean;
  autoCreate: boolean;
  intervalS: number;
  maxVariables: number;
  variables: Map<string, CachedVariable>;
  loadedAt: number;
}

const TTL_MS = 60_000;
/**
 * Misses are cached too, briefly. A device deleted while its broker session is
 * still open keeps publishing until it disconnects; without this, every one of
 * those messages would run a fresh lookup against Postgres.
 */
const MISS_TTL_MS = 10_000;
const MAX_MISSES = 5_000;

/**
 * Per-process device/variable cache. Ingest resolves a device on every message, so
 * this is the difference between one query per message and one query per minute.
 * Invalidation is broadcast over Redis, so an edit in the panel is visible to the
 * ingest worker immediately rather than after the TTL.
 */
export class DeviceRegistry {
  private byKey = new Map<string, CachedDevice>();
  private byId = new Map<string, CachedDevice>();
  private misses = new Map<string, number>();
  private inflight = new Map<string, Promise<CachedDevice | null>>();

  invalidate(deviceKeyOrId: string): void {
    this.misses.delete(deviceKeyOrId);
    const cached = this.byKey.get(deviceKeyOrId) ?? this.byId.get(deviceKeyOrId);
    if (!cached) return;
    this.byKey.delete(cached.deviceKey);
    this.byId.delete(cached.id);
  }

  clear(): void {
    this.byKey.clear();
    this.byId.clear();
    this.misses.clear();
  }

  async getByKey(deviceKey: string): Promise<CachedDevice | null> {
    const cached = this.byKey.get(deviceKey);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;

    const missedAt = this.misses.get(deviceKey);
    if (missedAt !== undefined) {
      if (Date.now() - missedAt < MISS_TTL_MS) return null;
      this.misses.delete(deviceKey);
    }

    const existing = this.inflight.get(deviceKey);
    if (existing) return existing;

    const promise = this.load(deviceKey).finally(() => this.inflight.delete(deviceKey));
    this.inflight.set(deviceKey, promise);
    return promise;
  }

  private async load(deviceKey: string): Promise<CachedDevice | null> {
    const rows = await db
      .select({
        id: devices.id,
        userId: devices.userId,
        deviceKey: devices.deviceKey,
        tokenHash: devices.tokenHash,
        tokenSalt: devices.tokenSalt,
        enabled: devices.enabled,
        autoCreate: devices.autoCreateVariables,
        intervalS: devices.intervalS,
      })
      .from(devices)
      .where(eq(devices.deviceKey, deviceKey))
      .limit(1);

    const row = rows[0];
    if (!row) {
      // Device keys reaching this path are unauthenticated and attacker-supplied,
      // so the negative cache needs a ceiling: expire what is already stale, and
      // if that frees nothing, drop the lot rather than grow without bound.
      if (this.misses.size >= MAX_MISSES) {
        const now = Date.now();
        for (const [k, t] of this.misses) if (now - t >= MISS_TTL_MS) this.misses.delete(k);
        if (this.misses.size >= MAX_MISSES) this.misses.clear();
      }
      this.misses.set(deviceKey, Date.now());
      return null;
    }

    const vars = await db
      .select({
        id: variables.id,
        key: variables.key,
        type: variables.type,
        writable: variables.writable,
      })
      .from(variables)
      .where(eq(variables.deviceId, row.id));

    const limit = await getVariableLimit(row.id);

    const entry: CachedDevice = {
      ...row,
      maxVariables: limit,
      variables: new Map(vars.map((v) => [v.key, { ...v, type: v.type as VariableType }])),
      loadedAt: Date.now(),
    };
    this.byKey.set(entry.deviceKey, entry);
    this.byId.set(entry.id, entry);
    return entry;
  }

  /** Create a variable that a device reported but the panel does not know about yet. */
  async ensureVariable(device: CachedDevice, key: string, sample: string | number | boolean | null) {
    const known = device.variables.get(key);
    if (known) return known;
    if (!device.autoCreate) return null;
    if (!variableKeySchema.safeParse(key).success) return null;
    if (device.variables.size >= device.maxVariables) return null;

    const type = inferType(sample);
    const inserted = await db
      .insert(variables)
      .values({
        deviceId: device.id,
        key,
        label: key,
        type,
        sortOrder: device.variables.size,
      })
      .onConflictDoNothing({ target: [variables.deviceId, variables.key] })
      .returning({ id: variables.id, key: variables.key, type: variables.type, writable: variables.writable });

    let created = inserted[0];
    if (!created) {
      const found = await db
        .select({ id: variables.id, key: variables.key, type: variables.type, writable: variables.writable })
        .from(variables)
        .where(and(eq(variables.deviceId, device.id), eq(variables.key, key)))
        .limit(1);
      created = found[0];
    }
    if (!created) return null;

    const entry: CachedVariable = { ...created, type: created.type as VariableType };
    device.variables.set(key, entry);

    await publish(CHANNELS.variable, {
      deviceId: device.id,
      userId: device.userId,
      variable: {
        id: entry.id,
        key: entry.key,
        label: entry.key,
        type: entry.type,
        unit: '',
        writable: entry.writable,
        color: '#38bdf8',
      },
    });

    return entry;
  }
}

async function getVariableLimit(deviceId: string): Promise<number> {
  const { rows } = await getPool().query<{ max_variables_per_device: number }>(
    `SELECT p.max_variables_per_device
       FROM devices d
       JOIN users u ON u.id = d.user_id
       JOIN plans p ON p.id = u.plan_id
      WHERE d.id = $1`,
    [deviceId],
  );
  return rows[0]?.max_variables_per_device ?? 16;
}

export const registry = new DeviceRegistry();

export const INVALIDATION_CHANNEL = 'pulse:registry:invalidate';

/** Broadcast from the API whenever a device or its variables change. */
export async function broadcastInvalidation(deviceKeyOrId: string): Promise<void> {
  await getPublisher().publish(INVALIDATION_CHANNEL, deviceKeyOrId);
}

/** Wire a dedicated Redis subscriber to the shared registry. */
export function listenForInvalidation(subscriber: Redis, target: DeviceRegistry = registry): void {
  void subscriber.subscribe(INVALIDATION_CHANNEL);
  subscriber.on('message', (channel: string, message: string) => {
    if (channel === INVALIDATION_CHANNEL) target.invalidate(message);
  });
}
