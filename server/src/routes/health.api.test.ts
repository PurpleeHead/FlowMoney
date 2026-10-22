import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import healthRoutes from './health.js';

const originalRawQuery = prisma.$queryRaw;

afterEach(() => {
  (prisma as any).$queryRaw = originalRawQuery;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use('/api', healthRoutes);
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

describe('health endpoints', () => {
  it('returns process liveness without requiring a database query', async () => {
    (prisma as any).$queryRaw = async () => {
      throw new Error('liveness must not depend on database availability');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', service: 'flowmoney-api' });
    });
  });

  it('reports readiness only when PostgreSQL responds', async () => {
    let queryCount = 0;
    (prisma as any).$queryRaw = async () => {
      queryCount += 1;
      return [{ '?column?': 1 }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        status: 'ready',
        service: 'flowmoney-api',
        database: 'ok',
      });
      assert.equal(queryCount, 1, 'readiness performs exactly one database probe');
    });
  });

  it('returns 503 and does not leak database errors when PostgreSQL is unavailable', async () => {
    (prisma as any).$queryRaw = async () => {
      throw new Error('sensitive database connection detail');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        status: 'not_ready',
        service: 'flowmoney-api',
      });
      assert.doesNotMatch(await response.clone().text(), /sensitive database connection detail/);
    });
  });
});
