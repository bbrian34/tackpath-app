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
