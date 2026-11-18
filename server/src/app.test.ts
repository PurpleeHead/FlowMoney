import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

test('trusts exactly one Render reverse proxy for client IP and rate limiting', () => {
  const app = createApp();
  assert.equal(app.get('trust proxy'), 1);
});


test('health endpoint confirms PostgreSQL readiness through the runtime adapter', async () => {
  const { prisma } = await import('./services/prisma.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; service: string; database: string };
    assert.deepEqual(body, { status: 'ok', service: 'nummiox-api', database: 'ok' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
