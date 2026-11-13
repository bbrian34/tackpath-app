// Migration 75: per-box load scans, the departure gate, driver custody, driver-to-driver transfers,
// Keel holds and the exception feed. Real migrations in PGlite (the full chain through 74); drivers,
// dispatcher and Keel through their gateways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql', '71_keel_inbox.sql', '72_box_by_box_publishing.sql',
  '73_pieces_and_returns.sql', '74_recovery_rules.sql'];
const M75 = sqlFile('75_load_scan_and_transfers.sql'), R75 = sqlFile('75_load_scan_and_transfers.rollback.sql');

async function setup({ m75 = true } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  if (m75) await db.exec(M75);
  const org = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const signIn = async (phone) => { const c = await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role'); return rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: c.code }); };
  const dana = await signIn('4045551234'), ned = await signIn('4045551235');
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: org, p_action: action, p_args: args });
  const OE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: org, p_action: action, p_args: args });
  const D = (who, action, args = {}) => rpc(db, 'tp_driver', { p_token: who.token, p_action: action, p_args: args });
  const DE = (who, action, args = {}) => rpcError(db, 'tp_driver', { p_token: who.token, p_action: action, p_args: args });
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const pkg = (id, n = 1) => ({ order_id: 'O-' + id, tracking_number: id, piece_id: id, required_count: n });
  const route = async (code, stops, driver = dana) => {
    const r = await O('publish_route', { payload: { title: 'Route ' + code, job_type: 'surge', master_code: code, status: 'pending', partial: true,
      total_stops: stops.length, total_packages: stops.flat().reduce((a, x) => a + (Array.isArray(x) ? x[1] : 1), 0),
      surge_stops: stops.map((ids, i) => ({ address: (100 + i) + ' Main St, Atlanta, GA 30303', recipient: 'R' + i, stop_number: i + 1,
        pkgs: ids.map((x) => (Array.isArray(x) ? pkg(x[0], x[1]) : pkg(x))) })) } });
    await q(`update public.jobs set driver_name = $2, status = 'assigned' where id = $1`, [r.job.id, driver.driver.name]);
    return r.job.id;
  };
  const depart = (who, id) => D(who, 'update_job', { id, patch: { status: 'in_transit', picked_up_at: new Date().toISOString() } });
  const departErr = (who, id) => DE(who, 'update_job', { id, patch: { status: 'in_transit', picked_up_at: new Date().toISOString() } });
  const piece = async (id) => (await q(`select custody, custody_driver, hold from public.pieces where piece_id = $1`, [id]))[0];
  return { db, O, OE, D, DE, q, route, depart, departErr, piece, dana, ned };
}

test('load scan: each box checked against the route; duplicates, wrong-route and unknown boxes detected', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1', ['A-2', 2]], ['A-3']]);
  const r2 = await s.route('R2', [['B-1']], s.ned);
  let x = await s.D(s.dana, 'load_scan', { id: r1, code: 'a-1' });
  assert.deepEqual([x.ok, x.result, x.stop_number, x.load.expected, x.load.loaded], [true, 'loaded', 1, 3, 1]);
  assert.deepEqual(await s.piece('A-1'), { custody: 'with_driver', custody_driver: 'Dana Driver', hold: null });
  x = await s.D(s.dana, 'load_scan', { id: r1, code: 'A-1' });
  assert.equal(x.result, 'already_loaded', 'a duplicate scan changes nothing');
  // a shared label covering 2 boxes needs two scans
  x = await s.D(s.dana, 'load_scan', { id: r1, code: 'A-2' }); assert.deepEqual([x.units, x.required], [1, 2]);
  x = await s.D(s.dana, 'load_scan', { id: r1, code: 'A-2' }); assert.deepEqual([x.units, x.required], [2, 2]);
  // another route's box, and a box nobody knows
  x = await s.D(s.dana, 'load_scan', { id: r1, code: 'B-1' });
  assert.deepEqual([x.ok, x.result, x.belongs_to], [false, 'wrong_route', 'Route R2']);
  x = await s.D(s.dana, 'load_scan', { id: r1, code: 'ZZZ-9' });
  assert.deepEqual([x.ok, x.result], [false, 'unknown']);
  const st = await s.D(s.dana, 'load_status', { id: r1 });
  assert.deepEqual(st.missing.map((m) => m.piece_id), ['A-3']);
  assert.deepEqual(st.discrepancies.map((d) => [d.kind, d.piece_id]).sort(), [['load_unknown', 'ZZZ-9'], ['load_wrong_route', 'B-1']]);
  assert.equal(st.can_depart, false);
  // the wrong-route box is still on its own route, untouched
  assert.equal((await s.q(`select count(*)::int n from public.piece_assignments where piece_id = 'B-1' and job_id = $1 and released_at is null`, [r2]))[0].n, 1);
  // only the route's own driver can scan for it
  assert.match(await s.DE(s.ned, 'load_scan', { id: r1, code: 'A-3' }), /TP_DENIED/);
});

