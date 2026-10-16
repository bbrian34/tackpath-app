// Migration 68: the server writes jobs.picked_up_at (status -> in_transit)
// and jobs.delivered_at (status -> delivered / completed_with_exceptions),
// once, never overwriting. Real migrations in PGlite (the full chain 10, 20,
// 50, 60-65, 67 with the production publication gate), every app call
// through the public tp_* functions as the anon role. The same scenario runs
// on a database without 68 and one with 68; every gateway answer must be the
// same apart from the two times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError, ORG_A } from './fixture.mjs';

const M68 = sqlFile('68_job_timestamps.sql');
const R68 = sqlFile('68_job_timestamps.rollback.sql');
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql'];

// prod: jobs.delivered_at exists in production (tp_driver update_job allows it, the dispatcher reads it);
// the fixture's jobs table predates it, so it is added the way production has it unless prod:false.
async function setup({ m68 = true, prod = true } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  for (const f of CHAIN) await db.exec(sqlFile(f));
  if (prod) await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz');
  if (m68) await db.exec(M68);
  const tok = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const OE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code });
  const D = (action, args = {}) => rpc(db, 'tp_driver', { p_token: drv.token, p_action: action, p_args: args });
  const DE = (action, args = {}) => rpcError(db, 'tp_driver', { p_token: drv.token, p_action: action, p_args: args });
  const name = drv.driver.name;
  let n = 0;
  const route = async (title, tns) => {
    const res = await O('publish_route', { payload: { title, job_type: 'surge', master_code: 'TP-TS-' + title.replace(/\W/g, '') + '-' + (++n),
      total_stops: 1, total_packages: tns.length,
      surge_stops: [{ stop_number: 1, address: title + ' St', recipient: 'Customer', pkgs: tns.map((tn) => ({ order_id: 'O-' + tn, tracking_number: tn, piece_id: tn, required_count: 1 })) }] } });
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.job.id;
  };
  const row = async (id) => (await db.query('select status, picked_up_at, delivered_at from public.jobs where id = $1', [id])).rows[0];
  return { db, O, OE, D, DE, name, route, row };
}

test('a. moving to in_transit sets picked_up_at once; a second update does not change it', async () => {
  const t = await setup();
  const id = await t.route('Route A', ['TA1', 'TA2']);
  await t.O('update_job', { id, patch: { status: 'assigned', driver_name: t.name } });
  assert.equal((await t.row(id)).picked_up_at, null, 'not on assignment');
  const before = Date.now();
  await t.D('update_job', { id, patch: { status: 'in_transit', driver_name: t.name } });     // what Start Route sends
  const first = (await t.row(id)).picked_up_at;
  assert.ok(first instanceof Date, 'picked_up_at set');
  assert.ok(Math.abs(first.getTime() - before) < 60000);
  assert.equal((await t.row(id)).delivered_at, null);
  await new Promise((r) => setTimeout(r, 20));
  await t.D('update_job', { id, patch: { status: 'in_transit', driver_name: t.name, stops_completed: 1 } });
  await t.D('update_job', { id, patch: { stops_completed: 2 } });
  assert.equal((await t.row(id)).picked_up_at.getTime(), first.getTime(), 'unchanged by later updates');
  // a time the client sends itself is kept (never overwritten)
  const id2 = await t.route('Route A2', ['TA3']);
  await t.O('update_job', { id: id2, patch: { status: 'assigned', driver_name: t.name } });
  await t.D('update_job', { id: id2, patch: { status: 'in_transit', picked_up_at: '2026-10-09T15:00:00Z', driver_name: t.name } });
  assert.equal((await t.row(id2)).picked_up_at.toISOString(), '2026-10-09T15:00:00.000Z');
  // back to assigned and in transit again (dispatch reset): still the first pickup time
  await t.db.query(`update public.jobs set status = 'assigned' where id = $1`, [id]);
  await t.db.query(`update public.jobs set status = 'in_transit' where id = $1`, [id]);
  assert.equal((await t.row(id)).picked_up_at.getTime(), first.getTime());
});

