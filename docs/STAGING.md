# nummioX staging environment

## Purpose and isolation

The staging environment is dedicated to feature-branch verification. It uses its own PostgreSQL database and its own JWT secret. It must never use the production DATABASE_URL, JWT_SECRET, CLIENT_ORIGIN or Telegram token.

The separate Render Blueprint is `render.staging.yaml` and provisions:

- Web service: `nummiox-staging`
- PostgreSQL: `nummiox-staging-db`
- Region: Frankfurt for both resources
- Service plan: Free
- Database plan: Free, 1 GB, PostgreSQL 16
- Branch: `feature/household-collaboration`
- Deploy only after GitHub checks pass
- Prisma migrations run in the staging service's pre-deploy phase only

The free Postgres plan expires after 30 days. It is suitable for temporary QA, not persistent production data. The free web service can spin down when idle.

## Create / sync

Create a Render Blueprint from this repository with:

- Repository: `https://github.com/PurpleeHead/FlowMoney`
- Branch: `feature/household-collaboration`
- Blueprint file: `render.staging.yaml`
- Existing resources: create new (never adopt production resources)
- Auto-sync: disabled until the first staging deployment is verified

Review the planned resources before applying. The Blueprint references its own database using Render's internal connection string and generates a unique JWT secret. It does not reference or modify the production service or database.

## Secret configuration

After the staging service exists, open its Environment page and add:

- `TELEGRAM_BOT_TOKEN`: the newly rotated token from BotFather

Never commit the token, put it in this file, send it in chat, or use a `VITE_*` variable. The token previously exposed in chat must remain revoked.

`TELEGRAM_BOT_USERNAME=nummioX_bot` is already configured by the Blueprint. The staging service URL must be added as the Main Mini App URL in BotFather only after its first successful deployment and HTTPS health check. Do not change the production bot URL as part of staging verification.

## Test plan

1. Confirm `/api/health` returns `status: ok`.
2. Confirm the database contains the expected Prisma migration history.
3. Register two independent Telegram accounts and accept an invitation from one to the other.
4. Verify both accounts see the same household finances and each can attribute transactions to their linked member profile.
5. Verify a third account cannot read or mutate those records.
6. Verify invitation expiry, single use, revocation, existing-data join rejection and immediate access revocation.
7. Verify that production service settings and production database remain unchanged.

No production migration or deployment is part of this procedure.
