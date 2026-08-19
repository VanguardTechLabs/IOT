import {
  IngestEngine,
  closeDatabase,
  connectMqtt,
  createLogger,
  createRedis,
  ensureServiceAccount,
  listenForInvalidation,
  parseTopic,
  runMigrations,
  setOnline,
  sweepOfflineDevices,
  topics,
  waitForDatabase,
} from '@pulse/core';

const log = createLogger('ingest-worker');

const SWEEP_INTERVAL_MS = 15_000;
const STATS_INTERVAL_MS = 60_000;

async function main() {
  await waitForDatabase();
  // Serialised against the API by an advisory lock inside runMigrations. Without
  // this the worker would reach ensureServiceAccount() before the API had created
  // service_accounts and crash-loop until it caught up.
  await runMigrations();
  await ensureServiceAccount();

  const redis = createRedis('ingest');
  const engine = new IngestEngine({ redis });
  listenForInvalidation(createRedis('ingest-invalidation'));

  const client = connectMqtt('pulse-ingest');

  client.on('connect', () => {
    client.subscribe(
      [topics.allUplinks, topics.allUplinkVariables, topics.allStatus],
      { qos: 1 },
      (err, granted) => {
        if (err) log.error({ err: err.message }, 'subscribe failed');
        else log.info({ topics: granted?.map((g) => g.topic) }, 'subscribed');
      },
    );
  });

  client.on('message', (topic, payload) => {
    void handleMessage(topic, payload);
  });

  async function handleMessage(topic: string, payload: Buffer) {
    const parts = parseTopic(topic);
    if (!parts) return;

    const device = await engine.resolveDevice(parts.deviceKey);
    if (!device) {
      // The broker already authenticated this client, so a miss here means the
      // device was deleted between connecting and publishing.
      log.warn({ topic }, 'message for unknown device');
      return;
    }

    if (parts.kind === 'status') {
      const text = payload.toString('utf8').trim().toLowerCase();
      const online = text === 'online' || text === '1' || text === 'true';
      await setOnline(device.id, online, 'mqtt');
      return;
    }

    if (parts.kind !== 'up') return;

    // `d/<key>/up/<variable>` carries a bare scalar; `d/<key>/up` carries the batch.
    if (parts.variable) {
      await engine.handleUplink(device, payload.toString('utf8'), 'mqtt', parts.variable);
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      log.debug({ topic }, 'dropped non-JSON uplink');
      return;
    }
    await engine.handleUplink(device, body, 'mqtt');
  }

  const sweepTimer = setInterval(() => {
    void sweepOfflineDevices().catch((err) => log.error({ err: err.message }, 'offline sweep failed'));
  }, SWEEP_INTERVAL_MS);

  const statsTimer = setInterval(() => {
    log.info(engine.writer.stats(), 'writer stats');
  }, STATS_INTERVAL_MS);

  log.info('ingest worker running');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearInterval(sweepTimer);
    clearInterval(statsTimer);
    client.end(true);
    await engine.stop().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, 'ingest worker failed to start');
  process.exit(1);
});
