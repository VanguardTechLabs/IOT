import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, getUserPlan, listPlans, newApiKey, preview, sha256, tables } from '@pulse/core';
import { notFound, parse, uuidParam } from '../lib/http.js';

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get('/plans', async () => ({ plans: await listPlans() }));

  /** Plan, live usage and storage footprint — the page a paid tier will upsell from. */
  app.get('/account/usage', async (req) => {
    const auth = await app.requireAuth(req);
    const plan = await getUserPlan(auth.id);

    const [counts] = await db
      .select({
        deviceCount: sql<number>`count(*)::int`,
        onlineCount: sql<number>`count(*) FILTER (WHERE ${tables.devices.online})::int`,
        messageCount: sql<number>`COALESCE(sum(${tables.devices.messageCount}), 0)::bigint`,
        pointCount: sql<number>`COALESCE(sum(${tables.devices.pointCount}), 0)::bigint`,
      })
      .from(tables.devices)
      .where(eq(tables.devices.userId, auth.id));

    const [variableCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.variables)
      .innerJoin(tables.devices, eq(tables.devices.id, tables.variables.deviceId))
      .where(eq(tables.devices.userId, auth.id));

    return {
      plan,
      usage: {
        devices: counts?.deviceCount ?? 0,
        devicesOnline: counts?.onlineCount ?? 0,
        variables: variableCount?.count ?? 0,
        messages: Number(counts?.messageCount ?? 0),
        points: Number(counts?.pointCount ?? 0),
      },
    };
  });

  app.get('/account/api-keys', async (req) => {
    const auth = await app.requireAuth(req);
    const rows = await db
      .select({
        id: tables.apiKeys.id,
        name: tables.apiKeys.name,
        keyPreview: tables.apiKeys.keyPreview,
        lastUsedAt: tables.apiKeys.lastUsedAt,
        createdAt: tables.apiKeys.createdAt,
      })
      .from(tables.apiKeys)
      .where(eq(tables.apiKeys.userId, auth.id))
      .orderBy(desc(tables.apiKeys.createdAt));
    return { apiKeys: rows };
  });

  app.post('/account/api-keys', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);

    const key = newApiKey();
    const [created] = await db
      .insert(tables.apiKeys)
      .values({ userId: auth.id, name: body.name, keyHash: sha256(key), keyPreview: preview(key) })
      .returning({ id: tables.apiKeys.id, name: tables.apiKeys.name, keyPreview: tables.apiKeys.keyPreview, createdAt: tables.apiKeys.createdAt });

    reply.code(201);
    return { apiKey: created, key };
  });

  app.delete('/account/api-keys/:id', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const deleted = await db
      .delete(tables.apiKeys)
      .where(and(eq(tables.apiKeys.id, id), eq(tables.apiKeys.userId, auth.id)))
      .returning({ id: tables.apiKeys.id });
    if (deleted.length === 0) throw notFound('API key not found');
    reply.code(204);
    return null;
  });
};
