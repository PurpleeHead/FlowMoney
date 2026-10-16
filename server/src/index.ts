import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import authRoutes from './routes/auth.js';
import exchangeRoutes from './routes/exchanges.js';
import expenseRoutes from './routes/expenses.js';
import receiptRoutes from './routes/receipts.js';
import translateRoutes from './routes/translate.js';
import dashboardRoutes from './routes/dashboard.js';
import { errorHandler } from './middleware/errors.js';
import { prisma } from './services/prisma.js';

const app = express();
// Render forwards requests through one trusted proxy hop.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      connectSrc: ["'self'", 'data:', 'https://tessdata.projectnaptha.com', 'https://cdn.jsdelivr.net'],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
      workerSrc: ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));
const allowedOrigins = new Set([process.env.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://purpleehead.github.io'].filter((value): value is string => Boolean(value)));
app.use(cors({ origin: (origin, callback) => { if (!origin || allowedOrigins.has(origin)) return callback(null, true); return callback(new Error('Origin not allowed by CORS')); } }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'flowmoney-api' }));
app.use('/api/auth', authRoutes);
app.use('/api/exchanges', exchangeRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/translate', translateRoutes);
app.use('/api/dashboard', dashboardRoutes);

// The server starts from the `server` workspace in production, but some local
// commands may start it from the repository root. Resolve the built client in
// either working directory so `/` serves the SPA instead of returning a 404.
const clientDistCandidates = [
  resolve(process.cwd(), 'client', 'dist'),
  resolve(process.cwd(), '..', 'client', 'dist'),
];
const clientDist = clientDistCandidates.find((candidate) =>
  existsSync(resolve(candidate, 'index.html')),
) ?? clientDistCandidates[0];
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
}
app.use('/api', (_req, res) => res.status(404).json({ message: 'API route not found.' }));
app.get('*', (_req, res, next) => {
  const indexFile = resolve(clientDist, 'index.html');
  if (existsSync(indexFile)) return res.sendFile(indexFile);
  return next();
});
app.use((_req, res) => res.status(404).json({ message: 'Route not found.' }));
app.use(errorHandler);

const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, '0.0.0.0', () => console.log(`FLOWMONEY listening on port ${port}`));
const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
