import 'dotenv/config';
import { prisma } from '../services/prisma.js';
import { runTelegramPaymentReminders } from '../services/telegramReminders.js';

try {
  const result = await runTelegramPaymentReminders();
  console.log('Telegram payment reminder run completed:', JSON.stringify(result));
} catch (error) {
  console.error('Telegram payment reminder run failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
