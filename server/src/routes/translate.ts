import {Router} from 'express';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
const router=Router();
router.use(auth);

async function translateWithConfiguredProvider(text:string,source:string,target:string):Promise<string>{
 const endpoint=process.env.TRANSLATE_URL;
 if(!endpoint)throw new Error('No configured provider');
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.TRANSLATE_API_KEY?{'Authorization':`Bearer ${process.env.TRANSLATE_API_KEY}`}:{})},body:JSON.stringify({q:text,source,target,format:'text',api_key:process.env.TRANSLATE_API_KEY||undefined}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Translation provider returned an error');
 const data=await response.json() as {translatedText?:string};
 if(!data.translatedText)throw new Error('Unexpected translation provider response');
 return data.translatedText;
}

async function translateWithFreeFallback(text:string,source:string,target:string):Promise<string>{
 const lines=text.split(/\\r?\\n/);
 const translated=await Promise.all(lines.map(async line=>{
  if(!line.trim())return line;
  const url=new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q',line.slice(0,450));
  url.searchParams.set('langpair',`${source}|${target}`);
  const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Free translation fallback is unavailable');
  const data=await response.json() as {responseStatus?:number;responseData?:{translatedText?:string}};
  const value=data.responseData?.translatedText;
  if(response.status!==200||!value||data.responseStatus!==200)throw new Error('Free translation fallback returned no translation');
  return value.replace(/\\r?\\n/g,' ').trim();
 }));
 return translated.join('\\n');
}

router.post('/',async(req,res)=>{
 const p=z.object({text:z.string().min(1).max(12000),source:z.string().default('vi'),target:z.string().default('ru')}).safeParse(req.body);
 if(!p.success){res.status(400).json({message:'Provide text to translate (up to 12,000 characters).'});return;}
 try{
  let translatedText:string;
  if(process.env.TRANSLATE_URL){
   try{translatedText=await translateWithConfiguredProvider(p.data.text,p.data.source,p.data.target);}
   catch{translatedText=await translateWithFreeFallback(p.data.text,p.data.source,p.data.target);}
  }else translatedText=await translateWithFreeFallback(p.data.text,p.data.source,p.data.target);
  res.json({translatedText});
 }catch{
  res.status(502).json({message:'Translation failed. Check the connection and try again; the original text and prices have not been changed.'});
 }
});
export default router;
