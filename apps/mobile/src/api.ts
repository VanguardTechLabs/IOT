import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * API client.
 *
 * Two differences from the web client, both forced by the platform:
 *
 * The refresh token lives in the OS keychain rather than an httpOnly cookie,
 * because React Native has no cookie jar that survives an app restart. The
 * server hands it over only when asked with `x-pulse-client: native`.
 *
 * The base URL is absolute. There is no origin to be relative to.
 */

const REFRESH_KEY = 'pulse.refreshToken';

export const API_URL: string =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'https://vmi3520387.contaboserver.net';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const l of listeners) l(token);
}

export function onTokenChange(l: (token: string | null) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

async function readRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_KEY);
  } catch {
    // A keychain read can fail on a device with no screen lock configured.
    // Treat it as "no session" rather than crashing on launch.
    return null;
  }
}

async function writeRefreshToken(token: string | null): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(REFRESH_KEY, token);
    else await SecureStore.deleteItemAsync(REFRESH_KEY);
  } catch {
    // Losing persistence degrades to "signs out when the app closes", which is
    // survivable. Failing the login over it would not be.
  }
}

export interface SessionResponse {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; email: string; name: string; role: string };
  plan: Plan;
}

async function adopt(session: SessionResponse): Promise<SessionResponse> {
  setAccessToken(session.accessToken);
  if (session.refreshToken) await writeRefreshToken(session.refreshToken);
  return session;
}

/** Trade the stored refresh token for a new access token. De-duplicated. */
export function refreshSession(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const stored = await readRefreshToken();
    if (!stored) {
      setAccessToken(null);
      return null;
    }
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pulse-client': 'native' },
        body: JSON.stringify({ refreshToken: stored }),
      });
      if (!res.ok) {
        // The server rotates on every refresh, so a rejected token is spent or
        // revoked. Dropping it stops an unusable token being retried forever.
        await writeRefreshToken(null);
        setAccessToken(null);
        return null;
      }
      const session = (await res.json()) as SessionResponse;
      await adopt(session);
      return session.accessToken;
    } catch {
      // A network failure is not an invalid session. Keep the token for the next
      // attempt and only report that there is no access token right now.
      setAccessToken(null);
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function hasStoredSession(): Promise<boolean> {
  return (await readRefreshToken()) !== null;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'No connection to the server');
  }

  if (res.status === 401 && retry) {
    const token = await refreshSession();
    if (token) return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Session ─────────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<SessionResponse> {
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pulse-client': 'native' },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);

  if (!res) throw new ApiError(0, 'No connection to the server');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? 'Could not sign in');
  }
  return adopt((await res.json()) as SessionResponse);
}

export async function logout(): Promise<void> {
  const stored = await readRefreshToken();
  await writeRefreshToken(null);
  setAccessToken(null);
  // Best effort: the local session is already gone, and a failure here only
  // leaves a row the server expires on its own.
  if (stored) {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stored }),
    }).catch(() => undefined);
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  maxDevices: number;
  maxVariablesPerDevice: number;
  maxVariablesTotal: number;
  maxDashboards: number;
  retentionDays: number;
  minIntervalS: number;
  monthlyDatapoints: number;
  priceCents: number;
}

export interface Device {
  id: string;
  name: string;
  deviceKey: string;
  description: string | null;
  intervalS: number;
  timezone: string;
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  lastTransport: string | null;
  messageCount: number;
  pointCount: number;
  variableCount?: number;
}

export type VariableType = 'int' | 'float' | 'bool' | 'string';

/** A row of GET /devices/:id/state — the variable and its newest value. */
export interface VariableState {
  variableId: string;
  key: string;
  label: string | null;
  unit: string | null;
  /** The four the database allows — not 'number'/'boolean', which never occur. */
  type: VariableType;
  writable: boolean;
  color: string | null;
  ts: string | null;
  valueNum: number | null;
  valueText: string | null;
}

/** A point from GET /variables/:id/series. `t` is epoch milliseconds. */
export interface SeriesPoint {
  t: number;
  v: number | null;
  min?: number | null;
  max?: number | null;
  s?: string | null;
}

export interface Series {
  variable: { id: string; key: string; label: string | null; type: string; unit: string | null; color: string | null };
  from: number;
  to: number;
  resolution: string;
  points: SeriesPoint[];
}

export interface Dashboard {
  id: string;
  name: string;
  slug: string;
  widgetCount?: number;
}

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
  pulseMs?: number;
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
}

export interface UsageResponse {
  plan: Plan;
  usage: {
    devices: number;
    devicesOnline: number;
    variables: number;
    dashboards: number;
    messages: number;
    points: number;
  };
  month: {
    month: string;
    datapoints: number;
    limit: number;
    fraction: number;
    warned: boolean;
    blocked: boolean;
  };
}
