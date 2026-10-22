import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseReady } from './readiness.js';

test('database readiness succeeds when the database probe succeeds', async () => {
  let called = false;
  const ready = await isDatabaseReady(async () => {
    called = true;
    return [{ '?column?': 1 }];
  });

  assert.equal(called, true);
  assert.equal(ready, true);
});

test('database readiness fails closed when the database probe throws', async () => {
  const ready = await isDatabaseReady(async () => {
    throw new Error('database unavailable');
  });

  assert.equal(ready, false);
});

test('database readiness handles a rejected probe without leaking the error', async () => {
  const ready = await isDatabaseReady(() => Promise.reject(new Error('sensitive connection detail')));
  assert.equal(ready, false);
});
