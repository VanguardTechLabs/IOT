import { eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { dashboards, devices, plans, users, variables } from './db/schema.js';

export interface PlanLimits {
  id: string;
  name: string;
  maxDevices: number;
  maxVariablesPerDevice: number;
  /** Across every device the user owns, not per device. */
  maxVariablesTotal: number;
  maxDashboards: number;
  /** Seats on the account. 1 until multi-user accounts exist. */
  maxUsers: number;
  retentionDays: number;
  minIntervalS: number;
  /**
   * Telemetry rows this plan may write per calendar month.
   *
   * min_interval_s says how fast a device MAY report; this is what actually caps
   * total usage. A Free device at its 60s minimum uses well under its allowance,
   * but ten of them at 5s would not — which is the point of having both.
   */
  monthlyDatapoints: number;
  publicAccess: boolean;
  mobileApp: boolean;
  priceCents: number;
}

/** Selected in both queries below; kept in one place so they cannot drift. */
const planColumns = {
  id: plans.id,
  name: plans.name,
  maxDevices: plans.maxDevices,
  maxVariablesPerDevice: plans.maxVariablesPerDevice,
  maxVariablesTotal: plans.maxVariablesTotal,
  maxDashboards: plans.maxDashboards,
  maxUsers: plans.maxUsers,
  retentionDays: plans.retentionDays,
  minIntervalS: plans.minIntervalS,
  monthlyDatapoints: plans.monthlyDatapoints,
  publicAccess: plans.publicAccess,
  mobileApp: plans.mobileApp,
  priceCents: plans.priceCents,
};

export class PlanLimitError extends Error {
  readonly statusCode = 402;
  constructor(message: string, readonly limit: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export async function getUserPlan(userId: string): Promise<PlanLimits> {
  const rows = await db
    .select(planColumns)
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

  // Also capped across the whole account, so a plan cannot be exceeded by
  // spreading variables thinly over several devices.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(variables)
    .innerJoin(devices, eq(devices.id, variables.deviceId))
    .where(eq(devices.userId, userId));

  if (total >= plan.maxVariablesTotal) {
    throw new PlanLimitError(
      `The ${plan.name} plan allows ${plan.maxVariablesTotal} variables in total across your devices.`,
      'max_variables_total',
    );
  }

  return plan;
}

export async function assertCanAddDashboard(userId: string): Promise<PlanLimits> {
  const plan = await getUserPlan(userId);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dashboards)
    .where(eq(dashboards.userId, userId));

  if (count >= plan.maxDashboards) {
    throw new PlanLimitError(
      `The ${plan.name} plan allows ${plan.maxDashboards} dashboard${plan.maxDashboards === 1 ? '' : 's'}. Upgrade to add more.`,
      'max_dashboards',
    );
  }
  return plan;
}

export function clampInterval(requested: number, plan: PlanLimits): number {
  return Math.min(Math.max(requested, plan.minIntervalS), 86_400);
}

export async function listPlans(): Promise<PlanLimits[]> {
  return db.select(planColumns).from(plans).orderBy(plans.sortOrder);
}
