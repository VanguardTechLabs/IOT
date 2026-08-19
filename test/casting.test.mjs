/**
 * The wire contract: ESP32s send strings, the platform casts by declared type.
 * These are the rules the firmware, the simulator and the CSV export all depend on,
 * so they are pinned here.
 *
 * Run with `pnpm test` (builds @pulse/core first).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castValue, inferType, renderValue } from '@pulse/core';

test('casts integers, truncating rather than rejecting decimals', () => {
  assert.deepEqual(castValue('int', '42'), { ok: true, num: 42, text: null });
  assert.deepEqual(castValue('int', '42.9'), { ok: true, num: 42, text: null });
  assert.deepEqual(castValue('int', '-7'), { ok: true, num: -7, text: null });
});

test('casts decimals', () => {
  assert.deepEqual(castValue('float', '23.5'), { ok: true, num: 23.5, text: null });
  assert.deepEqual(castValue('float', '-0.001'), { ok: true, num: -0.001, text: null });
});

test('accepts every boolean spelling firmware tends to send', () => {
  for (const truthy of ['1', 'true', 'T', 'on', 'HIGH', 'yes', 'y']) {
    assert.equal(castValue('bool', truthy).num, 1, truthy);
  }
  for (const falsy of ['0', 'false', 'f', 'off', 'LOW', 'no', 'n']) {
    assert.equal(castValue('bool', falsy).num, 0, falsy);
  }
});

test('stores text in value_text and caps its length', () => {
  assert.deepEqual(castValue('string', 'auto'), { ok: true, num: null, text: 'auto' });
  assert.equal(castValue('string', 'x'.repeat(900)).text.length, 512);
});

test('rejects values that cannot be the declared type', () => {
  assert.equal(castValue('float', 'abc').ok, false);
  assert.equal(castValue('int', '').ok, false);
  assert.equal(castValue('bool', 'maybe').ok, false);
  assert.equal(castValue('float', null).ok, false);
  assert.equal(castValue('float', undefined).ok, false);
});

test('infers a type for auto-created variables', () => {
  assert.equal(inferType('23.5'), 'float');
  assert.equal(inferType('42'), 'int');
  assert.equal(inferType('true'), 'bool');
  assert.equal(inferType(false), 'bool');
  assert.equal(inferType('auto'), 'string');
});

test('leaves "0" and "1" numeric — widening int to bool later is lossless, the reverse is not', () => {
  assert.equal(inferType('1'), 'int');
  assert.equal(inferType('0'), 'int');
});

test('renders stored values back to the wire form used by CSV export', () => {
  assert.equal(renderValue('bool', 1, null), '1');
  assert.equal(renderValue('bool', 0, null), '0');
  assert.equal(renderValue('int', 42.9, null), '42');
  assert.equal(renderValue('float', 23.5, null), '23.5');
  assert.equal(renderValue('string', null, 'hi'), 'hi');
  assert.equal(renderValue('float', null, null), '');
});
