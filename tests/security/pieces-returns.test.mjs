// Migration 73: one record per box, one open assignment per box, returns with the right custody.
// Real migrations in PGlite (the full chain through 72); the dispatcher, PathIQ and the driver
// through their gateways, exactly as the apps call them today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql', '71_keel_inbox.sql', '72_box_by_box_publishing.sql'];
const M73 = sqlFile('73_pieces_and_returns.sql'), R73 = sqlFile('73_pieces_and_returns.rollback.sql');

async function setup({ m73 = true, before } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
  const tokA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const tokB = (await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'other-code-2026' })).token;
  const A = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const AE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const B = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokB, p_action: action, p_args: args });
  const BE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tokB, p_action: action, p_args: args });
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  if (before) await before({ A, q, db });
  if (m73) await db.exec(M73);
  const piece = async (id) => (await q(`select custody, status, condition, hold, attempts, last_reason from public.pieces where piece_id = $1`, [id]))[0];
  const open = async (id) => (await q(`select job_id, stop_number from public.piece_assignments where piece_id = $1 and released_at is null`, [id]));
  // the driver's stop reports, as the driver app posts them
  const report = (job, stop, kind, extra = {}) => q(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Dana', 'driver', $2)`,
    [job, `STOP_${kind}::` + JSON.stringify({ stop_number: stop, ...extra })]);
  return { db, A, AE, B, BE, q, piece, open, report };
}
const pkg = (id) => ({ order_id: 'O-' + id.split('-')[1], tracking_number: id, piece_id: id, required_count: 1 });
const plan = (code, stops, extra = {}) => ({ title: 'Surge Route ' + code, job_type: 'surge', master_code: code, status: 'pending', partial: true,
  total_stops: stops.length, total_packages: stops.flat().length,
  surge_stops: stops.map((ids, i) => ({ address: (100 + i) + ' Main St', stop_number: i + 1, packages: ids.length, pkgs: ids.map(pkg) })), ...extra });

test('a published route assigns each box once; stow, pickup and delivery move custody', async () => {
  const { A, q, piece, open, report } = await setup();
  const r = await A('publish_route', { payload: plan('R1', [['O-1-1', 'O-1-2'], ['O-2-1']]) });
  assert.equal(r.ok, true);
  assert.deepEqual(await piece('O-1-1'), { custody: 'assigned', status: 'normal', condition: 'intact', hold: null, attempts: 0, last_reason: null });
  assert.deepEqual((await open('O-2-1')).map((x) => [x.job_id, x.stop_number]), [[r.job.id, 2]]);
  // PathIQ stows O-1-1 (its own event, as stow.html logs it)
  await A('log_event', { event_type: 'package.stowed', job_id: r.job.id, payload: { bin: '1A', code: 'O-1-1', piece: 'O-1-1' }, idempotency_key: 'stow:1' });
  assert.equal((await piece('O-1-1')).custody, 'in_bin');
  assert.equal((await piece('O-1-2')).custody, 'assigned');
  // picked up
  await q(`update public.jobs set status = 'in_transit', picked_up_at = now() where id = $1`, [r.job.id]);
  for (const id of ['O-1-1', 'O-1-2', 'O-2-1']) assert.equal((await piece(id)).custody, 'with_driver', id);
  // stop 1 delivered (twice: the report is retried) -> delivered, assignment closed
  await report(r.job.id, 1, 'DELIVERED'); await report(r.job.id, 1, 'DELIVERED');
  assert.equal((await piece('O-1-1')).custody, 'delivered');
  assert.deepEqual(await open('O-1-1'), []);
  assert.equal((await open('O-2-1')).length, 1, 'stop 2 untouched');
  const h = await A('piece_history', { piece_id: 'O-1-1' });
  assert.deepEqual(h.events.map((e) => e.event_type), ['piece.assigned', 'piece.released', 'piece.delivered']);
  assert.equal(h.assignments[0].release_reason, 'delivered');
});

