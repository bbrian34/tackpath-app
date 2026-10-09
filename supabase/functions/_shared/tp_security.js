// Shared logic for TackPath's secured edge functions (send-sms, driver-login,
// pod) and the Shopify webhook signature check. Plain JavaScript with no
// Deno-only imports, so the same code is unit-tested under Node
// (tests/security/edge.test.mjs). The index.ts files only wire in env and fetch.
//
// deps:
//   rpc(fn, args)  -> calls a Postgres RPC with the SERVICE ROLE key;
//                     resolves {data} or {error:{message}}
//   sms(to, body)  -> sends one SMS through Twilio; resolves {ok, sid?, error?}
//   storage        -> { upload(path, bytes, contentType), sign(path, seconds) }
//   log(...args)   -> optional logger

export const ALLOWED_ORIGINS = [
  'https://tackpath.com', 'https://www.tackpath.com',
  'https://localhost',        // driver app WebView (Capacitor, Android)
  'capacitor://localhost',    // driver app WebView (Capacitor, iOS)
];

export function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const json = (status, body) => ({ status, body });
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const authFailed = (e) => /TP_AUTH/.test(String(e && e.message || e));

async function readJson(req) {
  if (req.method !== 'POST') return { error: json(405, { error: 'POST only' }) };
  try {
    const text = await req.text();
    if (text.length > 8_000_000) return { error: json(413, { error: 'Request too large' }) };
    const body = JSON.parse(text || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: json(400, { error: 'JSON object expected' }) };
    return { body };
  } catch {
    return { error: json(400, { error: 'Invalid JSON' }) };
  }
}

// ── send-sms ──────────────────────────────────────────────────────────────
// The ONLY message this sends is the fixed driver-assignment text. The caller
// passes its company session and a job id; the database decides whether a
// text may go out, to whom, and what it says (tp_svc_assignment_sms).
export async function handleSendSms(req, deps) {
  const { body, error } = await readJson(req);
  if (error) return error;
  if ('to' in body || 'body' in body || 'phone' in body || 'message' in body) {
    return json(400, { error: 'The recipient and the text are decided by the server. Send {session, job_id}.' });
  }
  if (!isStr(body.session, 200) || !isStr(body.job_id, 100)) {
    return json(400, { error: 'session and job_id are required' });
  }
  const r = await deps.rpc('tp_svc_assignment_sms', { p_token: body.session, p_job_id: body.job_id });
  if (r.error) return authFailed(r.error) ? json(401, { error: 'Please sign in again' }) : json(500, { error: 'Could not check the job' });
  const plan = r.data || {};
  if (!plan.send) return json(200, { sent: false, reason: plan.reason || 'not_sent' });
  const sent = await deps.sms(plan.to, plan.body);
  if (!sent.ok) {
    deps.log?.('send-sms twilio error', sent.error);
    return json(502, { sent: false, reason: 'sms_provider_error' });
  }
  return json(200, { sent: true, sid: sent.sid });
}

// ── driver-login ──────────────────────────────────────────────────────────
// Sends a one-time sign-in code to a registered, approved driver's phone.
// Always answers the same way, so it cannot be used to find out which numbers
// are drivers. Codes are created, hashed and rate-limited in the database.
export async function handleDriverLogin(req, deps) {
  const { body, error } = await readJson(req);
  if (error) return error;
  if (!isStr(body.phone, 40)) return json(400, { error: 'phone is required' });
  const r = await deps.rpc('tp_svc_driver_code', { p_phone: body.phone });
  if (r.error) {
    deps.log?.('driver-login rpc error', r.error.message);
    return json(500, { error: 'Could not send a code right now' });
  }
  const plan = r.data || {};
  if (plan.send) {
    const sent = await deps.sms(plan.to,
      `TackPath sign-in code: ${plan.code}. It expires in 10 minutes. Do not share this code. Reply STOP to opt out.`);
    if (!sent.ok) deps.log?.('driver-login twilio error', sent.error);
  }
  return json(200, { ok: true, message: 'If this number belongs to an approved TackPath driver, a code is on its way.' });
}

// ── pod ───────────────────────────────────────────────────────────────────
// Proof of delivery lives in the private "pod" bucket.
//   upload: the assigned driver stores a photo or signature for their job
//   sign:   the job's company gets a link that works for 1 hour
const POD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const POD_MAX_BYTES = 6 * 1024 * 1024;

