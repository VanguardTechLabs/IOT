import { io, type Socket } from 'socket.io-client';
import { getAccessToken, onTokenChange, refreshSession } from './api';

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

  socket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: getAccessToken() }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  // A dropped connection usually means the access token aged out mid-session.
  socket.on('connect_error', async (err) => {
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
