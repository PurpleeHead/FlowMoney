import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { prisma } from '../services/prisma.js';
import { buildJournal, type JournalEntry } from '../lib/journal.js';

const router = Router();
router.use(auth);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  cursor: z.string().min(1).max(512).optional(),
});

type Cursor = { occurredAt: string; id: string; type: 'expense' | 'exchange' | 'wallet_movement' };
const cursorSchema = z.object({
  occurredAt: z.string().datetime(),
  id: z.string().min(1).max(256),
  type: z.enum(['expense', 'exchange', 'wallet_movement']),
});

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = cursorSchema.safeParse(JSON.parse(decoded));
    const expectedPrefix = parsed.success
      ? ({ expense: 'expense:', exchange: 'exchange:', wallet_movement: 'movement:' } as const)[parsed.data.type]
      : null;
    if (!parsed.success || !expectedPrefix || !parsed.data.id.startsWith(expectedPrefix)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function encodeCursor(entry: JournalEntry): string {
  return Buffer.from(JSON.stringify({
    occurredAt: entry.occurredAt,
    id: entry.id,
    type: entry.type,
  })).toString('base64url');
}

function sourceAfterCursor(
  cursor: Cursor | null,
  sourceType: Cursor['type'],
  timeField: 'date' | 'createdAt' | 'occurredAt',
) {
  if (!cursor) return {};
  const cursorTime = new Date(cursor.occurredAt);
  // Keep in sync with buildJournal's lexical ID tie-breaker and type prefixes.
  const priority: Record<Cursor['type'], number> = { expense: 0, exchange: 1, wallet_movement: 2 };
  const sourcePriority = priority[sourceType];
  const cursorPriority = priority[cursor.type];
  const id = cursor.id.slice(cursor.id.indexOf(':') + 1);
  const timeBefore = { [timeField]: { lt: cursorTime } };
  if (sourcePriority > cursorPriority) {
    return { OR: [timeBefore, { [timeField]: cursorTime }] };
  }
  if (sourcePriority < cursorPriority) return { OR: [timeBefore] };
  return { OR: [timeBefore, { [timeField]: cursorTime, id: { gt: id } }] };
}

router.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: 'Limit or cursor is invalid.' });
      return;
    }

    const userId = req.user!.id;
    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) {
      res.status(400).json({ message: 'Cursor is invalid.' });
      return;
    }

    // Apply cursor inside each user-scoped query so later pages remain bounded.
    const take = parsed.data.limit + 1;
    const [expenses, exchanges, movements] = await Promise.all([
      prisma.expense.findMany({
        where: { userId, ...sourceAfterCursor(cursor, 'expense', 'date') },
        orderBy: [{ date: 'desc' }, { id: 'asc' }],
        take,
        select: {
          id: true, title: true, category: true, amount: true, currency: true,
          amountVnd: true, amountRub: true, usdtCharged: true, date: true, createdAt: true,
        },
      }),
      prisma.exchange.findMany({
        where: { userId, ...sourceAfterCursor(cursor, 'exchange', 'createdAt') },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: {
          id: true, mode: true, rubSpent: true, usdtReceived: true, vndReceived: true,
          targetCurrency: true, targetReceived: true, targetVndEquivalent: true, createdAt: true,
        },
      }),
      prisma.walletMovement.findMany({
        where: { userId, ...sourceAfterCursor(cursor, 'wallet_movement', 'occurredAt') },
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        take,
        select: { id: true, currency: true, amountDelta: true, kind: true, note: true, occurredAt: true },
      }),
    ]);

    const entries = buildJournal(expenses, exchanges, parsed.data.limit + 1, movements);
    const hasMore = entries.length > parsed.data.limit;
    const page = entries.slice(0, parsed.data.limit);
    const lastEntry = page.at(-1);
    res.json({
      entries: page,
      limit: parsed.data.limit,
      hasMore,
      nextCursor: hasMore && lastEntry ? encodeCursor(lastEntry) : null,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
