# Prisma Compute hosting evaluation

Status: **evaluation only — not a deployment plan**  
Date: 2026-10-22  
Source baseline: `perf/dashboard-sql-exchange-aggregates` at `79f2fff31f8149e2c63ad33e1d115752c99d3d17`

## Decision

FLOWMONEY is a TypeScript/Node.js application with PostgreSQL and Prisma, so Prisma Compute is a plausible free-tier candidate to evaluate. This repository is **not currently a drop-in Compute service**. Keep Render and its current configuration untouched until an isolated compatibility spike, data-safety plan, and explicit owner approval are complete.

## Code-level compatibility findings

- The server is an Express application started from `server/src/index.ts`. It calls `app.listen(port, '0.0.0.0', ...)` and reads configuration directly from `process.env`.
- The app loads `dotenv/config`, creates a Prisma client, and relies on `DATABASE_URL`. Auth also requires a strong `JWT_SECRET`; CORS depends on `CLIENT_ORIGIN`. Translation settings are optional.
- The production build currently compiles the server to `server/dist` and builds the Vite client to `client/dist`. Express optionally serves the built SPA from the local filesystem. A Compute adaptation must explicitly account for static assets and the service's request/response lifecycle; do not assume the current `app.listen` entry point can be deployed unchanged.
- The application uses Express middleware, rate limiting, JSON request parsing, JWT authentication, and Prisma/PostgreSQL transactions. These paths need compatibility tests in the target runtime, especially transaction rollback and concurrent expense/exchange mutations.
- Prisma schema and migrations are central to preserving historical balances. Do not point an experimental Compute service at the existing Render database or run migrations against any existing database during the spike.

## Required isolated spike

1. Create a minimal Compute adapter in this branch only; leave the existing Render entry point and configuration unchanged.
2. Make runtime configuration explicit and fail closed if required secrets or database configuration are missing. Never commit secrets or a real connection string.
3. Verify that the selected Compute runtime supports the actual Express routing/middleware pattern or adapt the handler to the documented request adapter.
4. Verify static-client delivery separately; do not depend on a persistent writable filesystem.
5. Run the existing unit tests, TypeScript build, dependency audit, and disposable-PostgreSQL migration/financial-equivalence suite.
6. Add adapter-level tests for health/readiness, CORS, authentication, JSON body limits, and transaction rollback.
7. Use only a newly created disposable database for target-platform tests. Do not import or copy user/production records.
8. Document a rollback path and measure cold-start behavior, connection-pool behavior, request limits, and database limits before considering a pilot.

## Free-tier and financial-data risks

- A free hosting quota is not the same as a production reliability guarantee. Validate current limits, region availability, request duration, concurrency, and database operation/storage caps directly before committing to the platform.
- The reviewed free-tier documentation indicates that automated backups and point-in-time recovery are not included. That is a material risk for a personal finance application. A separate, tested backup/restore process is required before any real financial data is placed there.
- Do not assume an existing Render database is production or that the Render service uses the only database listed in its workspace. The current Render audit could not establish the live service's database target.
- The existing Render service was found with auto-deploy enabled on `review/pr-3-fix` and a startup command that runs `prisma migrate deploy`. This remains an independent operational risk; this evaluation must not change Render settings or trigger a deployment.

## Go/no-go gates

- [ ] A documented, minimal Compute adapter builds and runs against a disposable database.
- [ ] All existing CI checks and the new adapter tests pass.
- [ ] Database transactions, authentication, and financial calculations are verified in the target runtime.
- [ ] Free-tier quotas and region are verified against current official documentation.
- [ ] A backup and restore procedure is implemented and successfully tested.
- [ ] Production database identity and migration state are independently established.
- [ ] Owner explicitly approves any pilot deployment and any future data migration.

**Current recommendation:** continue the compatibility spike only. Do not migrate data, create a hosted service, deploy, or alter Render until the gates and owner approval are complete.
