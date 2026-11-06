import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { generateOccurrences, type Recurrence, type RecurrenceConfig } from '../services/personalFinance.js';

const router = Router();
router.use(auth);

const dateSchema = z.string()
  .regex(new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
  .refine(value => {
    const parsed = new Date(value + 'T00:00:00.000Z');
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date.');
const money = z.number().finite().positive().max(1_000_000_000);
const optionalMember = z.string().cuid().nullable().optional();
const recurrence = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'TWICE_MONTHLY', 'MONTHLY', 'YEARLY']);
const configSchema = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  intervalWeeks: z.number().int().min(1).max(52).optional(),
  firstDay: z.number().int().min(1).max(31).optional(),
  secondDay: z.number().int().min(1).max(31).optional(),
  day: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
}).default({});

function dateValue(value: string) { return new Date(value + 'T00:00:00.000Z'); }
function dateString(value: Date) { return value.toISOString().slice(0, 10); }
function monthStart(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)); }
function monthEnd(value: Date) { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)); }
function uid(req: AuthedRequest) { return req.user!.id; }
async function validMember(memberId: string | null | undefined, userId: string) {
  if (!memberId) return true;
  return Boolean(await prisma.householdMember.findFirst({ where: { id: memberId, userId, isArchived: false }, select: { id: true } }));
}
function memberError(res: Response) { return res.status(400).json({ message: 'Selected household member was not found.' }); }
function dateQuery(value: unknown, fallback: Date) {
  return typeof value === 'string' && dateSchema.safeParse(value).success ? dateValue(value) : fallback;
}
async function userDateAt(userId: string, value: Date): Promise<Date> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: user?.timezone ?? 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
  return dateValue(part('year') + '-' + part('month') + '-' + part('day'));
}
async function userToday(userId: string): Promise<Date> { return userDateAt(userId, new Date()); }

async function createIncomeOccurrences(source: {
  id: string; userId: string; memberId: string | null; amount: unknown; recurrence: string;
  recurrenceConfig: unknown; startDate: Date; endDate: Date | null;
}, from: Date, to: Date) {
  const end = source.endDate && source.endDate < to ? source.endDate : to;
  if (end < from) return;
  const dates = generateOccurrences(source.recurrence as Recurrence, (source.recurrenceConfig ?? {}) as RecurrenceConfig, from, end, source.startDate);
  if (!dates.length) return;
  await prisma.incomeEntry.createMany({
    data: dates.map(plannedDate => ({
      userId: source.userId, sourceId: source.id, memberId: source.memberId,
      plannedDate, plannedAmount: Number(source.amount), status: 'PLANNED',
    })),
    skipDuplicates: true,
  });
}
async function createObligationOccurrences(obligation: {
  id: string; userId: string; amount: unknown; recurrence: string;
  recurrenceConfig: unknown; startDate: Date; endDate: Date | null;
}, from: Date, to: Date, today: Date) {
  const end = obligation.endDate && obligation.endDate < to ? obligation.endDate : to;
  if (end < from) return;
  const dates = generateOccurrences(obligation.recurrence as Recurrence, (obligation.recurrenceConfig ?? {}) as RecurrenceConfig, from, end, obligation.startDate);
  if (!dates.length) return;
  await prisma.obligationOccurrence.createMany({
    data: dates.map(dueDate => ({
      userId: obligation.userId, obligationId: obligation.id, dueDate,
      plannedAmount: Number(obligation.amount), status: dueDate < today ? 'OVERDUE' : 'UPCOMING',
    })),
    skipDuplicates: true,
  });
}

