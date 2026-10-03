// Migration 10 (sessions, sign-in, RPCs) on a copy of today's production
// shape, every call made with the public anon key's role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rpc, rpcError, as, ORG_A, ORG_B, ORG_REVIEW } from './fixture.mjs';

const MIG = ['10_sessions_and_rpcs.sql'];

async function setup() {
  const db = await freshDb({ migrate: MIG });
  const insJob = async (o) => (await db.query(
    `insert into public.jobs (org_id, title, status, driver_name, job_type, surge_stops, created_at)
     values ($1,$2,$3,$4,$5,$6, now() - ($7 || ' minutes')::interval) returning id`,
    [o.org ?? ORG_A, o.title ?? 'Route', o.status ?? 'pending', o.driver ?? null, o.type ?? null,
     JSON.stringify(o.stops ?? null), String(o.ago ?? 0)])).rows[0].id;
  return { db, insJob };
}
const orgToken = async (db, slug = 'quickhaul', code = 'qh-portal-2026') =>
  (await rpc(db, 'tp_org_sign_in', { p_slug: slug, p_code: code })).token;
async function driverToken(db, phone = '4045551234') {
  const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role');
  assert.equal(issued.send, true, JSON.stringify(issued));
  const r = await rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: issued.code });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.token;
}

test('migration 10 refuses to run when production lacks a column it needs (and changes nothing)', async () => {
  const db = await freshDb();
  await db.exec('alter table public.jobs drop column staged_at');
  const { sqlFile } = await import('./fixture.mjs');
  await assert.rejects(db.exec(sqlFile('10_sessions_and_rpcs.sql')), /nothing was changed.*jobs\.staged_at/s);
  await db.exec('rollback');
  const r = await db.query(`select to_regnamespace('tp_sec') as s`);
  assert.equal(r.rows[0].s, null, 'tp_sec schema not created');
});

test('company sign-in: right code works, wrong code and unknown company fail, lockout after 10 failures', async () => {
  const { db } = await setup();
  const ok = await rpc(db, 'tp_org_sign_in', { p_slug: 'QuickHaul ', p_code: 'qh-portal-2026' });
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^[0-9a-f]{64}$/);
  assert.equal(ok.org.slug, 'quickhaul');
  // the slug alone (what the dispatcher used to need) is not enough
  assert.equal((await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: '' })).ok, false);
  assert.equal((await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'quickhaul' })).ok, false);
  // a company without a code cannot be signed into until one is set
  assert.equal((await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'anything' })).ok, false);
  for (let i = 0; i < 8; i++) await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'guess' + i });
  const locked = await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /TP_RATE/);
  // the plaintext code is stored only as a bcrypt hash
  const h = (await db.query(`select code_hash from tp_sec.org_codes where org_key = $1`, [ORG_A])).rows[0].code_hash;
  assert.match(h, /^\$2a\$10\$/);
  assert.ok(!h.includes('qh-portal'));
});

test('admin sets a company code; old sessions are signed out', async () => {
  const { db } = await setup();
  const old = await orgToken(db);
  await db.query(`select tp_sec.admin_set_org_code('otherco', 'other-code-123')`);
  assert.equal((await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'other-code-123' })).ok, true);
  await db.query(`select tp_sec.admin_set_org_code('quickhaul', 'new-qh-code-99')`);
  assert.match(await rpcError(db, 'tp_org', { p_token: old, p_action: 'jobs' }), /TP_AUTH/);
  // anon cannot call the admin function
  assert.match(String(await as(db, 'anon', `select tp_sec.admin_set_org_code('quickhaul','x')`).catch((e) => e.message)), /permission denied/);
});

