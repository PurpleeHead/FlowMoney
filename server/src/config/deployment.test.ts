import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const renderBlueprintPath = fileURLToPath(new URL('../../../render.yaml', import.meta.url));
const renderBlueprint = readFileSync(renderBlueprintPath, 'utf8');

describe('Render release blueprint safety gates', () => {
  it('keeps deploys manual until production gates are explicitly cleared', () => {
    assert.match(
      renderBlueprint,
      /^\s*autoDeployTrigger:\s*["']?off["']?\s*$/m,
      'Render auto-deploy must remain disabled until the production database and restore gates are approved',
    );
  });

  it('uses the database-aware readiness endpoint for deployment health checks', () => {
    assert.match(
      renderBlueprint,
      /^\s*healthCheckPath:\s*\/api\/ready\s*$/m,
      'Render readiness must fail when PostgreSQL is unavailable; /api/health only proves process liveness',
    );
  });

  it('requires explicit database configuration and generates a non-placeholder JWT secret', () => {
    assert.match(renderBlueprint, /-\s*key:\s*DATABASE_URL\s*\n\s*sync:\s*false/m);
    assert.match(renderBlueprint, /-\s*key:\s*JWT_SECRET\s*\n\s*generateValue:\s*true/m);
  });

  it('applies Prisma migrations before starting the application process', () => {
    assert.match(
      renderBlueprint,
      /^\s*startCommand:\s*npx prisma migrate deploy --schema server\/prisma\/schema\.prisma && npm start\s*$/m,
    );
  });
});
