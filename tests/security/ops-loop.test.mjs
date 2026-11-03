// Migration 70: the operations loop, server-side and per company.
// Real migrations in PGlite (the full chain through 69), the scheduler calling
// tp_svc_ops_tick as the service role, companies through tp_org as anon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb, sqlFile, rpc, rpcError, ORG_A, ORG_B } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql'];
const T0 = '2026-11-02T14:00:00Z';                                  // 9:00 AM Atlanta
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();

async function setup({ m70 = true, before } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
  if (before) await before(db);
  if (m70) await db.exec(sqlFile('70_ops_loop.sql'));
  const tokA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const tokB = (await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'other-code-2026' })).token;
  const A = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const AE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const B = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokB, p_action: action, p_args: args });
  const BE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tokB, p_action: action, p_args: args });
  const tick = (min = 0, token = null) => rpc(db, 'tp_svc_ops_tick', { p_org: token, p_now: at(min) }, 'service_role');
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  // a route as the apps leave it: stops with coordinates, optional delivery promises
  const job = async (org, o = {}) => (await q(`insert into public.jobs (org_id, title, status, driver_name, job_type, surge_stops, total_stops, stops_completed,
      estimated_delivery_at, original_eta_at, staged_at, picked_up_at, started_at, created_at)
      values ($1,$2,$3,$4,'surge',$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [org, o.title ?? 'Route', o.status ?? 'in_transit', o.driver === undefined ? 'Dana Driver' : o.driver, JSON.stringify(o.stops ?? stopsN(3)),
     (o.stops ?? stopsN(3)).length, o.done ?? 0, o.eta ?? null, o.eta ?? null, o.staged ?? null, o.pickedUp ?? null, o.started ?? at(-10), o.created ?? at(-60)]))[0].id;
  const msgs = (id) => q(`select sender, body, org_id::text as org from public.messages where job_id = $1 order by id`, [id]);
  const deliver = (id, stop, minute) => q(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Dana Driver', 'driver', $2)`,
    [id, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: stop, delivered_at: at(minute) })]);
  return { db, A, AE, B, BE, tick, q, job, msgs, deliver, tokA, tokB };
}
const stopsN = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ stop_number: i + 1, address: `${100 + i} Peachtree St`,
  recipient: 'Customer ' + (i + 1), order_id: 'O-' + (i + 1), coords: { lat: 33.78 + i * 0.005, lng: -84.38 }, ...extra(i) }));

// ── 1. company isolation ────────────────────────────────────────────────
test('agent data: before 70 an org-less agent row reaches every company; 70 backfills it and keeps each company to its own', async () => {
  const seed = async (db) => {
    const [{ id }] = (await db.query(`insert into public.jobs (org_id, title, status) values ($1, 'A route', 'in_transit') returning id`, [ORG_A])).rows;
    await db.query(`insert into public.agent_memory (agent_name, event_type, job_id, driver_name, details) values ('SmartTrack', 'stop_past_eta', $1, 'Dana Driver', '{"minutes_late":25}')`, [id]);
    await db.query(`insert into public.agent_memory (agent_name, event_type, details) values ('SwarmCoordinator', 'pattern_detected', '{"insight":"A only"}')`);
  };
  const before = await setup({ m70: false, before: seed });
  assert.ok((await before.B('agent_memory')).some((m) => m.agent_name === 'SmartTrack'), 'without 70 company B reads company A\'s SmartTrack exception');

  const t = await setup({ before: seed });
  const rows = await t.q(`select agent_name, org_id::text as org from public.agent_memory order by id`);
  assert.equal(rows[0].org, ORG_A, 'the exception is backfilled to its route\'s company');
  assert.deepEqual(await t.B('agent_memory'), [], 'company B sees none of it');
  assert.deepEqual((await t.A('agent_memory')).map((m) => m.agent_name), ['SmartTrack'], 'company A sees its own; the org-less legacy row is shown to no one');
  // a new row on a route is stamped with the route's company, whatever the writer sent
  const [{ id: jb }] = await t.q(`insert into public.jobs (org_id, title, status) values ($1, 'B route', 'pending') returning id`, [ORG_B]);
  await t.q(`insert into public.agent_memory (agent_name, event_type, job_id) values ('SmartSort', 'cluster_created', $1)`, [jb]);
  assert.equal((await t.q(`select org_id::text as o from public.agent_memory where job_id = $1`, [jb]))[0].o, ORG_B);
});

