/**
 * Creates N simulated devices for load testing and writes their credentials to
 * `simulated-devices.json`.
 *
 * It writes straight to the database on purpose: plan limits are a product rule
 * for real users, and a load test that has to respect a 2-device ceiling cannot
 * prove the platform holds 100.
 *
 *   pnpm --filter @pulse/simulator provision -- --devices 100 --email demo@pulse.io
 */
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import {
  closeDatabase,
  createLogger,
  db,
  newDeviceKey,
  newDeviceToken,
  newSalt,
  preview,
  runMigrations,
  sha256Salted,
  tables,
  waitForDatabase,
} from '@pulse/core';

const log = createLogger('sim-provision');

const VARIABLES = [
  { key: 'temp', label: 'Temperature', type: 'float', unit: '°C', color: '#f97316' },
  { key: 'hum', label: 'Humidity', type: 'float', unit: '%', color: '#38bdf8' },
  { key: 'pressure', label: 'Pressure', type: 'float', unit: 'hPa', color: '#a78bfa' },
  { key: 'lux', label: 'Light', type: 'int', unit: 'lx', color: '#facc15' },
  { key: 'voltage', label: 'Voltage', type: 'float', unit: 'V', color: '#34d399' },
  { key: 'current', label: 'Current', type: 'float', unit: 'A', color: '#fb7185' },
  { key: 'rssi', label: 'WiFi RSSI', type: 'int', unit: 'dBm', color: '#94a3b8' },
  { key: 'button', label: 'Push button', type: 'bool', unit: '', color: '#f472b6' },
  { key: 'relay', label: 'Relay', type: 'bool', unit: '', color: '#22d3ee', writable: true },
] as const;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main() {
  const count = Number.parseInt(arg('devices', '100'), 10);
  const email = arg('email', 'demo@pulse.io').toLowerCase();
  const intervalS = Number.parseInt(arg('interval', '10'), 10);

  await waitForDatabase();
  await runMigrations();

  const rows = await db
    .select({ id: tables.users.id })
    .from(tables.users)
    .where(eq(tables.users.email, email))
    .limit(1);

  // Deliberately does NOT create the account. It used to, with a hardcoded
  // password that is printed in the README — and both DEPLOY.md and the RUNBOOK
  // tell you to run this on the client's server, so a load test left a working
  // login behind on production. Attach to an account that already exists.
  if (rows.length === 0) {
    log.error(
      { email },
      'no such account — create it in the panel first, or pass --email <existing account>',
    );
    process.exit(1);
  }
  const userId = rows[0]!.id;

  const credentials: Array<{ deviceKey: string; token: string }> = [];

  for (let i = 0; i < count; i += 1) {
    const token = newDeviceToken();
    const salt = newSalt();
    const [device] = await db
      .insert(tables.devices)
      .values({
        userId,
        deviceKey: newDeviceKey(),
        name: `Sim ESP32 #${String(i + 1).padStart(3, '0')}`,
        description: 'Provisioned by the load simulator',
        tokenHash: sha256Salted(token, salt),
        tokenSalt: salt,
        tokenPreview: preview(token),
        intervalS,
      })
      .returning({ id: tables.devices.id, deviceKey: tables.devices.deviceKey });

    await db.insert(tables.variables).values(
      VARIABLES.map((v, index) => ({
        deviceId: device!.id,
        key: v.key,
        label: v.label,
        type: v.type,
        unit: v.unit,
        color: v.color,
        writable: 'writable' in v ? Boolean(v.writable) : false,
        sortOrder: index,
      })),
    );

    credentials.push({ deviceKey: device!.deviceKey, token });
  }

  await writeFile('simulated-devices.json', JSON.stringify(credentials, null, 2), 'utf8');
  log.info({ count, file: 'simulated-devices.json' }, 'provisioned simulated devices');
}

main()
  .then(closeDatabase)
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err: err.message }, 'provisioning failed');
    process.exit(1);
  });
