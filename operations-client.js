/* Shared operational client: acknowledgements, scoped state and durable retries. */
(function(global){
 const endpoint='https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/ops-api';
 const key='tp_ops_session';let snapshot=null,loginPromise=null,refreshPromise=null;
 let session;try{session=JSON.parse(localStorage.getItem(key)||'null')}catch{session=null}
 const nativeFetch=global.fetch.bind(global);
 const listeners=new Set();
 const inflight=new Map();
 const retryable=e=>!e.status||e.status===429||e.status>=500;
 function locked(id,fn){if(inflight.has(id))return inflight.get(id);const promise=fn().finally(()=>inflight.delete(id));inflight.set(id,promise);return promise}
 function emit(){for(const fn of listeners)try{fn(snapshot)}catch(e){console.error(e)}}
 async function api(body){const res=await nativeFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'x-tackpath-session':session.token}:{})},body:JSON.stringify(body)});let data;try{data=await res.json()}catch{throw new Error('Server response unavailable; operation remains pending')};if(!res.ok){const e=new Error(data.error||'Operation failed');e.status=res.status;throw e}return data}
 function saveSession(value){session=value;localStorage.setItem(key,JSON.stringify(value));snapshot=null}
 async function refresh(){if(!session)throw new Error('Sign in required');if(refreshPromise)return refreshPromise;const who=session;refreshPromise=api({action:'state'}).then(async s=>{if(session!==who)throw Error('Account changed during refresh');snapshot=s;await cacheState(who,s).catch(console.error);emit();return s}).catch(async e=>{if(e.status)throw e;const cached=await cacheState(who);if(session!==who||!cached)throw e;snapshot={...cached,_offline:true};emit();return snapshot}).finally(()=>refreshPromise=null);return refreshPromise}
 const dbPromise=new Promise((resolve,reject)=>{const r=indexedDB.open('tackpath-operations',2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('pending'))r.result.createObjectStore('pending',{keyPath:'id'});if(!r.result.objectStoreNames.contains('state'))r.result.createObjectStore('state')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 async function cacheState(who,value){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('state',value===undefined?'readonly':'readwrite'),table=tx.objectStore('state'),id=who.org.id+':'+who.actor_id;let result;const request=value===undefined?table.get(id):table.put(value,id);request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(value===undefined?result:value);tx.onerror=()=>reject(tx.error)})}
 async function store(mode,fn){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('pending',mode);let result;const request=fn(tx.objectStore('pending'));if(request)request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
 async function pending(){return (await store('readonly',s=>s.getAll())).sort((a,b)=>a.at-b.at).filter(x=>session&&x.org===session.org?.id&&x.actor===session.actor_id)}
 async function send(item){return locked(item.id,()=>sendCommand(item))}
 async function sendCommand(item){
  if(!session||item.org!==session.org?.id||item.actor!==session.actor_id)throw new Error('Pending operation belongs to another signed-in account');
  try{const result=await api(item.request);await store('readwrite',s=>s.delete(item.id));return result}
  catch(e){item.error=e.message;item.blocked=!!e.status&&e.status!==429&&e.status<500;await store('readwrite',s=>s.put(item));emit();throw e}
 }
 async function command(kind,payload,id=crypto.randomUUID()){
  if(!session)throw new Error('Sign in required');const item={id,org:session.org.id,actor:session.actor_id,at:Date.now(),request:{action:'command',id,kind,payload}};
  // Durable before transmission; never report success from local state.
  await store('readwrite',s=>s.put(item));const result=await send(item);await refresh();return result;
 }
 let flushing=false;
 async function flush(){if(flushing||!session)return;flushing=true;try{for(const item of await pending()){if(item.blocked)continue;try{if(item.request.action==='proof_workflow')await sendProof(item);else if(item.request.action==='manifest')await sendManifest(item);else await send(item)}catch(e){if(!e.status)break}}await refresh()}finally{flushing=false}}
 async function proof(stop,dataUrl,kind,recipient){
  if(!session)throw new Error('Sign in required');if(!dataUrl)throw new Error('Capture proof first');const bytes=Uint8Array.from(atob(dataUrl.split(',')[1]),c=>c.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const existing=(await pending()).find(p=>p.request.action==='proof_workflow'&&p.request.stop.stop_id===stop.stop_id);
  const item=existing||{id:crypto.randomUUID(),org:session.org.id,actor:session.actor_id,at:Date.now(),request:{action:'proof_workflow',stop:{...stop},proof_id:crypto.randomUUID(),prepare_id:crypto.randomUUID(),deliver_id:crypto.randomUUID(),kind,recipient,data_url:dataUrl,content_hash:hash}};
  await store('readwrite',s=>s.put(item));await sendProof(item);await refresh();
 }
 async function sendProof(item){return locked(item.id,()=>sendProofWorkflow(item))}
 async function sendProofWorkflow(item){
  if(item.org!==session.org.id||item.actor!==session.actor_id)throw new Error('Proof belongs to another account');
  const p=item.request;
  try{await api({action:'command',id:p.prepare_id,kind:'proof_prepare',payload:{...p.stop,proof_id:p.proof_id,kind:p.kind,content_hash:p.content_hash}});await api({action:'proof_upload',proof_id:p.proof_id,data_url:p.data_url});await api({action:'command',id:p.deliver_id,kind:'deliver',payload:{...p.stop,proof_id:p.proof_id,recipient:p.recipient}});await store('readwrite',s=>s.delete(item.id))}
  catch(e){item.error=e.message;item.blocked=!retryable(e);await store('readwrite',s=>s.put(item));throw e}
 }
 async function retry(){for(const p of await pending()){try{p.blocked=false;if(p.request.action==='proof_workflow')await sendProof(p);else if(p.request.action==='manifest')await sendManifest(p);else await send(p)}catch(e){console.error(e)}}return refresh()}
 async function login(slug,code,role='dispatcher'){const result=await api({action:'login',slug,code,role});saveSession(result);await refresh();return result}
 function ensure(role='dispatcher'){
  if(session&&(session.role===role||session.role==='dispatcher'&&role==='warehouse'))return refresh().then(()=>session).catch(e=>{if(e.status===401){session=null;localStorage.removeItem(key);return ensure(role)}throw e});
  if(role==='driver')return Promise.reject(new Error('Driver sign-in required'));
  if(loginPromise)return loginPromise;
  loginPromise=new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.style.cssText='max-width:380px;width:90%;padding:24px;border:1px solid #ccd;border-radius:16px;background:#fff;color:#172339';dialog.innerHTML='<form><h2>TackPath sign in</h2><label>Organization<input name="slug" required autocomplete="organization" style="display:block;width:100%;margin:8px 0 16px"></label><label>Access code<input name="code" type="password" required autocomplete="current-password" style="display:block;width:100%;margin:8px 0 16px"></label><p role="alert"></p><button>Sign in</button></form>';dialog.addEventListener('cancel',e=>e.preventDefault());dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button');b.disabled=true;try{const result=await login(f.slug.value,f.code.value,role);dialog.close();dialog.remove();loginPromise=null;resolve(result)}catch(err){f.querySelector('[role=alert]').textContent=err.message}finally{b.disabled=false}};document.body.append(dialog);dialog.showModal()});return loginPromise;
 }
 async function sendManifest(item){return locked(item.id,()=>sendManifestWorkflow(item))}
 async function sendManifestWorkflow(item){if(!session||item.org!==session.org.id||item.actor!==session.actor_id)throw new Error('Manifest belongs to another account');try{let result=await api(item.request);while(result.more)result=await api({action:'resume',manifest_id:result.manifest_id});await store('readwrite',s=>s.delete(item.id));snapshot=result.state;emit();return result}catch(e){item.error=e.message;item.blocked=!retryable(e);await store('readwrite',s=>s.put(item));throw e}}
 async function importManifest(text,warehouse_id){if(!session)throw new Error('Sign in required');const id=crypto.randomUUID();const item={id,org:session.org.id,actor:session.actor_id,at:Date.now(),request:{action:'manifest',id,text,warehouse_id}};await store('readwrite',s=>s.put(item));return sendManifest(item)}
 function findPackage(code){const value=String(code).trim().toUpperCase();const matches=(snapshot?.packages||[]).filter(p=>p.aliases.includes(value));if(matches.length!==1)throw new Error(matches.length?'Ambiguous barcode':'Package not found');return matches[0]}
 async function logout(){try{await api({action:'logout'})}finally{session=null;snapshot=null;localStorage.removeItem(key);localStorage.removeItem('tp_route_state');localStorage.removeItem('tp_drv');localStorage.removeItem('tp_dispatch_org')}}
 function jobs(){return (snapshot?.routes||[]).map(r=>({...r.job,ops_version:r.version,ops_status:r.status,assigned_driver_id:r.driver_id,stops:r.job.surge_stops}))}
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function labels(routeId){const url=new URL('labels.html',location.href);if(routeId)url.searchParams.set('route',routeId);const win=window.open(url.href,'_blank');if(!win)throw Error('Allow the label window');return win}
 global.fetch=async function(input,options={}){const url=typeof input==='string'?input:input.url;if(url.startsWith('https://hofijsiphyjpdvujjzfi.supabase.co/rest/v1/')){try{const path=url.split('/rest/v1/')[1];const data=await api({action:'legacy',path,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});return new Response(JSON.stringify(data??[]),{status:200,headers:{'Content-Type':'application/json'}})}catch(e){return new Response(JSON.stringify({message:e.message}),{status:e.status||409,headers:{'Content-Type':'application/json'}})}}return nativeFetch(input,options)};
 global.Ops={api,command,refresh,ensure,login,logout,saveSession,importManifest,findPackage,proof,pending,retry,labels,jobs,escape,onChange:fn=>listeners.add(fn),get state(){return snapshot},get session(){return session}};
 window.addEventListener('online',()=>retry().catch(console.error));
 setInterval(()=>{if(session)flush().catch(console.error)},10000);
if(!global.Capacitor&&'serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(console.error);
 function panel(){const script=document.createElement('script');script.src='operations-panel.js';document.head.append(script)}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',panel);else panel();
})(window);
