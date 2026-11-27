# nummioX transactional email setup

nummioX sends password-recovery messages through the Resend HTTP API. The application code is ready, but email delivery stays disabled until the sender is configured.

## 1. Create a Resend account and API key

1. Create an account at https://resend.com/.
2. Open API Keys and create a key with sending permission.
3. Store it as `RESEND_API_KEY` in the Render **staging** service environment. Do not commit it or paste it into chat.

## 2. Choose and verify a sending domain

For real users, use a domain you own (for example, a dedicated mail subdomain such as `mail.example.com`). Add that domain in Resend, then publish the exact DNS records Resend displays at your DNS provider. Resend uses domain authentication records such as SPF and DKIM; follow the dashboard's current values rather than copying records from another domain.

After Resend reports the domain as verified, choose a sender address on that domain, for example `noreply@mail.example.com`, and set:

- `RESEND_FROM_EMAIL=nummioX <noreply@mail.example.com>`

Do not use a sender address on an unverified domain for production.

## 3. Configure the application

Set these variables on the **staging** Render service first:

- `RESEND_API_KEY` — secret API key from Resend.
- `RESEND_FROM_EMAIL` — sender name and address on the verified domain.
- `APP_BASE_URL=https://nummiox-staging.onrender.com` — public origin where reset links should open.

After confirming delivery and reset flow on staging, production can be configured separately only as part of the approved release process.

## 4. Testing before domain verification

Resend documents test-email addresses such as `delivered@resend.dev` for testing delivery events. This is not a substitute for a verified sender domain or proof that real user inboxes can receive messages. Do not enable account recovery for public users until the sender domain is verified and a real mailbox test succeeds.

## Security behavior

- Reset tokens contain 256 bits of randomness; only SHA-256 hashes are stored.
- Links expire after 30 minutes and are single-use.
- A new request invalidates previous unused links for the account.
- A successful reset increments the account session version and invalidates existing JWT sessions.
- Requests are rate-limited and responses do not reveal whether an account exists.
- Telegram-only accounts with synthetic addresses cannot use email password recovery.