test('the return path: not delivered, route still out, received back, out again on a new route', async () => {
  const { A, AE, q, piece, open, report } = await setup();
  const r1 = await A('publish_route', { payload: plan('R1', [['O-1-1'], ['O-2-1']]) });
  await q(`update public.jobs set status = 'in_transit', picked_up_at = now() where id = $1`, [r1.job.id]);
  // R1: the driver can't deliver stop 1 (the report sent twice counts once)
  await report(r1.job.id, 1, 'EXCEPTION', { reason: 'business_closed', reason_label: 'Business closed' });
  await report(r1.job.id, 1, 'EXCEPTION', { reason: 'business_closed' });
  assert.deepEqual(await piece('O-1-1'), { custody: 'with_driver', status: 'returning', condition: 'intact', hold: null, attempts: 1, last_reason: 'business_closed' });
  assert.equal((await open('O-1-1')).length, 1, 'custody changes only on a scan: still on its route');
  // while it is still on its live route, a new route cannot take it
  const early = await A('publish_route', { payload: plan('R2', [['O-1-1'], ['O-9-1']]) });
  assert.equal(early.ok, true); assert.deepEqual(early.held.map((h) => h.piece_id), ['O-1-1']);
  await q(`update public.jobs set archived = true where id = $1`, [early.job.id]);
  // R3: the warehouse scans it RECEIVED, intact. The route is still out (stop 2 not done).
  const rec = await A('receive_return', { piece_id: 'O-1-1', condition: 'intact', by: 'Lee' });
  assert.equal(rec.ok, true); assert.equal(rec.custody, 'warehouse_returns'); assert.equal(rec.from_job_id, r1.job.id); assert.equal(rec.attempts, 1);
  assert.deepEqual(await open('O-1-1'), [], 'R4: no longer on its old route');
  const job = (await q(`select surge_stops, status from public.jobs where id = $1`, [r1.job.id]))[0];
  assert.deepEqual(job.surge_stops[0].pkgs, [], 'off the old route');
  assert.equal(job.surge_stops[0].returned_pkgs[0].piece_id, 'O-1-1', 'kept on the stop as returned');
  assert.equal((await open('O-2-1')).length, 1, 'the rest of the route is untouched');
  // scanned again: nothing changes
  assert.equal((await A('receive_return', { piece_id: 'O-1-1' })).replayed, true);
  // R7: out again on a new route at once, while the old route is still out
  const r3 = await A('publish_route', { payload: plan('R3', [['O-1-1']]) });
  assert.equal(r3.ok, true); assert.deepEqual(r3.held, []);
  assert.deepEqual((await open('O-1-1')).map((x) => x.job_id), [r3.job.id]);
  assert.equal((await piece('O-1-1')).custody, 'assigned');
  assert.equal((await piece('O-1-1')).attempts, 1, 'attempts are kept');
  // a delivered box cannot be received back
  await q(`update public.jobs set status = 'in_transit', picked_up_at = now() where id = $1`, [r3.job.id]);
  await report(r3.job.id, 1, 'DELIVERED');
  assert.match(await AE('receive_return', { piece_id: 'O-1-1' }), /TP_STATE: box O-1-1 is delivered/);
  assert.match(await AE('receive_return', { piece_id: 'NOPE' }), /not known to TackPath/);
  assert.match(await AE('receive_return', { piece_id: 'O-2-1', condition: 'wet' }), /condition must be intact or damaged/);
});

test('a damaged return is put on hold', async () => {
  const { A, q, piece, report } = await setup();
  const r = await A('publish_route', { payload: plan('R1', [['O-1-1']]) });
  await q(`update public.jobs set status = 'in_transit' where id = $1`, [r.job.id]);
  await report(r.job.id, 1, 'EXCEPTION', { reason: 'damaged' });
  await A('receive_return', { piece_id: 'O-1-1', condition: 'damaged' });
  assert.deepEqual(await piece('O-1-1'), { custody: 'warehouse_returns', status: 'normal', condition: 'damaged', hold: 'damaged', attempts: 1, last_reason: 'damaged' });
});

test('route over, cancelled or archived: open assignments close; boxes still in the warehouse wait for a route', async () => {
  const { A, q, piece, open } = await setup();
  const c = await A('publish_route', { payload: plan('RC', [['O-1-1']]) });
  await q(`update public.jobs set status = 'cancelled' where id = $1`, [c.job.id]);
  assert.deepEqual(await open('O-1-1'), []); assert.equal((await piece('O-1-1')).custody, 'awaiting_route');
  const x = await A('publish_route', { payload: plan('RX', [['O-2-1']]) });
  await q(`update public.jobs set archived = true where id = $1`, [x.job.id]);
  assert.equal((await piece('O-2-1')).custody, 'awaiting_route');
  const h = await A('piece_history', { piece_id: 'O-2-1' });
  assert.equal(h.assignments[0].release_reason, 'archived');
  // out on the road when the route closes: custody stays with the driver until it is scanned back
  const d = await A('publish_route', { payload: plan('RD', [['O-3-1']]) });
  await q(`update public.jobs set status = 'in_transit' where id = $1`, [d.job.id]);
  await q(`update public.jobs set status = 'completed_with_exceptions' where id = $1`, [d.job.id]);
  assert.equal((await piece('O-3-1')).custody, 'with_driver');
  assert.deepEqual(await open('O-3-1'), []);
});

