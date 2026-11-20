# nummioX Telegram Mini App setup

nummioX can be opened as a Telegram Mini App. The web client remains a normal responsive web app as well.

## 1. Existing Telegram bot

The bot has already been created: [@nummioX_bot](https://t.me/nummioX_bot).

1. Open [@BotFather](https://t.me/BotFather) and select `@nummioX_bot`.
2. Use `/revoke` to invalidate the token that was exposed and issue a new one. If a token is ever shared in a chat, treat it as compromised and rotate it immediately.
3. Store the token as `TELEGRAM_BOT_TOKEN` on the server. Never send it in chat, commit it to Git, or expose it through a `VITE_*` client variable.

## 2. Configure the server

Set `TELEGRAM_BOT_TOKEN` in the server environment (Render service environment or local `server/.env`) and `TELEGRAM_BOT_USERNAME=nummioX_bot`. Do not expose the token as a `VITE_*` variable.

The server verifies Telegram's signed `initData` using the bot token before creating or loading an account. Invalid signatures and data older than 24 hours are rejected. The database migration adds nullable Telegram identity fields and preserves existing users and finance records.

## 3. Configure the Mini App in BotFather

After the web app is deployed to HTTPS:

1. Run `/setmenubutton` in BotFather.
2. Select the bot.
3. Set the button text to `Open nummioX`.
4. Provide the deployed HTTPS app URL.
5. In Bot Settings, configure the same URL as the bot's **Main Mini App**. Telegram deep links can use Telegram's `startapp` parameter, which is delivered to the Mini App as `initDataUnsafe.start_param` only when a Main Mini App is configured. This is optional: household invitations are also generated as ordinary web links and can be accepted in a browser after email/password sign-in, without a configured bot.

For the bot profile, set the display name to `nummioX` and use this description: `Удобный учёт доходов, расходов, бюджета и накоплений семьи.`

Do not point BotFather at a feature-branch preview until it is deployed and verified. The production URL should only be changed after an approved deployment.

## 4. Local development

Run the normal nummioX setup, then set `TELEGRAM_BOT_TOKEN` in `server/.env`. Telegram's Web App SDK is loaded by the client. Opening the app from an actual Telegram Mini App supplies signed `initData`; opening the same URL in an ordinary browser continues to use email/password authentication.

## Security notes

- Only the server receives the bot token.
- The client sends Telegram's raw `initData`; it never decides the authenticated Telegram user ID.
- The server validates the HMAC signature, timestamp and user ID before issuing the existing nummioX session token.
- Never accept `initDataUnsafe` as proof of identity.
- The Telegram identity and household migrations are additive. They must be applied through the reviewed migration process, not by production startup.
- Household invitations are random, single-use, expire after seven days and store only a SHA-256 token hash. Rotate the bot token with BotFather `/revoke` immediately if it is ever exposed.


## 5. Telegram product roadmap

Telegram authentication and the core companion bot are implemented on staging. This section tracks the remaining setup and release gates rather than planned code work.

### Implemented on staging

- POST /api/auth/telegram validates signed Telegram initData and creates or loads the matching nummioX account.
- POST /api/auth/telegram/link securely links a Telegram identity to an existing email account.
- The client reads Telegram start_param and can use it to accept household invitations.
- POST /api/telegram/webhook verifies the secret-token header, restricts handling to private chats, validates updates, applies rate limiting and deduplicates Telegram update IDs.
- /start, /help and /app commands are implemented. /start and /app provide an HTTPS Mini App button when TELEGRAM_MINI_APP_URL is configured.
- The server registers the webhook on startup when the bot token, webhook secret and HTTPS webhook URL are configured. Staging logs previously confirmed successful registration.
- /balance and /month provide read-only finance summaries after account linking and enforce active household access.
- Per-account reminder preferences, timezone-aware due-obligation selection, idempotent delivery records and the one-shot reminder worker are implemented. Reminders are disabled by default and require a linked Telegram account.
- No finance transactions can be created, edited or paid through chat.

### Remaining staging setup and QA

- Confirm that the staging bot token has been rotated in BotFather if the previously exposed token was not already revoked. Keep the replacement only in the Render staging secret TELEGRAM_BOT_TOKEN.
- Verify BotFather's staging menu button and Main Mini App URL, then test opening the app inside Telegram on Android and iOS.
- Manually test /start, /help, /app, /balance and /month with a linked account, an unlinked account and a household member whose access has been revoked.
- Test reminder opt-in, local delivery-time preferences and an actual Telegram delivery using a controlled test obligation.
- Activate automated 15-minute scheduling only after PR #162 is merged into the repository default branch and GitHub Actions secrets DATABASE_URL (staging only) and TELEGRAM_BOT_TOKEN are configured. A successful scheduled or manually dispatched workflow run is required before claiming reminders are active.
- Do not use production credentials or production bot settings for staging tests.

### Production release gates

- Keep the production bot token, webhook secret and webhook URL separate from staging.
- Configure BotFather's production Main Mini App URL only after the production web release has been explicitly approved and verified.
- Run a separate production bot smoke test after explicit approval; no production bot configuration is authorized by staging work.

### Security and product boundaries

- Never store the bot token in Git, client variables or chat messages.
- Verify Telegram webhook secret tokens and signed Mini App initData independently.
- Ask users to explicitly opt in to notifications; no unsolicited broadcasts.
- The bot is a companion interface. The web app remains the complete finance workspace.
- No payments, transfers or other financial actions should be executable from chat in the first release.