test('departure gate: missing boxes or open load problems keep the route in; the driver fixes them or dispatch decides', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1'], ['A-2']]);
  await s.D(s.dana, 'load_scan', { id: r1, code: 'A-1' });
  await s.D(s.dana, 'load_scan', { id: r1, code: 'NOPE' });
  assert.match(await s.departErr(s.dana, r1), /TP_LOAD: route Route R1 cannot leave: 1 box\(es\) not scanned into the van, 1 load problem\(s\) open/);
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [r1]))[0].status, 'assigned');
  // the driver hands back the unknown box and scans the missing one: the route can leave
  await s.D(s.dana, 'load_remove', { id: r1, code: 'NOPE' });
  await s.D(s.dana, 'load_scan', { id: r1, code: 'A-2' });
  await s.depart(s.dana, r1);
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [r1]))[0].status, 'in_transit');
  assert.equal((await s.piece('A-2')).custody_driver, 'Dana Driver');
});

test('dispatch resolves a load: remove the missing box (it is searched for), or allow departure with a note', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1'], ['A-2']]);
  await s.D(s.dana, 'load_scan', { id: r1, code: 'A-1' });
  assert.match(await s.OE('resolve_load', { job_id: r1, action: 'remove_missing' }), /a note is required/);
  const st = await s.O('resolve_load', { job_id: r1, action: 'remove_missing', note: 'not on the dock', by: 'Sam' });
  assert.equal(st.can_depart, true); assert.equal(st.expected, 1);
  const j = (await s.q(`select surge_stops, total_stops from public.jobs where id = $1`, [r1]))[0];
  assert.equal(j.total_stops, 1, 'A-2 is off the route');
  assert.equal((await s.piece('A-2')).custody, 'awaiting_route');
  const att = (await s.O('attention')).items;
  assert.ok(att.some((i) => i.kind === 'load_missing' && i.piece_id === 'A-2'));
  await s.depart(s.dana, r1);
  // found later and scanned in at Returns: the search ends, it can go out again
  const rec = await s.O('receive_return', { piece_id: 'A-2', condition: 'intact' });
  assert.equal(rec.custody, 'warehouse_returns');
  // allow departure with an open problem
  const r2 = await s.route('R2', [['C-1'], ['C-2']]);
  await s.D(s.dana, 'load_scan', { id: r2, code: 'C-1' });
  await s.O('resolve_load', { job_id: r2, action: 'allow_departure', note: 'C-2 follows tomorrow, approved by Sam' });
  await s.depart(s.dana, r2);
  assert.equal((await s.q(`select load_override_note from public.jobs where id = $1`, [r2]))[0].load_override_note, 'C-2 follows tomorrow, approved by Sam');
});

test('an older driver app that never scans is not stranded: the route leaves and is listed as not verified', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1']]);
  await s.depart(s.dana, r1);
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [r1]))[0].status, 'in_transit');
  assert.equal((await s.piece('A-1')).custody_driver, 'Dana Driver');
  assert.ok((await s.O('attention')).items.some((i) => i.kind === 'departure_unverified'));
});

