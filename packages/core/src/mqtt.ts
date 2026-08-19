import mqtt, { type MqttClient } from 'mqtt';
import { getPool } from './db/index.js';
import { env } from './env.js';
import { createLogger } from './logger.js';
import { newSalt, sha256Salted } from './crypto.js';

const log = createLogger('mqtt');

/**
 * Registers the backend's broker credentials in `service_accounts`, which the
 * `emqx_authn` view exposes to EMQX as a superuser. Both the API and the ingest
 * worker call this before connecting, so a fresh database never leaves a service
 * unable to reach the broker.
 */
export async function ensureServiceAccount(): Promise<void> {
  const salt = newSalt();
  const hash = sha256Salted(env.MQTT_BACKEND_PASSWORD, salt);
  await getPool().query(
    `INSERT INTO service_accounts (username, password_hash, salt)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt`,
    [env.MQTT_BACKEND_USER, hash, salt],
  );
}

export function connectMqtt(clientIdPrefix: string): MqttClient {
  const client = mqtt.connect(env.MQTT_URL, {
    clientId: `${clientIdPrefix}-${Math.random().toString(16).slice(2, 10)}`,
    username: env.MQTT_BACKEND_USER,
    password: env.MQTT_BACKEND_PASSWORD,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 15_000,
    keepalive: 30,
    protocolVersion: 5,
    resubscribe: true,
  });

  client.on('connect', () => log.info({ url: env.MQTT_URL }, 'broker connected'));
  client.on('reconnect', () => log.warn('broker reconnecting'));
  client.on('error', (err) => log.error({ err: err.message }, 'broker error'));
  client.on('close', () => log.warn('broker connection closed'));

  return client;
}

export const topics = {
  uplink: (deviceKey: string) => `d/${deviceKey}/up`,
  uplinkVariable: (deviceKey: string, key: string) => `d/${deviceKey}/up/${key}`,
  downlink: (deviceKey: string) => `d/${deviceKey}/dn`,
  status: (deviceKey: string) => `d/${deviceKey}/status`,
  allUplinks: 'd/+/up',
  allUplinkVariables: 'd/+/up/+',
  allStatus: 'd/+/status',
};

export function parseTopic(topic: string): { deviceKey: string; kind: string; variable?: string } | null {
  const parts = topic.split('/');
  if (parts.length < 3 || parts[0] !== 'd') return null;
  return { deviceKey: parts[1]!, kind: parts[2]!, variable: parts[3] };
}
