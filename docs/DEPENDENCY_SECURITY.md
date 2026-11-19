# Dependency security snapshot

Snapshot date: 2026-11-18 15:01 UTC  
Source: GitHub Actions run `44330732634` on staging commit `f84ce91bb79b4169f15e82de346c5ec91588e01b`. This is an npm dependency audit, not a runtime penetration test.

## Verified audit results

- Full repository dependency tree: **5 high, 0 critical, 0 moderate, 0 low**.
- Reported package nodes: `fdir`, `picomatch`, `tinyglobby`, `vite`, and `vitest`.
- Isolated server production dependency tree: **0 advisories**.
- Isolated client production dependency tree: **0 advisories**.
- The five full-tree findings are in the build/test toolchain, not the separately resolved production dependency sets.
- The audit's suggested automatic fix was to change Vitest to `3.1.4` (a major-version change/downgrade relative to the installed `5.1.0`). This was not applied.
- No `npm audit fix --force`, forced downgrade, or unreviewed dependency override was applied.

The staging CI run passed dependency reporting, both isolated production audits, Prisma validation/client generation, all eight migrations against ephemeral PostgreSQL 17, server/client builds, tests, and PowerShell syntax validation.

## Exact toolchain versions in the lockfile

- Vite: `6.4.6`
- Vitest: `5.1.0`
- fdir: `6.5.0`
- picomatch: `4.0.7`
- tinyglobby: `0.2.17`

Vite `6.4.6` is the patched 6.4 release for the Vite dev-server advisories published in November 2026. Vitest `5.1.0` includes the fix for the Vitest 5 dev-server file exposure advisory (fixed in `5.0.5` and later).

## Security disposition

The five high findings are treated as a development-toolchain audit issue, not as five known vulnerabilities in the deployed runtime. The runtime dependency audits are clean. Do not downgrade the test runner solely to silence npm's suggested fix: preserve the current test toolchain unless a fresh advisory confirms a vulnerability affecting the installed versions and a compatible patched release is identified.

The npm audit snapshot must be refreshed on the next CI run because advisory databases can change. In particular, verify whether the picomatch advisory is still active before considering overrides or dependency changes. Do not introduce an override for an advisory that has been withdrawn.

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
- A clean production audit does not replace manual review of the development environment or CI runner exposure.

## Release gate

Production dependency trees must have zero high or critical advisories. Development-only findings require a current advisory review, a documented exposure assessment and a compatible remediation plan. Do not claim the entire repository audit is clean while high findings remain.