for (const end of ['delivered', 'completed_with_exceptions']) {
  test(`b. moving to ${end} sets delivered_at once`, async () => {
    const t = await setup();
    const id = await t.route('Route B ' + end, ['TB1']);
    await t.O('update_job', { id, patch: { status: 'assigned', driver_name: t.name } });
    await t.D('update_job', { id, patch: { status: 'in_transit', driver_name: t.name } });
    assert.equal((await t.row(id)).delivered_at, null, 'not at pickup');
    await t.D('update_job', { id, patch: { status: end, driver_name: t.name, stops_completed: 1 } });  // what the last stop sends
    const r = await t.row(id);
    assert.equal(r.status, end);
    assert.ok(r.delivered_at instanceof Date, 'delivered_at set');
    assert.ok(r.picked_up_at instanceof Date && r.delivered_at >= r.picked_up_at);
    const first = r.delivered_at.getTime();
    await t.db.query(`update public.jobs set status = $2 where id = $1`, [id, end === 'delivered' ? 'completed_with_exceptions' : 'delivered']);
    await t.db.query(`update public.jobs set route_summary = 'x' where id = $1`, [id]);
    assert.equal((await t.row(id)).delivered_at.getTime(), first, 'unchanged by later updates');
  });
}

test('c. cancelled routes (before or after pickup) get neither time; other statuses neither', async () => {
  const t = await setup();
  const a = await t.route('Route C1', ['TC1']);
  await t.O('update_job', { id: a, patch: { status: 'cancelled' } });
  assert.deepEqual([(await t.row(a)).picked_up_at, (await t.row(a)).delivered_at], [null, null]);
  const b = await t.route('Route C2', ['TC2']);
  await t.O('update_job', { id: b, patch: { status: 'assigned', driver_name: t.name } });
  await t.D('update_job', { id: b, patch: { status: 'in_transit', driver_name: t.name } });
  const p = (await t.row(b)).picked_up_at;
  await t.O('update_job', { id: b, patch: { status: 'cancelled' } });
  assert.equal((await t.row(b)).delivered_at, null, 'a cancelled route is not delivered');
  assert.equal((await t.row(b)).picked_up_at.getTime(), p.getTime(), 'its real pickup time stays');
  const c = await t.route('Route C3', ['TC3']);
  for (const s of ['routing', 'assigned', 'pending', 'closed_with_exceptions']) await t.db.query(`update public.jobs set status = $2 where id = $1`, [c, s]);
  assert.deepEqual([(await t.row(c)).picked_up_at, (await t.row(c)).delivered_at], [null, null]);
  // inserts are untouched
  const ins = (await t.db.query(`insert into public.jobs (org_id, title, status, job_type) values ($1, 'Ins', 'in_transit', 'surge') returning picked_up_at`, [ORG_A])).rows[0];
  assert.equal(ins.picked_up_at, null);
});

// d. the release on pickup, with and without 68: identical spots and states
async function releaseScenario(t) {
  const id = await t.route('Route D', ['TD1', 'TD2']);
  await t.O('open_binding', { id, bin_code: '1A', location_code: 'A-01', opened_by: 'Sam' });
  await t.O('binding_ready', { id });
  assert.equal((await t.O('stage_binding', { id, staging_code: 'STG:S-01' })).ok, true);
  await t.O('update_job', { id, patch: { status: 'assigned', driver_name: t.name } });
  await t.D('update_job', { id, patch: { status: 'in_transit', driver_name: t.name } });
  const binds = (await t.db.query(`select bin_code, location_code, staging_code, state, released_at is not null as released from public.bin_bindings where job_id = $1`, [id])).rows;
  // the same bin, LOC and STG are free for the next route
  const next = await t.route('Route D next', ['TD3']);
  const reopen = await t.O('open_binding', { id: next, bin_code: '1A', location_code: 'A-01', opened_by: 'Sam' });
  await t.O('binding_ready', { id: next });
  const restage = await t.O('stage_binding', { id: next, staging_code: 'STG:S-01' });
  const live = (await t.db.query(`select bin_code, location_code, staging_code, state from public.bin_bindings where state in ('open','ready') order by bin_code`)).rows;
  return { binds, reopen: strip(reopen), restage: strip(restage), live };
}
test('d. the bin / LOC / STG release on in_transit works exactly as before', async () => {
  const before = await releaseScenario(await setup({ m68: false }));
  const after = await releaseScenario(await setup());
  assert.equal(before.binds[0].released, true, 'released on pickup (without 68)');
  assert.deepEqual(after, before);
});