test('breakdown: can\'t continue, transfer to another driver on a new rescue route, box by box, custody and history kept', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1'], ['A-2'], ['A-3']]);
  for (const c of ['A-1', 'A-2', 'A-3']) await s.D(s.dana, 'load_scan', { id: r1, code: c });
  await s.depart(s.dana, r1);
  await s.q(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Dana Driver', 'driver', $2)`, [r1, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1 })]);
  await s.D(s.dana, 'cant_continue', { id: r1, reason: 'breakdown', note: 'flat tire on I-75' });
  const cc = (await s.O('attention')).items.find((i) => i.kind === 'cant_continue');
  assert.deepEqual([cc.detail.reason, cc.detail.boxes_left], ['breakdown', 2]);
  // the dispatcher sends the two undelivered boxes to Ned
  assert.match(await s.OE('start_transfer', { job_id: r1, to_driver: 'Dana Driver' }), /transfer to another driver/);
  const t = await s.O('start_transfer', { job_id: r1, to_driver: 'Ned NoConsent', reason: 'breakdown' });
  assert.deepEqual(t.pieces, ['A-2', 'A-3']);
  assert.match(await s.OE('start_transfer', { job_id: r1, to_driver: 'Ned NoConsent' }), /already in a transfer/, 'never transferred twice');
  // Ned sees it; Dana does not
  assert.equal((await s.D(s.ned, 'transfers')).length, 1);
  assert.equal((await s.D(s.dana, 'transfers')).length, 0);
  assert.equal((await s.D(s.ned, 'transfer_scan', { transfer_id: t.transfer_id, code: 'X-9' })).result, 'not_in_transfer');
  assert.match(await s.DE(s.dana, 'transfer_scan', { transfer_id: t.transfer_id, code: 'A-2' }), /for another driver/);
  let x = await s.D(s.ned, 'transfer_scan', { transfer_id: t.transfer_id, code: 'a-2' });
  assert.deepEqual([x.result, x.scanned, x.total], ['received', 1, 2]);
  assert.equal((await s.D(s.ned, 'transfer_scan', { transfer_id: t.transfer_id, code: 'A-2' })).result, 'already_received');
  assert.deepEqual(await s.piece('A-2'), { custody: 'with_driver', custody_driver: 'Ned NoConsent', hold: null });
  // on exactly one route at every moment
  const open = async (id) => (await s.q(`select job_id from public.piece_assignments where piece_id = $1 and released_at is null`, [id])).map((r) => r.job_id);
  assert.deepEqual(await open('A-2'), [t.to_job_id]); assert.deepEqual(await open('A-3'), [r1]);
  x = await s.D(s.ned, 'transfer_scan', { transfer_id: t.transfer_id, code: 'A-3' });
  assert.equal(x.complete, true);
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [r1]))[0].status, 'completed_with_exceptions', 'nothing left on the broken-down route');
  assert.equal((await s.piece('A-1')).custody, 'delivered', 'the box delivered before the breakdown stays delivered (73 sync fix)');
  assert.deepEqual(await open('A-1'), []);
  // Ned's rescue route is already loaded: it leaves at once, and he delivers
  const rescue = (await s.q(`select status, driver_name, surge_stops from public.jobs where id = $1`, [t.to_job_id]))[0];
  assert.deepEqual([rescue.status, rescue.driver_name, rescue.surge_stops.length], ['assigned', 'Ned NoConsent', 2]);
  await s.depart(s.ned, t.to_job_id);
  await s.q(`insert into public.messages (job_id, sender, sender_role, body) values ($1, 'Ned', 'driver', $2)`, [t.to_job_id, 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1 })]);
  assert.equal((await s.piece('A-2')).custody, 'delivered');
  const h = await s.O('piece_history', { piece_id: 'A-2' });
  assert.ok(h.events.some((e) => e.event_type === 'piece.transferred' && e.payload.from_driver === 'Dana Driver' && e.payload.to_driver === 'Ned NoConsent'));
  assert.deepEqual(h.assignments.map((a) => a.release_reason), ['transferred', 'delivered']);
  assert.ok(!(await s.O('attention')).items.some((i) => i.kind === 'cant_continue'), 'resolved by the transfer');
});

