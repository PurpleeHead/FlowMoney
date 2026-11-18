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

  let invitationRequestIp = 1;
  const request = (path: string, method = 'GET', body?: unknown, token?: string) => fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Keep the integration test focused on household behavior rather than
      // exhausting the production per-IP invitation creation rate limit.
      ...(path === '/api/household/invitations' && method === 'POST'
        ? { 'x-forwarded-for': `198.51.100.${invitationRequestIp++}` }
        : {}),
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
    const husbandProfile = await husbandProfileResponse.json() as { id: string };
    const wifeProfile = await wifeProfileResponse.json() as { id: string };
    const reservedProfile = await reservedProfileResponse.json() as { id: string };

    const inviteResponse = await request('/api/household/invitations', 'POST', { memberId: wifeProfile.id }, owner.token);
    assert.equal(inviteResponse.status, 201);
    const invite = await inviteResponse.json() as { inviteLink: string; id: string };
    const inviteToken = new URL(invite.inviteLink).searchParams.get('startapp');
    assert.ok(inviteToken);
    // A second invitation for the same profile can exist before the first is accepted.
    const duplicateProfileInviteResponse = await request('/api/household/invitations', 'POST', { memberId: wifeProfile.id }, owner.token);
    assert.equal(duplicateProfileInviteResponse.status, 201);
    const duplicateProfileInvite = await duplicateProfileInviteResponse.json() as { inviteLink: string };
    const duplicateProfileToken = new URL(duplicateProfileInvite.inviteLink).searchParams.get('startapp');
    assert.ok(duplicateProfileToken);

    const previewResponse = await request('/api/household/invitations/preview?token=' + encodeURIComponent(inviteToken), 'GET', undefined, spouse.token);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { householdName: string; memberName: string; alreadyAccepted: boolean };
    assert.equal(preview.memberName, 'Wife');
    assert.equal(preview.alreadyAccepted, false);

    const accepted = await request('/api/household/invitations/accept', 'POST', { token: inviteToken }, spouse.token);
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json() as { householdName: string; memberName: string };
    assert.equal(acceptedBody.memberName, 'Wife');

    // An owner cannot assign their own access to a profile already assigned to a member.
    const occupiedOwnerProfile = await request('/api/household/profile', 'PATCH', { memberId: wifeProfile.id }, owner.token);
    assert.equal(occupiedOwnerProfile.status, 409, 'an active member profile cannot be assigned to a second account');
    const availableOwnerProfile = await request('/api/household/profile', 'PATCH', { memberId: husbandProfile.id }, owner.token);
    assert.equal(availableOwnerProfile.status, 200, 'the owner may still assign an unoccupied profile to their own access');

    const duplicateProfileAccount = await register('duplicate-profile');
    const duplicateProfileAccept = await request('/api/household/invitations/accept', 'POST', {
      token: duplicateProfileToken,
    }, duplicateProfileAccount.token);
    assert.equal(duplicateProfileAccept.status, 409, 'one household profile must not be assigned to two active accounts');

    // Concurrent acceptance of two invitations for one profile must still produce
    // exactly one active assignment; the database partial unique index is the last guard.
    const concurrentProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Concurrent profile' }, owner.token);
    assert.equal(concurrentProfileResponse.status, 201);
    const concurrentProfile = await concurrentProfileResponse.json() as { id: string };
    const concurrentInviteResponses = await Promise.all([
      request('/api/household/invitations', 'POST', { memberId: concurrentProfile.id }, owner.token),
      request('/api/household/invitations', 'POST', { memberId: concurrentProfile.id }, owner.token),
    ]);
    assert.deepEqual(concurrentInviteResponses.map(response => response.status), [201, 201]);
    const concurrentInvites = await Promise.all(concurrentInviteResponses.map(response => response.json() as Promise<{ inviteLink: string }>));
    const concurrentTokens = concurrentInvites.map(invite => new URL(invite.inviteLink).searchParams.get('startapp'));
    assert.ok(concurrentTokens.every(Boolean));
    const concurrentAccounts = await Promise.all([register('race-one'), register('race-two')]);
    const concurrentAcceptances = await Promise.all(concurrentAccounts.map((account, index) =>
      request('/api/household/invitations/accept', 'POST', { token: concurrentTokens[index] }, account.token),
    ));
    assert.deepEqual(
      concurrentAcceptances.map(response => response.status).sort((a, b) => a - b),
      [200, 409],
      'simultaneous acceptance must allow only one account to claim a household profile',
    );
    const householdAfterConcurrentAccept = await request('/api/household', 'GET', undefined, owner.token);
    const householdMembersAfterConcurrentAccept = await householdAfterConcurrentAccept.json() as {
      members: Array<{ member: { id: string } | null }>;
    };
    assert.equal(
      householdMembersAfterConcurrentAccept.members.filter(access => access.member?.id === concurrentProfile.id).length,
      1,
      'the profile must have exactly one active account assignment after a race',
    );

    // Personal display preferences are per account, while the opening balance is shared
    // and may only be changed by the household owner.
    const ownerSettingsBefore = await request('/api/personal-finance/settings', 'GET', undefined, owner.token);
    const spouseSettingsBefore = await request('/api/personal-finance/settings', 'GET', undefined, spouse.token);
    assert.equal(ownerSettingsBefore.status, 200);
    assert.equal(spouseSettingsBefore.status, 200);
    const spousePreferenceUpdate = await request('/api/personal-finance/settings', 'PATCH', {
      locale: 'en', timezone: 'Asia/Bangkok',
    }, spouse.token);
    assert.equal(spousePreferenceUpdate.status, 200);
    const ownerSettingsAfter = await request('/api/personal-finance/settings', 'GET', undefined, owner.token);
    const spouseSettingsAfter = await request('/api/personal-finance/settings', 'GET', undefined, spouse.token);
    assert.equal((await ownerSettingsAfter.json() as { locale: string }).locale, 'ru', 'changing a spouse locale must not change the owner locale');
    const spousePreferences = await spouseSettingsAfter.json() as { locale: string; timezone: string };
    assert.equal(spousePreferences.locale, 'en');
    assert.equal(spousePreferences.timezone, 'Asia/Bangkok');
    const blockedOpeningBalanceChange = await request('/api/personal-finance/settings', 'PATCH', {
      openingBalance: 999999,
    }, spouse.token);
    assert.equal(blockedOpeningBalanceChange.status, 403, 'only the owner may change the shared opening balance');

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

    // An owner with active members must not be allowed to join another household,
    // because that would revoke their owner access and orphan the existing household.
    const secondOwner = await register('second-owner');
    const secondOwnerProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Second household member' }, secondOwner.token);
    assert.equal(secondOwnerProfileResponse.status, 201);
    const secondOwnerProfile = await secondOwnerProfileResponse.json() as { id: string };
    const secondOwnerInviteResponse = await request('/api/household/invitations', 'POST', { memberId: secondOwnerProfile.id }, secondOwner.token);
    assert.equal(secondOwnerInviteResponse.status, 201);
    const secondOwnerInvite = await secondOwnerInviteResponse.json() as { inviteLink: string };
    const secondOwnerToken = new URL(secondOwnerInvite.inviteLink).searchParams.get('startapp');
    assert.ok(secondOwnerToken);
    const ownerJoinAttempt = await request('/api/household/invitations/accept', 'POST', { token: secondOwnerToken }, owner.token);
    assert.equal(ownerJoinAttempt.status, 409, 'an owner must not orphan a household with active members');
    const ownerHouseholdAfterBlockedJoin = await request('/api/household', 'GET', undefined, owner.token);
    assert.equal(ownerHouseholdAfterBlockedJoin.status, 200, 'the original owner access must remain active');
    const spouseHouseholdAfterBlockedJoin = await request('/api/household', 'GET', undefined, spouse.token);
    assert.equal(spouseHouseholdAfterBlockedJoin.status, 200, 'the existing member must remain attached to the original household');

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