// e. response shapes (and values, apart from ids, tokens and times) unchanged
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function strip(v, key) {
  if (Array.isArray(v)) return v.map((x) => strip(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, strip(v[k], k)]));
  if (typeof v === 'string') {
    if (/token|code_hash|^code$/.test(key || '')) return '<secret>';
    if (UUID.test(v)) return '<uuid>';
    if (TS.test(v)) return '<time>';
    if (/^TP-TS-/.test(v)) return '<master>';
    return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  }
  return v;
}
// the two times are compared on their own (their values are the change); everything else must be identical
const TIMES = new Set(['picked_up_at', 'delivered_at']);
const dropTimes = (v) => JSON.parse(JSON.stringify(v, (k, x) => (TIMES.has(k) ? undefined : x)));
const keysOf = (v) => (Array.isArray(v) ? v.map(keysOf) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k, keysOf(v[k])])) : typeof v);
const keyTree = (v) => JSON.parse(JSON.stringify(keysOf(v), (k, x) => (TIMES.has(k) ? 'time' : x)));
async function gatewayScenario(t) {
  const out = [];
  const call = async (label, fn) => { try { out.push([label, strip(await fn())]); } catch (e) { out.push([label, 'ERROR ' + String(e.message).replace(UUID, '<uuid>')]); } };
  const id = await t.route('Route E', ['TE1', 'TE2']);
  await call('publish duplicate piece (gate refusal)', () => t.O('publish_route', { payload: { title: 'Dup', job_type: 'surge', master_code: 'TP-TS-DUP',
    total_stops: 1, total_packages: 1, surge_stops: [{ stop_number: 1, address: 'x', pkgs: [{ order_id: 'O-TE1', tracking_number: 'TE1', piece_id: 'TE1', required_count: 1 }] }] } }));
  await call('publish replay (idempotent)', async () => { const r = await t.db.query('select master_code from public.jobs where id = $1', [id]);
    return t.O('publish_route', { payload: { title: 'Route E', job_type: 'surge', master_code: r.rows[0].master_code, total_stops: 1, total_packages: 2,
      surge_stops: [{ stop_number: 1, address: 'Route E St', recipient: 'Customer', pkgs: ['TE1', 'TE2'].map((tn) => ({ order_id: 'O-' + tn, tracking_number: tn, piece_id: tn, required_count: 1 })) }] } }); });
  await call('org open_binding', () => t.O('open_binding', { id, bin_code: '2A', location_code: 'A-02', opened_by: 'Sam' }));
  await call('org binding_ready', () => t.O('binding_ready', { id }));
  await call('org stage_binding', () => t.O('stage_binding', { id, staging_code: 'STG:S-02' }));
  await call('org update_job assign', () => t.O('update_job', { id, patch: { status: 'assigned', driver_name: t.name } }));
  await call('driver me', () => t.D('me'));
  await call('driver jobs mine', () => t.D('jobs', { mine: true }));
  await call('driver job', () => t.D('job', { id }));
  await call('driver bin_binding', () => t.D('bin_binding', { job_id: id }));
  await call('driver update_job in_transit', () => t.D('update_job', { id, patch: { status: 'in_transit', driver_name: t.name } }));
  await call('driver job after pickup', () => t.D('job', { id }));
  await call('org jobs', () => t.O('jobs', {}));
  await call('org jobs exclude_archived', () => t.O('jobs', { exclude_archived: true }));
  await call('driver update_job delivered', () => t.D('update_job', { id, patch: { status: 'delivered', driver_name: t.name, stops_completed: 1 } }));
  await call('org jobs after delivery', () => t.O('jobs', { ids: [id] }));
  await call('self-heal: same bin for the next route', async () => { const nx = await t.route('Route E next', ['TE3']); return t.O('open_binding', { id: nx, bin_code: '2A', location_code: 'A-02', opened_by: 'Sam' }); });
  await call('driver refused (another company job)', () => t.DE('job', { id: '00000000-0000-4000-8000-000000000000' }));
  await call('org bad token', () => rpcError(t.db, 'tp_org', { p_token: 'nope', p_action: 'jobs', p_args: {} }));
  return out;
}
test('e. publication gate, self-heal, tp_driver and tp_org answers: same shapes and values before and after 68', async () => {
  const before = await gatewayScenario(await setup({ m68: false }));
  const after = await gatewayScenario(await setup());
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i][0], before[i][0]);
    assert.deepEqual(dropTimes(after[i][1]), dropTimes(before[i][1]), 'answer of: ' + before[i][0]);
    assert.deepEqual(keyTree(after[i][1]), keyTree(before[i][1]), 'shape of: ' + before[i][0]);
  }
  // the only difference: the two times are now filled in
  const jobsAfter = after.find((x) => x[0] === 'org jobs after delivery')[1][0];
  const jobsBefore = before.find((x) => x[0] === 'org jobs after delivery')[1][0];
  assert.deepEqual(Object.keys(jobsAfter), Object.keys(jobsBefore), 'same keys in a job');
  assert.equal(jobsBefore.picked_up_at, null); assert.equal(jobsBefore.delivered_at, null);
  assert.equal(jobsAfter.picked_up_at, '<time>'); assert.equal(jobsAfter.delivered_at, '<time>');
});

