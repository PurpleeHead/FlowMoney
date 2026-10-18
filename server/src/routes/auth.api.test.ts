import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';

const userModel = prisma.user as unknown as { findFirst: (...args: any[]) => Promise<any> };
const originalUserFindFirst = userModel.findFirst;
import authRoutes from './auth.js';

const userModel = prisma.user as unknown as {
  findUnique: (...args: any[]) => Promise<any>;
  update: (...args: any[]) => Promise<any>;
  create: (...args: any[]) => Promise<any>;
};
const originalFindUnique = userModel.findUnique;
const originalUpdate = userModel.update;
const originalCreate = userModel.create;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findFirst = originalUserFindFirst;
  userModel.findUnique = originalFindUnique;
  userModel.update = originalUpdate;
  userModel.create = originalCreate;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
  userModel.findFirst = async () => ({ tokenVersion: 0 });
  process.env.JWT_SECRET = 'auth-profile-test-secret-which-is-long-enough';
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
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
  return `Bearer ${jwt.sign({ id: userId, email: `${userId}@example.com` }, 'auth-profile-test-secret-which-is-long-enough')}`;
}

describe('auth profile ownership', () => {
  it('updates only the authenticated user profile and ignores userId in the body', async () => {
    let updateArgs: any;
    userModel.update = async (args: any) => {
      updateArgs = args;
      return { id: 'user-1', email: 'user-1@example.com', name: 'Updated', country: 'Vietnam', createdAt: new Date() };
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/profile`, {
        method: 'PATCH',
        headers: { authorization: bearer('user-1'), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Updated', country: 'Vietnam', userId: 'another-user' }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(updateArgs.where, { id: 'user-1' });
      assert.deepEqual(updateArgs.data, { name: 'Updated', country: 'Vietnam' });
    });
  });

  it('rejects invalid tokens before reading the current profile', async () => {
    let queryCalled = false;
    userModel.findUnique = async () => {
      queryCalled = true;
      return null;
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { authorization: 'Bearer not-a-valid-token' },
      });
      assert.equal(response.status, 401);
      assert.equal(queryCalled, false);
    });
  });
});

describe('password change safeguards', () => {
  const currentPassword = 'Current-password-123';
  let currentHash: string;

  it('rejects an incorrect current password without updating the account', async () => {
    currentHash = await bcrypt.hash(currentPassword, 4);
    userModel.findUnique = async args => {
      assert.deepEqual(args.where, { id: 'user-1' });
      assert.deepEqual(args.select, { id: true, passwordHash: true });
      return { id: 'user-1', passwordHash: currentHash };
    };
    let updateCalled = false;
    userModel.update = async () => {
      updateCalled = true;
      throw new Error('must not update password');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: { authorization: bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'New-password-456' }),
      });
      assert.equal(response.status, 400);
      assert.equal(updateCalled, false);
    });
  });

  it('rejects reusing the current password without updating the account', async () => {
    currentHash = await bcrypt.hash(currentPassword, 4);
    userModel.findUnique = async () => ({ id: 'user-1', passwordHash: currentHash });
    let updateCalled = false;
    userModel.update = async () => {
      updateCalled = true;
      throw new Error('must not update password');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: { authorization: bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword: currentPassword }),
      });
      assert.equal(response.status, 400);
      assert.equal(updateCalled, false);
    });
  });

  it('stores only a hash for the authenticated account and never returns it', async () => {
    currentHash = await bcrypt.hash(currentPassword, 4);
    userModel.findUnique = async () => ({ id: 'user-1', passwordHash: currentHash });
    let updateArgs: any;
    userModel.update = async args => {
      updateArgs = args;
      return { id: 'user-1' };
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PATCH',
        headers: { authorization: bearer(), 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword: 'New-password-456' }),
      });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 200);
      assert.deepEqual(updateArgs.where, { id: 'user-1' });
      assert.equal(typeof updateArgs.data.passwordHash, 'string');
      assert.notEqual(updateArgs.data.passwordHash, 'New-password-456');
      assert.equal(await bcrypt.compare('New-password-456', updateArgs.data.passwordHash), true);
      assert.equal('passwordHash' in body, false);
    });
  });
});

describe('registration validation and duplicate handling', () => {
  it('normalizes email and never returns credentials in the response', async () => {
    let lookupArgs: any;
    let createArgs: any;
    userModel.findUnique = async args => {
      lookupArgs = args;
      return null;
    };
    userModel.create = async args => {
      createArgs = args;
      return { id: 'created-user' };
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: '  Test.User@Example.COM  ', password: 'Valid-password-123' }),
      });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 201);
      assert.deepEqual(lookupArgs.where, { email: 'test.user@example.com' });
      assert.equal(createArgs.data.email, 'test.user@example.com');
      assert.equal(await bcrypt.compare('Valid-password-123', createArgs.data.passwordHash), true);
      assert.equal('passwordHash' in body, false);
      assert.equal('token' in body, false);
    });
  });

  it('rejects a short password before any database operation', async () => {
    let dbCalled = false;
    userModel.findUnique = async () => {
      dbCalled = true;
      return null;
    };
    userModel.create = async () => {
      dbCalled = true;
      throw new Error('must not create');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'valid@example.com', password: 'short' }),
      });
      assert.equal(response.status, 400);
      assert.equal(dbCalled, false);
    });
  });

  it('returns conflict when the email already exists', async () => {
    let createCalled = false;
    userModel.findUnique = async () => ({ id: 'existing-user' });
    userModel.create = async () => {
      createCalled = true;
      throw new Error('must not create duplicate');
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'existing@example.com', password: 'Valid-password-123' }),
      });
      assert.equal(response.status, 409);
      assert.equal(createCalled, false);
    });
  });

  it('returns conflict if a concurrent registration wins the unique-email race', async () => {
    userModel.findUnique = async () => null;
    userModel.create = async () => {
      const error = new Error('Unique constraint failed') as Error & { code: string; meta: { target: string[] } };
      error.code = 'P2002';
      error.meta = { target: ['email'] };
      throw error;
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'race@example.com', password: 'Valid-password-123' }),
      });
      assert.equal(response.status, 409);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.message, 'An account with this email already exists.');
    });
  });
});


describe('registration unique constraint scope', () => {
  it('does not misreport unrelated unique constraint failures as duplicate email', async () => {
    userModel.findUnique = async () => null;
    userModel.create = async () => {
      const error = new Error('Unique constraint failed') as Error & { code: string; meta: { target: string[] } };
      error.code = 'P2002';
      error.meta = { target: ['someOtherField'] };
      throw error;
    };

    await withApi(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'unrelated@example.com', password: 'Valid-password-123' }),
      });
      assert.equal(response.status, 500);
    });
  });
});
