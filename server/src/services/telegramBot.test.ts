import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramFinanceReply, buildTelegramReply, formatTelegramMoney, isSecureTelegramWebhookUrl, isValidTelegramWebhookSecret, parseTelegramCommand } from './telegramBot.js';

test('parses supported Telegram commands and bot mentions', () => {
  assert.equal(parseTelegramCommand('/start'), 'start');
  assert.equal(parseTelegramCommand('/start@nummioX_bot payload'), 'start');
  assert.equal(parseTelegramCommand('/APP'), 'app');
  assert.equal(parseTelegramCommand('/help'), 'help');
  assert.equal(parseTelegramCommand('/balance'), 'balance');
  assert.equal(parseTelegramCommand('/month'), 'month');
  assert.equal(parseTelegramCommand('/other'), 'unknown');
  assert.equal(parseTelegramCommand('hello'), null);
  assert.equal(parseTelegramCommand(undefined), null);
});

test('validates webhook secrets with constant-time comparison and minimum length', () => {
  const secret = 'a'.repeat(40);
  assert.equal(isValidTelegramWebhookSecret(secret, secret), true);
  assert.equal(isValidTelegramWebhookSecret('b'.repeat(40), secret), false);
  assert.equal(isValidTelegramWebhookSecret(secret, 'short'), false);
  assert.equal(isValidTelegramWebhookSecret(undefined, secret), false);
});

test('only creates a Mini App button for HTTPS URLs', () => {
  const reply = buildTelegramReply('start', 'https://nummiox-staging.onrender.com');
  assert.equal(reply.replyMarkup?.inline_keyboard[0][0].web_app.url, 'https://nummiox-staging.onrender.com/');
  assert.equal(buildTelegramReply('start', 'http://localhost:5173').replyMarkup, undefined);
  assert.match(buildTelegramReply('help').text, /уведомления появятся следующим этапом/);
  assert.match(buildTelegramReply('unknown').text, /Не понял команду/);
});

test('formats finance summaries in Russian rubles', () => {
  const reply = buildTelegramFinanceReply('month', { balance: 0, openingBalance: 0, income: 85000, expenses: 42000, periodLabel: 'ноябрь 2026' });
  assert.match(reply, /Доходы/);
  assert.match(reply, /Разница/);
  assert.equal(formatTelegramMoney(1000), '1 000 ₽');
});

test('accepts only secure webhook URLs without credentials or query strings', () => {
  assert.equal(isSecureTelegramWebhookUrl('https://nummiox-staging.onrender.com/api/telegram/webhook'), true);
  assert.equal(isSecureTelegramWebhookUrl('http://localhost:3001/api/telegram/webhook'), false);
  assert.equal(isSecureTelegramWebhookUrl('https://user:pass@example.com/hook'), false);
  assert.equal(isSecureTelegramWebhookUrl('https://example.com/hook?token=secret'), false);
  assert.equal(isSecureTelegramWebhookUrl(undefined), false);
});
