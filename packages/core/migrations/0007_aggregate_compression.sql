-- pulse:no-transaction
-- ─────────────────────────────────────────────────────────────
-- 0007 — compress the continuous aggregates
--
-- Raw telemetry is compressed after 2 days (migration 0002) and dropped after
-- 30. The rollups were neither: telemetry_1m is retained 90 days and
-- telemetry_1h 400, both uncompressed — so over a year the aggregates become
-- the largest object in the database, quietly larger than the raw table they
-- exist to make cheap.
--
-- Both offsets sit clear of their refresh windows (telemetry_1m refreshes back
-- 2 days, telemetry_1h back 7), so a refresh never has to touch a compressed
-- chunk.
-- ─────────────────────────────────────────────────────────────

ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.compress = true);
-- pulse:split

SELECT add_compression_policy('telemetry_1m', INTERVAL '7 days', if_not_exists => TRUE);
-- pulse:split

ALTER MATERIALIZED VIEW telemetry_1h SET (timescaledb.compress = true);
-- pulse:split

SELECT add_compression_policy('telemetry_1h', INTERVAL '30 days', if_not_exists => TRUE);
