# Dependency security snapshot

Snapshot date: 2026-11-06  
Source: `npm audit --json` from the pull-request CI run. This is a dependency-tree snapshot, not a runtime penetration test.

## Summary

- 12 advisories: 4 moderate, 6 high, 2 critical.
- The critical advisories are in the Vitest test-runner dependency tree (`vitest`, `tinypool`).
- The high advisories include `@prisma/config`, `prisma`, `body-parser`, `deepmerge-ts`, `vite` and `zod`.
- Moderate advisories include `@vitest/mocker`, `esbuild`, `qs` and `vite-node`.

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
