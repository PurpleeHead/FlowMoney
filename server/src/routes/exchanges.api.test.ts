import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const exchangeModel = prisma.exchange as unknown as { findMany: (...args: any[]) => Promise<any> };
const originalExchangeFindMany = exchangeModel.findMany;
const originalUserFindFirst = userModel.findFirst;
import exchangeRoutes from './exchanges.js';

const client = prisma as unknown as { $transaction: (...args: any[]) => Promise<any> };
const originalTransaction = client.$transaction;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  exchangeModel.findMany = originalExchangeFindMany;
  client.$transaction = originalTransaction;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
  process.env.JWT_SECRET = 'exchange-api-test-secret-long-enough-for-jwt-middleware';
  const app = express();
  app.use(express.json());
  app.use('/api/exchanges', exchangeRoutes);
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'exchange-api-test-secret-long-enough-for-jwt-middleware')}`;
}

describe('direct RUB to VND exchange fees', () => {
  it('persists and credits the net VND amount after the fee', async () => {
    let createdData: any;
    const movements: any[] = [];
    const tx = {
      exchange: {
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'direct-vnd-fee', ...data, createdAt: new Date('2026-10-20T10:00:00.000Z') };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => { movements.push(...data); return { count: data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_VND', rubSpent: 1000, vndReceived: 250000, vndFee: 5000,
        }),
      });
      assert.equal(response.status, 201);
      const body = await response.json() as any;
      assert.equal(Number(body.vndReceived), 245000);
      assert.equal(Number(body.targetReceived), 245000);
      assert.equal(Number(body.vndFee), 5000);
    });

    assert.equal(Number(createdData.vndReceived), 245000);
    assert.equal(Number(createdData.effectiveVndPerRub), 245);
    assert.deepEqual(movements.map(x => [x.currency, Number(x.amountDelta)]), [
      ['RUB', -1000],
      ['VND', 245000],
    ]);
  });

  it('subtracts the fee from indirect RUB-USDT-VND results before ledger credit', async () => {
    let createdData: any;
    const movements: any[] = [];
    const tx = {
      exchange: {
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'indirect-vnd-fee', ...data, createdAt: new Date('2026-10-20T10:00:00.000Z') };
        },
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => { movements.push(...data); return { count: data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndReceived: 2500000, vndFee: 5000,
        }),
      });
      assert.equal(response.status, 201);
      const body = await response.json() as any;
      assert.equal(Number(body.vndReceived), 2495000);
      assert.equal(Number(body.vndFee), 5000);
    });

    assert.equal(Number(createdData.vndReceived), 2495000);
    assert.deepEqual(movements.map(x => [x.currency, Number(x.amountDelta)]), [
      ['RUB', -8300],
      ['USDT', 93.7853],
      ['VND', 2495000],
    ]);
  });

  it('rejects a fee that consumes the entire gross VND amount before writing', async () => {
    let createCalls = 0;
    const tx = {
      exchange: { create: async ({ data }: any) => { createCalls += 1; return { id: 'bad-vnd-fee', ...data }; } },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => ({ count: data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_VND', rubSpent: 1000, vndReceived: 250000, vndFee: 250000,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(createCalls, 0);
    });
  });
});

  it('recalculates the net VND wallet credit when editing a direct exchange fee', async () => {
    let updateArgs: any;
    const deleted: any[] = [];
    const created: any[] = [];
    const current = {
      id: 'direct-fee-edit', userId: 'user-42', mode: 'RUB_VND',
      rubSpent: 1000, usdtReceived: null, vndReceived: 245000, vndFee: 5000,
      targetCurrency: 'VND', targetReceived: 245000, targetToVndRate: 1,
      targetVndEquivalent: null, createdAt: new Date('2026-10-20T10:00:00.000Z'),
    };
    const tx = {
      exchange: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => ({ ...current, ...(updateArgs?.data ?? {}) }),
      },
      walletMovement: {
        deleteMany: async (args: any) => { deleted.push(args); return { count: 1 }; },
        createMany: async (args: any) => { created.push(...args.data); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/direct-fee-edit`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_VND', rubSpent: 1000, vndReceived: 260000, vndFee: 10000,
        }),
      });
      assert.equal(response.status, 200);
    });

    assert.deepEqual(updateArgs.where, { id: 'direct-fee-edit', userId: 'user-42' });
    assert.equal(updateArgs.data.vndReceived, 250000, 'persisted VND outcome must be net of the new fee');
    assert.equal(updateArgs.data.targetReceived, 250000, 'legacy target amount must stay aligned with the net outcome');
    assert.equal(updateArgs.data.effectiveVndPerRub, 250);
    assert.deepEqual(deleted, [{
      where: { userId: 'user-42', sourceKey: { startsWith: 'exchange:direct-fee-edit:' } },
    }]);
    assert.deepEqual(created.map(x => [x.currency, Number(x.amountDelta), x.sourceKey]), [
      ['RUB', -1000, 'exchange:direct-fee-edit:RUB'],
      ['VND', 250000, 'exchange:direct-fee-edit:VND'],
    ]);
  });


  it('rejects editing a direct exchange when the fee consumes all gross VND before opening a transaction', async () => {
    let transactionCalls = 0;
    client.$transaction = async (...args: any[]) => {
      transactionCalls += 1;
      return originalTransaction(...args);
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/direct-fee-invalid`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_VND', rubSpent: 1000, vndReceived: 250000, vndFee: 250000,
        }),
      });
      assert.equal(response.status, 400);
    });

    assert.equal(transactionCalls, 0, 'invalid net outcome must be rejected before update or ledger synchronization');
  });


  it('recalculates the indirect exchange VND ledger credit when editing its fee', async () => {
    let updateArgs: any;
    const created: any[] = [];
    const current = {
      id: 'indirect-fee-edit', userId: 'user-42', mode: 'RUB_USDT_VND',
      rubSpent: 8300, usdtReceived: 93.7853, vndReceived: 2495000, vndFee: 5000,
      vndPerUsdt: 26600, planningVndPerUsdt: null, effectiveVndPerRub: 300.6024,
      effectiveRubPerUsdt: 88.4988, targetCurrency: 'VND', targetReceived: null,
      targetToVndRate: null, targetVndEquivalent: null,
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
    };
    const tx = {
      exchange: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => ({ ...current, ...(updateArgs?.data ?? {}) }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 3 }),
        createMany: async (args: any) => { created.push(...args.data); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/indirect-fee-edit`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndReceived: 2500000, vndFee: 10000,
        }),
      });
      assert.equal(response.status, 200);
    });

    assert.deepEqual(updateArgs.where, { id: 'indirect-fee-edit', userId: 'user-42' });
    assert.equal(updateArgs.data.vndReceived, 2490000);
    assert.equal(updateArgs.data.vndFee, 10000);
    assert.equal(updateArgs.data.effectiveVndPerRub, 2490000 / 8300);
    assert.deepEqual(created.map(x => [x.currency, Number(x.amountDelta), x.sourceKey]), [
      ['RUB', -8300, 'exchange:indirect-fee-edit:RUB'],
      ['USDT', 93.7853, 'exchange:indirect-fee-edit:USDT'],
      ['VND', 2490000, 'exchange:indirect-fee-edit:VND'],
    ]);
  });


