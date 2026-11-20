# Telegram payment reminders

Telegram reminders are optional and disabled by default for every account. Each linked account can enable them independently in **Settings → Telegram payment reminders** and choose a local delivery time. Reminders are sent one day before an unpaid household obligation is due.

## Worker

The worker is a one-shot process. It checks opted-in accounts, evaluates each account's reminder time in that person's timezone, matches tomorrow's due date in the household ledger owner's timezone, and sends one digest per account. A unique delivery record prevents repeat messages for the same account and payment occurrence.

Run it every 15 minutes:

```text
*/15 * * * *
```

The schedule is interpreted as UTC. The worker compares the configured time against each user's IANA timezone, so the reminder time remains local across daylight-saving changes.

## Current scheduling approach: GitHub Actions

Render Cron Jobs were not selected because the available free service plan does not support the required scheduled worker without creating a potentially paid resource. The workflow `.github/workflows/telegram-payment-reminders.yml` is merged into the repository default branch (`main`):

- Runs every 15 minutes and supports manual dispatch.
- Checks out `feature/household-collaboration` explicitly, so the worker code and database schema come from staging.
- Runs the one-shot `telegram:reminders` command; it does not deploy the app or modify Render resources.
- Requires repository Actions secrets `DATABASE_URL` (the staging database connection string) and `TELEGRAM_BOT_TOKEN`.
- The schedule is registered, but successful reminder delivery is not yet verified.

**Activation checklist:** add both secrets directly in GitHub **Settings → Secrets and variables → Actions**. Use the staging database URL from the Render staging service and the staging bot token only. Then open **Actions → nummioX Telegram payment reminders**, choose **Run workflow**, and verify a successful run. Never paste either secret into chat or source control. Do not use production credentials in this staging workflow.

The worker does not require `TELEGRAM_WEBHOOK_SECRET`. It does require a reachable staging PostgreSQL database and a valid staging bot token. Until a workflow run succeeds and delivery is verified, users may save reminder preferences but should not assume automatic reminders are being sent.

## Safety

- Preferences are per account; the default is off.
- Enabling reminders requires a verified Telegram link.
- Only active household members with reminders enabled receive messages.
- The worker reads payment occurrences; it never changes financial records.
- Delivery records are private backend state protected by PostgreSQL row-level security.
- The staging worker should be tested before any production setup.
