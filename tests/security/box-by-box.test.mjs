// Migration 72: box-by-box publishing and "Needs attention".
// Real migrations in PGlite (the full chain through 71), the dispatcher's session through tp_org.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError, ORG_A } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql', '71_keel_inbox.sql'];
const M72 = sqlFile('72_box_by_box_publishing.sql'), R72 = sqlFile('72_box_by_box_publishing.rollback.sql');

async function setup({ m72 = true } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
  if (m72) await db.exec(M72);
  const tokA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const tokB = (await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'other-code-2026' })).token;
  const A = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const AE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tokA, p_action: action, p_args: args });
  const B = (action, args = {}) => rpc(db, 'tp_org', { p_token: tokB, p_action: action, p_args: args });
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  return { db, A, AE, B, q };
}
const pkg = (id) => ({ order_id: 'O-' + id, tracking_number: id, piece_id: id, required_count: 1 });
// a route as the dispatcher sends it: stops numbered, each with its boxes
const plan = (code, stops, extra = {}) => ({ title: 'Surge Route ' + code, job_type: 'surge', master_code: code, status: 'pending',
  total_stops: stops.length, total_packages: stops.flat().length,
  surge_stops: stops.map((ids, i) => ({ address: (100 + i) + ' Main St', stop_number: i + 1, packages: ids.length, pkgs: ids.map(pkg) })), ...extra });

test('without "partial" the gate answers exactly as before: the whole route is refused', async () => {
  const { A, q } = await setup();
  const first = await A('publish_route', { payload: plan('R1', [['B1', 'B2']]) });
  assert.equal(first.ok, true);
  assert.deepEqual(first.held, []);
  const r = await A('publish_route', { payload: plan('R2', [['B2', 'B3']]) });
  assert.equal(r.ok, false);
  assert.equal(r.error, `piece_id B2 is already committed to live job ${first.job.id}`);
  assert.equal((await q(`select count(*)::int n from public.dispatch_attention`))[0].n, 0, 'nothing recorded for an old screen');
});

