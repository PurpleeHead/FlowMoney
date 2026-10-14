import {Router} from 'express';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';

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
    const observedVndPerUsdt=observedUsdt>0?observedVnd/observedUsdt:null;

    // Weighted by USDT received, so multiple RUB -> USDT operations produce one effective rate.
    const totalRub=exchanges.reduce((sum,x)=>sum+Number(x.rubSpent),0);
    const totalUsdt=exchanges.reduce((sum,x)=>sum+Number(x.usdtReceived),0);
    const effectiveRubPerUsdt=totalUsdt>0?totalRub/totalUsdt:null;
    const exchangeVnd=exchanges.filter(x=>x.vndReceived!=null).reduce((sum,x)=>sum+Number(x.vndReceived),0);
    const exchangeRub=exchanges.filter(x=>x.vndReceived!=null).reduce((sum,x)=>sum+Number(x.rubSpent),0);
    const exchangeVndPerRub=exchangeRub>0?exchangeVnd/exchangeRub:null;
    const effectiveVndPerRub=observedVndPerUsdt!=null && effectiveRubPerUsdt!=null && effectiveRubPerUsdt>0
      ? observedVndPerUsdt/effectiveRubPerUsdt : exchangeVndPerRub;

    res.json({
      totalVnd,monthVnd,
      observedVnd,observedUsdt,observedVndPerUsdt,effectiveRubPerUsdt,effectiveVndPerRub,
      expenses:expenses.map(x=>({...x,amount:Number(x.amount),amountVnd:Number(x.amountVnd),usdtCharged:x.usdtCharged==null?null:Number(x.usdtCharged)})),
      exchanges:exchanges.map(x=>({...x,rubSpent:Number(x.rubSpent),usdtReceived:Number(x.usdtReceived),vndPerUsdt:x.vndPerUsdt==null?null:Number(x.vndPerUsdt),vndReceived:x.vndReceived==null?null:Number(x.vndReceived),effectiveVndPerRub:x.effectiveVndPerRub==null?null:Number(x.effectiveVndPerRub),effectiveRubPerUsdt:Number(x.effectiveRubPerUsdt)}))
    });
  } catch(e) { next(e); }
});
export default router;
