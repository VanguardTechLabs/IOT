import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, tables } from '@pulse/core';
import { badRequest, notFound, parse, uuidParam } from '../lib/http.js';

/**
 * User-composed dashboards.
 *
 * The device page keeps its fixed one-tile-per-variable layout; this is the
 * freeform alternative. Positions are grid units on a 12-column grid so the same
 * config renders at any width — and, later, in the mobile app.
 */

export const WIDGET_TYPES = [
  'gauge',
  'tank',
  'thermometer',
  'number',
  'chart',
  'toggle',
  'button',
  'slider',
  'text',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Widgets that write back to the device, so they need a writable variable. */
const INTERACTIVE: ReadonlySet<string> = new Set(['toggle', 'button', 'slider']);

/** Widgets that display no variable at all. */
const VARIABLE_FREE: ReadonlySet<string> = new Set(['text']);

const GRID_COLUMNS = 12;

const widgetConfigSchema = z
  .object({
    label: z.string().trim().max(80).optional(),
    unit: z.string().trim().max(16).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    /** slider */
    step: z.number().positive().optional(),
    /** toggle / button — what to send. Strings, like every other downlink. */
    onValue: z.string().max(64).optional(),
    offValue: z.string().max(64).optional(),
    /** chart window, milliseconds */
    rangeMs: z.number().int().positive().optional(),
    /** text widget */
    body: z.string().max(2000).optional(),
  })
  .strict()
  .default({});

const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  deviceId: z.string().uuid().nullable().optional(),
});

const updateDashboardSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const createWidgetSchema = z.object({
  type: z.enum(WIDGET_TYPES),
  variableId: z.string().uuid().nullable().optional(),
  x: z.number().int().min(0).max(GRID_COLUMNS - 1).optional(),
  y: z.number().int().min(0).max(9999).optional(),
  w: z.number().int().min(1).max(GRID_COLUMNS).optional(),
  h: z.number().int().min(1).max(50).optional(),
  config: widgetConfigSchema.optional(),
});

const updateWidgetSchema = createWidgetSchema.partial().omit({ type: true });

/** Bulk position update, sent once on drag-end rather than per widget. */
const layoutSchema = z.object({
  widgets: z
    .array(
      z.object({
        id: z.string().uuid(),
        x: z.number().int().min(0).max(GRID_COLUMNS - 1),
        y: z.number().int().min(0).max(9999),
        w: z.number().int().min(1).max(GRID_COLUMNS),
        h: z.number().int().min(1).max(50),
      }),
    )
    .max(200),
});

const dashboardColumns = {
  id: tables.dashboards.id,
  deviceId: tables.dashboards.deviceId,
  name: tables.dashboards.name,
  sortOrder: tables.dashboards.sortOrder,
  createdAt: tables.dashboards.createdAt,
  updatedAt: tables.dashboards.updatedAt,
};

const widgetColumns = {
  id: tables.widgets.id,
  dashboardId: tables.widgets.dashboardId,
  variableId: tables.widgets.variableId,
  type: tables.widgets.type,
  x: tables.widgets.x,
  y: tables.widgets.y,
  w: tables.widgets.w,
  h: tables.widgets.h,
  config: tables.widgets.config,
  createdAt: tables.widgets.createdAt,
};

async function requireOwnedDashboard(userId: string, dashboardId: string) {
  const rows = await db
    .select(dashboardColumns)
    .from(tables.dashboards)
    .where(and(eq(tables.dashboards.id, dashboardId), eq(tables.dashboards.userId, userId)))
    .limit(1);
  const dashboard = rows[0];
  if (!dashboard) throw notFound('Dashboard not found');
  return dashboard;
}

/** A widget is owned transitively, through its dashboard. */
async function requireOwnedWidget(userId: string, widgetId: string) {
  const rows = await db
    .select({ ...widgetColumns })
    .from(tables.widgets)
    .innerJoin(tables.dashboards, eq(tables.dashboards.id, tables.widgets.dashboardId))
    .where(and(eq(tables.widgets.id, widgetId), eq(tables.dashboards.userId, userId)))
    .limit(1);
  const widget = rows[0];
  if (!widget) throw notFound('Widget not found');
  return widget;
}

/**
 * Validates the variable a widget points at: that the caller owns it, and that an
 * interactive widget is not bound to a read-only variable — otherwise the toggle
 * renders happily and every press is rejected by the command endpoint with a 404,
 * which reads as a broken dashboard rather than a misconfigured one.
 */
