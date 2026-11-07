import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { auth } from './auth.js';
import type { AuthedRequest } from '../types.js';

const secret = 'flowmoney-auth-middleware-test-secret-32-chars';
process.env.JWT_SECRET = secret;

function invoke(authorization?: string) {
  const req = {
    header: (name: string) => name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as unknown as AuthedRequest;
  let statusCode = 200;
  let responseBody: unknown;
  let nextCalled = false;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
  } as unknown as Response;
  auth(req, res, (() => { nextCalled = true; }) as NextFunction);
  return { req, statusCode, responseBody, nextCalled };
}

test('accepts a valid HS256 session and attaches only validated identity claims', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  const result = invoke(`Bearer ${token}`);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user?.id, 'user_123');
  assert.equal(result.req.user?.email, 'user@example.test');
});

test('rejects an HS384 token even when signed with the same secret', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS384' });
  const result = invoke(`Bearer ${token}`);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});

test('rejects tokens with incorrectly typed identity claims', () => {
  const token = jwt.sign({ id: 123, email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  const result = invoke(`Bearer ${token}`);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});

test('rejects requests without a bearer token', () => {
  const result = invoke();
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});
