import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import healthRoutes from './health.js';

const client = prisma as unknown as { $queryRaw: (...args: any[]) => Promise<unknown> };
const originalQueryRaw = client.$queryRaw;

afterEach(() => {
  client.$queryRaw = originalQueryRaw;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use('/api', healthRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('health endpoints', () => {
  it('keeps liveness independent of database connectivity', async () => {
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', service: 'flowmoney-api' });
    });
  });

  it('reports ready only when the database query succeeds', async () => {
    let queryCalled = false;
    client.$queryRaw = async () => {
      queryCalled = true;
      return [{ '?column?': 1 }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready', service: 'flowmoney-api', database: 'ok' });
      assert.equal(queryCalled, true);
    });
  });

  it('returns 503 without leaking database error details when database is unavailable', async () => {
    client.$queryRaw = async () => {
      throw new Error('sensitive connection string must not be exposed');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: 'not_ready', service: 'flowmoney-api' });
    });
  });
});
