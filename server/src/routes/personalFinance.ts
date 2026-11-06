import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { auth } from '../middleware/auth.js';
import type { AuthedRequest } from '../types.js';
import { generateOccurrences, type Recurrence, type RecurrenceConfig } from '../services/personalFinance.js';

const router = Router();
router.use(auth);

const dateSchema = z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).refine(value => { const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }, 'Invalid calendar date.');
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

function dateValue(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}
function monthEnd(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}
function userId(req: AuthedRequest): string {
  return req.user!.id;
}
async function memberBelongsToUser(memberId: string | null | undefined, user: string) {
  if (!memberId) return true;
  return Boolean(await prisma.householdMember.findFirst({ where: { id: memberId, userId: user, isArchived: false }, select: { id: true } }));
}
function badMember(res: Response) {
  res.status(400).json({ message: 'Selected household member was not found.' });
}

router.get('/members', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await prisma.householdMember.findMany({ where: { userId: userId(req) }, orderBy: { createdAt: 'asc' } }));
  } catch (error) { next(error); }
});
router.post('/members', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60), color: z.string().max(24).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a household member name.' });
    const member = await prisma.householdMember.create({ data: { ...parsed.data, userId: userId(req) } });
    return res.status(201).json(member);
  } catch (error) { next(error); }
});
router.patch('/members/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60).optional(), color: z.string().max(24).nullable().optional(), isArchived: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid member update.' });
    const result = await prisma.householdMember.updateMany({ where: { id: req.params.id, userId: userId(req) }, data: parsed.data });
    if (!result.count) return res.status(404).json({ message: 'Household member not found.' });
    return res.json(await prisma.householdMember.findFirst({ where: { id: req.params.id, userId: userId(req) } }));
  } catch (error) { next(error); }
});

