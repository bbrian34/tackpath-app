// Fixes from the independent security review of the API (2026-10-13).
// Each test reproduces a problem the review proved on the first version of
// migration 69 and the edge layer, and checks the fix:
//   H1  a client key attached itself to another client's stop by tracking number or external id
//   H2  the webhook triggers made a job update take seconds (4,275 ms)
//   H3  listing 40 orders took 13 s
//   M1  failed requests were not counted by the rate limit; invalid keys were never limited
//   M3  IPv6 forms of private and metadata addresses passed the webhook check
//   M5  test-mode keys created real jobs on the dispatch board
//   L1  webhook signing secrets were kept in the stored idempotency responses
//   L7  an off switch for the triggers and a kill switch for the API
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../supabase/functions/_shared/tp_api.js';
import { setup, ORDER, ORG_A, ORG_B } from './harness.mjs';

const hex = (uuid) => uuid.replace(/-/g, '');
const jobOf = async (db, orderId) => (await db.query('select job_id from tp_api.orders where id = tp_api.parse_id($1, $2)', ['ord', orderId])).rows[0].job_id;
const count = async (db, sql, args = []) => (await db.query(sql, args)).rows[0].n;

// another client's route: a manifest stop with its own tracking number, delivered with a photo
async function otherClientsDeliveredStop(db, code = 'ZZTRACK9001', orderId = 'SHOP-9001') {
  const { rows: [j] } = await db.query(`insert into public.jobs (org_id, title, status, job_type, driver_name, surge_stops, total_stops, source)
    values ($1, 'Route 7', 'in_transit', 'surge', 'Dana Reyes', $2, 1, 'shopify') returning id`,
  [ORG_A, JSON.stringify([{ stop_number: 1, order_id: orderId, tracking_number: code, recipient: 'Pat Other', address: '9 Secret St', packages: 1 }])]);
  await db.query(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Dana Reyes', 'driver', $2)`,
    [j.id, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, signed_by: 'Pat Other', notes: 'left at back door, code 4411',
      pod_url: j.id + '/stop1.jpg', delivered_at: new Date().toISOString() })]);
  return j.id;
}
const around = (text, s) => { const i = text.indexOf(s); return i < 0 ? '' : text.slice(Math.max(0, i - 200), i + s.length + 60); };
// what must never show: the other client's recipient, note, driver, address, photo and route
// (whole phrases: random hex ids and timestamps may contain short digit runs such as "4411")
const SECRETS = (jobId) => ['Pat Other', 'back door, code 4411', 'Dana R', '9 Secret St', 'stop1.jpg', hex(jobId), jobId];

test('H1: a client key cannot attach its order to another client\'s stop by tracking number or external id', async () => {
  const t = await setup();
  const shopJob = await otherClientsDeliveredStop(t.db);
  const k = await t.newKey(t.sessionA, { scopes: ['orders:write', 'orders:read', 'tracking:read', 'pod:read'], own_orders_only: true, client_label: 'client-y' });

  // the tracking number is already on a job of the company: refused at intake
  const c = await t.call('POST', '/orders', { key: k.key, body: ORDER(1, { tracking_number: 'ZZTRACK9001' }) });
  assert.equal(c.status, 409, JSON.stringify(c.body).slice(0, 300));
  assert.equal(c.body.error.code, 'duplicate_tracking_number');
  const tr = await t.call('GET', '/tracking/ZZTRACK9001', { key: k.key });
  assert.equal(tr.status, 404);

  // the other client's order id used as external_id: the order exists, but it is only the client's own order
  const c2 = await t.call('POST', '/orders', { key: k.key, body: ORDER(2, { external_id: 'SHOP-9001' }) });
  assert.equal(c2.status, 201);
  const g = await t.call('GET', '/orders/' + c2.body.id, { key: k.key });
  const pod = await t.call('GET', `/orders/${c2.body.id}/proof-of-delivery`, { key: k.key });
  const ev = await t.call('GET', `/orders/${c2.body.id}/events`, { key: k.key });
  assert.equal(g.body.status, 'received');
  assert.equal(g.body.route.driver, null);
  assert.notEqual(g.body.route.id, 'rte_' + hex(shopJob));
  assert.equal(pod.status, 404); assert.equal(pod.body.error.code, 'pod_not_available');
  assert.equal(pod.body.media, undefined);
  const seen = JSON.stringify([c.body, tr.body, c2.body, g.body, pod.body, ev.body]);
  for (const s of SECRETS(shopJob)) assert.ok(!seen.includes(s), `no "${s}" in any response: ${around(seen, s)}`);
  assert.deepEqual(t.signed, [], 'no proof-of-delivery link was signed');
});

