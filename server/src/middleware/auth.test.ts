import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { readSessionClaims } from './auth.js';

const secret = 'flowmoney-auth-middleware-test-secret-32-chars';
process.env.JWT_SECRET = secret;

test('accepts a valid HS256 session and attaches only validated identity claims', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  const result = readSessionClaims(token, secret);
  assert.deepEqual(result, { id: 'user_123', email: 'user@example.test' });
});

test('rejects an HS384 token even when signed with the same secret', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS384' });
  assert.equal(readSessionClaims(token, secret), null);
});

test('rejects tokens with incorrectly typed identity claims', () => {
  const token = jwt.sign({ id: 123, email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  const result = invoke(`Bearer ${token}`);
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});

