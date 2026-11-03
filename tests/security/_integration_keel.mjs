// Cross-system check (not part of CI): Keel's real TackPath client and SmartSort file against
// TackPath's real database code (migrations through 70) served over HTTP like Supabase's REST RPC.
import http from 'node:http';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';
const KEEL = process.argv[2];
const { TackPathOrgClient, smartSortCsv, etaFor } = await import(KEEL + '/api/dist/integrations/tackpath-org.js');

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const db = await freshDb();
await db.exec('drop function public.publish_surge_route(jsonb);'); await db.exec(PROD_GATE);
await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql']) await db.exec(sqlFile(f));
await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);

// Supabase-style REST RPC, as the anon key (what Keel uses)
const srv = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const fn = req.url.replace(/^\/rest\/v1\/rpc\//, '').split('?')[0];
  try { const out = await rpc(db, fn, JSON.parse(b || '{}'), 'anon'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
  catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: e.message })); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;

// 1. Keel's file for a same-day order promised 45 minutes from now
const promise = new Date(Date.now() + 45 * 60000).toISOString();
const csv = smartSortCsv({ order: { reference: 'O-100232', service: 'same_day', promised_by: promise },
  dropoff: { name: 'Ellis & Grant LLP', address1: '1075 Peachtree St NE', city: 'Atlanta', state: 'GA', postal_code: '30309' },
  packages: [{ barcode: 'O-100232-1' }] });
// 2. the dispatcher's SmartSort reads it (its own column parsing) and publishes the route through tp_org
const [head, line] = csv.trim().split('\n'); const h = head.split(','); const c = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((f) => f.replace(/,$/, '').replace(/^"|"$/g, ''));
const row = Object.fromEntries(h.map((k, i) => [k, c[i]]));
const tokA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
const pub = await rpc(db, 'tp_org', { p_token: tokA, p_action: 'publish_route', p_args: { payload: { title: 'Surge Route RT-001', job_type: 'surge',
  master_code: 'TP-INT-1', total_stops: 1, total_packages: 1, pickup_address: '1150 Huff Rd NW, Atlanta, GA 30318',
  surge_stops: [{ stop_number: 1, address: row.address, recipient: row.recipient, order_id: row.order_id, deliver_by: new Date(row.deliver_by).toISOString(),
    pkgs: [{ order_id: row.order_id, tracking_number: row.tracking_number, piece_id: row.tracking_number, required_count: 1 }] }] } } });
assert.equal(pub.ok, true, JSON.stringify(pub));
const jobId = pub.job.id;
// company B has its own late route at the same time
await db.query(`insert into public.jobs (org_id, title, status, driver_name, surge_stops, total_stops, estimated_delivery_at) values ($1, 'B route', 'in_transit', 'Ollie', $2, 1, now())`,
  [ORG_B, JSON.stringify([{ stop_number: 1, deliver_by: new Date(Date.now() - 5 * 60000).toISOString(), order_id: 'B-1' }])]);

// 3. the driver picks up; the live ETA puts the stop 60 minutes out, past the promise
await db.query(`update public.jobs set status = 'in_transit', driver_name = 'Andre Coleman', estimated_delivery_at = now() + interval '60 minutes' where id = $1`, [jobId]);
const tick = await rpc(db, 'tp_svc_ops_tick', {}, 'service_role');
assert.equal(tick.promises_at_risk, 2, 'one per company');

// 4. Keel's real client, signed in as company A, reads progress and the prediction
const client = new TackPathOrgClient({ base_url: 'https://tp.test', anon_key: 'anon', org_slug: 'quickhaul' }, 'qh-portal-2026',
  (u, o) => fetch(String(u).replace('https://tp.test', base), o));
const state = await client.state(['O-100232-1'], new Date(Date.now() - 86400000).toISOString());
assert.equal(state.packages[0].state, 'out_for_delivery');
assert.equal(state.promises.length, 1, 'Keel sees only its own company\'s predictions');
const eta = etaFor(state, ['O-100232-1']);
assert.equal(eta.risk, 'at_risk');
assert.ok(Math.abs(Date.parse(eta.eta) - (Date.now() + 60 * 60000)) < 120000, 'the live ETA');
assert.ok(Math.abs(eta.slack_min + 15) < 2, 'about 15 minutes past the promise');
// 5. TackPath dispatch has the decision; company B's is separate
const dA = await rpc(db, 'tp_org', { p_token: tokA, p_action: 'decisions', p_args: {} });
assert.equal(dA.length, 1); assert.equal(dA[0].kind, 'promise_risk'); assert.equal(dA[0].recommended_action, 'notify_dispatcher');
// 6. delivered: measured, and Keel reads it as delivered
await db.query(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Andre Coleman', 'driver', $2)`,
  [jobId, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, delivered_at: new Date(Date.now() + 55 * 60000).toISOString() })]);
await db.query(`update public.jobs set status = 'delivered', stops_completed = 1 where id = $1`, [jobId]);
await rpc(db, 'tp_svc_ops_tick', {}, 'service_role');
const [m] = await rpc(db, 'tp_org', { p_token: tokA, p_action: 'decisions', p_args: {} });
assert.equal(m.status, 'measured'); assert.ok(Math.abs(Number(m.error_min) + 5) < 1.5, 'arrived about 5 minutes sooner than predicted');
const after = await client.state(['O-100232-1'], new Date(Date.now() - 86400000).toISOString());
assert.equal(after.packages[0].state, 'delivered');
assert.equal(etaFor(after, ['O-100232-1']), null, 'no open prediction once delivered');
srv.close();
console.log('KEEL ↔ TACKPATH INTEGRATION OK');
