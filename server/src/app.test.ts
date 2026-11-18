import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

test('trusts exactly one Render reverse proxy for client IP and rate limiting', () => {
  const app = createApp();
  assert.equal(app.get('trust proxy'), 1);
});
