import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { readSessionClaims } from './auth.js';

const secret = 'flowmoney-auth-middleware-test-secret-32-chars';
process.env.JWT_SECRET = secret;

test('accepts a valid HS256 session and attaches only validated identity claims', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  const result = readSessionClaims(token, secret);
  assert.deepEqual(result, { id: 'user_123', email: 'user@example.test', sessionVersion: 0 });
});

test('rejects an HS384 token even when signed with the same secret', () => {
  const token = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS384' });
  assert.equal(readSessionClaims(token, secret), null);
});

test('rejects tokens with incorrectly typed identity claims', () => {
  const token = jwt.sign({ id: 123, email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  assert.equal(readSessionClaims(token, secret), null);
});

test('accepts only a non-negative integer session version and defaults legacy tokens to version zero', () => {
  const legacy = jwt.sign({ id: 'user_123', email: 'user@example.test' }, secret, { algorithm: 'HS256' });
  assert.equal(readSessionClaims(legacy, secret)?.sessionVersion, 0);
  const versioned = jwt.sign({ id: 'user_123', email: 'user@example.test', sessionVersion: 4 }, secret, { algorithm: 'HS256' });
  assert.equal(readSessionClaims(versioned, secret)?.sessionVersion, 4);
  const malformed = jwt.sign({ id: 'user_123', email: 'user@example.test', sessionVersion: '4' }, secret, { algorithm: 'HS256' });
  assert.equal(readSessionClaims(malformed, secret)?.sessionVersion, 0);
});

