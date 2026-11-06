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
  const thirdEmail = `flowmoney-test-race-${suffix}@example.test`;
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
  const patch = (path: string, body: unknown, token: string) => fetch(baseUrl + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  try {
    const frontend = await get('/');
    assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /FLOWMONEY/i);

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

    const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (name: string) => todayParts.find(item => item.type === name)?.value ?? '';
    const today = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00.000Z`);
    const future = new Date(today);
    future.setUTCDate(future.getUTCDate() + 7);
    const futureDate = future.toISOString().slice(0, 10);
    const settings = await patch('/api/personal-finance/settings', { openingBalance: 1000, openingBalanceDate: today.toISOString().slice(0, 10) }, first.token);
    assert.equal(settings.status, 200);
    const futureExpense = await post('/api/personal-finance/expenses', { title: 'Future test expense', amount: 500, date: futureDate }, first.token);
    assert.equal(futureExpense.status, 201);
    const dashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(dashboard.status, 200);
    const dashboardData = await dashboard.json() as { actual: { balance: number } };
    assert.equal(Number(dashboardData.actual.balance), 1000);

    const budgetPayload = { periodMonth: today.toISOString().slice(0, 7) + '-01', limitAmount: 10000 };
    const budgetResponses = await Promise.all([
      post('/api/personal-finance/budgets', budgetPayload, first.token),
      post('/api/personal-finance/budgets', { ...budgetPayload, limitAmount: 12000 }, first.token),
    ]);
    assert.ok(budgetResponses.every(response => response.status === 200 || response.status === 201));
    const budgets = await get('/api/personal-finance/budgets', first.token);
    assert.equal((await budgets.json() as unknown[]).length, 1);

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

    const concurrentRegistrations = await Promise.all([
      post('/api/auth/register', { email: thirdEmail, password: 'Concurrent-safe-password-123!' }),
      post('/api/auth/register', { email: thirdEmail.toUpperCase(), password: 'Concurrent-safe-password-123!' }),
    ]);
    assert.deepEqual(concurrentRegistrations.map(response => response.status).sort((a, b) => a - b), [201, 409]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.user.deleteMany({ where: { email: { in: [firstEmail, secondEmail, thirdEmail] } } });
  }
});
