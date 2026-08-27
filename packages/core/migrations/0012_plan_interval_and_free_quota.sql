-- ─────────────────────────────────────────────────────────────
-- 0012 — 5s on every tier, and a smaller Free allowance
--
-- Client decision, and a deliberate change of model.
--
-- 0010 differentiated the tiers by reporting speed: 60s Free, 15s Starter, 5s
-- Pro. The objection is fair — a plan that says "60s minimum" reads as a
-- capability the product is withholding, and most trial users send only a
-- handful of variables, for whom 60s is an arbitrary handicap.
--
-- So every tier now allows 5s and the MONTHLY ALLOWANCE becomes the only lever.
-- Free drops to 500k, which is a real trial: fast reporting is available, it
-- simply does not last long enough to run a fleet on. Anyone who needs both
-- speed and duration moves to a paid tier, which is the intent.
--
-- What this means in practice, at the 5s minimum:
--   1 variable   → 518,400/month  — just over the Free allowance
--   2 variables  → ~14 days on Free
--   9 variables  → ~3 days on Free
-- Slower reporting stretches it proportionally: 9 variables at 60s fits a full
-- month inside 500k with room to spare.
-- ─────────────────────────────────────────────────────────────

UPDATE plans SET min_interval_s = 5 WHERE id IN ('free', 'starter', 'pro');

UPDATE plans SET monthly_datapoints = 500000 WHERE id = 'free';
