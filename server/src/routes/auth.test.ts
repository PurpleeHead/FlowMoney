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

    const todayString = today.toISOString().slice(0, 10);
    const invalidWeeklyIncome = await post('/api/personal-finance/income-sources', {
      title: 'Invalid weekly income', amount: 100, recurrence: 'WEEKLY',
      recurrenceConfig: { weekdays: [] }, startDate: todayString,
    }, first.token);
    assert.equal(invalidWeeklyIncome.status, 400, 'empty weekly weekday selection must be rejected as a client validation error');
    const invalidTwiceMonthlyObligation = await post('/api/personal-finance/obligations', {
      title: 'Invalid twice-monthly obligation', category: 'housing', amount: 100,
      recurrence: 'TWICE_MONTHLY', recurrenceConfig: { firstDay: 10, secondDay: 10 }, startDate: todayString,
    }, first.token);
    assert.equal(invalidTwiceMonthlyObligation.status, 400, 'duplicate twice-monthly dates must be rejected as a client validation error');

    const recurringIncome = await post('/api/personal-finance/income-sources', {
      title: 'Schedule edit test income', amount: 300, recurrence: 'MONTHLY',
      recurrenceConfig: { day: Number(todayString.slice(-2)) }, startDate: todayString,
    }, first.token);
    assert.equal(recurringIncome.status, 201);
    const recurringIncomeSource = await recurringIncome.json() as { id: string };
    const incomeScheduleEdit = await patch(`/api/personal-finance/income-sources/${recurringIncomeSource.id}`, {
      recurrence: 'ONCE', recurrenceConfig: {},
    }, first.token);
    assert.equal(incomeScheduleEdit.status, 200);
    const updatedIncomeSchedules = await get(`/api/personal-finance/income-sources?from=${todayString}`, first.token);
    const updatedIncomeData = await updatedIncomeSchedules.json() as { entries: Array<{ id: string; sourceId: string }> };
    const updatedIncomeEntry = updatedIncomeData.entries.find(item => item.sourceId === recurringIncomeSource.id);
    assert.ok(updatedIncomeEntry, 'edited one-time income schedule should keep its next occurrence');
    assert.equal(updatedIncomeData.entries.filter(item => item.sourceId === recurringIncomeSource.id).length, 1,
      'editing an income schedule must remove obsolete future generated occurrences');
    const skipScheduleIncome = await patch(`/api/personal-finance/income-entries/${updatedIncomeEntry.id}`, { status: 'SKIPPED' }, first.token);
    assert.equal(skipScheduleIncome.status, 200);

    const recurringObligation = await post('/api/personal-finance/obligations', {
      title: 'Schedule edit test obligation', category: 'housing', amount: 200,
      recurrence: 'MONTHLY', recurrenceConfig: { day: Number(todayString.slice(-2)) }, startDate: todayString,
    }, first.token);
    assert.equal(recurringObligation.status, 201);
    const recurringObligationRecord = await recurringObligation.json() as { id: string };
    const obligationScheduleEdit = await patch(`/api/personal-finance/obligations/${recurringObligationRecord.id}`, {
      recurrence: 'ONCE', recurrenceConfig: {},
    }, first.token);
    assert.equal(obligationScheduleEdit.status, 200);
    const updatedObligationSchedules = await get(`/api/personal-finance/obligations?from=${todayString}`, first.token);
    const updatedObligationData = await updatedObligationSchedules.json() as {
      occurrences: Array<{ id: string; obligationId: string }>;
    };
    const updatedObligationOccurrence = updatedObligationData.occurrences.find(item => item.obligationId === recurringObligationRecord.id);
    assert.ok(updatedObligationOccurrence, 'edited one-time obligation schedule should keep its next occurrence');
    assert.equal(updatedObligationData.occurrences.filter(item => item.obligationId === recurringObligationRecord.id).length, 1,
      'editing an obligation schedule must remove obsolete future generated occurrences');
    const skipScheduleObligation = await post(`/api/personal-finance/obligation-occurrences/${updatedObligationOccurrence.id}/skip`, {}, first.token);
    assert.equal(skipScheduleObligation.status, 200);

    // Deactivating and reactivating a recurring income source must restore its future schedule.
    const reactivationIncome = await post('/api/personal-finance/income-sources', {
      title: 'Reactivation income test', amount: 300, recurrence: 'MONTHLY',
      recurrenceConfig: { day: Number(todayString.slice(-2)) }, startDate: todayString,
    }, first.token);
    assert.equal(reactivationIncome.status, 201);
    const reactivationIncomeSource = await reactivationIncome.json() as { id: string };
    const deactivateIncome = await patch(`/api/personal-finance/income-sources/${reactivationIncomeSource.id}`, { isActive: false }, first.token);
    assert.equal(deactivateIncome.status, 200);
    const inactiveIncomeRows = await get(`/api/personal-finance/income-sources?from=${todayString}`, first.token);
    const inactiveIncomeData = await inactiveIncomeRows.json() as { entries: Array<{ sourceId: string }> };
    assert.equal(inactiveIncomeData.entries.filter(item => item.sourceId === reactivationIncomeSource.id).length, 0);
    const reactivateIncome = await patch(`/api/personal-finance/income-sources/${reactivationIncomeSource.id}`, { isActive: true }, first.token);
    assert.equal(reactivateIncome.status, 200);
    const restoredIncomeRows = await get(`/api/personal-finance/income-sources?from=${todayString}`, first.token);
    const restoredIncomeData = await restoredIncomeRows.json() as { entries: Array<{ sourceId: string; status: string }> };
    assert.ok(restoredIncomeData.entries.some(item => item.sourceId === reactivationIncomeSource.id && item.status === 'PLANNED'),
      'reactivating an income source must regenerate its future planned entries');
    const cleanupIncomeSource = await patch(`/api/personal-finance/income-sources/${reactivationIncomeSource.id}`, { isActive: false }, first.token);
    assert.equal(cleanupIncomeSource.status, 200);

    const obligationResponse = await post('/api/personal-finance/obligations', {
      title: 'Concurrent rent payment', category: 'housing', amount: 700,
      recurrence: 'ONCE', recurrenceConfig: {}, startDate: todayString,
    }, first.token);
    assert.equal(obligationResponse.status, 201);
    // Deactivating and reactivating an obligation must restore unpaid future occurrences.
    const reactivationObligation = await post('/api/personal-finance/obligations', {
      title: 'Reactivation obligation test', category: 'housing', amount: 450,
      recurrence: 'MONTHLY', recurrenceConfig: { day: Number(todayString.slice(-2)) }, startDate: todayString,
    }, first.token);
    assert.equal(reactivationObligation.status, 201);
    const reactivationObligationRecord = await reactivationObligation.json() as { id: string };
    const deactivateObligation = await patch(`/api/personal-finance/obligations/${reactivationObligationRecord.id}`, { isActive: false }, first.token);
    assert.equal(deactivateObligation.status, 200);
    const inactiveObligationRows = await get(`/api/personal-finance/obligations?from=${todayString}`, first.token);
    const inactiveObligationData = await inactiveObligationRows.json() as { occurrences: Array<{ obligationId: string }> };
    assert.equal(inactiveObligationData.occurrences.filter(item => item.obligationId === reactivationObligationRecord.id).length, 0);
    const reactivateObligation = await patch(`/api/personal-finance/obligations/${reactivationObligationRecord.id}`, { isActive: true }, first.token);
    assert.equal(reactivateObligation.status, 200);
    const restoredObligationRows = await get(`/api/personal-finance/obligations?from=${todayString}`, first.token);
    const restoredObligationData = await restoredObligationRows.json() as { occurrences: Array<{ obligationId: string; status: string }> };
    assert.ok(restoredObligationData.occurrences.some(item => item.obligationId === reactivationObligationRecord.id && ['UPCOMING', 'OVERDUE'].includes(item.status)),
      'reactivating an obligation must regenerate its unpaid future occurrences');
    const cleanupObligation = await patch(`/api/personal-finance/obligations/${reactivationObligationRecord.id}`, { isActive: false }, first.token);
    assert.equal(cleanupObligation.status, 200);

    const obligationsResponse = await get(`/api/personal-finance/obligations?from=${todayString}&to=${todayString}`, first.token);
    assert.equal(obligationsResponse.status, 200);
    const obligationsData = await obligationsResponse.json() as { occurrences: Array<{ id: string; status: string }> };
    const occurrence = obligationsData.occurrences.find(item => item.status === 'UPCOMING');
    assert.ok(occurrence, 'one-time obligation occurrence should be generated');

    const paymentResponses = await Promise.all([
      post(`/api/personal-finance/obligation-occurrences/${occurrence.id}/pay`, { actualAmount: 750 }, first.token),
      post(`/api/personal-finance/obligation-occurrences/${occurrence.id}/pay`, { actualAmount: 750 }, first.token),
    ]);
    assert.ok(paymentResponses.every(response => response.status === 200));
    const paymentResults = await Promise.all(paymentResponses.map(response => response.json() as Promise<{ status: string; expenseId: string | null }>));
    assert.ok(paymentResults.every(result => result.status === 'PAID'));
    assert.equal(new Set(paymentResults.map(result => result.expenseId)).size, 1, 'concurrent payment requests must resolve to the same linked expense');

    const expensesResponse = await get('/api/personal-finance/expenses', first.token);
    const expensesData = await expensesResponse.json() as { expenses: Array<{ title: string }> };
    assert.equal(expensesData.expenses.filter(item => item.title === 'Concurrent rent payment').length, 1);
    const afterPaymentDashboard = await get('/api/personal-finance/dashboard', first.token);
    const afterPaymentData = await afterPaymentDashboard.json() as { actual: { balance: number }; obligations: { paid: number } };
    assert.equal(Number(afterPaymentData.actual.balance), 250, 'the actual payment amount must reduce the actual balance exactly once');
    assert.equal(Number(afterPaymentData.obligations.paid), 750, 'paid obligation reporting must use the actual amount, not the planned amount');

    const plannedIncomeResponse = await post('/api/personal-finance/income-entries', {
      plannedDate: todayString, plannedAmount: 1000,
    }, first.token);
    assert.equal(plannedIncomeResponse.status, 201);
    const plannedIncome = await plannedIncomeResponse.json() as { id: string };
    const beforeReceiptDashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await beforeReceiptDashboard.json() as { actual: { balance: number } }).actual.balance), 250,
      'planned income must not affect the actual balance');

    const receivedIncome = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, { actualAmount: 1200 }, first.token);
    assert.equal(receivedIncome.status, 200);
    const duplicateReceipt = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, { actualAmount: 9000 }, first.token);
    assert.equal(duplicateReceipt.status, 200);
    const afterReceiptDashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await afterReceiptDashboard.json() as { actual: { balance: number } }).actual.balance), 1450,
      'receiving the same income entry again must not count it twice or overwrite the first actual amount');

    // A future selected report month must not hide planned income and obligations due before that month.
    const forecastIncome = await post('/api/personal-finance/income-entries', {
      plannedDate: futureDate, plannedAmount: 500,
    }, first.token);
    assert.equal(forecastIncome.status, 201);
    const forecastObligation = await post('/api/personal-finance/obligations', {
      title: 'Upcoming forecast commitment', category: 'housing', amount: 250,
      recurrence: 'ONCE', recurrenceConfig: {}, startDate: futureDate,
    }, first.token);
    assert.equal(forecastObligation.status, 201);
    const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const nextMonthFrom = nextMonth.toISOString().slice(0, 10);
    const nextMonthEnd = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const futureMonthDashboard = await get(
      `/api/personal-finance/dashboard?from=${nextMonthFrom}&to=${nextMonthEnd}&horizon=${nextMonthEnd}`,
      first.token,
    );
    assert.equal(futureMonthDashboard.status, 200);
    const futureMonthData = await futureMonthDashboard.json() as {
      forecast: { plannedIncome: number; unpaidObligations: number; balance: number };
    };
    assert.equal(Number(futureMonthData.forecast.plannedIncome), 500,
      'forecast must include planned income between today and a future selected month');
    assert.equal(Number(futureMonthData.forecast.unpaidObligations), 250,
      'forecast must include unpaid obligations due before a future selected month');
    assert.equal(Number(futureMonthData.forecast.balance), 1700,
      'future-month forecast must reconcile from current actual balance plus near-term income less near-term obligations');

    const priorMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const priorFrom = priorMonth.toISOString().slice(0, 10);
    const priorTo = new Date(Date.UTC(priorMonth.getUTCFullYear(), priorMonth.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const historical = await get(`/api/personal-finance/dashboard?from=${priorFrom}&to=${priorTo}&horizon=${priorTo}`, first.token);
    assert.equal(historical.status, 200);
    const historicalData = await historical.json() as { period: { horizon: string } };
    assert.equal(historicalData.period.horizon, todayString);

    // Concurrent receipt requests must atomically preserve exactly one actual amount.
    // Income reporting follows the configured local calendar day, not UTC date boundaries.
    const timezoneUpdate = await patch('/api/personal-finance/settings', { timezone: 'America/Los_Angeles' }, first.token);
    assert.equal(timezoneUpdate.status, 200);
    const timezoneIncomeResponse = await post('/api/personal-finance/income-entries', {
      plannedDate: todayString, plannedAmount: 250,
    }, first.token);
    assert.equal(timezoneIncomeResponse.status, 201);
    const timezoneIncome = await timezoneIncomeResponse.json() as { id: string };
    const timezoneReceipt = await post(`/api/personal-finance/income-entries/${timezoneIncome.id}/receive`, {
      actualAmount: 250, receivedAt: '2026-11-01T06:30:00.000Z',
    }, first.token);
    assert.equal(timezoneReceipt.status, 200);
    const localDayAnalytics = await get('/api/personal-finance/analytics?from=2026-10-31&to=2026-10-31', first.token);
    assert.equal(localDayAnalytics.status, 200);
    const localDayAnalyticsData = await localDayAnalytics.json() as { totals: { income: number }; months: Array<{ month: string; income: number }> };
    assert.equal(Number(localDayAnalyticsData.totals.income), 250,
      'a receipt at 23:30 on October 31 in Los Angeles must belong to October 31, not November 1 UTC');
    assert.equal(localDayAnalyticsData.months[0]?.month, '2026-10',
      'monthly analytics must use the receipt local date when assigning the month');
    const localDayDashboard = await get('/api/personal-finance/dashboard?from=2026-10-31&to=2026-10-31', first.token);
    assert.equal(localDayDashboard.status, 200);
    const localDayDashboardData = await localDayDashboard.json() as { actual: { income: number } };
    assert.equal(Number(localDayDashboardData.actual.income), 250);
    const restoreTimezone = await patch('/api/personal-finance/settings', { timezone: 'Europe/Moscow' }, first.token);
    assert.equal(restoreTimezone.status, 200);

    const concurrentIncomeResponse = await post('/api/personal-finance/income-entries', {
      plannedDate: todayString, plannedAmount: 1100,
    }, first.token);
    assert.equal(concurrentIncomeResponse.status, 201);
    const concurrentIncome = await concurrentIncomeResponse.json() as { id: string };
    const concurrentReceipts = await Promise.all([
      post(`/api/personal-finance/income-entries/${concurrentIncome.id}/receive`, { actualAmount: 1300 }, first.token),
      post(`/api/personal-finance/income-entries/${concurrentIncome.id}/receive`, { actualAmount: 1700 }, first.token),
    ]);
    assert.ok(concurrentReceipts.every(response => response.status === 200));
    const concurrentReceiptResults = await Promise.all(concurrentReceipts.map(response => response.json() as Promise<{ status: string; actualAmount: number }>));
    assert.ok(concurrentReceiptResults.every(result => result.status === 'RECEIVED'));
    assert.ok([1300, 1700].includes(Number(concurrentReceiptResults[0].actualAmount)));
    assert.equal(Number(concurrentReceiptResults[0].actualAmount), Number(concurrentReceiptResults[1].actualAmount),
      'concurrent receipt requests must return the same winning actual amount');
    const afterConcurrentReceiptDashboard = await get('/api/personal-finance/dashboard', first.token);
    const afterConcurrentReceiptData = await afterConcurrentReceiptDashboard.json() as { actual: { balance: number } };
    assert.equal(Number(afterConcurrentReceiptData.actual.balance), 1450 + Number(concurrentReceiptResults[0].actualAmount),
      'concurrent receipt requests must add the winning actual amount to the balance exactly once');

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

    const foreignPayment = await post(`/api/personal-finance/obligation-occurrences/${occurrence.id}/pay`, {}, second.token);
    assert.equal(foreignPayment.status, 404, 'another account must not be able to pay this household obligation');
    const foreignReceipt = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, {}, second.token);
    assert.equal(foreignReceipt.status, 404, 'another account must not be able to receive this household income');

    const secondMemberResponse = await post('/api/personal-finance/members', { name: 'Second household member' }, second.token);
    assert.equal(secondMemberResponse.status, 201);
    const secondMember = await secondMemberResponse.json() as { id: string };
    const foreignMemberExpense = await post('/api/personal-finance/expenses', {
      title: 'Foreign member expense', amount: 100, date: todayString, memberId: secondMember.id,
    }, first.token);
    assert.equal(foreignMemberExpense.status, 400, 'a household cannot assign records to another account member');

    const firstMembers = await get('/api/personal-finance/members', first.token);
    const secondMembers = await get('/api/personal-finance/members', second.token);
    assert.equal(firstMembers.status, 200);
    assert.equal(secondMembers.status, 200);
    assert.equal((await firstMembers.json() as unknown[]).length, 1);
    assert.equal((await secondMembers.json() as unknown[]).length, 1);

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
