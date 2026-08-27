-- ─────────────────────────────────────────────────────────────
-- 0010 — the phase-2 plan tiers, and prices split out by billing period
--
-- 0001 shipped free/pro/business as placeholders so billing could be switched on
-- without a schema change. The client has now defined the real tiers — Free,
-- Starter, Pro — with several limits the old table had no room for.
--
-- Prices move to their own table because one tier now has three prices (monthly,
-- quarterly, annual) and each needs its own provider-side plan id. Keeping them
-- as columns would mean a column per period per provider.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_variables_total integer NOT NULL DEFAULT 100;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_dashboards      integer NOT NULL DEFAULT 5;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_users           integer NOT NULL DEFAULT 1;
-- Telemetry rows a plan may write per calendar month. The real ceiling on usage:
-- min_interval_s says how fast a device MAY report, this says how much it may
-- report in total.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_datapoints  bigint  NOT NULL DEFAULT 1000000;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS public_access       boolean NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS mobile_app          boolean NOT NULL DEFAULT false;

-- ── Tiers ────────────────────────────────────────────────────────────────────
-- Every tier allows 5s. Reporting speed was briefly used to separate the tiers,
-- but a plan advertising a 60s floor reads as a capability being withheld, and
-- most trial users send few enough variables that it is an arbitrary handicap.
-- The monthly allowance is the lever instead — see 0012 for the reasoning.

INSERT INTO plans (
  id, name, max_devices, max_variables_per_device, max_variables_total,
  retention_days, min_interval_s, monthly_datapoints, max_dashboards, max_users,
  public_access, mobile_app, price_cents, sort_order
) VALUES
  ('free',    'Free',     2, 15,  30, 30, 5,   500000,  2, 1, false, false,    0, 0),
  ('starter', 'Starter', 10, 20, 200, 60, 5,  5000000, 10, 2, true,  true,   900, 1),
  ('pro',     'Pro',     15, 30, 450, 90, 5, 15000000, 15, 5, true,  true,  1500, 2)
ON CONFLICT (id) DO UPDATE SET
  name                     = EXCLUDED.name,
  max_devices              = EXCLUDED.max_devices,
  max_variables_per_device = EXCLUDED.max_variables_per_device,
  max_variables_total      = EXCLUDED.max_variables_total,
  retention_days           = EXCLUDED.retention_days,
  min_interval_s           = EXCLUDED.min_interval_s,
  monthly_datapoints       = EXCLUDED.monthly_datapoints,
  max_dashboards           = EXCLUDED.max_dashboards,
  max_users                = EXCLUDED.max_users,
  public_access            = EXCLUDED.public_access,
  mobile_app               = EXCLUDED.mobile_app,
  price_cents              = EXCLUDED.price_cents,
  sort_order               = EXCLUDED.sort_order;
-- pulse:split

-- 'business' from 0001 is not part of the new lineup. Move anyone parked on it
-- before deleting, or the foreign key from users would block this.
UPDATE users SET plan_id = 'free' WHERE plan_id NOT IN ('free', 'starter', 'pro');
-- pulse:split

DELETE FROM plans WHERE id NOT IN ('free', 'starter', 'pro');
-- pulse:split

-- ── Prices ───────────────────────────────────────────────────────────────────
-- provider_plan_id is the id the payment provider knows this price by (a PayPal
-- billing plan, for example). Null until the plans are created provider-side.

CREATE TABLE IF NOT EXISTS plan_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  period           text NOT NULL CHECK (period IN ('month', 'quarter', 'year')),
  price_cents      integer NOT NULL,
  provider         text NOT NULL DEFAULT 'paypal',
  provider_plan_id text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_unique_idx
  ON plan_prices (plan_id, period, provider);
-- pulse:split

-- Quarterly is 10% off three months, annual 20% off twelve. A 3% quarterly
-- discount was considered and dropped: it saves a Starter customer 81 cents,
-- which does not change anyone's decision, and the provider's per-transaction
-- fee on two fewer charges is worth about as much anyway.
INSERT INTO plan_prices (plan_id, period, price_cents) VALUES
  ('starter', 'month',    900),
  ('starter', 'quarter', 2430),
  ('starter', 'year',    8640),
  ('pro',     'month',   1500),
  ('pro',     'quarter', 4050),
  ('pro',     'year',   14400)
ON CONFLICT (plan_id, period, provider) DO UPDATE SET
  price_cents = EXCLUDED.price_cents,
  active      = true;
