import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';

test('household invitations share finances, isolate other accounts and revoke access immediately', { skip: !process.env.DATABASE_URL }, async () => {
  process.env.JWT_SECRET = 'nummiox-household-integration-test-secret-32';
  const suffix = randomUUID();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const request = (path: string, method = 'GET', body?: unknown, token?: string) => fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const register = async (label: string) => {
    const response = await request('/api/auth/register', 'POST', {
      email: `household-${label}-${suffix}@example.test`,
      password: 'Safe-test-password-123!',
    });
    assert.equal(response.status, 201);
    return (await response.json()) as { token: string; user: { id: string } };
  };

  try {
    const owner = await register('owner');
    const spouse = await register('spouse');
    const outsider = await register('outsider');
    const dataAccount = await register('existing-data');

    const husbandProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Husband' }, owner.token);
    const wifeProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Wife' }, owner.token);
    const reservedProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Other relative' }, owner.token);
    assert.equal(husbandProfileResponse.status, 201);
    assert.equal(wifeProfileResponse.status, 201);
    assert.equal(reservedProfileResponse.status, 201);
    const wifeProfile = await wifeProfileResponse.json() as { id: string };
    const reservedProfile = await reservedProfileResponse.json() as { id: string };

    const inviteResponse = await request('/api/household/invitations', 'POST', { memberId: wifeProfile.id }, owner.token);
    assert.equal(inviteResponse.status, 201);
    const invite = await inviteResponse.json() as { inviteLink: string; id: string };
    const inviteToken = new URL(invite.inviteLink).searchParams.get('startapp');
    assert.ok(inviteToken);

    const previewResponse = await request('/api/household/invitations/preview?token=' + encodeURIComponent(inviteToken), 'GET', undefined, spouse.token);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { householdName: string; memberName: string; alreadyAccepted: boolean };
    assert.equal(preview.memberName, 'Wife');
    assert.equal(preview.alreadyAccepted, false);

    const accepted = await request('/api/household/invitations/accept', 'POST', { token: inviteToken }, spouse.token);
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json() as { householdName: string; memberName: string };
    assert.equal(acceptedBody.memberName, 'Wife');

    const alreadyJoinedPreview = await request('/api/household/invitations/preview?token=' + encodeURIComponent(inviteToken), 'GET', undefined, spouse.token);
    assert.equal(alreadyJoinedPreview.status, 200);
    assert.equal((await alreadyJoinedPreview.json() as { alreadyAccepted: boolean }).alreadyAccepted, true);

    const memberInviteAttempt = await request('/api/household/invitations', 'POST', { memberId: reservedProfile.id }, spouse.token);
    assert.equal(memberInviteAttempt.status, 403, 'only the household owner can invite users');

    const expense = await request('/api/personal-finance/expenses', 'POST', {
      title: 'Shared groceries', amount: 2450, date: '2026-11-11', memberId: wifeProfile.id,
    }, owner.token);
    assert.equal(expense.status, 201);
    const sharedFromSpouse = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, spouse.token);
    assert.equal(sharedFromSpouse.status, 200);
    const sharedData = await sharedFromSpouse.json() as { expenses: Array<{ title: string }> };
    assert.ok(sharedData.expenses.some(item => item.title === 'Shared groceries'));

    const outsiderData = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, outsider.token);
    assert.equal(outsiderData.status, 200);
    const isolated = await outsiderData.json() as { expenses: Array<{ title: string }> };
    assert.equal(isolated.expenses.some(item => item.title === 'Shared groceries'), false, 'a third account must not see another household');

    const existingExpense = await request('/api/personal-finance/expenses', 'POST', {
      title: 'Private record', amount: 100, date: '2026-11-11',
    }, dataAccount.token);
    assert.equal(existingExpense.status, 201);
    const secondInvite = await request('/api/household/invitations', 'POST', { memberId: reservedProfile.id }, owner.token);
    assert.equal(secondInvite.status, 201);
    const secondInviteBody = await secondInvite.json() as { inviteLink: string };
    const secondToken = new URL(secondInviteBody.inviteLink).searchParams.get('startapp');
    const blockedJoin = await request('/api/household/invitations/accept', 'POST', { token: secondToken }, dataAccount.token);
    assert.equal(blockedJoin.status, 409, 'accounts with existing financial records must not be silently merged');

    const revoke = await request('/api/household/access/' + encodeURIComponent(spouse.user.id), 'DELETE', undefined, owner.token);
    assert.equal(revoke.status, 204);
    const revokedRequest = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, spouse.token);
    assert.equal(revokedRequest.status, 403, 'revocation must take effect on the next request despite a valid JWT');

    const privateDataStillExists = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, dataAccount.token);
    assert.equal(privateDataStillExists.status, 200);
    const privateBody = await privateDataStillExists.json() as { expenses: Array<{ title: string }> };
    assert.ok(privateBody.expenses.some(item => item.title === 'Private record'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
