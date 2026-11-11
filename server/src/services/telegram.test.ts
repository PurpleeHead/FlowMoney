import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData } from './telegram.js';

function signedInitData(botToken: string, authDate: number) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAE-test-query',
    user: JSON.stringify({ id: 123456789, first_name: 'Artem', username: 'artem' }),
  });
  const data = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}

test('accepts a valid Telegram Web App signature', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(verifyTelegramInitData(signedInitData('test-bot-token', now / 1000), 'test-bot-token', now),
    { id: '123456789', firstName: 'Artem', username: 'artem' });
});

test('rejects tampered Telegram Web App data', () => {
  const now = 1_800_000_000_000;
  assert.equal(verifyTelegramInitData(signedInitData('test-bot-token', now / 1000).replace('Artem', 'Mallory'), 'test-bot-token', now), null);
});

test('rejects expired Telegram Web App data', () => {
  const now = 1_800_000_000_000;
  assert.equal(verifyTelegramInitData(signedInitData('test-bot-token', now / 1000 - 86401), 'test-bot-token', now), null);
});