describe('direct RUB to USDT top-up without VND rate', () => {
  it('rejects a VND fee in direct-target mode instead of silently ignoring it', async () => {
    let createCalls = 0;
    const tx = {
      exchange: { create: async ({ data }: any) => { createCalls += 1; return { id: 'exchange-test', ...data }; } },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => ({ count: data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_TARGET', rubSpent: 1000, targetCurrency: 'VND',
          targetReceived: 250000, vndFee: 5000,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(createCalls, 0, 'an ignored fee must not be persisted as if no fee existed');
    });
  });

  it('accepts actual USDT without requiring a VND conversion rate', async () => {
    const tx = {
      exchange: { create: async ({ data }: any) => ({ id: 'exchange-test', ...data, createdAt: new Date() }) },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => ({ count: data.length }),
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        method: 'POST',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'RUB_TARGET', rubSpent: 8300, targetCurrency: 'USDT', targetReceived: 93.7853 }),
      });
      assert.equal(response.status, 201);
      const body = await response.json() as any;
      assert.equal(body.targetToVndRate, null);
      assert.equal(body.targetVndEquivalent, null);
      assert.equal(body.effectiveVndPerRub, null);
    });
  });
});


describe('editing direct RUB to USDT top-ups', () => {
  it('allows saving a USDT top-up without inventing a VND rate or equivalent', async () => {
    let updateArgs: any;
    const movements: any[] = [];
    const updated = {
      id: 'usdt-top-up', userId: 'user-42', mode: 'RUB_TARGET',
      rubSpent: 8300, usdtReceived: null, vndReceived: null,
      targetCurrency: 'USDT', targetReceived: 93.7853,
      targetToVndRate: null, targetVndEquivalent: null,
      effectiveVndPerRub: null, effectiveRubPerUsdt: null,
      createdAt: new Date('2026-10-18T08:00:00.000Z'),
    };
    const tx = {
      exchange: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => updated,
      },
      walletMovement: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (args: any) => { movements.push(...args.data); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/usdt-top-up`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_TARGET', rubSpent: 8300,
          targetCurrency: 'USDT', targetReceived: 93.7853,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.targetCurrency, 'USDT');
      assert.equal(body.targetToVndRate, null);
      assert.equal(body.targetVndEquivalent, null);
      assert.equal(body.effectiveVndPerRub, null);
    });

    assert.deepEqual(updateArgs.where, { id: 'usdt-top-up', userId: 'user-42' });
    assert.equal(updateArgs.data.targetCurrency, 'USDT');
    assert.equal(updateArgs.data.targetToVndRate, null);
    assert.equal(updateArgs.data.targetVndEquivalent, null);
    assert.deepEqual(movements.map(x => [x.currency, Number(x.amountDelta)]), [
      ['RUB', -8300],
      ['USDT', 93.7853],
    ]);
  });
});

describe('exchange API ledger synchronization', () => {
  it('updates an exchange and replaces its ledger movements in the same transaction', async () => {
    let updateArgs: any;
    const deleted: any[] = [];
    const created: any[] = [];
    const current = {
      id: 'exchange-1', userId: 'user-42', mode: 'RUB_USDT_VND', rubSpent: 8300,
      usdtReceived: 93.7853, vndReceived: null, targetCurrency: 'VND',
      targetReceived: null, createdAt: new Date('2026-10-18T08:00:00.000Z'),
    };
    const tx = {
      exchange: {
        updateMany: async (args: any) => { updateArgs = args; return { count: 1 }; },
        findFirst: async () => current,
      },
      walletMovement: {
        deleteMany: async (args: any) => { deleted.push(args); return { count: 2 }; },
        createMany: async (args: any) => { created.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-1`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(updateArgs.where, { id: 'exchange-1', userId: 'user-42' });
      assert.deepEqual(deleted, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'exchange:exchange-1:' } },
      }]);
      const movements = created[0].data as Array<{ currency: string; amountDelta: number }>;
      assert.deepEqual(movements.map(item => [item.currency, item.amountDelta]), [
        ['RUB', -8300],
        ['USDT', 93.7853],
      ]);
    });
  });

  it('returns 404 and leaves ledger rows untouched when updating another user exchange', async () => {
    let updateArgs: any;
    const movementDeleteArgs: any[] = [];
    const movementCreateArgs: any[] = [];
    const tx = {
      exchange: {
        updateMany: async (args: any) => {
          updateArgs = args;
          return { count: 0 };
        },
        findFirst: async () => {
          throw new Error('exchange lookup must not run after an owner-scoped update matches no row');
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => { movementDeleteArgs.push(args); return { count: 1 }; },
        createMany: async (args: any) => { movementCreateArgs.push(args); return { count: args.data.length }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/another-users-exchange`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });

      assert.equal(response.status, 404);
      assert.deepEqual(updateArgs.where, { id: 'another-users-exchange', userId: 'user-42' });
      assert.deepEqual(movementDeleteArgs, [], 'ledger deletion must not run when the owner-scoped update matches no row');
      assert.deepEqual(movementCreateArgs, [], 'ledger creation must not run when the owner-scoped update matches no row');
    });
  });

  it('returns an error when ledger synchronization fails during exchange update', async () => {
    let transactionCompleted = false;
    const tx = {
      exchange: {
        updateMany: async (args: any) => {
          assert.deepEqual(args.where, { id: 'exchange-rollback', userId: 'user-42' });
          return { count: 1 };
        },
        findFirst: async () => ({
          id: 'exchange-rollback', userId: 'user-42', mode: 'RUB_USDT_VND',
          rubSpent: 8300, usdtReceived: 93.7853, vndReceived: null,
          targetCurrency: 'VND', targetReceived: null,
        }),
      },
      walletMovement: {
        deleteMany: async () => ({ count: 1 }),
        createMany: async () => { throw new Error('simulated ledger write failure'); },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } finally {
        transactionCompleted = true;
      }
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-rollback`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-42'), 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'RUB_USDT_VND', rubSpent: 8300, usdtReceived: 93.7853,
          vndFee: 0, targetCurrency: 'VND',
        }),
      });

      assert.equal(response.status, 500);
      assert.equal(transactionCompleted, true);
    });
  });

  it('deletes an exchange and its ledger rows in one transaction scoped to its owner', async () => {
    let deleteArgs: any;
    const deletedMovements: any[] = [];
    const tx = {
      exchange: {
        deleteMany: async (args: any) => { deleteArgs = args; return { count: 1 }; },
      },
      walletMovement: {
        deleteMany: async (args: any) => { deletedMovements.push(args); return { count: 2 }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/exchange-1`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 204);
      assert.deepEqual(deleteArgs.where, { id: 'exchange-1', userId: 'user-42' });
      assert.deepEqual(deletedMovements, [{
        where: { userId: 'user-42', sourceKey: { startsWith: 'exchange:exchange-1:' } },
      }]);
    });
  });

  it('returns 404 and leaves ledger rows untouched when the exchange is absent or owned by someone else', async () => {
    const movementDeleteArgs: any[] = [];
    const tx = {
      exchange: {
        deleteMany: async (args: any) => {
          assert.deepEqual(args.where, { id: 'another-users-exchange', userId: 'user-42' });
          return { count: 0 };
        },
      },
      walletMovement: {
        deleteMany: async (args: any) => { movementDeleteArgs.push(args); return { count: 1 }; },
      },
    };
    client.$transaction = async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx);

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges/another-users-exchange`, {
        method: 'DELETE',
        headers: { authorization: bearer('user-42') },
      });

      assert.equal(response.status, 404);
      assert.deepEqual(movementDeleteArgs, [], 'ledger deletion must not run if the owner-scoped exchange delete matched no row');
    });
  });
});