test('org gateway: a company sees and changes only its own jobs; bad or missing session is rejected', async () => {
  const { db, insJob } = await setup();
  const mine = await insJob({ title: 'Mine' });
  const theirs = await insJob({ title: 'Theirs', org: ORG_B });
  const legacy = await insJob({ title: 'Legacy', org: null });
  const tok = await orgToken(db);
  const ids = (await rpc(db, 'tp_org', { p_token: tok, p_action: 'jobs' })).map((j) => j.id);
  assert.ok(ids.includes(mine) && ids.includes(legacy), 'own jobs and legacy NULL-org jobs');
  assert.ok(!ids.includes(theirs), 'never another company\'s jobs');
  assert.match(await rpcError(db, 'tp_org', { p_token: tok, p_action: 'update_job', p_args: { id: theirs, patch: { status: 'cancelled' } } }), /TP_DENIED/);
  const upd = await rpc(db, 'tp_org', { p_token: tok, p_action: 'update_job', p_args: { id: mine, patch: { status: 'assigned', driver_name: 'Dana Driver', title: 'HACKED' } } });
  assert.equal(upd[0].status, 'assigned');
  assert.equal(upd[0].title, 'Mine', 'columns outside the dispatcher whitelist are ignored');
  assert.match(await rpcError(db, 'tp_org', { p_token: 'nope', p_action: 'jobs' }), /TP_AUTH/);
  assert.match(await rpcError(db, 'tp_org', { p_token: null, p_action: 'jobs' }), /TP_AUTH/);
  // a driver session is not a company session
  const dtok = await driverToken(db);
  assert.match(await rpcError(db, 'tp_org', { p_token: dtok, p_action: 'jobs' }), /TP_AUTH/);
  // clear board archives instead of deleting
  const r = await rpc(db, 'tp_org', { p_token: tok, p_action: 'archive_jobs', p_args: { ids: [mine, theirs] } });
  assert.equal(r.archived, 1);
  assert.equal((await db.query('select count(*)::int n from public.jobs')).rows[0].n, 3, 'nothing deleted');
  // signed out = token no longer works
  await rpc(db, 'tp_sign_out', { p_token: tok });
  assert.match(await rpcError(db, 'tp_org', { p_token: tok, p_action: 'jobs' }), /TP_AUTH/);
});

