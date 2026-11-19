import { timingSafeEqual } from 'node:crypto';

export type TelegramCommand = 'start' | 'help' | 'app' | 'balance' | 'month' | 'unknown';

export function parseTelegramCommand(text: unknown): TelegramCommand | null {
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\\s+/, 1)[0];
  if (!first.startsWith('/')) return null;
  const command = first.slice(1).split('@', 1)[0].toLowerCase();
  if (command === 'start' || command === 'help' || command === 'app' || command === 'balance' || command === 'month') return command;
  return 'unknown';
}

export function isValidTelegramWebhookSecret(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected || expected.length < 32 || expected.length > 256) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(expected) || received.length !== expected.length) return false;
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function buildTelegramReply(command: TelegramCommand, miniAppUrl?: string): {
  text: string;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> };
} {
  const validAppUrl = (() => {
    if (!miniAppUrl) return undefined;
    try {
      const parsed = new URL(miniAppUrl);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : undefined;
    } catch { return undefined; }
  })();

  if (command === 'start' || command === 'app') {
    return {
      text: validAppUrl
        ? 'Добро пожаловать в nummioX! Откройте приложение кнопкой ниже. Ваши данные доступны только после входа в свой аккаунт.'
        : 'Добро пожаловать в nummioX! Приложение скоро будет доступно из этого чата. Пока откройте веб-версию по сохранённой ссылке.',
      ...(validAppUrl ? { replyMarkup: { inline_keyboard: [[{ text: 'Открыть nummioX', web_app: { url: validAppUrl } }]] } } : {}),
    };
  }
  if (command === 'help') {
    return {
      text: 'Команды nummioX:\\n/start — начать работу\\n/app — открыть приложение\\n/balance — текущий баланс семьи\\n/month — итоги текущего месяца\\n/help — помощь\\n\\nБот показывает только данные вашего привязанного аккаунта и не изменяет доходы или расходы.',
    };
  }
  if (command === 'balance') return { text: 'Сейчас подготовлю текущий баланс.' };
  if (command === 'month') return { text: 'Сейчас подготовлю итоги месяца.' };
  return { text: 'Не понял команду. Используйте /start, /app, /balance, /month или /help.' };
}

export function formatTelegramMoney(value: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value);
}

export function buildTelegramFinanceReply(kind: 'balance' | 'month', data: {
  balance: number;
  openingBalance: number;
  income: number;
  expenses: number;
  adjustments?: number;
  periodLabel?: string;
}): string {
  if (kind === 'balance') {
    return [
      '💰 Текущий баланс семьи',
      '',
      'Баланс: ' + formatTelegramMoney(data.balance),
      'Начальный баланс: ' + formatTelegramMoney(data.openingBalance),
      'Получено доходов: ' + formatTelegramMoney(data.income),
      'Расходы: ' + formatTelegramMoney(data.expenses),
      ...(data.adjustments ? ['Корректировки: ' + formatTelegramMoney(data.adjustments)] : []),
      '',
      'Данные обновлены на момент запроса.',
    ].join('\\n');
  }
  return [
    '📊 Итоги за ' + (data.periodLabel ?? 'текущий месяц'),
    '',
    'Доходы: ' + formatTelegramMoney(data.income),
    'Расходы: ' + formatTelegramMoney(data.expenses),
    'Разница: ' + formatTelegramMoney(data.income - data.expenses),
  ].join('\\n');
}

export function isSecureTelegramWebhookUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function registerTelegramWebhook(botToken: string, webhookUrl: string, secretToken: string): Promise<void> {
  if (!isSecureTelegramWebhookUrl(webhookUrl)) throw new Error('Telegram webhook URL must be a valid HTTPS URL');
  if (secretToken.length < 32 || secretToken.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secretToken)) {
    throw new Error('Telegram webhook secret must be 32–256 URL-safe characters');
  }
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: false }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram setWebhook failed with HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error('Telegram setWebhook returned an unsuccessful result');
}
