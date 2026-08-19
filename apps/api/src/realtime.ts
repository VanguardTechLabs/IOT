import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { eq, and } from 'drizzle-orm';
import {
  CHANNELS,
  createLogger,
  createRedis,
  db,
  env,
  tables,
  type CommandEvent,
  type StatusEvent,
  type TelemetryEvent,
  type VariableEvent,
} from '@pulse/core';

const log = createLogger('realtime');

interface SocketAuth {
  userId: string;
}

/**
 * Browser fan-out.
 *
 * Ingest happens in a separate process, so live updates arrive here over Redis
 * pub/sub rather than in-process. That indirection is what lets the API scale
 * horizontally: every instance subscribes, and each one pushes only to the
 * sockets it actually holds.
 */
export function attachRealtime(server: HttpServer, verifyToken: (token: string) => SocketAuth | null): SocketServer {
  const io = new SocketServer(server, {
    path: '/socket.io',
    serveClient: false,
    // Mirrors the REST CORS policy. Pinning to PUBLIC_URL unconditionally would
    // break `pnpm dev`, where the page is served from Vite on another port.
    cors: { origin: env.NODE_ENV === 'production' ? [env.PUBLIC_URL] : true, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    const auth = token ? verifyToken(token) : null;
    if (!auth) return next(new Error('unauthorized'));
    socket.data.userId = auth.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    void socket.join(`user:${userId}`);

    socket.on('subscribe:device', async (deviceId: string, ack?: (ok: boolean) => void) => {
      if (typeof deviceId !== 'string') return ack?.(false);
      const rows = await db
        .select({ id: tables.devices.id })
        .from(tables.devices)
        .where(and(eq(tables.devices.id, deviceId), eq(tables.devices.userId, userId)))
        .limit(1);
      if (rows.length === 0) return ack?.(false);
      await socket.join(`device:${deviceId}`);
      ack?.(true);
    });

    socket.on('unsubscribe:device', (deviceId: string) => {
      if (typeof deviceId === 'string') void socket.leave(`device:${deviceId}`);
    });
  });

  const subscriber = createRedis('rt-sub');
  void subscriber.subscribe(CHANNELS.telemetry, CHANNELS.status, CHANNELS.variable, CHANNELS.command);

  subscriber.on('message', (channel, raw) => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    switch (channel) {
      case CHANNELS.telemetry: {
        const event = payload as TelemetryEvent;
        io.to(`device:${event.deviceId}`).emit('telemetry', event);
        break;
      }
      case CHANNELS.status: {
        const event = payload as StatusEvent;
        // Status drives the device list too, so it also goes to the account room.
        io.to(`user:${event.userId}`).emit('device:status', event);
        break;
      }
      case CHANNELS.variable: {
        const event = payload as VariableEvent;
        io.to(`device:${event.deviceId}`).emit('variable:created', event);
        io.to(`user:${event.userId}`).emit('variable:created', event);
        break;
      }
      case CHANNELS.command: {
        const event = payload as CommandEvent;
        io.to(`device:${event.deviceId}`).emit('command', event);
        break;
      }
    }
  });

  subscriber.on('error', (err) => log.error({ err: err.message }, 'realtime subscriber error'));

  return io;
}
