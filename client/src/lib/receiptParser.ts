export type ReceiptItem={name:string;price:number;quantity:number;originalName?:string;translatedName?:string};
// Heuristic parser: handles common receipt lines ending in a price; always review OCR output.
export function parseReceiptLines(text:string):ReceiptItem[]{
 return text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
   const m=line.match(/^(.*?)(?:\s{1,}|\s*[xх×]\s*)(\d[\d., ]*)\s*(?:₫|đ|VND)?$/i);
   if(!m) return null; const name=m[1].replace(/[|*]+/g,' ').trim(); const raw=m[2].replace(/\s/g,''); const normalized=/[.,]\d{3}$/.test(raw)?raw.replace(/[.,]/g,''):raw.replace(',','.'); const price=Number(normalized);
   if(!name||!Number.isFinite(price)||price<=0) return null; return {name,price,quantity:1};
 }).filter((x):x is ReceiptItem=>x!==null);
}