test('the server tick keeps every company separate: messages, memory and decisions carry their own company', async () => {
  const t = await setup();
  const ja = await t.job(ORG_A, { eta: at(-30), driver: 'Dana Driver' });
  const jb = await t.job(ORG_B, { eta: at(-30), driver: 'Ollie Other' });
  await t.tick(-31);                                   // locks each stop's deadline
  const r = await t.tick(0);
  assert.equal(r.exceptions_flagged, 2);
  for (const [id, org] of [[ja, ORG_A], [jb, ORG_B]]) {
    const m = await t.msgs(id);
    assert.ok(m.some((x) => x.body.startsWith('SMARTTRACK::')) && m.every((x) => x.org === org), 'messages on the route stay in its company');
  }
  const mem = await t.q(`select org_id::text as o, job_id::text as j from public.agent_memory where agent_name = 'SmartTrack'`);
  assert.deepEqual(mem.map((x) => [x.j, x.o]).sort(), [[ja, ORG_A], [jb, ORG_B]].sort(), 'each exception is written with its company');
  const da = await t.A('decisions'), dbb = await t.B('decisions');
  assert.ok(da.length && da.every((d) => d.org_id === ORG_A && d.job_id === ja));
  assert.ok(dbb.length && dbb.every((d) => d.org_id === ORG_B && d.job_id === jb));
  // company B cannot act on company A's routes or decisions
  await t.BE('agent_claim', { key: 'checkin:' + ja + ':9', job_id: ja });
  const review = da.find((d) => d.status === 'awaiting_approval');
  if (review) assert.match(await t.BE('decide', { id: review.id, verdict: 'approve' }), /TP_INVALID/);
  // a company's own tick (session) runs only its own routes
  const jb2 = await t.job(ORG_B, { eta: at(5), started: at(-40) });
  const ja2 = await t.job(ORG_A, { eta: at(5), started: at(-40) });
  const ownA = await rpc(t.db, 'tp_svc_ops_tick', { p_org: ORG_A, p_now: at(6) }, 'service_role');
  assert.equal(ownA.checkins, 1, 'only company A\'s route got its check-in');
  assert.equal((await t.msgs(jb2)).length, 0, 'company B\'s route was not touched by company A\'s tick');
  assert.equal((await t.msgs(ja2)).filter((x) => x.sender === 'SmartComms').length, 1);
  assert.match(await rpcError(t.db, 'tp_svc_ops_tick', {}, 'anon'), /permission denied/, 'the public cannot run the tick');
});

test('Brain patterns are counted per company: three exceptions in A do not raise a pattern in B', async () => {
  const t = await setup();
  for (let k = 0; k < 3; k++) await t.job(ORG_A, { eta: at(-30), driver: 'Driver ' + k });
  await t.job(ORG_B, { eta: at(-30), driver: 'Ollie Other' });
  await t.tick(-31); await t.tick(0);
  const pat = await t.q(`select org_id::text as o from public.agent_memory where agent_name = 'SwarmCoordinator' and event_type = 'pattern_detected'`);
  assert.deepEqual(pat.map((p) => p.o), [ORG_A]);
  await t.tick(1);
  assert.equal((await t.q(`select count(*)::int n from public.agent_memory where event_type = 'pattern_detected'`))[0].n, 1, 'once per day');
});

// ── 2. server agents, never twice ───────────────────────────────────────
test('SmartComms: one check-in per 30 minutes and one end-of-route message, however many times the tick runs', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { started: at(-35), eta: at(30) });
  await Promise.all([t.tick(0), t.tick(0), t.tick(1)]);              // overlapping ticks
  let m = (await t.msgs(id)).filter((x) => x.sender === 'SmartComms');
  assert.equal(m.length, 1, 'one check-in in the first window');
  await t.tick(26);                                                  // 61 minutes in: second window
  await t.tick(27);
  assert.equal((await t.msgs(id)).filter((x) => x.sender === 'SmartComms').length, 2);
  await t.q(`update public.jobs set status = 'delivered', stops_completed = 3 where id = $1`, [id]);
  await t.q(`update public.jobs set delivered_at = $2 where id = $1`, [id, at(28)]);
  await t.tick(29); await t.tick(30);
  m = (await t.msgs(id)).filter((x) => x.body.startsWith('Great work'));
  assert.equal(m.length, 1, 'one end-of-route message');
  // a route finished long ago (before the server agents were on) gets nothing
  const old = await t.job(ORG_A, { status: 'delivered', started: at(-600), done: 3 });
  await t.q(`update public.jobs set delivered_at = $2 where id = $1`, [old, at(-400)]);
  await t.tick(31);
  assert.equal((await t.msgs(old)).length, 0);
});