test('"partial": only the box already on a live route is held; the rest of the route is published', async () => {
  const { A, q } = await setup();
  const first = await A('publish_route', { payload: plan('R1', [['B1', 'B2']]) });
  const r = await A('publish_route', { payload: plan('R2', [['B2'], ['B3', 'B4'], ['B5']], { partial: true }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.held.map((h) => [h.piece_id, h.live_job_id]), [['B2', first.job.id]]);
  // stop 1 had only B2: dropped; the others renumbered; totals follow what was published
  const job = (await q(`select surge_stops, total_stops, total_packages from public.jobs where id = $1`, [r.job.id]))[0];
  assert.deepEqual(job.surge_stops.map((s) => [s.stop_number, s.pkgs.map((p) => p.piece_id), s.packages]), [[1, ['B3', 'B4'], 2], [2, ['B5'], 1]]);
  assert.equal(job.total_stops, 2); assert.equal(job.total_packages, 3);
  // recorded for the dispatcher, with the route it is already on
  const att = await A('attention');
  assert.equal(att.items.length, 1);
  assert.equal(att.items[0].kind, 'piece_held'); assert.equal(att.items[0].piece_id, 'B2'); assert.equal(att.items[0].ref, 'R2');
  assert.equal(att.items[0].detail.live_job_id, first.job.id);
});

test('a stop keeps its other boxes when only one of them is held', async () => {
  const { A, q } = await setup();
  await A('publish_route', { payload: plan('R1', [['B1']]) });
  const r = await A('publish_route', { payload: plan('R2', [['B1', 'B9']], { partial: true }) });
  assert.equal(r.ok, true);
  const s = (await q(`select surge_stops from public.jobs where id = $1`, [r.job.id]))[0].surge_stops;
  assert.deepEqual(s.map((x) => [x.stop_number, x.pkgs.map((p) => p.piece_id), x.packages]), [[1, ['B9'], 1]]);
});

test('every box held: the route is refused, each box is recorded once', async () => {
  const { A, q } = await setup();
  await A('publish_route', { payload: plan('R1', [['B1', 'B2']]) });
  const r = await A('publish_route', { payload: plan('R2', [['B1'], ['B2']], { partial: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'every box on this route is already on a live route');
  assert.deepEqual(r.held.map((h) => h.piece_id), ['B1', 'B2']);
  assert.equal((await q(`select count(*)::int n from public.jobs where master_code = 'R2'`))[0].n, 0);
  await A('publish_route', { payload: plan('R2', [['B1'], ['B2']], { partial: true }) });   // retried
  assert.equal((await A('attention')).items.length, 2, 'a retry records nothing new');
});

test('a retry of a published route returns the same job and the same held boxes, and changes nothing', async () => {
  const { A, q } = await setup();
  await A('publish_route', { payload: plan('R1', [['B1']]) });
  const a = await A('publish_route', { payload: plan('R2', [['B1'], ['B2']], { partial: true }) });
  const b = await A('publish_route', { payload: plan('R2', [['B1'], ['B2']], { partial: true }) });
  assert.equal(b.ok, true); assert.equal(b.idempotent, true); assert.equal(b.job.id, a.job.id);
  assert.deepEqual(b.held.map((h) => h.piece_id), ['B1']);
  assert.equal((await q(`select count(*)::int n from public.jobs`))[0].n, 2);
  assert.equal((await A('attention')).items.length, 1);
});

test('the checks on the whole plan still run first (duplicate box, declared totals)', async () => {
  const { A } = await setup();
  const dup = await A('publish_route', { payload: plan('R1', [['B1'], ['B1']], { partial: true }) });
  assert.equal(dup.error, 'duplicate piece_id within this plan: B1');
  const bad = await A('publish_route', { payload: plan('R2', [['B1']], { partial: true, total_packages: 5 }) });
  assert.match(bad.error, /total_packages \(5\) does not match/);
});

test('finished, cancelled and archived routes never hold a box (62 kept)', async () => {
  const { A, q } = await setup();
  for (const [code, set] of [['D', `status = 'delivered'`], ['C', `status = 'cancelled'`], ['X', `archived = true`]]) {
    const r = await A('publish_route', { payload: plan(code, [['B-' + code]]) });
    await q(`update public.jobs set ${set} where id = $1`, [r.job.id]);
    const again = await A('publish_route', { payload: plan(code + '2', [['B-' + code]], { partial: true }) });
    assert.equal(again.ok, true); assert.deepEqual(again.held, [], code);
  }
});

test('company isolation: another company\'s route never holds a box, and its items are never shown', async () => {
  const { A, B } = await setup();
  await B('publish_route', { payload: plan('RB', [['B1']]) });
  const r = await A('publish_route', { payload: plan('RA', [['B1']], { partial: true }) });
  assert.equal(r.ok, true); assert.deepEqual(r.held, []);
  await A('publish_route', { payload: plan('RA2', [['B1'], ['B7']], { partial: true }) });
  assert.equal((await A('attention')).items.length, 1);
  assert.equal((await B('attention')).items.length, 0);
});

test('attention_add, attention_resolve: a refused route is recorded once and closed with a note', async () => {
  const { A, AE, B } = await setup();
  assert.match(await AE('attention_add', { kind: 'piece_held', ref: 'x' }), /kind must be/);
  assert.match(await AE('attention_add', { kind: 'route_refused' }), /ref is required/);
  const a = await A('attention_add', { kind: 'route_refused', ref: 'R9', reason: 'no stops in payload', file_ref: 'keel-1', pieces: ['B1'] });
  assert.equal(a.new, true);
  assert.equal((await A('attention_add', { kind: 'route_refused', ref: 'R9', reason: 'again' })).new, false);
  const [item] = (await A('attention')).items;
  assert.equal(item.detail.reason, 'no stops in payload'); assert.deepEqual(item.detail.pieces, ['B1']);
  assert.equal((await B('attention_resolve', { id: item.id, note: 'not mine' })).ok, false, 'another company cannot close it');
  assert.match(await AE('attention_resolve', { id: item.id }), /a note is required/);
  assert.equal((await A('attention_resolve', { id: item.id, note: 'rebuilt by hand', by: 'Sam' })).ok, true);
  assert.equal((await A('attention')).items.length, 0);
  assert.equal((await A('attention_resolve', { id: item.id, note: 'twice' })).ok, false);
  // once closed, the same problem can be recorded again
  assert.equal((await A('attention_add', { kind: 'route_refused', ref: 'R9', reason: 'again' })).new, true);
});

test('inbox: a file claimed and never finished shows up after 15 minutes; inbox_done and inbox_retry', async () => {
  const { A, B, q } = await setup();
  await A('inbox_put', { ref: 'keel-1', filename: 'a.csv', csv: 'x' });
  await A('inbox_put', { ref: 'keel-2', filename: 'b.csv', csv: 'y' });
  const [f1, f2] = await A('inbox');
  await A('inbox_claim', { id: f1.id }); await A('inbox_claim', { id: f2.id });
  assert.deepEqual((await A('attention')).stale_files, [], 'just claimed');
  await q(`update public.smartsort_inbox set claimed_at = now() - interval '20 minutes'`);
  assert.equal((await A('inbox_done', { id: f1.id, result: { routes: 2, held: 0 } })).ok, true);
  assert.equal((await B('inbox_done', { id: f2.id })).ok, false, 'another company');
  const stale = (await A('attention')).stale_files;
  assert.deepEqual(stale.map((s) => s.ref), ['keel-2']);
  assert.deepEqual((await q(`select result from public.smartsort_inbox where ref = 'keel-1'`))[0].result, { routes: 2, held: 0 });
  // a failed file is recorded, then sent back to the inbox; the record closes itself
  await A('attention_add', { kind: 'file_failed', ref: 'keel-2', reason: 'screen closed' });
  assert.equal((await B('inbox_retry', { id: f2.id })).ok, false);
  assert.equal((await A('inbox_retry', { id: f2.id })).ok, true);
  assert.deepEqual((await A('inbox')).map((f) => f.ref), ['keel-2']);
  assert.equal((await A('attention')).items.length, 0);
  assert.deepEqual((await A('attention')).stale_files, []);
});

test('files claimed before 72 count as handled (no false alarms after the change)', async () => {
  const { A, db, q } = await setup({ m72: false });
  await A('inbox_put', { ref: 'old', csv: 'x' });
  await A('inbox_claim', { id: (await A('inbox'))[0].id });
  await q(`update public.smartsort_inbox set claimed_at = now() - interval '2 hours'`);
  await db.exec(M72);
  assert.deepEqual((await A('attention')).stale_files, []);
});

test('every other gateway action passes through unchanged; still only the tp_* entry points are public', async () => {
  const { A, q } = await setup();
  assert.ok(Array.isArray(await A('inbox')));
  const pub = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1`);
  assert.ok(pub.every((r) => r.proname.startsWith('tp_')), pub.map((r) => r.proname).join(','));
  for (const role of ['anon', 'authenticated']) {
    const can = (await q(`select has_table_privilege($1, 'public.dispatch_attention', 'select') c`, [role]))[0].c;
    assert.equal(can, false, role + ' cannot read the table directly');
  }
});

test('rollback: 62\'s gate and 71\'s gateway exactly; reapplying works; preflight refuses twice', async () => {
  const before = await setup({ m72: false });
  const def = async (d, f) => (await d.query(`select pg_get_functiondef($1::regprocedure) d`, [f])).rows[0].d;
  const acl = async (d, f) => (await d.query(`select proacl::text a, prosecdef s, proconfig::text c from pg_proc where oid = $1::regprocedure`, [f])).rows[0];
  const gate0 = await def(before.db, 'public.publish_surge_route(jsonb)'), org0 = await def(before.db, 'public.tp_org(text,text,jsonb)');
  const acl0 = await acl(before.db, 'public.tp_org(text,text,jsonb)');
  await before.db.exec(M72);
  await assert.rejects(before.db.exec(M72), /already applied/);
  await before.db.exec('rollback');
  await before.db.exec(R72);
  assert.equal(await def(before.db, 'public.publish_surge_route(jsonb)'), gate0);
  assert.equal(await def(before.db, 'public.tp_org(text,text,jsonb)'), org0);
  assert.deepEqual(await acl(before.db, 'public.tp_org(text,text,jsonb)'), acl0);
  assert.equal((await before.q(`select to_regclass('public.dispatch_attention') r`))[0].r, null);
  await assert.rejects(before.db.exec(R72), /was not applied/);
  await before.db.exec('rollback');
  await before.db.exec(M72);
  assert.equal((await before.A('publish_route', { payload: plan('R1', [['B1']], { partial: true }) })).ok, true);
});
