import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { calculateObservedVndPerUsdt } from '../lib/money.js';

const router=Router();
router.use(auth);

router.get('/',async(req:AuthedRequest,res,next)=>{
  try {
    const now=new Date();
    const start=new Date(now.getFullYear(),now.getMonth(),1);
    // The chart only displays the last 12 calendar months; financial totals/rates below
    // are computed from unbounded database aggregates so history size cannot change them.
    const chartStart=new Date(now.getFullYear(),now.getMonth()-11,1);
    const normalizedTargetCurrency = (x: { targetCurrency: string | null }) =>
      x.targetCurrency?.trim().toUpperCase() ?? null;
    const isDirectVndTarget = (x: { mode: string; targetCurrency: string | null }) =>
      x.mode === 'RUB_TARGET' && normalizedTargetCurrency(x) === 'VND';
    // Dashboard rows are a bounded recent-activity window. All-history financial
    // summaries come from the user-scoped PostgreSQL aggregate below, never this page.
    const [expenses,exchanges,totalExpenseAggregate,monthExpenseAggregate,purchaseAggregate,totalExpenseCount,totalExchangeCount,exchangeSummaryRows]=await Promise.all([
      prisma.expense.findMany({
        where:{userId:req.user!.id,date:{gte:chartStart}},
        orderBy:{date:'desc'},
        select:{
          id:true,title:true,category:true,amount:true,currency:true,amountVnd:true,
          amountRub:true,usdtCharged:true,date:true,
        },
      }),
      prisma.exchange.findMany({
        where:{userId:req.user!.id},
        orderBy:{createdAt:'desc'},
        take:100,
        select:{
          id:true,mode:true,targetCurrency:true,targetReceived:true,targetToVndRate:true,
          targetVndEquivalent:true,rubSpent:true,usdtReceived:true,vndPerUsdt:true,
          planningVndPerUsdt:true,vndReceived:true,effectiveVndPerRub:true,
          effectiveRubPerUsdt:true,createdAt:true,
        },
      }),
      prisma.expense.aggregate({where:{userId:req.user!.id},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,date:{gte:start},},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,amountVnd:{gt:0},usdtCharged:{gt:0}},_sum:{amountVnd:true,usdtCharged:true}}),
      prisma.expense.count({where:{userId:req.user!.id}}),
      prisma.exchange.count({where:{userId:req.user!.id}}),
      prisma.$queryRaw<Array<{
        rubUsdtRub: unknown; rubUsdtUsdt: unknown;
        actualVndUsdtVnd: unknown; actualVndUsdtUsdt: unknown;
        confirmedExchangeVnd: unknown; estimatedTargetCurrencyVnd: unknown;
        plannedUsdt: unknown; plannedWeightedVnd: unknown; estimatedUnpricedUsdt: unknown;
        hasUnpricedUsdtTopUps: boolean | null;
        directRub: unknown; directVnd: unknown; actualRub: unknown; actualVnd: unknown;
      }>>`
        SELECT
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0 THEN "rubSpent"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0 THEN "rubSpent"
            ELSE 0 END), 0) AS "rubUsdtRub",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0 THEN "usdtReceived"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0 THEN "targetReceived"
            ELSE 0 END), 0) AS "rubUsdtUsdt",
          COALESCE(SUM(CASE WHEN "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0
            THEN "vndReceived" ELSE 0 END), 0) AS "actualVndUsdtVnd",
          COALESCE(SUM(CASE WHEN "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0
            THEN "usdtReceived" ELSE 0 END), 0) AS "actualVndUsdtUsdt",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND'
              THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
            ELSE "vndReceived" END), 0) AS "confirmedExchangeVnd",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) <> 'VND'
              THEN "targetVndEquivalent" ELSE 0 END), 0) AS "estimatedTargetCurrencyVnd",
          COALESCE(SUM(CASE
            WHEN "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
              AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL
              THEN "usdtReceived" ELSE 0 END), 0) AS "plannedUsdt",
          COALESCE(SUM(CASE
            WHEN "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
              AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL
              THEN "usdtReceived" * "planningVndPerUsdt" ELSE 0 END), 0) AS "plannedWeightedVnd",
          COALESCE(SUM(CASE
            WHEN "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
              AND "vndReceived" IS NULL
              AND (( "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
                    AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
                OR "usdtReceived" IS NOT NULL)
              THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
                        THEN COALESCE("targetReceived", 0) ELSE "usdtReceived" END
            ELSE 0 END), 0) AS "estimatedUnpricedUsdt",
          BOOL_OR(
            ("mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL)
            OR ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'USDT'
                AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
          ) AS "hasUnpricedUsdtTopUps",
          COALESCE(SUM(CASE
            WHEN "rubSpent" > 0 AND (
              ("mode" = 'RUB_VND' AND "vndReceived" > 0)
              OR ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND'
                  AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0))
            THEN "rubSpent" ELSE 0 END), 0) AS "directRub",
          COALESCE(SUM(CASE
            WHEN "rubSpent" > 0 AND (
              ("mode" = 'RUB_VND' AND "vndReceived" > 0)
              OR ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND'
                  AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0))
            THEN CASE WHEN "mode" = 'RUB_TARGET'
              THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
              ELSE "vndReceived" END ELSE 0 END), 0) AS "directVnd",
          COALESCE(SUM(CASE
            WHEN "rubSpent" > 0 AND "vndReceived" > 0 AND "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            THEN "rubSpent" ELSE 0 END), 0) AS "actualRub",
          COALESCE(SUM(CASE
            WHEN "rubSpent" > 0 AND "vndReceived" > 0 AND "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim(COALESCE("targetCurrency", ''))) = 'VND')
            THEN "vndReceived" ELSE 0 END), 0) AS "actualVnd"
        FROM "Exchange"
        WHERE "userId" = ${req.user!.id}
      `,
    ]);

    const totalVnd=Number(totalExpenseAggregate._sum.amountVnd ?? 0);
    const monthVnd=Number(monthExpenseAggregate._sum.amountVnd ?? 0);
    const observedVnd=Number(purchaseAggregate._sum.amountVnd ?? 0);
    const observedUsdt=Number(purchaseAggregate._sum.usdtCharged ?? 0);
    // Aggregate sums preserve weighted rates exactly: sum(VND) / sum(USDT), not
    // an average of individual rates. One synthetic observation carries those sums.
    const purchases = observedVnd > 0 && observedUsdt > 0
      ? [{amountVnd:observedVnd,usdtCharged:observedUsdt}]
      : [];
    const observedVndPerUsdt=calculateObservedVndPerUsdt(purchases);
    const exchangeSummary=exchangeSummaryRows[0];
    const effectiveRubPerUsdt=Number(exchangeSummary.rubUsdtUsdt) > 0
      ? Number(exchangeSummary.rubUsdtRub) / Number(exchangeSummary.rubUsdtUsdt)
      : null;
    const exchangeVnd=Number(exchangeSummary.actualVndUsdtVnd);
    const exchangeUsdt=Number(exchangeSummary.actualVndUsdtUsdt);
    // Prefer actual card-purchase observations. Otherwise use only exchanges with a recorded VND outcome.
    const effectiveVndPerUsdt=observedVndPerUsdt!=null
      ? observedVndPerUsdt
      : exchangeUsdt>0 ? exchangeVnd/exchangeUsdt : null;
    const plannedUsdt=Number(exchangeSummary.plannedUsdt);
    const planningVndPerUsdt=plannedUsdt>0
      ? Number(exchangeSummary.plannedWeightedVnd)/plannedUsdt
      : null;
    const balanceRateVndPerUsdt=effectiveVndPerUsdt??planningVndPerUsdt;
    let effectiveVndPerRubNumerator=Number(exchangeSummary.directVnd)+Number(exchangeSummary.actualVnd);
    let effectiveVndPerRubDenominator=Number(exchangeSummary.directRub)+Number(exchangeSummary.actualRub);
    if (effectiveRubPerUsdt != null && Number.isFinite(effectiveRubPerUsdt) && effectiveRubPerUsdt > 0) {
      effectiveVndPerRubNumerator += observedVnd;
      effectiveVndPerRubDenominator += observedUsdt * effectiveRubPerUsdt;
    }
    const effectiveVndPerRub=effectiveVndPerRubDenominator>0 && effectiveVndPerRubNumerator>0
      ? effectiveVndPerRubNumerator/effectiveVndPerRubDenominator
      : null;

    // A budget balance is a planning estimate: actual VND received is counted as-is;
    // USDT-only top-ups are converted using the observed VND/USDT rate when available.
    // Only actual VND outcomes are confirmed. A non-VND target's VND equivalent
    // is a valuation estimate based on a manually supplied conversion rate.
    const confirmedExchangeVnd=Number(exchangeSummary.confirmedExchangeVnd);
    const unpricedUsdtTopUps=exchangeSummary.hasUnpricedUsdtTopUps===true;
    const estimatedTargetCurrencyVnd=Number(exchangeSummary.estimatedTargetCurrencyVnd);
    const estimatedUnconvertedVnd=estimatedTargetCurrencyVnd +
      (balanceRateVndPerUsdt == null ? 0 : Number(exchangeSummary.estimatedUnpricedUsdt)*balanceRateVndPerUsdt);
    const balanceVnd = totalExchangeCount===0 || (unpricedUsdtTopUps && balanceRateVndPerUsdt == null)
      ? null
      : confirmedExchangeVnd + estimatedUnconvertedVnd - totalVnd;

    res.json({
      totalVnd,monthVnd,totalExpenseCount,totalExchangeCount,balanceVnd,confirmedExchangeVnd,estimatedUnconvertedVnd,planningVndPerUsdt,
      balanceIsEstimated: estimatedUnconvertedVnd > 0 || exchanges.some(x => x.mode === 'RUB_TARGET' && !isDirectVndTarget(x) && x.targetVndEquivalent != null),
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:x.amountVnd==null?null:Number(x.amountVnd),amountRub:x.amountRub==null?null:Number(x.amountRub),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:exchanges.slice(0,100).map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:x.usdtReceived==null?null:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),planningVndPerUsdt:x.planningVndPerUsdt==null?null:Number(x.planningVndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),targetReceived:x.targetReceived==null?null:Number(x.targetReceived),targetToVndRate:x.targetToVndRate==null?null:Number(x.targetToVndRate),targetVndEquivalent:x.targetVndEquivalent==null?null:Number(x.targetVndEquivalent),targetCurrency:x.targetCurrency,effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:x.effectiveRubPerUsdt==null?null:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
