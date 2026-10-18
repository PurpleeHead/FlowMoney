import {Router} from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {z} from 'zod';
import {prisma} from '../services/prisma.js';
import {auth} from '../middleware/auth.js';
import type {AuthedRequest} from '../types.js';

const router=Router();
const credentials=z.object({
  email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),
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
router.post('/register',async(req,res,next)=>{
  try{
    const parsed=credentials.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Enter a valid email and a password of at least 8 characters.'});return;}
    const {email,password}=parsed.data;
    if(await prisma.user.findUnique({where:{email}})){res.status(409).json({message:'An account with this email already exists.'});return;}
    const passwordHash=await bcrypt.hash(password,12);
    await prisma.user.create({
      data:{
        email,passwordHash,
        wallets:{create:[{currency:'RUB',balance:0,label:'Russian ruble'},{currency:'USDT',balance:0,label:'Tether'},{currency:'VND',balance:0,label:'Vietnamese dong'}]},
      },
    });
    res.status(201).json({message:'Account created. You can now sign in.'});
  }catch(e){
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002') {
      const target = 'meta' in e && typeof e.meta === 'object' && e.meta !== null && 'target' in e.meta
        ? e.meta.target
        : undefined;
      const emailConstraint = Array.isArray(target)
        ? target.includes('email')
        : typeof target === 'string' && /email/i.test(target);
      if (emailConstraint) {
        res.status(409).json({message:'An account with this email already exists.'});
        return;
      }
    }
    next(e);
  }
});

router.post('/login',async(req,res,next)=>{
  try{
    const parsed=credentials.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Enter a valid email and password.'});return;}
    const {email,password}=parsed.data;
    const user=await prisma.user.findUnique({where:{email}});
    if(!user||!(await bcrypt.compare(password,user.passwordHash))){res.status(401).json({message:'Email or password is incorrect.'});return;}
    res.json({token:token(user.id,user.email),user:{id:user.id,email:user.email,name:user.name,country:user.country}});
  }catch(e){next(e);}
});

router.get('/me',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const user=await prisma.user.findUnique({where:{id:req.user!.id},select:{id:true,email:true,name:true,country:true}});
    if(!user){res.status(401).json({message:'Account not found.'});return;}
    res.json(user);
  }catch(e){next(e);}
});

router.get('/profile',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const user=await prisma.user.findUnique({where:{id:req.user!.id},select:{id:true,email:true,name:true,country:true,createdAt:true}});
    if(!user){res.status(404).json({message:'Profile not found.'});return;}
    res.json(user);
  }catch(e){next(e);}
});

router.patch('/profile',auth,async(req:AuthedRequest,res,next)=>{
  try{
    const parsed=profileSchema.safeParse(req.body);
    if(!parsed.success){res.status(400).json({message:'Name or country is invalid.'});return;}
    const user=await prisma.user.update({where:{id:req.user!.id},data:parsed.data,select:{id:true,email:true,name:true,country:true,createdAt:true}});
    res.json(user);
  }catch(e){next(e);}
});


router.patch('/password', auth, async (req: AuthedRequest, res, next) => {
  try {
    const parsed = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Enter your current password and a new password of at least 8 characters.' });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, passwordHash: true },
    });
    if (!user) {
      res.status(404).json({ message: 'Account not found.' });
      return;
    }
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      res.status(400).json({ message: 'Current password is incorrect.' });
      return;
    }
    if (await bcrypt.compare(parsed.data.newPassword, user.passwordHash)) {
      res.status(400).json({ message: 'New password must be different from the current password.' });
      return;
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    res.json({ message: 'Password changed successfully.' });
  } catch (e) {
    next(e);
  }
});

export default router;