router.get('/settings', async (req: AuthedRequest, res, next) => {
  try {
    const settings = await prisma.user.findUnique({ where: { id: uid(req) }, select: { timezone: true, locale: true, openingBalance: true, openingBalanceDate: true, openingBalanceConfigured: true } });
    if (!settings) return res.status(404).json({ message: 'User settings not found.' });
    return res.json(settings);
  } catch (error) { return next(error); }
});
router.patch('/settings', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ timezone: z.string().trim().min(1).max(80).optional(), locale: z.enum(['ru', 'en']).optional(), openingBalance: z.number().finite().min(-1_000_000_000).max(1_000_000_000).optional(), openingBalanceDate: dateSchema.optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid timezone or language.' });
    if (parsed.data.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }); }
      catch { return res.status(400).json({ message: 'Unknown IANA timezone.' }); }
    }
    if (parsed.data.openingBalanceDate && parsed.data.openingBalanceDate > dateString(await userToday(uid(req)))) return res.status(400).json({ message: 'Opening balance date cannot be in the future.' });
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.openingBalanceDate) data.openingBalanceDate = dateValue(parsed.data.openingBalanceDate);
    if (parsed.data.openingBalance !== undefined || parsed.data.openingBalanceDate !== undefined) data.openingBalanceConfigured = true;
    return res.json(await prisma.user.update({ where: { id: uid(req) }, data: data as never, select: { timezone: true, locale: true, openingBalance: true, openingBalanceDate: true, openingBalanceConfigured: true } }));
  } catch (error) { return next(error); }
});

router.get('/members', async (req: AuthedRequest, res, next) => {
  try { return res.json(await prisma.householdMember.findMany({ where: { userId: uid(req) }, orderBy: { createdAt: 'asc' } })); }
  catch (error) { return next(error); }
});
router.post('/members', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60), color: z.string().max(24).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a household member name.' });
    return res.status(201).json(await prisma.householdMember.create({ data: { ...parsed.data, userId: uid(req) } }));
  } catch (error) { return next(error); }
});
router.patch('/members/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60).optional(), color: z.string().max(24).nullable().optional(), isArchived: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid member update.' });
    const result = await prisma.householdMember.updateMany({ where: { id: String(req.params.id), userId: uid(req) }, data: parsed.data });
    if (!result.count) return res.status(404).json({ message: 'Household member not found.' });
    return res.json(await prisma.householdMember.findFirst({ where: { id: String(req.params.id), userId: uid(req) } }));
  } catch (error) { return next(error); }
});