test('the dispatcher and the server claim the same actions: whoever is first acts, the other stands down', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { started: at(-35), eta: at(30) });
  // the open dispatcher tab claims this window's check-in first
  assert.deepEqual(await t.A('agent_claim', { key: 'checkin:' + id + ':1', agent: 'SmartComms', job_id: id }), { claimed: true });
  await t.tick(0);
  assert.equal((await t.msgs(id)).filter((x) => x.sender === 'SmartComms').length, 0, 'the server does not send it again');
  // the server claims the next one first; the tab is told it is taken
  await t.tick(30);
  assert.deepEqual(await t.A('agent_claim', { key: 'checkin:' + id + ':2', agent: 'SmartComms', job_id: id }), { claimed: false });
  assert.deepEqual(await t.A('agent_mode'), { server_agents: true });
  // many tabs at once: exactly one claim succeeds
  const tries = await Promise.all(Array.from({ length: 6 }, () => t.A('agent_claim', { key: 'complete:' + id, job_id: id })));
  assert.equal(tries.filter((x) => x.claimed).length, 1);
});

test('SmartTrack locks the deadline when the driver heads to a stop, flags once, and re-arms for the next stop', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { eta: at(0) });
  await t.tick(0);                                                   // first sighting: lock only
  assert.equal((await t.msgs(id)).length, 0);
  await t.tick(19);
  assert.equal((await t.msgs(id)).filter((x) => x.sender === 'SmartTrack').length, 0, 'under 20 minutes late: nothing');
  await t.tick(21); await t.tick(22);
  const st = (await t.msgs(id)).filter((x) => x.sender === 'SmartTrack');
  assert.equal(st.length, 2, 'one dispatcher alert and one driver message, once');
  assert.equal((await t.q(`select exception_flag from public.jobs where id = $1`, [id]))[0].exception_flag, true);
  // the driver delivers stop 1 and heads to stop 2 with a new ETA: a fresh deadline
  await t.q(`update public.jobs set stops_completed = 1, estimated_delivery_at = $2 where id = $1`, [id, at(40)]);
  await t.tick(23); await t.tick(65);
  assert.equal((await t.msgs(id)).filter((x) => x.body.startsWith('SMARTTRACK::')).length, 2, 'stop 2 flagged once on its own deadline');
});

test('Ruby categorises each driver message once and writes its findings to the company', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { eta: at(60) });
  for (const b of ['Stuck in traffic on I-85', 'Customer not home', 'ok']) await t.q(`insert into public.messages (job_id, sender, sender_role, body, created_at) values ($1,'Dana Driver','driver',$2,$3)`, [id, b, at(-5)]);
  await t.tick(0); await t.tick(1);
  const r = await t.q(`select org_id::text as o, details from public.agent_memory where agent_name = 'Ruby'`);
  assert.equal(r.length, 1, 'analysed once');
  assert.equal(r[0].o, ORG_A);
  assert.deepEqual(r[0].details.category_breakdown, { traffic: 1, customer_issue: 1, acknowledgment: 1 });
});

test('server agents can be switched off: the tick then sends nothing, but predictions and measurement keep running', async () => {
  const t = await setup();
  await t.q(`update tp_sec.settings set value = 'false' where key = 'server_agents'`);
  const id = await t.job(ORG_A, { started: at(-35), eta: at(-30), stops: stopsN(1, () => ({ deliver_by: at(10) })) });
  const r = await t.tick(0);
  assert.equal(r.server_agents, false);
  assert.equal((await t.msgs(id)).length, 0);
  assert.equal(r.promises_predicted, 1);
  assert.deepEqual(await t.A('agent_mode'), { server_agents: false });
});

