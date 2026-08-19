-- ─────────────────────────────────────────────────────────────
-- 0004 — EMQX authentication / authorization sources
--
-- EMQX queries these two views directly (see infra/emqx/emqx.conf), so device
-- credentials live in one place and revoking a device is a single UPDATE.
-- Password hashing is sha256(password + salt) with salt_position = suffix,
-- which the Node services reproduce byte-for-byte for the HTTP/WS ingest paths.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW emqx_authn AS
SELECT
  d.device_key   AS username,
  d.token_hash   AS password_hash,
  d.token_salt   AS salt,
  false          AS is_superuser
FROM devices d
WHERE d.enabled
UNION ALL
SELECT
  s.username,
  s.password_hash,
  s.salt,
  true           AS is_superuser
FROM service_accounts s;

CREATE OR REPLACE VIEW emqx_acl AS
-- uplink: one message carrying every variable of the cycle
SELECT d.device_key AS username, 'allow' AS permission, 'publish'   AS action, 'd/' || d.device_key || '/up'      AS topic FROM devices d WHERE d.enabled
UNION ALL
-- uplink: optional per-variable topic  d/<key>/up/<variable>
SELECT d.device_key, 'allow', 'publish',   'd/' || d.device_key || '/up/+'   FROM devices d WHERE d.enabled
UNION ALL
-- presence: retained online/offline, also used as the MQTT last will
SELECT d.device_key, 'allow', 'publish',   'd/' || d.device_key || '/status' FROM devices d WHERE d.enabled
UNION ALL
-- downlink: commands from the panel
SELECT d.device_key, 'allow', 'subscribe', 'd/' || d.device_key || '/dn'     FROM devices d WHERE d.enabled
UNION ALL
SELECT d.device_key, 'allow', 'subscribe', 'd/' || d.device_key || '/dn/+'   FROM devices d WHERE d.enabled;
