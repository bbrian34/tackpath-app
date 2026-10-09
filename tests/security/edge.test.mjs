// Edge functions (send-sms, driver-login, pod, Shopify signature) against the
// real migration in PGlite. Twilio and Storage are recorded, never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDb, rpc, ORG_A, ORG_B } from './fixture.mjs';
import { handleSendSms, handleDriverLogin, handlePod, verifyShopifyHmac, corsFor } from '../../supabase/functions/_shared/tp_security.js';

async function env() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  const texts = []; const stored = {};
  const deps = {
    rpc: async (fn, args) => { try { return { data: await rpc(db, fn, args, 'service_role') }; } catch (e) { return { error: { message: e.message } }; } },
    sms: async (to, body) => { texts.push({ to, body }); return { ok: true, sid: 'SM' + texts.length }; },
    storage: {
      upload: async (path, bytes, type) => { if (stored[path]) return { ok: false }; stored[path] = { bytes, type }; return { ok: true }; },
      sign: async (path) => (stored[path] ? { ok: true, url: 'https://signed.example/' + path + '?token=t' } : { ok: false }),
    },
    now: () => 1700000000000,
  };
  const call = (h, body, method = 'POST') => h(new Request('https://x/fn', { method, body: method === 'POST' ? JSON.stringify(body) : undefined }), deps);
  const org = async (slug = 'quickhaul', code = 'qh-portal-2026') => (await rpc(db, 'tp_org_sign_in', { p_slug: slug, p_code: code })).token;
  const job = async (o = {}) => (await db.query(`insert into public.jobs (org_id, title, status, driver_name) values ($1,$2,$3,$4) returning id`,
    [o.org ?? ORG_A, o.title ?? 'Route 7', o.status ?? 'assigned', o.driver === undefined ? 'Dana Driver' : o.driver])).rows[0].id;
  return { db, texts, stored, deps, call, org, job };
}

test('SMS relay is closed: free-form recipient/text is refused and nothing is sent', async () => {
  const e = await env();
  for (const body of [
    { to: '+15555550100', body: 'Free money http://evil' },
    { phone: '+15555550100', job_id: 'x', type: 'customer_order' },
    { session: await e.org(), job_id: await e.job(), to: '+15555550100' },
    { message: 'hi' }, {},
  ]) {
    const r = await e.call(handleSendSms, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await e.call(handleSendSms, null, 'GET')).status, 405);
  assert.equal(e.texts.length, 0);
});

test('send-sms: only the fixed assignment text, only to the assigned consenting driver of the caller\'s company', async () => {
  const e = await env();
  const tok = await e.org();
  const jid = await e.job({ title: 'Route 7 — see https://phish.example/x now' });
  const r = await e.call(handleSendSms, { session: tok, job_id: jid });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  assert.deepEqual(e.texts, [{ to: '+14045551234',
    body: 'TackPath: You have been assigned a new route: Route 7  see  now. Open the TackPath driver app for details. Reply STOP to opt out.' }]);
  // again within 10 minutes: not sent twice
  assert.equal((await e.call(handleSendSms, { session: tok, job_id: jid })).body.reason, 'rate_limited');
  // no session / wrong session / a driver's session
  assert.equal((await e.call(handleSendSms, { session: 'f'.repeat(64), job_id: jid })).status, 401);
  // another company's job
  const other = await e.job({ org: ORG_B, driver: 'Ollie Other' });
  assert.equal((await e.call(handleSendSms, { session: tok, job_id: other })).body.reason, 'not_your_job');
  // no consent, not assigned, unknown driver
  assert.equal((await e.call(handleSendSms, { session: tok, job_id: await e.job({ driver: 'Ned NoConsent' }) })).body.reason, 'no_consent');
  assert.equal((await e.call(handleSendSms, { session: tok, job_id: await e.job({ status: 'pending', driver: null }) })).body.reason, 'not_assigned');
  assert.equal((await e.call(handleSendSms, { session: tok, job_id: await e.job({ driver: 'Nobody' }) })).body.reason, 'driver_ambiguous');
  assert.equal(e.texts.length, 1, 'still exactly one text');
});

