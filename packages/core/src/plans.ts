import { eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { devices, plans, users, variables } from './db/schema.js';

export interface PlanLimits {
  id: string;
  name: string;
  maxDevices: number;
  maxVariablesPerDevice: number;
  retentionDays: number;
  minIntervalS: number;
  priceCents: number;
}

export class PlanLimitError extends Error {
  readonly statusCode = 402;
  constructor(message: string, readonly limit: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export async function getUserPlan(userId: string): Promise<PlanLimits> {
  const rows = await db
    .select({
      id: plans.id,
      name: plans.name,
      maxDevices: plans.maxDevices,
      maxVariablesPerDevice: plans.maxVariablesPerDevice,
      retentionDays: plans.retentionDays,
      minIntervalS: plans.minIntervalS,
      priceCents: plans.priceCents,
    })
    .from(users)
    .innerJoin(plans, eq(plans.id, users.planId))
    .where(eq(users.id, userId))
    .limit(1);

  const plan = rows[0];
  if (!plan) throw new Error('plan not found for user');
  return plan;
}

export async function assertCanAddDevice(userId: string): Promise<PlanLimits> {
  const plan = await getUserPlan(userId);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(eq(devices.userId, userId));

  if (count >= plan.maxDevices) {
    throw new PlanLimitError(
      `The ${plan.name} plan allows ${plan.maxDevices} device${plan.maxDevices === 1 ? '' : 's'}. Upgrade to add more.`,
      'max_devices',
    );
  }
  return plan;
}

export async function assertCanAddVariable(userId: string, deviceId: string): Promise<PlanLimits> {
  const plan = await getUserPlan(userId);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(variables)
    .where(eq(variables.deviceId, deviceId));

  if (count >= plan.maxVariablesPerDevice) {
    throw new PlanLimitError(
      `The ${plan.name} plan allows ${plan.maxVariablesPerDevice} variables per device.`,
      'max_variables_per_device',
    );
  }
  return plan;
}

export function clampInterval(requested: number, plan: PlanLimits): number {
  return Math.min(Math.max(requested, plan.minIntervalS), 86_400);
}

export async function listPlans(): Promise<PlanLimits[]> {
  return db
    .select({
      id: plans.id,
      name: plans.name,
      maxDevices: plans.maxDevices,
      maxVariablesPerDevice: plans.maxVariablesPerDevice,
      retentionDays: plans.retentionDays,
      minIntervalS: plans.minIntervalS,
      priceCents: plans.priceCents,
    })
    .from(plans)
    .orderBy(plans.sortOrder);
}
