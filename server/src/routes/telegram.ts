import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../services/prisma.js';
import { buildTelegramReply, isValidTelegramWebhookSecret, parseTelegramCommand } from '../services/telegramBot.js';

const router = Router();
const webhookLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

type TelegramMessage = {
  text?: unknown;
  chat?: { id?: unknown; type?: unknown };
};
type TelegramUpdate = {
  update_id?: unknown;
  message?: TelegramMessage;
};

async function sendTelegramMessage(botToken: string, chatId: number, reply: ReturnType<typeof buildTelegramReply>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: reply.text,
      ...(reply.replyMarkup ? { reply_markup: reply.replyMarkup } : {}),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error('Telegram sendMessage returned an unsuccessful result');
}

router.post('/webhook', webhookLimit, async (req, res, next) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = req.header('x-telegram-bot-api-secret-token');
  if (!isValidTelegramWebhookSecret(receivedSecret, expectedSecret)) {
    return res.status(401).json({ message: 'Unauthorized webhook request.' });
  }
  if (!botToken) return res.status(503).json({ message: 'Telegram bot is not configured.' });

  const update = req.body as TelegramUpdate;
  if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) {
    return res.status(400).json({ message: 'Invalid Telegram update.' });
  }

  const message = update.message;
  const chatId = message?.chat?.id;
  const command = parseTelegramCommand(message?.text);
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || !command) {
    return res.status(200).json({ ok: true });
  }

  const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || process.env.CLIENT_ORIGIN;
  const reply = buildTelegramReply(command, miniAppUrl);
  const updateId = BigInt(update.update_id as number);
  try {
    // Telegram retries webhook deliveries. A unique update ID makes command handling
    // idempotent across restarts and concurrent requests, not merely within one process.
    await prisma.$executeRaw`DELETE FROM "TelegramBotUpdate" WHERE "receivedAt" < NOW() - INTERVAL '30 days'`;
    const claimed = await prisma.$executeRaw`INSERT INTO "TelegramBotUpdate" ("updateId") VALUES (${updateId}) ON CONFLICT ("updateId") DO NOTHING`;
    if (claimed === 0) return res.status(200).json({ ok: true, duplicate: true });

    try {
      await sendTelegramMessage(botToken, chatId as number, reply);
    } catch (error) {
      await prisma.$executeRaw`DELETE FROM "TelegramBotUpdate" WHERE "updateId" = ${updateId}`;
      throw error;
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
