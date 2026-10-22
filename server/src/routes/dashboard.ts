import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { aggregateDashboardExchanges } from '../lib/dashboard-exchange-aggregate.js';
import { calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt, mapActualVndUsdtExchanges } from '../lib/money.js';

const router=Router();
router.use(auth);



router.get('/',async(req:AuthedRequest,res,next)=>{
  try {
    const now=new Date();
    const start=new Date(now.getFullYear(),now.getMonth(),1);
    const chartStart=new Date(now.getFullYear(),now.getMonth()-11,1);
    // Keep the complete exchange history in PostgreSQL. Only the visible history is
    // fetched as rows; all financial totals/rates are calculated by one tenant-scoped
    // aggregate query so older exchanges continue to affect every weighted rate.
    const [expenses,exchangeAggregateRows,totalExpenseAggregate,monthExpenseAggregate,purchaseAggregate,totalExpenseCount,totalExchangeCount,recentExchanges]=await Promise.all([
      prisma.expense.findMany({
        where:{userId:req.user!.id,date:{gte:chartStart}},
        orderBy:{date:'desc'},
        select:{id:true,title:true,category:true,amount:true,currency:true,amountVnd:true,amountRub:true,usdtCharged:true,date:true},
      }),
      aggregateDashboardExchanges(req.user!.id),
      prisma.expense.aggregate({where:{userId:req.user!.id},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,date:{gte:start}},_sum:{amountVnd:true}}),
      prisma.expense.aggregate({where:{userId:req.user!.id,amountVnd:{gt:0},usdtCharged:{gt:0}},_sum:{amountVnd:true,usdtCharged:true}}),
      prisma.expense.count({where:{userId:req.user!.id}}),
      prisma.exchange.count({where:{userId:req.user!.id}}),
      prisma.exchange.findMany({
        where:{userId:req.user!.id},orderBy:{createdAt:'desc'},take:100,
        select:{
          id:true,mode:true,targetCurrency:true,targetReceived:true,targetToVndRate:true,
          targetVndEquivalent:true,rubSpent:true,usdtReceived:true,vndPerUsdt:true,
          planningVndPerUsdt:true,vndReceived:true,effectiveVndPerRub:true,
          effectiveRubPerUsdt:true,createdAt:true,
        },
      }),
    ]);
    const aggregate=exchangeAggregateRows;
    const totalVnd=Number(totalExpenseAggregate._sum.amountVnd ?? 0);
    const monthVnd=Number(monthExpenseAggregate._sum.amountVnd ?? 0);
    const observedVnd=Number(purchaseAggregate._sum.amountVnd ?? 0);
    const observedUsdt=Number(purchaseAggregate._sum.usdtCharged ?? 0);
    const purchases=observedVnd>0&&observedUsdt>0?[{amountVnd:observedVnd,usdtCharged:observedUsdt}]:[];
    const observedVndPerUsdt=calculateObservedVndPerUsdt(purchases);
    const effectiveRubPerUsdt=calculateRubPerUsdt(
      Number(aggregate.rubUsdtUsdt)>0?[{rubSpent:Number(aggregate.rubUsdtRub),usdtReceived:Number(aggregate.rubUsdtUsdt)}]:[],
    );
    const exchangeVnd=Number(aggregate.actualVndUsdtVnd);
    const exchangeUsdt=Number(aggregate.actualVndUsdtUsdt);
    const effectiveVndPerUsdt=observedVndPerUsdt!=null?observedVndPerUsdt:exchangeUsdt>0?exchangeVnd/exchangeUsdt:null;
    const plannedUsdt=Number(aggregate.planningUsdt);
    const planningVndPerUsdt=plannedUsdt>0?Number(aggregate.planningWeightedVnd)/plannedUsdt:null;
    const balanceRateVndPerUsdt=effectiveVndPerUsdt??planningVndPerUsdt;
    const effectiveVndPerRub=calculateObservedVndPerRub({
      directExchanges:[{rubSpent:Number(aggregate.directRub),vndReceived:Number(aggregate.directVnd)}],
      actualVndExchanges:[{rubSpent:Number(aggregate.indirectRub),vndReceived:Number(aggregate.indirectVnd)}],
      cardPurchases:purchases.map(x=>({amountVnd:Number(x.amountVnd),usdtCharged:Number(x.usdtCharged)})),
      rubPerUsdt:effectiveRubPerUsdt,
    });
    const confirmedExchangeVnd=Number(aggregate.confirmedVnd);
    const estimatedTargetCurrencyVnd=Number(aggregate.estimatedTargetVnd);
    const estimatedUnconvertedVnd=estimatedTargetCurrencyVnd+(balanceRateVndPerUsdt==null?0:Number(aggregate.estimatedUsdt)*balanceRateVndPerUsdt);
    const balanceVnd=totalExchangeCount===0||(aggregate.hasUnpricedUsdtTopUps&&balanceRateVndPerUsdt==null)
      ?null:confirmedExchangeVnd+estimatedUnconvertedVnd-totalVnd;
    res.json({
      totalVnd,monthVnd,totalExpenseCount,totalExchangeCount,balanceVnd,confirmedExchangeVnd,estimatedUnconvertedVnd,planningVndPerUsdt,
      balanceIsEstimated:estimatedUnconvertedVnd>0||aggregate.hasEstimatedTargetVnd,
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:x.amountVnd==null?null:Number(x.amountVnd),amountRub:x.amountRub==null?null:Number(x.amountRub),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:recentExchanges.map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:x.usdtReceived==null?null:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),planningVndPerUsdt:x.planningVndPerUsdt==null?null:Number(x.planningVndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),targetReceived:x.targetReceived==null?null:Number(x.targetReceived),targetToVndRate:x.targetToVndRate==null?null:Number(x.targetToVndRate),targetVndEquivalent:x.targetVndEquivalent==null?null:Number(x.targetVndEquivalent),targetCurrency:x.targetCurrency,effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:x.effectiveRubPerUsdt==null?null:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