test('partial transfer: what was scanned moved, the rest stays with the first driver; staged routes stay closed', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1'], ['A-2']]);
  for (const c of ['A-1', 'A-2']) await s.D(s.dana, 'load_scan', { id: r1, code: c });
  await s.depart(s.dana, r1);
  const t = await s.O('start_transfer', { job_id: r1, to_driver: 'Ned NoConsent', pieces: ['A-2'] });
  assert.deepEqual(t.pieces, ['A-2']);
  const t2 = await s.O('start_transfer', { job_id: r1, to_driver: 'Ned NoConsent', pieces: ['A-1'] });
  await s.D(s.ned, 'transfer_scan', { transfer_id: t2.transfer_id, code: 'A-1' });
  const closed = await s.O('close_transfer', { transfer_id: t.transfer_id, note: 'Ned left before A-2' });
  assert.deepEqual([closed.moved, closed.stayed], [0, 1]);
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [t.to_job_id]))[0].status, 'cancelled', 'an empty rescue route is cancelled');
  assert.equal((await s.piece('A-2')).custody_driver, 'Dana Driver');
  assert.equal((await s.q(`select status from public.jobs where id = $1`, [r1]))[0].status, 'in_transit', 'Dana still has A-2');
  // the staged-route rule still holds for everything but a transfer's own rescue route
  const r3 = await s.route('R3', [['C-1']]);
  await s.q(`update public.jobs set staged_at = now() where id = $1`, [r3]);
  const st = (await s.q(`select surge_stops from public.jobs where id = $1`, [r3]))[0].surge_stops;
  st[0].pkgs.push({ piece_id: 'A-2' });
  await assert.rejects(s.q(`update public.jobs set surge_stops = $2 where id = $1`, [r3, JSON.stringify(st)]), /TP_CLOSED/);
});

test('Keel holds: a held box is never put on a route; released, it can go', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1']]);
  await s.O('receive_return', { piece_id: 'A-1', condition: 'intact' }).catch(() => {});
  await s.q(`update public.jobs set status = 'cancelled' where id = $1`, [r1]);
  assert.equal((await s.O('hold_piece', { piece_id: 'A-1', reason: 'merchant hold', ref: 'keel-exc-1' })).ok, true);
  const p = await s.O('publish_route', { payload: { title: 'Route R2', job_type: 'surge', master_code: 'R2', partial: true, total_stops: 2, total_packages: 2,
    surge_stops: [{ stop_number: 1, pkgs: [{ piece_id: 'A-1' }] }, { stop_number: 2, pkgs: [{ piece_id: 'B-1' }] }] } });
  assert.equal(p.ok, true);
  const j = (await s.q(`select surge_stops, total_packages from public.jobs where id = $1`, [p.job.id]))[0];
  assert.deepEqual(j.surge_stops.map((x) => x.pkgs.map((y) => y.piece_id)), [['B-1']]); assert.equal(j.total_packages, 1);
  assert.ok((await s.O('attention')).items.some((i) => i.kind === 'piece_on_hold' && i.detail.reason === 'merchant hold'));
  assert.equal((await s.O('release_hold', { piece_id: 'A-1', ref: 'keel-exc-1' })).ok, true);
  assert.equal((await s.piece('A-1')).hold, null);
  assert.ok(!(await s.O('attention')).items.some((i) => i.kind === 'piece_on_hold'));
});

test('exception feed: created, changed and resolved items since a time, for Keel; this company only', async () => {
  const s = await setup();
  const r1 = await s.route('R1', [['A-1']]);
  const t0 = new Date(Date.now() - 1000).toISOString();
  await s.D(s.dana, 'load_scan', { id: r1, code: 'NOPE' });
  let feed = await s.O('exceptions_feed', { since: t0 });
  assert.deepEqual(feed.map((f) => [f.kind, f.piece_id, f.resolved_at]), [['load_unknown', 'NOPE', null]]);
  assert.equal(feed[0].route, 'Route R1');
  const mark = feed[0].updated_at;
  await s.O('attention_resolve', { id: feed[0].id, note: 'resolved in Keel', by: 'keel' });
  feed = await s.O('exceptions_feed', { since: mark });
  assert.equal(feed.length, 1); assert.equal(feed[0].resolution, 'resolved in Keel');
  assert.deepEqual(await s.O('exceptions_feed', { since: feed[0].updated_at }), []);
});

test('rollback: 74\'s gateways exactly; reapply; preflight refuses twice', async () => {
  const s = await setup({ m75: false });
  const def = async (f) => (await s.db.query(`select pg_get_functiondef($1::regprocedure) d`, [f])).rows[0].d;
  const org0 = await def('public.tp_org(text,text,jsonb)'), drv0 = await def('public.tp_driver(text,text,jsonb)');
  await s.db.exec(M75);
  await assert.rejects(s.db.exec(M75), /already applied/); await s.db.exec('rollback');
  await s.db.exec(R75);
  assert.equal(await def('public.tp_org(text,text,jsonb)'), org0);
  assert.equal(await def('public.tp_driver(text,text,jsonb)'), drv0);
  await assert.rejects(s.db.exec(R75), /was not applied/); await s.db.exec('rollback');
  await s.db.exec(M75);
});
