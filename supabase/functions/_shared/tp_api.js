// TackPath Public API v1: the HTTP layer of the "api" and "api-webhooks" edge
// functions. Plain JavaScript (runs in Deno and is tested under Node).
//
// Authorization, tenant isolation, rate limits, idempotency, validation of the
// order fields and the audit log are enforced by the database gateway
// public.tp_svc_api (migration 69), which only the service role can call.
// This layer: routing, request size and shape, the webhook URL guard (DNS,
// private networks), short-lived links for proof-of-delivery media, response
// headers, and the webhook worker (signing, sending, retry reporting).
import { ALLOWED_ORIGINS, timingSafeEqual } from './tp_security.js';

export const API_VERSION = 'v1';
export const MAX_BODY_BYTES = 1_000_000;          // 1 MB (a batch of 500 orders fits)
export const POD_LINK_SECONDS = 900;              // proof-of-delivery media links: 15 minutes
export const SIGNATURE_TOLERANCE_SECONDS = 300;   // receivers should reject older signatures
const ID = /^[A-Za-z0-9._:-]{1,64}$/;

// ── Routing ───────────────────────────────────────────────────────────────
// [method, path pattern, op, auth] — auth: 'any' (key or session), 'session' (developer page only), 'none'
export const ROUTES = [
  ['GET', '/health', 'health', 'none'],
  ['POST', '/orders', 'orders.create', 'any'],
  ['POST', '/orders/batch', 'orders.batch', 'any'],
  ['GET', '/orders', 'orders.list', 'any'],
  ['GET', '/orders/:id', 'orders.get', 'any'],
  ['GET', '/orders/:id/events', 'orders.events', 'any'],
  ['GET', '/orders/:id/proof-of-delivery', 'orders.pod', 'any'],
  ['GET', '/batches/:id', 'batches.get', 'any'],
  ['GET', '/tracking/:id', 'tracking.get', 'any'],
  ['GET', '/routes', 'routes.list', 'any'],
  ['GET', '/routes/:id', 'routes.get', 'any'],
  ['POST', '/webhooks', 'webhooks.create', 'any'],
  ['GET', '/webhooks', 'webhooks.list', 'any'],
  ['GET', '/webhooks/:id', 'webhooks.get', 'any'],
  ['PATCH', '/webhooks/:id', 'webhooks.update', 'any'],
  ['DELETE', '/webhooks/:id', 'webhooks.delete', 'any'],
  ['POST', '/webhooks/:id/rotate-secret', 'webhooks.rotate', 'any'],
  ['POST', '/webhooks/:id/test', 'webhooks.test', 'any'],
  ['GET', '/webhooks/:id/deliveries', 'webhooks.deliveries', 'any'],
  ['GET', '/events', 'events.list', 'any'],
  ['GET', '/admin/keys', 'keys.list', 'session'],
  ['POST', '/admin/keys', 'keys.create', 'session'],
  ['POST', '/admin/keys/:id/revoke', 'keys.revoke', 'session'],
  ['POST', '/admin/keys/:id/rotate', 'keys.rotate', 'session'],
];
export const QUERY = {
  'orders.list': ['status', 'external_id', 'tracking_number', 'created_after', 'created_before', 'limit', 'cursor'],
  'routes.list': ['status', 'created_after', 'limit', 'cursor'],
  'events.list': ['limit', 'cursor'],
};

// The path after the API version: ".../functions/v1/api/v1/orders/x" -> "/orders/x"
export function apiPath(pathname) {
  const i = pathname.lastIndexOf('/' + API_VERSION + '/');
  if (i >= 0) return pathname.slice(i + API_VERSION.length + 1).replace(/\/+$/, '') || '/';
  if (pathname.endsWith('/' + API_VERSION)) return '/';
  return null;
}

export function matchRoute(method, path) {
  let pathMatched = false;
  for (const [m, pattern, op, auth] of ROUTES) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:id/g, () => { keys.push('id'); return '([^/]+)'; }) + '$');
    const hit = path.match(re);
    if (!hit) continue;
    pathMatched = true;
    if (m !== method) continue;
    return { op, auth, id: hit[1] ? decodeURIComponent(hit[1]) : undefined };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

// ── Responses ─────────────────────────────────────────────────────────────
const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
export const newRequestId = () => 'req_' + randomHex(12);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key, x-tackpath-session',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'x-request-id, x-ratelimit-limit, x-ratelimit-remaining, retry-after, idempotent-replayed',
    'Vary': 'Origin',
  };
}

function reply(status, body, requestId, extra = {}) {
  return { status, body, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId, ...extra } };
}
function error(status, code, message, requestId, extra = {}) {
  return reply(status, { error: { code, message, request_id: requestId } }, requestId, extra);
}