const incomeSchema = z.object({
  title: z.string().trim().min(1).max(120), amount: money, recurrence,
  recurrenceConfig: configSchema, startDate: dateSchema, endDate: dateSchema.nullable().optional(),
  memberId: optionalMember, note: z.string().max(500).nullable().optional(),
});
router.get('/income-sources', async (req: AuthedRequest, res, next) => {
  try {
    const now = await userToday(uid(req)), from = dateQuery(req.query.from, monthStart(now));
    const to = dateQuery(req.query.to, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0)));
    const sources = await prisma.incomeSource.findMany({ where: { userId: uid(req), isActive: true } });
    for (const source of sources) await createIncomeOccurrences(source, from, to);
    const entries = await prisma.incomeEntry.findMany({
      where: { userId: uid(req), plannedDate: { gte: from, lte: to } },
      include: { source: true, member: true }, orderBy: { plannedDate: 'asc' },
    });
    return res.json({ sources, entries });
  } catch (error) { return next(error); }
});
router.post('/income-sources', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = incomeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the income name, amount, recurrence and dates.', issues: parsed.error.flatten() });
    const input = parsed.data, userId = uid(req);
    if (input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    const source = await prisma.incomeSource.create({
      data: {
        ...input, userId, startDate: dateValue(input.startDate),
        endDate: input.endDate ? dateValue(input.endDate) : null,
        recurrenceConfig: JSON.parse(JSON.stringify(input.recurrenceConfig)),
      },
    });
    await createIncomeOccurrences(source, source.startDate, new Date(Date.UTC(source.startDate.getUTCFullYear(), source.startDate.getUTCMonth() + 3, 0)));
    return res.status(201).json(source);
  } catch (error) { return next(error); }
});
router.patch('/income-sources/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = incomeSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid income source update.' });
    const input = parsed.data, userId = uid(req);
    if (input.memberId !== undefined && !(await validMember(input.memberId, userId))) return memberError(res);
    if (input.startDate && input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    const data: Record<string, unknown> = { ...input };
    if (input.startDate) data.startDate = dateValue(input.startDate);
    if (input.endDate !== undefined) data.endDate = input.endDate ? dateValue(input.endDate) : null;
    if (input.recurrenceConfig) data.recurrenceConfig = JSON.parse(JSON.stringify(input.recurrenceConfig));
    const result = await prisma.incomeSource.updateMany({ where: { id: String(req.params.id), userId }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Income source not found.' });
    return res.json(await prisma.incomeSource.findFirst({ where: { id: String(req.params.id), userId } }));
  } catch (error) { return next(error); }
});
router.delete('/income-sources/:id', async (req: AuthedRequest, res, next) => {
  try {
    const userId = uid(req);
    const today = await userToday(userId);
    const result = await prisma.incomeSource.updateMany({ where: { id: String(req.params.id), userId }, data: { isActive: false } });
    if (!result.count) return res.status(404).json({ message: 'Income source not found.' });
    await prisma.incomeEntry.updateMany({ where: { sourceId: String(req.params.id), userId, status: 'PLANNED', plannedDate: { gte: today } }, data: { status: 'SKIPPED' } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});
router.patch('/income-entries/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({
      plannedDate: dateSchema.optional(), plannedAmount: money.optional(), memberId: optionalMember,
      note: z.string().max(500).nullable().optional(), status: z.enum(['PLANNED', 'SKIPPED']).optional(),
    }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid planned income update.' });
    const input = parsed.data, userId = uid(req);
    if (input.memberId !== undefined && !(await validMember(input.memberId, userId))) return memberError(res);
    const data: Record<string, unknown> = { ...input };
    if (input.plannedDate) data.plannedDate = dateValue(input.plannedDate);
    const result = await prisma.incomeEntry.updateMany({ where: { id: String(req.params.id), userId, status: { not: 'RECEIVED' } }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Editable planned income not found.' });
    return res.json(await prisma.incomeEntry.findFirst({ where: { id: String(req.params.id), userId } }));
  } catch (error) { return next(error); }
});
router.post('/income-entries/:id/receive', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ actualAmount: money.optional(), receivedAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid received amount.' });
    const userId = uid(req);
    const entry = await prisma.$transaction(async tx => {
      const current = await tx.incomeEntry.findFirst({ where: { id: String(req.params.id), userId } });
      if (!current || current.status === 'RECEIVED') return current;
      return tx.incomeEntry.update({
        where: { id: current.id },
        data: { status: 'RECEIVED', actualAmount: parsed.data.actualAmount ?? current.plannedAmount, receivedAt: parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date() },
      });
    });
    if (!entry) return res.status(404).json({ message: 'Income entry not found.' });
    return res.json(entry);
  } catch (error) { return next(error); }
});
router.post('/income-entries', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ plannedDate: dateSchema, plannedAmount: money, memberId: optionalMember, note: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid income date and amount.' });
    const input = parsed.data, userId = uid(req);
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    return res.status(201).json(await prisma.incomeEntry.create({
      data: { userId, ...input, plannedDate: dateValue(input.plannedDate), status: 'PLANNED' },
    }));
  } catch (error) { return next(error); }
});

