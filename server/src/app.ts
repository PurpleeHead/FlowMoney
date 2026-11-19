import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import exchangeRoutes from './routes/exchanges.js';
import expenseRoutes from './routes/expenses.js';
import receiptRoutes from './routes/receipts.js';
import translateRoutes from './routes/translate.js';
import dashboardRoutes from './routes/dashboard.js';
import personalFinanceRoutes from './routes/personalFinance.js';
import householdRoutes from './routes/household.js';
import telegramRoutes from './routes/telegram.js';
import { errorHandler } from './middleware/errors.js';
import { prisma } from './services/prisma.js';

export function createApp() {
  const app = express();
  // Render terminates TLS and forwards one trusted proxy hop. This lets Express
  // and express-rate-limit use the real client IP instead of rejecting X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'", 'https://telegram.org', 'https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
    workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", 'https://cdn.jsdelivr.net'],
  } } }));
  const allowedOrigins = new Set([process.env.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://purpleehead.github.io'].filter((value): value is string => Boolean(value)));
  app.use(cors({ origin: (origin, callback) => { if (!origin || allowedOrigins.has(origin)) return callback(null, true); return callback(new Error('Origin not allowed by CORS')); } }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/password-reset/request', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/password-reset/confirm', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
  app.get('/api/health', async (_req, res) => {
    try {
      // Render uses this endpoint as its readiness probe. Check the actual
      // PostgreSQL adapter, not only whether the Express process is alive.
      await prisma.$queryRaw`SELECT 1`;
      return res.json({ status: 'ok', service: 'nummiox-api', database: 'ok' });
    } catch {
      return res.status(503).json({ status: 'error', service: 'nummiox-api', database: 'unavailable' });
    }
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/exchanges', exchangeRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/receipts', receiptRoutes);
  app.use('/api/translate', translateRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/personal-finance', personalFinanceRoutes);
  app.use('/api/household', householdRoutes);
  app.use('/api/telegram', telegramRoutes);

  const clientDist = resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));
  if (existsSync(clientDist)) app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.use('/api', (_req, res) => res.status(404).json({ message: 'API route not found.' }));
  app.get('*', (_req, res, next) => {
    const indexFile = resolve(clientDist, 'index.html');
    if (existsSync(indexFile)) return res.sendFile(indexFile);
    return next();
  });
  app.use((_req, res) => res.status(404).json({ message: 'Route not found.' }));
  app.use(errorHandler);
  return app;
}
