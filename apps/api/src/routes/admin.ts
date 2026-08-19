import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { broadcastInvalidation, db, getPool, tables } from '@pulse/core';
import { conflict, forbidden, notFound, parse, uuidParam } from '../lib/http.js';

/**
 * Platform administration.
 *
 * The first account to register becomes an admin (see routes/auth.ts) so a fresh
 * deployment is never locked out; every later promotion happens from here.
 */
async function requireAdmin(app: { requireAuth: (req: FastifyRequest) => Promise<{ id: string; role: string }> }, req: FastifyRequest) {
  const auth = await app.requireAuth(req);
  if (auth.role !== 'admin') throw forbidden('Administrator access required');
  return auth;
}

/** Timescale helpers are wrapped: a plain-Postgres dev database must still work. */
async function safeScalar<T>(sqlText: string, fallback: T): Promise<T> {
  try {
    const { rows } = await getPool().query<{ value: T }>(sqlText);
    return rows[0]?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/overview', async (req) => {
    await requireAdmin(app, req);

    const [userStats] = await db
      .select({
        users: sql<number>`count(*)::int`,
        admins: sql<number>`count(*) FILTER (WHERE ${tables.users.role} = 'admin')::int`,
      })
      .from(tables.users);

    const [deviceStats] = await db
      .select({
        devices: sql<number>`count(*)::int`,
        online: sql<number>`count(*) FILTER (WHERE ${tables.devices.online})::int`,
        disabled: sql<number>`count(*) FILTER (WHERE NOT ${tables.devices.enabled})::int`,
        messages: sql<number>`COALESCE(sum(${tables.devices.messageCount}), 0)::bigint`,
        points: sql<number>`COALESCE(sum(${tables.devices.pointCount}), 0)::bigint`,
      })
      .from(tables.devices);

    const [variableStats] = await db
      .select({ variables: sql<number>`count(*)::int` })
      .from(tables.variables);

    const byPlan = await db
      .select({ planId: tables.users.planId, count: sql<number>`count(*)::int` })
      .from(tables.users)
      .groupBy(tables.users.planId);

    // approximate_row_count avoids a full scan of the hypertable; on a 200M-row
    // table an exact count(*) would take minutes and lock nothing useful.
    const telemetryRows = await safeScalar<number>(
      `SELECT approximate_row_count('telemetry')::bigint AS value`,
      0,
    );
    const telemetryBytes = await safeScalar<number>(
      `SELECT hypertable_size('telemetry')::bigint AS value`,
      0,
    );
    const databaseBytes = await safeScalar<number>(
      `SELECT pg_database_size(current_database())::bigint AS value`,
      0,
    );

    return {
      users: { total: userStats?.users ?? 0, admins: userStats?.admins ?? 0, byPlan },
      devices: {
        total: deviceStats?.devices ?? 0,
        online: deviceStats?.online ?? 0,
        disabled: deviceStats?.disabled ?? 0,
        messages: Number(deviceStats?.messages ?? 0),
        points: Number(deviceStats?.points ?? 0),
      },
      variables: variableStats?.variables ?? 0,
      storage: {
        telemetryRows: Number(telemetryRows),
        telemetryBytes: Number(telemetryBytes),
        databaseBytes: Number(databaseBytes),
      },
    };
  });

  app.get('/admin/users', async (req) => {
    await requireAdmin(app, req);
    const query = parse(
      z.object({ search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
      req.query,
    );

    const where = query.search
      ? or(ilike(tables.users.email, `%${query.search}%`), ilike(tables.users.name, `%${query.search}%`))
      : undefined;

    const rows = await db
      .select({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        planId: tables.users.planId,
        createdAt: tables.users.createdAt,
        deviceCount: sql<number>`(SELECT count(*)::int FROM devices d WHERE d.user_id = ${tables.users.id})`,
        onlineCount: sql<number>`(SELECT count(*)::int FROM devices d WHERE d.user_id = ${tables.users.id} AND d.online)`,
        messageCount: sql<number>`(SELECT COALESCE(sum(d.message_count), 0)::bigint FROM devices d WHERE d.user_id = ${tables.users.id})`,
      })
      .from(tables.users)
      .where(where)
      .orderBy(desc(tables.users.createdAt))
      .limit(query.limit);

    return { users: rows.map((r) => ({ ...r, messageCount: Number(r.messageCount) })) };
  });

  app.patch('/admin/users/:id', async (req) => {
    const auth = await requireAdmin(app, req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        role: z.enum(['user', 'admin']).optional(),
        planId: z.string().trim().min(1).max(40).optional(),
        name: z.string().trim().min(1).max(80).optional(),
      }),
      req.body,
    );

    if (body.role === 'user' && id === auth.id) {
      throw conflict('You cannot remove your own administrator access');
    }

    if (body.planId) {
      const plan = await db.select({ id: tables.plans.id }).from(tables.plans).where(eq(tables.plans.id, body.planId)).limit(1);
      if (plan.length === 0) throw notFound(`Unknown plan "${body.planId}"`);
    }

    const updated = await db
      .update(tables.users)
      .set({
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tables.users.id, id))
      .returning({
        id: tables.users.id,
        email: tables.users.email,
        name: tables.users.name,
        role: tables.users.role,
        planId: tables.users.planId,
      });

    if (updated.length === 0) throw notFound('User not found');

    // A plan change moves the per-device variable ceiling, which the ingest
    // registry caches — drop the cached entry for every device this user owns.
    const owned = await db
      .select({ deviceKey: tables.devices.deviceKey })
      .from(tables.devices)
      .where(eq(tables.devices.userId, id));
    for (const device of owned) await broadcastInvalidation(device.deviceKey);

    return { user: updated[0] };
  });

  app.delete('/admin/users/:id', async (req, reply) => {
    const auth = await requireAdmin(app, req);
    const { id } = parse(uuidParam, req.params);
    if (id === auth.id) throw conflict('You cannot delete your own account from here');

    const owned = await db
      .select({ deviceKey: tables.devices.deviceKey })
      .from(tables.devices)
      .where(eq(tables.devices.userId, id));

    const deleted = await db.delete(tables.users).where(eq(tables.users.id, id)).returning({ id: tables.users.id });
    if (deleted.length === 0) throw notFound('User not found');

    // Devices and variables cascade. The hypertable rows are deliberately left to
    // the retention policy — a DELETE spanning every chunk would block this request
    // for minutes on an account with real history.
    for (const device of owned) await broadcastInvalidation(device.deviceKey);

    reply.code(204);
    return null;
  });

  app.get('/admin/devices', async (req) => {
    await requireAdmin(app, req);
    const query = parse(
      z.object({ search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );

    const where = query.search
      ? or(
          ilike(tables.devices.name, `%${query.search}%`),
          ilike(tables.devices.deviceKey, `%${query.search}%`),
          ilike(tables.users.email, `%${query.search}%`),
        )
      : undefined;

    const rows = await db
      .select({
        id: tables.devices.id,
        deviceKey: tables.devices.deviceKey,
        name: tables.devices.name,
        online: tables.devices.online,
        enabled: tables.devices.enabled,
        intervalS: tables.devices.intervalS,
        lastSeenAt: tables.devices.lastSeenAt,
        lastTransport: tables.devices.lastTransport,
        messageCount: tables.devices.messageCount,
        pointCount: tables.devices.pointCount,
        createdAt: tables.devices.createdAt,
        ownerId: tables.users.id,
        ownerEmail: tables.users.email,
        ownerName: tables.users.name,
      })
      .from(tables.devices)
      .innerJoin(tables.users, eq(tables.users.id, tables.devices.userId))
      .where(where)
      .orderBy(desc(tables.devices.lastSeenAt))
      .limit(query.limit);

    return { devices: rows };
  });

  app.patch('/admin/devices/:id', async (req) => {
    await requireAdmin(app, req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ enabled: z.boolean() }), req.body);

    const updated = await db
      .update(tables.devices)
      .set({ enabled: body.enabled, updatedAt: new Date() })
      .where(eq(tables.devices.id, id))
      .returning({ id: tables.devices.id, deviceKey: tables.devices.deviceKey, enabled: tables.devices.enabled });

    if (updated.length === 0) throw notFound('Device not found');

    // Disabling drops the device out of emqx_authn, so the broker rejects its next
    // connect; invalidating the cache closes the HTTP and WebSocket paths too.
    await broadcastInvalidation(updated[0]!.deviceKey);
    return { device: updated[0] };
  });
};
