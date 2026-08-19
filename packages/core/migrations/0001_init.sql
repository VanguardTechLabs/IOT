-- ─────────────────────────────────────────────────────────────
-- 0001 — core relational model
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS plans (
  id                        text PRIMARY KEY,
  name                      text NOT NULL,
  max_devices               integer NOT NULL,
  max_variables_per_device  integer NOT NULL,
  retention_days            integer NOT NULL,
  min_interval_s            integer NOT NULL,
  price_cents               integer NOT NULL DEFAULT 0,
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Phase 1 ships free-only. The paid rows exist so enabling billing later is a
-- column update, never a schema migration.
INSERT INTO plans (id, name, max_devices, max_variables_per_device, retention_days, min_interval_s, price_cents, sort_order)
VALUES
  ('free',     'Free',     2,    16,  30,  3, 0,    0),
  ('pro',      'Pro',      25,   32,  90,  1, 1900, 1),
  ('business', 'Business', 250,  64,  365, 1, 9900, 2)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  plan_id        text NOT NULL DEFAULT 'free' REFERENCES plans(id),
  role           text NOT NULL DEFAULT 'user',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS devices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key              text NOT NULL,
  name                    text NOT NULL,
  description             text NOT NULL DEFAULT '',
  token_hash              text NOT NULL,
  token_salt              text NOT NULL,
  token_preview           text NOT NULL DEFAULT '',
  interval_s              integer NOT NULL DEFAULT 10,
  enabled                 boolean NOT NULL DEFAULT true,
  auto_create_variables   boolean NOT NULL DEFAULT true,
  online                  boolean NOT NULL DEFAULT false,
  last_seen_at            timestamptz,
  last_transport          text,
  message_count           bigint NOT NULL DEFAULT 0,
  point_count             bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_key_idx ON devices (device_key);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);

CREATE TABLE IF NOT EXISTS variables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL DEFAULT 'float' CHECK (type IN ('int', 'float', 'bool', 'string')),
  unit        text NOT NULL DEFAULT '',
  writable    boolean NOT NULL DEFAULT false,
  color       text NOT NULL DEFAULT '#38bdf8',
  min_value   double precision,
  max_value   double precision,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS variables_device_key_idx ON variables (device_id, key);
CREATE INDEX IF NOT EXISTS variables_device_idx ON variables (device_id);

CREATE TABLE IF NOT EXISTS variable_state (
  variable_id  uuid PRIMARY KEY REFERENCES variables(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL,
  ts           timestamptz NOT NULL,
  value_num    double precision,
  value_text   text
);
CREATE INDEX IF NOT EXISTS variable_state_device_idx ON variable_state (device_id);

CREATE TABLE IF NOT EXISTS commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  variable_id  uuid REFERENCES variables(id) ON DELETE SET NULL,
  key          text NOT NULL,
  value        text NOT NULL,
  issued_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  source       text NOT NULL DEFAULT 'panel',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commands_device_created_idx ON commands (device_id, created_at DESC);

-- Phase 2 alerting. Rules can be stored today; the evaluator lands next stage.
CREATE TABLE IF NOT EXISTS alert_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variable_id    uuid NOT NULL REFERENCES variables(id) ON DELETE CASCADE,
  name           text NOT NULL,
  operator       text NOT NULL CHECK (operator IN ('gt','gte','lt','lte','eq','neq','offline')),
  threshold      double precision,
  for_seconds    integer NOT NULL DEFAULT 0,
  channels       jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  last_fired_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_variable_idx ON alert_rules (variable_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_hash      text NOT NULL,
  key_preview   text NOT NULL,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS service_accounts (
  username       text PRIMARY KEY,
  password_hash  text NOT NULL,
  salt           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
