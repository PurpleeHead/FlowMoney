import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import receiptRoutes from './receipts.js';

const receiptModel = prisma.receipt as unknown as {
  findMany: (...args: any[]) => Promise<any>;
};
const originalFindMany = receiptModel.findMany;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  receiptModel.findMany = originalFindMany;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  process.env.JWT_SECRET = 'receipt-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use(express.json());
  app.use('/api/receipts', receiptRoutes);
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'receipt-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('receipt API ownership', () => {
  it('lists only receipts belonging to the authenticated user', async () => {
    let findManyArgs: any;
    receiptModel.findMany = async (args: any) => {
      findManyArgs = args;
      return [{ id: 'receipt-user-1', userId: 'user-1', rawText: 'receipt' }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`, {
        headers: { authorization: bearer('user-1') },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(findManyArgs.where, { userId: 'user-1' });
      assert.deepEqual(findManyArgs.orderBy, { createdAt: 'desc' });
      assert.equal(findManyArgs.take, 100);
      const receipts = await response.json() as Array<{ userId: string }>;
      assert.deepEqual(receipts.map(receipt => receipt.userId), ['user-1']);
    });
  });

  it('rejects receipt listing without authentication', async () => {
    let queryCalled = false;
    receiptModel.findMany = async () => {
      queryCalled = true;
      return [];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/receipts`);
      assert.equal(response.status, 401);
      assert.equal(queryCalled, false);
    });
  });
});
