import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, env, listPlans, paypal, tables } from '@pulse/core';
import { badRequest, notFound, parse } from '../lib/http.js';

/**
 * Subscriptions.
 *
 * The flow is: subscribe → PayPal approval page → PayPal calls the webhook →
 * the plan changes. The browser's return URL is only a redirect back; nothing
 * is granted on it, because anyone can visit a return URL. Entitlement comes
 * exclusively from a verified webhook.
 */

const subscribeSchema = z.object({
  planId: z.string().trim().min(1).max(40),
  period: z.enum(['month', 'quarter', 'year']),
});

/** Events we act on. Everything else is acknowledged and ignored. */
const HANDLED = new Set([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
]);

export const billingRoutes: FastifyPluginAsync = async (app) => {
  /** What the account page needs: the tiers, their prices, and where the user stands. */
  app.get('/billing/status', async (req) => {
    const auth = await app.requireAuth(req);

    const prices = await db
      .select({
        planId: tables.planPrices.planId,
        period: tables.planPrices.period,
        priceCents: tables.planPrices.priceCents,
        ready: tables.planPrices.providerPlanId,
      })
      .from(tables.planPrices)
      .where(and(eq(tables.planPrices.provider, 'paypal'), eq(tables.planPrices.active, true)));

    const [subscription] = await db
      .select({
        id: tables.subscriptions.id,
        planId: tables.subscriptions.planId,
        period: tables.subscriptions.period,
        status: tables.subscriptions.status,
        currentPeriodEnd: tables.subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: tables.subscriptions.cancelAtPeriodEnd,
      })
      .from(tables.subscriptions)
      .where(eq(tables.subscriptions.userId, auth.id))
      // A live subscription outranks a newer abandoned one. Clicking Upgrade
      // twice and approving the first leaves a pending row with the later
      // timestamp; sorting on time alone would report that one and tell a
      // paying customer their payment is still being processed.
      .orderBy(
        sql`CASE WHEN status IN ('active', 'past_due') THEN 0 WHEN status = 'pending' THEN 1 ELSE 2 END`,
        desc(tables.subscriptions.createdAt),
      )
      .limit(1);

    return {
      configured: paypal.billingConfigured(),
      environment: env.PAYPAL_ENV,
      plans: await listPlans(),
      // `ready` is null until the plan exists on PayPal's side; the UI disables
      // those buttons rather than starting a checkout that cannot complete.
      prices: prices.map((p) => ({ ...p, ready: p.ready !== null })),
      subscription: subscription ?? null,
    };
  });

  app.post('/billing/subscribe', async (req) => {
    const auth = await app.requireAuth(req);
    const body = parse(subscribeSchema, req.body);

    if (!paypal.billingConfigured()) {
      throw badRequest('Billing is not configured on this deployment');
    }

    const [price] = await db
      .select({ providerPlanId: tables.planPrices.providerPlanId })
      .from(tables.planPrices)
      .where(
        and(
          eq(tables.planPrices.planId, body.planId),
          eq(tables.planPrices.period, body.period),
          eq(tables.planPrices.provider, 'paypal'),
          eq(tables.planPrices.active, true),
        ),
      )
      .limit(1);

    if (!price) throw notFound('No such plan and billing period');
    if (!price.providerPlanId) {
      throw badRequest('This plan has not been published to PayPal yet — try again shortly');
    }

    const created = await paypal.createSubscription({
      providerPlanId: price.providerPlanId,
      email: auth.email,
      returnUrl: `${env.PUBLIC_URL}/account?subscribed=1`,
      cancelUrl: `${env.PUBLIC_URL}/account?cancelled=1`,
    });

    // Recorded as `pending`, NOT active. Only the webhook activates it — a user
    // who abandons the PayPal page must not end up on a paid plan.
    await db.insert(tables.subscriptions).values({
      userId: auth.id,
      planId: body.planId,
      period: body.period,
      provider: 'paypal',
      providerRef: created.providerRef,
      status: 'pending',
    });

    return { approvalUrl: created.approvalUrl };
  });

  app.post('/billing/cancel', async (req) => {
    const auth = await app.requireAuth(req);

    const [subscription] = await db
      .select({ id: tables.subscriptions.id, providerRef: tables.subscriptions.providerRef })
      .from(tables.subscriptions)
      .where(and(eq(tables.subscriptions.userId, auth.id), eq(tables.subscriptions.status, 'active')))
      .orderBy(desc(tables.subscriptions.createdAt))
      .limit(1);

    if (!subscription) throw notFound('You have no active subscription');

    await paypal.cancelSubscription(subscription.providerRef);

    // Access continues to the end of the paid period — taking it away the moment
    // someone clicks cancel would be charging for time they cannot use.
    await db
      .update(tables.subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(tables.subscriptions.id, subscription.id));

    return { ok: true, accessUntilPeriodEnd: true };
  });

  /**
   * PayPal's callback. Unauthenticated by nature, so the signature check is the
   * only thing standing between this endpoint and free plan upgrades.
   */
  app.post('/billing/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    const event = req.body as { id?: string; event_type?: string; resource?: Record<string, unknown> };

    if (!event?.id || !event.event_type) {
      reply.code(400);
      return { error: 'malformed event' };
    }

    const valid = await paypal.verifyWebhook(req.headers as never, event);
    if (!valid) {
      req.log.warn({ eventId: event.id, type: event.event_type }, 'rejected unverified webhook');
      reply.code(401);
      return { error: 'signature verification failed' };
    }

    // Providers deliver at-least-once and retry on any non-2xx. Claiming the id
    // first means a redelivery is a no-op instead of a second upgrade or a
    // duplicate payment row.
    const claimed = await db
      .insert(tables.billingEvents)
      .values({ provider: 'paypal', eventId: event.id, eventType: event.event_type })
      .onConflictDoNothing()
      .returning({ eventId: tables.billingEvents.eventId });

    if (claimed.length === 0) {
      req.log.info({ eventId: event.id }, 'duplicate webhook ignored');
      return { ok: true, duplicate: true };
    }

    if (!HANDLED.has(event.event_type)) return { ok: true, ignored: true };

    try {
      await handleEvent(event.event_type, event.resource ?? {}, req.log);
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, eventId: event.id, type: event.event_type },
        'webhook handling failed',
      );
      // Still 200: the event id is claimed, so a retry would be swallowed as a
      // duplicate anyway. Better a logged failure than an endless retry loop.
    }

    return { ok: true };
  });
};

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