const incomeSourceSchema = z.object({
  title: z.string().trim().min(1).max(120), amount: money, recurrence,
  recurrenceConfig: configSchema, startDate: dateSchema, endDate: dateSchema.nullable().optional(),
  memberId: optionalMember, note: z.string().max(500).nullable().optional(),
});
async function materializeIncome(source: { id: string; userId: string; memberId: string | null; amount: unknown; recurrence: string; recurrenceConfig: unknown; startDate: Date; endDate: Date | null }, from: Date, to: Date) {
  const end = source.endDate && source.endDate < to ? source.endDate : to;
  if (end < from) return;
  const dates = generateOccurrences(source.recurrence as Recurrence, (source.recurrenceConfig ?? {}) as RecurrenceConfig, from, end, source.startDate);
  if (!dates.length) return;
  await prisma.incomeEntry.createMany({
    data: dates.map(plannedDate => ({ userId: source.userId, sourceId: source.id, memberId: source.memberId, plannedDate, plannedAmount: Number(source.amount), status: 'PLANNED' })),
    skipDuplicates: true,
  });
}
router.get('/income-sources', async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const from = dateValue(typeof req.query.from === 'string' && dateSchema.safeParse(req.query.from).success ? req.query.from : dateString(monthStart(now)));
    const to = dateValue(typeof req.query.to === 'string' && dateSchema.safeParse(req.query.to).success ? req.query.to : dateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0))));
    const sources = await prisma.incomeSource.findMany({ where: { userId: userId(req), isActive: true } });
    for (const source of sources) await materializeIncome(source, from, to);
    const entries = await prisma.incomeEntry.findMany({ where: { userId: userId(req), plannedDate: { gte: from, lte: to } }, include: { source: true, member: true }, orderBy: { plannedDate: 'asc' } });
    return res.json({ sources, entries });
  } catch (error) { next(error); }
});
router.post('/income-sources', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = incomeSourceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the income name, amount, recurrence and dates.', issues: parsed.error.flatten() });
    const input = parsed.data, uid = userId(req);
    if (input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    if (!(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const source = await prisma.incomeSource.create({ data: { ...input, userId: uid, startDate: dateValue(input.startDate), endDate: input.endDate ? dateValue(input.endDate) : null, recurrenceConfig: input.recurrenceConfig } });
    await materializeIncome(source, source.startDate, new Date(Date.UTC(source.startDate.getUTCFullYear(), source.startDate.getUTCMonth() + 3, 0)));
    return res.status(201).json(source);
  } catch (error) { next(error); }
});
router.patch('/income-sources/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = incomeSourceSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid income source update.' });
    const uid = userId(req), input = parsed.data;
    if (input.memberId !== undefined && !(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const data: Record<string, unknown> = { ...input };
    if (input.startDate) data.startDate = dateValue(input.startDate);
    if (input.endDate !== undefined) data.endDate = input.endDate ? dateValue(input.endDate) : null;
    const result = await prisma.incomeSource.updateMany({ where: { id: req.params.id, userId: uid }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Income source not found.' });
    return res.json(await prisma.incomeSource.findFirst({ where: { id: req.params.id, userId: uid } }));
  } catch (error) { next(error); }
});
router.delete('/income-sources/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.incomeSource.updateMany({ where: { id: req.params.id, userId: userId(req) }, data: { isActive: false } });
    if (!result.count) return res.status(404).json({ message: 'Income source not found.' });
    return res.status(204).end();
  } catch (error) { next(error); }
});
router.post('/income-entries', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ plannedDate: dateSchema, plannedAmount: money, memberId: optionalMember, note: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid income date and amount.' });
    const input = parsed.data, uid = userId(req);
    if (!(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const entry = await prisma.incomeEntry.create({ data: { userId: uid, ...input, plannedDate: dateValue(input.plannedDate), status: 'PLANNED' } });
    return res.status(201).json(entry);
  } catch (error) { next(error); }
});
router.patch('/income-entries/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ plannedDate: dateSchema.optional(), plannedAmount: money.optional(), memberId: optionalMember, note: z.string().max(500).nullable().optional(), status: z.enum(['PLANNED', 'SKIPPED']).optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid planned income update.' });
    const uid = userId(req), input = parsed.data;
    if (input.memberId !== undefined && !(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const data: Record<string, unknown> = { ...input };
    if (input.plannedDate) data.plannedDate = dateValue(input.plannedDate);
    const result = await prisma.incomeEntry.updateMany({ where: { id: req.params.id, userId: uid, status: { not: 'RECEIVED' } }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Editable planned income not found.' });
    return res.json(await prisma.incomeEntry.findFirst({ where: { id: req.params.id, userId: uid } }));
  } catch (error) { next(error); }
});
router.post('/income-entries/:id/receive', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ actualAmount: money.optional(), receivedAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid received amount.' });
    const uid = userId(req);
    const result = await prisma.$transaction(async tx => {
      const entry = await tx.incomeEntry.findFirst({ where: { id: req.params.id, userId: uid } });
      if (!entry) return null;
      if (entry.status === 'RECEIVED') return entry;
      return tx.incomeEntry.update({ where: { id: entry.id }, data: { status: 'RECEIVED', actualAmount: parsed.data.actualAmount ?? entry.plannedAmount, receivedAt: parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date() } });
    });
    if (!result) return res.status(404).json({ message: 'Income entry not found.' });
    return res.json(result);
  } catch (error) { next(error); }
});

const categorySchema = z.object({ name: z.string().trim().min(1).max(60), slug: z.string().trim().min(1).max(70).regex(/^[a-z0-9-]+$/) });
router.post('/categories', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a category name and a lowercase slug.' });
    const category = await prisma.expenseCategory.create({ data: { ...parsed.data, userId: userId(req) } });
    return res.status(201).json(category);
  } catch (error) { next(error); }
});
router.patch('/categories/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(60).optional(), isArchived: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid category update.' });
    const result = await prisma.expenseCategory.updateMany({ where: { id: req.params.id, userId: userId(req) }, data: parsed.data });
    if (!result.count) return res.status(404).json({ message: 'Custom category not found.' });
    return res.json(await prisma.expenseCategory.findFirst({ where: { id: req.params.id, userId: userId(req) } }));
  } catch (error) { next(error); }
});

