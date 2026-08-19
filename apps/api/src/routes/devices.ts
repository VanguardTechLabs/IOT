import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  assertCanAddDevice,
  broadcastInvalidation,
  clampInterval,
  db,
  downlinkChannel,
  env,
  getUserPlan,
  newDeviceKey,
  newDeviceToken,
  newSalt,
  preview,
  sha256Salted,
  tables,
  timeZoneSchema,
  topics,
} from '@pulse/core';
import type { MqttClient } from 'mqtt';
import type { Redis } from 'ioredis';
import { getContext } from '../context.js';
import { notFound, parse, uuidParam } from '../lib/http.js';

const DOWNLINK_PUBLISH_TIMEOUT_MS = 3_000;

/**
 * Sends one downlink frame on both paths — MQTT for broker-attached devices, Redis
 * for the WebSocket uplink — and never lets a sick broker stall the HTTP request.
 * mqtt.js buffers publishes while disconnected and only fires the callback after it
 * reconnects, so the wait is bounded and a timeout is reported, not thrown.
 *
 * Returns whether the MQTT leg was acknowledged; the Redis leg is awaited directly.
 */
async function publishDownlink(
  mqtt: MqttClient,
  redis: Redis,
  deviceKey: string,
  frame: string,
  retain: boolean,
): Promise<boolean> {
  await redis.publish(downlinkChannel(deviceKey), frame);
  return Promise.race([
    new Promise<boolean>((resolve) =>
      mqtt.publish(topics.downlink(deviceKey), frame, { qos: 1, retain }, (err) => resolve(!err)),
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DOWNLINK_PUBLISH_TIMEOUT_MS)),
  ]);
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional().default(''),
  intervalS: z.number().int().min(1).max(86_400).optional(),
  timezone: timeZoneSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(280).optional(),
  intervalS: z.number().int().min(1).max(86_400).optional(),
  timezone: timeZoneSchema.optional(),
  enabled: z.boolean().optional(),
  autoCreateVariables: z.boolean().optional(),
});

const deviceColumns = {
  id: tables.devices.id,
  deviceKey: tables.devices.deviceKey,
  name: tables.devices.name,
  description: tables.devices.description,
  intervalS: tables.devices.intervalS,
  timezone: tables.devices.timezone,
  enabled: tables.devices.enabled,
  autoCreateVariables: tables.devices.autoCreateVariables,
  online: tables.devices.online,
  lastSeenAt: tables.devices.lastSeenAt,
  lastTransport: tables.devices.lastTransport,
  messageCount: tables.devices.messageCount,
  pointCount: tables.devices.pointCount,
  tokenPreview: tables.devices.tokenPreview,
  createdAt: tables.devices.createdAt,
};

