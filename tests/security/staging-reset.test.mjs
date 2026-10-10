// Migration 60: PathIQ staging spots (STG:<code>) and release of a route's
// BIN / LOC / STG when the driver picks it up. Real migrations 10, 20 and 60
// in PGlite; every call goes through the public entry points as the anon
// role, like the pages (no direct table access).
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError, ORG_A, ORG_B } from './fixture.mjs';

async function setup() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql'] });
  const org = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = (await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).token;
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: org, p_action: action, p_args: args });
  const D = (action, args = {}) => rpc(db, 'tp_driver', { p_token: drv, p_action: action, p_args: args });
  const route = async (title, orgId = ORG_A) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name) values ($1, $2, 'assigned', 'surge', 'Dana Driver') returning id`,
    [orgId, title])).rows[0].id;
  const binding = async (jid) => (await db.query(
    `select bin_code, location_code, staging_code, state, staged_at is not null as staged, released_at is not null as released
       from public.bin_bindings where job_id = $1 order by opened_at`, [jid])).rows;
  return { db, O, D, route, binding };
}
// stow: open the bin at a location, then the last package completes it
async function stowComplete(t, jid, bin, loc) {
  await t.O('open_binding', { id: jid, bin_code: bin, location_code: loc, opened_by: 'Sam' });
  await t.O('binding_ready', { id: jid });
}

test('full cycle: stow, ready to stage, stage at STG, driver pickup releases BIN/LOC/STG and keeps the record', async () => {
  const t = await setup();
  const r1 = await t.route('Surge Route RT-001');
  await t.O('open_binding', { id: r1, bin_code: '1A', location_code: 'A-07', opened_by: 'Sam' });
  // staging before the bin is complete changes nothing
  assert.deepEqual(await t.O('stage_binding', { id: r1, staging_code: 'STG:S-01' }), { ok: false, error: 'not_complete', bin_code: '1A' });
  await t.O('binding_ready', { id: r1 });
  const st = await t.O('stage_binding', { id: r1, staging_code: 'STG:S-01' });
  assert.deepEqual(st, { ok: true, staging_code: 'S-01', bin_code: '1A', location_code: 'A-07' });
  assert.equal((await t.db.query('select staged_at is not null s from public.jobs where id = $1', [r1])).rows[0].s, true);
  assert.equal((await t.O('bindings', { job_id: r1 }))[0].staging_code, 'S-01', 'PathIQ reads the spot back');
  // the same scan again is harmless
  assert.equal((await t.O('stage_binding', { id: r1, staging_code: 's-01' })).idempotent, true);
  // driver: bin scan at pickup -> in transit (the driver app's own update)
  assert.equal((await t.D('bin_binding', { id: r1 }))[0].bin_code, '1A');
  await t.D('update_job', { id: r1, patch: { status: 'in_transit', picked_up_at: new Date().toISOString(), driver_name: 'Dana Driver' } });
  assert.deepEqual(await t.binding(r1), [{ bin_code: '1A', location_code: 'A-07', staging_code: 'S-01', state: 'released', staged: true, released: true }],
    'freed, and the record of BIN/LOC/STG is kept');
  assert.deepEqual(await t.O('bindings', { job_id: r1 }), [], 'no longer live');
  const j = (await t.db.query('select bin_label, staged_at is not null s, status from public.jobs where id = $1', [r1])).rows[0];
  assert.equal(j.status, 'in_transit'); assert.equal(j.s, true, 'staged_at kept on the job');
  // the next manifest reuses the same BIN, LOC and STG
  const r2 = await t.route('Surge Route RT-002');
  await stowComplete(t, r2, '1A', 'A-07');
  assert.equal((await t.O('stage_binding', { id: r2, staging_code: 'STG:S-01' })).ok, true);
});

test('two routes cannot be staged at the same STG spot; the second is told which route is there', async () => {
  const t = await setup();
  const r1 = await t.route('Surge Route RT-001'); const r2 = await t.route('Surge Route RT-002');
  await stowComplete(t, r1, '1A', 'A-07'); await stowComplete(t, r2, '2A', 'A-08');
  assert.equal((await t.O('stage_binding', { id: r1, staging_code: 'S-01' })).ok, true);
  const refused = await t.O('stage_binding', { id: r2, staging_code: 'STG:S-01' });
  assert.deepEqual(refused, { ok: false, error: 'spot_taken', staging_code: 'S-01', route: 'Surge Route RT-001', job_id: r1 });
  assert.equal((await t.binding(r2))[0].staging_code, null, 'nothing changed for the refused route');
  assert.equal((await t.O('stage_binding', { id: r2, staging_code: 'S-02' })).ok, true, 'another spot is fine');
  // another company may use the same spot name
  const tb = await t.route('Other Co route', ORG_B);
  await t.db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state) values ($1,'9Z','Z-1',$2,'ready')`, [ORG_B, tb]);
  await t.db.query(`update public.bin_bindings set staging_code = 'S-03' where job_id = $1`, [tb]);
  const r3 = await t.route('Surge Route RT-003'); await stowComplete(t, r3, '3A', 'A-09');
  assert.equal((await t.O('stage_binding', { id: r3, staging_code: 'S-03' })).ok, true);
  // and a company cannot stage another company's route
  assert.match(await rpcError(t.db, 'tp_org', { p_token: (await rpc(t.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token,
    p_action: 'stage_binding', p_args: { id: tb, staging_code: 'S-09' } }), /TP_DENIED/);
});

