// Migration 74: recovery rules. Real migrations in PGlite (the full chain through 73); the apps through
// their gateways and the database as they leave it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql', '71_keel_inbox.sql', '72_box_by_box_publishing.sql', '73_pieces_and_returns.sql'];
const M74 = sqlFile('74_recovery_rules.sql'), R74 = sqlFile('74_recovery_rules.rollback.sql');

async function setup({ m74 = true } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  if (m74) await db.exec(M74);
  const tok = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const A = (action, args = {}) => rpc(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const AE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: tok, p_action: action, p_args: args });
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const piece = async (id) => (await q(`select custody, status, condition, hold, attempts, avoid_driver_name, investigation_level, investigation_opened_at is not null inv from public.pieces where piece_id = $1`, [id]))[0];
  const open = async (id) => (await q(`select job_id from public.piece_assignments where piece_id = $1 and released_at is null`, [id])).map((r) => r.job_id);
  const report = (job, stop, kind, extra = {}) => q(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'D', 'driver', $2)`,
    [job, `STOP_${kind}::` + JSON.stringify({ stop_number: stop, ...extra })]);
  const tick = (iso) => rpc(db, 'tp_svc_piece_tick', { p_now: iso }, 'service_role');
  return { db, A, AE, q, piece, open, report, tick };
}
const pkg = (id) => ({ order_id: 'O-' + id.split('-')[1], tracking_number: id, piece_id: id, required_count: 1 });
const plan = (code, stops) => ({ title: 'Route ' + code, job_type: 'surge', master_code: code, status: 'pending', partial: true,
  total_stops: stops.length, total_packages: stops.flat().length,
  surge_stops: stops.map((ids, i) => ({ address: (100 + i) + ' Main St, Atlanta, GA 30303', recipient: 'R' + i, stop_number: i + 1, packages: ids.length, pkgs: ids.map(pkg) })) });
async function outAndBack(s, code, box, driver = 'Dana Brooks', reason = 'refused') {
  const r = await s.A('publish_route', { payload: plan(code, [[box]]) });
  await s.q(`update public.jobs set driver_name = $2, status = 'in_transit', picked_up_at = now() where id = $1`, [r.job.id, driver]);
  await s.report(r.job.id, 1, 'EXCEPTION', { reason });
  return r.job.id;
}

test('a staged route is closed: no box can be added, even before the driver leaves; taking a box off still works', async () => {
  const s = await setup();
  const r = await s.A('publish_route', { payload: plan('R1', [['O-1-1'], ['O-2-1']]) });
  await s.q(`update public.jobs set staged_at = now() where id = $1`, [r.job.id]);
  const stops = (await s.q(`select surge_stops from public.jobs where id = $1`, [r.job.id]))[0].surge_stops;
  stops[0].pkgs.push(pkg('O-9-1'));
  await assert.rejects(s.q(`update public.jobs set surge_stops = $2 where id = $1`, [r.job.id, JSON.stringify(stops)]), /TP_CLOSED: route Route R1 is staged and closed; box O-9-1 goes to the next route batch/);
  stops[0].pkgs = [stops[0].pkgs[0]];
  await s.q(`update public.jobs set surge_stops = $2 where id = $1`, [r.job.id, JSON.stringify([stops[0]])]);
  assert.deepEqual(await s.open('O-2-1'), [], 'taken off the closed route');
});

test('carton damaged, contents fine: rebox (same label), then out again with a different driver', async () => {
  const s = await setup();
  await outAndBack(s, 'R1', 'O-1-1', 'Dana Brooks', 'damaged');
  const rec = await s.A('receive_return', { piece_id: 'O-1-1', condition: 'carton_damaged' });
  assert.equal(rec.next, 'rebox'); assert.equal(rec.hold, 'rebox'); assert.equal(rec.avoid_driver, 'Dana Brooks');
  // not ready until the rebox is confirmed
  const open = await s.A('publish_route', { payload: plan('R2', [['O-7-1']]) });
  assert.match(await s.AE('assign_piece', { piece_id: 'O-1-1', job_id: open.job.id }), /not ready for a route \(warehouse_returns, hold rebox\)/);
  const label = await s.A('reprint_label', { piece_id: 'O-1-1' });
  assert.deepEqual([label.piece_id, label.address], ['O-1-1', '100 Main St, Atlanta, GA 30303'], 'the same barcode and its stop');
  assert.equal((await s.A('rebox_done', { piece_id: 'O-1-1' })).avoid_driver, 'Dana Brooks');
  assert.equal((await s.A('rebox_done', { piece_id: 'O-1-1' })).replayed, true);
  // the same driver cannot take a route with it; another driver can
  await s.q(`update public.jobs set driver_name = 'Dana Brooks' where id = $1`, [open.job.id]);
  const cands = await s.A('piece_candidates', { piece_id: 'O-1-1' });
  assert.deepEqual(cands.map((c) => [c.title, c.avoided_driver]), [['Route R2', true]]);
  assert.match(await s.AE('assign_piece', { piece_id: 'O-1-1', job_id: open.job.id }), /came back damaged from this driver's route/);
  await s.q(`update public.jobs set driver_name = 'Marcus Hill' where id = $1`, [open.job.id]);
  const ok = await s.A('assign_piece', { piece_id: 'O-1-1', job_id: open.job.id });
  assert.equal(ok.ok, true); assert.equal(ok.joined_stop, 1, 'R2 already stops at its address');
  assert.deepEqual(await s.open('O-1-1'), [open.job.id]);
  assert.equal((await s.piece('O-1-1')).custody, 'assigned');
  // the avoided driver can no longer be given that route
  await assert.rejects(s.q(`update public.jobs set driver_name = 'Dana Brooks' where id = $1`, [open.job.id]), /came back damaged from this driver's route/);
  const r2 = (await s.q(`select surge_stops, total_stops, total_packages from public.jobs where id = $1`, [open.job.id]))[0];
  assert.equal(r2.total_stops, 1); assert.equal(r2.total_packages, 2);
  assert.deepEqual(r2.surge_stops[0].pkgs.map((p) => p.piece_id), ['O-7-1', 'O-1-1']);
});

test('contents damaged: on hold for the problem-solving station, listed for the dispatcher, never routed', async () => {
  const s = await setup();
  await outAndBack(s, 'R1', 'O-1-1', 'Dana Brooks', 'damaged');
  const rec = await s.A('receive_return', { piece_id: 'O-1-1', condition: 'contents_damaged' });
  assert.equal(rec.next, 'problem_station');
  assert.deepEqual(await s.piece('O-1-1'), { custody: 'warehouse_returns', status: 'normal', condition: 'damaged', hold: 'contents_damaged', attempts: 1, avoid_driver_name: null, investigation_level: 0, inv: false });
  const r2 = await s.A('publish_route', { payload: plan('R2', [['O-7-1']]) });
  assert.match(await s.AE('assign_piece', { piece_id: 'O-1-1', job_id: r2.job.id }), /hold contents_damaged/);
  assert.ok((await s.A('attention')).items.some((i) => i.kind === 'contents_damaged' && i.piece_id === 'O-1-1'));
  // an older screen's "damaged" means the contents
  await outAndBack(s, 'R3', 'O-3-1');
  assert.equal((await s.A('receive_return', { piece_id: 'O-3-1', condition: 'damaged' })).hold, 'contents_damaged');
});

test('no attempt limit: five failed attempts, each received back and out again on the next route', async () => {
  const s = await setup();
  for (let i = 1; i <= 5; i++) {
    const r = await s.A('publish_route', { payload: plan('A' + i, [['O-1-1']]) });
    assert.equal(r.ok, true, 'attempt ' + i + ' published'); assert.deepEqual(r.held, []);
    await s.q(`update public.jobs set driver_name = 'Driver ${i}', status = 'in_transit', picked_up_at = now() where id = $1`, [r.job.id]);
    await s.report(r.job.id, 1, 'EXCEPTION', { reason: 'no_access' });
    await s.A('receive_return', { piece_id: 'O-1-1', condition: 'intact' });
  }
  assert.equal((await s.piece('O-1-1')).attempts, 5);
  const r6 = await s.A('publish_route', { payload: plan('A6', [['O-1-1']]) });
  assert.equal(r6.ok, true, 'still eligible');
});

test('a recovered box joins an open route at its stop when the route goes to the same address; staged routes are not offered', async () => {
  const s = await setup();
  await outAndBack(s, 'R1', 'O-1-1');
  await s.A('receive_return', { piece_id: 'O-1-1', condition: 'intact' });
  const same = await s.A('publish_route', { payload: plan('R2', [['O-5-1']]) });    // stop 1 is at the same address
  const staged = await s.A('publish_route', { payload: plan('R3', [['O-6-1']]) });
  await s.q(`update public.jobs set staged_at = now() where id = $1`, [staged.job.id]);
  assert.deepEqual((await s.A('piece_candidates', { piece_id: 'O-1-1' })).map((c) => c.title), ['Route R2']);
  assert.match(await s.AE('assign_piece', { piece_id: 'O-1-1', job_id: staged.job.id }), /TP_CLOSED/);
  const ok = await s.A('assign_piece', { piece_id: 'O-1-1', job_id: same.job.id });
  assert.equal(ok.joined_stop, 1);
  const st = (await s.q(`select surge_stops from public.jobs where id = $1`, [same.job.id]))[0].surge_stops;
  assert.deepEqual(st[0].pkgs.map((p) => p.piece_id), ['O-5-1', 'O-1-1']);
  assert.match(await s.AE('assign_piece', { piece_id: 'O-1-1', job_id: same.job.id }), /not ready for a route \(assigned\)/, 'never twice');
});

test('a recovered box for an address the open route does not visit becomes a new last stop', async () => {
  const s = await setup();
  await outAndBack(s, 'R1', 'O-1-1');
  await s.A('receive_return', { piece_id: 'O-1-1', condition: 'intact' });
  const p = plan('R2', [['O-5-1']]); p.surge_stops[0].address = '900 Other Rd, Atlanta, GA 30303';
  const r = await s.A('publish_route', { payload: p });
  const ok = await s.A('assign_piece', { piece_id: 'O-1-1', job_id: r.job.id });
  assert.equal(ok.joined_stop, null);
  const j = (await s.q(`select surge_stops, total_stops from public.jobs where id = $1`, [r.job.id]))[0];
  assert.equal(j.total_stops, 2);
  assert.deepEqual([j.surge_stops[1].stop_number, j.surge_stops[1].address, j.surge_stops[1].recipient], [2, '100 Main St, Atlanta, GA 30303', 'R0']);
  assert.equal(j.surge_stops[1].returned_pkgs, undefined);
});

test('missing boxes: investigation after 2 hours, alerts on day 1 and 3, lost on day 5; a RECEIVED scan finds it', async () => {
  const s = await setup();
  const job = await outAndBack(s, 'R1', 'O-1-1');
  await s.q(`update public.jobs set status = 'completed_with_exceptions' where id = $1`, [job]);   // route over, box never scanned back
  const t0 = Date.now();
  const at = (h) => new Date(t0 + h * 3600_000).toISOString();
  assert.equal((await s.tick(at(1))).opened, 0, 'not yet');
  assert.equal((await s.tick(at(3))).opened, 1);
  assert.equal((await s.tick(at(4))).opened, 0, 'once');
  const kp = (await s.A('pieces', { ids: ['O-1-1'] }))[0];
  assert.equal(kp.investigation, 'Reported not delivered, never received back', 'Keel sees the investigation');
  let it = (await s.A('attention')).items.find((i) => i.kind === 'investigation');
  assert.equal(it.detail.reason, 'Reported not delivered, never received back'); assert.equal(it.detail.driver, 'Dana Brooks');
  await s.tick(at(3 + 25)); assert.equal((await s.piece('O-1-1')).investigation_level, 1);
  await s.tick(at(3 + 73)); assert.equal((await s.piece('O-1-1')).investigation_level, 3);
  assert.equal((await s.tick(at(3 + 121))).lost, 1);
  assert.equal((await s.piece('O-1-1')).custody, 'lost');
  const att = (await s.A('attention')).items;
  assert.ok(att.some((i) => i.kind === 'piece_lost') && !att.some((i) => i.kind === 'investigation'));
  // found after all: scanned RECEIVED
  const rec = await s.A('receive_return', { piece_id: 'O-1-1', condition: 'intact' });
  assert.equal(rec.custody, 'warehouse_returns');
  assert.equal((await s.piece('O-1-1')).inv, false);
  assert.ok(!(await s.A('attention')).items.some((i) => i.kind === 'piece_lost'));
  const h = await s.A('piece_history', { piece_id: 'O-1-1' });
  for (const e of ['piece.investigation_opened', 'piece.investigation_escalated', 'piece.lost', 'piece.received_return'])
    assert.ok(h.events.some((x) => x.event_type === e), e);
});

test('a box on a route that ended with no report is investigated too; mark_found closes it', async () => {
  const s = await setup();
  const r = await s.A('publish_route', { payload: plan('R1', [['O-1-1']]) });
  await s.q(`update public.jobs set driver_name = 'Dana', status = 'in_transit', picked_up_at = now() where id = $1`, [r.job.id]);
  await s.q(`update public.jobs set status = 'completed_with_exceptions' where id = $1`, [r.job.id]);
  await s.tick(new Date(Date.now() + 3 * 3600_000).toISOString());
  assert.equal((await s.A('attention')).items.find((i) => i.kind === 'investigation').detail.reason, 'Route ended without a delivery or a report');
  assert.equal((await s.A('mark_found', { piece_id: 'O-1-1', note: 'under the seat' })).ok, true);
  assert.ok(!(await s.A('attention')).items.some((i) => i.kind === 'investigation'));
});

test('driver patterns: boxes another driver then delivered are flagged for the operator; nothing is done to the driver', async () => {
  const s = await setup();
  for (let i = 1; i <= 3; i++) {
    const box = `O-${i}-1`;
    const j1 = await outAndBack(s, 'F' + i, box, 'Avoider', 'no_access');
    await s.A('receive_return', { piece_id: box, condition: 'intact' });
    const r = await s.A('publish_route', { payload: plan('G' + i, [[box]]) });
    await s.q(`update public.jobs set driver_name = 'Reliable', status = 'in_transit', picked_up_at = now() where id = $1`, [r.job.id]);
    await s.report(r.job.id, 1, 'DELIVERED');
  }
  const pat = await s.A('driver_patterns', { days: 14 });
  const av = pat.find((p) => p.driver === 'Avoider');
  assert.equal(av.flagged, true); assert.equal(av.delivered_by_another, 3); assert.deepEqual(av.by_reason, { no_access: 3 });
  assert.match(av.why, /3 boxes they could not deliver were delivered by another driver/);
  assert.equal(pat.find((p) => p.driver === 'Reliable').flagged, false);
  assert.equal((await s.tick(new Date().toISOString())).flagged, 1);
  const item = (await s.A('attention')).items.find((i) => i.kind === 'driver_pattern');
  assert.equal(item.ref, 'Avoider');
  // the driver keeps working: still listed as a driver, routes can still be given to them
  const r = await s.A('publish_route', { payload: plan('H1', [['O-9-1']]) });
  await s.q(`update public.jobs set driver_name = 'Avoider' where id = $1`, [r.job.id]);
});

test('rollback: 73\'s gateway exactly; reapply; preflight refuses twice', async () => {
  const s = await setup({ m74: false });
  const def = async (f) => (await s.db.query(`select pg_get_functiondef($1::regprocedure) d`, [f])).rows[0].d;
  const org0 = await def('public.tp_org(text,text,jsonb)');
  await s.db.exec(M74);
  await assert.rejects(s.db.exec(M74), /already applied/); await s.db.exec('rollback');
  await s.db.exec(R74);
  assert.equal(await def('public.tp_org(text,text,jsonb)'), org0);
  assert.equal((await s.q(`select to_regprocedure('tp_sec.piece_tick_once(timestamptz)') r`))[0].r, null);
  await assert.rejects(s.db.exec(R74), /was not applied/); await s.db.exec('rollback');
  await s.db.exec(M74);
});