test('dispatcher flows: drivers roster, messages, locations, agent memory, publish route', async () => {
  const { db, insJob } = await setup();
  const tok = await orgToken(db);
  const call = (action, args = {}) => rpc(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const names = (await call('drivers')).map((d) => d.name);
  assert.ok(names.includes('Dana Driver') && !names.includes('Ollie Other'));
  const added = await call('driver_add', { name: 'New Person', phone: '(770) 555-2222' });
  assert.equal(added.phone, '7705552222');
  assert.equal(added.org_id, ORG_A);
  await call('driver_update', { id: added.id, name: 'New P. Person' });
  await call('driver_remove', { id: added.id });
  assert.ok(!(await call('drivers')).some((d) => d.id === added.id), 'removed drivers leave the roster');
  assert.equal((await db.query('select status from public.drivers where id = $1', [added.id])).rows[0].status, 'removed');
  const pend = (await db.query(`select id from public.drivers where name = 'Pat Pending'`)).rows[0].id;
  await call('driver_approve', { id: pend });
  const jid = await insJob({});
  await call('post_message', { job_id: jid, body: 'hello', sender_role: 'dispatcher' });
  assert.equal((await call('messages', { job_id: jid }))[0].body, 'hello');
  await db.query(`insert into public.driver_locations (driver_name, job_id, lat, lng) values ('Dana Driver', $1, 33.7, -84.4), ('Ollie Other', null, 1, 1)`, [jid]);
  const locs = (await call('locations')).map((l) => l.driver_name);
  assert.deepEqual(locs, ['Dana Driver']);
  await call('agent_memory_insert', { agent_name: 'SmartTrack', event_type: 'stop_past_eta', job_id: jid, details: { x: 1 } });
  assert.equal((await call('agent_memory', { agent_name: 'SmartTrack' })).length, 1);
  const pub = await call('publish_route', { payload: { title: 'Surge 1', master_code: 'M-1', surge_stops: [{ order_id: 'A' }], org_id: ORG_B } });
  assert.equal(pub.ok, true);
  assert.equal(pub.job.org_id, ORG_A, 'the company comes from the session, not the payload');
  assert.equal((await call('shopify_connection')).length, 0);
  await db.query(`insert into public.shopify_connections (org_id, shop_domain, access_token, active) values ($1, 'x.myshopify.com', 'shpat_secret', true)`, [ORG_A]);
  const sc = await call('shopify_connection');
  assert.equal(sc[0].shop_domain, 'x.myshopify.com');
  assert.ok(!JSON.stringify(sc).includes('shpat_secret'), 'never returns the Shopify access token');
});

test('PathIQ stow flows through the company session', async () => {
  const { db, insJob } = await setup();
  const tok = await orgToken(db);
  const call = (action, args = {}) => rpc(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const jid = await insJob({});
  assert.ok((await call('jobs', { unbinned: true, statuses: ['pending', 'assigned', 'in_transit'], order: 'asc' })).some((j) => j.id === jid));
  await call('open_binding', { id: jid, bin_code: '1A', location_code: 'L-01', opened_by: 'Sam' });
  await call('set_bin_label', { id: jid, bin_label: '1A' });
  await call('set_staged', { id: jid, staged: true });
  await call('binding_ready', { id: jid });
  const b = await call('bindings');
  assert.equal(b[0].state, 'ready');
  const ev = { event_type: 'package.stowed', job_id: jid, payload: { bin: '1A' }, idempotency_key: 'k1' };
  await call('log_event', ev);
  assert.equal((await call('log_event', ev)).duplicate, true, 'duplicate idempotency key ignored');
  assert.equal((await call('events', { types: ['package.stowed'] })).length, 1);
  const j = (await call('job', { id: jid }));
  assert.equal(j.bin_label, '1A');
  assert.ok(j.staged_at);
});

test('driver sign-in: real codes, hashed, single use, expiry, 5 attempts, unknown and unapproved numbers', async () => {
  const { db } = await setup();
  const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: '+1 (404) 555-1234' }, 'service_role');
  assert.equal(issued.send, true);
  assert.equal(issued.to, '+14045551234');
  assert.match(issued.code, /^\d{6}$/);
  const stored = (await db.query('select * from tp_sec.login_challenges')).rows[0];
  assert.notEqual(stored.code_hash, issued.code);
  assert.ok(!JSON.stringify(stored).includes(issued.code), 'the code is never stored in plain text');
  const wrong = String((Number(issued.code) + 1) % 1000000).padStart(6, '0');
  assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: wrong })).ok, false);
  const good = await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code });
  assert.equal(good.ok, true);
  assert.equal(good.driver.name, 'Dana Driver');
  assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).ok, false, 'single use');
  // attempts limit: 5 wrong guesses burn the code even if the 6th is right
  await db.query(`delete from tp_sec.rate_events`);
  const c2 = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  for (let i = 0; i < 5; i++) await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: String((Number(c2.code) + 1 + i) % 1000000).padStart(6, '0') });
  assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c2.code })).ok, false);
  // expiry
  await db.query(`delete from tp_sec.rate_events`);
  const c3 = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  await db.query(`update tp_sec.login_challenges set expires_at = now() - interval '1 second' where used_at is null`);
  assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c3.code })).ok, false);
  // no code is ever issued for unknown, pending or removed numbers
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '4045559999' }, 'service_role')).send, false);
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551236' }, 'service_role')).reason, 'not_approved');
  // the old behaviour (any 6 digits) is gone
  for (const code of ['000000', '123456', '999999']) {
    assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '6785550000', p_code: code })).ok, false);
  }
  // neither the public key nor a signed-in user can ask the database for a code
  for (const role of ['anon', 'authenticated']) {
    for (const [fn, args] of [['tp_svc_driver_code', { p_phone: '4045551234' }],
                              ['tp_svc_assignment_sms', { p_token: 'x', p_job_id: 'y' }],
                              ['tp_svc_pod', { p_token: 'x', p_kind: 'org', p_job_id: 'y' }]]) {
      assert.match(await rpcError(db, fn, args, role) ?? 'ALLOWED', /permission denied/, role + ' ' + fn);
    }
  }
});

