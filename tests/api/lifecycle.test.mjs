// API v1 end to end: an order submitted through the API is dispatched, sorted
// and staged in PathIQ, picked up and delivered by the driver, all through the
// real gateways the apps use (tp_org, tp_driver). Tracking, routes and proof of
// delivery are read back from what those apps recorded, nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORDER, ORG_A } from './harness.mjs';

const t = await setup();
const { call, sessionA, newKey, db } = t;
const key = (await newKey(sessionA)).key;
const O = t.org(sessionA);
const D = t.drv(await t.driverSession());
const jobOf = async (orderId) => (await db.query('select job_id from tp_api.orders where id = tp_api.parse_id($1, $2)', ['ord', orderId])).rows[0].job_id;
const get = (p) => call('GET', p, { key });
const types = (ev) => ev.map((e) => e.type);

test('the full journey: received, assigned, sorted, staged, out for delivery, delivered, with proof of delivery', async () => {
  const o = (await call('POST', '/orders', { key, body: ORDER(1, { tracking_number: 'TRK-100001', packages: 1 }) })).body;
  const jid = await jobOf(o.id);
  assert.equal((await get(`/orders/${o.id}`)).body.status, 'received');
  const noPod = await get(`/orders/${o.id}/proof-of-delivery`);
  assert.equal(noPod.status, 404); assert.equal(noPod.body.error.code, 'pod_not_available', 'no POD before delivery');

  await O('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });       // dispatcher
  let g = (await get(`/orders/${o.id}`)).body;
  assert.equal(g.status, 'assigned'); assert.deepEqual(g.route.driver, { name: 'Dana D.' });

  await O('log_event', { event_type: 'package.stowed', job_id: jid, payload: { code: 'TRK-100001', bin: '1A' },     // PathIQ
                         idempotency_key: 'stow-1' });
  assert.equal((await get(`/orders/${o.id}`)).body.status, 'sorted');
  await O('open_binding', { id: jid, bin_code: '1A', location_code: 'A-07', opened_by: 'Keisha' });
  await O('binding_ready', { id: jid });
  const st = await O('stage_binding', { id: jid, staging_code: 'STG:S-01' });
  assert.equal(st.ok, true, JSON.stringify(st));
  g = (await get(`/orders/${o.id}`)).body;
  assert.equal(g.status, 'staged'); assert.equal(g.staging_spot, 'S-01');

  await D('update_job', { id: jid, patch: { status: 'in_transit', picked_up_at: new Date().toISOString() } });  // driver
  g = (await get(`/orders/${o.id}`)).body;
  assert.equal(g.status, 'out_for_delivery'); assert.ok(g.out_for_delivery_at);

  const deliveredAt = new Date().toISOString();
  await D('post_message', { id: jid, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, stop_total: 1, recipient: 'Avery Collins',
    delivered_at: deliveredAt, pod_kind: 'photo', pod_url: `${jid}/stop-1-photo-1.jpg`, delivery_choice: 'handed',
    delivery_choice_label: 'Handed to customer', signed_by: 'Avery C.' }) });
  await D('post_message', { id: jid, body: 'POD_ATTACHED::' + JSON.stringify({ stop: 1, kind: 'signature', url: `${jid}/stop-1-signature-2.png` }) });
  await D('post_message', { id: jid, body: 'POD_ATTACHED::' + JSON.stringify({ stop: 1, kind: 'photo', url: `00000000-0000-0000-0000-000000000000/stolen.jpg` }) });
  await D('update_job', { id: jid, patch: { status: 'delivered', stops_completed: 1 } });

  g = (await get(`/orders/${o.id}`)).body;
  assert.equal(g.status, 'delivered'); assert.equal(g.delivered_at, deliveredAt); assert.equal(g.proof_of_delivery_available, true);
  assert.equal(g.route.status, 'completed');

  const ev = (await get(`/orders/${o.id}/events`)).body;
  assert.deepEqual(types(ev.data), ['received', 'assigned', 'sorted', 'staged', 'out_for_delivery', 'delivered']);
  assert.ok(ev.data.every((e) => e.occurred_at), 'every event has a recorded time');
  assert.equal(ev.data.find((e) => e.type === 'assigned').driver, 'Dana D.');

  const pod = await get(`/orders/${o.id}/proof-of-delivery`);
  assert.equal(pod.status, 200);
  assert.equal(pod.body.recipient_name, 'Avery C.'); assert.equal(pod.body.delivery_method_label, 'Handed to customer');
  assert.deepEqual(pod.body.media.map((m) => m.kind).sort(), ['photo', 'signature']);
  assert.ok(pod.body.media.every((m) => m.url.includes(jid) && !m.url.includes('stolen')), "only this job's files");
  assert.ok(pod.body.media.every((m) => Date.parse(m.expires_at) - Date.now() <= 900e3), 'links last at most 15 minutes');
  assert.ok(t.signed.every((s) => s.seconds === 900));

  const tr = await get('/tracking/trk-100001');
  assert.equal(tr.status, 200); assert.equal(tr.body.order.id, o.id); assert.equal(tr.body.events.length, 6);
  const all = JSON.stringify([g, ev.body, pod.body, tr.body]);   // the driver's phone is 4045551234 (random ids may contain "555")
  assert.ok(!all.includes('4045551234') && !all.includes('555-1234'), 'no phone numbers in any response');
});