export async function requireOwnedDevice(userId: string, deviceId: string) {
  const rows = await db
    .select(deviceColumns)
    .from(tables.devices)
    .where(and(eq(tables.devices.id, deviceId), eq(tables.devices.userId, userId)))
    .limit(1);
  const device = rows[0];
  if (!device) throw notFound('Device not found');
  return device;
}

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const auth = await app.requireAuth(req);
    const rows = await db
      .select({
        ...deviceColumns,
        variableCount: sql<number>`(SELECT count(*)::int FROM variables v WHERE v.device_id = ${tables.devices.id})`,
      })
      .from(tables.devices)
      .where(eq(tables.devices.userId, auth.id))
      .orderBy(desc(tables.devices.createdAt));
    return { devices: rows };
  });

  app.post('/', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = parse(createSchema, req.body);
    const plan = await assertCanAddDevice(auth.id);

    const token = newDeviceToken();
    const salt = newSalt();
    const [device] = await db
      .insert(tables.devices)
      .values({
        userId: auth.id,
        deviceKey: newDeviceKey(),
        name: body.name,
        description: body.description ?? '',
        tokenHash: sha256Salted(token, salt),
        tokenSalt: salt,
        tokenPreview: preview(token),
        intervalS: clampInterval(body.intervalS ?? 10, plan),
        timezone: body.timezone ?? 'UTC',
      })
      .returning(deviceColumns);

    reply.code(201);
    // The plaintext token exists only in this response.
    return { device, token };
  });

  app.get('/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    return { device: await requireOwnedDevice(auth.id, id) };
  });

  app.patch('/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateSchema, req.body);
    await requireOwnedDevice(auth.id, id);
    const plan = await getUserPlan(auth.id);

    const [device] = await db
      .update(tables.devices)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.intervalS !== undefined ? { intervalS: clampInterval(body.intervalS, plan) } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.autoCreateVariables !== undefined
          ? { autoCreateVariables: body.autoCreateVariables }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(tables.devices.id, id))
      .returning(deviceColumns);

    await broadcastInvalidation(device!.deviceKey);

    // A changed interval has to reach the firmware, otherwise the panel field is
    // decorative. Retained, so EMQX replays it the moment the sketch subscribes to
    // d/<key>/dn — which is what makes the "applied on next connect" hint true.
    if (body.intervalS !== undefined) {
      const { mqtt, redis } = getContext();
      const frame = JSON.stringify({ interval: String(device!.intervalS) });
      await publishDownlink(mqtt, redis, device!.deviceKey, frame, true);
    }

    return { device };
  });

  app.delete('/:id', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const device = await requireOwnedDevice(auth.id, id);

    // Only the relational rows are removed here. Deleting the matching telemetry
    // would mean a DELETE across every chunk of the hypertable — on a device with
    // 30 days of history that decompresses compressed chunks and blocks the request
    // for minutes. The orphaned rows are unreachable (their variables are gone) and
    // the retention policy drops them within the retention window.
    await db.delete(tables.devices).where(eq(tables.devices.id, id));
    await broadcastInvalidation(device.deviceKey);

    reply.code(204);
    return null;
  });

  app.post('/:id/rotate-token', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const existing = await requireOwnedDevice(auth.id, id);

    const token = newDeviceToken();
    const salt = newSalt();
    await db
      .update(tables.devices)
      .set({ tokenHash: sha256Salted(token, salt), tokenSalt: salt, tokenPreview: preview(token), updatedAt: new Date() })
      .where(eq(tables.devices.id, id));

    await broadcastInvalidation(existing.deviceKey);
    return { token, tokenPreview: preview(token) };
  });

  /** Everything a firmware author needs, rendered from the live configuration. */
  app.get('/:id/connection', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const device = await requireOwnedDevice(auth.id, id);

    return {
      deviceKey: device.deviceKey,
      tokenPreview: device.tokenPreview,
      intervalS: device.intervalS,
      mqtt: {
        host: env.PUBLIC_MQTT_HOST,
        port: env.PUBLIC_MQTT_PORT,
        wsPort: env.PUBLIC_MQTT_WS_PORT,
        username: device.deviceKey,
        password: '<device token>',
        publishTopic: topics.uplink(device.deviceKey),
        subscribeTopic: topics.downlink(device.deviceKey),
        statusTopic: topics.status(device.deviceKey),
      },
      http: {
        url: `${env.PUBLIC_URL}/api/v1/ingest`,
        method: 'POST',
        headers: { 'X-Device-Key': device.deviceKey, 'X-Device-Token': '<device token>' },
      },
      websocket: {
        url: `${env.PUBLIC_URL.replace(/^http/, 'ws')}/api/v1/ingest/ws?key=${device.deviceKey}&token=<device token>`,
      },
      payloadExample: { ts: 1730000000, v: { temp: '23.5', relay: '1', mode: 'auto' } },
    };
  });

  app.get('/:id/commands', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    await requireOwnedDevice(auth.id, id);

    const rows = await db
      .select({
        id: tables.commands.id,
        key: tables.commands.key,
        value: tables.commands.value,
        source: tables.commands.source,
        createdAt: tables.commands.createdAt,
      })
      .from(tables.commands)
      .where(eq(tables.commands.deviceId, id))
      .orderBy(desc(tables.commands.createdAt))
      .limit(50);

    return { commands: rows };
  });

  app.post('/:id/commands', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ key: z.string().trim().min(1).max(48), value: z.union([z.string(), z.number(), z.boolean()]) }),
      req.body,
    );
    const device = await requireOwnedDevice(auth.id, id);

    const variableRows = await db
      .select({ id: tables.variables.id, type: tables.variables.type, writable: tables.variables.writable })
      .from(tables.variables)
      .where(and(eq(tables.variables.deviceId, id), eq(tables.variables.key, body.key)))
      .limit(1);

    const variable = variableRows[0];
    if (!variable) throw notFound(`Device has no variable "${body.key}"`);
    if (!variable.writable) throw notFound(`Variable "${body.key}" is not marked as writable`);

    // Devices parse strings; the panel converts here so firmware stays trivial.
    const value = typeof body.value === 'boolean' ? (body.value ? '1' : '0') : String(body.value);
    const frame = JSON.stringify({ [body.key]: value });

    // Audit row and the WebSocket leg first: neither depends on the broker, and a
    // device attached over the WS uplink must still get its command when MQTT is
    // down. The MQTT publish is then bounded, because mqtt.js queues the callback
    // until it reconnects — which used to hang this request indefinitely.
    const { mqtt, redis } = getContext();

    await db.insert(tables.commands).values({
      deviceId: id,
      variableId: variable.id,
      key: body.key,
      value,
      issuedBy: auth.id,
      source: 'panel',
    });

    const mqttOk = await publishDownlink(mqtt, redis, device.deviceKey, frame, false);

    return { ok: true, key: body.key, value, mqtt: mqttOk };
  });
};
