import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { prisma } from '../services/prisma.js';
import { hashInvitationToken } from '../services/households.js';

function tokenFromInviteLink(link: string): string | null {
  const url = new URL(link);
  return url.searchParams.get('startapp')
    ?? new URLSearchParams(url.hash.replace(/^#/, '')).get('invite');
}

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
      ...(path.startsWith('/api/household/invitations') && method !== 'GET'
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
    const webInviteUrl = new URL(invite.inviteLink);
    assert.equal(webInviteUrl.hash.startsWith('#invite='), true,
      'household invitations should be shareable as ordinary web links');
    const inviteToken = tokenFromInviteLink(invite.inviteLink);
    assert.ok(inviteToken);
    // A second invitation for the same profile can exist before the first is accepted.
    const duplicateProfileInviteResponse = await request('/api/household/invitations', 'POST', { memberId: wifeProfile.id }, owner.token);
    assert.equal(duplicateProfileInviteResponse.status, 201);
    const duplicateProfileInvite = await duplicateProfileInviteResponse.json() as { id: string; inviteLink: string };
    const duplicateProfileToken = tokenFromInviteLink(duplicateProfileInvite.inviteLink);
    assert.ok(duplicateProfileToken);

    const previewResponse = await request('/api/household/invitations/preview', 'POST', { token: inviteToken }, spouse.token);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { householdName: string; memberName: string; alreadyAccepted: boolean };
    assert.equal(preview.memberName, 'Wife');
    assert.equal(preview.alreadyAccepted, false);

    const malformedPreview = await request('/api/household/invitations/preview', 'POST', { token: 'not-a-valid-token' }, spouse.token);
    assert.equal(malformedPreview.status, 400, 'malformed invitation tokens must be rejected');

    const expiredInviteResponse = await request('/api/household/invitations', 'POST', { memberId: reservedProfile.id }, owner.token);
    assert.equal(expiredInviteResponse.status, 201);
    const expiredInvite = await expiredInviteResponse.json() as { id: string; inviteLink: string };
    const expiredToken = tokenFromInviteLink(expiredInvite.inviteLink);
    assert.ok(expiredToken);
    await prisma.householdInvite.update({
      where: { tokenHash: hashInvitationToken(expiredToken) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expiredPreview = await request('/api/household/invitations/preview', 'POST', { token: expiredToken }, outsider.token);
    assert.equal(expiredPreview.status, 404, 'expired invitations must not be previewed');
    const expiredAccept = await request('/api/household/invitations/accept', 'POST', { token: expiredToken }, outsider.token);
    assert.equal(expiredAccept.status, 400, 'expired invitations must not be accepted');

    const revokedInviteResponse = await request('/api/household/invitations', 'POST', { memberId: reservedProfile.id }, owner.token);
    assert.equal(revokedInviteResponse.status, 201);
    const revokedInvite = await revokedInviteResponse.json() as { id: string; inviteLink: string };
    const revokedToken = tokenFromInviteLink(revokedInvite.inviteLink);
    assert.ok(revokedToken);
    const revokeInvite = await request('/api/household/invitations/' + encodeURIComponent(revokedInvite.id), 'DELETE', undefined, owner.token);
    assert.equal(revokeInvite.status, 204);
    const revokedPreview = await request('/api/household/invitations/preview', 'POST', { token: revokedToken }, outsider.token);
    assert.equal(revokedPreview.status, 404, 'revoked invitations must not be previewed');
    const revokedAccept = await request('/api/household/invitations/accept', 'POST', { token: revokedToken }, outsider.token);
    assert.equal(revokedAccept.status, 400, 'revoked invitations must not be accepted');

    const accepted = await request('/api/household/invitations/accept', 'POST', { token: inviteToken }, spouse.token);
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json() as { householdName: string; memberName: string };
    assert.equal(acceptedBody.memberName, 'Wife');

    const renamedHousehold = await request('/api/household', 'PATCH', { name: 'Our family budget' }, owner.token);
    assert.equal(renamedHousehold.status, 200, 'the owner may rename the shared household');
    assert.equal((await renamedHousehold.json() as { name: string }).name, 'Our family budget');
    const memberRenameAttempt = await request('/api/household', 'PATCH', { name: 'Unauthorized name' }, spouse.token);
    assert.equal(memberRenameAttempt.status, 403, 'members cannot rename the household');
    const invalidHouseholdName = await request('/api/household', 'PATCH', { name: '   ' }, owner.token);
    assert.equal(invalidHouseholdName.status, 400, 'household names must not be empty');
    const memberSeesHouseholdName = await request('/api/household', 'GET', undefined, spouse.token);
    assert.equal((await memberSeesHouseholdName.json() as { name: string }).name, 'Our family budget');

    // An owner cannot assign their own access to a profile already assigned to a member.
    const occupiedOwnerProfile = await request('/api/household/profile', 'PATCH', { memberId: wifeProfile.id }, owner.token);
    assert.equal(occupiedOwnerProfile.status, 409, 'an active member profile cannot be assigned to a second account');
    const availableOwnerProfile = await request('/api/household/profile', 'PATCH', { memberId: husbandProfile.id }, owner.token);
    assert.equal(availableOwnerProfile.status, 200, 'the owner may still assign an unoccupied profile to their own access');

    const archiveLinkedProfile = await request('/api/personal-finance/members/' + encodeURIComponent(wifeProfile.id), 'PATCH', {
      isArchived: true,
    }, owner.token);
    assert.equal(archiveLinkedProfile.status, 409, 'a profile linked to an active account must not be archived');

    const reusedInviteAccept = await request('/api/household/invitations/accept', 'POST', { token: inviteToken }, outsider.token);
    assert.equal(reusedInviteAccept.status, 400, 'an accepted invitation token must not be reusable');
    const memberCannotRevokeInvite = await request('/api/household/invitations/' + encodeURIComponent(duplicateProfileInvite.id), 'DELETE', undefined, spouse.token);
    assert.equal(memberCannotRevokeInvite.status, 403, 'only the owner may revoke invitations');
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
    const concurrentTokens = concurrentInvites.map(invite => tokenFromInviteLink(invite.inviteLink));
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

    const alreadyJoinedPreview = await request('/api/household/invitations/preview', 'POST', { token: inviteToken }, spouse.token);
    assert.equal(alreadyJoinedPreview.status, 200);
    assert.equal((await alreadyJoinedPreview.json() as { alreadyAccepted: boolean }).alreadyAccepted, true);

    const memberInviteAttempt = await request('/api/household/invitations', 'POST', { memberId: reservedProfile.id }, spouse.token);
    assert.equal(memberInviteAttempt.status, 403, 'only the household owner can invite users');

    // Built-in categories use stable IDs (e.g. "system-category-groceries"),
    // not Prisma CUIDs. They must be accepted just like user-created categories.
    const systemCategoryExpense = await request('/api/personal-finance/expenses', 'POST', {
      title: 'Groceries with built-in category',
      amount: 1800,
      date: '2026-11-11',
      categoryId: 'system-category-groceries',
      memberId: wifeProfile.id,
    }, owner.token);
    assert.equal(systemCategoryExpense.status, 201, 'built-in system category IDs must pass expense validation');
    const systemCategoryExpenseBody = await systemCategoryExpense.json() as { categoryId: string | null };
    assert.equal(systemCategoryExpenseBody.categoryId, 'system-category-groceries');

    const systemCategoryBudget = await request('/api/personal-finance/budgets', 'POST', {
      periodMonth: '2026-11-01',
      limitAmount: 5000,
      categoryId: 'system-category-groceries',
      memberId: wifeProfile.id,
    }, owner.token);
    assert.ok([200, 201].includes(systemCategoryBudget.status), 'built-in system category IDs must pass budget validation');
    const systemCategoryBudgetBody = await systemCategoryBudget.json() as { categoryId: string | null };
    assert.equal(systemCategoryBudgetBody.categoryId, 'system-category-groceries');

    const expense = await request('/api/personal-finance/expenses', 'POST', {
      title: 'Shared groceries', amount: 2450, date: '2026-11-11', memberId: wifeProfile.id,
    }, owner.token);
    assert.equal(expense.status, 201);
    const sharedFromSpouse = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, spouse.token);
    assert.equal(sharedFromSpouse.status, 200);
    const sharedData = await sharedFromSpouse.json() as { expenses: Array<{ title: string }> };
    assert.ok(sharedData.expenses.some(item => item.title === 'Shared groceries'));

    // Legacy finance endpoints must use the same canonical household owner as the
    // newer personal-finance API, so family members see the same ledger.
    const legacyExchange = await request('/api/exchanges', 'POST', {
      rubSpent: 1000, usdtReceived: 12, vndPerUsdt: 25000, vndReceived: 299000, vndFee: 1000,
    }, owner.token);
    assert.equal(legacyExchange.status, 201);
    const legacyExchangeBody = await legacyExchange.json() as { id: string };
    const spouseLegacyExchanges = await request('/api/exchanges', 'GET', undefined, spouse.token);
    assert.equal(spouseLegacyExchanges.status, 200);
    assert.ok((await spouseLegacyExchanges.json() as Array<{ id: string }>).some(item => item.id === legacyExchangeBody.id));
    const outsiderLegacyExchanges = await request('/api/exchanges', 'GET', undefined, outsider.token);
    assert.equal(outsiderLegacyExchanges.status, 200);
    assert.equal((await outsiderLegacyExchanges.json() as Array<{ id: string }>).some(item => item.id === legacyExchangeBody.id), false);

    const legacyExpense = await request('/api/expenses', 'POST', {
      title: 'Legacy shared purchase', category: 'Food', amount: 299000, currency: 'VND',
      amountVnd: 299000, usdtCharged: 11.96, date: '2026-11-11T10:00:00.000Z',
    }, owner.token);
    assert.equal(legacyExpense.status, 201);
    const legacyExpenseBody = await legacyExpense.json() as { id: string };
    const spouseLegacyExpenses = await request('/api/expenses', 'GET', undefined, spouse.token);
    assert.equal(spouseLegacyExpenses.status, 200);
    assert.ok((await spouseLegacyExpenses.json() as Array<{ id: string }>).some(item => item.id === legacyExpenseBody.id));
    const outsiderLegacyExpenses = await request('/api/expenses', 'GET', undefined, outsider.token);
    assert.equal(outsiderLegacyExpenses.status, 200);
    assert.equal((await outsiderLegacyExpenses.json() as Array<{ id: string }>).some(item => item.id === legacyExpenseBody.id), false);

    const legacyReceipt = await request('/api/receipts', 'POST', {
      rawText: 'Rice 299000 VND',
      items: [{ name: 'Rice', price: 299000, quantity: 1, currency: 'VND', amountVnd: 299000 }],
    }, owner.token);
    assert.equal(legacyReceipt.status, 201);
    const legacyReceiptBody = await legacyReceipt.json() as { id: string };
    const spouseLegacyReceipts = await request('/api/receipts', 'GET', undefined, spouse.token);
    assert.equal(spouseLegacyReceipts.status, 200);
    assert.ok((await spouseLegacyReceipts.json() as Array<{ id: string }>).some(item => item.id === legacyReceiptBody.id));
    const outsiderLegacyReceipts = await request('/api/receipts', 'GET', undefined, outsider.token);
    assert.equal(outsiderLegacyReceipts.status, 200);
    assert.equal((await outsiderLegacyReceipts.json() as Array<{ id: string }>).some(item => item.id === legacyReceiptBody.id), false);

    const spouseLegacyDashboard = await request('/api/dashboard', 'GET', undefined, spouse.token);
    assert.equal(spouseLegacyDashboard.status, 200);
    const legacyDashboard = await spouseLegacyDashboard.json() as {
      expenses: Array<{ id: string }>;
      exchanges: Array<{ id: string }>;
    };
    assert.ok(legacyDashboard.expenses.some(item => item.id === legacyExpenseBody.id));
    assert.ok(legacyDashboard.exchanges.some(item => item.id === legacyExchangeBody.id));

    // An owner with active members must not be allowed to join another household,
    // because that would revoke their owner access and orphan the existing household.
    const secondOwner = await register('second-owner');
    const secondOwnerProfileResponse = await request('/api/personal-finance/members', 'POST', { name: 'Second household member' }, secondOwner.token);
    assert.equal(secondOwnerProfileResponse.status, 201);
    const secondOwnerProfile = await secondOwnerProfileResponse.json() as { id: string };
    const secondOwnerInviteResponse = await request('/api/household/invitations', 'POST', { memberId: secondOwnerProfile.id }, secondOwner.token);
    assert.equal(secondOwnerInviteResponse.status, 201);
    const secondOwnerInvite = await secondOwnerInviteResponse.json() as { inviteLink: string };
    const secondOwnerToken = tokenFromInviteLink(secondOwnerInvite.inviteLink);
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
    const secondToken = tokenFromInviteLink(secondInviteBody.inviteLink);
    const joinedWithExistingData = await request('/api/household/invitations/accept', 'POST', { token: secondToken }, dataAccount.token);
    assert.equal(joinedWithExistingData.status, 200, 'accounts with existing financial records must be able to join without merging them');

    const personalSpaceData = await request('/api/personal-finance/expenses?take=50&skip=0&space=personal', 'GET', undefined, dataAccount.token);
    assert.equal(personalSpaceData.status, 200);
    const personalSpaceBody = await personalSpaceData.json() as { expenses: Array<{ title: string }> };
    assert.ok(personalSpaceBody.expenses.some(item => item.title === 'Private record'), 'the member must retain their personal history');

    const sharedSpaceData = await request('/api/personal-finance/expenses?take=50&skip=0&space=household', 'GET', undefined, dataAccount.token);
    assert.equal(sharedSpaceData.status, 200);
    const sharedSpaceBody = await sharedSpaceData.json() as { expenses: Array<{ title: string }> };
    assert.equal(sharedSpaceBody.expenses.some(item => item.title === 'Private record'), false, 'personal records must not leak into the shared household');
    assert.ok(sharedSpaceBody.expenses.some(item => item.title === 'Shared groceries'), 'the member must see the invited household data');

    const revoke = await request('/api/household/access/' + encodeURIComponent(spouse.user.id), 'DELETE', undefined, owner.token);
    assert.equal(revoke.status, 204);
    const revokedRequest = await request('/api/personal-finance/expenses?take=50&skip=0', 'GET', undefined, spouse.token);
    assert.equal(revokedRequest.status, 403, 'revocation must take effect on the next request despite a valid JWT');

    for (const path of ['/api/expenses', '/api/exchanges', '/api/receipts', '/api/dashboard']) {
      const revokedLegacyRequest = await request(path, 'GET', undefined, spouse.token);
      assert.equal(revokedLegacyRequest.status, 403, `revoked members must lose access to ${path} immediately`);
    }

    const privateDataStillExists = await request('/api/personal-finance/expenses?take=50&skip=0&space=personal', 'GET', undefined, dataAccount.token);
    assert.equal(privateDataStillExists.status, 200);
    const privateBody = await privateDataStillExists.json() as { expenses: Array<{ title: string }> };
    assert.ok(privateBody.expenses.some(item => item.title === 'Private record'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('public database tables enforce RLS and block direct Supabase API roles', { skip: !process.env.DATABASE_URL }, async () => {
  const tables = await prisma.$queryRaw<Array<{ table_name: string; rls_enabled: boolean }>>`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
  assert.ok(tables.length > 0, 'the public schema should contain the application tables');
  assert.deepEqual(
    tables.filter(table => !table.rls_enabled).map(table => table.table_name),
    [],
    'every public table must have row-level security enabled',
  );

  const access = await prisma.$queryRaw<Array<{
    anon_schema_usage: boolean;
    anon_can_read_user: boolean;
    authenticated_schema_usage: boolean;
    authenticated_can_read_user: boolean;
  }>>`
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
        THEN has_schema_privilege('anon', 'public', 'USAGE') ELSE false END AS anon_schema_usage,
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
        THEN has_table_privilege('anon', 'public."User"', 'SELECT') ELSE false END AS anon_can_read_user,
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
        THEN has_schema_privilege('authenticated', 'public', 'USAGE') ELSE false END AS authenticated_schema_usage,
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
        THEN has_table_privilege('authenticated', 'public."User"', 'SELECT') ELSE false END AS authenticated_can_read_user
  `;
  assert.deepEqual(access[0], {
    anon_schema_usage: false,
    anon_can_read_user: false,
    authenticated_schema_usage: false,
    authenticated_can_read_user: false,
  });
});
