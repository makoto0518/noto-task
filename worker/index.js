import { TASK_MODEL, TASK_MESSAGES, groundedTaskSuggestions } from './task-extraction.js';
import { getAnalyticsMetrics } from './usage.js';
/**
 * Cloudflare Worker: all authenticated API routes are same-origin (/api/*).
 * D1 SQL queries bind parameters (never concatenate user input into SQL).
 * Authentication: Google OAuth authorization code + PKCE -> server session;
 * session token is HttpOnly cookie and only SHA-256 digest resides in D1.
 * This module imports no paid services and works on Cloudflare Workers Free.
 */
const SESSION_SECONDS=60*60*24*30;
const statusValues=new Set(['todo','doing','done']);
const encoder=new TextEncoder();
function fail(message,status=400){return Response.json({error:message},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function ok(value,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function cookieMap(header){const out={};for(const part of (header||'').split(';')){const n=part.indexOf('=');if(n!==-1){try{out[part.slice(0,n).trim()]=decodeURIComponent(part.slice(n+1).trim());}catch{}}}return out;}
function base64url(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function randomString(bytes=32){return base64url(crypto.getRandomValues(new Uint8Array(bytes)));}
async function sha256(input){return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(input))));}
function cookie(key,value,options={}){const params=[`${key}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','SameSite=Lax',`Max-Age=${options.maxAge??SESSION_SECONDS}`];if(options.secure)params.push('Secure');return params.join('; ');}
function originOf(request,env){return env.APP_ORIGIN||new URL(request.url).origin;}
function isSecure(request,env){return originOf(request,env).startsWith('https://');}
function isMutating(method){return !['GET','HEAD','OPTIONS'].includes(method);}
// Same-origin mutation guard supplements SameSite=Lax cookie CSRF protection.
function allowedWrite(request,env){const origin=request.headers.get('Origin');return Boolean(origin&&origin===originOf(request,env));}
async function bodyJson(request){const length=Number(request.headers.get('Content-Length')||0);if(length>12000)throw new Error('入力が長すぎます');const raw=await request.text();if(raw.length>12000)throw new Error('入力が長すぎます');try{return JSON.parse(raw);}catch{throw new Error('JSONが不正です');}}
async function getSession(request,env){const token=cookieMap(request.headers.get('Cookie')).mizu_session;if(!token||!env.DB)return null;const digest=await sha256(token);const row=await env.DB.prepare('SELECT u.id,u.email,u.name,u.avatar_url FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(digest,Math.floor(Date.now()/1000)).first();return row?{id:row.id,email:row.email,name:row.name,avatarUrl:row.avatar_url}:null;}
/** Normalize untrusted JSON before writing it to the database. */
function normalizeItem(data,{patch=false}={}){
  if(!data||typeof data!=='object'||!['note','task'].includes(data.kind)||typeof data.id!=='string'||!/^[\w-]{10,80}$/.test(data.id))return null;
  if(typeof data.content!=='string'||!data.content.trim()||data.content.length>4000)return null;
  const dueDate=data.kind==='task'&&data.dueDate!=null?data.dueDate:null;
  if(dueDate!==null&&(typeof dueDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)||Number.isNaN(new Date(dueDate+'T00:00:00Z').getTime())))return null;
  const createdAt=typeof data.createdAt==='string'&&!Number.isNaN(Date.parse(data.createdAt))?data.createdAt:new Date().toISOString();
  return {id:data.id,kind:data.kind,content:data.content.trim(),status:data.kind==='note'?'todo':statusValues.has(data.status)?data.status:'todo',dueDate,createdAt,updatedAt:new Date().toISOString()};
}
function mapRow(row){return {id:row.id,kind:row.kind,content:row.content,status:row.status,dueDate:row.due_date,createdAt:row.created_at,updatedAt:row.updated_at};}
/** Conditional writes detect stale edits without requiring a D1 schema change. */
function validExpectedRevision(value){return value===null||(typeof value==='string'&&value.length<=64&&!Number.isNaN(Date.parse(value)));}
function nextRevision(previous){const old=Date.parse(previous);return new Date(Math.max(Date.now(),Number.isFinite(old)?old+1:0)).toISOString();}
async function getItemRow(db,userId,id){return db.prepare('SELECT id,kind,content,status,due_date,created_at,updated_at FROM items WHERE user_id=? AND id=?').bind(userId,id).first();}
function sameItemData(a,b){return a.kind===b.kind&&a.content===b.content&&a.status===b.status&&a.dueDate===b.dueDate;}
function conflictResponse(row){return Response.json({error:'別の端末で更新されています',current:row?mapRow(row):null},{status:409,headers:{'Cache-Control':'no-store'}});}
/** OAuth redirect: random state prevents CSRF, PKCE challenge binds the callback. */
async function beginGoogle(request,env){
  if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)return fail('Google OAuthの設定が必要です',503);
  const state=randomString(),verifier=randomString(64);const challenge=await sha256(verifier);
  const redirect=originOf(request,env)+'/api/auth/callback';
  const params=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:'openid email profile',state,code_challenge:challenge,code_challenge_method:'S256',access_type:'online',prompt:'select_account'});
  const headers=new Headers({Location:'https://accounts.google.com/o/oauth2/v2/auth?'+params.toString(),'Cache-Control':'no-store'});
  headers.append('Set-Cookie',cookie('mizu_oauth_state',state,{maxAge:600,secure:isSecure(request,env)}));
  headers.append('Set-Cookie',cookie('mizu_pkce',verifier,{maxAge:600,secure:isSecure(request,env)}));
  return new Response(null,{status:302,headers});
}
/** Exchange code on server; profile comes from Google userinfo, not the browser. */
async function googleCallback(request,env){
  const url=new URL(request.url);const givenState=url.searchParams.get('state');const code=url.searchParams.get('code');const cookies=cookieMap(request.headers.get('Cookie'));
  if(!givenState||!code||givenState!==cookies.mizu_oauth_state||!cookies.mizu_pkce)return fail('Google認証を確認できませんでした',401);
  const redirect=originOf(request,env)+'/api/auth/callback';
  const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code',code_verifier:cookies.mizu_pkce})});
  if(!tokenResponse.ok)return fail('Googleの認証に失敗しました',401);
  const token=await tokenResponse.json();if(!token.access_token)return fail('Googleの認証情報が不足しています',401);
  const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+token.access_token}});
  if(!profileResponse.ok)return fail('Googleのプロフィールを取得できませんでした',401);
  const profile=await profileResponse.json();if(!profile.sub||!profile.email||profile.email_verified!==true)return fail('確認済みGoogleアカウントが必要です',403);
  await env.DB.prepare('INSERT INTO users(id,email,name,avatar_url) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,avatar_url=excluded.avatar_url').bind(profile.sub,profile.email,String(profile.name||'').slice(0,100),String(profile.picture||'').slice(0,512)).run();
  const sessionToken=randomString(48);const digest=await sha256(sessionToken);
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(digest,profile.sub,Math.floor(Date.now()/1000)+SESSION_SECONDS).run();
  const headers=new Headers({Location:'/', 'Cache-Control':'no-store'});
  headers.append('Set-Cookie',cookie('mizu_session',sessionToken,{secure:isSecure(request,env)}));
  headers.append('Set-Cookie',cookie('mizu_oauth_state','',{maxAge:0,secure:isSecure(request,env)}));
  headers.append('Set-Cookie',cookie('mizu_pkce','',{maxAge:0,secure:isSecure(request,env)}));
  return new Response(null,{status:302,headers});
}
/**
 * AI runs only after explicit user action. We cap each user at 20/day to
 * protect the shared FREE-tier neuron allocation; model output is untrusted.
 * The 20/day cap is NOT a guaranteed global cloud cost/quota ceiling.
 */
async function handleAI(request,env,user){
  if(!env.AI)return fail('Workers AIが設定されていません',503);
  const data=await bodyJson(request);if(typeof data.text!=='string'||!data.text.trim()||data.text.length>2000)return fail('メモは1〜2000文字で入力してください');
  const day=new Date().toISOString().slice(0,10);
  const usage=await env.DB.prepare('INSERT INTO ai_usage(user_id,day,calls) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET calls=calls+1 WHERE calls<20').bind(user.id,day).run();
  if(!usage.meta?.changes)return fail('AIの1日あたりの利用上限に達しました',429);
  const result=await env.AI.run(TASK_MODEL,{
    messages:TASK_MESSAGES(data.text),max_tokens:380,temperature:0,
    chat_template_kwargs:{enable_thinking:false}
  });
  const tasks=groundedTaskSuggestions(result,data.text);
  return ok({tasks});
}
/** Central router; every item query is scoped to session.user.id. */
async function route(request,env){
  const url=new URL(request.url);const path=url.pathname;
  if(!path.startsWith('/api/'))return new Response('Not found',{status:404});
  if(!env.DB)return fail('D1データベースが設定されていません',503);
  if(isMutating(request.method)&&!allowedWrite(request,env))return fail('無効なリクエスト元です',403);
  if(path==='/api/auth/google'&&request.method==='GET')return beginGoogle(request,env);
  if(path==='/api/auth/callback'&&request.method==='GET')return googleCallback(request,env);
  const user=await getSession(request,env);
  if(path==='/api/session'&&request.method==='GET')return ok({authenticated:Boolean(user),user});
  if(!user)return fail('Googleログインが必要です',401);
  // Only the explicitly configured owner can see account-wide billing analytics.
  // Ordinary Google users must NOT be able to fetch Cloudflare account data.
  if(path==='/api/usage'&&request.method==='GET'){
    if(!env.OWNER_GOOGLE_SUB || user.id !== env.OWNER_GOOGLE_SUB)return fail('利用状況は管理者のみ確認できます',403);
    const today=new Date().toISOString().slice(0,10);
    let aiCalls=null;
    try {
      const row=await env.DB.prepare('SELECT calls FROM ai_usage WHERE user_id=? AND day=?').bind(user.id,today).first();
      aiCalls={used:Math.max(0,Number(row?.calls||0)),limit:20};
    }catch{/* Older DB / temporary query failure must not hide the whole page. */}
    const result=await getAnalyticsMetrics(env);
    return ok({...result,aiCalls,message:result.configured
      ? 'Cloudflareのアカウント全体の集計です。反映遅延や計測方法の違いがあるため請求の確定値ではありません。'
      : 'Cloudflare Analyticsを連携するとWorkers・D1の集計が表示されます。Neuronsは公式ダッシュボードで確認してください。'});
  }
  if(path==='/api/logout'&&request.method==='POST'){
    const token=cookieMap(request.headers.get('Cookie')).mizu_session;
    if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookie('mizu_session','',{maxAge:0,secure:isSecure(request,env)})}});
  }
  if(path==='/api/items'&&request.method==='GET'){
    const {results}=await env.DB.prepare('SELECT id,kind,content,status,due_date,created_at,updated_at FROM items WHERE user_id=? ORDER BY created_at DESC LIMIT 2000').bind(user.id).all();
    return ok({items:results.map(mapRow)});
  }
  if(path==='/api/items'&&request.method==='POST'){
    const item=normalizeItem(await bodyJson(request));if(!item)return fail('記録内容が不正です');
    const write=await env.DB.prepare('INSERT INTO items(id,user_id,kind,content,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING')
      .bind(item.id,user.id,item.kind,item.content,item.status,item.dueDate,item.createdAt,item.updatedAt).run();
    if(!write.meta?.changes)return conflictResponse(await getItemRow(env.DB,user.id,item.id));
    return ok({item},201);
  }
  const match=path.match(/^\/api\/items\/([\w-]{10,80})$/);
  // No schema migration: use the existing updated_at column for atomic compare-and-swap.
  if(match&&request.method==='PUT'){
    const data=await bodyJson(request);
    if(!Object.hasOwn(data,'expectedUpdatedAt')||!validExpectedRevision(data.expectedUpdatedAt))return fail('更新前の版情報が必要です',428);
    const item=normalizeItem({...data,id:match[1]});if(!item)return fail('記録内容が不正です');
    const expected=data.expectedUpdatedAt;
    if(expected===null){
      const write=await env.DB.prepare('INSERT INTO items(id,user_id,kind,content,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING')
        .bind(item.id,user.id,item.kind,item.content,item.status,item.dueDate,item.createdAt,item.updatedAt).run();
      if(write.meta?.changes)return ok({item},201);
    }else{
      const updatedAt=nextRevision(expected);
      const write=await env.DB.prepare('UPDATE items SET content=?,status=?,due_date=?,updated_at=? WHERE user_id=? AND id=? AND kind=? AND updated_at=?')
        .bind(item.content,item.status,item.dueDate,updatedAt,user.id,item.id,item.kind,expected).run();
      if(write.meta?.changes)return ok({item:{...item,updatedAt}});
    }
    // A lost response after a successful write can be safely acknowledged.
    const current=await getItemRow(env.DB,user.id,item.id);
    if(current&&sameItemData(mapRow(current),item))return ok({item:mapRow(current)});
    return conflictResponse(current);
  }
  if(match&&request.method==='DELETE'){
    const expected=request.headers.get('If-Match');
    if(typeof expected!=='string'||!validExpectedRevision(expected)){
      // A legacy outbox has no revision. Never execute its deletion, but return
      // 409 instead of 428 so the client can reconcile and unblock its queue.
      const current=await getItemRow(env.DB,user.id,match[1]);
      return Response.json({error:'版情報のない古い削除要求を安全のため中止しました',reason:'legacy_delete',current:current?mapRow(current):null},{status:409,headers:{'Cache-Control':'no-store'}});
    }
    const write=await env.DB.prepare('DELETE FROM items WHERE user_id=? AND id=? AND updated_at=?')
      .bind(user.id,match[1],expected).run();
    if(write.meta?.changes)return ok({ok:true});
    const current=await getItemRow(env.DB,user.id,match[1]);
    if(!current)return ok({ok:true}); // Retry after a committed delete.
    return conflictResponse(current);
  }
  // Older PATCH clients must also send a revision precondition, not bypass protection.
  if(match&&request.method==='PATCH'){
    const data=await bodyJson(request);
    if(!Object.hasOwn(data,'expectedUpdatedAt')||!validExpectedRevision(data.expectedUpdatedAt)||data.expectedUpdatedAt===null)return fail('更新前の版情報が必要です',428);
    const current=await getItemRow(env.DB,user.id,match[1]);
    if(!current)return conflictResponse(null);
    const item=normalizeItem({...data,id:match[1],kind:current.kind,createdAt:current.created_at});
    if(!item)return fail('更新内容が不正です');
    const updatedAt=nextRevision(data.expectedUpdatedAt);
    const write=await env.DB.prepare('UPDATE items SET content=?,status=?,due_date=?,updated_at=? WHERE user_id=? AND id=? AND updated_at=?')
      .bind(item.content,item.status,item.dueDate,updatedAt,user.id,match[1],data.expectedUpdatedAt).run();
    if(write.meta?.changes)return ok({item:{...item,updatedAt}});
    const newest=await getItemRow(env.DB,user.id,match[1]);
    if(newest&&sameItemData(mapRow(newest),item))return ok({item:mapRow(newest)});
    return conflictResponse(newest);
  }
  if(path==='/api/ai/tasks'&&request.method==='POST')return handleAI(request,env,user);
  return fail('APIが見つかりません',404);
}
export default { async fetch(request,env){try{return await route(request,env);}catch(error){console.error('API error',error);if(error?.message==='入力が長すぎます'||error?.message==='JSONが不正です')return fail(error.message);return fail('サーバーでエラーが発生しました',500);}} };
export const __test={normalizeItem,nextStatus:undefined,cookieMap,allowedWrite};
