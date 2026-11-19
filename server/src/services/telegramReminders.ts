import { prisma } from './prisma.js';

type ReminderUser = {
  id: string;
  telegramId: string | null;
  telegramReminderTime: string;
  timezone: string;
  locale: string;
  householdAccess: Array<{ household: { ownerUserId: string; owner: { timezone: string } } }>;
};

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
}

function dateValue(value: string) {
  return new Date(value + 'T00:00:00.000Z');
}

export function addCalendarDays(value: string, days: number) {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isReminderWindow(now: Date, timeZone: string, reminderTime: string) {
  const parts = localParts(now, timeZone);
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const [hour, minute] = reminderTime.split(':').map(Number);
  const elapsed = currentMinute - (hour * 60 + minute);
  return elapsed >= 0 && elapsed < 15;
}

function money(value: number, locale: string) {
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    style: 'currency', currency: 'RUB', maximumFractionDigits: 0,
  }).format(value);
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram reminder send failed with HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error('Telegram reminder send returned an unsuccessful result');
}

export async function runTelegramPaymentReminders(now = new Date()) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const users = await prisma.user.findMany({
    where: {
      telegramRemindersEnabled: true,
      telegramId: { not: null },
      householdAccess: { some: { revokedAt: null } },
    },
    select: {
      id: true, telegramId: true, telegramReminderTime: true, timezone: true, locale: true,
      householdAccess: {
        where: { revokedAt: null },
        select: { household: { select: { ownerUserId: true, owner: { select: { timezone: true } } } } },
        take: 1,
      },
    },
  }) as ReminderUser[];

  let checked = 0;
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    checked++;
    const access = user.householdAccess[0];
    if (!access || !user.telegramId || !isReminderWindow(now, user.timezone || 'Europe/Moscow', user.telegramReminderTime)) continue;

    const ledgerTimeZone = access.household.owner.timezone || 'Europe/Moscow';
    const localToday = localParts(now, ledgerTimeZone);
    const today = `${localToday.year}-${localToday.month}-${localToday.day}`;
    const dueDate = addCalendarDays(today, 1);
    const ownerId = access.household.ownerUserId;
    const occurrences = await prisma.obligationOccurrence.findMany({
      where: { userId: ownerId, dueDate: dateValue(dueDate), status: { in: ['UPCOMING', 'OVERDUE'] } },
      include: { obligation: { select: { title: true } } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: 30,
    });
    if (!occurrences.length) continue;

    const claimed: string[] = [];
    const claimedOccurrenceIds: string[] = [];
    for (const occurrence of occurrences) {
      try {
        const delivery = await prisma.telegramReminderDelivery.create({
          data: { userId: user.id, occurrenceId: occurrence.id, dueDate: dateValue(dueDate) },
          select: { id: true },
        });
        claimed.push(delivery.id);
        claimedOccurrenceIds.push(occurrence.id);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') continue;
        throw error;
      }
    }
    if (!claimed.length) continue;

    const occurrenceIds = new Set(claimedOccurrenceIds);
    const lines = [
      user.locale === 'en' ? '⏰ Payments due tomorrow' : '⏰ Завтра срок оплаты',
      '',
      ...occurrences.filter(item => occurrenceIds.has(item.id)).map(item =>
        `• ${item.obligation.title} — ${money(Number(item.plannedAmount), user.locale)}`,
      ),
      '',
      user.locale === 'en' ? 'Open nummioX to review your payment calendar.' : 'Откройте nummioX, чтобы посмотреть календарь платежей.',
    ];
    try {
      await sendTelegramMessage(botToken, user.telegramId, lines.join('\n'));
      sent++;
    } catch (error) {
      await prisma.telegramReminderDelivery.deleteMany({ where: { id: { in: claimed } } });
      failed++;
      console.error('Telegram payment reminder failed for an account:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  return { checked, sent, failed };
}
