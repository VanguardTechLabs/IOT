import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Subscription plans. The free tier is seeded by migration 0001. */
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  maxDevices: integer('max_devices').notNull(),
  maxVariablesPerDevice: integer('max_variables_per_device').notNull(),
  maxVariablesTotal: integer('max_variables_total').notNull().default(100),
  maxDashboards: integer('max_dashboards').notNull().default(5),
  maxUsers: integer('max_users').notNull().default(1),
  retentionDays: integer('retention_days').notNull(),
  minIntervalS: integer('min_interval_s').notNull(),
  /** Telemetry rows this plan may write per calendar month. */
  monthlyDatapoints: bigint('monthly_datapoints', { mode: 'number' }).notNull().default(1_000_000),
  publicAccess: boolean('public_access').notNull().default(false),
  mobileApp: boolean('mobile_app').notNull().default(false),
  /** The monthly headline price. Per-period prices live in plan_prices. */
  priceCents: integer('price_cents').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One price per (plan, billing period). A tier has monthly, quarterly and annual. */
export const planPrices = pgTable(
  'plan_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    /** 'month' | 'quarter' | 'year' */
    period: text('period').notNull(),
    priceCents: integer('price_cents').notNull(),
    provider: text('provider').notNull().default('paypal'),
    /** The provider's own id for this price. Null until created provider-side. */
    providerPlanId: text('provider_plan_id'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plan_prices_unique_idx').on(t.planId, t.period, t.provider)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    planId: text('plan_id')
      .notNull()
      .default('free')
      .references(() => plans.id),
    role: text('role').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(t.email)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_idx').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

/** A physical ESP32 (or any MQTT/HTTP/WS client). */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceKey: text('device_key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** sha256(token + salt), hex — validated identically by EMQX and by the HTTP/WS ingest paths. */
    tokenHash: text('token_hash').notNull(),
    tokenSalt: text('token_salt').notNull(),
    tokenPreview: text('token_preview').notNull().default(''),
    intervalS: integer('interval_s').notNull().default(10),
    /** IANA zone used to label this device's charts and CSV export. Storage stays UTC. */
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    autoCreateVariables: boolean('auto_create_variables').notNull().default(true),
    online: boolean('online').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastTransport: text('last_transport'),
    messageCount: bigint('message_count', { mode: 'number' }).notNull().default(0),
    pointCount: bigint('point_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('devices_key_idx').on(t.deviceKey),
    index('devices_user_idx').on(t.userId),
  ],
);

/** One variable = one telemetry channel of one device. Types are declared here; the wire format is always string. */
export const variables = pgTable(
  'variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** 'int' | 'float' | 'bool' | 'string' */
    type: text('type').notNull().default('float'),
    unit: text('unit').notNull().default(''),
    writable: boolean('writable').notNull().default(false),
    color: text('color').notNull().default('#38bdf8'),
    minValue: doublePrecision('min_value'),
    maxValue: doublePrecision('max_value'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('variables_device_key_idx').on(t.deviceId, t.key),
    index('variables_device_idx').on(t.deviceId),
  ],
);

/** Hypertable. Numeric values (int/float/bool) go to value_num, text to value_text. */
export const telemetry = pgTable(
  'telemetry',
  {
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    variableId: uuid('variable_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    valueNum: doublePrecision('value_num'),
    valueText: text('value_text'),
  },
  (t) => [index('telemetry_variable_ts_idx').on(t.variableId, t.ts)],
);

/** Last known value per variable — powers instant dashboard loads without touching the hypertable. */
export const variableState = pgTable('variable_state', {
  variableId: uuid('variable_id')
    .primaryKey()
    .references(() => variables.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  valueNum: doublePrecision('value_num'),
  valueText: text('value_text'),
});

/** Downlink command audit trail (panel → device). */
export const commands = pgTable(
  'commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    variableId: uuid('variable_id').references(() => variables.id, { onDelete: 'set null' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('panel'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('commands_device_created_idx').on(t.deviceId, t.createdAt)],
);

/** Phase-2 alerting: schema is live so rules can be authored now and evaluated later. */
export const alertRules = pgTable(
  'alert_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    variableId: uuid('variable_id')
      .notNull()
      .references(() => variables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'offline' */
    operator: text('operator').notNull(),
    threshold: doublePrecision('threshold'),
    forSeconds: integer('for_seconds').notNull().default(0),
    channels: jsonb('channels').notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alert_rules_variable_idx').on(t.variableId)],
);

/** Machine-to-machine keys for third-party integrations. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPreview: text('key_preview').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.keyHash), index('api_keys_user_idx').on(t.userId)],
);

/**
 * A dashboard the user composes themselves, as opposed to the fixed one-tile-per
 * -variable layout on the device page.
 */
export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null = spans several devices. Set = belongs to one, and dies with it. */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dashboards_user_idx').on(t.userId, t.sortOrder), index('dashboards_device_idx').on(t.deviceId)],
);

/**
 * One widget on a dashboard. Position is in GRID UNITS on a 12-column grid, not
 * pixels — a pixel layout does not survive a different screen width, and the same
 * rows have to render in the mobile app.
 */
export const widgets = pgTable(
  'widgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dashboardId: uuid('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    /** Null for widgets that show no variable, e.g. a text note. */
    variableId: uuid('variable_id').references(() => variables.id, { onDelete: 'cascade' }),
    /** gauge | tank | thermometer | number | chart | toggle | button | slider | text */
    type: text('type').notNull(),
    x: smallint('x').notNull().default(0),
    y: smallint('y').notNull().default(0),
    w: smallint('w').notNull().default(3),
    h: smallint('h').notNull().default(2),
    /** Per-type options. Schemaless on purpose — a column per option would mean a migration per widget type. */
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('widgets_dashboard_idx').on(t.dashboardId), index('widgets_variable_idx').on(t.variableId)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    period: text('period').notNull(),
    provider: text('provider').notNull().default('paypal'),
    providerRef: text('provider_ref').notNull(),
    /** pending | active | past_due | cancelled | expired */
    status: text('status').notNull(),
    /** A cancellation is honoured to this date rather than taking access away at once. */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_provider_ref_idx').on(t.provider, t.providerRef),
    index('subscriptions_user_idx').on(t.userId, t.status),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    provider: text('provider').notNull().default('paypal'),
    providerRef: text('provider_ref').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    status: text('status').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_provider_ref_idx').on(t.provider, t.providerRef),
    index('payments_user_idx').on(t.userId, t.paidAt),
  ],
);

/**
 * Webhook events already handled. Providers deliver at-least-once and retry on
 * any non-2xx, so checking this first is what makes the handler idempotent.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

/**
 * Telemetry rows written per user per calendar month.
 *
 * Counted rather than derived: the quota check runs on every uplink, and a
 * COUNT(*) over a month of a busy account is far too slow for the ingest path.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** First day of the month, UTC. */
    month: date('month').notNull(),
    datapoints: bigint('datapoints', { mode: 'number' }).notNull().default(0),
    /** Set once, so the 80% warning is not re-sent on every subsequent uplink. */
    warnedAt: timestamp('warned_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

/** Broker credentials for the API/ingest services (EMQX superusers). */
export const serviceAccounts = pgTable('service_accounts', {
  username: text('username').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  salt: text('salt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const migrationsTable = pgTable(
  '_migrations',
  {
    name: text('name').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.name] })],
);