test('H1: a tracking number claimed before the other client\'s manifest arrives links nothing either', async () => {
  const t = await setup();
  const k = await t.newKey(t.sessionA, { scopes: ['orders:write', 'orders:read', 'tracking:read', 'pod:read'], own_orders_only: true, client_label: 'client-y' });
  const o = (await t.call('POST', '/orders', { key: k.key, body: ORDER(3, { tracking_number: 'FUTURE-7777' }) })).body;
  const later = await otherClientsDeliveredStop(t.db, 'FUTURE-7777', 'SHOP-7777');
  await t.db.query(`update public.jobs set status = 'delivered' where id = $1`, [later]);
  const g = await t.call('GET', '/orders/' + o.id, { key: k.key });
  const pod = await t.call('GET', `/orders/${o.id}/proof-of-delivery`, { key: k.key });
  assert.equal(g.body.status, 'received'); assert.equal(g.body.route.driver, null);
  assert.equal(pod.status, 404);
  const seen = JSON.stringify([g.body, pod.body]);
  for (const s of SECRETS(later)) assert.ok(!seen.includes(s), `no "${s}": ${around(seen, s)}`);
});

test('H1: dispatch links an order to a route stop only by its TackPath order id, same company, live orders only', async () => {
  const t = await setup();
  const kA = (await t.newKey(t.sessionA)).key, kB = (await t.newKey(t.sessionB)).key;
  const a = (await t.call('POST', '/orders', { key: kA, body: ORDER(1) })).body;
  const b = (await t.call('POST', '/orders', { key: kB, body: ORDER(2) })).body;
  const stops = [{ stop_number: 1, tp_order_id: a.id, order_id: 'R-1', recipient: 'Avery Collins', address: '214 Maple Grove Ln' },
                 { stop_number: 2, tp_order_id: b.id, order_id: 'R-2', recipient: 'Somebody Else', address: '1 Other Rd' }];
  const { rows: [r] } = await t.db.query(`insert into public.jobs (org_id, title, status, job_type, surge_stops, total_stops)
    values ($1, 'Surge Route RT-1', 'pending', 'surge', $2, 2) returning id`, [ORG_A, JSON.stringify(stops)]);
  const ga = (await t.call('GET', '/orders/' + a.id, { key: kA })).body;
  assert.equal(ga.route.id, 'rte_' + hex(r.id), 'company A\'s order follows the route dispatch put it on');
  assert.equal(ga.route.stop_number, 1);
  const gb = (await t.call('GET', '/orders/' + b.id, { key: kB })).body;
  assert.notEqual(gb.route.id, 'rte_' + hex(r.id), 'another company\'s order id on A\'s route links nothing');
  await t.db.query(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'D', 'driver', $2)`,
    [r.id, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, delivered_at: new Date().toISOString() })]);
  assert.equal((await t.call('GET', '/orders/' + a.id, { key: kA })).body.status, 'delivered');
  assert.equal((await t.call('GET', '/orders/' + b.id, { key: kB })).body.status, 'received');
});

// 1,500 routes of 20 stops; 20 API orders on one of them (the route carries
// each order's TackPath id and its tracking number, as dispatch would).
async function bigCompany(t) {
  const key = (await t.newKey(t.sessionA)).key;
  await t.call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/big' } });
  const made = await t.call('POST', '/orders/batch', { key, body: { orders: Array.from({ length: 40 }, (_, i) => ORDER(500 + i, { tracking_number: `BIG-${1000 + i}` })) } });
  assert.equal(made.body.created, 40, JSON.stringify(made.body).slice(0, 300));
  const ids = made.body.results.map((x) => x.order_id);
  await t.db.query(`insert into public.jobs (org_id, title, status, job_type, surge_stops, total_stops)
    select $1, 'R-' || g, 'assigned', 'surge',
      (select jsonb_agg(jsonb_build_object('stop_number', i + 1, 'order_id', 'X-' || g || '-' || i, 'tracking_number', 'XT' || g || 'N' || i,
                                           'pkgs', jsonb_build_array(jsonb_build_object('order_id', 'X-' || g || '-' || i, 'tracking_number', 'XT' || g || 'N' || i))))
         from generate_series(0, 19) i), 20
    from generate_series(1, 1500) g`, [ORG_A]);
  const stops = ids.slice(0, 20).map((id, i) => ({ stop_number: i + 1, tp_order_id: id, order_id: `SO-${1500 + i}`, tracking_number: `BIG-${1000 + i}`,
    pkgs: [{ order_id: `SO-${1500 + i}`, tracking_number: `BIG-${1000 + i}` }] }));
  const { rows: [route] } = await t.db.query(`insert into public.jobs (org_id, title, status, job_type, surge_stops, total_stops)
    values ($1, 'Surge Route BIG', 'assigned', 'surge', $2, 20) returning id`, [ORG_A, JSON.stringify(stops)]);
  return { key, ids, route: route.id };
}
const timed = async (fn) => { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; };

test('H2 + H3: one job update stays under 20 ms and listing 40 orders under 1 s, in a company with 1,500 routes', async () => {
  const t = await setup();
  const { key, ids, route } = await bigCompany(t);
  await t.call('GET', '/orders/' + ids[0], { key });                          // links the route (worker step)
  const { rows: [warm] } = await t.db.query(`select id from public.jobs where title = 'R-1'`);
  await t.db.query(`update public.jobs set status = 'in_transit' where id = $1`, [warm.id]);   // compile the trigger once

  const [ms] = await timed(() => t.db.query(`update public.jobs set status = 'in_transit' where id = $1`, [route]));
  console.log(`# job update with 20 API orders on the route: ${ms.toFixed(1)} ms (was 4,275 ms)`);
  assert.ok(ms < 20, `UPDATE jobs SET status took ${ms.toFixed(1)} ms`);

  const [listMs, list] = await timed(() => t.call('GET', '/orders?limit=200', { key }));
  console.log(`# GET /orders, 40 orders: ${listMs.toFixed(0)} ms (was 13,131 ms)`);
  assert.equal(list.status, 200); assert.equal(list.body.data.length, 40);
  assert.ok(listMs < 1000, `list took ${listMs.toFixed(0)} ms`);
  const ofd = await t.call('GET', '/orders?status=out_for_delivery&limit=200', { key });
  assert.deepEqual(ofd.body.data.map((o) => o.id).sort(), ids.slice(0, 20).sort(), 'the stored status follows the route');
  assert.ok(ofd.body.data.every((o) => o.status === 'out_for_delivery' && o.route.id === 'rte_' + hex(route)));
});