test('driver code requests are rate limited per number and in total', async () => {
  const { db } = await setup();
  const a = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const b = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  assert.equal(a.send, true);
  assert.deepEqual(b, { send: false, reason: 'rate_phone' }, 'one code per minute per number');
  await db.query(`update tp_sec.rate_events set at = at - interval '2 minutes'`);
  for (let i = 0; i < 4; i++) {
    await db.query(`update tp_sec.rate_events set at = at - interval '2 minutes' where bucket = 'code_phone_min'`);
    await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  }
  await db.query(`update tp_sec.rate_events set at = at - interval '2 minutes' where bucket = 'code_phone_min'`);
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role')).reason, 'rate_phone', '5 per hour');
  await db.query(`insert into tp_sec.rate_events (bucket, key) select 'code_global', 'all' from generate_series(1, 300)`);
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551235' }, 'service_role')).reason, 'rate_global');
});

test('reviewer demo account: fixed code only for +1 404 555 0199, sees only the review company', async () => {
  const { db, insJob } = await setup();
  await db.query(`select tp_sec.admin_set_demo_code('246810')`);
  const reviewJob = await insJob({ org: ORG_REVIEW, title: 'Review route' });
  const realJob = await insJob({ org: ORG_A, title: 'Real route' });
  const legacyJob = await insJob({ org: null, title: 'Legacy route' });
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '(404) 555-0199' }, 'service_role')).reason, 'demo', 'never texted');
  const ok = await rpc(db, 'tp_driver_sign_in', { p_phone: '(404) 555-0199', p_code: '246810' });
  assert.equal(ok.ok, true);
  const seen = (await rpc(db, 'tp_driver', { p_token: ok.token, p_action: 'jobs', p_args: { limit: 50 } })).map((j) => j.id);
  assert.deepEqual(seen, [reviewJob], 'review company only, never real or legacy jobs');
  assert.match(await rpcError(db, 'tp_driver', { p_token: ok.token, p_action: 'job', p_args: { id: realJob } }), /TP_DENIED/);
  assert.match(await rpcError(db, 'tp_driver', { p_token: ok.token, p_action: 'job', p_args: { id: legacyJob } }), /TP_DENIED/);
  // the fixed code works for no other number
  for (const phone of ['4045551234', '4045550198', '6785550000']) {
    assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: '246810' })).ok, false, phone);
  }
  assert.equal((await rpc(db, 'tp_driver_sign_in', { p_phone: '4045550199', p_code: '246811' })).ok, false);
  // the code itself is not stored, and anon cannot set it
  assert.match((await db.query('select code_hash from tp_sec.demo_code')).rows[0].code_hash, /^\$2a\$/);
  assert.match(String(await as(db, 'anon', `select tp_sec.admin_set_demo_code('111111')`).catch((e) => e.message)), /permission denied/);
});

