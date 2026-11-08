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
  const fourthEmail = `flowmoney-test-foreign-${suffix}@example.test`;
  const fifthEmail = `flowmoney-test-expense-foreign-${suffix}@example.test`;
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
  const del = (path: string, token: string) => fetch(baseUrl + path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
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
    const obligationFilterFuture = new Date(today);
    obligationFilterFuture.setUTCDate(obligationFilterFuture.getUTCDate() + 40);
    const obligationFilterDate = obligationFilterFuture.toISOString().slice(0, 10);
    const settings = await patch('/api/personal-finance/settings', { openingBalance: 1000, openingBalanceDate: today.toISOString().slice(0, 10) }, first.token);
    assert.equal(settings.status, 200);
    const futureExpense = await post('/api/personal-finance/expenses', { title: 'Future test expense', amount: 500, date: futureDate }, first.token);
    assert.equal(futureExpense.status, 201);

    const customCategoryResponse = await post('/api/personal-finance/categories', {
      name: 'Test category', slug: `test-category-${suffix.slice(0, 8)}`,
    }, first.token);
    assert.equal(customCategoryResponse.status, 201);
    const customCategory = await customCategoryResponse.json() as { id: string };
    const editableExpenseResponse = await post('/api/personal-finance/expenses', {
      title: 'Editable future expense', amount: 125, date: futureDate, categoryId: customCategory.id,
    }, first.token);
    assert.equal(editableExpenseResponse.status, 201);
    const editableExpense = await editableExpenseResponse.json() as { id: string };
    const filteredExpenseResponse = await get(`/api/personal-finance/expenses?from=${futureDate}&to=${futureDate}&categoryId=${customCategory.id}`, first.token);
    assert.equal(filteredExpenseResponse.status, 200);
    const filteredExpenseData = await filteredExpenseResponse.json() as { expenses: Array<{ id: string }> };
    assert.ok(filteredExpenseData.expenses.some(item => item.id === editableExpense.id),
      'expense history filters must match the requested date and category');
    const invalidExpenseRange = await get(`/api/personal-finance/expenses?from=not-a-date&to=${futureDate}`, first.token);
    assert.equal(invalidExpenseRange.status, 400, 'invalid expense date filters must be rejected');
    const invalidExpenseCategory = await get(`/api/personal-finance/expenses?categoryId=${randomUUID()}`, first.token);
    assert.equal(invalidExpenseCategory.status, 400, 'foreign or unknown expense categories must be rejected');
    const updatedExpenseResponse = await patch(`/api/personal-finance/expenses/${editableExpense.id}`, {
      title: 'Updated future expense', amount: 150,
    }, first.token);
    assert.equal(updatedExpenseResponse.status, 200);
    assert.equal((await updatedExpenseResponse.json() as { title: string }).title, 'Updated future expense');
    const foreignExpenseEdit = await patch(`/api/personal-finance/expenses/${editableExpense.id}`, { amount: 200 }, (await (async () => {
      const response = await post('/api/auth/register', { email: fifthEmail, password: 'Safe-test-password-123!' });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ token: string }>;
    })()).token);
    assert.equal(foreignExpenseEdit.status, 404, 'another household must not edit this expense');
    const deletedExpense = await del(`/api/personal-finance/expenses/${editableExpense.id}`, first.token);
    assert.equal(deletedExpense.status, 204);
    const repeatedExpenseDelete = await del(`/api/personal-finance/expenses/${editableExpense.id}`, first.token);
    assert.equal(repeatedExpenseDelete.status, 404, 'expense deletion must be idempotently protected');
    const dashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(dashboard.status, 200);
    const dashboardData = await dashboard.json() as { actual: { balance: number } };
    assert.equal(Number(dashboardData.actual.balance), 1000);

    // A member-specific balance must exclude the household opening balance while
    // still including that member's own received income and actual expenses.
    const member = await createdMember.json() as { id: string };
    const memberIncome = await post('/api/personal-finance/income-entries', {
      plannedDate: today.toISOString().slice(0, 10), plannedAmount: 200, memberId: member.id,
    }, first.token);
    assert.equal(memberIncome.status, 201);
    const memberIncomeEntry = await memberIncome.json() as { id: string };
    const receivedMemberIncome = await post(`/api/personal-finance/income-entries/${memberIncomeEntry.id}/receive`, {}, first.token);
    assert.equal(receivedMemberIncome.status, 200);
    const memberExpense = await post('/api/personal-finance/expenses', {
      title: 'Member balance test expense', amount: 50, date: today.toISOString().slice(0, 10), memberId: member.id,
    }, first.token);
    assert.equal(memberExpense.status, 201);
    const memberDashboard = await get(`/api/personal-finance/dashboard?memberId=${member.id}`, first.token);
    assert.equal(memberDashboard.status, 200);
    const memberDashboardData = await memberDashboard.json() as { actual: { balance: number } };
    assert.equal(Number(memberDashboardData.actual.balance), 150,
      'member balance must include member transactions but not the household opening balance');

    const memberAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 25, date: today.toISOString().slice(0, 10), reason: 'Member balance correction', memberId: member.id,
    }, first.token);
    assert.equal(memberAdjustment.status, 201);
    const sharedAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 40, date: today.toISOString().slice(0, 10), reason: 'Shared household correction',
    }, first.token);
    assert.equal(sharedAdjustment.status, 201);
    const adjustedMemberDashboard = await get(`/api/personal-finance/dashboard?memberId=${member.id}`, first.token);
    assert.equal(Number((await adjustedMemberDashboard.json() as { actual: { balance: number } }).actual.balance), 175,
      'member balance must include only adjustments attributed to that member');

    const householdDashboardAfterMemberTransactions = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await householdDashboardAfterMemberTransactions.json() as { actual: { balance: number } }).actual.balance), 1215,
      'household balance must include the opening balance, all member transactions and shared adjustments');

    const todayString = today.toISOString().slice(0, 10);

    // Reject oversized report windows before generating recurring rows or running broad aggregates.
    const wideRange = 'from=2020-01-01&to=2026-11-30';
    for (const path of [
      `/api/personal-finance/income-sources?${wideRange}`,
      `/api/personal-finance/obligations?${wideRange}`,
      `/api/personal-finance/analytics?${wideRange}`,
      `/api/personal-finance/dashboard?${wideRange}`,
    ]) {
      const response = await get(path, first.token);
      assert.equal(response.status, 400, `oversized date range must be rejected: ${path}`);
    }
    const distantForecast = await get('/api/personal-finance/dashboard?from=' + todayString + '&to=' + todayString + '&horizon=2030-01-01', first.token);
    assert.equal(distantForecast.status, 400, 'forecast horizons beyond two years must be rejected');

    for (const path of [
      `/api/personal-finance/income-sources?from=not-a-date&to=${todayString}`,
      `/api/personal-finance/income-entries?from=not-a-date&to=${todayString}`,
      `/api/personal-finance/obligations?from=not-a-date&to=${todayString}`,
      `/api/personal-finance/analytics?from=not-a-date&to=${todayString}`,
      `/api/personal-finance/dashboard?from=not-a-date&to=${todayString}`,
      '/api/personal-finance/analytics?from=2026-02-30&to=2026-03-01',
      `/api/personal-finance/dashboard?from=${todayString}&to=${todayString}&horizon=not-a-date`,
    ]) {
      const response = await get(path, first.token);
      assert.equal(response.status, 400, `malformed date parameters must be rejected: ${path}`);
    }

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

    // Obligation history must honor the same household member/shared filter as the dashboard.
    const memberScopedObligation = await post('/api/personal-finance/obligations', {
      title: 'Member-scoped obligation filter test', category: 'housing', amount: 90,
      recurrence: 'ONCE', startDate: obligationFilterDate, memberId: member.id,
    }, first.token);
    assert.equal(memberScopedObligation.status, 201);
    const sharedScopedObligation = await post('/api/personal-finance/obligations', {
      title: 'Shared obligation filter test', category: 'housing', amount: 80,
      recurrence: 'ONCE', startDate: obligationFilterDate,
    }, first.token);
    assert.equal(sharedScopedObligation.status, 201);
    const memberObligationFilter = await get(`/api/personal-finance/obligations?from=${obligationFilterDate}&to=${obligationFilterDate}&memberId=${member.id}`, first.token);
    assert.equal(memberObligationFilter.status, 200);
    const memberObligationFilterData = await memberObligationFilter.json() as { occurrences: Array<{ obligation: { title: string } }> };
    assert.ok(memberObligationFilterData.occurrences.some(item => item.obligation.title === 'Member-scoped obligation filter test'));
    assert.ok(!memberObligationFilterData.occurrences.some(item => item.obligation.title === 'Shared obligation filter test'));
    const sharedObligationFilter = await get(`/api/personal-finance/obligations?from=${obligationFilterDate}&to=${obligationFilterDate}&memberId=shared`, first.token);
    assert.equal(sharedObligationFilter.status, 200);
    const sharedObligationFilterData = await sharedObligationFilter.json() as { occurrences: Array<{ obligation: { title: string } }> };
    assert.ok(sharedObligationFilterData.occurrences.some(item => item.obligation.title === 'Shared obligation filter test'));
    assert.ok(!sharedObligationFilterData.occurrences.some(item => item.obligation.title === 'Member-scoped obligation filter test'));
    const invalidObligationMemberFilter = await get(`/api/personal-finance/obligations?from=${obligationFilterDate}&to=${obligationFilterDate}&memberId=unknown`, first.token);
    assert.equal(invalidObligationMemberFilter.status, 400);

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
    const afterPaymentData = await afterPaymentDashboard.json() as { actual: { balance: number }; obligations: { paid: number; unpaid: number } };
    assert.equal(Number(afterPaymentData.actual.balance), 465, 'the actual payment amount must reduce the household balance exactly once while retaining member and shared adjustments');
    assert.equal(Number(afterPaymentData.obligations.paid), 750, 'paid obligation reporting must use the actual amount, not the planned amount');
    assert.equal(Number(afterPaymentData.obligations.unpaid), 0, 'overpaying a planned obligation must not create a negative unpaid balance');
    const paidObligationAnalytics = await get(`/api/personal-finance/analytics?from=${todayString}&to=${todayString}`, first.token);
    assert.equal(paidObligationAnalytics.status, 200);
    const paidObligationAnalyticsData = await paidObligationAnalytics.json() as { totals: { obligations: number } };
    assert.equal(Number(paidObligationAnalyticsData.totals.obligations), 750,
      'analytics obligation totals must use the actual amount paid, not the planned amount');

    const plannedIncomeResponse = await post('/api/personal-finance/income-entries', {
      plannedDate: todayString, plannedAmount: 1000,
    }, first.token);
    assert.equal(plannedIncomeResponse.status, 201);
    const plannedIncome = await plannedIncomeResponse.json() as { id: string };
    const listedIncomeResponse = await get(`/api/personal-finance/income-entries?from=${todayString}&to=${todayString}&status=PLANNED`, first.token);
    assert.equal(listedIncomeResponse.status, 200);
    const listedIncomeData = await listedIncomeResponse.json() as { entries: Array<{ id: string; status: string }> };
    assert.ok(listedIncomeData.entries.some(item => item.id === plannedIncome.id && item.status === 'PLANNED'),
      'income entry listing must return matching planned entries with status filtering');
    const invalidIncomeStatus = await get(`/api/personal-finance/income-entries?from=${todayString}&to=${todayString}&status=UNKNOWN`, first.token);
    assert.equal(invalidIncomeStatus.status, 400, 'unknown income entry status filters must be rejected');
    const beforeReceiptDashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await beforeReceiptDashboard.json() as { actual: { balance: number } }).actual.balance), 465,
      'planned income must not affect the actual balance');

    const receivedIncome = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, { actualAmount: 1200 }, first.token);
    assert.equal(receivedIncome.status, 200);
    const duplicateReceipt = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, { actualAmount: 9000 }, first.token);
    assert.equal(duplicateReceipt.status, 200);

    // One-time planned income is deletable; received history and another account's records are not.
    const disposableIncomeResponse = await post('/api/personal-finance/income-entries', {
      plannedDate: todayString, plannedAmount: 350,
    }, first.token);
    assert.equal(disposableIncomeResponse.status, 201);
    const disposableIncome = await disposableIncomeResponse.json() as { id: string };
    const foreignAccountResponse = await post('/api/auth/register', { email: fourthEmail, password: 'Safe-test-password-123!' });
    assert.equal(foreignAccountResponse.status, 201);
    const foreignAccount = await foreignAccountResponse.json() as { token: string };
    const foreignDelete = await del(`/api/personal-finance/income-entries/${disposableIncome.id}`, foreignAccount.token);
    assert.equal(foreignDelete.status, 404, 'another account must not delete a one-time income entry');
    const deleteManualIncome = await del(`/api/personal-finance/income-entries/${disposableIncome.id}`, first.token);
    assert.equal(deleteManualIncome.status, 204);
    const repeatDeleteManualIncome = await del(`/api/personal-finance/income-entries/${disposableIncome.id}`, first.token);
    assert.equal(repeatDeleteManualIncome.status, 404, 'deleting the same income twice must not report success');
    const deleteReceivedIncome = await del(`/api/personal-finance/income-entries/${plannedIncome.id}`, first.token);
    assert.equal(deleteReceivedIncome.status, 404, 'received income history must remain protected');
    const afterReceiptDashboard = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await afterReceiptDashboard.json() as { actual: { balance: number } }).actual.balance), 1665,
      'receiving the same income entry again must not count it twice or overwrite the first actual amount');

    // Dated balance adjustments affect actual cash only once their date is reached,
    // and an adjustment before the accounting start date must never enter the balance.
    const beforeOpeningDate = new Date(today);
    beforeOpeningDate.setUTCDate(beforeOpeningDate.getUTCDate() - 1);
    const beforeOpeningAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 300, date: beforeOpeningDate.toISOString().slice(0, 10), reason: 'Before accounting start',
    }, first.token);
    assert.equal(beforeOpeningAdjustment.status, 201);
    const futureSharedAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 500, date: futureDate, reason: 'Future shared correction',
    }, first.token);
    assert.equal(futureSharedAdjustment.status, 201);
    const futureMemberAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 200, date: futureDate, reason: 'Future member correction', memberId: member.id,
    }, first.token);
    assert.equal(futureMemberAdjustment.status, 201);
    const balanceAfterDatedAdjustments = await get('/api/personal-finance/dashboard', first.token);
    assert.equal(Number((await balanceAfterDatedAdjustments.json() as { actual: { balance: number } }).actual.balance), 1665,
      'future and pre-opening adjustments must not affect the current household balance');
    const memberBalanceAfterFutureAdjustment = await get(`/api/personal-finance/dashboard?memberId=${member.id}`, first.token);
    assert.equal(Number((await memberBalanceAfterFutureAdjustment.json() as { actual: { balance: number } }).actual.balance), 175,
      'future member adjustments must not affect the current member balance');

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
    assert.equal(Number(futureMonthData.forecast.balance), 1915,
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
    assert.equal(Number(afterConcurrentReceiptData.actual.balance), 1665 + Number(concurrentReceiptResults[0].actualAmount),
      'concurrent receipt requests must add the winning actual amount to the balance exactly once');

    const budgetPayload = { periodMonth: today.toISOString().slice(0, 7) + '-01', limitAmount: 10000 };
    const budgetResponses = await Promise.all([
      post('/api/personal-finance/budgets', budgetPayload, first.token),
      post('/api/personal-finance/budgets', { ...budgetPayload, limitAmount: 12000 }, first.token),
    ]);
    assert.ok(budgetResponses.every(response => response.status === 200 || response.status === 201));
    const budgets = await get('/api/personal-finance/budgets', first.token);
    assert.equal((await budgets.json() as unknown[]).length, 1);
    const budgetMemberResponse = await post('/api/personal-finance/members', { name: 'Budget scope test' }, first.token);
    assert.equal(budgetMemberResponse.status, 201);
    const budgetMember = await budgetMemberResponse.json() as { id: string };
    const memberBudgetResponse = await post('/api/personal-finance/budgets', {
      ...budgetPayload, memberId: budgetMember.id,
    }, first.token);
    assert.equal(memberBudgetResponse.status, 201);
    const memberBudget = await memberBudgetResponse.json() as { id: string };
    const conflictingBudgetUpdate = await patch(`/api/personal-finance/budgets/${memberBudget.id}`, {
      memberId: null,
    }, first.token);
    assert.equal(conflictingBudgetUpdate.status, 409,
      'changing a budget into an existing month/scope must return a conflict instead of a server error');

    const archiveBudgetMember = await patch(`/api/personal-finance/members/${budgetMember.id}`, { isArchived: true }, first.token);
    assert.equal(archiveBudgetMember.status, 200);
    const assignArchivedMember = await post('/api/personal-finance/income-sources', {
      title: 'Archived member income', amount: 1000, recurrence: 'ONCE', startDate: today.toISOString().slice(0, 10), memberId: budgetMember.id,
    }, first.token);
    assert.equal(assignArchivedMember.status, 400,
      'archived household members must not be assignable to new income sources');
    const assignArchivedExpense = await post('/api/personal-finance/expenses', {
      title: 'Archived member expense', amount: 100, date: today.toISOString().slice(0, 10), memberId: budgetMember.id,
    }, first.token);
    assert.equal(assignArchivedExpense.status, 400,
      'archived household members must not be assignable to new expenses');
    const assignArchivedObligation = await post('/api/personal-finance/obligations', {
      title: 'Archived member obligation', category: 'Other', amount: 500, recurrence: 'ONCE', startDate: today.toISOString().slice(0, 10), memberId: budgetMember.id,
    }, first.token);
    assert.equal(assignArchivedObligation.status, 400,
      'archived household members must not be assignable to new obligations');
    const assignArchivedAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 50, date: todayString, reason: 'Archived member adjustment', memberId: budgetMember.id,
    }, first.token);
    assert.equal(assignArchivedAdjustment.status, 400,
      'archived household members must not be assignable to new balance adjustments');

    const archivedMemberDashboard = await get(`/api/personal-finance/dashboard?memberId=${budgetMember.id}`, first.token);
    assert.equal(archivedMemberDashboard.status, 200,
      'archived household members must remain selectable in historical dashboard reports');
    const archivedMemberAnalytics = await get(`/api/personal-finance/analytics?from=${todayString}&to=${todayString}&memberId=${budgetMember.id}`, first.token);
    assert.equal(archivedMemberAnalytics.status, 200,
      'archived household members must remain selectable in historical analytics');

    const secondResponse = await post('/api/auth/register', { email: secondEmail, password: 'Another-safe-password-123!' });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as { token: string };

    const foreignPayment = await post(`/api/personal-finance/obligation-occurrences/${occurrence.id}/pay`, {}, second.token);
    assert.equal(foreignPayment.status, 404, 'another account must not be able to pay this household obligation');
    const foreignReceipt = await post(`/api/personal-finance/income-entries/${plannedIncome.id}/receive`, {}, second.token);
    assert.equal(foreignReceipt.status, 404, 'another account must not be able to receive this household income');
    const foreignIncomeList = await get(`/api/personal-finance/income-entries?from=${todayString}&to=${todayString}`, second.token);
    assert.equal(foreignIncomeList.status, 200);
    assert.deepEqual((await foreignIncomeList.json() as { entries: unknown[] }).entries, [],
      'income entry listing must remain isolated between accounts');
    const foreignIncomeDelete = await del(`/api/personal-finance/income-entries/${plannedIncome.id}`, second.token);
    assert.equal(foreignIncomeDelete.status, 404, 'another account must not delete this household income');

    const secondMemberResponse = await post('/api/personal-finance/members', { name: 'Second household member' }, second.token);
    assert.equal(secondMemberResponse.status, 201);
    const secondMember = await secondMemberResponse.json() as { id: string };
    const foreignMemberExpense = await post('/api/personal-finance/expenses', {
      title: 'Foreign member expense', amount: 100, date: todayString, memberId: secondMember.id,
    }, first.token);
    assert.equal(foreignMemberExpense.status, 400, 'a household cannot assign records to another account member');
    const foreignMemberAdjustment = await post('/api/personal-finance/balance-adjustments', {
      amount: 100, date: todayString, reason: 'Foreign member adjustment', memberId: secondMember.id,
    }, first.token);
    assert.equal(foreignMemberAdjustment.status, 400,
      'a household cannot assign balance adjustments to another account member');
    const secondAdjustments = await get('/api/personal-finance/balance-adjustments', second.token);
    assert.equal(secondAdjustments.status, 200);
    assert.deepEqual(await secondAdjustments.json(), [],
      'a household must not be able to read another account balance adjustments');

    const firstMembers = await get('/api/personal-finance/members', first.token);
    const secondMembers = await get('/api/personal-finance/members', second.token);
    assert.equal(firstMembers.status, 200);
    assert.equal(secondMembers.status, 200);
    const firstMemberList = await firstMembers.json() as Array<{ id: string; isArchived: boolean }>;
    assert.equal(firstMemberList.length, 2, 'archived household members remain visible for historical records');
    assert.equal(firstMemberList.find(member => member.id === budgetMember.id)?.isArchived, true);
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
    await prisma.user.deleteMany({ where: { email: { in: [firstEmail, secondEmail, thirdEmail, fourthEmail, fifthEmail] } } });
  }
});
