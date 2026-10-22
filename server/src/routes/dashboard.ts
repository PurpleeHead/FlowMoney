import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt, mapRubUsdtExchanges } from '../lib/money.js';

const router=Router();
router.use(auth);

router.get('/',async(req:AuthedRequest,res,next)=>{
  try {
    const now=new Date();
    const start=new Date(now.getFullYear(),now.getMonth(),1);
    const [expenses,exchanges]=await Promise.all([
      prisma.expense.findMany({where:{userId:req.user!.id},orderBy:{date:'desc'}}),
      prisma.exchange.findMany({where:{userId:req.user!.id},orderBy:{createdAt:'desc'}})
    ]);

    const totalVnd=expenses.reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const monthVnd=expenses.filter(x=>x.date>=start).reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const purchases=expenses.filter(x=>x.amountVnd!=null && x.usdtCharged!=null && Number(x.usdtCharged)>0);
    const observedVnd=purchases.reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const observedUsdt=purchases.reduce((sum,x)=>sum+Number(x.usdtCharged),0);
    const observedVndPerUsdt=calculateObservedVndPerUsdt(
      purchases.map(x=>({amountVnd:Number(x.amountVnd),usdtCharged:Number(x.usdtCharged)}))
    );

    // Weighted by USDT received, using the same RUB/USDT helper as expense saving.
    const effectiveRubPerUsdt=calculateRubPerUsdt(
      mapRubUsdtExchanges(exchanges.map(x => ({
        mode: x.mode,
        rubSpent: Number(x.rubSpent),
        usdtReceived: x.usdtReceived == null ? null : Number(x.usdtReceived),
        targetCurrency: x.targetCurrency,
        targetReceived: x.targetReceived == null ? null : Number(x.targetReceived),
      })))
    );
    const knownVndExchanges=exchanges.filter(x=>x.mode!=='RUB_VND'&&x.usdtReceived!=null&&x.vndReceived!=null);
    const exchangeVnd=knownVndExchanges.reduce((sum,x)=>sum+Number(x.vndReceived),0);
    const exchangeUsdt=knownVndExchanges.reduce((sum,x)=>sum+Number(x.usdtReceived),0);
    // Prefer actual card-purchase observations. Otherwise use only exchanges with a recorded VND outcome.
    const effectiveVndPerUsdt=observedVndPerUsdt!=null
      ? observedVndPerUsdt
      : exchangeUsdt>0 ? exchangeVnd/exchangeUsdt : null;
    const plannedExchanges=exchanges.filter(x=>x.mode!=='RUB_VND'&&x.vndReceived==null&&x.usdtReceived!=null&&x.planningVndPerUsdt!=null);
    const plannedUsdt=plannedExchanges.reduce((sum,x)=>sum+Number(x.usdtReceived),0);
    const planningVndPerUsdt=plannedUsdt>0
      ? plannedExchanges.reduce((sum,x)=>sum+Number(x.usdtReceived)*Number(x.planningVndPerUsdt),0)/plannedUsdt
      : null;
    const balanceRateVndPerUsdt=effectiveVndPerUsdt??planningVndPerUsdt;
    const effectiveVndPerRub = calculateObservedVndPerRub({
      directExchanges: [
        ...exchanges.filter(x => x.mode === 'RUB_VND' && x.vndReceived != null).map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
        ...exchanges.filter(x => x.mode === 'RUB_TARGET' && x.targetCurrency === 'VND' && x.targetVndEquivalent != null).map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.targetVndEquivalent) })),
      ],
      actualVndExchanges: exchanges
        .filter(x => x.mode !== 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
      cardPurchases: purchases.map(x => ({
        amountVnd: Number(x.amountVnd),
        usdtCharged: Number(x.usdtCharged),
      })),
      rubPerUsdt: effectiveRubPerUsdt,
    });

    // A budget balance is a planning estimate: actual VND received is counted as-is;
    // USDT-only top-ups are converted using the observed VND/USDT rate when available.
    // Only actual VND outcomes are confirmed. A non-VND target's VND equivalent
    // is a valuation estimate based on a manually supplied conversion rate.
    const confirmedExchangeVnd = exchanges.reduce((sum, x) =>
      sum + (x.vndReceived != null ? Number(x.vndReceived) : 0) +
      (x.targetCurrency === 'VND' && x.targetVndEquivalent != null ? Number(x.targetVndEquivalent) : 0), 0);
    const isUnpricedUsdtTopUp = (x: typeof exchanges[number]) =>
      (x.mode === 'RUB_USDT_VND' && x.vndReceived == null && x.usdtReceived != null) ||
      (x.mode === 'RUB_TARGET' && x.targetCurrency === 'USDT' && x.targetReceived != null && x.targetVndEquivalent == null);
    const unpricedUsdtTopUps = exchanges.some(isUnpricedUsdtTopUp);
    const estimatedTargetCurrencyVnd = exchanges.reduce((sum, x) =>
      sum + (x.mode === 'RUB_TARGET' && x.targetCurrency !== 'VND' && x.targetVndEquivalent != null
        ? Number(x.targetVndEquivalent) : 0), 0);
    const estimatedUnconvertedVnd = estimatedTargetCurrencyVnd + (balanceRateVndPerUsdt == null ? 0 : exchanges
      .filter(x => x.mode !== 'RUB_VND' && x.vndReceived == null &&
        ((x.mode === 'RUB_TARGET' && x.targetCurrency === 'USDT' && x.targetReceived != null && x.targetVndEquivalent == null) ||
         x.usdtReceived != null))
      .reduce((sum, x) => {
        const usdt = x.mode === 'RUB_TARGET' && x.targetCurrency === 'USDT'
          ? Number(x.targetReceived)
          : Number(x.usdtReceived);
        return sum + usdt * balanceRateVndPerUsdt;
      }, 0));
    const balanceVnd = exchanges.length===0 || (unpricedUsdtTopUps && balanceRateVndPerUsdt == null)
      ? null
      : confirmedExchangeVnd + estimatedUnconvertedVnd - totalVnd;

    res.json({
      totalVnd,monthVnd,balanceVnd,confirmedExchangeVnd,estimatedUnconvertedVnd,planningVndPerUsdt,
      balanceIsEstimated: estimatedUnconvertedVnd > 0 || exchanges.some(x => x.mode === 'RUB_TARGET' && x.targetCurrency !== 'VND' && x.targetVndEquivalent != null),
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:x.amountVnd==null?null:Number(x.amountVnd),amountRub:x.amountRub==null?null:Number(x.amountRub),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:exchanges.map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:x.usdtReceived==null?null:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),planningVndPerUsdt:x.planningVndPerUsdt==null?null:Number(x.planningVndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),targetReceived:x.targetReceived==null?null:Number(x.targetReceived),targetToVndRate:x.targetToVndRate==null?null:Number(x.targetToVndRate),targetVndEquivalent:x.targetVndEquivalent==null?null:Number(x.targetVndEquivalent),targetCurrency:x.targetCurrency,effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:x.effectiveRubPerUsdt==null?null:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