// ── Webhook destinations: no private networks (SSRF) ──────────────────────
export function isPublicIp(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;              // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;    // carrier-grade NAT
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff')) return false;
  if (v6.startsWith('::ffff:')) return isPublicIp(v6.slice(7));
  return v6.includes(':');
}

// Checks the URL shape and that every address the host resolves to is public.
export async function checkWebhookUrl(url, resolve) {
  let u;
  try { u = new URL(url); } catch { return 'url is not a valid URL'; }
  if (u.protocol !== 'https:') return 'url must be an https:// address';
  if (u.username || u.password) return 'url must not contain credentials';
  if (u.port && u.port !== '443') return 'url must use port 443';
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host === 'localhost' || !/\.[a-z]{2,}$/.test(host)
      || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) {
    return 'url must use a public host name (no IP addresses or internal names)';
  }
  let ips;
  try { ips = await resolve(host); } catch { return 'url host name does not resolve'; }
  if (!ips || ips.length === 0) return 'url host name does not resolve';
  if (!ips.every(isPublicIp)) return 'url resolves to a private or reserved address';
  return null;
}

// ── Webhook signatures ────────────────────────────────────────────────────
// TackPath-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signWebhook(secret, rawBody, timestamp) {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}
// What a receiver does (also in the docs): true only for a fresh, valid signature.
export async function verifyWebhook(secret, rawBody, header, { now = Date.now(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  return timingSafeEqual(await hmacHex(secret, `${t}.${rawBody}`), parts.v1);
}

// ── POD media links ───────────────────────────────────────────────────────
async function signMedia(pod, storage) {
  const media = [];
  for (const m of pod.media || []) {
    const s = await storage.sign(m.path, POD_LINK_SECONDS);
    if (s.ok) media.push({ kind: m.kind, url: s.url, expires_at: new Date(Date.now() + POD_LINK_SECONDS * 1000).toISOString() });
  }
  return { ...pod, media };
}

// ── The API handler ───────────────────────────────────────────────────────
// deps: { rpc(fn, args) -> {data|error}, storage: {sign}, resolve(host) -> [ip], log }
export async function handleApi(req, deps) {
  const requestId = newRequestId();
  const url = new URL(req.url);
  const path = apiPath(url.pathname);
  if (path === null) return error(404, 'unknown_endpoint', 'Use /' + API_VERSION + '/...', requestId);
  const route = matchRoute(req.method, path);
  if (!route) return error(404, 'unknown_endpoint', 'No such endpoint', requestId);
  if (route.methodNotAllowed) return error(405, 'method_not_allowed', 'This method is not allowed here', requestId);
  if (route.op === 'health') return reply(200, { ok: true, api_version: API_VERSION }, requestId);
  if (route.id !== undefined && !ID.test(route.id)) return error(404, 'not_found', 'No such resource', requestId);

  // credentials: an API key, or (developer page) a company session
  const auth = req.headers.get('authorization') || '';
  const session = req.headers.get('x-tackpath-session') || '';
  const args = { op: route.op, id: route.id, request_id: requestId, method: req.method, path: url.pathname.slice(0, 300) };
  if (route.auth === 'session') {
    if (!session) return error(401, 'invalid_session', 'Sign in on the TackPath developer page', requestId);
    args.session = session;
  } else if (/^Bearer\s+/i.test(auth)) {
    args.key = auth.replace(/^Bearer\s+/i, '').trim();
  } else if (session) {
    args.session = session;
  } else {
    return error(401, 'invalid_api_key', 'Send your API key as: Authorization: Bearer tpk_live_...', requestId,
                 { 'WWW-Authenticate': 'Bearer' });
  }

  // query string: known parameters only
  const allowed = QUERY[route.op] || [];
  const query = {};
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k)) return error(400, 'invalid_parameter', `Unknown query parameter: ${k}`, requestId);
    if (v.length > 300) return error(400, 'invalid_parameter', `${k} is too long`, requestId);
    query[k] = v;
  }
  if (query.limit !== undefined && !/^\d{1,3}$/.test(query.limit)) return error(400, 'invalid_parameter', 'limit: 1-200', requestId);
  for (const k of ['created_after', 'created_before']) {
    if (query[k] !== undefined && Number.isNaN(Date.parse(query[k]))) return error(400, 'invalid_parameter', `${k}: an ISO 8601 date-time`, requestId);
  }
  args.query = query;

  // body: JSON object, at most 1 MB
  if (['POST', 'PATCH'].includes(req.method)) {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > MAX_BODY_BYTES) return error(413, 'payload_too_large', 'The request body is over 1 MB', requestId);
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return error(413, 'payload_too_large', 'The request body is over 1 MB', requestId);
    if (text.trim() !== '') {
      if (!/application\/json/i.test(req.headers.get('content-type') || '')) {
        return error(415, 'unsupported_media_type', 'Send Content-Type: application/json', requestId);
      }
      let body;
      try { body = JSON.parse(text); } catch { return error(400, 'invalid_json', 'The request body is not valid JSON', requestId); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'invalid_json', 'The request body must be a JSON object', requestId);
      args.body = body;
    } else {
      args.body = {};
    }
    const idem = req.headers.get('idempotency-key');
    if (idem !== null) args.idempotency_key = idem;
    // webhook destinations must be public (checked before anything is stored)
    if (['webhooks.create', 'webhooks.update'].includes(route.op) && typeof args.body.url === 'string') {
      const bad = await checkWebhookUrl(args.body.url, deps.resolve);
      if (bad) return error(422, 'invalid_url', bad, requestId);
    }
  }

  const r = await deps.rpc('tp_svc_api', { p_action: 'request', p_args: args });
  if (r.error || !r.data) {
    deps.log?.('api gateway error', requestId, r.error && r.error.message);
    return error(500, 'internal_error', 'Something went wrong on our side. Please retry later', requestId);
  }
  let { status, body, headers = {} } = r.data;
  if (body && body.error) body = { error: { ...body.error, request_id: requestId } };
  if (route.op === 'orders.pod' && status === 200) body = await signMedia(body, deps.storage);
  return reply(status, body, requestId, headers);
}

