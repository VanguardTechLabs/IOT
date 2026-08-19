import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUplink, resolveTimestamp, pickResolution } from '@pulse/core';

test('accepts the documented nested payload', () => {
  assert.deepEqual(parseUplink({ ts: 100, v: { a: '1' } }), { ts: 100, values: { a: '1' } });
});

test('accepts a flat payload for minimal firmware', () => {
  assert.deepEqual(parseUplink({ a: '1', b: '2' }).values, { a: '1', b: '2' });
});

test('rejects anything that is not an object of scalars', () => {
  assert.equal(parseUplink('nope'), null);
  assert.equal(parseUplink(42), null);
  assert.equal(parseUplink({ v: { nested: { deep: 1 } } }), null);
});

// A device with no RTC reports millis()/1000, which would otherwise land every
// sample in January 1970 and make the chart unusable.
test('stamps server time when the device clock is absent or implausible', () => {
  const now = 1_700_000_000_000;
  assert.equal(resolveTimestamp(undefined, now).getTime(), now);
  assert.equal(resolveTimestamp(1234, now).getTime(), now, 'uptime seconds, not epoch');
  assert.equal(resolveTimestamp(now + 86_400_000, now).getTime(), now, 'a day in the future');
  assert.equal(resolveTimestamp(Number.NaN, now).getTime(), now);
});

test('trusts a plausible device clock, in seconds or milliseconds', () => {
  const now = 1_700_000_000_000;
  assert.equal(resolveTimestamp(1_699_999_999, now).getTime(), 1_699_999_999_000);
  assert.equal(resolveTimestamp(now - 5000, now).getTime(), now - 5000);
});

test('accepts buffered data up to a day old so offline devices can flush', () => {
  const now = 1_700_000_000_000;
  const sixHoursAgo = now - 6 * 3_600_000;
  assert.equal(resolveTimestamp(sixHoursAgo, now).getTime(), sixHoursAgo);
});

test('routes chart reads to the cheapest source that stays readable', () => {
  const now = 1_700_000_000_000;
  assert.equal(pickResolution(now - 3_600_000, now), 'raw');
  assert.equal(pickResolution(now - 6 * 3_600_000, now), 'raw');
  assert.equal(pickResolution(now - 86_400_000, now), '1m');
  assert.equal(pickResolution(now - 7 * 86_400_000, now), '1m');
  assert.equal(pickResolution(now - 30 * 86_400_000, now), '1h');
});
