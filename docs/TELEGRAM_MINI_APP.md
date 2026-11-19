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

The current code already supports Telegram Mini App authentication and secure account linking:
- POST /api/auth/telegram validates signed Telegram initData and creates or loads the matching nummioX account.
- POST /api/auth/telegram/link securely links a Telegram identity to an existing email account.
- The client reads Telegram start_param and can use it to accept household invitations.
- verifyTelegramInitData validates the HMAC, timestamp and Telegram user ID on the server.

This is Mini App authentication, not yet a complete conversational bot. The next implementation should be delivered in small staging-only milestones:

### Phase A — Bot foundation (implementation in progress)
- Rotate the previously exposed bot token with BotFather /revoke; configure the replacement only as Render server secret TELEGRAM_BOT_TOKEN.
- Configure TELEGRAM_WEBHOOK_SECRET (32–256 URL-safe random characters), TELEGRAM_WEBHOOK_URL and TELEGRAM_MINI_APP_URL as staging-only server environment variables.
- The staging code now includes POST /api/telegram/webhook with secret-token header verification, private-chat-only handling, request validation, rate limiting and durable update-ID deduplication.
- Implemented /start, /help and /app. /start and /app provide an HTTPS Mini App button when TELEGRAM_MINI_APP_URL is configured.
- The server registers the webhook with Telegram on startup only when the bot token, webhook secret and HTTPS webhook URL are all configured. Registration failures do not prevent the API from starting.
- Keep ordinary browser/email login available; Telegram remains an optional sign-in method.
- The first bot release is read-only: no finance data is sent and no transactions can be created or changed from chat.

### Phase B — Useful read-only finance assistant
- After explicit account linking, support private-chat commands such as /balance, /month and /help.
- Use the existing authenticated account/household services; never accept a Telegram-supplied account ID as authorization.
- Return only the linked user's permitted household totals. Do not expose full transaction descriptions or sensitive details by default.
- Add tests for unlinked users, revoked household members, cross-household isolation, duplicate webhook delivery and Telegram API failures.

### Phase C — Notifications
- Add user-controlled opt-in preferences before sending any finance notifications.
- Start with daily/weekly summaries and due-obligation reminders; avoid sending transaction details to group chats.
- Add quiet hours, timezone-aware scheduling, delivery retries and a way to pause/unsubscribe.
- Use a background worker/queue for scheduled notifications rather than relying on an HTTP request process staying alive.

### Phase D — Mini App polish and release
- Configure BotFather menu button and Main Mini App URL only after the selected HTTPS staging/production URL is approved.
- Test inside Telegram on Android and iOS, including auth expiry, account linking, household invite deep links, safe-area layout and back navigation.
- Keep the production bot token and webhook separate from staging; do not point BotFather at an unverified preview.

### Security and product boundaries
- Never store the bot token in Git, client variables or chat messages.
- Verify Telegram webhook secret tokens and signed Mini App initData independently.
- Ask users to explicitly opt in to notifications; no unsolicited broadcasts.
- The bot is a companion interface. The web app remains the complete finance workspace.
- No payments, transfers or other financial actions should be executable from chat in the first release.
