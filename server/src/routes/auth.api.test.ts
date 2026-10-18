import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { AddressInfo } from 'node:net';
import { prisma } from '../services/prisma.js';
import authRoutes from './auth.js';

const userModel = prisma.user as unknown as {
  findUnique: (...args: any[]) => Promise<any>;
  update: (...args: any[]) => Promise<any>;
};
const originalFindUnique = userModel.findUnique;
const originalUpdate = userModel.update;
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  userModel.findUnique = originalFindUnique;
  userModel.update = originalUpdate;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function withApi(run: (baseUrl: string) => Promise<void>) {
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
