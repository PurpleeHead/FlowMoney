import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionSecurityConfiguration } from './security.js';

describe('production security configuration', () => {
  it('allows non-production environments without a configured JWT secret', () => {
    assert.doesNotThrow(() => assertProductionSecurityConfiguration({ NODE_ENV: 'development' }));
  });

  it('rejects a missing production JWT secret', () => {
    assert.throws(
      () => assertProductionSecurityConfiguration({ NODE_ENV: 'production' }),
      /JWT_SECRET must contain at least 32/,
    );
  });

  it('rejects a short production JWT secret', () => {
    assert.throws(
      () => assertProductionSecurityConfiguration({ NODE_ENV: 'production', JWT_SECRET: 'too-short' }),
      /JWT_SECRET must contain at least 32/,
    );
  });

  it('rejects common placeholder values', () => {
    assert.throws(
      () => assertProductionSecurityConfiguration({
        NODE_ENV: 'production',
        JWT_SECRET: 'change-me-change-me-change-me-1234',
      }),
      /must not use a placeholder/,
    );
  });

  it('accepts a sufficiently long production secret', () => {
    assert.doesNotThrow(() => assertProductionSecurityConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: 'a-realistic-random-secret-value-that-is-at-least-32-chars',
    }));
  });
});