const expenseSchema = z.object({
  title: z.string().trim().min(1).max(140), amount: money, date: dateSchema,
  categoryId: z.string().cuid().nullable().optional(), memberId: optionalMember,
  note: z.string().max(500).nullable().optional(),
});
router.get('/expenses', async (req: AuthedRequest, res, next) => {
  try {
    const uid = userId(req);
    const where = { userId: uid };
    const [expenses, categories] = await Promise.all([
      prisma.ledgerExpense.findMany({ where, include: { category: true, member: true, obligationOccurrence: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 }),
      prisma.expenseCategory.findMany({ where: { OR: [{ userId: uid }, { userId: null }] }, orderBy: [{ userId: 'asc' }, { name: 'asc' }] }),
    ]);
    return res.json({ expenses, categories });
  } catch (error) { next(error); }
});
router.post('/expenses', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the expense name, amount and date.', issues: parsed.error.flatten() });
    const input = parsed.data, uid = userId(req);
    if (!(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, OR: [{ userId: uid }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    const expense = await prisma.ledgerExpense.create({ data: { ...input, userId: uid, date: dateValue(input.date) }, include: { category: true, member: true } });
    return res.status(201).json(expense);
  } catch (error) { next(error); }
});
router.patch('/expenses/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = expenseSchema.partial().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid expense update.' });
    const uid = userId(req), input = parsed.data;
    if (input.memberId !== undefined && !(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    if (input.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: input.categoryId, OR: [{ userId: uid }, { userId: null }] } }))) return res.status(400).json({ message: 'Selected category was not found.' });
    const data: Record<string, unknown> = { ...input };
    if (input.date) data.date = dateValue(input.date);
    const result = await prisma.ledgerExpense.updateMany({ where: { id: req.params.id, userId: uid, obligationOccurrence: { is: null } }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Editable expense not found.' });
    return res.json(await prisma.ledgerExpense.findFirst({ where: { id: req.params.id, userId: uid }, include: { category: true, member: true } }));
  } catch (error) { next(error); }
});
router.delete('/expenses/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.ledgerExpense.deleteMany({ where: { id: req.params.id, userId: userId(req), obligationOccurrence: null } });
    if (!result.count) return res.status(404).json({ message: 'Editable expense not found.' });
    return res.status(204).end();
  } catch (error) { next(error); }
});

