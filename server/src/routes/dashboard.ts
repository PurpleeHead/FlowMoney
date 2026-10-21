import {Router} from 'express';
import { Prisma } from '@prisma/client';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { calculateObservedVndPerUsdt } from '../lib/money.js';
import { getDashboardExchangeAggregates } from '../lib/dashboard-aggregates.js';

const router=Router();
router.use(auth);

router.get('/',async(req:AuthedRequest,res,next)=>{
  try {
    const now=new Date();
    const start=new Date(now.getFullYear(),now.getMonth(),1);
    // The chart only displays the last 12 calendar months; financial totals/rates below
    // are computed from unbounded database aggregates so history size cannot change them.
    const chartStart=new Date(now.getFullYear(),now.getMonth()-11,1);
    // Return only fields consumed by dashboard calculations and the client. This keeps
    // internal ownership/audit metadata out of the response and avoids fetching unused columns.
    const [expenses,exchanges,totalExpenseAggregate,monthExpenseAggregate,purchaseAggregate,exchangeAggregates]=await Promise.all([
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
        orderBy:[{createdAt:'desc'},{id:'desc'}],
        take:100,
        select:{
          id:true,mode:true,targetCurrency:true,targetReceived:true,targetToVndRate:true,
          targetVndEquivalent:true,rubSpent:true,usdtReceived:true,vndPerUsdt:true,
          planningVndPerUsdt:true,vndReceived:true,effectiveVndPerRub:true,
          effectiveRubPerUsdt:true,createdAt:true,
        },
      }),
      // PostgreSQL numeric NaN compares greater than ordinary numbers; exclude it
      // explicitly so corrupted legacy values cannot poison totals or weighted rates.
      prisma.expense.aggregate({where:{userId:req.user!.id,amountVnd:{not:new Prisma.Decimal('NaN')}},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,date:{gte:start},amountVnd:{not:new Prisma.Decimal('NaN')}},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,amountVnd:{gt:0,not:new Prisma.Decimal('NaN')},usdtCharged:{gt:0,not:new Prisma.Decimal('NaN')}},_sum:{amountVnd:true,usdtCharged:true}}),
      getDashboardExchangeAggregates(req.user!.id),
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
    // The aggregate query is scoped to VND expenses; stale conversion fields on other currencies are not purchase-rate evidence.
    const observedVndPerUsdt=calculateObservedVndPerUsdt(purchases);

    // Exchange-history financial totals are calculated by user-scoped PostgreSQL aggregates.
    // The separate exchange row query is only a bounded recent-activity payload; never use it
    // as the source of all-history balances or weighted rates.
    const effectiveRubPerUsdt = exchangeAggregates.rubUsdtUsdt > 0
      ? exchangeAggregates.rubUsdtRub / exchangeAggregates.rubUsdtUsdt
      : null;
    const exchangeVnd = exchangeAggregates.actualVnd;
    const exchangeUsdt = exchangeAggregates.actualUsdt;
    // Prefer actual card-purchase observations. Otherwise use only exchanges with a recorded actual VND outcome.
    const effectiveVndPerUsdt = observedVndPerUsdt != null
      ? observedVndPerUsdt
      : exchangeUsdt > 0 ? exchangeVnd / exchangeUsdt : null;
    const planningVndPerUsdt = exchangeAggregates.plannedUsdt > 0
      ? exchangeAggregates.plannedWeightedVnd / exchangeAggregates.plannedUsdt
      : null;
    const balanceRateVndPerUsdt = effectiveVndPerUsdt ?? planningVndPerUsdt;

    // Match calculateObservedVndPerRub: card purchases contribute to the RUB denominator
    // only when a valid historical RUB/USDT cost basis exists.
    const rateVndTotal = exchangeAggregates.rateExchangeVnd +
      (effectiveRubPerUsdt != null && effectiveRubPerUsdt > 0 ? observedVnd : 0);
    const rateRubTotal = exchangeAggregates.rateExchangeRub +
      (effectiveRubPerUsdt != null && effectiveRubPerUsdt > 0 ? observedUsdt * effectiveRubPerUsdt : 0);
    const effectiveVndPerRub = rateRubTotal > 0 && rateVndTotal > 0
      ? rateVndTotal / rateRubTotal
      : null;

    const confirmedExchangeVnd = exchangeAggregates.confirmedVnd;
    const unpricedUsdtTopUps = exchangeAggregates.hasUnpricedUsdtTopUp;
    const estimatedTargetCurrencyVnd = exchangeAggregates.estimatedTargetVnd;
    const estimatedUnconvertedVnd = estimatedTargetCurrencyVnd +
      (balanceRateVndPerUsdt == null ? 0 : exchangeAggregates.estimatedUsdt * balanceRateVndPerUsdt);
    // A known USDT amount may be estimated with an effective/planning rate.
    // If the acquired amount itself is malformed/unknown, no rate can recover the balance.
    const balanceVnd = exchangeAggregates.exchangeCount === 0 ||
      exchangeAggregates.hasUnknownTopUpAmount ||
      (unpricedUsdtTopUps && balanceRateVndPerUsdt == null)
      ? null
      : confirmedExchangeVnd + estimatedUnconvertedVnd - totalVnd;

    res.json({
      totalVnd,monthVnd,balanceVnd,confirmedExchangeVnd,estimatedUnconvertedVnd,planningVndPerUsdt,
      balanceIsEstimated: estimatedUnconvertedVnd > 0 || exchangeAggregates.hasEstimatedTarget,
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:x.amountVnd==null?null:Number(x.amountVnd),amountRub:x.amountRub==null?null:Number(x.amountRub),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:exchanges.map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:x.usdtReceived==null?null:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),planningVndPerUsdt:x.planningVndPerUsdt==null?null:Number(x.planningVndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),targetReceived:x.targetReceived==null?null:Number(x.targetReceived),targetToVndRate:x.targetToVndRate==null?null:Number(x.targetToVndRate),targetVndEquivalent:x.targetVndEquivalent==null?null:Number(x.targetVndEquivalent),targetCurrency:x.targetCurrency,effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:x.effectiveRubPerUsdt==null?null:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
