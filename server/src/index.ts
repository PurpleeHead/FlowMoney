import 'dotenv/config';
import { createApp } from './app.js';
import { prisma } from './services/prisma.js';

const app = createApp();
const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, '0.0.0.0', () => console.log(`FLOWMONEY listening on port ${port}`));
const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
