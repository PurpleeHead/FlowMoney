import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import walletRoutes from './wallets.js';

const model = prisma.walletMovement as unknown as {
  findMany: (...args: any[]) => Promise<any>;
  create: (...args: any[]) => Promise<any>;
};
const originalFindMany = model.findMany;
const originalCreate = model.create;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  model.findMany = originalFindMany;
  model.create = originalCreate;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  process.env.JWT_SECRET = 'wallet-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use(express.json());
  app.use('/api/wallets', walletRoutes);
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

function bearer(userId = 'user-1') {
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'wallet-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('wallet API integration', () => {
  it('requires authentication for wallet balances', async () => {
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/wallets/balances`);
      assert.equal(response.status, 401);
    });
  });

  it('scopes balance reads to the authenticated user', async () => {
    let receivedArgs: any;
    model.findMany = async args => {
      receivedArgs = args;
      return [];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/wallets/balances`, {
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { balances: Array<{ currency: string; balance: number | null }> };
      assert.deepEqual(receivedArgs.where, { userId: 'user-42' });
      assert.deepEqual(body.balances.map(item => item.currency), ['RUB', 'USDT', 'VND']);
      assert.ok(body.balances.every(item => item.balance === null));
    });
  });

  it('always assigns a new wallet movement to the authenticated user', async () => {
    let receivedData: any;
    model.create = async ({ data }: any) => {
      receivedData = data;
      const now = new Date();
      return { id: 'movement-owned-by-user-1', ...data, occurredAt: now, createdAt: now };
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/wallets/movements`, {
        method: 'POST',
        headers: { authorization: bearer('user-1'), 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'ADJUSTMENT',
          currency: 'USDT',
          amount: -1.25,
          userId: 'another-user',
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(receivedData.userId, 'user-1');
      assert.equal(receivedData.currency, 'USDT');
      assert.equal(receivedData.amountDelta, -1.25);
      assert.equal(receivedData.kind, 'ADJUSTMENT');
      assert.equal(receivedData.sourceKey.startsWith('adjustment:user-1:'), true);
    });
  });

  it('allows only one of two concurrent opening-balance requests for the same user and currency', async () => {
    const createdSourceKeys = new Set<string>();
    model.create = async ({ data }: any) => {
      if (createdSourceKeys.has(data.sourceKey)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      createdSourceKeys.add(data.sourceKey);
      const now = new Date();
      return { id: 'movement-1', ...data, occurredAt: now, createdAt: now };
    };

    await withApi(async baseUrl => {
      const request = () => fetch(`${baseUrl}/api/wallets/movements`, {
        method: 'POST',
        headers: { authorization: bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'OPENING', currency: 'USDT', amount: 93.7853 }),
      });
      const responses = await Promise.all([request(), request()]);
      assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
      assert.equal(createdSourceKeys.size, 1);
      const conflict = responses.find(response => response.status === 409)!;
      assert.deepEqual(await conflict.json(), {
        message: 'An opening balance has already been recorded for this currency.',
      });
    });
  });
});
