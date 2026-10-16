import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';
import { calculateObservedVndPerRub, calculateObservedVndPerUsdt, calculateRubPerUsdt } from '../lib/money.js';

const router=Router();
router.use(auth);

router.get('/',async(req:AuthedRequest,res,next)=>{
  try {
    const now=new Date();
    const start=new Date(now.getFullYear(),now.getMonth(),1);
    const [expenses,exchanges]=await Promise.all([
      prisma.expense.findMany({where:{userId:req.user!.id},orderBy:{date:'desc'},take:500}),
      prisma.exchange.findMany({where:{userId:req.user!.id},orderBy:{createdAt:'desc'},take:100})
    ]);

    const totalVnd=expenses.reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const monthVnd=expenses.filter(x=>x.date>=start).reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const purchases=expenses.filter(x=>x.usdtCharged!=null && Number(x.usdtCharged)>0);
    const observedVnd=purchases.reduce((sum,x)=>sum+Number(x.amountVnd),0);
    const observedUsdt=purchases.reduce((sum,x)=>sum+Number(x.usdtCharged),0);
    const observedVndPerUsdt=calculateObservedVndPerUsdt(
      purchases.map(x=>({amountVnd:Number(x.amountVnd),usdtCharged:Number(x.usdtCharged)}))
    );

    // Weighted by USDT received, using the same RUB/USDT helper as expense saving.
    const effectiveRubPerUsdt=calculateRubPerUsdt(
      exchanges.map(x=>({rubSpent:Number(x.rubSpent),usdtReceived:Number(x.usdtReceived)}))
    );
    const knownVndExchanges=exchanges.filter(x=>x.mode!=='RUB_VND'&&x.usdtReceived!=null&&x.vndReceived!=null);
    const exchangeVnd=knownVndExchanges.reduce((sum,x)=>sum+Number(x.vndReceived),0);
    const exchangeUsdt=knownVndExchanges.reduce((sum,x)=>sum+Number(x.usdtReceived),0);
    // Prefer actual card-purchase observations. Otherwise use only exchanges with a recorded VND outcome.
    const effectiveVndPerUsdt=observedVndPerUsdt!=null
      ? observedVndPerUsdt
      : exchangeUsdt>0 ? exchangeVnd/exchangeUsdt : null;
    const effectiveVndPerRub = calculateObservedVndPerRub({
      directExchanges: exchanges
        .filter(x => x.mode === 'RUB_VND' && x.vndReceived != null)
        .map(x => ({ rubSpent: Number(x.rubSpent), vndReceived: Number(x.vndReceived) })),
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
    const confirmedExchangeVnd = exchanges
      .filter(x => x.vndReceived != null)
      .reduce((sum, x) => sum + Number(x.vndReceived), 0);
    const unpricedUsdtTopUps = exchanges.some(x => x.mode !== 'RUB_VND' && x.vndReceived == null && x.usdtReceived != null);
    const estimatedUnconvertedVnd = effectiveVndPerUsdt == null ? 0 : exchanges
      .filter(x => x.mode !== 'RUB_VND' && x.vndReceived == null && x.usdtReceived != null)
      .reduce((sum, x) => sum + Number(x.usdtReceived) * effectiveVndPerUsdt, 0);
    const balanceVnd = unpricedUsdtTopUps && effectiveVndPerUsdt == null
      ? null
      : confirmedExchangeVnd + estimatedUnconvertedVnd - totalVnd;

    res.json({
      totalVnd,monthVnd,balanceVnd,confirmedExchangeVnd,estimatedUnconvertedVnd,
      balanceIsEstimated: estimatedUnconvertedVnd > 0,
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:Number(x.amountVnd),amountRub:x.amountRub==null?null:Number(x.amountRub),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:exchanges.map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:x.usdtReceived==null?null:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:x.effectiveRubPerUsdt==null?null:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
