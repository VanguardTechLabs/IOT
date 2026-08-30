import { io, type Socket } from 'socket.io-client';
import { API_URL, getAccessToken, onTokenChange, refreshSession } from './api';

/**
 * Live telemetry.
 *
 * Mirrors the web client, with one change: an explicit URL, because there is no
 * page origin to be relative to.
 *
 * As on the web, the transport list is deliberately not overridden. Naming
 * websocket first looks like an optimisation, but engine.io-client only walks to
 * the next transport when `tryAllTransports` is set, so any WebSocket failure
 * becomes a permanent outage instead of a silent degrade to polling. On a phone
 * moving between wifi, cellular and captive portals that distinction matters far
 * more than it does on a desktop.
 */

export interface TelemetryPoint {
  variableId: string;
  key: string;
  type: string;
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

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(API_URL, {
    path: '/socket.io',
    auth: (cb) => cb({ token: getAccessToken() }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect_error', async (err: Error) => {
    if (err.message === 'unauthorized') {
      const token = await refreshSession();
      if (token) socket?.connect();
    }
  });

  onTokenChange((token) => {
    if (!socket) return;
    if (token) {
      if (!socket.connected) socket.connect();
    } else {
      socket.disconnect();
    }
  });

  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