test('send-sms rate limits: 10 per driver per hour', async () => {
  const e = await env();
  const tok = await e.org();
  for (let i = 0; i < 12; i++) await e.call(handleSendSms, { session: tok, job_id: await e.job({ title: 'R' + i }) });
  assert.equal(e.texts.length, 10);
  assert.ok(e.texts.every((t) => t.to === '+14045551234' && t.body.endsWith('Reply STOP to opt out.')));
});

test('driver-login: real code by SMS to approved drivers only; same answer for every number', async () => {
  const e = await env();
  const generic = { ok: true, message: 'If this number belongs to an approved TackPath driver, a code is on its way.' };
  for (const phone of ['4045559999', '4045551236', '(404) 555-0199', 'not a phone']) {
    const r = await e.call(handleDriverLogin, { phone });
    assert.deepEqual([r.status, r.body], [200, generic], phone);
  }
  assert.equal(e.texts.length, 0, 'unknown, unapproved, reviewer and invalid numbers get no text');
  const r = await e.call(handleDriverLogin, { phone: '(404) 555-1234' });
  assert.deepEqual(r.body, generic);
  assert.equal(e.texts.length, 1);
  assert.equal(e.texts[0].to, '+14045551234');
  const code = e.texts[0].body.match(/code: (\d{6})\./)[1];
  assert.match(e.texts[0].body, /Reply STOP to opt out\.$/);
  const s = await rpc(e.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: code });
  assert.equal(s.ok, true);
  // a second request within a minute sends nothing
  await e.call(handleDriverLogin, { phone: '4045551234' });
  assert.equal(e.texts.length, 1);
});

