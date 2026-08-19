/**
 * Drives every provisioned simulated device over MQTT, one message per cycle
 * carrying all nine variables — exactly the shape the real firmware uses.
 *
 *   pnpm --filter @pulse/simulator start -- --interval 10 --devices 100
 */
import { readFile } from 'node:fs/promises';
import mqtt, { type MqttClient } from 'mqtt';
import { createLogger, env } from '@pulse/core';

const log = createLogger('simulator');

interface Credential {
  deviceKey: string;
  token: string;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

/** Smooth, device-specific signals so the charts look like real sensors. */
function makeSensors(seed: number) {
  let phase = seed;
  return () => {
    phase += 0.05;
    const temp = 22 + Math.sin(phase) * 4 + Math.random() * 0.3;
    const hum = 55 + Math.cos(phase * 0.7) * 12 + Math.random() * 0.5;
    return {
      temp: temp.toFixed(2),
      hum: hum.toFixed(1),
      pressure: (1013 + Math.sin(phase * 0.3) * 6).toFixed(1),
      lux: String(Math.max(0, Math.round(500 + Math.sin(phase * 0.5) * 400 + Math.random() * 40))),
      voltage: (3.3 + Math.sin(phase * 1.3) * 0.05).toFixed(3),
      current: (0.4 + Math.random() * 0.2).toFixed(3),
      rssi: String(Math.round(-55 - Math.random() * 20)),
      button: Math.random() < 0.03 ? '1' : '0',
      relay: temp > 25 ? '1' : '0',
    };
  };
}

async function main() {
  const intervalS = Number.parseInt(arg('interval', '10'), 10);
  const limit = Number.parseInt(arg('devices', '0'), 10);
  const file = arg('file', 'simulated-devices.json');

  const raw = await readFile(file, 'utf8').catch(() => {
    throw new Error(`${file} not found — run the provision script first`);
  });
  let credentials = JSON.parse(raw) as Credential[];
  if (limit > 0) credentials = credentials.slice(0, limit);

  log.info({ devices: credentials.length, intervalS, broker: env.MQTT_URL }, 'starting simulation');

  let published = 0;
  let failed = 0;
  const clients: MqttClient[] = [];
  const timers: NodeJS.Timeout[] = [];

  credentials.forEach((credential, index) => {
    const statusTopic = `d/${credential.deviceKey}/status`;
    const client = mqtt.connect(env.MQTT_URL, {
      clientId: `sim-${credential.deviceKey}`,
      username: credential.deviceKey,
      password: credential.token,
      clean: true,
      reconnectPeriod: 5000,
      keepalive: Math.max(15, intervalS * 2),
      will: { topic: statusTopic, payload: Buffer.from('offline'), qos: 1, retain: true },
    });

    const sensors = makeSensors(index * 0.37);
    let started = false;

    client.on('connect', () => {
      client.publish(statusTopic, 'online', { qos: 1, retain: true });
      client.subscribe(`d/${credential.deviceKey}/dn`, { qos: 1 });

      // 'connect' fires again on every reconnect. Without this guard each
      // reconnect would stack another interval and silently multiply the publish
      // rate, which would make the load-test numbers meaningless.
      if (started) return;
      started = true;

      // Spread the fleet across the interval so the broker sees a steady rate
      // rather than a thundering herd every N seconds.
      const jitter = Math.floor((index / credentials.length) * intervalS * 1000);
      setTimeout(() => {
        const publish = () => {
          if (!client.connected) return;
          const payload = JSON.stringify({ ts: Math.floor(Date.now() / 1000), v: sensors() });
          client.publish(`d/${credential.deviceKey}/up`, payload, { qos: 0 }, (err) => {
            if (err) failed += 1;
            else published += 1;
          });
        };
        publish();
        timers.push(setInterval(publish, intervalS * 1000));
      }, jitter);
    });

    client.on('message', (topic, payload) => {
      log.debug({ device: credential.deviceKey, topic, command: payload.toString('utf8') }, 'command received');
    });

    client.on('error', (err) => log.warn({ device: credential.deviceKey, err: err.message }, 'client error'));
    clients.push(client);
  });

  setInterval(() => {
    log.info(
      { published, failed, rate: `${(published / 10).toFixed(1)} msg/s`, devices: clients.length },
      'simulation throughput',
    );
    published = 0;
    failed = 0;
  }, 10_000);

  const shutdown = () => {
    log.info('stopping simulation');
    for (const timer of timers) clearInterval(timer);
    for (const client of clients) client.end(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err: err.message }, 'simulator failed');
  process.exit(1);
});