test('f. 68 checks the columns, refuses to run twice; the rollback restores the prior state exactly', async () => {
  const state = async (db) => (await db.query(`
    select (select json_agg(json_build_object('n', tgname, 'def', pg_get_triggerdef(oid)) order by tgname) from pg_trigger
             where tgrelid = 'public.jobs'::regclass and not tgisinternal) as triggers,
           (select json_agg(json_build_object('c', column_name, 't', data_type, 'null', is_nullable) order by ordinal_position)
              from information_schema.columns where table_schema = 'public' and table_name = 'jobs') as cols,
           (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','tp_sec')) as fns,
           (select json_agg(p.proname || ':' || coalesce(p.proacl::text, '') order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public') as public_fns`)).rows[0];
  // production-like: both columns there
  const t = await setup({ m68: false });
  const s0 = await state(t.db);
  await t.db.exec(M68);
  const s1 = await state(t.db);
  assert.deepEqual(s1.cols, s0.cols, 'no column added when both exist');
  assert.deepEqual(s1.public_fns, s0.public_fns, 'no public function added or changed');
  assert.ok(s1.triggers.some((x) => x.n === 'tp_set_job_timestamps' && /BEFORE UPDATE OF status/.test(x.def)));
  assert.deepEqual(s1.triggers.filter((x) => x.n !== 'tp_set_job_timestamps'), s0.triggers, 'existing triggers untouched');
  await assert.rejects(t.db.exec(M68), /already applied/); await t.db.exec('rollback');
  await t.db.exec(R68);
  assert.deepEqual(await state(t.db), s0, 'rollback: triggers, columns, functions as before');
  await assert.rejects(t.db.exec(R68), /not in place/); await t.db.exec('rollback');
  // delivered_at missing (the fixture as it was): 68 adds it, nullable timestamptz; the rollback removes it again
  const u = await setup({ m68: false, prod: false });
  const u0 = await state(u.db);
  assert.ok(!u0.cols.some((c) => c.c === 'delivered_at'));
  await u.db.exec(M68);
  const added = (await state(u.db)).cols.find((c) => c.c === 'delivered_at');
  assert.deepEqual(added, { c: 'delivered_at', t: 'timestamp with time zone', null: 'YES' });
  const id = await u.route('Route F', ['TF1']);
  await u.O('update_job', { id, patch: { status: 'assigned', driver_name: u.name } });
  await u.D('update_job', { id, patch: { status: 'in_transit', driver_name: u.name } });
  await u.D('update_job', { id, patch: { status: 'delivered', driver_name: u.name } });
  assert.ok((await u.row(id)).delivered_at instanceof Date);
  await u.db.exec(R68);
  assert.deepEqual(await state(u.db), u0, 'rollback removes only what 68 added');
  // a column of the wrong type: refused, nothing changed
  const w = await setup({ m68: false, prod: false });
  await w.db.exec('alter table public.jobs add column delivered_at text');
  const w0 = await state(w.db);
  await assert.rejects(w.db.exec(M68), /delivered_at exists but is not a timestamp/); await w.db.exec('rollback');
  assert.deepEqual(await state(w.db), w0);
});
