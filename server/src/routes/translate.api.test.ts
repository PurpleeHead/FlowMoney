import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import translateRoutes from './translate.js';

it('rate limits translation requests before authentication and provider calls', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/translate', translateRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'xin chao', source: 'vi', target: 'ru' }),
      });
      statuses.push(response.status);
    }
    assert.equal(statuses.filter(status => status === 401).length, 30);
    assert.equal(statuses[30], 429);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
