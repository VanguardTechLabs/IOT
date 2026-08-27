import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.string().default('info'),

  PUBLIC_URL: z.string().default('http://localhost:8080'),
  PUBLIC_MQTT_HOST: z.string().default('localhost'),
  PUBLIC_MQTT_PORT: int(1883),
  PUBLIC_MQTT_WS_PORT: int(8083),

  // Optional: in Docker the connection comes from the discrete PG* variables
  // instead, because a composed URL cannot carry an arbitrary password safely.
  // getPool() requires one of the two and says so if neither is present.
  DATABASE_URL: z.string().optional().default(''),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  MQTT_URL: z.string().default('mqtt://localhost:1883'),
  MQTT_BACKEND_USER: z.string().default('pulse-backend'),
  MQTT_BACKEND_PASSWORD: z.string().min(6, 'MQTT_BACKEND_PASSWORD must be at least 6 chars'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),

  // ── Billing ────────────────────────────────────────────────────────────
  // Optional: the platform runs perfectly well with payments switched off, and
  // did for the whole of phase 1. Every billing route checks for these and
  // returns a clear "billing is not configured" rather than crashing on boot.
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional().default(''),
  PAYPAL_SECRET: z.string().optional().default(''),
  /** Set after registering the webhook with PayPal; signature checks need it. */
  PAYPAL_WEBHOOK_ID: z.string().optional().default(''),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: int(30),
  COOKIE_SECURE: bool(false),

  API_PORT: int(4000),
  API_HOST: z.string().default('0.0.0.0'),

  INGEST_FLUSH_MS: int(200),
  INGEST_FLUSH_ROWS: int(500),
  INGEST_BURST_LIMIT: int(30),
  INGEST_BURST_WINDOW_S: int(3),
  DEVICE_OFFLINE_GRACE_MULTIPLIER: int(3),
  DEVICE_OFFLINE_MIN_GRACE_S: int(45),

});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = new Proxy({} as Env, {
  get: (_t, prop: string) => loadEnv()[prop as keyof Env],
});
