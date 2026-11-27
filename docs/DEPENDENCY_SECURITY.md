# Dependency security snapshot

Snapshot date: 2026-11-19 02:54 UTC  
Source: GitHub Actions run `44447647615` on audit-refresh commit `48541c8242ecf3d28ad55f69f794ac18b7943f08`. This is an npm dependency audit, not a runtime penetration test.

## Latest verified audit results

- Full repository dependency tree: **0 vulnerabilities** (0 low, 0 moderate, 0 high, 0 critical).
- Isolated server production dependency tree: **0 vulnerabilities**.
- Isolated client production dependency tree: **0 vulnerabilities**.
- The audit run installed the existing lockfile with `npm ci`; no package or lockfile changes and no forced fixes were needed to obtain the clean result.
- The previous 18 November snapshot reported five high findings in the development toolchain (`fdir`, `picomatch`, `tinyglobby`, `vite`, `vitest`). The fresh audit database no longer reports those findings.
- The previous suggested automatic fix was a Vitest downgrade to `3.1.4`. It was not applied.

The same CI run passed Prisma validation, client generation, all eight migrations against ephemeral PostgreSQL 17, server/client builds, and server/client tests.

## Exact toolchain versions in the lockfile

- Vite: `6.4.6`
- Vitest: `5.1.0`
- fdir: `6.5.0`
- picomatch: `4.0.7`
- tinyglobby: `0.2.17`

No dependency versions were changed as part of this audit refresh. Keep the current toolchain unless a new advisory affects the installed versions and a compatible patched release is identified.

## Supply-chain and authentication hardening already present

- The lockfile package tarball references use the canonical `registry.npmjs.org` registry.
- JWT middleware accepts only HS256 session tokens and rejects missing, empty, or incorrectly typed identity claims.
- Middleware tests cover HS256 acceptance, HS384 rejection, malformed identity claims and missing bearer credentials.
- Authenticated API integration tests cover concurrent obligation payment (one linked expense only), repeated income receipt (one actual ledger entry), and cross-household attempts to pay/receive or assign records.

## Safe remediation policy

- Never run `npm audit fix --force` as an automatic release step.
- Prefer compatible patch/minor updates and regenerate the lockfile using npm.
- Review any major upgrade separately; run build, server/client tests, Prisma validation and migration replay before merging.
- Keep server and client production audits separate from the full development-toolchain audit.
- A clean dependency audit does not replace manual review of the application, CI environment or production infrastructure.

## Release gate

The latest verified audit is clean across the full repository and both production dependency trees. Refresh it again on the exact release commit before production approval.