// For Deno.serve: CORS preflight, JSON out, never a stack trace.
export function serveApi(deps) {
  return async (req) => {
    const cors = corsHeaders(req.headers.get('origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let out;
    try { out = await handleApi(req, deps); }
    catch (e) { deps.log?.('api unexpected', e && e.message); out = error(500, 'internal_error', 'Something went wrong on our side. Please retry later', newRequestId()); }
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...cors, ...out.headers } });
  };
}

// ── The webhook worker ────────────────────────────────────────────────────
// Takes due deliveries, sends each once (10 s timeout, no redirects), reports
// the result; the database schedules retries (1m, 5m, 30m, 2h, 6h, 12h, 24h).
export async function runWebhooks(deps, { limit = 25 } = {}) {
  const claimed = await deps.rpc('tp_svc_api', { p_action: 'claim', p_args: { limit } });
  if (claimed.error) { deps.log?.('webhook claim failed', claimed.error.message); return { sent: 0, failed: 0, error: true }; }
  let sent = 0, failed = 0;
  for (const d of claimed.data || []) {
    const raw = JSON.stringify(d.event);
    const t = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
    const started = Date.now();
    let ok = false, statusCode = null, err = null;
    const bad = await checkWebhookUrl(d.url, deps.resolve);
    if (bad) {
      err = bad;
    } else {
      try {
        const res = await deps.fetch(d.url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
          headers: {
            'Content-Type': 'application/json', 'User-Agent': 'TackPath-Webhooks/1',
            'TackPath-Signature': await signWebhook(d.secret, raw, t),
            'TackPath-Event-Id': d.event.id, 'TackPath-Event-Type': d.event.type,
            'TackPath-Delivery-Id': d.delivery_id, 'TackPath-Delivery-Attempt': String(d.attempt),
          },
          body: raw,
        });
        statusCode = res.status;
        ok = res.status >= 200 && res.status < 300;
        if (!ok) err = `HTTP ${res.status}`;
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
      } catch (e) {
        err = (e && e.name === 'TimeoutError') ? 'timeout after 10 s' : 'connection failed';
      }
    }
    await deps.rpc('tp_svc_api', { p_action: 'report', p_args: { delivery_id: d.delivery_id, ok, status_code: statusCode,
      error: err, duration_ms: Date.now() - started } });
    if (ok) sent++; else failed++;
  }
  return { sent, failed };
}

// Scheduled caller (pg_cron) must send the cron secret, as swarm-watch does.
export async function handleWebhookWorker(req, deps) {
  const got = req.headers.get('x-tp-cron-secret') || '';
  if (!deps.cronSecret || !timingSafeEqual(got, deps.cronSecret)) return { status: 401, body: { error: 'unauthorized' } };
  return { status: 200, body: await runWebhooks(deps) };
}

// Deno DNS lookup (A and AAAA); in tests a stub is passed instead.
export function denoResolver() {
  return async (host) => {
    const out = [];
    for (const type of ['A', 'AAAA']) {
      try { out.push(...await Deno.resolveDns(host, type)); } catch { /* no records of this type */ }
    }
    return out;
  };
}