test('driver gateway: offers, claim race, own route updates only, messages, GPS, push token, bin', async () => {
  const { db, insJob } = await setup();
  const tok = await driverToken(db);
  const call = (action, args = {}) => rpc(db, 'tp_driver', { p_token: tok, p_action: action, p_args: args });
  const offer = await insJob({ status: 'pending' });
  const othersRoute = await insJob({ status: 'assigned', driver: 'Ned NoConsent' });
  const otherCo = await insJob({ status: 'pending', org: ORG_B });
  const me = await call('me');
  assert.equal(me.name, 'Dana Driver');
  const seen = (await call('jobs', { statuses: ['routing', 'pending', 'assigned'] })).map((j) => j.id);
  assert.ok(seen.includes(offer));
  assert.ok(!seen.includes(othersRoute), 'another driver\'s route is not visible');
  assert.ok(!seen.includes(otherCo), 'another company\'s offer is not visible to a driver of this company');
  const claimed = await call('claim', { id: offer });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].driver_name, 'Dana Driver');
  assert.equal((await call('claim', { id: offer })).length, 0, 'second claim loses the race');
  await call('update_job', { id: offer, patch: { status: 'in_transit', driver_name: 'Dana Driver', stops_completed: 1 } });
  assert.match(await rpcError(db, 'tp_driver', { p_token: tok, p_action: 'update_job', p_args: { id: offer, patch: { driver_name: 'Somebody Else' } } }), /TP_INVALID/);
  assert.match(await rpcError(db, 'tp_driver', { p_token: tok, p_action: 'update_job', p_args: { id: offer, patch: { status: 'cancelled' } } }), /TP_INVALID/);
  assert.match(await rpcError(db, 'tp_driver', { p_token: tok, p_action: 'update_job', p_args: { id: othersRoute, patch: { status: 'delivered' } } }), /TP_DENIED/);
  const upd = await call('update_job', { id: offer, patch: { status: 'delivered', stops_completed: 3, price: 0 } });
  assert.equal(upd[0].status, 'delivered');
  assert.notEqual(upd[0].price, 0, 'price is not a driver column');
  await call('post_message', { job_id: offer, body: 'STOP_DELIVERED::{}' });
  await call('post_message', { job_id: offer, body: 'retry note', sender: 'system' });
  const msgs = await call('messages', { job_id: offer });
  assert.deepEqual(msgs.map((m) => [m.sender, m.sender_role]), [['Dana Driver', 'driver'], ['system', 'dispatcher']]);
  assert.match(await rpcError(db, 'tp_driver', { p_token: tok, p_action: 'messages', p_args: { job_id: othersRoute } }), /TP_DENIED/);
  await call('location', { job_id: offer, lat: 33.75, lng: -84.39, accuracy: 5 });
  await call('location', { job_id: offer, lat: 33.76, lng: -84.38 });
  const loc = (await db.query(`select * from public.driver_locations where driver_name = 'Dana Driver'`)).rows;
  assert.equal(loc.length, 1);
  assert.equal(loc[0].lat, 33.76);
  await call('fcm_token', { token: 'fcm-abc' });
  await call('fcm_token', { token: 'fcm-def' });
  assert.equal((await db.query(`select token from public.driver_fcm_tokens where phone = '4045551234'`)).rows[0].token, 'fcm-def');
  await db.query(`insert into public.bin_bindings (job_id, bin_code, location_code, state) values ($1, '2B', 'L-2', 'open')`, [offer]);
  assert.equal((await call('bin_binding', { job_id: offer }))[0].bin_code, '2B');
});

test('removing a driver signs them out', async () => {
  const { db } = await setup();
  const dtok = await driverToken(db);
  const otok = await orgToken(db);
  const id = (await db.query(`select id from public.drivers where name = 'Dana Driver'`)).rows[0].id;
  await rpc(db, 'tp_org', { p_token: otok, p_action: 'driver_remove', p_args: { id } });
  assert.match(await rpcError(db, 'tp_driver', { p_token: dtok, p_action: 'me' }), /TP_AUTH/);
});

