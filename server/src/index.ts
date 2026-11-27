import 'dotenv/config';
import { createApp } from './app.js';
import { prisma } from './services/prisma.js';
import { registerTelegramWebhook, isSecureTelegramWebhookUrl } from './services/telegramBot.js';

const app = createApp();
const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`nummioX API listening on port ${port}`);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL
    || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/telegram/webhook` : undefined);
  if (botToken && webhookSecret && isSecureTelegramWebhookUrl(webhookUrl)) {
    void registerTelegramWebhook(botToken, webhookUrl, webhookSecret)
      .then(() => console.log('Telegram webhook registered for the configured environment.'))
      .catch(error => console.error('Telegram webhook registration failed:', error instanceof Error ? error.message : 'Unknown error'));
  }
});
const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