const expenseSchema = z.object({
  title: z.string().trim().min(1).max(140), amount: money, date: dateSchema,
  categoryId: z.string().cuid().nullable().optional(), memberId: optionalMember,
  note: z.string().max(500).nullable().optional(),
});
router.get('/expenses', async (req: AuthedRequest, res, next) => {
  try {
    const userId = uid(req);
    const [expenses, categories] = await Promise.all([
      prisma.ledgerExpense.findMany({
        where: { userId }, include: { category: true, member: true, obligationOccurrence: true },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000,
      }),
      prisma.expenseCategory.findMany({ where: { OR: [{ userId }, { userId: null }] }, orderBy: [{ userId: 'asc' }, { name: 'asc' }] }),
    ]);
    return res.json({ expenses, categories });
  } catch (error) { return next(error); }
});
const categorySchema = z.object({ name: z.string().trim().min(1).max(60), slug: z.string().trim().min(1).max(70).regex(new RegExp('^[a-z0-9-]+$')) });
router.post('/categories', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a category name and a lowercase slug.' });
    return res.status(201).json(await prisma.expenseCategory.create({ data: { ...parsed.data, userId: uid(req) } }));
  } catch (error) { return next(error); }
});
router.patch('/categories/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60).optional(), isArchived: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid category update.' });
    const result = await prisma.expenseCategory.updateMany({ where: { id: String(req.params.id), userId: uid(req) }, data: parsed.data });
    if (!result.count) return res.status(404).json({ message: 'Custom category not found.' });
    return res.json(await prisma.expenseCategory.findFirst({ where: { id: String(req.params.id), userId: uid(req) } }));
  } catch (error) { return next(error); }
});
router.post('/expenses', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the expense name, amount and date.', issues: parsed.error.flatten() });
    const input = parsed.data, userId = uid(req);
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isArchived: false, OR: [{ userId }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    return res.status(201).json(await prisma.ledgerExpense.create({
      data: { ...input, userId, date: dateValue(input.date) }, include: { category: true, member: true },
    }));
  } catch (error) { return next(error); }
});
router.patch('/expenses/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.partial().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid expense update.' });
    const input = parsed.data, userId = uid(req);
    if (input.memberId !== undefined && !(await validMember(input.memberId, userId))) return memberError(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isArchived: false, OR: [{ userId }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    const data: Record<string, unknown> = { ...input };
    if (input.date) data.date = dateValue(input.date);
    const result = await prisma.ledgerExpense.updateMany({ where: { id: String(req.params.id), userId, obligationOccurrence: { is: null } }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Editable expense not found.' });
    return res.json(await prisma.ledgerExpense.findFirst({ where: { id: String(req.params.id), userId }, include: { category: true, member: true } }));
  } catch (error) { return next(error); }
});
router.delete('/expenses/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.ledgerExpense.deleteMany({ where: { id: String(req.params.id), userId: uid(req), obligationOccurrence: { is: null } } });
    if (!result.count) return res.status(404).json({ message: 'Editable expense not found.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

const obligationSchema = z.object({
  title: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), amount: money,
  recurrence, recurrenceConfig: configSchema, startDate: dateSchema, endDate: dateSchema.nullable().optional(),
  memberId: optionalMember, note: z.string().max(500).nullable().optional(),
});
router.get('/obligations', async (req: AuthedRequest, res, next) => {
  try {
    const now = await userToday(uid(req)), from = dateQuery(req.query.from, monthStart(now));
    const to = dateQuery(req.query.to, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0)));
    const userId = uid(req);
    const obligations = await prisma.obligation.findMany({ where: { userId, isActive: true } });
    for (const obligation of obligations) await createObligationOccurrences(obligation, from, to, now);
    const today = now;
    await prisma.obligationOccurrence.updateMany({ where: { userId, status: 'UPCOMING', dueDate: { lt: today } }, data: { status: 'OVERDUE' } });
    const occurrences = await prisma.obligationOccurrence.findMany({
      where: { userId, status: { not: 'SKIPPED' }, dueDate: { gte: from, lte: to } }, include: { obligation: true, expense: true }, orderBy: { dueDate: 'asc' },
    });
    return res.json({ obligations, occurrences });
  } catch (error) { return next(error); }
});
router.post('/obligations', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = obligationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the obligation title, amount, recurrence and dates.', issues: parsed.error.flatten() });
    const input = parsed.data, userId = uid(req);
    if (input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    const obligation = await prisma.obligation.create({
      data: { ...input, userId, startDate: dateValue(input.startDate), endDate: input.endDate ? dateValue(input.endDate) : null, recurrenceConfig: JSON.parse(JSON.stringify(input.recurrenceConfig)) },
    });
    await createObligationOccurrences(obligation, obligation.startDate, new Date(Date.UTC(obligation.startDate.getUTCFullYear(), obligation.startDate.getUTCMonth() + 4, 0)), await userToday(userId));
    return res.status(201).json(obligation);
  } catch (error) { return next(error); }
});
router.patch('/obligations/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = obligationSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid obligation update.' });
    const input = parsed.data, userId = uid(req);
    if (input.memberId !== undefined && !(await validMember(input.memberId, userId))) return memberError(res);
    if (input.startDate && input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    const data: Record<string, unknown> = { ...input };
    if (input.startDate) data.startDate = dateValue(input.startDate);
    if (input.endDate !== undefined) data.endDate = input.endDate ? dateValue(input.endDate) : null;
    if (input.recurrenceConfig) data.recurrenceConfig = JSON.parse(JSON.stringify(input.recurrenceConfig));
    const result = await prisma.obligation.updateMany({ where: { id: String(req.params.id), userId }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Obligation not found.' });
    if (input.amount !== undefined) {
      await prisma.obligationOccurrence.updateMany({ where: { obligationId: String(req.params.id), userId, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { gte: await userToday(userId) } }, data: { plannedAmount: input.amount } });
    }
    return res.json(await prisma.obligation.findFirst({ where: { id: String(req.params.id), userId } }));
  } catch (error) { return next(error); }
});
router.delete('/obligations/:id', async (req: AuthedRequest, res, next) => {
  try {
    const userId = uid(req);
    const result = await prisma.obligation.updateMany({ where: { id: String(req.params.id), userId }, data: { isActive: false } });
    if (!result.count) return res.status(404).json({ message: 'Obligation not found.' });
    const today = await userToday(userId);
    await prisma.obligationOccurrence.updateMany({ where: { obligationId: String(req.params.id), userId, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { gte: today } }, data: { status: 'SKIPPED' } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});
router.post('/obligation-occurrences/:id/skip', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.obligationOccurrence.updateMany({
      where: { id: String(req.params.id), userId: uid(req), status: { in: ['UPCOMING', 'OVERDUE'] } },
      data: { status: 'SKIPPED' },
    });
    if (!result.count) return res.status(404).json({ message: 'Skippable obligation occurrence not found.' });
    return res.json(await prisma.obligationOccurrence.findFirst({ where: { id: String(req.params.id), userId: uid(req) } }));
  } catch (error) { return next(error); }
});
router.post('/obligation-occurrences/:id/pay', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ actualAmount: money.optional(), paidAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid payment amount.' });
    const userId = uid(req);
    const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date();
    const paidDate = await userDateAt(userId, paidAt);
    const paid = await prisma.$transaction(async tx => {
      const occurrence = await tx.obligationOccurrence.findFirst({ where: { id: String(req.params.id), userId } });
      if (!occurrence) return null;
      const obligation = await tx.obligation.findFirst({ where: { id: occurrence.obligationId, userId } });
      if (!obligation) return null;
      if (occurrence.status === 'PAID') return tx.obligationOccurrence.findFirst({ where: { id: occurrence.id }, include: { expense: true, obligation: true } });
      if (!['UPCOMING', 'OVERDUE'].includes(occurrence.status)) return null;
      const amount = parsed.data.actualAmount ?? Number(occurrence.plannedAmount);
      const expense = await tx.ledgerExpense.create({
        data: { userId, memberId: obligation.memberId, title: obligation.title, amount, date: paidDate, note: 'Obligation payment' },
      });
      const claimed = await tx.obligationOccurrence.updateMany({
        where: { id: occurrence.id, userId, status: { in: ['UPCOMING', 'OVERDUE'] } },
        data: { status: 'PAID', paidAt, actualAmount: amount, expenseId: expense.id },
      });
      if (!claimed.count) {
        await tx.ledgerExpense.delete({ where: { id: expense.id } });
        return tx.obligationOccurrence.findFirst({ where: { id: occurrence.id, userId }, include: { expense: true, obligation: true } });
      }
      return tx.obligationOccurrence.findFirst({ where: { id: occurrence.id, userId }, include: { expense: true, obligation: true } });
    });
    if (!paid) return res.status(404).json({ message: 'Payable obligation occurrence not found.' });
    return res.json(paid);
  } catch (error) { return next(error); }
});

