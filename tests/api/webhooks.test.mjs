// API v1 webhooks: registration (HTTPS public destinations only), signed
// deliveries, retries with backoff, replay protection, delivery logs, and the
// guarantee that webhooks never block an operational write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORDER } from './harness.mjs';
import { verifyWebhook, signWebhook, isPublicIp } from '../../supabase/functions/_shared/tp_api.js';

const t = await setup({ dns: { 'evil.example.com': ['10.0.0.5'], 'meta.example.com': ['169.254.169.254'], 'mixed.example.com': ['93.184.216.40', '127.0.0.1'] } });
const { call, sessionA, sessionB, newKey, db } = t;
const key = (await newKey(sessionA)).key;
const O = t.org(sessionA);
const D = t.drv(await t.driverSession());
const jobOf = async (id) => (await db.query('select job_id from tp_api.orders where id = tp_api.parse_id($1,$2)', ['ord', id])).rows[0].job_id;

// a receiver that records what it gets and answers with the next queued status
function receiver(statuses = []) {
  const got = [];
  const fetch = async (url, init) => { got.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return { status: statuses.length ? statuses.shift() : 200, body: null }; };
  return { got, fetch };
}

test('registration: https and a public host only; private, metadata and internal addresses are refused', async () => {
  const bad = ['http://hooks.example.com/x', 'https://10.0.0.1/x', 'https://localhost/x', 'https://evil.example.com/x',
    'https://meta.example.com/x', 'https://mixed.example.com/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com:8443/x',
    'https://nowhere.example.com/x', 'https://printer.internal/x', 'ftp://hooks.example.com/x'];
  for (const url of bad) {
    const r = await call('POST', '/webhooks', { key, body: { url, events: ['order.status_changed'] } });
    assert.equal(r.status, 422, url); assert.equal(r.body.error.code, 'invalid_url');
  }
  const ev = await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/x', events: ['order.lost'] } });
  assert.equal(ev.status, 422); assert.equal(ev.body.error.code, 'invalid_events');
  for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp('93.184.216.34'), true);
});

test('the signing secret is shown once; endpoints belong to one company', async () => {
  const r = await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/once', events: ['delivery.completed'] } });
  assert.equal(r.status, 201); assert.match(r.body.secret, /^whsec_[0-9a-f]{64}$/); assert.match(r.body.id, /^whk_/);
  const g = await call('GET', `/webhooks/${r.body.id}`, { key });
  assert.equal(g.status, 200); assert.equal(g.body.secret, undefined);
  assert.ok((await call('GET', '/webhooks', { key })).body.data.every((w) => !('secret' in w)));
  const keyB = (await newKey(sessionB)).key;
  for (const [m, p] of [['GET', `/webhooks/${r.body.id}`], ['PATCH', `/webhooks/${r.body.id}`], ['DELETE', `/webhooks/${r.body.id}`],
                        ['GET', `/webhooks/${r.body.id}/deliveries`], ['POST', `/webhooks/${r.body.id}/rotate-secret`]]) {
    assert.equal((await call(m, p, { key: keyB, body: m === 'GET' || m === 'DELETE' ? undefined : {} })).status, 404, `${m} ${p}`);
  }
  await call('DELETE', `/webhooks/${r.body.id}`, { key });
});

