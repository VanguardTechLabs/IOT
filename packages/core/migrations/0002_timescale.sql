-- pulse:no-transaction
-- ─────────────────────────────────────────────────────────────
-- 0002 — telemetry hypertable, compression and retention
--
-- Sizing note: 100 devices x 9 variables @ 10s = ~7.8M rows/day.
-- Segment-by variable_id + order-by ts gives 10-20x compression, so 30 days
-- of that workload lands around 5-15 GB instead of ~120 GB.
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb;
-- pulse:split

CREATE TABLE IF NOT EXISTS telemetry (
  ts          timestamptz NOT NULL,
  variable_id uuid NOT NULL,
  device_id   uuid NOT NULL,
  value_num   double precision,
  value_text  text
);
-- pulse:split

SELECT create_hypertable(
  'telemetry',
  'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);
-- pulse:split

CREATE INDEX IF NOT EXISTS telemetry_variable_ts_idx ON telemetry (variable_id, ts DESC);
-- pulse:split

CREATE INDEX IF NOT EXISTS telemetry_device_ts_idx ON telemetry (device_id, ts DESC);
-- pulse:split

ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'variable_id',
  timescaledb.compress_orderby = 'ts DESC'
);
-- pulse:split

SELECT add_compression_policy('telemetry', INTERVAL '2 days', if_not_exists => TRUE);
-- pulse:split

-- Free-tier retention. Per-plan retention is enforced at query time; raising this
-- ceiling for paid plans is a single call to add_retention_policy().
SELECT add_retention_policy('telemetry', INTERVAL '30 days', if_not_exists => TRUE);
