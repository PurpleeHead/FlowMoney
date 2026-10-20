# FLOWMONEY SaaS: trial, subscription, and access-entitlement design

**Status:** design proposal only. This document does not implement billing, alter the Prisma schema, create migrations, or authorize a merge/deployment.

## 1. Agreed commercial hypothesis

- Initial audience: Russian-speaking residents of Vietnam.
- Trial: 14 calendar days.
- No payment card is required to start the trial.
- After the trial, the user deliberately chooses whether to subscribe; there is no automatic charge.
- Initial price hypothesis: RUB 199 per month. This is not validated demand or a final provider settlement currency.
- Preserve user data if the trial ends or a subscription lapses.
- Do not add email verification as part of this work without separate approval; the existing product decision excluded it.

## 2. Product states

Model the account's billing state separately from authentication and user data.

| State | Meaning | Access |
| --- | --- | --- |
| `TRIALING` | Current time is before the recorded trial end | Full trial entitlements |
| `ACTIVE` | A subscription period is confirmed as paid/active by a trusted server-side process | Full paid entitlements |
| `EXPIRED` | Trial ended and no active subscription exists | Read-only + export |
| `CANCELED` | Subscription was canceled; access remains until the paid-through period ends, if any | Full access through paid-through date, then read-only + export |
| `PAYMENT_PENDING` | User started checkout/manual payment flow, but payment is not yet confirmed | Existing entitlement remains; never grant paid access based only on a client redirect |
| `SUSPENDED` | Account access is restricted for a documented safety/support reason | No write access; preserve data and provide a support path |

Avoid storing an independently editable `isPremium` boolean. It becomes stale and is easy to trust incorrectly. Entitlements must be derived on the server from persisted subscription state and dates.

## 3. Trial rules

1. Start the 14-day clock once, at successful account creation, and persist `trialStartedAt` and `trialEndsAt` in UTC. Do not restart it on login, reinstall, or client-side storage reset.
2. Use the persisted `trialEndsAt` as the source of truth. Calculate expiry server-side; never trust a browser clock or a submitted plan/status.
3. Define expiry precisely as `now >= trialEndsAt`. Use one shared clock-injected entitlement function so boundary behavior is testable.
4. A user who does not subscribe enters `EXPIRED` access without data deletion.
5. Do not offer an automatic second trial in the MVP. Any support/admin exception must be audited and server-authorized.
6. Do not require card details during registration or trial.

## 4. Entitlements matrix

The API is the enforcement point. The UI may hide or disable controls for clarity, but UI checks are not security controls.

| Capability | Trialing | Active | Expired / unpaid |
| --- | --- | --- | --- |
| Sign in and view own dashboard/history | Yes | Yes | Yes, read-only |
| Create/update/delete exchanges | Yes | Yes | No |
| Create/update/delete expenses | Yes | Yes | No |
| Create/update/delete receipt records | Yes | Yes | No |
| Run OCR and translation | Yes, with reasonable abuse/cost limits | Yes, with reasonable abuse/cost limits | No new processing |
| Analytics and rate calculations | Yes | Yes | Read existing results |
| Export own data (CSV/JSON where supported) | Yes | Yes | Yes |
| Manage subscription / reopen checkout | Yes | Yes | Yes |
| Read or modify another user's data | Never | Never | Never |

For expired accounts, keep data export and subscription reactivation accessible without a paid entitlement. The first release should not implement deletion, retention expiry, or a data-purge policy implicitly through billing.

## 5. Suggested domain model (conceptual; not a migration)

Prefer a billing domain separate from finance tables.

### Subscription record

Fields to evaluate for a later Prisma migration:

- `id`, `userId`, `planCode` (initial code such as `individual_monthly_v1`)
- `status` (server-controlled enum)
- `trialStartedAt`, `trialEndsAt`
- `currentPeriodStart`, `currentPeriodEnd`
- `canceledAt`, `endedAt`
- `provider` and nullable provider customer/subscription identifiers, added only when a provider is chosen
- `createdAt`, `updatedAt`

Keep enough subscription history to investigate disputes and avoid silently overwriting past periods. Decide whether trial dates live on a one-per-user entitlement row or a subscription-history table during implementation; enforce a single effective entitlement per user transactionally. Provider IDs must be unique when present.

### Billing events / audit trail

A separate append-only event record should capture trusted transitions such as trial started, checkout initiated, payment confirmed, renewal confirmed, cancellation requested, period ended, refund/chargeback, and administrative override. Store provider event IDs uniquely for idempotency. Never store card numbers or CVC.

Do not create payment tables until the supported provider and payment flow are selected.

## 6. Server-side authorization design

