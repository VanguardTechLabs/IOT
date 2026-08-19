import type { StateEntry, VariableType } from './api';

export function formatValue(type: VariableType, num: number | null, text: string | null): string {
  if (type === 'string') return text ?? '—';
  if (num === null || num === undefined) return '—';
  if (type === 'bool') return num >= 0.5 ? 'ON' : 'OFF';
  if (type === 'int') return Math.trunc(num).toLocaleString();
  const abs = Math.abs(num);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return num.toFixed(digits);
}

export function formatState(entry: StateEntry): string {
  return formatValue(entry.type, entry.valueNum, entry.valueText);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `timeZone` is the device's configured zone; undefined falls back to the browser's. */
export function formatClock(ts: number, span: number, timeZone?: string): string {
  const date = new Date(ts);
  if (span > 3 * 86_400_000) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone });
  }
  if (span > 86_400_000) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
  }
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: span < 3_600_000 ? '2-digit' : undefined,
    timeZone,
  });
}

export function formatFullClock(ts: number, timeZone?: string): string {
  return new Date(ts).toLocaleString(undefined, { timeZone, timeZoneName: 'short' });
}

/** Every IANA zone the browser knows, with a curated fallback for older engines. */
export function listTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') {
    try {
      return supported('timeZone');
    } catch {
      /* fall through */
    }
  }
  return [
    'UTC',
    'America/Argentina/Buenos_Aires',
    'America/Bogota',
    'America/Caracas',
    'America/Guayaquil',
    'America/Lima',
    'America/Mexico_City',
    'America/Santiago',
    'America/Sao_Paulo',
    'Europe/Madrid',
    'Europe/London',
    'Asia/Tokyo',
  ];
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const RANGES = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 7 * 86_400_000 },
  { label: '30d', ms: 30 * 86_400_000 },
] as const;
