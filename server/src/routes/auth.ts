import {Router} from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';

const router=Router();
const credentials=z.object({
  email:z.string().email().max(254).transform(v=>v.toLowerCase().trim()),
  password:z.string().min(8).max(128),
});
const profileSchema=z.object({
  name:z.string().trim().max(80).optional(),
  country:z.string().trim().max(80).optional(),
});

function token(id:string,email:string){
  const secret=process.env.JWT_SECRET;
  if(!secret||secret.length<32)throw new Error('JWT_SECRET must be at least 32 characters');
  return jwt.sign({id,email},secret,{expiresIn:'7d'});
}
function hashVerificationToken(value:string){return createHash('sha256').update(value).digest('hex');}

async function sendVerificationEmail(email:string,verificationToken:string){
  const apiKey=process.env.RESEND_API_KEY;
  const from=process.env.MAIL_FROM;
  if(!apiKey||!from)throw new Error('Email verification is not configured. Set RESEND_API_KEY and MAIL_FROM in Render.');
  const appUrl=(process.env.APP_URL||process.env.CLIENT_ORIGIN||'https://flowmoney-app.onrender.com').replace(/\/$/,'');
  const verifyUrl=`${appUrl}/?verify=${encodeURIComponent(verificationToken)}`;
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      from,
      to:[email],
      subject:'Verify your FLOWMONEY email',
      text:`Verify your FLOWMONEY email by opening this link (valid for 24 hours): ${verifyUrl}`,
      html:`<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Welcome to FLOWMONEY</h2><p>Confirm your email address to activate your account.</p><p><a href="${verifyUrl}">Verify email address</a></p><p>This link expires in 24 hours.</p></div>`,
    }),
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error('Email provider rejected the verification email.');
}

router.post('/register',async(req,res,next)=>{
  let createdUserId:string|undefined;
  try{
    const parsed=credentials.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Enter a valid email and a password of at least 8 characters.'});return;}
    const {email,password}=parsed.data;
    if(await prisma.user.findUnique({where:{email}})){res.status(409).json({message:'An account with this email already exists.'});return;}
    const verificationToken=randomBytes(32).toString('hex');
    const passwordHash=await bcrypt.hash(password,12);
    const user=await prisma.user.create({
      data:{
        email,passwordHash,emailVerified:false,
        emailVerificationTokenHash:hashVerificationToken(verificationToken),
        emailVerificationExpiresAt:new Date(Date.now()+24*60*60*1000),
        wallets:{create:[{currency:'RUB',balance:0,label:'Russian ruble'},{currency:'USDT',balance:0,label:'Tether'},{currency:'VND',balance:0,label:'Vietnamese dong'}]},
      },
    });
    createdUserId=user.id;
    await sendVerificationEmail(user.email,verificationToken);
    res.status(201).json({message:'Account created. Check your email and verify the address before signing in.'});
  }catch(e){
    if(createdUserId){
      try{await prisma.user.delete({where:{id:createdUserId}});}catch{/* Keep the original error for diagnostics. */}
    }
    if(e instanceof Error&&e.message.includes('Email verification is not configured')){
      res.status(503).json({message:'Email verification is not configured on the server yet. Please try again later.'});
      return;
    }
    if(e instanceof Error&&e.message.includes('Email provider rejected')){
      res.status(502).json({message:'We could not send the verification email. Check the email address or try again later.'});
      return;
    }
    next(e);
  }
});

router.post('/verify-email',async(req,res,next)=>{
  try{
    const parsed=z.object({token:z.string().min(32).max(200)}).safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'The verification link is invalid or incomplete.'});return;}
    const user=await prisma.user.findUnique({where:{emailVerificationTokenHash:hashVerificationToken(parsed.data.token)}});
    if(!user||!user.emailVerificationExpiresAt||user.emailVerificationExpiresAt<new Date()){
      res.status(400).json({message:'This verification link has expired or was already used. Request a new one.'});return;
    }
    await prisma.user.update({where:{id:user.id},data:{emailVerified:true,emailVerificationTokenHash:null,emailVerificationExpiresAt:null}});
    res.json({message:'Email verified. You can now sign in on any device.'});
  }catch(e){next(e);}
});

router.post('/resend-verification',async(req,res,next)=>{
  try{
    const parsed=z.object({email:z.string().email().max(254).transform(v=>v.toLowerCase().trim())}).safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Enter a valid email address.'});return;}
    const user=await prisma.user.findUnique({where:{email:parsed.data.email}});
    if(!user||user.emailVerified){res.json({message:'If the account needs verification, a new email will be sent.'});return;}
    const verificationToken=randomBytes(32).toString('hex');
    await prisma.user.update({where:{id:user.id},data:{emailVerificationTokenHash:hashVerificationToken(verificationToken),emailVerificationExpiresAt:new Date(Date.now()+24*60*60*1000)}});
    await sendVerificationEmail(user.email,verificationToken);
    res.json({message:'If the account needs verification, a new email will be sent.'});
  }catch(e){next(e);}
});

router.post('/login',async(req,res,next)=>{
  try{
    const parsed=credentials.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Enter a valid email and password.'});return;}
    const {email,password}=parsed.data;
    const user=await prisma.user.findUnique({where:{email}});
    if(!user||!(await bcrypt.compare(password,user.passwordHash))){res.status(401).json({message:'Email or password is incorrect.'});return;}
    if(!user.emailVerified){res.status(403).json({message:'Please verify your email before signing in. Check your inbox or request a new verification link.'});return;}
    res.json({token:token(user.id,user.email),user:{id:user.id,email:user.email,name:user.name,country:user.country,emailVerified:user.emailVerified}});
  }catch(e){next(e);}
});

router.get('/me',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const user=await prisma.user.findUnique({where:{id:req.user!.id},select:{id:true,email:true,name:true,country:true,emailVerified:true}});
    if(!user){res.status(401).json({message:'Account not found.'});return;}
    res.json(user);
  }catch(e){next(e);}
});

router.get('/profile',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const user=await prisma.user.findUnique({where:{id:req.user!.id},select:{id:true,email:true,name:true,country:true,emailVerified:true,createdAt:true}});
    if(!user){res.status(404).json({message:'Profile not found.'});return;}
    res.json(user);
  }catch(e){next(e);}
});

router.patch('/profile',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const parsed=profileSchema.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Name or country is invalid.'});return;}
    const user=await prisma.user.update({where:{id:req.user!.id},data:parsed.data,select:{id:true,email:true,name:true,country:true,emailVerified:true,createdAt:true}});
    res.json(user);
  }catch(e){next(e);}
});

export default router;
