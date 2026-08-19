import { z } from 'zod';

export const VARIABLE_TYPES = ['int', 'float', 'bool', 'string'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const variableTypeSchema = z.enum(VARIABLE_TYPES);

export const variableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, 'use letters, digits, _ . - and do not start with a symbol');

/**
 * The wire contract. ESP32s always send strings — the platform casts using the
 * declared type of each variable.
 *
 *   { "ts": 1730000000, "v": { "temp": "23.5", "rele": "1", "mode": "auto" } }
 *
 * `ts` is optional (seconds or milliseconds); the server stamps the time when it
 * is missing or implausible, which keeps devices with no RTC usable.
 */
export const uplinkSchema = z.object({
  ts: z.number().optional(),
  v: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type Uplink = z.infer<typeof uplinkSchema>;

/** Flat form accepted too: { "temp": "23.5", "rele": "1" } */
export const flatUplinkSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const downlinkSchema = z.record(z.string());

export type CastResult =
  | { ok: true; num: number | null; text: string | null }
  | { ok: false; reason: string };

const TRUTHY = new Set(['1', 'true', 't', 'on', 'high', 'yes', 'y']);
const FALSY = new Set(['0', 'false', 'f', 'off', 'low', 'no', 'n']);

/** Cast a raw wire value to the storage representation for a declared variable type. */
export function castValue(type: VariableType, raw: string | number | boolean | null): CastResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'null value' };
  const asString = typeof raw === 'string' ? raw.trim() : String(raw);
  if (asString === '') return { ok: false, reason: 'empty value' };

  switch (type) {
    case 'int': {
      const n = Number(asString);
      if (!Number.isFinite(n)) return { ok: false, reason: `"${asString}" is not an integer` };
      return { ok: true, num: Math.trunc(n), text: null };
    }
    case 'float': {
      const n = Number(asString);
      if (!Number.isFinite(n)) return { ok: false, reason: `"${asString}" is not a number` };
      return { ok: true, num: n, text: null };
    }
    case 'bool': {
      const lowered = asString.toLowerCase();
      if (TRUTHY.has(lowered)) return { ok: true, num: 1, text: null };
      if (FALSY.has(lowered)) return { ok: true, num: 0, text: null };
      return { ok: false, reason: `"${asString}" is not a boolean` };
    }
    case 'string':
      return { ok: true, num: null, text: asString.slice(0, 512) };
  }
}

/**
 * Best guess for auto-created variables, refined by the user in the panel.
 * "0"/"1" stay numeric on purpose — they are far more often counters or a raw ADC
 * reading than a flag, and widening int -> bool later is lossless while the
 * reverse is not.
 */
export function inferType(raw: string | number | boolean | null): VariableType {
  if (typeof raw === 'boolean') return 'bool';
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  const n = Number(s);
  if (s !== '' && Number.isFinite(n)) return Number.isInteger(n) ? 'int' : 'float';
  const lowered = s.toLowerCase();
  if (TRUTHY.has(lowered) || FALSY.has(lowered)) return 'bool';
  return 'string';
}

/** Render a stored value back to the string form devices and CSV exports expect. */
export function renderValue(type: VariableType, num: number | null, text: string | null): string {
  if (type === 'string') return text ?? '';
  if (num === null) return '';
  if (type === 'bool') return num >= 0.5 ? '1' : '0';
  if (type === 'int') return String(Math.trunc(num));
  return String(num);
}

export interface TelemetryPoint {
  variableId: string;
  key: string;
  type: VariableType;
  ts: number;
  num: number | null;
  text: string | null;
}

export interface TelemetryEvent {
  deviceId: string;
  userId: string;
  points: TelemetryPoint[];
}

export interface StatusEvent {
  deviceId: string;
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
  messageCount?: number;
  pointCount?: number;
  transport?: string;
}

export interface VariableEvent {
  deviceId: string;
  userId: string;
  variable: {
    id: string;
    key: string;
    label: string;
    type: VariableType;
    unit: string;
    writable: boolean;
    color: string;
  };
}

export interface CommandEvent {
  deviceId: string;
  userId: string;
  key: string;
  value: string;
  at: string;
}

export const TRANSPORTS = ['mqtt', 'http', 'ws'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export type Resolution = 'raw' | '1m' | '1h';

/**
 * Picks the cheapest source that still gives a readable chart. This encodes the
 * rollup strategy from migration 0003, so it lives beside the schema rather than
 * in the HTTP layer.
 *
 * A 30-day window over a 3 s variable is ~865k raw rows; the hourly rollup answers
 * the same question in 720.
 */
export function pickResolution(fromMs: number, toMs: number): Resolution {
  const spanHours = (toMs - fromMs) / 3_600_000;
  if (spanHours <= 6) return 'raw';
  if (spanHours <= 24 * 7) return '1m';
  return '1h';
}

/**
 * Validates an IANA time zone against the runtime's own tz database.
 *
 * This is a security boundary as well as a correctness one: the CSV export
 * interpolates the zone into a COPY statement, which takes no bind parameters.
 * The character class alone would not be enough — the value must also be a zone
 * Postgres will recognise.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .refine(isValidTimeZone, 'not a recognised IANA time zone, e.g. America/Lima');