test('events are delivered signed; the receiver can verify them; old or altered ones fail verification', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/tp',
    events: ['order.status_changed', 'route.assignment_changed', 'delivery.completed', 'pod.available', 'delivery.exception'] } })).body;
  const o = (await call('POST', '/orders', { key, body: ORDER(1) })).body;
  const jid = await jobOf(o.id);
  await O('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });
  await D('update_job', { id: jid, patch: { status: 'in_transit' } });
  await D('post_message', { id: jid, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, delivered_at: new Date().toISOString(),
    pod_kind: 'photo', pod_url: `${jid}/stop-1-photo-1.jpg` }) });
  await D('update_job', { id: jid, patch: { status: 'delivered' } });

  const rx = receiver();
  const run = await t.webhooks({ fetch: rx.fetch });
  assert.equal(run.failed, 0);
  const evs = rx.got.map((g) => JSON.parse(g.body));
  assert.deepEqual(evs.map((e) => e.type + (e.data.order ? ':' + e.data.order.status : '')), [
    'route.assignment_changed', 'order.status_changed:assigned', 'order.status_changed:out_for_delivery',
    'delivery.completed:delivered', 'pod.available:delivered', 'order.status_changed:delivered']);
  for (const g of rx.got) {
    assert.equal(g.redirect, 'manual', 'redirects are not followed');
    assert.equal(g.headers['TackPath-Event-Id'], JSON.parse(g.body).id);
    assert.equal(await verifyWebhook(w.secret, g.body, g.headers['TackPath-Signature']), true);
    assert.equal(await verifyWebhook(w.secret, g.body.slice(0, -1) + ' }', g.headers['TackPath-Signature']), false, 'altered body');
    assert.equal(await verifyWebhook('whsec_wrong', g.body, g.headers['TackPath-Signature']), false, 'wrong secret');
  }
  const old = await signWebhook(w.secret, rx.got[0].body, Math.floor(Date.now() / 1000) - 600);
  assert.equal(await verifyWebhook(w.secret, rx.got[0].body, old), false, 'a signature older than 5 minutes is rejected (replay)');
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, 'every event has its own id');
  assert.ok(evs.every((e) => e.api_version === 'v1' && /^evt_/.test(e.id)));
  assert.equal((await t.webhooks({ fetch: rx.fetch })).sent, 0, 'delivered events are not sent again');
  const log = await call('GET', `/webhooks/${w.id}/deliveries`, { key });
  assert.ok(log.body.data.length >= 6 && log.body.data.every((d) => d.status === 'delivered' && d.attempts === 1));
  await call('DELETE', `/webhooks/${w.id}`, { key });
});

test('retries: a failing endpoint is retried with backoff, then marked failed after 8 attempts', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/down', events: ['order.status_changed'] } })).body;
  const o = (await call('POST', '/orders', { key, body: ORDER(2) })).body;
  await O('update_job', { id: await jobOf(o.id), patch: { status: 'cancelled' } });
  const rx = receiver([500]);
  await t.webhooks({ fetch: rx.fetch });
  let d = (await db.query(`select * from tp_api.deliveries where endpoint_id = tp_api.parse_id('whk', $1)`, [w.id])).rows[0];
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.equal(d.last_status_code, 500);
  const wait = (new Date(d.next_attempt_at) - Date.now()) / 1000;
  assert.ok(wait > 50 && wait < 70, `first retry in about a minute (${wait})`);
  assert.equal((await t.webhooks({ fetch: rx.fetch })).sent + (await t.webhooks({ fetch: rx.fetch })).failed, 0, 'not before its time');
  for (let i = 2; i <= 8; i++) {
    await db.query(`update tp_api.deliveries set next_attempt_at = now() - interval '1 second' where id = $1`, [d.id]);
    await t.webhooks({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  }
  d = (await db.query('select * from tp_api.deliveries where id = $1', [d.id])).rows[0];
  assert.equal(d.status, 'failed'); assert.equal(d.attempts, 8); assert.equal(d.last_error, 'connection failed');
  assert.equal((await db.query('select count(*)::int n from tp_api.delivery_attempts where delivery_id = $1', [d.id])).rows[0].n, 8);
  await call('DELETE', `/webhooks/${w.id}`, { key });
});

test('a destination that starts resolving to a private address is not called', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://api.shipper.example/hook', events: ['order.status_changed'] } })).body;
  const o = (await call('POST', '/orders', { key, body: ORDER(3) })).body;
  await O('update_job', { id: await jobOf(o.id), patch: { status: 'cancelled' } });
  const rx = receiver();
  await t.webhooks({ fetch: rx.fetch, resolve: async () => ['192.168.0.10'] });
  assert.equal(rx.got.length, 0);
  const d = (await db.query(`select * from tp_api.deliveries where endpoint_id = tp_api.parse_id('whk', $1)`, [w.id])).rows[0];
  assert.match(d.last_error, /private or reserved/);
  await call('DELETE', `/webhooks/${w.id}`, { key });
});

