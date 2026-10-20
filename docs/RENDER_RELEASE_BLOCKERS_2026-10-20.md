# FLOWMONEY — Render release blocker audit (2026-10-20)

This is a point-in-time read-only audit of the currently configured Render web service. It is not a production approval.

## Observed live configuration

Service: `flowmoney-app` (`srv-db8461gm7kps73d01ge0`)

- Repository: `https://github.com/PurpleeHead/FlowMoney`
- Live branch: `review/pr-3-fix`
- Auto-deploy: enabled on commit
- Live health check: `/api/health`
- Runtime plan: Free, Singapore, one instance
- Last observed live deployment: commit `bb2bb41d801f466049c9c50e7bd2da02e007d235`, deployed 2026-10-17
- The live service is not running the current production-candidate PR branch.

The repository's `render.yaml` config specifies auto-deploy off and readiness check `/api/ready`. This differs from the live service configuration. Do not switch the live branch or health path blindly; coordinate a controlled configuration change after release gates are ready.

## Release blockers

1. **Deployment configuration mismatch:** reconcile branch, auto-deploy policy, and readiness path with the reviewed production candidate. Confirm that `/api/ready` succeeds only when the database is reachable.
2. **Production database not verified:** the existing Render test database is not a production database and is not release-ready.
3. **Backup and restore not proven:** configure the documented database backup secrets and object-storage credentials; perform an encrypted backup, verify the uploaded object, and conduct a restore drill into a disposable database.
4. **Legacy wallet reconciliation:** run the read-only legacy wallet balance preflight against a production snapshot and resolve every nonzero legacy balance before any backfill or migration that could affect balances.
5. **Release smoke test:** validate registration/login without email verification, exchange entry and editing, expenses, receipt review/save, cursor continuation, CSV export, wallet balances, and health/readiness against the target environment.
6. **Operational checks:** confirm deployment logs, error responses, database connectivity, and backup retention after the controlled release.

## Safe order of operations

- Keep the release PR unmerged until CI, migration checks, financial regression tests, and code review pass.
- Prepare production database and backup credentials without putting secrets in the repository or CI logs.
- Test restore and migration/backfill against disposable data first.
- Disable or control automatic deployment before changing the live branch.
- Apply the reviewed configuration deliberately, deploy the selected commit, run smoke tests, and verify logs.
- Roll back if health checks or financial reconciliation fail.

## Evidence limitation

This document records configuration returned by the Render service API on 2026-10-20. It does not prove database contents, secret availability, backup success, restore success, or production readiness. Those require explicit checks in the target environment.


## Observability spot-check — 2026-10-20

A read-only Render check was repeated after the code/documentation CI passed:

- The service API still reports the live branch as `review/pr-3-fix`, auto-deploy enabled, and health path `/api/health`; the latest deployment remains the 2026-10-17 commit listed above.
- Render returned no application error/fatal log entries in the queried 2026-10-20 UTC window. This is not proof that the application is healthy or that no errors occurred outside the queried window.
- Render returned no HTTP request-count/latency samples for the service in that time window, so these metrics cannot establish that health/readiness endpoints were reached successfully. The web inspection interface also could not retrieve the endpoints directly.
- CPU/memory samples were available and low in the sampled points, but the sparse samples and missing HTTP telemetry are insufficient for a release health claim.

**Action:** retain endpoint smoke tests and database-backed readiness verification as explicit release gates. No service configuration, deployment, or database was changed during this check.
