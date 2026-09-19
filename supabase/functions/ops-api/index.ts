import {censusGeocode} from '../_shared/geocode.js';
﻿import {parseManifest,planRoutes} from '../_shared/manifest.js';
const URL_BASE=Deno.env.get('SUPABASE_URL')!;
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-tackpath-session','Access-Control-Allow-Methods':'POST,OPTIONS'};
const hash=async(value:string|Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))).map(b=>b.toString(16).padStart(2,'0')).join('');
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST',prefer='return=representation'){
 const response=await fetch(URL_BASE+path,{method,headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':'application/json',Prefer:prefer},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let result;try{result=JSON.parse(text)}catch{result={message:text}}
 if(!response.ok)throw Object.assign(new Error(result.message||result.error||'Database operation failed'),{status:response.status});return result;
}
const rpc=(name:string,args:unknown)=>request('/rest/v1/rpc/'+name,args);
const state=(token:string)=>rpc('ops_state',{p_token:token});
const command=(token:string,kind:string,payload:unknown,id=crypto.randomUUID())=>rpc('ops_command',{p_token:token,p_id:id,p_kind:kind,p_payload:payload});
async function geocode(address:string){
 const key=Deno.env.get('GOOGLE_MAPS_KEY');
 if(key){
  try{
   const response=await fetch('https://maps.googleapis.com/maps/api/geocode/json?address='+encodeURIComponent(address)+'&key='+encodeURIComponent(key),{signal:AbortSignal.timeout(12000)});
   if(response.ok){const data=await response.json();if(data.status==='OK'&&data.results?.[0]){const best=data.results[0];if(best.partial_match||!['ROOFTOP','RANGE_INTERPOLATED'].includes(best.geometry.location_type))throw new Error('Address requires more precise location');return {...best.geometry.location,provider:'google',precision:best.geometry.location_type}}
    if(!['REQUEST_DENIED','OVER_QUERY_LIMIT','UNKNOWN_ERROR'].includes(data.status))throw new Error(data.status||'Address not located');
   }
  }catch(e){if(!['TypeError','TimeoutError'].includes(e.name))throw e}
 }
 return censusGeocode(address);
}
async function processManifest(token:string,manifestId:string){
 let s=await state(token);if(s.role==='driver')throw new Error('Manifest access denied');
 const manifest=s.manifests.find((m:any)=>m.id===manifestId);if(!manifest)throw new Error('Manifest not found');
 const candidates=s.rows.filter((r:any)=>r.manifest_id===manifestId&&!r.error&&s.packages.some((p:any)=>p.row_id===r.id&&!p.route_id&&['awaiting_geocode','geocode_failed'].includes(p.exception_code)));
 // New rows must progress even when the first batch contains permanent failures.
 const eligible=candidates.sort((a:any,b:any)=>Number(!s.packages.some((p:any)=>p.row_id===a.id&&p.exception_code==='awaiting_geocode'))-Number(!s.packages.some((p:any)=>p.row_id===b.id&&p.exception_code==='awaiting_geocode'))).slice(0,20);
 await Promise.all(eligible.map(async(row:any)=>{try{const coords=await geocode(row.raw.address);await command(token,'geocode',{row_id:row.id,...coords})}catch(e){await command(token,'geocode',{row_id:row.id,error:String(e.message||e)})}}));
 s=await state(token);
 const waiting=s.packages.some((p:any)=>p.manifest_id===manifestId&&p.exception_code==='awaiting_geocode');
 if(waiting)return {manifest_id:manifestId,more:true,state:s};
 const routable=s.rows.filter((r:any)=>r.manifest_id===manifestId&&!r.error&&s.packages.filter((p:any)=>p.row_id===r.id).every((p:any)=>p.state==='routable'&&!p.route_id&&!p.exception_code));
 if(routable.length){const warehouse=s.warehouses.find((w:any)=>w.id===manifest.warehouse_id);let origin;try{origin=await geocode(warehouse.address)}catch{origin=undefined}
  const plans=planRoutes(routable,origin);for(const plan of plans)plan.key=await hash(plan.rows.join('|'));
  await command(token,'publish',{manifest_id:manifestId,routes:plans});
 }
 return {manifest_id:manifestId,more:false,state:await state(token)};
}
export async function handle(req:Request):Promise<Response>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return respond({error:'POST required'},405);
 try{
 const b=await req.json();const token=req.headers.get('x-tackpath-session')||b.token||'';
 if(b.action==='login'||b.action==='driver_request'){
  const slug=String(b.slug||'').trim().toLowerCase();const ip=req.headers.get('x-forwarded-for')||'unknown';
  if(!await rpc('ops_login_limit',{p_key:await hash(slug+':'+ip)}))return respond({error:'Too many login attempts; try again later'},429);
  const orgs=await request('/rest/v1/organizations?slug=eq.'+encodeURIComponent(slug)+'&select=id,name,slug,access_code');const org=orgs[0];
  if(!org||b.action==='login'&&(!org.access_code||org.access_code!==b.code))return respond({error:'Invalid organization or access code'},401);
  if(b.action==='login'){
   const token=crypto.randomUUID()+crypto.randomUUID();const role=b.role==='warehouse'?'warehouse':'dispatcher';
   await rpc('ops_create_session',{p_org:org.id,p_actor:org.id,p_role:role,p_token_hash:await hash(token)});
   return respond({token,org:{id:org.id,name:org.name,slug:org.slug},actor_id:org.id,role});
  }
  const digits=String(b.phone||'').replace(/\D/g,'');if(!/^1?\d{10}$/.test(digits))return respond({error:'Enter a valid phone number'},400);
  const normalized=digits.length===11?digits.slice(1):digits;
  const allDrivers=await request('/rest/v1/drivers?select=id,name,phone,org_id&ops_disabled=eq.false');
  const matches=allDrivers.filter((d:any)=>String(d.phone||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'')===normalized&&d.org_id===org.id);
  if(matches.length!==1)return respond({error:'Driver registration is missing or ambiguous'},409);
  const sid=Deno.env.get('TWILIO_ACCOUNT_SID'),secret=Deno.env.get('TWILIO_AUTH_TOKEN');if(!sid||!secret)throw new Error('Verification delivery is unavailable');
  const random=new Uint32Array(1);crypto.getRandomValues(random);const otp=String(random[0]%1000000).padStart(6,'0');const challenge=crypto.randomUUID();
  await rpc('ops_login_challenge',{p_id:challenge,p_org:org.id,p_driver:matches[0].id,p_hash:await hash(challenge+':'+otp)});
  const sms=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+sid+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+btoa(sid+':'+secret),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:'+1'+normalized,From:Deno.env.get('TWILIO_FROM_NUMBER')||'+16782745974',Body:'TackPath driver verification: '+otp+'. Expires in 5 minutes.'})});
  if(!sms.ok)throw new Error('Verification message could not be sent');return respond({challenge});
 }
 if(b.action==='driver_verify'){
  const token=crypto.randomUUID()+crypto.randomUUID();const result=await rpc('ops_verify_challenge',{p_id:b.challenge,p_hash:await hash(b.challenge+':'+b.code),p_token_hash:await hash(token)});
  if(result.error)return respond(result,401);return respond({...result,token});
 }
 if(b.action==='manage_driver')return respond(await rpc('ops_manage_driver',{p_token:token,p_driver:b.driver_id,p_name:b.name??null,p_phone:b.phone??null,p_disabled:b.disabled??null}));
 if(b.action==='legacy'){
  const scoped=await state(token);const path=new URL('https://local/'+String(b.path||''));const table=path.pathname.slice(1);const read=b.method==='GET';
  const direct=['jobs','drivers','messages','driver_locations','agent_memory','driver_fcm_tokens','organizations'];if(!direct.includes(table))throw new Error('Resource not available through operational access');
  if(!read){
   if(b.method!=='POST'||!['messages','driver_locations','agent_memory','driver_fcm_tokens'].includes(table))throw new Error('Use an authoritative operational command');
   const payload={...b.body};const allowedRoute=scoped.routes.find((r:any)=>r.id===payload.job_id);
   if(table!=='agent_memory'&&table!=='driver_fcm_tokens'&&!allowedRoute)throw new Error('Route access denied');
   if(table==='messages'){payload.org_id=scoped.organization.id;payload.sender_role=scoped.role==='driver'?'driver':'dispatcher';payload.sender=scoped.role==='driver'?(scoped.drivers.find((d:any)=>d.id===scoped.actor_id)?.name||'Driver'):'Dispatcher'}
   if(table==='driver_locations'){if(scoped.role!=='driver'||allowedRoute.driver_id!==scoped.actor_id)throw new Error('Location access denied');payload.driver_name=scoped.drivers[0]?.name}
   if(table==='agent_memory'){if(payload.job_id&&!allowedRoute)throw new Error('Route access denied');payload.org_id=scoped.organization.id}
   if(table==='driver_fcm_tokens'){if(scoped.role!=='driver')throw new Error('Driver authentication required');payload.driver_name=scoped.drivers[0]?.name;payload.phone=scoped.drivers[0]?.phone;return respond(await request('/rest/v1/'+table+'?on_conflict=phone',payload,'POST','resolution=merge-duplicates,return=representation'))}
   return respond(await request('/rest/v1/'+table,payload));
  }
  if(table==='organizations')return respond([{id:scoped.organization.id,name:'Organization'}]);
  if(table==='drivers')return respond(scoped.drivers);
  path.searchParams.delete('apikey');path.searchParams.delete('or');
  if(['jobs','messages','agent_memory'].includes(table))path.searchParams.set('org_id','eq.'+scoped.organization.id);
  if(table==='jobs'&&scoped.role==='driver')path.searchParams.set('id','in.('+scoped.routes.map((r:any)=>r.id).join(',')+')');
  if(table==='driver_locations'||table==='messages'){if(!scoped.routes.length)return respond([]);path.searchParams.set('job_id','in.('+scoped.routes.map((r:any)=>r.id).join(',')+')')}
  if(table==='driver_fcm_tokens')return respond([]);
  return respond(await request('/rest/v1/'+table+'?'+path.searchParams));
 }
 if(b.action==='state')return respond(await state(token));
 if(b.action==='logout'){await rpc('ops_revoke_session',{p_token:token});return respond({success:true})}
 if(b.action==='command')return respond(await command(token,b.kind,b.payload,b.id));
 if(b.action==='manifest'){
  const rows=parseManifest(String(b.text||''));const canonical=JSON.stringify(rows);const fingerprint=await hash(canonical);
  if(rows.length>10000||rows.reduce((sum:number,row:any)=>sum+(row.packages||0),0)>50000)return respond({error:'Manifest exceeds 10,000 rows or 50,000 physical pieces; split the upload'},413);
  const intake=await command(token,'intake',{warehouse_id:b.warehouse_id,source:b.source||'csv',external_id:b.external_id||fingerprint,content_hash:fingerprint,raw_text:String(b.text||''),rows},b.id||crypto.randomUUID());
  return respond(await processManifest(token,intake.manifest_id));
 }
 if(b.action==='resume')return respond(await processManifest(token,b.manifest_id));
 if(b.action==='proof_upload'){
  const s=await state(token);const proof=s.proofs.find((p:any)=>p.id===b.proof_id);if(!proof||s.role!=='driver'||proof.driver_id!==s.actor_id)throw new Error('Proof not authorized');
  const match=String(b.data_url||'').match(/^data:(image\/(?:png|jpeg));base64,(.+)$/s);if(!match)throw new Error('Invalid proof image');
  if(match[2].length>14000000)throw new Error('Proof image exceeds upload limit');
  const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));const contentHash=await hash(bytes);if(contentHash!==proof.content_hash)throw new Error('Proof content changed');
  const path='/storage/v1/object/ops-pod/'+proof.object_path;
  const response=await fetch(URL_BASE+path,{method:'POST',headers:{apikey:SERVICE,Authorization:'Bearer '+SERVICE,'Content-Type':match[1],'x-upsert':'true'},body:bytes});
  if(!response.ok)throw Object.assign(new Error('Proof upload failed; retained for retry'),{status:503});
  await rpc('ops_proof_uploaded',{p_token:token,p_proof:proof.id,p_hash:contentHash});return respond({uploaded:true,proof_id:proof.id});
 }
 if(b.action==='proof_url'){
  const s=await state(token);const proof=s.proofs.find((p:any)=>p.id===b.proof_id);if(!proof?.uploaded_at)throw new Error('Proof not available');
  const result=await request('/storage/v1/object/sign/ops-pod/'+proof.object_path,{expiresIn:300});return respond({url:URL_BASE+'/storage/v1'+result.signedURL});
 }
 return respond({error:'Unknown operation'},400);
 }catch(e){const message=String(e.message||e);return respond({error:message},/Authentication|JWT|session|access denied/i.test(message)?401:(e.status>=500?503:409))}
}
if(import.meta.main)Deno.serve(handle);