export async function handlePod(req, deps) {
  const { body, error } = await readJson(req);
  if (error) return error;
  if (!isStr(body.session, 200) || !isStr(body.job_id, 100)) return json(400, { error: 'session and job_id are required' });
  if (!/^[A-Za-z0-9-]+$/.test(body.job_id)) return json(400, { error: 'invalid job_id' });

  if (body.action === 'upload') {
    const ext = POD_TYPES[body.content_type];
    if (!ext) return json(400, { error: 'content_type must be image/jpeg, image/png or image/webp' });
    if (!['photo', 'signature'].includes(body.kind)) return json(400, { error: 'kind must be photo or signature' });
    const stop = Number.isInteger(body.stop) && body.stop >= 0 && body.stop < 10000 ? body.stop : 1;
    if (!isStr(body.data, 9_000_000)) return json(400, { error: 'data (base64) is required' });
    let bytes;
    try { bytes = Uint8Array.from(atob(body.data.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0)); }
    catch { return json(400, { error: 'data is not valid base64' }); }
    if (bytes.length === 0 || bytes.length > POD_MAX_BYTES) return json(413, { error: 'image must be 1 byte to 6 MB' });
    const ok = await deps.rpc('tp_svc_pod', { p_token: body.session, p_kind: 'driver', p_job_id: body.job_id });
    if (ok.error) return authFailed(ok.error) ? json(401, { error: 'Please sign in again' }) : json(500, { error: 'Could not check the job' });
    if (!ok.data || ok.data.ok !== true) return json(403, { error: 'This route is not assigned to you' });
    const path = `${body.job_id}/stop-${stop}-${body.kind}-${deps.now ? deps.now() : Date.now()}.${ext}`;
    const up = await deps.storage.upload(path, bytes, body.content_type);
    if (!up.ok) return json(502, { error: 'Upload failed' });
    return json(200, { path });
  }

  if (body.action === 'sign') {
    if (!isStr(body.path, 300) || !body.path.startsWith(body.job_id + '/') || body.path.includes('..')) {
      return json(400, { error: 'path must belong to job_id' });
    }
    const ok = await deps.rpc('tp_svc_pod', { p_token: body.session, p_kind: 'org', p_job_id: body.job_id });
    if (ok.error) return authFailed(ok.error) ? json(401, { error: 'Please sign in again' }) : json(500, { error: 'Could not check the job' });
    if (!ok.data || ok.data.ok !== true) return json(403, { error: 'Not one of your jobs' });
    const s = await deps.storage.sign(body.path, 3600);
    if (!s.ok) return json(404, { error: 'Not found' });
    return json(200, { url: s.url, expires_in: 3600 });
  }
  return json(400, { error: 'action must be upload or sign' });
}

// ── Shopify webhook signature ─────────────────────────────────────────────
// X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app secret, raw request body))
export async function verifyShopifyHmac(rawBody, headerValue, secret) {
  if (!secret || !headerValue) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  let expected;
  try { expected = Uint8Array.from(atob(headerValue.trim()), (c) => c.charCodeAt(0)); } catch { return false; }
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ expected[i];   // constant time
  return diff === 0;
}

// ── Session guard for the other edge functions ────────────────────────────
// smooth-api, nav-proxy, smartsort, sponge and swarm-watch run with the
// service role or the Google server key, so they must not answer strangers.
// A request passes with a live TackPath session of an allowed kind, sent as
// body.session (JSON body) or the x-tp-session header, or, for scheduled
// jobs, with the x-tp-cron-secret header matching the CRON_SECRET secret.
// Returns {req, session} (req can be read again) or {response} (401).
export async function guardRequest(req, deps, { kinds = ['org', 'driver'], cors = {} } = {}) {
  const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const rebuilt = () => new Request(req.url, { method: req.method, headers: req.headers, body: raw || undefined });
  const cron = req.headers.get('x-tp-cron-secret') || '';
  if (deps.cronSecret && cron && timingSafeEqual(cron, deps.cronSecret)) {
    return { req: rebuilt(), session: { kind: 'cron' } };
  }
  let token = req.headers.get('x-tp-session') || '';
  if (!token && raw) { try { const b = JSON.parse(raw); if (b && typeof b.session === 'string') token = b.session; } catch { /* not JSON */ } }
  if (token && token.length <= 200) {
    const r = await deps.rpc('tp_svc_session', { p_token: token });
    if (r.data && r.data.ok === true && kinds.includes(r.data.kind)) return { req: rebuilt(), session: r.data };
  }
  return { response: new Response(JSON.stringify({ error: 'Sign in required' }),
    { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } }) };
}