describe('exchange list response privacy', () => {
  it('scopes the query to the authenticated user and omits the internal userId field', async () => {
    let queryArgs: any;
    exchangeModel.findMany = async (args: any) => {
      queryArgs = args;
      return [{
        id: 'exchange-list-1', mode: 'RUB_USDT_VND',
        targetCurrency: 'VND', targetReceived: null, targetToVndRate: null,
        targetVndEquivalent: null, rubSpent: 8300, usdtReceived: 93.7853,
        vndPerUsdt: null, planningVndPerUsdt: 25400, vndFee: 0,
        vndReceived: null, effectiveVndPerRub: null, effectiveRubPerUsdt: 88.5,
        createdAt: new Date('2026-10-18T08:00:00.000Z'),
      }];
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges`, {
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as Array<Record<string, unknown>>;
      assert.equal(body.length, 1);
      assert.equal(body[0].id, 'exchange-list-1');
      assert.equal('userId' in body[0], false);
    });

    assert.deepEqual(queryArgs.where, { userId: 'user-42' });
    assert.deepEqual(queryArgs.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
    assert.equal(queryArgs.take, 100);
    assert.equal('userId' in queryArgs.select, false);
  });
});

describe('exchange cursor pagination', () => {
  it('returns a page and next cursor without exposing owner identifiers', async () => {
    let queryArgs: any;
    exchangeModel.findMany = async (args: any) => {
      queryArgs = args;
      return [
        { id: 'exchange-a', createdAt: new Date('2026-10-19T10:00:00.000Z') },
        { id: 'exchange-b', createdAt: new Date('2026-10-18T10:00:00.000Z') },
      ];
    };
    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/exchanges?limit=1`, {
        headers: { authorization: bearer('user-42') },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { items: Array<{ id: string; userId?: string }>; hasMore: boolean; nextCursor: string | null };
      assert.deepEqual(body.items.map(item => item.id), ['exchange-a']);
      assert.equal('userId' in body.items[0], false);
      assert.equal(body.hasMore, true);
      assert.equal(typeof body.nextCursor, 'string');
    });
    assert.equal(queryArgs.take, 2);
    assert.deepEqual(queryArgs.where.userId, 'user-42');
    assert.deepEqual(queryArgs.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});