Implement one pure, well-tested entitlement resolver, conceptually:

`getEntitlements(userId, now) -> { state, canRead, canWrite, canExport, canUseOcr, canUseTranslation, canUseAnalytics, trialEndsAt, paidThrough }`

- The resolver loads trusted persisted state; callers cannot pass an arbitrary `userId`, `state`, or `isPremium` to grant access.
- Authentication middleware identifies the user; entitlement middleware/service checks the requested capability after authentication.
- Apply the same write guard to every mutation route for expenses, exchanges, receipts, wallets, and any future user-editable financial resources. Review all routes before declaring coverage.
- Keep read routes owner-scoped regardless of subscription state.
- Exports must remain owner-scoped and rate-limited.
- Return a stable response, e.g. HTTP 402 or 403 with machine-readable code `SUBSCRIPTION_REQUIRED`, `trialEndsAt`, and a safe message. Select one status convention and document it before coding.
- Exempt auth, subscription-status, checkout initiation, provider webhook, health/readiness, and export endpoints as intentionally designed; avoid broad middleware that accidentally blocks reactivation.
- A checkout return URL or frontend state is never proof of payment. Only a verified server-side provider event or an explicitly designed trusted manual reconciliation may activate a paid period.
- Do not make a user's historical financial values depend on their current subscription state.

## 7. API surface before payments

First implementation should be limited to trial state and entitlement checks; no payment processing:

- `GET /api/billing/me`: return the current state, trial end, available plan summary, and effective entitlements for the authenticated user.
- A later `POST /api/billing/checkout` may be added only after a provider is selected. It must create checkout sessions server-side.
- A later signed webhook endpoint must verify signatures, reject invalid events, deduplicate provider event IDs, and handle out-of-order/replayed events.
- Never accept `status=ACTIVE`, price, currency, period end, or provider identifiers from an ordinary client request.

## 8. Pricing and payment-provider decision

Keep RUB 199/month as a product hypothesis, not a hard-coded entitlement rule. Separate plan identity, displayed price, billing currency, provider price ID, and entitlement definitions.

Before provider integration, verify:
- seller/business registration jurisdiction and provider eligibility;
- whether the provider can charge the target audience and settle/payout to the seller;
- supported payment methods for users in Vietnam and cross-border Russian-speaking customers;
- fees, payout currency, refund/dispute handling, recurring-payment rules, and local legal/tax requirements;
- how to offer a compliant non-card manual payment flow if the provider does not support the intended audience.

Do not assume eligibility based only on nationality or current residence. Do not collect or paste provider secrets into GitHub, client code, or chat.

## 9. Required tests before enabling entitlements

- Trial begins once and the persisted end date does not move on later login.
- Trial boundary: just before expiry is full access; at/after expiry is read-only.
- Client clock manipulation and forged `isPremium`/status payloads cannot grant access.
- Expired users cannot mutate every protected resource through direct API requests.
- Expired users can read their own data, export it, and initiate reactivation.
- One user's subscription state never affects another user's data or access.
- Subscription state changes and provider event processing are transactional/idempotent.
- Canceled paid access remains available only through the confirmed paid-through date.
- Missing billing records fail safely without granting paid access; preserve an explicit, tested migration/backfill policy for existing accounts.
- No payment credentials or provider secrets are exposed in responses/logs.
- Full server tests, client tests, production builds, and disposable-PostgreSQL migration checks pass.

## 10. Delivery sequence and release gates

1. Finish review of the current release candidate and all relevant stacked PR dependencies; resolve the exact release head and CI evidence.
2. Close production blockers: persistent PostgreSQL, verified live Render settings/manual deploy, private encrypted backups, independent restore drill, readiness health check, runtime smoke tests, and legacy wallet-balance decision.
3. Review and approve this design before any schema or authorization code is written.
4. Implement trial timestamps and entitlement resolver on a dedicated branch; add read-only behavior and API tests. No provider SDK or payment credentials yet.
5. Add a migration only after checking production data and defining a safe backfill for existing users; validate against disposable PostgreSQL.
6. Verify every mutation endpoint and client behavior, especially export and subscription reactivation.
7. Select a provider only after eligibility/fees/settlement checks. Implement checkout and signed/idempotent webhooks in a separate phase.
8. Keep all PRs unmerged and production untouched until the owner explicitly approves the relevant merge/deploy step.

## 11. Current non-goals

- No payment provider integration or automatic charges.
- No card collection.
- No email verification change.
- No automatic data deletion after trial.
- No production migration, branch merge, Render setting change, or deployment.
- No claim that RUB 199/month or the 14-day trial has been market-validated.
