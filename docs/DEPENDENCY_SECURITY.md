# Dependency security snapshot

Snapshot date: 2026-11-07  
Source: `npm audit --json` from the pull-request CI run. This is a dependency-tree snapshot, not a runtime penetration test.

## Summary

- Full repository audit: 12 advisories (4 moderate, 6 high, 2 critical). The critical findings are in the Vitest test-runner dependency tree (`vitest`, `tinypool`).
- Server workspace audit using `npm audit --workspace=@flowmoney/server --omit=dev`: 6 advisories (1 moderate, 5 high, 0 critical). Reported packages: `@prisma/config`, `body-parser`, `deepmerge-ts`, `prisma`, `qs` and `zod`.
- The server-workspace result still includes Prisma CLI/config packages marked `devOptional` in the lockfile; treat it as a workspace-scoped audit with dev dependencies omitted, not a definitive inventory of only deployed runtime files.
- The full-repository high advisories also include `vite`; moderate advisories include `@vitest/mocker`, `esbuild`, `qs` and `vite-node`.

## Supply-chain and authentication hardening

- The lockfile's 415 package tarball references were changed from the third-party `registry.npmmirror.com` mirror to the canonical `registry.npmjs.org` registry. Package versions and integrity hashes were retained in that edit; this is a registry-source normalization, not a substitute for an npm audit remediation.
- JWT middleware now explicitly accepts only HS256 session tokens and rejects missing, empty, or incorrectly typed identity claims.
- Added middleware tests for HS256 acceptance, HS384 rejection, malformed identity claims and missing bearer credentials.
- Expanded authenticated API integration coverage for concurrent obligation payment (one linked expense only), repeated income receipt (one actual ledger entry), and cross-household attempts to pay/receive or assign records.

These new tests must pass in CI before this branch is considered verified.

## Upgrade implications

The audit report indicated compatible fixes for `@prisma/config`, `prisma`, `body-parser`, `deepmerge-ts` and `qs`. The remaining reported fixes require major-version changes in the Vitest toolchain (to Vitest 5.1.0) or Zod (to 4.6.7).

No `npm audit fix --force` was run and no dependency major versions were changed as part of this feature. The CI audit step is informational and does not hide build or test failures.

## Safe local remediation helper

Run `UPDATE-DEPENDENCIES.ps1` from PowerShell after pulling this feature branch. It:
- requires Node.js 22+ and the expected feature branch;
- refuses to run with a dirty working tree;
- backs up the root lockfile outside the repository;
- runs `npm audit fix` without `--force`;
- retains the lockfile update only if the server/client build and tests pass;
- restores the original lockfile if verification fails.

The script does not commit changes, run migrations, or deploy. Review the resulting `package-lock.json` diff and the remaining audit counts before committing. Major upgrades to Vitest or Zod still require separate compatibility work if the compatible update cannot clear them.

## Recommended remediation sequence

1. Apply the compatible lockfile-only updates and rerun build, migration and tests.
2. Upgrade the Vitest/Vite toolchain in a separate reviewed change; verify all unit tests and CI.
3. Plan Zod 3-to-4 migration separately, review validation error behavior and route schemas, then rerun all tests.
4. Re-run `npm audit` and confirm the remaining advisory count is zero or explicitly accepted.

Do not merge or deploy solely on the basis of green build checks while critical dependency advisories remain unresolved.
