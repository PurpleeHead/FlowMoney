# nummioX Telegram Mini App setup

nummioX can be opened as a Telegram Mini App. The web client remains a normal responsive web app as well.

## 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Run `/newbot` and follow the prompts.
3. Copy the bot token. Treat it as a secret; never commit it to Git.
4. The bot username is `@nummioX_bot`. Keep it for the Mini App configuration.

## 2. Configure the server

Set `TELEGRAM_BOT_TOKEN` in the server environment (Render service environment or local `server/.env`). Do not expose it as a `VITE_*` variable.

The server verifies Telegram's signed `initData` using the bot token before creating or loading an account. Invalid signatures and data older than 24 hours are rejected. The database migration adds nullable Telegram identity fields and preserves existing users and finance records.

## 3. Configure the Mini App in BotFather

After the web app is deployed to HTTPS:

1. Run `/setmenubutton` in BotFather.
2. Select the bot.
3. Set the button text to `Open nummioX`.
4. Provide the deployed HTTPS app URL.
5. Optionally use `/newapp` to create a named Mini App. Use `nummioX` as its title and a short name such as `nummiox` if Telegram accepts it.

For the bot profile, set the display name to `nummioX` and use this description: `Удобный учёт доходов, расходов, бюджета и накоплений семьи.`

Do not point BotFather at a feature-branch preview until it is deployed and verified. The production URL should only be changed after an approved deployment.

## 4. Local development

Run the normal nummioX setup, then set `TELEGRAM_BOT_TOKEN` in `server/.env`. Telegram's Web App SDK is loaded by the client. Opening the app from an actual Telegram Mini App supplies signed `initData`; opening the same URL in an ordinary browser continues to use email/password authentication.

## Security notes

- Only the server receives the bot token.
- The client sends Telegram's raw `initData`; it never decides the authenticated Telegram user ID.
- The server validates the HMAC signature, timestamp and user ID before issuing the existing nummioX session token.
- Never accept `initDataUnsafe` as proof of identity.
- The Telegram identity migration is additive. It must be applied through the reviewed migration process, not by production startup.
