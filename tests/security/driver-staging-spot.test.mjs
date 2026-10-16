// Migration 67: tp_driver 'bin_binding' gives the driver the STAGING spot
// (STG, written by PathIQ's stage_binding) and never the stow location (LOC).
// Only the driver's own route (or an open offer), only that job's company;
// another driver's or company's route is refused. Real migrations in PGlite,
// every call as anon; also on top of the full chain 10, 20, 50, 60-65.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError, ORG_A, ORG_B } from './fixture.mjs';

const M67 = sqlFile('67_driver_staging_spot.sql');
const R67 = sqlFile('67_driver_staging_spot.rollback.sql');
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const BASE = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql', '64_driver_hide_archived.sql'];
const FULL = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql'];

async function setup({ m67 = true, full = false } = {}) {
  const db = await freshDb();
  if (full) { await db.exec('drop function public.publish_surge_route(jsonb);'); await db.exec(PROD_GATE); }
  for (const f of full ? FULL : BASE) await db.exec(sqlFile(f));
  if (m67) await db.exec(M67);
  await db.query(`insert into public.drivers (name, phone, sms_consent, status, org_id) values ('Sam Second', '4045559999', true, 'active', $1)`, [ORG_A]);
  await db.query(`insert into public.drivers (name, phone, sms_consent, status, org_id) values ('Bea Other', '4045558888', true, 'active', $1)`, [ORG_B]);
  const signIn = async (phone) => {
    const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role');
    return rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: issued.code });
  };
  const dana = await signIn('4045551234'), sam = await signIn('4045559999'), bea = await signIn('4045558888');
  const route = async (title, driver, org = ORG_A) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name) values ($1,$2,'assigned','surge',$3) returning id`, [org, title, driver])).rows[0].id;
  const orgTok = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const O = (action, args) => rpc(db, 'tp_org', { p_token: orgTok, p_action: action, p_args: args });
  // PathIQ: stow into BIN 1A at LOC A-01, bin complete, then (optionally) stage at STG
  const stow = async (id, bin, loc, spot) => {
    await O('open_binding', { id, bin_code: bin, location_code: loc, opened_by: 'Sam' });
    await O('binding_ready', { id });
    if (spot) assert.equal((await O('stage_binding', { id, staging_code: 'STG:' + spot })).ok, true);
  };
  const D = (who, args) => rpc(db, 'tp_driver', { p_token: who.token, p_action: 'bin_binding', p_args: args });
  const DE = (who, args) => rpcError(db, 'tp_driver', { p_token: who.token, p_action: 'bin_binding', p_args: args });
  return { db, dana, sam, bea, route, stow, D, DE, O };
}

test('before 67: the driver gets the stow LOC and no staging spot (the bug)', async () => {
  const t = await setup({ m67: false });
  const id = await t.route('Route A', t.dana.driver.name);
  await t.stow(id, '1A', 'A-01', 'S-01');
  const rows = await t.D(t.dana, { job_id: id });
  assert.equal(rows[0].location_code, 'A-01');
  assert.equal(rows[0].staging_code, undefined);
});

for (const full of [false, true]) {
  test(`67${full ? ' on top of 10, 20, 50, 60-65' : ''}: the driver gets BIN and STG for their own route, never the LOC`, async () => {
    const t = await setup({ full });
    const staged = await t.route('Route A', t.dana.driver.name);
    const later = await t.route('Route B', t.dana.driver.name);
    await t.stow(staged, '1A', 'A-01', 'S-01');
    await t.stow(later, '2A', 'A-02', null);                         // "Stage later"
    assert.deepEqual(await t.D(t.dana, { job_id: staged }), [{ bin_code: '1A', state: 'ready', staging_code: 'S-01' }]);
    assert.deepEqual(await t.D(t.dana, { job_id: later }), [{ bin_code: '2A', state: 'ready', staging_code: null }]);
    assert.ok(!JSON.stringify(await t.D(t.dana, { job_id: staged })).includes('A-01'), 'LOC never sent');
    // staging later: the next answer carries it
    assert.equal((await t.O('stage_binding', { id: later, staging_code: 'STG:S-02' })).ok, true);
    assert.equal((await t.D(t.dana, { job_id: later }))[0].staging_code, 'S-02');
    // not stowed yet: nothing
    const none = await t.route('Route C', t.dana.driver.name);
    assert.deepEqual(await t.D(t.dana, { job_id: none }), []);
  });
}

test("d. 67: never another driver's or another company's STG spot", async () => {
  const t = await setup();
  const mine = await t.route('Route A', t.dana.driver.name);
  const sams = await t.route('Sam route', t.sam.driver.name);
  const other = await t.route('Other Co route', t.bea.driver.name, ORG_B);
  await t.stow(mine, '1A', 'A-01', 'S-01');
  await t.stow(sams, '2A', 'A-02', 'S-02');
  await t.db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, staging_code)
                    values ($1,'9A','B-09',$2,'ready','S-09')`, [ORG_B, other]);
  // another driver's route, another company's route: refused
  assert.match(await t.DE(t.dana, { job_id: sams }), /TP_DENIED/);
  assert.match(await t.DE(t.dana, { job_id: other }), /TP_DENIED/);
  assert.match(await t.DE(t.bea, { job_id: mine }), /TP_DENIED/);
  // a row of another company attached to my job id is not returned
  await t.db.query(`update public.bin_bindings set state = 'released' where job_id = $1`, [mine]);
  await t.db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, staging_code)
                    values ($1,'7Z','Z-07',$2,'ready','S-77')`, [ORG_B, mine]);
  assert.deepEqual(await t.D(t.dana, { job_id: mine }), []);
  // archived (64) still refused; a bad session refused
  await t.db.query(`update public.jobs set archived = true where id = $1`, [sams]);
  assert.match(await t.DE(t.sam, { job_id: sams }), /removed by dispatch/);
  assert.match(await rpcError(t.db, 'tp_driver', { p_token: 'nope', p_action: 'bin_binding', p_args: { job_id: mine } }), /TP_AUTH/);
  // other actions unchanged
  assert.equal((await rpc(t.db, 'tp_driver', { p_token: t.dana.token, p_action: 'me', p_args: {} })).name, t.dana.driver.name);
  assert.ok((await rpc(t.db, 'tp_driver', { p_token: t.dana.token, p_action: 'jobs', p_args: { mine: true } })).some((j) => j.id === mine));
});

test('67 refuses to run twice or without 64; the rollback restores 64 and the grants; no new public function', async () => {
  const db = await freshDb({ migrate: BASE });
  const q1 = async (sql) => (await db.query(sql)).rows[0];
  const src = () => q1(`select prosrc from pg_proc where oid = 'public.tp_driver(text,text,jsonb)'::regprocedure`);
  const grants = () => q1(`select proacl::text a, prosecdef s from pg_proc where oid = 'public.tp_driver(text,text,jsonb)'::regprocedure`);
  const publicFns = () => q1(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  const s64 = await src(), g64 = await grants(), n = await publicFns();
  await db.exec(M67);
  assert.deepEqual(await grants(), g64, 'same grants, SECURITY DEFINER');
  assert.deepEqual(await publicFns(), n);
  assert.equal((await db.query(`select has_function_privilege('anon', 'tp_sec.tp_driver_v64(text,text,jsonb)', 'execute') ok`)).rows[0].ok, false);
  await assert.rejects(db.exec(M67), /already applied/); await db.exec('rollback');
  await db.exec(R67);
  assert.deepEqual(await src(), s64);
  assert.deepEqual(await grants(), g64);
  await assert.rejects(db.exec(R67), /not in place/); await db.exec('rollback');
  await db.exec(M67);
  const no64 = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql'] });
  await assert.rejects(no64.exec(M67), /Apply 64_driver_hide_archived\.sql first/); await no64.exec('rollback');
});
