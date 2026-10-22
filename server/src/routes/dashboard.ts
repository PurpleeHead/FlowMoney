import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt, mapActualVndUsdtExchanges } from '../lib/money.js';

const router=Router();
router.use(auth);

type DashboardExchangeAggregate = {
  rubUsdtRub: number; rubUsdtUsdt: number;
  actualVndUsdtVnd: number; actualVndUsdtUsdt: number;
  planningUsdt: number; planningWeightedVnd: number;
  directRub: number; directVnd: number; indirectRub: number; indirectVnd: number;
  confirmedVnd: number; estimatedTargetVnd: number; estimatedUsdt: number;
  hasEstimatedTargetVnd: boolean; hasUnpricedUsdtTopUps: boolean;
};

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
      prisma.$queryRaw<DashboardExchangeAggregate[]>`
        SELECT
          COALESCE(SUM(CASE
            WHEN ("mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0)
              THEN "rubSpent"
            WHEN ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0)
              THEN "rubSpent" ELSE 0 END), 0)::float8 AS "rubUsdtRub",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_USDT_VND' AND "rubSpent" > 0 AND "usdtReceived" > 0
              THEN "usdtReceived"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "rubSpent" > 0 AND "targetReceived" > 0
              THEN "targetReceived" ELSE 0 END), 0)::float8 AS "rubUsdtUsdt",
          COALESCE(SUM("vndReceived") FILTER (WHERE "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0), 0)::float8 AS "actualVndUsdtVnd",
          COALESCE(SUM("usdtReceived") FILTER (WHERE "mode" = 'RUB_USDT_VND' AND "vndReceived" > 0 AND "usdtReceived" > 0), 0)::float8 AS "actualVndUsdtUsdt",
          COALESCE(SUM("usdtReceived") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
            AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL), 0)::float8 AS "planningUsdt",
          COALESCE(SUM("usdtReceived" * "planningVndPerUsdt") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
            AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL AND "planningVndPerUsdt" IS NOT NULL), 0)::float8 AS "planningWeightedVnd",
          COALESCE(SUM("rubSpent") FILTER (WHERE "rubSpent" > 0 AND (
            ("mode" = 'RUB_VND' AND "vndReceived" > 0) OR
            ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0)
          )), 0)::float8 AS "directRub",
          COALESCE(SUM(CASE
            WHEN "mode" = 'RUB_VND' AND "vndReceived" > 0 AND "rubSpent" > 0 THEN "vndReceived"
            WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
              AND "rubSpent" > 0 AND COALESCE("targetVndEquivalent", "targetReceived", "vndReceived") > 0
              THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
            ELSE 0 END), 0)::float8 AS "directVnd",
          COALESCE(SUM("rubSpent") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
            AND "rubSpent" > 0 AND "vndReceived" > 0), 0)::float8 AS "indirectRub",
          COALESCE(SUM("vndReceived") FILTER (WHERE "mode" <> 'RUB_VND'
            AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
            AND "rubSpent" > 0 AND "vndReceived" > 0), 0)::float8 AS "indirectVnd",
          COALESCE(SUM(CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND'
            THEN COALESCE("targetVndEquivalent", "targetReceived", "vndReceived")
            ELSE "vndReceived" END), 0)::float8 AS "confirmedVnd",
          COALESCE(SUM("targetVndEquivalent") FILTER (WHERE "mode" = 'RUB_TARGET'
            AND upper(trim(COALESCE("targetCurrency", ''))) <> 'VND' AND "targetVndEquivalent" IS NOT NULL), 0)::float8 AS "estimatedTargetVnd",
          COALESCE(SUM(CASE
            WHEN "mode" <> 'RUB_VND'
              AND NOT ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'VND')
              AND "vndReceived" IS NULL AND (
                ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
                  AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
                OR "usdtReceived" IS NOT NULL
              )
              THEN CASE WHEN "mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
                THEN "targetReceived" ELSE "usdtReceived" END
            ELSE 0 END), 0)::float8 AS "estimatedUsdt",
          COALESCE(bool_or("mode" = 'RUB_TARGET' AND NOT upper(trim("targetCurrency")) = 'VND'
            AND "targetVndEquivalent" IS NOT NULL), false) AS "hasEstimatedTargetVnd",
          COALESCE(bool_or(
            ("mode" = 'RUB_USDT_VND' AND "vndReceived" IS NULL AND "usdtReceived" IS NOT NULL)
            OR ("mode" = 'RUB_TARGET' AND upper(trim("targetCurrency")) = 'USDT'
              AND "targetReceived" IS NOT NULL AND "targetVndEquivalent" IS NULL)
          ), false) AS "hasUnpricedUsdtTopUps"
        FROM "Exchange"
        WHERE "userId" = ${req.user!.id}
      `,
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
    const aggregate=exchangeAggregateRows[0];
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