test('never on two live routes, even when a route is written without the gate', async () => {
  const { A, q, open } = await setup();
  const r = await A('publish_route', { payload: plan('R1', [['O-1-1']]) });
  const org = (await q(`select org_id from public.jobs where id = $1`, [r.job.id]))[0].org_id;
  // an edge function inserting a route directly (no gate) with the same box
  await q(`insert into public.jobs (org_id, title, status, surge_stops) values ($1, 'Direct', 'pending', $2)`,
    [org, JSON.stringify([{ stop_number: 1, pkgs: [pkg('O-1-1')] }])]);
  assert.deepEqual((await open('O-1-1')).map((x) => x.job_id), [r.job.id]);
  const att = await A('attention');
  assert.deepEqual(att.items.map((i) => [i.kind, i.piece_id]), [['piece_conflict', 'O-1-1']]);
  // the database rule itself
  await assert.rejects(q(`insert into public.piece_assignments (org_id, piece_id, job_id) values ($1, 'O-1-1', gen_random_uuid())`, [org]), /duplicate key/);
});

test('a box taken off a route is released; changing stop order follows', async () => {
  const { A, q, open, piece } = await setup();
  const r = await A('publish_route', { payload: plan('R1', [['O-1-1'], ['O-2-1']]) });
  const stops = (await q(`select surge_stops from public.jobs where id = $1`, [r.job.id]))[0].surge_stops;
  await q(`update public.jobs set surge_stops = $2 where id = $1`, [r.job.id, JSON.stringify([{ ...stops[1], stop_number: 1 }])]);
  assert.deepEqual((await open('O-2-1')).map((x) => x.stop_number), [1]);
  assert.deepEqual(await open('O-1-1'), []);
  assert.equal((await piece('O-1-1')).custody, 'awaiting_route');
});

test('pieces: custody for Keel, this company only; at most 500', async () => {
  const { A, AE, B, BE } = await setup();
  const r = await A('publish_route', { payload: plan('R1', [['O-1-1', 'O-1-2']]) });
  const p = await A('pieces', { ids: ['O-1-2', 'O-1-1', 'NOPE'] });
  assert.deepEqual(p.map((x) => [x.piece_id, x.custody, x.job_id, x.stop_number]), [['O-1-1', 'assigned', r.job.id, 1], ['O-1-2', 'assigned', r.job.id, 1]]);
  assert.deepEqual(await B('pieces', { ids: ['O-1-1'] }), []);
  assert.match(await AE('pieces', { ids: Array.from({ length: 501 }, (_, i) => 'X' + i) }), /at most 500/);
  assert.match(await BE('receive_return', { piece_id: 'O-1-1' }), /not known to TackPath/, 'another company cannot receive this box');
});

test('backfill: routes live before 73 get their assignments; finished ones do not', async () => {
  let live, done;
  const { open, piece } = await setup({ before: async ({ A, q }) => {
    live = (await A('publish_route', { payload: plan('L', [['O-1-1']]) })).job.id;
    done = (await A('publish_route', { payload: plan('D', [['O-2-1']]) })).job.id;
    await q(`update public.jobs set status = 'delivered' where id = $1`, [done]);
  } });
  assert.deepEqual((await open('O-1-1')).map((x) => x.job_id), [live]);
  assert.deepEqual(await open('O-2-1'), []);
  assert.equal(await piece('O-2-1'), undefined);
});

test('every other gateway action passes through; still only tp_* entry points public; tables closed', async () => {
  const { A, q } = await setup();
  assert.ok(Array.isArray((await A('attention')).items));
  const pub = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1`);
  assert.ok(pub.every((r) => r.proname.startsWith('tp_')), pub.map((r) => r.proname).join(','));
  for (const t of ['public.pieces', 'public.piece_assignments']) for (const role of ['anon', 'authenticated'])
    assert.equal((await q(`select has_table_privilege($1, $2, 'select') c`, [role, t]))[0].c, false);
});

test('rollback: 72\'s gateway exactly, tables gone; reapply; preflight refuses twice', async () => {
  const s = await setup({ m73: false });
  const def = async (f) => (await s.db.query(`select pg_get_functiondef($1::regprocedure) d`, [f])).rows[0].d;
  const org0 = await def('public.tp_org(text,text,jsonb)');
  await s.db.exec(M73);
  await assert.rejects(s.db.exec(M73), /already applied/); await s.db.exec('rollback');
  await s.db.exec(R73);
  assert.equal(await def('public.tp_org(text,text,jsonb)'), org0);
  assert.equal((await s.q(`select to_regclass('public.pieces') r`))[0].r, null);
  await assert.rejects(s.db.exec(R73), /was not applied/); await s.db.exec('rollback');
  await s.db.exec(M73);
  assert.equal((await s.A('publish_route', { payload: plan('R1', [['O-1-1']]) })).ok, true);
});
