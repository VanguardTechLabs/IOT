import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  assertCanAddVariable,
  broadcastInvalidation,
  db,
  tables,
  variableKeySchema,
  variableTypeSchema,
} from '@pulse/core';
import { conflict, notFound, parse, uuidParam } from '../lib/http.js';
import { requireOwnedDevice } from './devices.js';

const createSchema = z.object({
  key: variableKeySchema,
  label: z.string().trim().min(1).max(80).optional(),
  type: variableTypeSchema.default('float'),
  unit: z.string().trim().max(16).optional().default(''),
  writable: z.boolean().optional().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ key: true });

const columns = {
  id: tables.variables.id,
  deviceId: tables.variables.deviceId,
  key: tables.variables.key,
  label: tables.variables.label,
  type: tables.variables.type,
  unit: tables.variables.unit,
  writable: tables.variables.writable,
  color: tables.variables.color,
  minValue: tables.variables.minValue,
  maxValue: tables.variables.maxValue,
  sortOrder: tables.variables.sortOrder,
  createdAt: tables.variables.createdAt,
};

async function requireOwnedVariable(userId: string, variableId: string) {
  const rows = await db
    .select({ ...columns, deviceKey: tables.devices.deviceKey })
    .from(tables.variables)
    .innerJoin(tables.devices, eq(tables.devices.id, tables.variables.deviceId))
    .where(and(eq(tables.variables.id, variableId), eq(tables.devices.userId, userId)))
    .limit(1);
  const variable = rows[0];
  if (!variable) throw notFound('Variable not found');
  return variable;
}

export { requireOwnedVariable };

export const variableRoutes: FastifyPluginAsync = async (app) => {
  app.get('/devices/:id/variables', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    await requireOwnedDevice(auth.id, id);

    const rows = await db
      .select({
        ...columns,
        lastTs: tables.variableState.ts,
        lastNum: tables.variableState.valueNum,
        lastText: tables.variableState.valueText,
      })
      .from(tables.variables)
      .leftJoin(tables.variableState, eq(tables.variableState.variableId, tables.variables.id))
      .where(eq(tables.variables.deviceId, id))
      .orderBy(asc(tables.variables.sortOrder), asc(tables.variables.key));

    return { variables: rows };
  });

  app.post('/devices/:id/variables', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(createSchema, req.body);
    const device = await requireOwnedDevice(auth.id, id);
    await assertCanAddVariable(auth.id, id);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.variables)
      .where(eq(tables.variables.deviceId, id));

    const inserted = await db
      .insert(tables.variables)
      .values({
        deviceId: id,
        key: body.key,
        label: body.label ?? body.key,
        type: body.type,
        unit: body.unit ?? '',
        writable: body.writable ?? false,
        color: body.color ?? '#38bdf8',
        minValue: body.minValue ?? null,
        maxValue: body.maxValue ?? null,
        sortOrder: count,
      })
      .onConflictDoNothing({ target: [tables.variables.deviceId, tables.variables.key] })
      .returning(columns);

    if (!inserted[0]) throw conflict(`Variable "${body.key}" already exists on this device`);

    await broadcastInvalidation(device.deviceKey);
    reply.code(201);
    return { variable: inserted[0] };
  });

  app.patch('/variables/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateSchema, req.body);
    const existing = await requireOwnedVariable(auth.id, id);

    const [variable] = await db
      .update(tables.variables)
      .set({
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.writable !== undefined ? { writable: body.writable } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.minValue !== undefined ? { minValue: body.minValue } : {}),
        ...(body.maxValue !== undefined ? { maxValue: body.maxValue } : {}),
      })
      .where(eq(tables.variables.id, id))
      .returning(columns);

    await broadcastInvalidation(existing.deviceKey);
    return { variable };
  });

  app.delete('/variables/:id', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const existing = await requireOwnedVariable(auth.id, id);

    // variable_state cascades; the hypertable rows are left for the retention
    // policy rather than blocking this request on a cross-chunk DELETE.
    await db.delete(tables.variables).where(eq(tables.variables.id, id));
    await broadcastInvalidation(existing.deviceKey);

    reply.code(204);
    return null;
  });

  app.post('/devices/:id/variables/reorder', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ order: z.array(z.string().uuid()).max(200) }), req.body);
    await requireOwnedDevice(auth.id, id);

    await db.transaction(async (tx) => {
      for (const [index, variableId] of body.order.entries()) {
        await tx
          .update(tables.variables)
          .set({ sortOrder: index })
          .where(and(eq(tables.variables.id, variableId), eq(tables.variables.deviceId, id)));
      }
    });

    return { ok: true };
  });
};
