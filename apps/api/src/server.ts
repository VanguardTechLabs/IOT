import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  IngestEngine,
  PlanLimitError,
  closeDatabase,
  connectMqtt,
  createLogger,
  createRedis,
  ensureServiceAccount,
  env,
  listenForInvalidation,
  runMigrations,
  waitForDatabase,
} from '@pulse/core';
import { setContext } from './context.js';
import { HttpError } from './lib/http.js';
import { authPlugin } from './plugins/auth.js';
import { attachRealtime } from './realtime.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { exportRoutes } from './routes/export.js';
import { ingestRoutes } from './routes/ingest.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { variableRoutes } from './routes/variables.js';

const log = createLogger('api');

async function main() {
  await waitForDatabase();
  // Running migrations from the API keeps `docker compose up` a single step; it is
  // idempotent and guarded by the _migrations table, so concurrent replicas are safe.
  await runMigrations();
  await ensureServiceAccount();

  const redis = createRedis('api');
  const mqtt = connectMqtt('pulse-api');
  const ingest = new IngestEngine({ redis });
  setContext({ redis, mqtt, ingest });

  listenForInvalidation(createRedis('api-invalidation'));

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Exactly one hop (Caddy). `true` would walk the whole X-Forwarded-For chain
    // and hand back a client-supplied address, which is what req.ip is keyed on.
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: env.NODE_ENV === 'production',
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false });
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? [env.PUBLIC_URL] : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: '1 minute',
    redis,
    // Must not be derived from a request header: both x-device-key and
    // x-forwarded-for are unauthenticated at this point, so a fresh random value
    // per request would mint a fresh bucket and defeat the /auth brute-force
    // limits entirely. Per-device uplink throttling happens after authentication,
    // in consumeBurstToken().
    keyGenerator: (req) => req.ip,
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(authPlugin);

  app.setErrorHandler((rawError, req, reply) => {
    const error = rawError as Error & { statusCode?: number; code?: string };
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof PlanLimitError) {
      return reply.code(402).send({ error: error.message, code: 'plan_limit', limit: error.limit });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code ?? 'error' });
    }
    req.log.error({ err: error.message, stack: error.stack }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error', code: 'internal' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    writer: ingest.writer.stats(),
  }));

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(deviceRoutes, { prefix: '/devices' });
      await v1.register(variableRoutes);
      await v1.register(telemetryRoutes);
      await v1.register(exportRoutes);
      await v1.register(accountRoutes);
      await v1.register(adminRoutes);
      await v1.register(ingestRoutes);
    },
    { prefix: '/api/v1' },
  );

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  // Socket.IO attaches after Fastify so engine.io can delegate non-/socket.io
  // upgrades back to @fastify/websocket (the device uplink route).
  const io = attachRealtime(app.server, (token) => {
    try {
      const payload = app.jwt.verify<{ sub: string }>(token);
      return { userId: payload.sub };
    } catch {
      return null;
    }
  });

  log.info({ port: env.API_PORT }, 'api listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await io.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await ingest.stop().catch(() => undefined);
    mqtt.end(true);
    await redis.quit().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Backstop. Node's default for an unhandled rejection is to terminate, which on
  // a telemetry ingest process means dropping whatever is still buffered. Every
  // known path is guarded; this is here so an unknown one degrades to a log line.
  process.on('unhandledRejection', (err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled rejection');
  });
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, 'api failed to start');
  process.exit(1);
});
