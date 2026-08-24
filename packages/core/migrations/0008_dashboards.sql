-- ─────────────────────────────────────────────────────────────
-- 0008 — user-composed dashboards
--
-- Phase 2. The device page has a fixed layout: one tile per variable, in
-- sort_order. This adds dashboards the user composes themselves — gauges, tanks,
-- thermometers, charts, and the interactive widgets (toggle, button, slider) that
-- write back to the device.
--
-- Positions are stored in GRID UNITS, not pixels. A pixel layout does not survive
-- a different screen width, and the same config has to render on the mobile app
-- later; a 12-column grid does.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dashboards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Null means a dashboard spanning several devices. Set means it belongs to one
  -- device and disappears with it.
  device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboards_user_idx ON dashboards (user_id, sort_order);
CREATE INDEX IF NOT EXISTS dashboards_device_idx ON dashboards (device_id);

CREATE TABLE IF NOT EXISTS widgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  -- Null for widgets that display no variable (a text note or a heading).
  variable_id   uuid REFERENCES variables(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN (
                  'gauge', 'tank', 'thermometer', 'number', 'chart',
                  'toggle', 'button', 'slider', 'text'
                )),
  -- Grid units on a 12-column grid.
  x             smallint NOT NULL DEFAULT 0,
  y             smallint NOT NULL DEFAULT 0,
  w             smallint NOT NULL DEFAULT 3,
  h             smallint NOT NULL DEFAULT 2,
  -- Per-type options: min, max, unit, decimals, colour, label, step, onValue,
  -- offValue, rangeMs. Deliberately schemaless — every widget type wants
  -- different fields, and a column per option would be a migration per feature.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS widgets_dashboard_idx ON widgets (dashboard_id);
CREATE INDEX IF NOT EXISTS widgets_variable_idx ON widgets (variable_id);