export function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ── Shopify OAuth: signed state ───────────────────────────────────────────
// A shop can only be linked to the company that started the flow: the
// dispatcher starts it with its company session, and the state carries that
// company, the shop and an expiry, signed with the Shopify app secret. The
// callback also checks Shopify's own signature on the query string.
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function hmacBytes(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export const isShopDomain = (shop) => typeof shop === 'string' && /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(shop);

export async function signOAuthState({ org, shop, ttlSeconds = 900, now = Date.now() }, secret) {
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not set');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ org, shop, exp: Math.floor(now / 1000) + ttlSeconds, n: b64url(nonce) })));
  return payload + '.' + b64url(await hmacBytes(secret, payload));
}

export async function verifyOAuthState(state, secret, { shop, now = Date.now() } = {}) {
  if (!secret || typeof state !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) return null;
  const [payload, sig] = state.split('.');
  if (!timingSafeEqual(b64url(await hmacBytes(secret, payload)), sig)) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(unb64url(payload))); } catch { return null; }
  if (!data || typeof data.org !== 'string' || !data.org || data.exp < Math.floor(now / 1000)) return null;
  if (shop !== undefined && data.shop !== shop) return null;
  return data;
}

// Shopify signs the OAuth callback query: hex HMAC-SHA256 of the other
// parameters sorted by name, joined as k=v&k=v.
export async function verifyShopifyQueryHmac(searchParams, secret) {
  const given = searchParams.get('hmac') || '';
  if (!secret || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const msg = [...searchParams.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const hex = [...(await hmacBytes(secret, msg))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, given.toLowerCase());
}

// POST {action:'start', session, shop} from the dispatcher -> {url}
export async function handleShopifyStart(req, deps) {
  const { body, error } = await readJson(req);
  if (error) return error;
  if (body.action !== 'start') return json(400, { error: 'Start the Shopify connection from the TackPath dispatcher' });
  const shop = String(body.shop || '').trim().toLowerCase();
  if (!isShopDomain(shop)) return json(400, { error: 'Enter your store as name.myshopify.com' });
  if (!isStr(body.session, 200)) return json(401, { error: 'Please sign in again' });
  const r = await deps.rpc('tp_svc_session', { p_token: body.session });
  if (!r.data || r.data.ok !== true || r.data.kind !== 'org' || !r.data.org_id) return json(401, { error: 'Please sign in again' });
  const state = await signOAuthState({ org: r.data.org_id, shop, now: deps.now ? deps.now() : Date.now() }, deps.shopifySecret);
  const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(deps.shopifyApiKey)}`
    + `&scope=${encodeURIComponent(deps.scopes)}&redirect_uri=${encodeURIComponent(deps.redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;
  return json(200, { url });
}

// GET callback ?code&shop&state&hmac&timestamp -> {org, shop} or {error}
export async function checkShopifyCallback(url, deps) {
  const q = url.searchParams;
  const shop = q.get('shop') || '';
  if (!isShopDomain(shop)) return { error: 'Invalid shop' };
  if (!(await verifyShopifyQueryHmac(q, deps.shopifySecret))) return { error: 'Invalid Shopify signature' };
  const st = await verifyOAuthState(q.get('state') || '', deps.shopifySecret, { shop, now: deps.now ? deps.now() : Date.now() });
  if (!st) return { error: 'This link has expired or was not started from your TackPath account. Start again from the dispatcher.' };
  return { org: st.org, shop };
}

// ── Deno wiring helpers (used by the index.ts files) ─────────────────────
export function serviceRpc(sbUrl, serviceKey, fetchImpl = fetch) {
  return async (fn, args) => {
    const r = await fetchImpl(`${sbUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) {
      let message = text;
      try { message = JSON.parse(text).message || text; } catch { /* plain text */ }
      return { error: { message } };
    }
    return { data: text ? JSON.parse(text) : null };
  };
}

export function twilioSms(accountSid, authToken, from, fetchImpl = fetch) {
  return async (to, body) => {
    if (!accountSid || !authToken) return { ok: false, error: 'Twilio credentials are not set' };
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, sid: data.sid } : { ok: false, error: data };
  };
}

export function podStorage(sbUrl, serviceKey, fetchImpl = fetch) {
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  return {
    async upload(path, bytes, contentType) {
      const r = await fetchImpl(`${sbUrl}/storage/v1/object/pod/${enc(path)}`, {
        method: 'POST', headers: { ...h, 'Content-Type': contentType, 'x-upsert': 'false' }, body: bytes,
      });
      return { ok: r.ok };
    },
    async sign(path, seconds) {
      const r = await fetchImpl(`${sbUrl}/storage/v1/object/sign/pod/${enc(path)}`, {
        method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }),
      });
      if (!r.ok) return { ok: false };
      const d = await r.json();
      return { ok: true, url: `${sbUrl}/storage/v1${d.signedURL || d.signedUrl}` };
    },
  };
}

// Wraps a handler for Deno.serve: CORS preflight, JSON response, never leaks a stack.
export function serveJson(handler, deps) {
  return async (req) => {
    const cors = corsFor(req.headers.get('origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let out;
    try { out = await handler(req, deps); }
    catch (e) { deps.log?.('unexpected', e && e.message); out = json(500, { error: 'Unexpected failure' }); }
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  };
}