test('customer orders need their order token; tracking shows only tracking fields', async () => {
  const { db } = await setup();
  const created = await rpc(db, 'tp_customer', { p_action: 'create_order', p_args: {
    org_slug: 'quickhaul', title: 'Ann — Atlanta to Decatur', pickup_address: '1 A St', dropoff_address: '2 B St',
    price: 42, distance_miles: 7.5, route_summary: 'I-20', estimated_delivery_at: new Date().toISOString(),
    status: 'delivered', driver_name: 'Injected' } });
  const id = created.job.id; const ot = created.order_token;
  assert.equal(created.job.status, 'routing', 'status forced');
  assert.equal(created.job.driver_name, null, 'cannot set a driver');
  assert.equal(created.job.org_id, ORG_A);
  assert.match(await rpcError(db, 'tp_customer', { p_action: 'get', p_args: { id, order_token: 'wrong' } }), /TP_DENIED/);
  assert.equal((await rpc(db, 'tp_customer', { p_action: 'get', p_args: { id, order_token: ot } })).id, id);
  await rpc(db, 'tp_customer', { p_action: 'post_message', p_args: { id, order_token: ot, body: 'Order placed' } });
  const conf = await rpc(db, 'tp_customer', { p_action: 'confirm', p_args: { id, order_token: ot } });
  assert.equal(conf[0].status, 'pending');
  assert.equal(conf[0].customer_confirmed, true);
  const pub = await rpc(db, 'tp_track', { p_action: 'job', p_args: { id } });
  assert.deepEqual(Object.keys(pub).sort(), ['driver_name', 'driver_rating', 'dropoff_address', 'estimated_delivery_at',
    'id', 'pickup_address', 'price', 'status', 'stops_completed', 'title', 'total_packages']);
  assert.equal(await rpc(db, 'tp_track', { p_action: 'job', p_args: { id: id.slice(0, 8) } }), null, 'no prefix search');
  assert.equal(await rpc(db, 'tp_track', { p_action: 'location', p_args: { id } }), null, 'no location before a driver is assigned');
  assert.match(await rpcError(db, 'tp_track', { p_action: 'rate', p_args: { id, rating: 5 } }) ?? 'none', /none/);
  const rated = await rpc(db, 'tp_track', { p_action: 'rate', p_args: { id, rating: 5 } });
  assert.equal(rated.length, 0, 'only delivered jobs can be rated');
  await db.query(`update public.jobs set status = 'delivered' where id = $1`, [id]);
  assert.equal((await rpc(db, 'tp_track', { p_action: 'rate', p_args: { id, rating: 4 } }))[0].driver_rating, 4);
  assert.equal((await rpc(db, 'tp_track', { p_action: 'rate', p_args: { id, rating: 1 } })).length, 0, 'only once');
  await db.query(`update public.jobs set status = 'in_transit' where id = $1`, [id]);
  assert.match(await rpcError(db, 'tp_customer', { p_action: 'cancel', p_args: { id, order_token: ot } }), /TP_DENIED/);
});

test('tracking number lookup returns only that customer\'s stop of a multi-stop route', async () => {
  const { db, insJob } = await setup();
  await insJob({ status: 'in_transit', driver: 'Dana Driver', type: 'surge', stops: [
    { stop_number: 1, tracking_number: 'TPAAA111', recipient: 'Ann', address: '1 A St' },
    { stop_number: 2, tracking_number: 'TPBBB222', recipient: 'Bob', address: '2 B St', phone: '4045550000' }] });
  const r = await rpc(db, 'tp_track', { p_action: 'stop', p_args: { tracking_number: 'tpbbb222' } });
  assert.equal(r.surge_stops.length, 1);
  assert.equal(r.surge_stops[0].recipient, 'Bob');
  assert.ok(!JSON.stringify(r).includes('Ann'), 'other customers on the route are not exposed');
  assert.ok(!JSON.stringify(r).includes('4045550000'), 'phone numbers are not exposed');
  assert.equal(await rpc(db, 'tp_track', { p_action: 'stop', p_args: { tracking_number: 'TP' } }), null);
  await db.query(`insert into public.driver_locations (driver_name, job_id, lat, lng) values ('Dana Driver', $1, 1, 2)`, [r.id]);
  assert.deepEqual(Object.keys(await rpc(db, 'tp_track', { p_action: 'location', p_args: { id: r.id } })).sort(), ['lat', 'lng', 'updated_at']);
});

test('driver application: creates a pending driver who cannot sign in until approved', async () => {
  const { db } = await setup();
  const r = await rpc(db, 'tp_driver_signup', { p_args: { name: 'Avery Applicant', phone: '(470) 555-3333', date_of_birth: '1990-01-01', vehicle: 'Van', sms_consent: true, status: 'active' } });
  assert.equal(r.ok, true);
  assert.equal((await db.query(`select status from public.drivers where phone = '4705553333'`)).rows[0].status, 'pending_approval');
  assert.equal((await rpc(db, 'tp_driver_signup', { p_args: { name: 'Again', phone: '4705553333' } })).exists, true);
  assert.equal((await rpc(db, 'tp_svc_driver_code', { p_phone: '4705553333' }, 'service_role')).reason, 'not_approved');
});