// ── 3. decisions and outcomes ───────────────────────────────────────────
test('a late stop becomes a decision: detected, acted on automatically, then measured against what happened', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { eta: at(0) });
  await t.tick(0); await t.tick(25);
  let [d] = (await t.A('decisions')).filter((x) => x.kind === 'late_stop');
  assert.equal(d.status, 'executed');
  assert.equal(d.executed_action, 'driver_messaged');
  assert.equal(d.prediction.late_min_at_detection, 25);
  assert.equal(d.requires_approval, false, 'a check-in message is low risk: automatic');
  await t.deliver(id, 1, 40);
  await t.tick(41);
  [d] = (await t.A('decisions')).filter((x) => x.kind === 'late_stop');
  assert.equal(d.status, 'measured');
  assert.equal(Number(d.actual.actual_late_min), 40, 'actually delivered 40 minutes after its ETA');
  assert.equal(Number(d.error_min), 15, '15 minutes later than it was when flagged');
});

test('moving stops needs a person: the Brain proposes it, the dispatcher approves or rejects, the change is detected and measured', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { eta: at(0), stops: stopsN(4) });   // stops 0.35 mi apart: tight
  await t.tick(0); await t.tick(22);
  let [r] = (await t.A('decisions', { status: 'awaiting_approval' }));
  assert.equal(r.kind, 'reassign_review');
  assert.equal(r.requires_approval, true);
  assert.equal(r.risk, 'medium');
  assert.match(await t.AE('decide', { id: r.id, verdict: 'maybe' }), /TP_INVALID/);
  const ok = await t.A('decide', { id: r.id, verdict: 'approve', by: 'Marco (dispatch)', note: 'moving 3 and 4 to Lee' });
  assert.equal(ok.status, 'approved');
  assert.match(await t.AE('decide', { id: r.id, verdict: 'reject' }), /TP_INVALID/, 'decided once');
  await t.tick(23);
  assert.equal((await t.A('decisions', { status: 'approved' })).length, 1, 'not executed until the route actually changes');
  await t.q(`update public.jobs set surge_stops = $2, total_stops = 2 where id = $1`, [id, JSON.stringify(stopsN(2))]);
  await t.tick(24);
  [r] = (await t.A('decisions')).filter((x) => x.id === r.id);
  assert.equal(r.status, 'executed');
  assert.equal(r.executed_action, 'route_changed');
  assert.equal(r.decided_by, 'Marco (dispatch)');
  await t.deliver(id, 1, 30); await t.tick(31);
  [r] = (await t.A('decisions')).filter((x) => x.id === r.id);
  assert.equal(r.status, 'measured');
  assert.equal(r.actual.decision, 'executed');
});

test('a rejected proposal stays rejected, and the outcome is still measured', async () => {
  const t = await setup();
  const id = await t.job(ORG_A, { eta: at(0), stops: stopsN(3) });
  await t.tick(0); await t.tick(22);
  const [r] = await t.A('decisions', { status: 'awaiting_approval' });
  await t.A('decide', { id: r.id, verdict: 'reject', note: 'driver is nearly there' });
  await t.deliver(id, 1, 26); await t.tick(27);
  const [x] = (await t.A('decisions')).filter((d) => d.id === r.id);
  assert.equal(x.status, 'rejected');
  assert.ok(x.measured_at && x.actual.actual_at);
});

