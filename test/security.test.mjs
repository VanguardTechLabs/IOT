import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  isValidTimeZone,
  newApiKey,
  newDeviceKey,
  newDeviceToken,
  newSalt,
  safeEqualHex,
  sha256Salted,
  verifyPassword,
} from '@pulse/core';

test('device token hashing is stable and salt-dependent', () => {
  const salt = newSalt();
  const hash = sha256Salted('tok_example', salt);
  assert.equal(hash.length, 64, 'hex sha256');
  assert.equal(sha256Salted('tok_example', salt), hash, 'deterministic');
  assert.notEqual(sha256Salted('tok_example', newSalt()), hash, 'salt changes the digest');
  assert.notEqual(sha256Salted('tok_other', salt), hash, 'wrong token changes the digest');
});

// EMQX validates this exact construction (sha256, salt_position = suffix). If the
// order ever changes here, every device silently fails to authenticate.
test('salt is appended, not prepended — this is the EMQX contract', async () => {
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update('secret' + 'abcd1234').digest('hex');
  assert.equal(sha256Salted('secret', 'abcd1234'), expected);
});

test('hex comparison is length-safe', () => {
  const a = sha256Salted('a', 'b');
  assert.equal(safeEqualHex(a, a), true);
  assert.equal(safeEqualHex(a, a.slice(0, 60)), false);
  assert.equal(safeEqualHex(a, 'zz'), false);
});

test('generated credentials are prefixed and long enough to resist guessing', () => {
  assert.match(newDeviceKey(), /^dev_[0-9a-f]{18}$/);
  assert.match(newDeviceToken(), /^tok_.{20,}$/);
  assert.match(newApiKey(), /^pk_.{20,}$/);
  assert.notEqual(newDeviceToken(), newDeviceToken());
});

test('passwords verify with argon2 and reject anything else', async () => {
  const hash = await hashPassword('pulse1234');
  assert.equal(await verifyPassword(hash, 'pulse1234'), true);
  assert.equal(await verifyPassword(hash, 'wrong'), false);
  assert.equal(await verifyPassword('not-a-hash', 'pulse1234'), false, 'malformed hash must not throw');
});

// The CSV export interpolates the zone into a COPY statement, which takes no bind
// parameters. This validator is the only thing between a device setting and SQL.
test('accepts real IANA zones', () => {
  for (const zone of ['UTC', 'America/Lima', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Europe/Madrid']) {
    assert.equal(isValidTimeZone(zone), true, zone);
  }
});

test('rejects injection attempts and unknown zones', () => {
  for (const bad of [
    '',
    'Not/AZone',
    '../../etc/passwd',
    "UTC'; DROP TABLE devices--",
    "'||pg_sleep(10)||'",
    'UTC; SELECT 1',
    'A'.repeat(80),
  ]) {
    assert.equal(isValidTimeZone(bad), false, JSON.stringify(bad));
  }
});
