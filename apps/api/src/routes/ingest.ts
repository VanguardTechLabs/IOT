import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeEqualHex, setOnline, sha256Salted, type CachedDevice } from '@pulse/core';
import { getContext } from '../context.js';
import { HttpError, parse, unauthorized } from '../lib/http.js';

const credentialsSchema = z.object({
  key: z.string().min(1).max(64),
  token: z.string().min(1).max(128),
});

/**
 * Device authentication for the non-MQTT transports. Uses exactly the same salted
 * SHA-256 material EMQX checks, so one credential works across all three protocols.
 */
async function authenticateDevice(key: string, token: string): Promise<CachedDevice> {
  const { ingest } = getContext();
  const device = await ingest.resolveDevice(key);
  if (!device || !device.enabled) throw unauthorized('Unknown or disabled device');
  if (!safeEqualHex(device.tokenHash, sha256Salted(token, device.tokenSalt))) {
    throw unauthorized('Invalid device token');
  }
  return device;
}

function readCredentials(req: FastifyRequest): { key: string; token: string } {
  const headerKey = req.headers['x-device-key'];
  const headerToken = req.headers['x-device-token'];
  if (typeof headerKey === 'string' && typeof headerToken === 'string') {
    return parse(credentialsSchema, { key: headerKey, token: headerToken });
  }

  // Also accept `Authorization: Bearer <device-key>:<token>` for constrained clients.
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const [key, ...rest] = auth.slice(7).split(':');
    if (key && rest.length > 0) return parse(credentialsSchema, { key, token: rest.join(':') });
  }

  throw unauthorized('Send X-Device-Key and X-Device-Token headers');
}

export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/ingest',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      bodyLimit: 64 * 1024,
    },
    async (req, reply) => {
      const { key, token } = readCredentials(req);
      const device = await authenticateDevice(key, token);
      const { ingest } = getContext();

      const outcome = await ingest.handleUplink(device, req.body, 'http');
      if (outcome.throttled) throw new HttpError(429, 'Too many messages, slow down', 'rate_limited');
      if (outcome.accepted === 0) {
        reply.code(422);
        return { accepted: 0, rejected: outcome.rejected };
      }
      return { accepted: outcome.accepted, rejected: outcome.rejected, intervalS: device.intervalS };
    },
  );

  /**
   * Persistent WebSocket uplink. Cheaper than HTTP for fast intervals because it
   * skips a TLS handshake and headers per message, and it lets the platform push
   * commands back down the same socket.
   */
  app.get('/ingest/ws', { websocket: true }, async (socket, req) => {
    const query = credentialsSchema.safeParse(req.query);
    if (!query.success) {
      socket.close(1008, 'key and token query parameters are required');
      return;
    }

    let device: CachedDevice;
    try {
      device = await authenticateDevice(query.data.key, query.data.token);
    } catch {
      socket.close(1008, 'authentication failed');
      return;
    }

    const { ingest, redis } = getContext();
    await setOnline(device.id, true, 'ws');

    const downlinkChannel = `pulse:dn:${device.deviceKey}`;
    const subscriber = redis.duplicate();
    await subscriber.subscribe(downlinkChannel);
    subscriber.on('message', (_channel: string, message: string) => {
      if (socket.readyState === socket.OPEN) socket.send(message);
    });

    socket.send(JSON.stringify({ type: 'welcome', deviceKey: device.deviceKey, intervalS: device.intervalS }));

    socket.on('message', async (raw: Buffer) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
        return;
      }

      const outcome = await ingest.handleUplink(device, payload, 'ws');
      socket.send(
        JSON.stringify({
          type: 'ack',
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          throttled: outcome.throttled ?? false,
        }),
      );
    });

    const cleanup = async () => {
      await subscriber.quit().catch(() => undefined);
      await setOnline(device.id, false, 'ws').catch(() => undefined);
    };

    socket.on('close', () => void cleanup());
    socket.on('error', () => void cleanup());
  });
};
