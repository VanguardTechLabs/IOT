-- ─────────────────────────────────────────────────────────────
-- 0005 — per-device display time zone
--
-- Telemetry stays in UTC on disk; this only changes how a device's charts and
-- its CSV export are labelled. Storing it per device rather than per account
-- means one customer can run sites in different zones without duplicating
-- accounts, which is the direction a fleet grows.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