test('subscriptions and client keys: an endpoint gets only its events and, for a client key, only its own orders', async () => {
  const shipper = (await newKey(sessionA, { own_orders_only: true, client_label: 'shipper-9', scopes: ['orders:write', 'webhooks:manage'] })).key;
  const ws = (await call('POST', '/webhooks', { key: shipper, body: { url: 'https://api.shipper.example/s9', events: ['order.status_changed', 'route.assignment_changed'] } })).body;
  const wc = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/company', events: ['route.assignment_changed'] } })).body;
  const mine = (await call('POST', '/orders', { key: shipper, body: ORDER(4) })).body;
  const other = (await call('POST', '/orders', { key, body: ORDER(5) })).body;
  for (const o of [mine, other]) await O('update_job', { id: await jobOf(o.id), patch: { driver_name: 'Dana Driver', status: 'assigned' } });
  const rx = receiver();
  await t.webhooks({ fetch: rx.fetch });
  const to = (u) => rx.got.filter((g) => g.url === u).map((g) => JSON.parse(g.body));
  const s9 = to('https://api.shipper.example/s9');
  assert.deepEqual(s9.map((e) => e.type), ['order.status_changed'], 'the client endpoint gets no route events');
  assert.equal(s9[0].data.order.id, mine.id, "and only its own order's events");
  assert.deepEqual(to('https://hooks.example.com/company').map((e) => e.type), ['route.assignment_changed', 'route.assignment_changed']);
  assert.equal((await call('GET', '/webhooks', { key: shipper })).body.data.length, 1, 'a client key lists only its own endpoints');
  for (const w of [ws, wc]) await call('DELETE', `/webhooks/${w.id}`, { key });
});

test('rotate the secret, test event, disable and delete', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/rot', events: ['delivery.completed'] } })).body;
  const r = await call('POST', `/webhooks/${w.id}/rotate-secret`, { key });
  assert.equal(r.status, 200); assert.notEqual(r.body.secret, w.secret);
  assert.equal((await call('POST', `/webhooks/${w.id}/test`, { key })).status, 202);
  const rx = receiver();
  await t.webhooks({ fetch: rx.fetch });
  const g = rx.got.find((x) => x.url.endsWith('/rot'));
  assert.equal(JSON.parse(g.body).type, 'webhook.test');
  assert.equal(await verifyWebhook(r.body.secret, g.body, g.headers['TackPath-Signature']), true, 'signed with the new secret');
  const off = await call('PATCH', `/webhooks/${w.id}`, { key, body: { active: false } });
  assert.equal(off.body.active, false);
  const del = await call('DELETE', `/webhooks/${w.id}`, { key });
  assert.equal(del.body.deleted, true);
});

test('webhooks never block operations: with the webhook tables broken, dispatcher and driver writes still succeed', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/b', events: ['order.status_changed', 'delivery.completed'] } })).body;
  const o = (await call('POST', '/orders', { key, body: ORDER(6) })).body;
  const jid = await jobOf(o.id);
  await db.exec('alter table tp_api.events rename to events_broken');
  try {
    const u = await O('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });
    assert.equal(u[0].status, 'assigned');
    const m = await D('post_message', { id: jid, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, delivered_at: new Date().toISOString() }) });
    assert.ok(m.id, 'the delivery record is stored');
    const bad = await D('post_message', { id: jid, body: 'STOP_DELIVERED::{not json' });
    assert.ok(bad.id, 'a malformed record is stored too, as before');
  } finally { await db.exec('alter table tp_api.events_broken rename to events'); }
  await call('DELETE', `/webhooks/${w.id}`, { key });
});

test('the scheduled worker needs the cron secret', async () => {
  const req = (h) => new Request('https://x.supabase.co/functions/v1/api-webhooks', { method: 'POST', headers: h });
  assert.equal((await t.worker(req({}), { cronSecret: 'cron-s3cret' })).status, 401);
  assert.equal((await t.worker(req({ 'x-tp-cron-secret': 'wrong' }), { cronSecret: 'cron-s3cret' })).status, 401);
  assert.equal((await t.worker(req({ 'x-tp-cron-secret': 'cron-s3cret' }), { cronSecret: '' })).status, 401, 'no secret configured: refused');
  const ok = await t.worker(req({ 'x-tp-cron-secret': 'cron-s3cret' }), { cronSecret: 'cron-s3cret', fetch: receiver().fetch });
  assert.equal(ok.status, 200);
});

test('the events endpoint lists recent events for polling', async () => {
  const w = (await call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/poll', events: ['order.status_changed'] } })).body;
  const o = (await call('POST', '/orders', { key, body: ORDER(7) })).body;
  await O('update_job', { id: await jobOf(o.id), patch: { status: 'cancelled' } });
  const r = await call('GET', '/events?limit=5', { key });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((e) => e.type === 'order.status_changed' && e.data.order.id === o.id));
  await call('DELETE', `/webhooks/${w.id}`, { key });
});
