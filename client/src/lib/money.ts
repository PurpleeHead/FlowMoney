export type ExchangeInput = { rubSpent:number; usdtReceived:number; vndPerUsdt:number; vndFee?:number };
export type ExchangeResult = { vndReceived:number; effectiveVndPerRub:number; effectiveRubPerUsdt:number; effectiveVndPerUsdt:number };
export function calculateExchange(input:ExchangeInput):ExchangeResult {
  const {rubSpent,usdtReceived,vndPerUsdt,vndFee=0}=input;
  if (![rubSpent,usdtReceived,vndPerUsdt,vndFee].every(Number.isFinite) || rubSpent<=0 || usdtReceived<=0 || vndPerUsdt<=0 || vndFee<0) throw new Error('Enter positive amounts and rates; fee cannot be negative.');
  const vndReceived=usdtReceived*vndPerUsdt-vndFee;
  if(vndReceived<0) throw new Error('Fee cannot exceed the VND amount received.');
  return {vndReceived,effectiveVndPerRub:vndReceived/rubSpent,effectiveRubPerUsdt:rubSpent/usdtReceived,effectiveVndPerUsdt:vndReceived/usdtReceived};
}
export const formatMoney=(value:number,currency='VND',locale='en-US')=>new Intl.NumberFormat(locale,{style:'currency',currency,maximumFractionDigits:currency==='VND'?0:2}).format(value);
