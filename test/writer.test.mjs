/**
 * Regression tests for the telemetry writer's flush loop.
 *
 * Neither test touches a database: TelemetryWriter.write() is the only method that
 * does I/O, so the stub overrides it and the rest of the class runs for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryWriter } from '@pulse/core';

class StubWriter extends TelemetryWriter {
  constructor(writeDelayMs) {
    // flushMs, flushRows, maxBuffer — passed explicitly so no env is read.
    super(5, 50, 100_000);
    this.writeDelayMs = writeDelayMs;
    this.persisted = [];
    this.lastLatest = null;
  }

  async write(rows, latest) {
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    this.lastLatest = latest;
    this.persisted.push(...rows);
    this.writtenRows += rows.length;
  }
}

const row = (variableId, num, ts) => ({ ts, variableId, deviceId: 'd1', num, text: null });

// schedule() used to call flush() whenever the buffer passed flushRows, and flush()
// called schedule() right back while a write was in flight. Nothing awaited between
// the two, so a write slower than the arrival rate recursed until the stack blew —
// and the rejected promise took the whole ingest process down with it.
test('buffering past the flush threshold during a slow write does not blow the stack', async () => {
  const writer = new StubWriter(30);
  const ts = new Date();

  for (let i = 0; i < 3000; i += 1) {
    writer.enqueue(row(`v${i % 9}`, i, ts));
  }

  await writer.stop();

  assert.equal(writer.droppedRows, 0, 'nothing may be shed');
  assert.equal(writer.persisted.length, 3000, 'every buffered row is written');
});

// variable_state is guarded in SQL by `WHERE variable_state.ts <= EXCLUDED.ts`, but
// that guard cannot see two samples batched into the same statement — the in-memory
// map has to pick the newer one itself.
test('the variable_state batch keeps the newest sample, not the last to arrive', async () => {
  const writer = new StubWriter(0);

  writer.enqueue(row('v1', 99, new Date(9_000)));
  writer.enqueue(row('v1', 1, new Date(2_000)));

  await writer.stop();

  assert.equal(writer.lastLatest.get('v1').num, 99, 'out-of-order sample must not win');
  assert.equal(writer.persisted.length, 2, 'both samples still land in telemetry');
});