async function assertVariableUsable(userId: string, type: string, variableId: string | null | undefined) {
  if (VARIABLE_FREE.has(type)) return;

  if (!variableId) throw badRequest(`A "${type}" widget needs a variable`);

  const rows = await db
    .select({ id: tables.variables.id, writable: tables.variables.writable, key: tables.variables.key })
    .from(tables.variables)
    .innerJoin(tables.devices, eq(tables.devices.id, tables.variables.deviceId))
    .where(and(eq(tables.variables.id, variableId), eq(tables.devices.userId, userId)))
    .limit(1);

  const variable = rows[0];
  if (!variable) throw notFound('Variable not found');

  if (INTERACTIVE.has(type) && !variable.writable) {
    throw badRequest(
      `"${variable.key}" is not marked as writable, so it cannot be used for a ${type}. ` +
        'Enable "Writable" on the variable first.',
    );
  }
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/dashboards', async (req) => {
    const auth = await app.requireAuth(req);
    const rows = await db
      .select(dashboardColumns)
      .from(tables.dashboards)
      .where(eq(tables.dashboards.userId, auth.id))
      .orderBy(asc(tables.dashboards.sortOrder), asc(tables.dashboards.createdAt));
    return { dashboards: rows };
  });

  app.post('/dashboards', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = parse(createDashboardSchema, req.body);

    // A device-scoped dashboard must point at a device the caller owns.
    if (body.deviceId) {
      const owned = await db
        .select({ id: tables.devices.id })
        .from(tables.devices)
        .where(and(eq(tables.devices.id, body.deviceId), eq(tables.devices.userId, auth.id)))
        .limit(1);
      if (owned.length === 0) throw notFound('Device not found');
    }

    const [created] = await db
      .insert(tables.dashboards)
      .values({ userId: auth.id, name: body.name, deviceId: body.deviceId ?? null })
      .returning(dashboardColumns);

    reply.code(201);
    return { dashboard: created };
  });

  /** The whole dashboard in one round trip — the panel needs both halves to render. */
  app.get('/dashboards/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const dashboard = await requireOwnedDashboard(auth.id, id);

    const rows = await db
      .select(widgetColumns)
      .from(tables.widgets)
      .where(eq(tables.widgets.dashboardId, id))
      .orderBy(asc(tables.widgets.y), asc(tables.widgets.x));

    return { dashboard, widgets: rows };
  });

  app.patch('/dashboards/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateDashboardSchema, req.body);
    await requireOwnedDashboard(auth.id, id);

    const [updated] = await db
      .update(tables.dashboards)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tables.dashboards.id, id))
      .returning(dashboardColumns);

    return { dashboard: updated };
  });

  app.delete('/dashboards/:id', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    await requireOwnedDashboard(auth.id, id);
    // Widgets cascade.
    await db.delete(tables.dashboards).where(eq(tables.dashboards.id, id));
    reply.code(204);
    return null;
  });

  app.post('/dashboards/:id/widgets', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(createWidgetSchema, req.body);
    await requireOwnedDashboard(auth.id, id);
    await assertVariableUsable(auth.id, body.type, body.variableId);

    const [created] = await db
      .insert(tables.widgets)
      .values({
        dashboardId: id,
        variableId: body.variableId ?? null,
        type: body.type,
        ...(body.x !== undefined ? { x: body.x } : {}),
        ...(body.y !== undefined ? { y: body.y } : {}),
        ...(body.w !== undefined ? { w: body.w } : {}),
        ...(body.h !== undefined ? { h: body.h } : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
      })
      .returning(widgetColumns);

    reply.code(201);
    return { widget: created };
  });

  app.patch('/widgets/:id', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateWidgetSchema, req.body);
    const existing = await requireOwnedWidget(auth.id, id);

    // Re-check on rebind: moving a toggle onto a read-only variable is the same
    // mistake as creating it that way.
    if (body.variableId !== undefined) {
      await assertVariableUsable(auth.id, existing.type, body.variableId);
    }

    const [updated] = await db
      .update(tables.widgets)
      .set({
        ...(body.variableId !== undefined ? { variableId: body.variableId } : {}),
        ...(body.x !== undefined ? { x: body.x } : {}),
        ...(body.y !== undefined ? { y: body.y } : {}),
        ...(body.w !== undefined ? { w: body.w } : {}),
        ...(body.h !== undefined ? { h: body.h } : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
      })
      .where(eq(tables.widgets.id, id))
      .returning(widgetColumns);

    return { widget: updated };
  });

  app.delete('/widgets/:id', async (req, reply) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    await requireOwnedWidget(auth.id, id);
    await db.delete(tables.widgets).where(eq(tables.widgets.id, id));
    reply.code(204);
    return null;
  });

  /**
   * Bulk position update, sent once when a drag or resize finishes. One request
   * per widget would mean a dozen round trips for a single gesture.
   */
  app.post('/dashboards/:id/layout', async (req) => {
    const auth = await app.requireAuth(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(layoutSchema, req.body);
    await requireOwnedDashboard(auth.id, id);

    if (body.widgets.length === 0) return { updated: 0 };

    // Confirm every id belongs to THIS dashboard before writing anything —
    // otherwise a crafted payload could reposition another dashboard's widgets.
    const ids = body.widgets.map((w) => w.id);
    const owned = await db
      .select({ id: tables.widgets.id })
      .from(tables.widgets)
      .where(and(eq(tables.widgets.dashboardId, id), inArray(tables.widgets.id, ids)));

    if (owned.length !== ids.length) throw badRequest('One or more widgets are not on this dashboard');

    await db.transaction(async (tx) => {
      for (const w of body.widgets) {
        await tx
          .update(tables.widgets)
          .set({ x: w.x, y: w.y, w: w.w, h: w.h })
          .where(eq(tables.widgets.id, w.id));
      }
      await tx
        .update(tables.dashboards)
        .set({ updatedAt: new Date() })
        .where(eq(tables.dashboards.id, id));
    });

    return { updated: body.widgets.length };
  });
};
