import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { auth } from './auth.js';
import type { AuthedRequest } from '../types.js';

const secret = 'auth-middleware-test-secret-at-least-32-characters';
const previousSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

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
    process.env.JWT_SECRET = secret;
    const result = runAuth();
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects malformed tokens', () => {
    process.env.JWT_SECRET = secret;
    const result = runAuth('Bearer not-a-valid-token');
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects expired tokens', () => {
    process.env.JWT_SECRET = secret;
    const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, secret, { expiresIn: -1 });
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects a validly signed token without required user claims', () => {
    process.env.JWT_SECRET = secret;
    const token = jwt.sign({ sub: 'user-1' }, secret);
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('rejects a token with non-string identity claims', () => {
    process.env.JWT_SECRET = secret;
    const token = jwt.sign({ id: 123, email: ['user@example.com'] }, secret);
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('accepts a valid bearer token and attaches only the authenticated identity', () => {
    process.env.JWT_SECRET = secret;
    const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, secret);
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.user, { id: 'user-1', email: 'user@example.com' });
  });

  it('fails closed when the JWT secret is not configured', () => {
    delete process.env.JWT_SECRET;
    const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, secret);
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  it('fails closed when the configured JWT secret is shorter than 32 characters', () => {
    process.env.JWT_SECRET = 'short-secret';
    const token = jwt.sign({ id: 'user-1', email: 'user@example.com' }, 'short-secret');
    const result = runAuth(`Bearer ${token}`);
    assert.equal(result.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });
});