// ── 4. delivery promise, warehouse to door ──────────────────────────────
test('promise watch: predicts each stop against its promise, flags the ones heading late, and is measured on delivery', async () => {
  const t = await setup();
  // in transit on stop 1 (ETA in 10 min); stop 3 promised in 25 min, but at 12 min a stop it lands at about 34
  const id = await t.job(ORG_A, { eta: at(10), stops: stopsN(3, (i) => (i === 2 ? { deliver_by: at(25) } : i === 0 ? { deliver_by: at(60) } : {})) });
  const r = await t.tick(0);
  assert.equal(r.promises_predicted, 2);
  const pw = await t.A('promise_watch');
  const s1 = pw.find((p) => p.stop_number === 1), s3 = pw.find((p) => p.stop_number === 3);
  assert.equal(s1.risk, 'on_track');
  assert.equal(new Date(s3.predicted_at).toISOString(), at(34), 'live ETA + two stops at 12 minutes each');
  assert.equal(s3.risk, 'at_risk');
  assert.deepEqual(await t.B('promise_watch'), [], 'another company sees none of it');
  const [d] = (await t.A('decisions')).filter((x) => x.kind === 'promise_risk');
  assert.equal(Number(d.prediction.expected_late_min), 9);
  assert.equal(d.recommended_action, 'reassign_review', 'a later stop on a moving route: moving it needs approval');
  assert.equal(d.status, 'awaiting_approval');
  await t.tick(1);
  assert.equal((await t.A('decisions')).filter((x) => x.kind === 'promise_risk').length, 1, 'flagged once');
  // what really happened
  await t.deliver(id, 1, 11); await t.deliver(id, 2, 22); await t.deliver(id, 3, 31);
  await t.q(`update public.jobs set stops_completed = 3, status = 'delivered' where id = $1`, [id]);
  await t.tick(32);
  const [m] = (await t.A('decisions')).filter((x) => x.kind === 'promise_risk');
  assert.equal(m.status, 'measured');
  assert.equal(Number(m.actual.actual_late_min), 6, 'delivered 6 minutes after the promise');
  assert.equal(Number(m.error_min), -3, 'the prediction was 3 minutes pessimistic');
  assert.ok((await t.A('promise_watch')).every((p) => p.risk === 'delivered'));
  const ins = await t.A('ops_insights');
  assert.equal(ins.by_kind.promise_risk.measured, 1);
  assert.equal(Number(ins.by_kind.promise_risk.mean_abs_error_min), 3);
  assert.equal(ins.by_kind.promise_risk.ended_late, 1);
  assert.deepEqual(await t.B('ops_insights').then((x) => x.by_kind), {}, 'insights are per company');
});

test('promise watch before pickup: an unassigned route is told to assign a driver; a staged one to start; no approval needed', async () => {
  const t = await setup();
  await t.job(ORG_A, { status: 'pending', driver: null, stops: stopsN(1, () => ({ deliver_by: at(30) })) });
  await t.job(ORG_A, { status: 'assigned', staged: at(-5), stops: stopsN(1, () => ({ deliver_by: at(20) })) });
  await t.tick(0);
  const ds = (await t.A('decisions')).filter((x) => x.kind === 'promise_risk').map((d) => [d.recommended_action, d.requires_approval]).sort();
  assert.deepEqual(ds, [['assign_driver', false], ['start_route', false]]);
});

test('Keel reads its promises through its own company session; the stop keeps the order reference it was sent with', async () => {
  const t = await setup();
  await t.job(ORG_A, { status: 'assigned', staged: at(-5), stops: [{ stop_number: 1, address: '1075 Peachtree St NE', order_id: 'KEEL-O-100232',
    pkgs: [{ order_id: 'KEEL-O-100232', tracking_number: 'O-100232-1' }], deliver_by: at(300) }] });
  await t.tick(0);
  const [p] = await t.A('promise_watch');
  assert.equal(p.order_ref, 'KEEL-O-100232');
  assert.equal(p.risk, 'on_track');
  assert.equal(new Date(p.deliver_by).toISOString(), at(300));
});

test('rollback restores the previous gateway and removes only what 70 added', async () => {
  const t = await setup();
  await t.job(ORG_A, { eta: at(0) }); await t.tick(0); await t.tick(25);
  await t.db.exec(sqlFile('70_ops_loop.rollback.sql'));
  assert.equal((await t.q(`select to_regclass('public.ops_decisions') is null as gone`))[0].gone, true);
  assert.ok(Array.isArray(await t.A('jobs')), 'the gateway still works');
  assert.ok((await t.q(`select count(*)::int n from public.messages`))[0].n > 0, 'messages are kept');
  await assert.rejects(t.db.exec(sqlFile('70_ops_loop.rollback.sql')), /was not applied/);
  await t.db.exec('rollback');
  await t.db.exec(sqlFile('70_ops_loop.sql'));
  await assert.rejects(t.db.exec(sqlFile('70_ops_loop.sql')), /already applied/);
});

test('swarm-watch only runs the tick: the company comes from the verified session, never from the request', () => {
  const src = fs.readFileSync(new URL('../../supabase/functions/swarm-watch/index.ts', import.meta.url), 'utf8');
  assert.match(src, /const org_id = guard\.session\.kind === "org" \? guard\.session\.org_id : null;/);
  assert.match(src, /rpc\("tp_svc_ops_tick", \{ p_org: org_id \}\)/);
  assert.doesNotMatch(src, /createClient\(|\.from\(|req\.json\(\)/, 'no direct table writes with the service key, nothing read from the body');
});
