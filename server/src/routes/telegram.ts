import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../services/prisma.js';
import { buildTelegramFinanceReply, buildTelegramReply, isValidTelegramWebhookSecret, parseTelegramCommand } from '../services/telegramBot.js';

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

async function sendTelegramMessage(botToken: string, chatId: number, text: string, replyMarkup?: ReturnType<typeof buildTelegramReply>['replyMarkup']) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error('Telegram sendMessage returned an unsuccessful result');
}

function localDateString(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day');
}

function localMidnightUtc(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (name: string) => Number(parts.find(item => item.type === name)?.value ?? 0);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    const adjustment = target - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate);
}

async function loadFinanceSummary(telegramId: string, kind: 'balance' | 'month') {
  const account = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, timezone: true },
  });
  if (!account) return { error: 'not-linked' as const };

  const access = await prisma.householdAccess.findFirst({
    where: { userId: account.id, revokedAt: null },
    include: { household: { select: { ownerUserId: true } } },
  });
  if (!access) return { error: 'no-access' as const };

  const ownerId = access.household.ownerUserId;
  const timezone = account.timezone || 'Europe/Moscow';
  const now = new Date();
  const today = localDateString(now, timezone);
  const opening = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { openingBalance: true, openingBalanceDate: true },
  });
  if (!opening) return { error: 'no-access' as const };

  const openingDate = opening.openingBalanceDate.toISOString().slice(0, 10);
  const balanceStart = localMidnightUtc(openingDate, timezone);
  const todayStart = localMidnightUtc(today, timezone);
  const tomorrowDate = new Date(today + 'T00:00:00.000Z');
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);

  if (kind === 'balance') {
    const [income, expenses, adjustments] = await Promise.all([
      prisma.incomeEntry.aggregate({
        where: { userId: ownerId, status: 'RECEIVED', receivedAt: { gte: balanceStart, lte: now } },
        _sum: { actualAmount: true },
      }),
      prisma.ledgerExpense.aggregate({
        where: { userId: ownerId, date: { gte: new Date(openingDate + 'T00:00:00.000Z'), lte: new Date(today + 'T00:00:00.000Z') } },
        _sum: { amount: true },
      }),
      prisma.balanceAdjustment.aggregate({
        where: { userId: ownerId, date: { gte: new Date(openingDate + 'T00:00:00.000Z'), lte: new Date(today + 'T00:00:00.000Z') } },
        _sum: { amount: true },
      }),
    ]);
    const incomeTotal = Number(income._sum.actualAmount ?? 0);
    const expenseTotal = Number(expenses._sum.amount ?? 0);
    const adjustmentTotal = Number(adjustments._sum.amount ?? 0);
    const openingBalance = Number(opening.openingBalance);
    return {
      text: buildTelegramFinanceReply('balance', {
        balance: openingBalance + incomeTotal - expenseTotal + adjustmentTotal,
        openingBalance, income: incomeTotal, expenses: expenseTotal, adjustments: adjustmentTotal,
      }),
    };
  }

  const monthStartDate = today.slice(0, 7) + '-01';
  const [year, month] = today.slice(0, 7).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEndDate = today.slice(0, 7) + '-' + String(lastDay).padStart(2, '0');
  const monthStart = localMidnightUtc(monthStartDate, timezone);
  const nextMonthDate = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const nextMonth = localMidnightUtc(nextMonthDate, timezone);
  const [income, expenses] = await Promise.all([
    prisma.incomeEntry.aggregate({
      where: { userId: ownerId, status: 'RECEIVED', receivedAt: { gte: monthStart, lt: nextMonth } },
      _sum: { actualAmount: true },
    }),
    prisma.ledgerExpense.aggregate({
      where: { userId: ownerId, date: { gte: new Date(monthStartDate + 'T00:00:00.000Z'), lte: new Date(monthEndDate + 'T00:00:00.000Z') } },
      _sum: { amount: true },
    }),
  ]);
  return {
    text: buildTelegramFinanceReply('month', {
      balance: 0, openingBalance: 0,
      income: Number(income._sum.actualAmount ?? 0),
      expenses: Number(expenses._sum.amount ?? 0),
      periodLabel: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: timezone }).format(now),
    }),
  };
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
    await prisma.telegramBotUpdate.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
    try {
      await prisma.telegramBotUpdate.create({ data: { updateId } });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      throw error;
    }

    try {
      if (command === 'balance' || command === 'month') {
        const telegramUserId = String(chatId);
        const summary = await loadFinanceSummary(telegramUserId, command);
        const text = 'error' in summary
          ? summary.error === 'not-linked'
            ? 'Чтобы просматривать финансы, сначала привяжите Telegram в настройках nummioX. После привязки повторите команду.'
            : 'У вашего аккаунта сейчас нет активного доступа к семейному пространству. Обратитесь к владельцу семьи.'
          : summary.text;
        await sendTelegramMessage(botToken, chatId as number, text);
      } else {
        await sendTelegramMessage(botToken, chatId as number, reply.text, reply.replyMarkup);
      }
    } catch (error) {
      await prisma.telegramBotUpdate.deleteMany({ where: { updateId } });
      throw error;
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
