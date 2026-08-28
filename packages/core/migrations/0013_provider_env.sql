-- ─────────────────────────────────────────────────────────────
-- 0013 — remember which PayPal environment a plan id came from
--
-- provider_plan_id was treated as "published, nothing more to do". That holds
-- only while a deployment never changes environment, and every deployment
-- changes environment exactly once: sandbox during development, live on the day
-- it takes money.
--
-- At that moment the column is full of sandbox ids. syncPlans() sees them, finds
-- nothing pending, and skips. Checkout then hands live PayPal a plan id that
-- exists only in sandbox, and fails at the last step for every customer — with
-- no error at boot, because from the code's point of view everything was already
-- done.
--
-- Recording the environment alongside the id makes "published" mean "published
-- HERE". Switching credentials makes every row pending again and the plans are
-- recreated against live on the next boot.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE plan_prices ADD COLUMN IF NOT EXISTS provider_env text;
-- pulse:split

-- Any id already in this column was created against the sandbox: live
-- credentials have never been configured, and a deployment that starts on live
-- has an empty table anyway.
UPDATE plan_prices SET provider_env = 'sandbox'
 WHERE provider_plan_id IS NOT NULL AND provider_env IS NULL;
