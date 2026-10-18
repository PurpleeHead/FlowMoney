import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { auth } from './auth.js';
import type { AuthedRequest } from '../types.js';

function runAuth(authorization?: string) {
  let statusCode = 200;
  let body: unknown;
  let nextCalled = false;
  const req = {
    header: (name: string) => name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as unknown as AuthedRequest;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  const next = () => { nextCalled = true; };
  auth(req, res as never, next as never);
  return { statusCode, body, nextCalled, user: req.user };
}

describe('auth middleware used by wallet and journal APIs', () => {
  it('rejects requests without a bearer token', () => {
    process.env.JWT_SECRET = 'test-secret';
    const result = runAuth();
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects malformed and expired/invalid tokens', () => {
    process.env.JWT_SECRET = 'test-secret';
    const result = runAuth('Bearer not-a-valid-token');
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects a validly signed token without required user claims', () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = jwt.sign({ sub: 'user-1' }, 'test-secret');
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('accepts a valid bearer token and attaches only the authenticated identity', () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, 'test-secret');
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.user, { id: 'user-1', email: 'user@example.com' });
  });

  it('fails closed when the JWT secret is not configured', () => {
    const previous = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, 'temporary-secret');
      const result = runAuth(`Bearer ${token}`);
      assert.equal(result.statusCode, 401);
      assert.equal(result.nextCalled, false);
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });
});
