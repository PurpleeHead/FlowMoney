import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { prisma } from '../services/prisma.js';

test('authentication works and household records stay isolated between accounts', { skip: !process.env.DATABASE_URL }, async () => {
  process.env.JWT_SECRET = 'flowmoney-integration-test-secret-32-chars-minimum';
  const suffix = randomUUID();
  const firstEmail = `flowmoney-test-${suffix}@example.test`;
  const secondEmail = `flowmoney-test-other-${suffix}@example.test`;
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, token?: string) => fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path: string, token?: string) => fetch(baseUrl + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  try {
    const unauthenticated = await get('/api/personal-finance/members');
    assert.equal(unauthenticated.status, 401);

    const firstResponse = await post('/api/auth/register', { email: firstEmail, password: 'Safe-test-password-123!' });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json() as { token: string; user: { id: string; email: string } };
    assert.equal(first.user.email, firstEmail);

    const duplicate = await post('/api/auth/register', { email: firstEmail.toUpperCase(), password: 'Safe-test-password-123!' });
    assert.equal(duplicate.status, 409);

    const login = await post('/api/auth/login', { email: firstEmail, password: 'Safe-test-password-123!' });
    assert.equal(login.status, 200);
    const loggedIn = await login.json() as { token: string };
    assert.ok(loggedIn.token);

    const createdMember = await post('/api/personal-finance/members', { name: 'First household member' }, first.token);
    assert.equal(createdMember.status, 201);

    const secondResponse = await post('/api/auth/register', { email: secondEmail, password: 'Another-safe-password-123!' });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as { token: string };

    const firstMembers = await get('/api/personal-finance/members', first.token);
    const secondMembers = await get('/api/personal-finance/members', second.token);
    assert.equal(firstMembers.status, 200);
    assert.equal(secondMembers.status, 200);
    assert.equal((await firstMembers.json() as unknown[]).length, 1);
    assert.equal((await secondMembers.json() as unknown[]).length, 0);

    const invalidLogin = await post('/api/auth/login', { email: firstEmail, password: 'incorrect-password' });
    assert.equal(invalidLogin.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.user.deleteMany({ where: { email: { in: [firstEmail, secondEmail] } } });
  }
});