router.get('/balance-adjustments', async (req: AuthedRequest, res, next) => {
  try {
    return res.json(await prisma.balanceAdjustment.findMany({
      where: { userId: uid(req) }, include: { member: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    }));
  } catch (error) { return next(error); }
});
router.post('/balance-adjustments', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({
      amount: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
      date: dateSchema, reason: z.string().trim().min(1).max(160), memberId: optionalMember,
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid signed balance adjustment, date and reason.' });
    const input = parsed.data, userId = uid(req);
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    return res.status(201).json(await prisma.balanceAdjustment.create({ data: { ...input, userId, date: dateValue(input.date) } }));
  } catch (error) { return next(error); }
});


const budgetSchema = z.object({
  periodMonth: dateSchema, limitAmount: money, memberId: optionalMember,
  categoryId: z.string().cuid().nullable().optional(),
});
router.get('/budgets', async (req: AuthedRequest, res, next) => {
  try {
    const today = await userToday(uid(req));
    const month = typeof req.query.month === 'string' && dateSchema.safeParse(req.query.month).success ? monthStart(dateValue(req.query.month)) : monthStart(today);
    return res.json(await prisma.budget.findMany({
      where: { userId: uid(req), periodMonth: month }, include: { category: true, member: true },
      orderBy: [{ memberId: 'asc' }, { categoryId: 'asc' }],
    }));
  } catch (error) { return next(error); }
});
router.post('/budgets', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid month and budget limit.' });
    const input = parsed.data, userId = uid(req), month = monthStart(dateValue(input.periodMonth));
    if (!(await validMember(input.memberId, userId))) return memberError(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isArchived: false, OR: [{ userId }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    const existing = await prisma.budget.findFirst({ where: { userId, periodMonth: month, memberId: input.memberId ?? null, categoryId: input.categoryId ?? null } });
    if (existing) return res.json(await prisma.budget.update({ where: { id: existing.id }, data: { limitAmount: input.limitAmount }, include: { category: true, member: true } }));
    return res.status(201).json(await prisma.budget.create({ data: { userId, periodMonth: month, limitAmount: input.limitAmount, memberId: input.memberId ?? null, categoryId: input.categoryId ?? null }, include: { category: true, member: true } }));
  } catch (error) { return next(error); }
});
router.patch('/budgets/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = budgetSchema.partial().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid budget update.' });
    const input = parsed.data, userId = uid(req);
    if (input.memberId !== undefined && !(await validMember(input.memberId, userId))) return memberError(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, isArchived: false, OR: [{ userId }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    const data: Record<string, unknown> = { ...input };
    if (input.periodMonth) data.periodMonth = monthStart(dateValue(input.periodMonth));
    const result = await prisma.budget.updateMany({ where: { id: String(req.params.id), userId }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Budget not found.' });
    return res.json(await prisma.budget.findFirst({ where: { id: String(req.params.id), userId }, include: { category: true, member: true } }));
  } catch (error) { return next(error); }
});
router.delete('/budgets/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.budget.deleteMany({ where: { id: String(req.params.id), userId: uid(req) } });
    if (!result.count) return res.status(404).json({ message: 'Budget not found.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

const goalSchema = z.object({
  title: z.string().trim().min(1).max(120), targetAmount: money,
  currentAmount: z.number().finite().min(0).max(1_000_000_000).optional(),
  targetDate: dateSchema.nullable().optional(), status: z.enum(['ACTIVE', 'COMPLETED', 'ARCHIVED']).optional(),
});
router.get('/savings-goals', async (req: AuthedRequest, res, next) => {
  try { return res.json(await prisma.savingsGoal.findMany({ where: { userId: uid(req) }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] })); }
  catch (error) { return next(error); }
});
router.post('/savings-goals', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = goalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a goal title and target amount.' });
    const input = parsed.data;
    return res.status(201).json(await prisma.savingsGoal.create({
      data: { ...input, userId: uid(req), targetDate: input.targetDate ? dateValue(input.targetDate) : null },
    }));
  } catch (error) { return next(error); }
});
router.patch('/savings-goals/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = goalSchema.partial().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid goal update.' });
    const input = parsed.data, data: Record<string, unknown> = { ...input };
    if (input.targetDate !== undefined) data.targetDate = input.targetDate ? dateValue(input.targetDate) : null;
    const result = await prisma.savingsGoal.updateMany({ where: { id: String(req.params.id), userId: uid(req) }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Savings goal not found.' });
    return res.json(await prisma.savingsGoal.findFirst({ where: { id: String(req.params.id), userId: uid(req) } }));
  } catch (error) { return next(error); }
});
router.delete('/savings-goals/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.savingsGoal.deleteMany({ where: { id: String(req.params.id), userId: uid(req) } });
    if (!result.count) return res.status(404).json({ message: 'Savings goal not found.' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

router.get('/analytics', async (req: AuthedRequest, res, next) => {
  try {
    const userId = uid(req), now = await userToday(uid(req));
    const from = dateQuery(req.query.from, monthStart(now));
    const to = dateQuery(req.query.to, monthEnd(now));
    const memberId = typeof req.query.memberId === 'string' ? req.query.memberId : '';
    if (memberId && memberId !== 'shared' && !(await validMember(memberId, userId))) return res.status(400).json({ message: 'Selected household member was not found.' });
    const memberWhere = memberId === 'shared' ? { memberId: null } : memberId ? { memberId } : {};
    const [expenses, incomes, obligations] = await Promise.all([
      prisma.ledgerExpense.findMany({ where: { userId, ...memberWhere, date: { gte: from, lte: to } }, include: { category: true, member: true } }),
      prisma.incomeEntry.findMany({ where: { userId, ...memberWhere, status: 'RECEIVED', receivedAt: { gte: from, lte: new Date(to.getTime() + 86400000 - 1) } }, include: { member: true } }),
      prisma.obligationOccurrence.findMany({ where: { userId, ...(memberId ? { obligation: { is: { memberId: memberId === 'shared' ? null : memberId } } } : {}), dueDate: { gte: from, lte: to }, status: { not: 'SKIPPED' } }, include: { obligation: true } }),
    ]);
    const categoryTotals = new Map<string, number>();
    const memberTotals = new Map<string, { income: number; expenses: number }>();
    const monthTotals = new Map<string, { income: number; expenses: number }>();
    for (const item of expenses) {
      const category = item.category?.name ?? 'Uncategorized';
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + Number(item.amount));
      const name = item.member?.name ?? 'Shared';
      const totals = memberTotals.get(name) ?? { income: 0, expenses: 0 };
      totals.expenses += Number(item.amount); memberTotals.set(name, totals);
      const month = dateString(item.date).slice(0, 7), monthTotal = monthTotals.get(month) ?? { income: 0, expenses: 0 };
      monthTotal.expenses += Number(item.amount); monthTotals.set(month, monthTotal);
    }
    for (const item of incomes) {
      const amount = Number(item.actualAmount ?? 0), name = item.member?.name ?? 'Shared';
      const totals = memberTotals.get(name) ?? { income: 0, expenses: 0 };
      totals.income += amount; memberTotals.set(name, totals);
      const month = dateString(item.receivedAt ?? item.plannedDate).slice(0, 7), monthTotal = monthTotals.get(month) ?? { income: 0, expenses: 0 };
      monthTotal.income += amount; monthTotals.set(month, monthTotal);
    }
    return res.json({
      totals: { income: incomes.reduce((sum, item) => sum + Number(item.actualAmount ?? 0), 0), expenses: expenses.reduce((sum, item) => sum + Number(item.amount), 0), obligations: obligations.reduce((sum, item) => sum + Number(item.plannedAmount), 0) },
      categories: [...categoryTotals].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      members: [...memberTotals].map(([name, totals]) => ({ name, ...totals, net: totals.income - totals.expenses })),
      months: [...monthTotals].sort((a, b) => a[0].localeCompare(b[0])).map(([month, totals]) => ({ month, ...totals, net: totals.income - totals.expenses })),
    });
  } catch (error) { return next(error); }
});

router.get('/dashboard', async (req: AuthedRequest, res, next) => {
  try {
    const userId = uid(req), now = await userToday(uid(req));
    const memberFilter = typeof req.query.memberId === 'string' ? req.query.memberId : '';
    if (memberFilter && memberFilter !== 'shared' && !(await validMember(memberFilter, userId))) return res.status(400).json({ message: 'Selected household member was not found.' });
    const memberWhere = memberFilter === 'shared' ? { memberId: null } : memberFilter ? { memberId: memberFilter } : {};
    const obligationMemberWhere = memberFilter ? { obligation: { is: { memberId: memberFilter === 'shared' ? null : memberFilter } } } : {};
    const from = dateQuery(req.query.from, monthStart(now));
    const to = dateQuery(req.query.to, monthEnd(now));
    const horizon = dateQuery(req.query.horizon, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0)));
    const openingSettings = await prisma.user.findUnique({ where: { id: userId }, select: { openingBalance: true, openingBalanceDate: true } });
    const openingDate = openingSettings?.openingBalanceDate ?? new Date(0);
    const [sources, obligations] = await Promise.all([
      prisma.incomeSource.findMany({ where: { userId, isActive: true, ...memberWhere } }),
      prisma.obligation.findMany({ where: { userId, isActive: true, ...(memberFilter ? { memberId: memberFilter === 'shared' ? null : memberFilter } : {}) } }),
    ]);
    for (const source of sources) await createIncomeOccurrences(source, from, horizon);
    for (const obligation of obligations) await createObligationOccurrences(obligation, from, horizon, now);
    const today = now;
    await prisma.obligationOccurrence.updateMany({ where: { userId, status: 'UPCOMING', dueDate: { lt: today } }, data: { status: 'OVERDUE' } });
    const inclusiveTo = new Date(to.getTime() + 86400000 - 1);
    // Actual cash is always measured as of now, independently of the selected reporting period.
    // Date-only ledger entries use the user's current calendar day; receivedAt is a timestamp.
    const balanceDateCutoff = new Date(now.getTime() + 86400000 - 1);
    const balanceTimestampCutoff = new Date();
    const [receivedAll, receivedPeriod, plannedHorizon, plannedPeriod, allExpenses, periodExpenses, forecastObligations, adjustments, monthOccurrences] = await Promise.all([
      prisma.incomeEntry.aggregate({ where: { userId, ...memberWhere, status: 'RECEIVED', receivedAt: { gte: openingDate, lte: balanceTimestampCutoff } }, _sum: { actualAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId, ...memberWhere, status: 'RECEIVED', receivedAt: { gte: from, lte: inclusiveTo } }, _sum: { actualAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId, ...memberWhere, status: 'PLANNED', plannedDate: { gte: from, lte: horizon } }, _sum: { plannedAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId, ...memberWhere, status: 'PLANNED', plannedDate: { gte: from, lte: to } }, _sum: { plannedAmount: true } }),
      prisma.ledgerExpense.aggregate({ where: { userId, ...memberWhere, date: { gte: openingDate, lte: balanceDateCutoff } }, _sum: { amount: true } }),
      prisma.ledgerExpense.aggregate({ where: { userId, ...memberWhere, date: { gte: from, lte: inclusiveTo } }, _sum: { amount: true } }),
      prisma.obligationOccurrence.aggregate({ where: { userId, ...obligationMemberWhere, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { lte: horizon } }, _sum: { plannedAmount: true } }),
      prisma.balanceAdjustment.aggregate({ where: { userId, ...memberWhere, date: { gte: openingDate, lte: balanceDateCutoff } }, _sum: { amount: true } }),
      prisma.obligationOccurrence.findMany({ where: { userId, ...obligationMemberWhere, status: { not: 'SKIPPED' }, dueDate: { gte: from, lte: to } }, select: { plannedAmount: true, status: true } }),
    ]);
    const actualIncome = Number(receivedAll._sum.actualAmount ?? 0);
    const actualExpenseTotal = Number(allExpenses._sum.amount ?? 0);
    const householdOpeningBalance = memberFilter ? 0 : Number(openingSettings?.openingBalance ?? 0);
    const actualBalance = householdOpeningBalance + Number(adjustments._sum.amount ?? 0) + actualIncome - actualExpenseTotal;
    const plannedIncome = Number(plannedHorizon._sum.plannedAmount ?? 0);
    const unpaidObligations = Number(forecastObligations._sum.plannedAmount ?? 0);
    const dueTotal = monthOccurrences.reduce((sum, item) => sum + Number(item.plannedAmount), 0);
    const receivedThisMonth = Number(receivedPeriod._sum.actualAmount ?? 0);
    const plannedThisMonth = Number(plannedPeriod._sum.plannedAmount ?? 0);
    const paidMonth = monthOccurrences.filter(item => item.status === 'PAID').reduce((sum, item) => sum + Number(item.plannedAmount), 0);
    const unpaidMonth = dueTotal - paidMonth;
    const nextPayments = await prisma.obligationOccurrence.findMany({
      where: { userId, ...obligationMemberWhere, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { gte: from, lte: horizon } },
      include: { obligation: true }, orderBy: { dueDate: 'asc' }, take: 10,
    });
    return res.json({
      period: { from: dateString(from), to: dateString(to), horizon: dateString(horizon) },
      actual: { income: receivedThisMonth, expenses: Number(periodExpenses._sum.amount ?? 0), balance: actualBalance },
      forecast: { plannedIncome, unpaidObligations, balance: actualBalance + plannedIncome - unpaidObligations },
      obligations: {
        due: dueTotal, paid: paidMonth, unpaid: unpaidMonth,
        coverage: { receivedIncome: receivedThisMonth, shortfall: Math.max(0, dueTotal - receivedThisMonth), surplus: Math.max(0, receivedThisMonth - dueTotal) },
        plannedCoverage: { income: receivedThisMonth + plannedThisMonth, shortfall: Math.max(0, dueTotal - receivedThisMonth - plannedThisMonth) },
      },
      nextPayments,
    });
  } catch (error) { return next(error); }
});

export default router;
