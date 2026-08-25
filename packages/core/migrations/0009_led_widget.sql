-- ─────────────────────────────────────────────────────────────
-- 0009 — the LED indicator widget
--
-- Client request: a lamp that changes colour when a value goes from 0 to 1.
-- The toggle already shows on/off state, but it is a control — an operator
-- watching a panel wants a read-only light, not something they might click.
--
-- 0008 declared the type list as an inline column CHECK, which Postgres names
-- widgets_type_check, so extending it means replacing the constraint.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE widgets DROP CONSTRAINT IF EXISTS widgets_type_check;

ALTER TABLE widgets ADD CONSTRAINT widgets_type_check CHECK (type IN (
  'gauge', 'tank', 'thermometer', 'number', 'chart',
  'toggle', 'button', 'slider', 'text', 'led'
));
