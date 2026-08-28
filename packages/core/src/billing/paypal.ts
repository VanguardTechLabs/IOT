import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { planPrices, plans } from '../db/schema.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';

const log = createLogger('paypal');

/**
 * PayPal subscriptions.
 *
 * Kept behind a narrow surface — token, plans, subscribe, cancel, verify, parse —
 * so a local processor can be added later without the routes knowing. Ecuador
 * turned out to support PayPal bank withdrawals, but that was not certain when
 * the schema was designed, which is why nothing here leaks into column names.
 */

const API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

export function billingConfigured(): boolean {
  return env.PAYPAL_CLIENT_ID.length > 0 && env.PAYPAL_SECRET.length > 0;
}

function baseUrl(): string {
  return API_BASE[env.PAYPAL_ENV];
}

/** How PayPal spells the billing periods we store as month/quarter/year. */
const INTERVAL: Record<string, { interval_unit: 'MONTH' | 'YEAR'; interval_count: number }> = {
  month: { interval_unit: 'MONTH', interval_count: 1 },
  quarter: { interval_unit: 'MONTH', interval_count: 3 },
  year: { interval_unit: 'YEAR', interval_count: 1 },
};

// ── Access token ────────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Tokens last ~9 hours. Cached with a minute of headroom rather than fetched per
 * call — a webhook burst would otherwise open a token request per event.
 */
export async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_SECRET.`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    // PayPal's error bodies name the offending field, which is far more useful in
    // a log than the status code alone.
    throw new Error(`PayPal ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ── Products and billing plans ──────────────────────────────────────────────

/**
 * Creates the PayPal-side product and one billing plan per (tier, period), then
 * records each plan id against the matching plan_prices row.
 *
 * Idempotent by virtue of that column: a row that already has a provider_plan_id
 * is skipped, so this is safe to run on every boot and after adding a tier.
 */
export async function syncPlans(): Promise<{ created: number; skipped: number }> {
  if (!billingConfigured()) return { created: 0, skipped: 0 };

  const rows = await db
    .select({
      id: planPrices.id,
      planId: planPrices.planId,
      period: planPrices.period,
      priceCents: planPrices.priceCents,
      providerPlanId: planPrices.providerPlanId,
      providerEnv: planPrices.providerEnv,
      planName: plans.name,
    })
    .from(planPrices)
    .innerJoin(plans, eq(plans.id, planPrices.planId))
    .where(and(eq(planPrices.provider, 'paypal'), eq(planPrices.active, true)));

  // A row published to a DIFFERENT environment counts as unpublished. Sandbox
  // ids are worthless once live credentials are in place, and the failure they
  // cause otherwise is invisible until a customer reaches PayPal's last screen.
  const pending = rows.filter(
    (r) => r.priceCents > 0 && (!r.providerPlanId || r.providerEnv !== env.PAYPAL_ENV),
  );
  if (pending.length === 0) return { created: 0, skipped: rows.length };

  const product = await api<{ id: string }>('/v1/catalogs/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Pulse IoT',
      description: 'IoT telemetry platform subscription',
      type: 'SERVICE',
      category: 'SOFTWARE',
    }),
  });

  let created = 0;
  for (const row of pending) {
    const cycle = INTERVAL[row.period];
    if (!cycle) {
      log.warn({ period: row.period }, 'unknown billing period, skipped');
      continue;
    }

    const plan = await api<{ id: string }>('/v1/billing/plans', {
      method: 'POST',
      body: JSON.stringify({
        product_id: product.id,
        name: `${row.planName} (${row.period})`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: cycle,
            tenure_type: 'REGULAR',
            sequence: 1,
            // 0 means "until cancelled" — the whole point of a subscription.
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: (row.priceCents / 100).toFixed(2), currency_code: 'USD' },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CONTINUE',
          payment_failure_threshold: 3,
        },
      }),
    });

    await db
      .update(planPrices)
      .set({ providerPlanId: plan.id, providerEnv: env.PAYPAL_ENV })
      .where(eq(planPrices.id, row.id));

    created += 1;
    log.info({ plan: row.planId, period: row.period, providerPlanId: plan.id }, 'billing plan created');
  }

  return { created, skipped: rows.length - created };
}

// ── Subscriptions ───────────────────────────────────────────────────────────

export interface CreatedSubscription {
  providerRef: string;
  approvalUrl: string;
}

export async function createSubscription(opts: {
  providerPlanId: string;
  email: string;
  returnUrl: string;
  cancelUrl: string;
}): Promise<CreatedSubscription> {
  const body = await api<{ id: string; links: Array<{ rel: string; href: string }> }>(
    '/v1/billing/subscriptions',
    {
      method: 'POST',
      body: JSON.stringify({
        plan_id: opts.providerPlanId,
        subscriber: { email_address: opts.email },
        application_context: {
          brand_name: 'Pulse IoT',
          user_action: 'SUBSCRIBE_NOW',
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
        },
      }),
    },
  );

  const approve = body.links.find((l) => l.rel === 'approve');
  if (!approve) throw new Error('PayPal did not return an approval link');

  return { providerRef: body.id, approvalUrl: approve.href };
}

export async function cancelSubscription(providerRef: string, reason = 'Cancelled by user'): Promise<void> {
  await api(`/v1/billing/subscriptions/${providerRef}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getSubscription(providerRef: string): Promise<{
  status: string;
  billing_info?: { next_billing_time?: string };
}> {
  return api(`/v1/billing/subscriptions/${providerRef}`);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface WebhookHeaders {
  'paypal-auth-algo'?: string;
  'paypal-cert-url'?: string;
  'paypal-transmission-id'?: string;
  'paypal-transmission-sig'?: string;
  'paypal-transmission-time'?: string;
}

/**
 * Asks PayPal whether it really sent this event.
 *
 * Without it the webhook is an unauthenticated endpoint that grants plan
 * upgrades — anyone who knows the URL could POST themselves onto Pro. Returns
 * false when PAYPAL_WEBHOOK_ID is unset, so an unconfigured deployment refuses
 * events rather than trusting them.
 */
export async function verifyWebhook(headers: WebhookHeaders, event: unknown): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) {
    log.error('PAYPAL_WEBHOOK_ID is not set — refusing to trust webhook events');
    return false;
  }

  try {
    const result = await api<{ verification_status: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: env.PAYPAL_WEBHOOK_ID,
          webhook_event: event,
        }),
      },
    );
    return result.verification_status === 'SUCCESS';
  } catch (err) {
    log.error({ err: (err as Error).message }, 'webhook verification failed');
    return false;
  }
}