async function handleEvent(type: string, resource: Record<string, unknown>, log: Logger): Promise<void> {
  if (type === 'PAYMENT.SALE.COMPLETED') {
    const saleId = String(resource.id ?? '');
    const subscriptionRef = String(resource.billing_agreement_id ?? '');
    if (!saleId || !subscriptionRef) return;

    const [subscription] = await db
      .select({ id: tables.subscriptions.id, userId: tables.subscriptions.userId })
      .from(tables.subscriptions)
      .where(eq(tables.subscriptions.providerRef, subscriptionRef))
      .limit(1);
    if (!subscription) return;

    const amount = resource.amount as { total?: string; currency?: string } | undefined;

    await db
      .insert(tables.payments)
      .values({
        userId: subscription.userId,
        subscriptionId: subscription.id,
        provider: 'paypal',
        providerRef: saleId,
        amountCents: Math.round(Number(amount?.total ?? 0) * 100),
        currency: amount?.currency ?? 'USD',
        status: 'completed',
        paidAt: new Date(),
      })
      .onConflictDoNothing();

    log.info({ userId: subscription.userId, saleId }, 'payment recorded');
    return;
  }

  // The remaining events all identify a subscription by its own id.
  const providerRef = String(resource.id ?? '');
  if (!providerRef) return;

  const [subscription] = await db
    .select({
      id: tables.subscriptions.id,
      userId: tables.subscriptions.userId,
      planId: tables.subscriptions.planId,
    })
    .from(tables.subscriptions)
    .where(eq(tables.subscriptions.providerRef, providerRef))
    .limit(1);

  if (!subscription) {
    log.warn({ providerRef }, 'webhook for an unknown subscription');
    return;
  }

  const billingInfo = resource.billing_info as { next_billing_time?: string } | undefined;
  const periodEnd = billingInfo?.next_billing_time ? new Date(billingInfo.next_billing_time) : null;

  switch (type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      await db
        .update(tables.subscriptions)
        .set({ status: 'active', currentPeriodEnd: periodEnd, updatedAt: new Date() })
        .where(eq(tables.subscriptions.id, subscription.id));

      await db
        .update(tables.users)
        .set({ planId: subscription.planId, updatedAt: new Date() })
        .where(eq(tables.users.id, subscription.userId));

      log.info({ userId: subscription.userId, plan: subscription.planId }, 'subscription activated');
      break;
    }

    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      // Payment trouble, not a cancellation. The plan is deliberately left alone:
      // PayPal retries, and pulling someone's devices offline over a card that
      // expired on Tuesday is not a good way to keep a customer.
      await db
        .update(tables.subscriptions)
        .set({ status: 'past_due', updatedAt: new Date() })
        .where(eq(tables.subscriptions.id, subscription.id));
      log.warn({ userId: subscription.userId }, 'subscription payment failed');
      break;
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      await db
        .update(tables.subscriptions)
        .set({ status: type.endsWith('EXPIRED') ? 'expired' : 'cancelled', updatedAt: new Date() })
        .where(eq(tables.subscriptions.id, subscription.id));

      await db
        .update(tables.users)
        .set({ planId: 'free', updatedAt: new Date() })
        .where(eq(tables.users.id, subscription.userId));

      // Nothing is deleted or disabled. Plan limits are enforced when something
      // is CREATED, so an account over the free ceiling keeps everything it has
      // and simply cannot add more. Destroying a paying customer's data because
      // a subscription lapsed is not a decision code should make on its own.
      log.info({ userId: subscription.userId }, 'subscription ended, moved to free');
      break;
    }
  }
}
