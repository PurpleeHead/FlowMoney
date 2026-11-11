# Cross-account household collaboration

## Implementation status (2026-11-11)

Backend schema, migration, request-level household resolution, invitation API, immediate revocation and initial Telegram invite UI are now being implemented on `feature/household-collaboration`. This is not production-enabled until the migration is reviewed and deployed through an approved release.

## Why this is a separate milestone

The current `HouseholdMember` records are attribution labels inside one account. They are not login identities. A second Telegram user currently receives a separate FlowMoney account and cannot see the first user's financial data. Do not describe the current model as shared multi-user access.

## Target behavior

- One household has one owner and one or more authenticated user accounts.
- Each authenticated user is linked to one household member profile (for example, the existing profile named "Wife") so transactions can continue to be attributed consistently.
- Household users can read and create the shared income, expense, obligation, budget, goal, dashboard and analytics records.
- Only the owner can create/revoke invitations and manage ownership.
- Removing a user revokes access immediately; it does not delete household records.
- A user's unrelated personal financial records must never become visible to another household.

## Data model direction

Introduce a `Household` and a membership/access relation rather than using Telegram IDs as household membership:

- `Household`: id, name, ownerUserId, createdAt, updatedAt.
- `HouseholdAccess`: householdId, userId, memberId, role, joinedAt, revokedAt.
- `HouseholdInvite`: householdId, createdByUserId, tokenHash, expiresAt, acceptedAt, acceptedByUserId, revokedAt, createdAt.

Use database foreign keys and unique constraints:
- one active household access per user;
- one active access per member profile;
- one-time invitation token hashes;
- indexes on household/user and pending invitation lookup.

Store only a cryptographic hash of invite tokens. Generate tokens from a cryptographically secure random source, make them single-use, expire them after seven days, and rate-limit invitation creation and acceptance.

## Migration and compatibility

1. Create one personal household for each existing user and make that user its owner.
2. Create an owner access record for every existing account.
3. Preserve all existing financial rows and IDs. Do not copy or rewrite historical transactions during the first migration.
4. Keep existing `userId` ownership as the canonical data-owner key for the first release. Resolve an authenticated user's household owner on the server and use that owner key for all personal-finance reads/writes. Never accept an owner ID from the client.
5. Add the authenticated user's `memberId` to the request context for attribution defaults, while still allowing an explicit shared/unassigned transaction where product rules permit.
6. A joining account with existing finance records must not silently merge or lose them. Initially reject joining if the account already owns financial records; a separately reviewed data-transfer flow can be built later.
7. Preserve email/password login and Telegram login as independent authentication methods attached to the same FlowMoney user account. Linking an existing email account to Telegram must require an authenticated session and a verified Telegram signature; never auto-link by matching email text.

This approach avoids a destructive migration of every existing financial table and allows access revocation to take effect on the next API request.

## Invitation UX

- Owner chooses an existing member profile or creates a new one for the invited person.
- Server creates a random single-use invitation and stores only its hash.
- The UI shares a Telegram Mini App deep link using the configured bot username and `startapp` parameter. Also provide a copyable invitation code for manual entry.
- Recipient opens the Mini App, authenticates with signed Telegram `initData`, reviews the household name and selected member profile, then explicitly accepts.
- Server validates expiry, revocation, single-use status, recipient account eligibility and household membership in one transaction.
- The recipient sees a clear confirmation before switching from their empty personal household to the invited household.

## API surface to implement

- `POST /api/personal-finance/household/invitations` — owner creates invite.
- `GET /api/personal-finance/household/invitations` — owner lists pending/recent invites without exposing token hashes.
- `DELETE /api/personal-finance/household/invitations/:id` — owner revokes invite.
- `POST /api/personal-finance/household/invitations/accept` — authenticated user accepts token and selected member profile.
- `GET /api/personal-finance/household` — returns household name, role, current user profile and members.
- `DELETE /api/personal-finance/household/access/:userId` — owner revokes a member's access.

## Required security and integration tests

- Owner and invited user see the same household dashboard and transaction history after acceptance.
- A third account cannot read or mutate either household's records.
- Client-supplied owner IDs and foreign member IDs are ignored/rejected.
- Expired, revoked, malformed, already-used and concurrently accepted invitations fail safely.
- Only the owner can create or revoke invitations or revoke household access.
- Revoked users lose access on the next API request, even with a still-valid JWT.
- Existing users receive personal households after migration without changing financial row IDs or balances.
- A joining account with existing finance records is rejected without modifying either account.
- Account linking requires both an authenticated FlowMoney session and verified Telegram identity; matching a synthetic Telegram email is never sufficient.

## Release boundary

Implement and test this in a separate feature branch after the Telegram Mini App auth PR is integrated into the personal-finance branch. Do not deploy or run the migration against production until backup, migration rehearsal and explicit approval are complete.
