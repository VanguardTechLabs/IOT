-- ─────────────────────────────────────────────────────────────
-- 0011 — subscriptions, payments, and the monthly usage counter
--
-- The provider columns are deliberately generic rather than PayPal-specific.
-- PayPal is confirmed for Ecuador (the client verified a Banco Pichincha
-- withdrawal account), but a platform that may later need a local processor
-- should not have "paypal" baked into its column names.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id            text NOT NULL REFERENCES plans(id),
  period             text NOT NULL CHECK (period IN ('month', 'quarter', 'year')),
  provider           text NOT NULL DEFAULT 'paypal',
  -- The provider's own id for this subscription. Unique per provider so a
  -- replayed webhook cannot create a second row for the same subscription.
  provider_ref       text NOT NULL,
  status             text NOT NULL CHECK (status IN
                       ('pending', 'active', 'past_due', 'cancelled', 'expired')),
  -- When the paid period ends. A cancellation is honoured to this date rather
  -- than taking access away the moment someone clicks cancel.
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_ref_idx
  ON subscriptions (provider, provider_ref);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'paypal',
  provider_ref    text NOT NULL,
  amount_cents    integer NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  status          text NOT NULL,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Providers retry webhooks. Without this a single payment becomes three rows.
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_idx
  ON payments (provider, provider_ref);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, paid_at DESC);

/*
 * Every webhook event we have already handled.
 *
 * Providers deliver at-least-once and retry on any non-2xx, so the same event
 * arrives more than once as a matter of course. Recording the id and checking it
 * first is what makes handling idempotent — the alternative is a user upgraded
 * twice, or three payment rows for one charge.
 */
CREATE TABLE IF NOT EXISTS billing_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

/*
 * Telemetry rows written per user per calendar month.
 *
 * Counted here rather than derived from the telemetry hypertable on demand: the
 * check runs on every uplink, and COUNT(*) over a month of a busy account would
 * be far too slow for the ingest hot path. One upsert per flush keeps it cheap.
 *
 * `month` is the first day of the month, in UTC.
 */
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       date NOT NULL,
  datapoints  bigint NOT NULL DEFAULT 0,
  -- So the 80% warning is sent once, not on every uplink after the threshold.
  warned_at   timestamptz,
  blocked_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
