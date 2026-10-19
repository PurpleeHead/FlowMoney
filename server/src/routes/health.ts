import { Router } from 'express';
import { prisma } from '../services/prisma.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'flowmoney-api' });
});

// Liveness is process-only; readiness verifies that the database is reachable.
router.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', service: 'flowmoney-api', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'not_ready', service: 'flowmoney-api' });
  }
});

export default router;
