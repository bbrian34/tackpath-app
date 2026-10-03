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