test('pod: only the assigned driver uploads; only the job\'s company views; files are not public', async () => {
  const e = await env();
  const jid = await e.job({ status: 'in_transit' });
  const issued = await rpc(e.db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const dtok = (await rpc(e.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).token;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const up = await e.call(handlePod, { action: 'upload', session: dtok, job_id: jid, stop: 2, kind: 'photo', content_type: 'image/png', data: 'data:image/png;base64,' + png });
  assert.equal(up.status, 200);
  assert.equal(up.body.path, `${jid}/stop-2-photo-1700000000000.png`);
  // someone else's route, a company session, bad inputs
  const other = await e.job({ driver: 'Ned NoConsent' });
  assert.equal((await e.call(handlePod, { action: 'upload', session: dtok, job_id: other, kind: 'photo', content_type: 'image/png', data: png })).status, 403);
  const otok = await e.org();
  assert.equal((await e.call(handlePod, { action: 'upload', session: otok, job_id: jid, kind: 'photo', content_type: 'image/png', data: png })).status, 401);
  assert.equal((await e.call(handlePod, { action: 'upload', session: dtok, job_id: jid, kind: 'photo', content_type: 'text/html', data: png })).status, 400);
  assert.equal((await e.call(handlePod, { action: 'upload', session: dtok, job_id: '../x', kind: 'photo', content_type: 'image/png', data: png })).status, 400);
  // viewing
  const signed = await e.call(handlePod, { action: 'sign', session: otok, job_id: jid, path: up.body.path });
  assert.equal(signed.status, 200);
  assert.match(signed.body.url, /token=/);
  assert.equal((await e.call(handlePod, { action: 'sign', session: otok, job_id: jid, path: other + '/stop-1-photo-1.png' })).status, 400);
  assert.equal((await e.call(handlePod, { action: 'sign', session: otok, job_id: jid, path: jid + '/../other' })).status, 400);
  await e.db.query(`select tp_sec.admin_set_org_code('otherco', 'other-code-123')`);
  const btok = await e.org('otherco', 'other-code-123');
  assert.equal((await e.call(handlePod, { action: 'sign', session: btok, job_id: jid, path: up.body.path })).status, 403);
  assert.equal((await e.call(handlePod, { action: 'sign', session: dtok, job_id: jid, path: up.body.path })).status, 401, 'drivers do not get view links');
});

test('Shopify webhook signature check', async () => {
  const secret = 'shpss_test_secret';
  const raw = JSON.stringify({ fulfillment_order: { id: 1, order_id: 2 } });
  const good = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(await verifyShopifyHmac(raw, good, secret), true);
  assert.equal(await verifyShopifyHmac(raw + ' ', good, secret), false, 'altered body');
  assert.equal(await verifyShopifyHmac(raw, good, 'other'), false, 'wrong secret');
  assert.equal(await verifyShopifyHmac(raw, '', secret), false, 'unsigned');
  assert.equal(await verifyShopifyHmac(raw, good, ''), false, 'secret not configured fails closed');
});

test('CORS allows tackpath.com and the driver app WebView only', () => {
  for (const o of ['https://tackpath.com', 'https://www.tackpath.com', 'https://localhost', 'capacitor://localhost']) {
    assert.equal(corsFor(o)['Access-Control-Allow-Origin'], o);
  }
  assert.equal(corsFor('https://evil.example')['Access-Control-Allow-Origin'], 'https://tackpath.com');
});

// ── Session guard for smooth-api, nav-proxy, smartsort, sponge, swarm-watch ──
import fs from 'node:fs';
import { guardRequest, handleShopifyStart, checkShopifyCallback, signOAuthState, verifyOAuthState } from '../../supabase/functions/_shared/tp_security.js';

test('guard: company or driver sessions pass where allowed; anything else gets 401 and no work is done', async () => {
  const e = await env();
  const org = await e.org();
  const issued = await rpc(e.db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = (await rpc(e.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).token;
  const req = (body, headers = {}) => new Request('https://x/fn', { method: 'POST', headers, body: JSON.stringify(body) });
  const pass = async (body, opts, headers) => {
    const g = await guardRequest(req(body, headers), e.deps, opts);
    if (g.response) return g.response.status;
    assert.deepEqual(JSON.parse(await g.req.text()), body, 'the function can still read the body');
    return g.session.kind;
  };
  assert.equal(await pass({ session: org, action: 'routes' }), 'org');
  assert.equal(await pass({ session: drv, action: 'geocode' }), 'driver');
  assert.equal(await pass({ action: 'x' }, {}, { 'x-tp-session': org }), 'org', 'header works too');
  assert.equal(await pass({ session: drv }, { kinds: ['org'] }), 401, 'driver session refused where only companies may call');
  for (const body of [{}, { session: '' }, { session: 'f'.repeat(64) }, { session: 'x'.repeat(500) }]) {
    assert.equal(await pass(body), 401, JSON.stringify(body).slice(0, 40));
  }
  await rpc(e.db, 'tp_sign_out', { p_token: org });
  assert.equal(await pass({ session: org }), 401, 'signed-out session refused');
  // scheduler secret: only when the function is configured with one
  assert.equal(await pass({}, { kinds: ['org'] }, { 'x-tp-cron-secret': 'cron-123' }), 401);
  const withCron = { ...e.deps, cronSecret: 'cron-123' };
  const g = await guardRequest(req({}, { 'x-tp-cron-secret': 'cron-123' }), withCron, { kinds: ['org'] });
  assert.equal(g.session.kind, 'cron');
  const bad = await guardRequest(req({}, { 'x-tp-cron-secret': 'cron-124' }), withCron, { kinds: ['org'] });
  assert.equal(bad.response.status, 401);
  // tp_svc_session is not callable with the public key
  assert.match(String(await rpc(e.db, 'tp_svc_session', { p_token: org }, 'anon').catch((x) => x.message)), /permission denied/);
});

test('every remaining edge function checks the session before doing anything', () => {
  const fn = (n) => fs.readFileSync(new URL('../../supabase/functions/' + n + '/index.ts', import.meta.url), 'utf8');
  const want = { 'smooth-api': '["org", "driver"]', 'nav-proxy': '["org", "driver"]', smartsort: '["org"]', sponge: '["org"]', 'swarm-watch': '["org"]' };
  for (const [name, kinds] of Object.entries(want)) {
    const src = fn(name);
    const opt = src.indexOf('req.method === "OPTIONS"');
    const guard = src.indexOf('await guardRequest(req,');
    const deny = src.indexOf('if (guard.response) return guard.response;');
    assert.ok(opt > 0 && guard > opt && deny > guard, name + ': guard right after the CORS preflight');
    const after = src.slice(deny);
    const firstWork = Math.min(...['req.json()', 'createClient(', 'fetch('].map((k) => { const i = src.indexOf(k, opt); return i < 0 ? Infinity : i; }));
    assert.ok(firstWork > deny, name + ': no work before the guard');
    assert.ok(src.slice(guard, deny).includes(`kinds: ${kinds}`), name + ' allows ' + kinds);
    assert.equal(src.includes('CRON_SECRET'), name === 'swarm-watch', name + ': scheduler secret only for swarm-watch');
    assert.ok(after.length > 0);
  }
  assert.doesNotMatch(fn('smartsort'), /const \{[^}]*org_id[^}]*\} = await req\.json\(\)/, 'smartsort never takes the company from the body');
  assert.match(fn('smartsort'), /const org_id = guard\.session\.kind === "org" \? guard\.session\.org_id : null;/);
});

// ── Shopify OAuth signed state ──
const SECRET = 'shpss_app_secret';
const shopifyQuery = (params) => {
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', SECRET).update(msg).digest('hex');
  return new URL('https://x/shopify-oauth?' + new URLSearchParams({ ...params, hmac }).toString());
};

test('Shopify: a store can only be linked to the company that started the connection', async () => {
  const e = await env();
  const deps = { ...e.deps, now: () => Date.now(), shopifySecret: SECRET, shopifyApiKey: 'apikey1', scopes: 'read_orders', redirectUri: 'https://x/shopify-oauth' };
  const tok = await e.org();
  const start = await handleShopifyStart(new Request('https://x', { method: 'POST', body: JSON.stringify({ action: 'start', session: tok, shop: 'Acme-Store.myshopify.com' }) }), deps);
  assert.equal(start.status, 200);
  const authUrl = new URL(start.body.url);
  assert.equal(authUrl.host, 'acme-store.myshopify.com');
  const state = authUrl.searchParams.get('state');
  // callback from Shopify for that shop and state -> linked to Quick Haul (the company that started it)
  const ok = await checkShopifyCallback(shopifyQuery({ code: 'c1', shop: 'acme-store.myshopify.com', state, timestamp: '1700000000' }), deps);
  assert.deepEqual(ok, { org: ORG_A, shop: 'acme-store.myshopify.com' });
  // the same state for a different shop
  assert.ok((await checkShopifyCallback(shopifyQuery({ code: 'c1', shop: 'other.myshopify.com', state, timestamp: '1' }), deps)).error);
  // forged / tampered / unsigned states, and the old "state = org_id" form
  const [payload, sig] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ org: ORG_B, shop: 'acme-store.myshopify.com', exp: 9999999999, n: 'x' })).toString('base64url');
  for (const st of [forged + '.' + sig, payload + '.' + sig.slice(0, -2) + 'AA', ORG_B, '', payload]) {
    assert.ok((await checkShopifyCallback(shopifyQuery({ code: 'c1', shop: 'acme-store.myshopify.com', state: st, timestamp: '1' }), deps)).error, st.slice(0, 30));
  }
  // a callback whose query was not signed by Shopify
  const unsigned = new URL('https://x/shopify-oauth?' + new URLSearchParams({ code: 'c1', shop: 'acme-store.myshopify.com', state, hmac: 'a'.repeat(64) }));
  assert.equal((await checkShopifyCallback(unsigned, deps)).error, 'Invalid Shopify signature');
  // expired after 15 minutes
  const old = await signOAuthState({ org: ORG_A, shop: 'acme-store.myshopify.com', now: Date.now() - 16 * 60 * 1000 }, SECRET);
  assert.ok((await checkShopifyCallback(shopifyQuery({ code: 'c1', shop: 'acme-store.myshopify.com', state: old, timestamp: '1' }), deps)).error);
  assert.equal(await verifyOAuthState(state, 'another-secret', { shop: 'acme-store.myshopify.com' }), null);
  // starting needs a company session and a real store name
  const st = (body) => handleShopifyStart(new Request('https://x', { method: 'POST', body: JSON.stringify(body) }), deps).then((r) => r.status);
  assert.equal(await st({ action: 'start', shop: 'acme-store.myshopify.com' }), 401);
  assert.equal(await st({ action: 'start', session: 'f'.repeat(64), shop: 'acme-store.myshopify.com' }), 401);
  assert.equal(await st({ action: 'start', session: tok, shop: 'evil.example.com' }), 400);
  assert.equal(await st({ action: 'start', session: tok, shop: 'a.myshopify.com.evil.com' }), 400);
  // the function no longer starts from a bare GET link with org_id
  const src = fs.readFileSync(new URL('../../supabase/functions/shopify-oauth/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /searchParams\.get\("org_id"\)/);
  assert.match(src, /org_id: checked\.org,/);
});
