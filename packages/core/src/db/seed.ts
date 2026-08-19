import { eq } from 'drizzle-orm';
import { db, closeDatabase, waitForDatabase } from './index.js';
import { devices, users, variables } from './schema.js';
import { hashPassword, newDeviceKey, newDeviceToken, newSalt, preview, sha256Salted } from '../crypto.js';
import { createLogger } from '../logger.js';
import { runMigrations } from './migrate.js';

const log = createLogger('seed');

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@pulse.io';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'pulse1234';

const DEMO_VARIABLES = [
  { key: 'temp', label: 'Temperature', type: 'float', unit: '°C', color: '#f97316' },
  { key: 'hum', label: 'Humidity', type: 'float', unit: '%', color: '#38bdf8' },
  { key: 'pressure', label: 'Pressure', type: 'float', unit: 'hPa', color: '#a78bfa' },
  { key: 'lux', label: 'Light', type: 'int', unit: 'lx', color: '#facc15' },
  { key: 'voltage', label: 'Voltage', type: 'float', unit: 'V', color: '#34d399' },
  { key: 'rssi', label: 'WiFi RSSI', type: 'int', unit: 'dBm', color: '#94a3b8' },
  { key: 'button', label: 'Push button', type: 'bool', unit: '', color: '#f472b6' },
  { key: 'relay', label: 'Relay', type: 'bool', unit: '', color: '#22d3ee', writable: true },
  { key: 'mode', label: 'Mode', type: 'string', unit: '', color: '#e2e8f0', writable: true },
] as const;

async function main() {
  await waitForDatabase();
  await runMigrations();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  let userId = existing[0]?.id;

  if (!userId) {
    const [created] = await db
      .insert(users)
      .values({
        email: DEMO_EMAIL,
        name: 'Demo User',
        passwordHash: await hashPassword(DEMO_PASSWORD),
        planId: 'free',
      })
      .returning({ id: users.id });
    userId = created!.id;
    log.info({ email: DEMO_EMAIL }, 'demo user created');
  }

  const existingDevices = await db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId));
  if (existingDevices.length > 0) {
    log.info('demo devices already present, nothing to do');
    return;
  }

  const token = newDeviceToken();
  const salt = newSalt();
  const [device] = await db
    .insert(devices)
    .values({
      userId,
      deviceKey: newDeviceKey(),
      name: 'ESP32 Demo',
      description: 'Seeded device with the nine reference variables',
      tokenHash: sha256Salted(token, salt),
      tokenSalt: salt,
      tokenPreview: preview(token),
      intervalS: 10,
    })
    .returning({ id: devices.id, deviceKey: devices.deviceKey });

  await db.insert(variables).values(
    DEMO_VARIABLES.map((v, i) => ({
      deviceId: device!.id,
      key: v.key,
      label: v.label,
      type: v.type,
      unit: v.unit,
      color: v.color,
      writable: 'writable' in v ? Boolean(v.writable) : false,
      sortOrder: i,
    })),
  );

  log.info(
    { email: DEMO_EMAIL, password: DEMO_PASSWORD, deviceKey: device!.deviceKey, token },
    'seed complete — save this device token, it is not stored in clear text',
  );
}

main()
  .then(closeDatabase)
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err: err.message }, 'seed failed');
    process.exit(1);
  });
