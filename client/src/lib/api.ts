const BASE=import.meta.env.VITE_API_URL||'http://localhost:3001/api';
export function getToken(){return localStorage.getItem('flowmoney_token');}
export function setToken(token:string|null){token?localStorage.setItem('flowmoney_token',token):localStorage.removeItem('flowmoney_token');}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{const token=getToken();const response=await fetch(`${BASE}${path}`,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(options.headers||{})}});const data=await response.json().catch(()=>({message:'Unexpected server response'}));if(!response.ok)throw new Error(data.message||'Request failed');return data as T;}
