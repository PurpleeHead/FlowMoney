# FLOWMONEY production backup and release gate

**Status:** prepared on `release/production-candidate-2026-10-19`; not yet active in production.

## Free-tier layout

- Application/API: existing Render web service.
- PostgreSQL: **recommended first candidate: Neon Free**. It provides managed PostgreSQL with a free allowance and compute that scales to zero, rather than Render Free Postgres's fixed 30-day expiry. Confirm current limits and create the project in the account owner's control. Use a direct PostgreSQL connection URL for Prisma migrations and backups; do not use the current `flowmoney-test-db` Render Free database for production.
- Encrypted off-site backups: Cloudflare R2 Standard, within its published free allowance (10 GB-month storage, 1 million Class A operations, 10 million Class B operations, no egress fee). Keep backup size/usage within the allowance; provider free-tier terms can change.
- Backup cadence/retention: daily at 03:17 UTC, plus manual workflow dispatch; prune objects older than 30 days only after a new backup has been uploaded and verified.

## GitHub configuration required

Configure these repository **Actions secrets** on the trusted repository before running the workflow:

- `FLOWMONEY_BACKUP_DATABASE_URL`: direct PostgreSQL connection URL for the production database, with TLS enabled. Use the direct endpoint for `pg_dump` and Prisma migrations.
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`: scoped to the backup bucket only, with list/read metadata/write/delete access for the backup prefix.
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

Configure this repository **Actions variable**:

- `FLOWMONEY_BACKUP_AGE_RECIPIENT`: public age encryption recipient (usually `age1...`). Keep the corresponding private age identity offline and separately backed up. Never put the private identity in the repository, a workflow log, or R2.

Create a private R2 bucket and a dedicated bucket-scoped access key. Do not reuse an application credential. Keep the bucket private; no public access or public custom domain.

## Backup acceptance test (required before deployment / public launch)

1. Confirm the production database URL points to the intended persistent database and not `flowmoney-test-db`.
2. Confirm the R2 bucket is private and the age private identity can be recovered offline.
3. After PR #82's code review and CI pass, merge only with Render auto-deploy disabled. This makes the workflow available on `main`; merging must not be treated as permission to deploy or migrate the production database.
4. Run **Actions → FLOWMONEY encrypted database backup → Run workflow** on `main` before triggering a Render deploy. It creates a PostgreSQL custom-format dump, validates its archive catalog, encrypts it before upload, uploads to R2, and verifies the uploaded object's non-zero size.
5. Independently download the encrypted object, decrypt it using the offline private age identity, and restore it into a disposable PostgreSQL database. Verify tables and representative records/counts. A successful upload alone is not a restore test.
6. Record the timestamp, object key, restore result, and the person who performed the test in the release notes. Do not store secrets or real financial data in the notes.
7. Manually deploy the reviewed commit only after the pre-deploy backup and restore test pass. The current Render start command runs `prisma migrate deploy`; therefore deploying it applies migrations. Confirm the target URL and backup immediately before triggering the deploy.
8. After migration, run and verify another encrypted backup, then perform runtime smoke tests before public launch. The workflow's daily schedule maintains ongoing backups after it is on `main`.

## Safe deployment sequence

1. Keep PR #82 in draft until the release branch's CI passes and code review is complete.
2. Provision the persistent Neon Free PostgreSQL target (or another owner-approved persistent free PostgreSQL service). Do not run production migrations yet.
3. Configure the R2 bucket, scoped credentials, public age recipient variable, and production backup database URL as GitHub Actions secrets/variables. Never paste credentials into chat or commit them.
4. Set the live Render service to **manual deploy / auto-deploy disabled** before changing its branch to `main`; the service currently tracks `review/pr-3-fix`. Verify this in the Render Dashboard rather than assuming a Blueprint change updated the live service.
5. Set production environment variables, including a unique random `JWT_SECRET` with at least 32 non-whitespace characters, the production `DATABASE_URL`, `NODE_ENV=production`, and the correct `CLIENT_ORIGIN`/`APP_URL`. Never commit values.
6. Once CI and review are complete, merge PR #82 without enabling a deployment. The live Render service currently tracks a different branch, but its actual settings must still be checked manually.
7. Run the backup workflow on `main` and complete a restore drill before triggering any production deploy or migration.
8. Manually deploy the reviewed commit only after the backup gate is satisfied. Verify `/api/health`, register/login, user data isolation, create/edit/delete exchange and expense, wallet movements, actual versus estimated rates, receipt review, RU/EN switching, mobile layout, and logout.
9. Run the encrypted backup workflow again after migration and before public launch. Keep auto-deploy disabled until launch checks are signed off.

## Restore outline

- Download the chosen `*.dump.age` object from the private R2 bucket.
- Decrypt offline: `age --decrypt --identity /secure/offline/age-identity.txt --output flowmoney.dump flowmoney.dump.age`.
- Restore into a **new/disposable** PostgreSQL database, never over the live database during a test: `pg_restore --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" flowmoney.dump`.
- Verify schema and record counts, then securely delete temporary plaintext dump files.

## Known limitations / explicit release gates

- GitHub Actions backup workflow is only scheduled after the workflow is merged to `main`; it cannot access production secrets from an unmerged draft PR.
- Cloudflare R2 credentials and the database backup URL must be configured by the account owner; these credentials are not currently available to this workflow.
- The workflow validates the dump and uploaded object, but the first successful backup still requires a separate manual restore drill.
- The proposed Render Blueprint now uses `/api/ready` for health checks. `/api/health` remains a liveness endpoint; readiness returns HTTP 503 when the database probe fails and does not expose connection details. Applying a Blueprint is a live configuration change and still requires explicit owner approval.
- Free tiers are not an SLA. Keep usage under the published quota and review provider policies periodically.
- Do not switch the live service to `main`, trigger a production deploy, or run production migrations until the required checks and backup/restore gate are complete.