test('a repeated pickup scan changes nothing', async () => {
  const t = await setup();
  const r1 = await t.route('Surge Route RT-001');
  await stowComplete(t, r1, '1A', 'A-07'); await t.O('stage_binding', { id: r1, staging_code: 'S-01' });
  await t.D('update_job', { id: r1, patch: { status: 'in_transit', picked_up_at: '2026-10-09T15:00:00Z', driver_name: 'Dana Driver' } });
  const first = (await t.db.query('select released_at from public.bin_bindings where job_id = $1', [r1])).rows[0].released_at;
  // the pickup comes in again (offline replay, double scan)
  await t.D('update_job', { id: r1, patch: { status: 'in_transit', picked_up_at: '2026-10-09T15:00:05Z', driver_name: 'Dana Driver' } });
  const rows = (await t.db.query('select state, released_at from public.bin_bindings where job_id = $1', [r1])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'released');
  assert.deepEqual(rows[0].released_at, first, 'released once, at the first pickup');
});

test('one route\'s pickup does not free another live route\'s BIN, LOC or STG', async () => {
  const t = await setup();
  const r1 = await t.route('Surge Route RT-001'); const r2 = await t.route('Surge Route RT-002'); const r3 = await t.route('Surge Route RT-003');
  await stowComplete(t, r1, '1A', 'A-07'); await t.O('stage_binding', { id: r1, staging_code: 'S-01' });
  await stowComplete(t, r2, '2A', 'A-08'); await t.O('stage_binding', { id: r2, staging_code: 'S-02' });
  await t.O('open_binding', { id: r3, bin_code: '3A', location_code: 'A-09', opened_by: 'Sam' });   // still stowing
  await t.D('update_job', { id: r1, patch: { status: 'in_transit', picked_up_at: new Date().toISOString(), driver_name: 'Dana Driver' } });
  assert.equal((await t.binding(r1))[0].state, 'released');
  assert.deepEqual((await t.binding(r2))[0], { bin_code: '2A', location_code: 'A-08', staging_code: 'S-02', state: 'ready', staged: true, released: false });
  assert.equal((await t.binding(r3))[0].state, 'open');
  // RT-002 still owns S-02 and bin 2A
  const r4 = await t.route('Surge Route RT-004'); await stowComplete(t, r4, '4A', 'A-10');
  assert.equal((await t.O('stage_binding', { id: r4, staging_code: 'S-02' })).route, 'Surge Route RT-002');
  // PathIQ refuses a bin that a live binding holds (binCodeInUse over this list): 2A is still RT-002's
  const live = (await t.O('bindings')).map((b) => [b.bin_code, b.state, b.job_id]);
  assert.ok(live.some(([bin, st, jid]) => bin === '2A' && st === 'ready' && jid === r2));
  assert.ok(!live.some(([bin]) => bin === '1A'), 'RT-001\'s bin is free');
});

test('every other tp_org action still works through the wrapper; the core is not callable with the public key', async () => {
  const t = await setup();
  const me = await t.O('me');
  assert.equal(me.slug, 'quickhaul');
  assert.ok(Array.isArray(await t.O('jobs')));
  assert.match(await rpcError(t.db, 'tp_org', { p_token: 'bad', p_action: 'stage_binding', p_args: { id: 'x', staging_code: 'S-01' } }), /TP_AUTH|session/i);
  const anonCore = await t.db.query(`select has_function_privilege('anon', 'tp_sec.tp_org_core(text,text,jsonb)', 'execute') a,
    has_function_privilege('anon', 'public.tp_org(text,text,jsonb)', 'execute') b`);
  assert.deepEqual(anonCore.rows[0], { a: false, b: true });
});

test('migration 60 refuses to run twice; the rollback restores the gateway and keeps the staging record', async () => {
  const t = await setup();
  const r1 = await t.route('Surge Route RT-001');
  await stowComplete(t, r1, '1A', 'A-07'); await t.O('stage_binding', { id: r1, staging_code: 'S-01' });
  await assert.rejects(t.db.exec(sqlFile('60_pathiq_staging_reset.sql')), /already applied/); await t.db.exec('rollback');
  await t.db.exec(sqlFile('60_pathiq_staging_reset.rollback.sql'));
  assert.match(await rpcError(t.db, 'tp_org', { p_token: (await rpc(t.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token,
    p_action: 'stage_binding', p_args: {} }), /unknown action/);
  assert.equal((await t.binding(r1))[0].staging_code, 'S-01', 'staging record kept');
  await t.D('update_job', { id: r1, patch: { status: 'in_transit', driver_name: 'Dana Driver' } });
  assert.equal((await t.binding(r1))[0].state, 'ready', 'no release without 60');
  await assert.rejects(t.db.exec(sqlFile('60_pathiq_staging_reset.rollback.sql')), /not in place/); await t.db.exec('rollback');
  await t.db.exec(sqlFile('60_pathiq_staging_reset.sql'));   // and it can be applied again
});
