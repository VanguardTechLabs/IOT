-- pulse:no-transaction
-- ─────────────────────────────────────────────────────────────
-- 0003 — rollups so a 30-day chart never scans raw rows
--
-- The API router picks the source by range:
--   <= 6h   -> telemetry (raw)
--   <= 7d   -> telemetry_1m
--   >  7d   -> telemetry_1h
-- Real-time aggregation is left ON, so the newest bucket is always live.
-- ─────────────────────────────────────────────────────────────

-- Created WITH DATA (the default) rather than WITH NO DATA: on a fresh install the
-- source table is empty so it costs nothing, and it puts the materialization
-- watermark at "now". WITH NO DATA would leave every bucket older than the refresh
-- policy's start_offset permanently unmaterialized and therefore invisible to a
-- long-range chart.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT
  variable_id,
  time_bucket(INTERVAL '1 minute', ts) AS bucket,
  avg(value_num)          AS avg_value,
  min(value_num)          AS min_value,
  max(value_num)          AS max_value,
  last(value_num, ts)     AS last_value,
  count(*)                AS sample_count
FROM telemetry
GROUP BY variable_id, bucket;
-- pulse:split

-- start_offset spans 2 days so that late data — a device flushing a buffer after
-- hours offline — still gets rolled up. Refreshes are driven by the invalidation
-- log, so a wide window is cheap when nothing old actually changed.
SELECT add_continuous_aggregate_policy('telemetry_1m',
  start_offset      => INTERVAL '2 days',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);
-- pulse:split

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1h
WITH (timescaledb.continuous) AS
SELECT
  variable_id,
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  avg(value_num)          AS avg_value,
  min(value_num)          AS min_value,
  max(value_num)          AS max_value,
  last(value_num, ts)     AS last_value,
  count(*)                AS sample_count
FROM telemetry
GROUP BY variable_id, bucket;
-- pulse:split

SELECT add_continuous_aggregate_policy('telemetry_1h',
  start_offset      => INTERVAL '7 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists     => TRUE);
-- pulse:split

SELECT add_retention_policy('telemetry_1m', INTERVAL '90 days', if_not_exists => TRUE);
-- pulse:split

SELECT add_retention_policy('telemetry_1h', INTERVAL '400 days', if_not_exists => TRUE);
