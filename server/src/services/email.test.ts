import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePasswordResetBaseUrl } from './email.js';

test('requires an explicit safe password-reset base URL', () => {
  assert.equal(resolvePasswordResetBaseUrl(undefined, 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('not-a-url', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('javascript:alert(1)', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('http://nummiox.example.test', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('https://user:pass@nummiox.example.test', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('https://nummiox.example.test/app', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('https://nummiox.example.test/?next=/evil', 'production'), null);
  assert.equal(resolvePasswordResetBaseUrl('https://nummiox.example.test', 'production'), 'https://nummiox.example.test');
  assert.equal(resolvePasswordResetBaseUrl('http://localhost:5173', 'test'), 'http://localhost:5173');
});
