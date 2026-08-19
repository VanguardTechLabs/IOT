-- pulse:no-transaction
-- ─────────────────────────────────────────────────────────────
-- 0006 — turn real-time aggregation on for existing deployments
--
-- 0003 now creates both continuous aggregates WITH materialized_only = false, but
-- `CREATE MATERIALIZED VIEW IF NOT EXISTS` does not revisit a view that already
-- exists, so any database created before that change keeps the old setting.
--
-- With materialized_only = true a continuous aggregate returns only what the
-- refresh policy has already written. telemetry_1m has a 1 minute end_offset and
-- telemetry_1h a 1 hour one, so the newest bucket — the part of a chart anyone is
-- actually looking at — is missing until the next refresh lands.
-- ─────────────────────────────────────────────────────────────

ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);
-- pulse:split

ALTER MATERIALIZED VIEW telemetry_1h SET (timescaledb.materialized_only = false);
