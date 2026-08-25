export interface ApiErrorShape {
  error: string;
  code?: string;
  limit?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly limit?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Exchange the httpOnly refresh cookie for a fresh access token, de-duplicated. */
export function refreshSession(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        setAccessToken(null);
        return null;
      }
      const data = (await res.json()) as { accessToken: string };
      setAccessToken(data.accessToken);
      return data.accessToken;
    })
    .catch(() => {
      setAccessToken(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const res = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && retry) {
    const token = await refreshSession();
    if (token) return request<T>(path, init, false);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const shape = (data ?? {}) as ApiErrorShape;
    throw new ApiError(res.status, shape.error ?? res.statusText, shape.code, shape.limit);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Domain types shared with the API ────────────────────────────────────────
export type VariableType = 'int' | 'float' | 'bool' | 'string';

export interface Plan {
  id: string;
  name: string;
  maxDevices: number;
  maxVariablesPerDevice: number;
  retentionDays: number;
  minIntervalS: number;
  priceCents: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Device {
  id: string;
  deviceKey: string;
  name: string;
  description: string;
  intervalS: number;
  timezone: string;
  enabled: boolean;
  autoCreateVariables: boolean;
  online: boolean;
  lastSeenAt: string | null;
  lastTransport: string | null;
  messageCount: number;
  pointCount: number;
  tokenPreview: string;
  createdAt: string;
  variableCount?: number;
}

export interface Variable {
  id: string;
  deviceId: string;
  key: string;
  label: string;
  type: VariableType;
  unit: string;
  writable: boolean;
  color: string;
  minValue: number | null;
  maxValue: number | null;
  sortOrder: number;
}

// ── Dashboards (phase 2) ────────────────────────────────────────────────────

export const WIDGET_TYPES = [
  'gauge',
  'tank',
  'thermometer',
  'number',
  'chart',
  'toggle',
  'button',
  'slider',
  'text',
  'led',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Widgets that write back to the device, so they need a writable variable. */
export const INTERACTIVE_WIDGETS: readonly WidgetType[] = ['toggle', 'button', 'slider'];
/** Widgets that display no variable at all. */
export const VARIABLE_FREE_WIDGETS: readonly WidgetType[] = ['text'];

export interface WidgetConfig {
  label?: string;
  unit?: string;
  color?: string;
  min?: number;
  max?: number;
  decimals?: number;
  step?: number;
  onValue?: string;
  offValue?: string;
  /** button: hold ON this long, then send OFF. 0 disables the pulse. */
  pulseMs?: number;
  /** led */
  onColor?: string;
  offColor?: string;
  threshold?: number;
  rangeMs?: number;
  body?: string;
}

export interface Widget {
  id: string;
  dashboardId: string;
  variableId: string | null;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfig;
  createdAt: string;
}

export interface Dashboard {
  id: string;
  deviceId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateEntry {
  variableId: string;
  key: string;
  label: string;
  type: VariableType;
  unit: string;
  writable: boolean;
  color: string;
  ts: string | null;
  valueNum: number | null;
  valueText: string | null;
}

export interface SeriesPoint {
  t: number;
  v: number | null;
  min?: number | null;
  max?: number | null;
  s?: string | null;
}

export interface SeriesResponse {
  from: number;
  to: number;
  series: Array<{
    variable: Pick<Variable, 'id' | 'key' | 'label' | 'type' | 'unit' | 'color'>;
    resolution: 'raw' | '1m' | '1h';
    points: SeriesPoint[];
  }>;
}

/**
 * GET /variables/:id/series — one variable, points at the top level.
 * Deliberately NOT the same shape as SeriesResponse (GET /devices/:id/series),
 * which nests everything under `series`.
 */
export interface VariableSeriesResponse {
  variable: Pick<Variable, 'id' | 'key' | 'label' | 'type' | 'unit' | 'color'>;
  from: number;
  to: number;
  resolution: 'raw' | '1m' | '1h';
  points: SeriesPoint[];
}

export interface ConnectionInfo {
  deviceKey: string;
  tokenPreview: string;
  intervalS: number;
  mqtt: {
    host: string;
    port: number;
    wsPort: number;
    username: string;
    password: string;
    publishTopic: string;
    subscribeTopic: string;
    statusTopic: string;
  };
  http: { url: string; method: string; headers: Record<string, string> };
  websocket: { url: string };
  payloadExample: unknown;
}