const obligationSchema = z.object({
  title: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), amount: money,
  recurrence, recurrenceConfig: configSchema, startDate: dateSchema, endDate: dateSchema.nullable().optional(),
  memberId: optionalMember, note: z.string().max(500).nullable().optional(),
});
async function materializeObligation(obligation: { id: string; userId: string; amount: unknown; recurrence: string; recurrenceConfig: unknown; startDate: Date; endDate: Date | null }, from: Date, to: Date) {
  const end = obligation.endDate && obligation.endDate < to ? obligation.endDate : to;
  if (end < from) return;
  const dates = generateOccurrences(obligation.recurrence as Recurrence, (obligation.recurrenceConfig ?? {}) as RecurrenceConfig, from, end, obligation.startDate);
  if (!dates.length) return;
  await prisma.obligationOccurrence.createMany({ data: dates.map(dueDate => ({ userId: obligation.userId, obligationId: obligation.id, dueDate, plannedAmount: Number(obligation.amount), status: dueDate < new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) ? 'OVERDUE' : 'UPCOMING' })), skipDuplicates: true });
}
router.get('/obligations', async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const from = dateValue(typeof req.query.from === 'string' && dateSchema.safeParse(req.query.from).success ? req.query.from : dateString(monthStart(now)));
    const to = dateValue(typeof req.query.to === 'string' && dateSchema.safeParse(req.query.to).success ? req.query.to : dateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0))));
    const uid = userId(req);
    const obligations = await prisma.obligation.findMany({ where: { userId: uid, isActive: true } });
    for (const obligation of obligations) await materializeObligation(obligation, from, to);
    const today = dateValue(dateString(new Date()));
    await prisma.obligationOccurrence.updateMany({ where: { userId: uid, status: 'UPCOMING', dueDate: { lt: today } }, data: { status: 'OVERDUE' } });
    const occurrences = await prisma.obligationOccurrence.findMany({ where: { userId: uid, dueDate: { gte: from, lte: to } }, include: { obligation: true, expense: true }, orderBy: { dueDate: 'asc' } });
    return res.json({ obligations, occurrences });
  } catch (error) { next(error); }
});
router.post('/obligations', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = obligationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Check the obligation title, amount, recurrence and dates.', issues: parsed.error.flatten() });
    const input = parsed.data, uid = userId(req);
    if (input.endDate && input.endDate < input.startDate) return res.status(400).json({ message: 'End date cannot be before start date.' });
    if (!(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const obligation = await prisma.obligation.create({ data: { ...input, userId: uid, startDate: dateValue(input.startDate), endDate: input.endDate ? dateValue(input.endDate) : null } });
    await materializeObligation(obligation, obligation.startDate, new Date(Date.UTC(obligation.startDate.getUTCFullYear(), obligation.startDate.getUTCMonth() + 4, 0)));
    return res.status(201).json(obligation);
  } catch (error) { next(error); }
});
router.patch('/obligations/:id', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = obligationSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return res.status(400).json({ message: 'Provide a valid obligation update.' });
    const uid = userId(req), input = parsed.data;
    if (input.memberId !== undefined && !(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    const data: Record<string, unknown> = { ...input };
    if (input.startDate) data.startDate = dateValue(input.startDate);
    if (input.endDate !== undefined) data.endDate = input.endDate ? dateValue(input.endDate) : null;
    const result = await prisma.obligation.updateMany({ where: { id: req.params.id, userId: uid }, data: data as never });
    if (!result.count) return res.status(404).json({ message: 'Obligation not found.' });
    return res.json(await prisma.obligation.findFirst({ where: { id: req.params.id, userId: uid } }));
  } catch (error) { next(error); }
});
router.delete('/obligations/:id', async (req: AuthedRequest, res, next) => {
  try {
    const result = await prisma.obligation.updateMany({ where: { id: req.params.id, userId: userId(req) }, data: { isActive: false } });
    if (!result.count) return res.status(404).json({ message: 'Obligation not found.' });
    return res.status(204).end();
  } catch (error) { next(error); }
});
router.post('/obligation-occurrences/:id/pay', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ actualAmount: money.optional(), paidAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid payment amount.' });
    const uid = userId(req);
    const paid = await prisma.$transaction(async tx => {
      const occurrence = await tx.obligationOccurrence.findFirst({ where: { id: req.params.id, userId: uid }, include: { obligation: true } });
      if (!occurrence) return null;
      if (occurrence.status === 'PAID' && occurrence.expenseId) return occurrence;
      const amount = parsed.data.actualAmount ?? Number(occurrence.plannedAmount);
      const expense = await tx.ledgerExpense.create({ data: { userId: uid, memberId: occurrence.obligation.memberId, title: occurrence.obligation.title, amount, date: dateValue(dateString(occurrence.dueDate)), note: 'Obligation payment' } });
      const claimed = await tx.obligationOccurrence.updateMany({ where: { id: occurrence.id, userId: uid, status: { in: ['UPCOMING', 'OVERDUE'] } }, data: { status: 'PAID', paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(), actualAmount: amount, expenseId: expense.id } });
      if (!claimed.count) {
        await tx.ledgerExpense.delete({ where: { id: expense.id } });
        return tx.obligationOccurrence.findFirst({ where: { id: occurrence.id, userId: uid }, include: { expense: true, obligation: true } });
      }
      return tx.obligationOccurrence.findFirst({ where: { id: occurrence.id, userId: uid }, include: { expense: true, obligation: true } });
    });
    if (!paid) return res.status(404).json({ message: 'Obligation occurrence not found.' });
    return res.json(paid);
  } catch (error) { next(error); }
});