test('H2: the triggers only queue a row; nothing for a company without endpoints or API orders; a broken queue blocks nothing', async () => {
  const t = await setup();
  const key = (await t.newKey(t.sessionA)).key;
  await t.call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/q' } });
  const o = (await t.call('POST', '/orders', { key, body: ORDER(1) })).body;
  const jid = await jobOf(t.db, o.id);
  const before = await count(t.db, 'select count(*)::int n from tp_api.outbox');
  await t.org(t.sessionA)('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });
  assert.equal(await count(t.db, 'select count(*)::int n from tp_api.outbox'), before + 1, 'one queued row per change');
  assert.equal(await count(t.db, `select count(*)::int n from tp_api.events where type = 'order.status_changed' and created_at > now() - interval '1 hour' and data->'order'->>'status' = 'assigned'`), 0,
    'nothing is computed in the trigger');

  // company B: no endpoint, no API order: nothing is queued for its jobs
  const { rows: [jb] } = await t.db.query(`insert into public.jobs (org_id, title, status, job_type) values ($1, 'B job', 'pending', 'surge') returning id`, [ORG_B]);
  await t.db.query(`update public.jobs set status = 'assigned', driver_name = 'X' where id = $1`, [jb.id]);
  assert.equal(await count(t.db, 'select count(*)::int n from tp_api.outbox where org_key = $1', [ORG_B]), 0);

  // the queue itself is broken: dispatcher and driver writes still succeed
  await t.db.exec('alter table tp_api.outbox rename to outbox_broken');
  try {
    const u = await t.org(t.sessionA)('update_job', { id: jid, patch: { status: 'cancelled' } });
    assert.equal(u[0].status, 'cancelled');
    const D = t.drv(await t.driverSession());
    const m = await D('post_message', { id: jid, body: 'STOP_EXCEPTION::' + JSON.stringify({ stop_number: 1, reason: 'refused' }) });
    assert.ok(m === null || typeof m === 'object');
  } finally { await t.db.exec('alter table tp_api.outbox_broken rename to outbox'); }
});

test('M1: every request counts toward the rate limit, failures included (20 failing requests on a 3 per minute key)', async () => {
  const t = await setup();
  const k = await t.newKey(t.sessionA, { rate_per_minute: 3 });
  const codes = [];
  for (let i = 0; i < 20; i++) codes.push((await t.call('GET', '/orders/ord_' + '0'.repeat(32), { key: k.key })).status);
  assert.deepEqual(codes, [404, 404, 404, ...Array(17).fill(429)]);
  assert.equal(await count(t.db, `select count(*)::int n from tp_sec.rate_events where bucket = 'api_req'`), 3);
});

test('M1: invalid keys are limited by IP and by key prefix, in the edge function (before the database) and in the gateway', async () => {
  const t = await setup();
  assert.equal(typeof api.createAuthLimiter, 'function', 'the edge function has an auth-failure limiter');
  let rpcCalls = 0;
  const rpc0 = t.deps.rpc;
  t.deps.rpc = (...a) => { rpcCalls++; return rpc0(...a); };
  t.deps.authLimiter = api.createAuthLimiter();
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  const bad = (i) => 'tpk_live_' + (100000000000 + i).toString(16).padStart(12, '0').slice(-12) + '_' + 'b'.repeat(64);
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await t.call('GET', '/orders', { key: bad(i), headers: ip })).status);
  assert.deepEqual(codes, [...Array(20).fill(401), ...Array(5).fill(429)]);
  assert.equal(rpcCalls, 20, 'blocked requests never reach the database');
  const other = await t.call('GET', '/orders', { key: (await t.newKey(t.sessionA)).key, headers: { 'cf-connecting-ip': '198.51.100.7' } });
  assert.equal(other.status, 200, 'other addresses are not affected');

  // by key prefix: someone guessing secrets for one key prefix
  const good = await t.newKey(t.sessionA);
  const pre = good.key.slice(0, 22);
  const tries = [];
  for (let i = 0; i < 12; i++) tries.push((await t.call('GET', '/orders', { key: pre + i.toString(16).padStart(64, '0'), headers: { 'cf-connecting-ip': `198.51.100.${20 + i}` } })).status);
  assert.deepEqual(tries, [...Array(10).fill(401), 429, 429]);

  // the gateway enforces the same limits when several edge instances share the work (no shared memory)
  t.deps.authLimiter = undefined;
  const ip2 = { 'cf-connecting-ip': '192.0.2.77' };
  const db = [];
  for (let i = 0; i < 32; i++) db.push((await t.call('GET', '/orders', { key: bad(500 + i), headers: ip2 })).status);
  assert.deepEqual(db, [...Array(30).fill(401), 429, 429]);
  assert.equal((await t.call('GET', '/orders', { key: good.key })).status, 200, 'the real key still works');
});

