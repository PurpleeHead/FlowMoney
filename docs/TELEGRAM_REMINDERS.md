# Telegram payment reminders

Telegram reminders are optional and disabled by default for every account. Each linked account can enable them independently in **Settings → Telegram payment reminders** and choose a local delivery time. Reminders are sent one day before an unpaid household obligation is due.

## Worker

The worker is a one-shot process. It checks opted-in accounts, evaluates each account's reminder time in that person's timezone, matches tomorrow's due date in the household ledger owner's timezone, and sends one digest per account. A unique delivery record prevents repeat messages for the same account and payment occurrence.

Run it every 15 minutes:

```text
*/15 * * * *
```

The schedule is interpreted as UTC by Render Cron Jobs. The worker compares the configured time against each user's IANA timezone, so the reminder time remains local across daylight-saving changes.

## Render Cron Job configuration

Create a separate Cron Job only after confirming the Render plan and cost:

- **Repository:** `PurpleeHead/FlowMoney`
- **Branch:** `feature/household-collaboration` (staging branch)
- **Build command:** `npm ci && npm run build`
- **Start command:** `npm --workspace server run telegram:reminders`
- **Schedule:** `*/15 * * * *`
- **Environment:** use the same PostgreSQL connection and `TELEGRAM_BOT_TOKEN` as the staging API service. Do not paste secrets into source control.

The worker does not require `TELEGRAM_WEBHOOK_SECRET`. It does require a reachable PostgreSQL database and a valid bot token. If the cron job is not configured, users may save reminder preferences but no scheduled reminders will be sent.

## Safety

- Preferences are per account; the default is off.
- Enabling reminders requires a verified Telegram link.
- Only active household members with reminders enabled receive messages.
- The worker reads payment occurrences; it never changes financial records.
- Delivery records are private backend state protected by PostgreSQL row-level security.
- The staging worker should be tested before any production setup.
