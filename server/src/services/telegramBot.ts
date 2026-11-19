import { timingSafeEqual } from 'node:crypto';

export type TelegramCommand = 'start' | 'help' | 'app' | 'unknown';

export function parseTelegramCommand(text: unknown): TelegramCommand | null {
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\s+/, 1)[0];
  if (!first.startsWith('/')) return null;
  const command = first.slice(1).split('@', 1)[0].toLowerCase();
  if (command === 'start' || command === 'help' || command === 'app') return command;
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
      text: 'Команды nummioX:\n/start — начать работу\n/app — открыть приложение\n/help — помощь\n\nФинансовые команды и уведомления появятся следующим этапом. Сейчас бот не изменяет ваши доходы и расходы.',
    };
  }
  return { text: 'Не понял команду. Используйте /start, /app или /help.' };
}