router.get('/balance-adjustments', async (req: AuthedRequest, res, next) => {
  try {
    const records = await prisma.balanceAdjustment.findMany({ where: { userId: userId(req) }, include: { member: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
    return res.json(records);
  } catch (error) { next(error); }
});
router.post('/balance-adjustments', async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({ amount: z.number().finite().min(-1_000_000_000).max(1_000_000_000), date: dateSchema, reason: z.string().trim().min(1).max(160), memberId: optionalMember }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Enter a valid signed balance adjustment, date and reason.' });
    const input = parsed.data, uid = userId(req);
    if (!(await memberBelongsToUser(input.memberId, uid))) return badMember(res);
    return res.status(201).json(await prisma.balanceAdjustment.create({ data: { ...input, userId: uid, date: dateValue(input.date) } }));
  } catch (error) { next(error); }
});
router.get('/dashboard', async (req: AuthedRequest, res, next) => {
  try {
    const uid = userId(req), now = new Date();
    const from = dateValue(typeof req.query.from === 'string' && dateSchema.safeParse(req.query.from).success ? req.query.from : dateString(monthStart(now)));
    const to = dateValue(typeof req.query.to === 'string' && dateSchema.safeParse(req.query.to).success ? req.query.to : dateString(monthEnd(now)));
    const horizon = dateValue(typeof req.query.horizon === 'string' && dateSchema.safeParse(req.query.horizon).success ? req.query.horizon : dateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0))));
    const [activeSources, activeObligations] = await Promise.all([
      prisma.incomeSource.findMany({ where: { userId: uid, isActive: true } }),
      prisma.obligation.findMany({ where: { userId: uid, isActive: true } }),
    ]);
    for (const source of activeSources) await materializeIncome(source, from, horizon);
    for (const obligation of activeObligations) await materializeObligation(obligation, from, horizon);
    const inclusiveTo = new Date(to.getTime() + 86400000 - 1);
    const today = dateValue(dateString(now));
    await prisma.obligationOccurrence.updateMany({ where: { userId: uid, status: 'UPCOMING', dueDate: { lt: today } }, data: { status: 'OVERDUE' } });
    const [receivedAll, receivedPeriod, planned, plannedPeriod, balanceExpenses, periodExpenses, forecastObligations, adjustments, monthlyObligations] = await Promise.all([
      prisma.incomeEntry.aggregate({ where: { userId: uid, status: 'RECEIVED', receivedAt: { lte: inclusiveTo } }, _sum: { actualAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId: uid, status: 'RECEIVED', receivedAt: { gte: from, lte: inclusiveTo } }, _sum: { actualAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId: uid, status: 'PLANNED', plannedDate: { gte: from, lte: horizon } }, _sum: { plannedAmount: true } }),
      prisma.incomeEntry.aggregate({ where: { userId: uid, status: 'PLANNED', plannedDate: { gte: from, lte: to } }, _sum: { plannedAmount: true } }),
      prisma.ledgerExpense.aggregate({ where: { userId: uid, date: { lte: inclusiveTo } }, _sum: { amount: true } }),
      prisma.ledgerExpense.aggregate({ where: { userId: uid, date: { gte: from, lte: inclusiveTo } }, _sum: { amount: true } }),
      prisma.obligationOccurrence.aggregate({ where: { userId: uid, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { lte: horizon } }, _sum: { plannedAmount: true } }),
      prisma.balanceAdjustment.aggregate({ where: { userId: uid, date: { lte: inclusiveTo } }, _sum: { amount: true } }),
      prisma.obligationOccurrence.findMany({ where: { userId: uid, dueDate: { gte: from, lte: to } }, select: { plannedAmount: true, status: true } }),
    ]);
    const actualIncome = Number(receivedAll._sum.actualAmount ?? 0);
    const actualExpenses = Number(balanceExpenses._sum.amount ?? 0);
    const actualBalance = Number(adjustments._sum.amount ?? 0) + actualIncome - actualExpenses;
    const plannedIncome = Number(planned._sum.plannedAmount ?? 0);
    const plannedIncomeThisMonth = Number(plannedPeriod._sum.plannedAmount ?? 0);
    const unpaidObligations = Number(forecastObligations._sum.plannedAmount ?? 0);
    const dueTotal = monthlyObligations.reduce((sum, item) => sum + Number(item.plannedAmount), 0);
    const receivedMonthAmount = Number(receivedPeriod._sum.actualAmount ?? 0);
    const paidMonth = monthlyObligations.filter(x => x.status === 'PAID').reduce((sum, x) => sum + Number(x.plannedAmount), 0);
    const unpaidMonth = dueTotal - paidMonth;
    const nextPayments = await prisma.obligationOccurrence.findMany({ where: { userId: uid, status: { in: ['UPCOMING', 'OVERDUE'] }, dueDate: { gte: from, lte: horizon } }, include: { obligation: true }, orderBy: { dueDate: 'asc' }, take: 10 });
    return res.json({
      period: { from: dateString(from), to: dateString(to), horizon: dateString(horizon) },
      actual: { income: receivedMonthAmount, expenses: Number(periodExpenses._sum.amount ?? 0), balance: actualBalance },
      forecast: { plannedIncome, unpaidObligations, balance: actualBalance + plannedIncome - unpaidObligations },
      obligations: { due: dueTotal, paid: paidMonth, unpaid: unpaidMonth, coverage: { receivedIncome: receivedMonthAmount, shortfall: Math.max(0, dueTotal - receivedMonthAmount), surplus: Math.max(0, receivedMonthAmount - dueTotal) }, plannedCoverage: { income: receivedMonthAmount + plannedIncomeThisMonth, shortfall: Math.max(0, dueTotal - receivedMonthAmount - plannedIncomeThisMonth) } },
      nextPayments,
    });
  } catch (error) { next(error); }
});

export default router;