test('before anything is recorded, nothing is invented: no sorted, staged or delivered times', async () => {
  const o = (await call('POST', '/orders', { key, body: ORDER(2) })).body;
  assert.equal(o.sorted_at, null); assert.equal(o.staged_at, null); assert.equal(o.delivered_at, null);
  assert.deepEqual(types((await get(`/orders/${o.id}/events`)).body.data), ['received']);
});

test('a stop reported as a problem: business closed is a delivery attempt, damaged is an exception', async () => {
  const mk = async (n) => { const o = (await call('POST', '/orders', { key, body: ORDER(n) })).body; const j = await jobOf(o.id);
    await O('update_job', { id: j, patch: { driver_name: 'Dana Driver', status: 'assigned' } }); return { o, j }; };
  const a = await mk(3), b = await mk(4);
  await D('post_message', { id: a.j, body: 'STOP_EXCEPTION::' + JSON.stringify({ stop_number: 1, reason: 'business_closed', reason_label: 'Business closed',
    reported_at: new Date().toISOString() }) });
  await D('post_message', { id: b.j, body: 'STOP_EXCEPTION::' + JSON.stringify({ stop_number: 1, reason: 'damaged', reason_label: 'Damaged',
    reported_at: new Date().toISOString() }) });
  const ga = (await get(`/orders/${a.o.id}`)).body, gb = (await get(`/orders/${b.o.id}`)).body;
  assert.equal(ga.status, 'delivery_attempted'); assert.equal(gb.status, 'exception');
  const ev = (await get(`/orders/${a.o.id}/events`)).body.data.at(-1);
  assert.equal(ev.type, 'delivery_attempted'); assert.equal(ev.reason, 'business_closed');
  assert.equal((await get(`/orders/${a.o.id}/proof-of-delivery`)).status, 404);
});

test('cancelled by dispatch', async () => {
  const o = (await call('POST', '/orders', { key, body: ORDER(5) })).body;
  await O('update_job', { id: await jobOf(o.id), patch: { status: 'cancelled' } });
  const g = (await get(`/orders/${o.id}`)).body;
  assert.equal(g.status, 'cancelled'); assert.equal(g.route.status, 'cancelled');
});

test('an order that dispatch puts on a multi-stop route follows that route and its stop', async () => {
  const a = (await call('POST', '/orders', { key, body: ORDER(6, { tracking_number: 'RTE-000006' }) })).body;
  const b = (await call('POST', '/orders', { key, body: ORDER(7, { tracking_number: 'RTE-000007' }) })).body;
  // a SmartSort route as the dispatcher publishes it (stop 2 combines two packages at one address);
  // dispatch puts an API order on a route by writing its TackPath order id (tp_order_id) on the stop or package
  const stops = [
    { stop_number: 1, tp_order_id: a.id, order_id: 'SO-1006', tracking_number: 'RTE-000006', recipient: 'Avery Collins', address: '214 Maple Grove Ln', packages: 1 },
    { stop_number: 2, order_id: 'X-9', recipient: 'Jordan Blake', address: '87 Cedar Hollow Dr', packages: 2,
      pkgs: [{ order_id: 'X-9', tracking_number: 'OTHER-1' }, { tp_order_id: b.id, order_id: 'SO-1007', tracking_number: 'RTE-000007' }] },
  ];
  const rid = (await db.query(`insert into public.jobs (org_id, title, status, job_type, surge_stops, total_stops, total_packages)
    values ($1, 'Surge Route RT-009', 'pending', 'surge', $2, 2, 3) returning id`, [ORG_A, JSON.stringify(stops)])).rows[0].id;
  let ga = (await get(`/orders/${a.id}`)).body, gb = (await get(`/orders/${b.id}`)).body;
  assert.equal(ga.route.stop_number, 1); assert.equal(gb.route.stop_number, 2);
  assert.equal(ga.route.id, gb.route.id); assert.notEqual(ga.route.id, a.route.id, 'now on the new route');

  await O('update_job', { id: rid, patch: { driver_name: 'Dana Driver', status: 'assigned' } });
  await D('update_job', { id: rid, patch: { status: 'in_transit' } });
  await D('post_message', { id: rid, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 2, stop_total: 2, order_id: 'X-9',
    delivered_at: new Date().toISOString() }) });
  ga = (await get(`/orders/${a.id}`)).body; gb = (await get(`/orders/${b.id}`)).body;
  assert.equal(ga.status, 'out_for_delivery', 'stop 1 is not delivered yet');
  assert.equal(gb.status, 'delivered', 'stop 2 is delivered');

  const route = (await get(`/routes/${ga.route.id}`)).body;
  assert.equal(route.type, 'route'); assert.equal(route.status, 'in_progress'); assert.deepEqual(route.driver, { name: 'Dana D.' });
  assert.deepEqual(route.stops.map((s) => s.status), ['pending', 'delivered']);
  const list = (await get('/routes?status=in_progress')).body.data;
  assert.ok(list.some((r) => r.id === ga.route.id));
  assert.ok(list.every((r) => !('stops' in r)), 'the list has no stop details');
});