test('M3: webhook destinations: only global IPv6 unicast; every proven bypass form is refused', () => {
  for (const ip of ['::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '::a9fe:a9fe', '2002:a9fe:a9fe::1', 'fe90::1', 'fec0::1',
    '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::ffff:10.0.0.1',
    '::ffff:127.0.0.1', '64:ff9b::8.8.8.8', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', 'fe80::1%eth0', 'not-an-ip', '2606:4700::1::1']) {
    assert.equal(api.isPublicIp(ip), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888', '::ffff:93.184.216.34', '93.184.216.34']) {
    assert.equal(api.isPublicIp(ip), true, ip);
  }
});

test('M5: a test-mode key never creates a job on the dispatch board, and live and test orders do not mix', async () => {
  const t = await setup();
  const test_ = (await t.newKey(t.sessionA, { mode: 'test' })).key;
  const live = (await t.newKey(t.sessionA)).key;
  const jobs = await count(t.db, 'select count(*)::int n from public.jobs');
  const o = await t.call('POST', '/orders', { key: test_, body: ORDER(1) });
  const b = await t.call('POST', '/orders/batch', { key: test_, body: { orders: [ORDER(2), ORDER(3)] } });
  assert.equal(o.status, 201); assert.equal(b.body.created, 2);
  assert.equal(await count(t.db, 'select count(*)::int n from public.jobs'), jobs, 'no job was created');
  assert.ok(!(await t.org(t.sessionA)('jobs')).some((j) => /SO-100[123]/.test(j.title || '')), 'nothing on the board');
  assert.equal(o.body.mode, 'test'); assert.equal(o.body.route, null);
  assert.equal((await t.call('GET', '/orders/' + o.body.id, { key: test_ })).status, 200);
  assert.equal((await t.call('GET', '/orders/' + o.body.id, { key: live })).status, 404, 'a live key does not see test orders');
  const l = await t.call('POST', '/orders', { key: live, body: ORDER(1) });
  assert.equal(l.status, 201, 'the same external_id may exist once in test and once in live');
  assert.equal((await t.call('GET', '/orders/' + l.body.id, { key: test_ })).status, 404, 'a test key does not see live orders');
});

test('L1: webhook signing secrets are not kept in stored idempotency responses', async () => {
  const t = await setup();
  const key = (await t.newKey(t.sessionA)).key;
  const r = await t.call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/idem' }, headers: { 'idempotency-key': 'hook-1' } });
  assert.equal(r.status, 201); assert.match(r.body.secret, /^whsec_/);
  const rot = await t.call('POST', `/webhooks/${r.body.id}/rotate-secret`, { key, headers: { 'idempotency-key': 'rot-1' } });
  assert.match(rot.body.secret, /^whsec_/);
  const stored = JSON.stringify((await t.db.query('select response from tp_api.idempotency')).rows);
  assert.ok(!stored.includes('whsec_'), 'no secret in tp_api.idempotency');
  const again = await t.call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/idem' }, headers: { 'idempotency-key': 'hook-1' } });
  assert.equal(again.status, 201); assert.equal(again.body.id, r.body.id); assert.equal(again.body.secret, undefined);
});

test('L7: the trigger off switch stops all queueing; the kill switch turns both functions into 503s; both are reversible', async () => {
  const t = await setup();
  const key = (await t.newKey(t.sessionA)).key;
  await t.call('POST', '/webhooks', { key, body: { url: 'https://hooks.example.com/off' } });
  const o = (await t.call('POST', '/orders', { key, body: ORDER(1) })).body;
  const jid = await jobOf(t.db, o.id);
  const off = ['public.jobs', 'public.messages', 'public.events', 'public.bin_bindings'];
  const names = (await t.db.query(`select tgrelid::regclass::text rel, tgname from pg_trigger where tgname like 'tp_api_%' order by 1`)).rows;
  assert.deepEqual(names.map((r) => r.rel).sort(), [...off].sort().map((x) => x.replace('public.', '')).sort(), 'one trigger per table');
  for (const r of names) await t.db.exec(`alter table public.${r.rel} disable trigger ${r.tgname}`);
  const n0 = await count(t.db, 'select count(*)::int n from tp_api.outbox');
  await t.org(t.sessionA)('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });
  assert.equal(await count(t.db, 'select count(*)::int n from tp_api.outbox'), n0, 'nothing queued with the triggers off');
  for (const r of names) await t.db.exec(`alter table public.${r.rel} enable trigger ${r.tgname}`);
  await t.org(t.sessionA)('update_job', { id: jid, patch: { status: 'cancelled' } });
  assert.equal(await count(t.db, 'select count(*)::int n from tp_api.outbox'), n0 + 1, 'queueing resumes');

  await t.db.exec(`update tp_api.settings set enabled = false`);
  const r = await t.call('GET', '/orders', { key });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'api_disabled');
  let sent = 0;
  const run = await t.webhooks({ fetch: async () => { sent++; return { status: 200 }; } });
  assert.equal(sent, 0); assert.equal(run.disabled, true);
  await t.db.exec(`update tp_api.settings set enabled = true`);
  assert.equal((await t.call('GET', '/orders', { key })).status, 200);
  await t.webhooks({ fetch: async () => { sent++; return { status: 200 }; } });
  assert.ok(sent > 0, 'sending resumes');
});

test('H1: at a stop shared by two clients, each order gets only its own package scans', async () => {
  const t = await setup();
  const kA = (await t.newKey(t.sessionA, { own_orders_only: true, client_label: 'client-a', scopes: ['orders:write', 'orders:read'] })).key;
  const kB = (await t.newKey(t.sessionA, { own_orders_only: true, client_label: 'client-b', scopes: ['orders:write', 'orders:read'] })).key;
  const a = (await t.call('POST', '/orders', { key: kA, body: ORDER(1, { tracking_number: 'SHARE-A-1' }) })).body;
  const b = (await t.call('POST', '/orders', { key: kB, body: ORDER(2, { tracking_number: 'SHARE-B-1' }) })).body;
  // one stop, two packages: the stop carries A's id, the second package carries B's
  const stops = [{ stop_number: 1, tp_order_id: a.id, tracking_number: 'SHARE-A-1', address: '1 Shared Way',
    pkgs: [{ tracking_number: 'SHARE-A-1' }, { tp_order_id: b.id, tracking_number: 'SHARE-B-1' }] }];
  const { rows: [r] } = await t.db.query(`insert into public.jobs (org_id, title, status, job_type, surge_stops, total_stops)
    values ($1, 'Surge Route SHARED', 'pending', 'surge', $2, 1) returning id`, [ORG_A, JSON.stringify(stops)]);
  await t.org(t.sessionA)('log_event', { event_type: 'package.stowed', job_id: r.id, payload: { code: 'SHARE-B-1', bin: '3C' }, idempotency_key: 'share-b' });
  assert.equal((await t.call('GET', '/orders/' + b.id, { key: kB })).body.status, 'sorted', "B's package was scanned");
  assert.equal((await t.call('GET', '/orders/' + a.id, { key: kA })).body.status, 'received', "B's scan does not count for A");
});
