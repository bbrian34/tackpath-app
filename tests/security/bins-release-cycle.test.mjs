// BIN, LOC and STG spots free themselves (migration 65, on top of 60, 61, 62,
// 63, 64). Real migrations in PGlite, the production publication gate, the
// real PathIQ page (stow.html) in jsdom, the driver's pickup through the real
// tp_driver. Every call goes through the public tp_* functions as the anon
// role; no SQL is run to free anything. Stale rows (scenario d, e) are seeded
// the way they exist in production: written before the triggers existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const UPTO64 = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql',
  '61_staging_release_gaps.sql', '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql'];
const M65 = sqlFile('65_bins_self_heal.sql');
const R65 = sqlFile('65_bins_self_heal.rollback.sql');

let seq = 0;
// BINS_WITHOUT_65=1 runs the scenarios against the server as it is before 65.
async function setup({ m65 = !process.env.BINS_WITHOUT_65 } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  for (const f of UPTO64) await db.exec(sqlFile(f));
  if (m65) await db.exec(M65);
  // BINS_WITHOUT_TRIGGERS=1 removes the release triggers of 60/61/62/65: the
  // scenarios then fail unless something else frees the spots.
  if (process.env.BINS_WITHOUT_TRIGGERS) {
    for (const tg of ['tp_release_spots_on_pickup', 'tp_release_spots_on_archive', 'tp_free_spot_on_reset', 'tp_release_spots_on_delete']) {
      await db.exec(`drop trigger if exists ${tg} on public.jobs`);
    }
  }
  const signOrg = async (slug, code) => (await rpc(db, 'tp_org_sign_in', { p_slug: slug, p_code: code })).token;
  const tokA = await signOrg('quickhaul', 'qh-portal-2026');
  const O = (action, args = {}, token = tokA) => rpc(db, 'tp_org', { p_token: token, p_action: action, p_args: args });
  const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code });
  const D = (action, args = {}) => rpc(db, 'tp_driver', { p_token: drv.token, p_action: action, p_args: args });
  // the dispatcher: upload a manifest and Build Routes -> one publish per route (tp_org publish_route)
  const build = async (routes) => {
    const ids = [];
    for (const r of routes) {
      const res = await O('publish_route', { payload: { title: r.title, job_type: 'surge', master_code: 'TP-ROUTE-' + (++seq) + Math.random().toString(36).slice(2, 6).toUpperCase(),
        total_stops: 1, total_packages: r.tns.length,
        surge_stops: [{ stop_number: 1, address: r.title + ' St', recipient: 'Customer', pkgs: r.tns.map((tn) => ({ order_id: 'O-' + tn, tracking_number: tn, piece_id: tn, required_count: 1 })) }] } });
      assert.equal(res.ok, true, r.title + ': ' + JSON.stringify(res));
      ids.push(res.job.id);
    }
    return ids;
  };
  const assign = (id) => O('update_job', { id, patch: { status: 'assigned', driver_name: drv.driver.name } });
  // the driver app scans the bin at pickup: in transit + picked_up_at
  const pickup = (id) => D('update_job', { id, patch: { status: 'in_transit', picked_up_at: new Date().toISOString(), driver_name: drv.driver.name } });
  const rows = async (jid) => (await db.query(
    `select bin_code, location_code, staging_code, state, released_at is not null as released from public.bin_bindings where job_id = $1 order by opened_at`, [jid])).rows;
  const live = async (org = ORG_A) => (await db.query(
    `select bin_code, location_code, staging_code, state from public.bin_bindings where org_id = $1 and state in ('open','ready') order by bin_code`, [org])).rows;
  return { db, O, D, build, assign, pickup, rows, live, tokA, signOrg };
}

// The real PathIQ page, signed in to the company, on the Stow screen.
async function pathiq(t) {
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const app = loadApp('stow.html', { initialStorage: { tp_worker: 'Sam', tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token: t.tokA }) },
    fetchHandler: async (url, opts) => {
      const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)/);
      if (!m) return json(401, { message: 'no direct table access' });
      try { return json(200, await rpc(t.db, m[1], JSON.parse((opts && opts.body) || '{}'), 'anon')); } catch (e) { return json(400, { message: e.message }); }
    } });
  const w = app.dom.window;
  await wait(500);
  const card = () => w.document.getElementById('stowResult').innerHTML.replace(/<br>|<\/div>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&#10003;/g, '✓').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const scan = async (code) => { await w.eval('handleStowScan(' + JSON.stringify(code) + ')'); await wait(40); return card(); };
  const refresh = async () => { await w.eval('loadRoutes()'); await wait(40); };
  // Stow a whole route: OPEN BIN (bin + location) on its first package, then every package into the bin.
  const stow = async (tns, bin, loc) => {
    await refresh();
    let c = await scan(tns[0]);
    assert.match(c, /OPEN NEW BIN/, 'first package opens a bin: ' + c);
    c = await scan('BIN:' + bin);
    assert.doesNotMatch(c, /Bin In Use|already holds/i, `BIN ${bin} must be free: ${c}`);
    c = await scan('LOC:' + loc);
    assert.match(c, new RegExp('Bin Open BIN ' + bin), c);
    for (const tn of tns) {
      c = await scan(tn); c = await scan('BIN:' + bin);
      assert.match(c, /Confirmed|Bin Complete/, tn + ': ' + c);
    }
    assert.match(c, /Bin Complete.*Route complete\. Scan a STG code/, c);
    return c;
  };
  const stage = async (spot) => scan('STG:' + spot);
  return { app, w, card, scan, refresh, stow, stage, close: () => app.cleanup() };
}

const BINS = [['1A', 'A-07', 'S-01'], ['2A', 'A-08', 'S-02']];
const manifest = (n) => [{ title: `M${n} Route 1`, tns: [`M${n}A1`, `M${n}A2`] }, { title: `M${n} Route 2`, tns: [`M${n}B1`] }];

test('a. full cycle, twice in a row: stow, LOC, complete, STG, pickup -> the same BIN/LOC/STG are free for the next manifest', async () => {
  const t = await setup();
  const p = await pathiq(t);
  try {
    for (let cycle = 1; cycle <= 3; cycle++) {      // cycles 1 and 2, then the next manifest (3) on the same spots
      const ids = await t.build(manifest(cycle));
      for (let i = 0; i < ids.length; i++) {
        const [bin, loc, spot] = BINS[i];
        await p.stow(manifest(cycle)[i].tns, bin, loc);
        assert.match(await p.stage(spot), new RegExp(`Staged STG ${spot} BIN ${bin}`));
        assert.deepEqual((await t.rows(ids[i])).map((r) => [r.bin_code, r.location_code, r.staging_code, r.state]), [[bin, loc, spot, 'ready']]);
      }
      if (cycle === 3) break;
      for (const id of ids) { await t.assign(id); await t.pickup(id); }
      for (const id of ids) assert.deepEqual((await t.rows(id)).map((r) => [r.state, r.released]), [['released', true]], 'freed at pickup, kept as history');
      assert.deepEqual(await t.live(), [], 'nothing held after pickup');
    }
    assert.equal((await t.db.query(`select count(*)::int n from public.bin_bindings where org_id = $1`, [ORG_A])).rows[0].n, 6, 'every binding kept');
  } finally { p.close(); }
});

test('b. Clear board, then upload and build the same manifest again: bins open, no "already holds another route"', async () => {
  const t = await setup();
  const p = await pathiq(t);
  try {
    const first = await t.build(manifest(1));
    await p.stow(manifest(1)[0].tns, '1A', 'A-07');
    assert.match(await p.stage('S-01'), /Staged STG S-01/);
    await p.refresh();
    await p.scan('M1B1'); await p.scan('BIN:2A'); await p.scan('LOC:A-08');       // route 2: bin opened, not finished
    assert.equal((await t.live()).length, 2);
    assert.equal((await t.O('archive_jobs', { ids: first })).archived, 2);       // dispatcher: Clear board
    const again = await t.build(manifest(1));                                    // the same manifest again (new routes)
    assert.notDeepEqual(again, first);
    await p.stow(manifest(1)[0].tns, '1A', 'A-07');
    assert.match(await p.stage('S-01'), /Staged STG S-01/);
    await p.stow(manifest(1)[1].tns, '2A', 'A-08');
    for (const id of first) assert.ok((await t.rows(id)).every((r) => r.state === 'released' && r.released), 'old rows kept as released');
  } finally { p.close(); }
});

test('c. a route cancelled mid-stow, and a staged route cancelled: all spots free for the next manifest', async () => {
  const t = await setup();
  const p = await pathiq(t);
  try {
    const [r1, r2] = await t.build(manifest(1));
    await p.refresh();
    await p.scan('M1A1'); await p.scan('BIN:1A'); await p.scan('LOC:A-07');     // route 1: bin open, 0 of 2 stowed
    await p.scan('M1A1'); await p.scan('BIN:1A');                               // 1 of 2
    await p.stow(manifest(1)[1].tns, '2A', 'A-08');
    assert.match(await p.stage('S-02'), /Staged STG S-02/);
    await t.O('update_job', { id: r1, patch: { status: 'cancelled' } });       // dispatcher: Cancel This Job
    await t.O('update_job', { id: r2, patch: { status: 'cancelled' } });
    assert.deepEqual(await t.live(), []);
    await t.build(manifest(2));
    await p.stow(manifest(2)[0].tns, '1A', 'A-07');
    assert.match(await p.stage('S-02'), /Staged STG S-02/, 'the cancelled route\'s STG spot is free');
    await p.stow(manifest(2)[1].tns, '2A', 'A-08');
  } finally { p.close(); }
});

// Stale rows: bindings still open/ready for routes that had already moved on
// before migrations 60-62 existed (no trigger ever saw the change).
async function seedStale(t, org = ORG_A) {
  await t.db.exec('alter table public.bin_bindings drop constraint if exists bin_bindings_job_id_fkey');   // production keeps rows of deleted jobs
  const job = async (title, status, archived = false) => (await t.db.query(
    `insert into public.jobs (org_id, title, status, job_type, archived) values ($1,$2,$3,'surge',$4) returning id`, [org, title, status, archived])).rows[0].id;
  const stale = {
    archived: await job('Old archived', 'pending', true),
    cancelled: await job('Old cancelled', 'cancelled'),
    delivered: await job('Old delivered', 'delivered'),
    completed_with_exceptions: await job('Old cwe', 'completed_with_exceptions'),
    closed_with_exceptions: await job('Old closed', 'closed_with_exceptions'),
    in_transit: await job('Old in transit', 'in_transit'),
    deleted: org === ORG_A ? '99999999-9999-4999-8999-999999999999' : '88888888-8888-4888-8888-888888888888',
  };
  const spots = { archived: ['1A', 'A-07', 'S-01'], cancelled: ['2A', 'A-08', 'S-02'], delivered: ['3A', 'A-09', null],
    completed_with_exceptions: ['4A', 'A-10', 'S-04'], closed_with_exceptions: ['5A', 'A-11', null], in_transit: ['6A', 'A-12', 'S-06'], deleted: ['7A', 'A-13', 'S-07'] };
  for (const [k, id] of Object.entries(stale)) {
    const [bin, loc, stg] = spots[k];
    await t.db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, staging_code, staged_at)
                      values ($1,$2,$3,$4,$5,$6,$7)`, [org, bin, loc, id, stg ? 'ready' : 'open', stg, stg ? new Date().toISOString() : null]);
  }
  return { stale, spots };
}

test('before 65: stale bindings of finished, archived and deleted routes block their bins (the bug)', async () => {
  const t = await setup({ m65: false });
  await seedStale(t);
  const p = await pathiq(t);
  try {
    await t.build([{ title: 'New route', tns: ['N1'] }]);
    await p.refresh();
    await p.scan('N1');
    assert.match(await p.scan('BIN:1A'), /Bin In Use/);
  } finally { p.close(); }
});

test('d. stale bindings of archived, cancelled, delivered, completed/closed with exceptions, in-transit and deleted routes do not block; a live route still does, by name', async () => {
  const t = await setup();
  const { stale, spots } = await seedStale(t);
  // a live route holding BIN 9A
  const [liveRoute] = await t.build([{ title: 'Live Route', tns: ['L1'] }]);
  await t.assign(liveRoute);
  await t.O('open_binding', { id: liveRoute, bin_code: '9A', location_code: 'A-19', opened_by: 'Sam' });
  const p = await pathiq(t);
  try {
    // the first PathIQ request released every stale row of this company, kept as history
    for (const [k, id] of Object.entries(stale)) {
      assert.deepEqual((await t.rows(id)).map((r) => [r.state, r.released]), [['released', true]], k);
    }
    assert.deepEqual((await t.live()).map((r) => r.bin_code), ['9A'], 'only the live route holds a spot');
    const tns = Object.keys(spots).map((k, i) => 'D' + i);
    await t.build(Object.keys(spots).map((k, i) => ({ title: 'Next ' + k, tns: [tns[i]] })));
    let i = 0;
    for (const [k, [bin, loc, stg]] of Object.entries(spots)) {
      await p.stow([tns[i++]], bin, loc);
      if (stg) assert.match(await p.stage(stg), new RegExp('Staged STG ' + stg), k + ' spot ' + stg);
    }
    // the live route's bin is still refused, naming the route and its status
    await t.build([{ title: 'One more', tns: ['X1'] }]);
    await p.refresh();
    await p.scan('X1');
    assert.match(await p.scan('BIN:9A'), /Bin In Use BIN 9A BIN 9A holds Live Route \(assigned\)\. Scan an empty bin\./);
    // and by the server too, if the device's copy is out of date
    const x1 = (await t.db.query(`select id from public.jobs where title = 'One more'`)).rows[0].id;
    assert.deepEqual(await t.O('open_binding', { id: x1, bin_code: '9a', location_code: 'A-20' }),
      { ok: false, error: 'bin_taken', bin_code: '9A', route: 'Live Route', status: 'assigned', job_id: liveRoute });
    assert.deepEqual((await t.rows(liveRoute)).map((r) => r.state), ['open'], 'the live route is never touched');
  } finally { p.close(); }
});

test('d. a route closed with exceptions or deleted releases at that moment (triggers); repeats change nothing', async () => {
  const t = await setup();
  await t.db.exec('alter table public.bin_bindings drop constraint if exists bin_bindings_job_id_fkey');
  const [a, b] = await t.build([{ title: 'A', tns: ['T1'] }, { title: 'B', tns: ['T2'] }]);
  await t.O('open_binding', { id: a, bin_code: '1A', location_code: 'A-07' });
  await t.O('open_binding', { id: b, bin_code: '2A', location_code: 'A-08' });
  await t.db.query(`update public.jobs set status = 'closed_with_exceptions' where id = $1`, [a]);    // the operations system closing a route
  assert.deepEqual((await t.rows(a)).map((r) => r.state), ['released']);
  await t.db.query(`delete from public.jobs where id = $1`, [b]);
  assert.deepEqual((await t.rows(b)).map((r) => r.state), ['released'], 'kept as history when the table keeps rows of deleted jobs');
  const snap = JSON.stringify((await t.db.query('select * from public.bin_bindings order by id')).rows);
  await t.O('bindings'); await t.O('bindings');
  assert.equal(JSON.stringify((await t.db.query('select * from public.bin_bindings order by id')).rows), snap, 'repeat-safe');
});

test('e. another company using the same bin names is unaffected; released rows are kept as history', async () => {
  const t = await setup();
  await seedStale(t, ORG_A);
  await seedStale(t, ORG_B);
  const otherLive = (await t.db.query(`insert into public.jobs (org_id, title, status, job_type) values ($1,'Other Co live','assigned','surge') returning id`, [ORG_B])).rows[0].id;
  await t.db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state) values ($1,'9A','A-19',$2,'open')`, [ORG_B, otherLive]);
  const before = JSON.stringify((await t.db.query(`select * from public.bin_bindings where org_id = $1 order by id`, [ORG_B])).rows);
  const p = await pathiq(t);
  try {
    assert.equal(JSON.stringify((await t.db.query(`select * from public.bin_bindings where org_id = $1 order by id`, [ORG_B])).rows), before,
      "the other company's rows, stale or live, are untouched by this company's requests");
    // this company uses 9A, which the other company holds
    await t.build([{ title: 'Mine', tns: ['E1'] }]);
    await p.stow(['E1'], '9A', 'A-19');
    assert.equal((await t.db.query(`select count(*)::int n from public.bin_bindings where org_id = $1 and state = 'released'`, [ORG_A])).rows[0].n, 7, 'released rows kept');
    // the other company's own request heals its own rows only
    await t.db.query(`select tp_sec.admin_set_org_code('otherco', 'other-co-test-code')`);   // test setup: Other Co's sign-in code
    const tokB = await t.signOrg('otherco', 'other-co-test-code');
    assert.ok(tokB);
    await t.O('bindings', {}, tokB);
    assert.deepEqual((await t.live(ORG_B)).map((r) => r.bin_code), ['9A'], 'its stale rows released, its live route kept');
    assert.deepEqual((await t.live(ORG_A)).map((r) => r.bin_code), ['9A'], 'and this company untouched by it');
  } finally { p.close(); }
});

test('65 refuses to run twice or out of order; the rollback restores 63 and 61, keeps released rows', async () => {
  const t = await setup({ m65: false });
  const q1 = async (sql) => (await t.db.query(sql)).rows[0];
  const src = () => q1(`select prosrc from pg_proc where oid = 'public.tp_org(text,text,jsonb)'::regprocedure`);
  const grants = () => q1(`select proacl::text a, prosecdef s from pg_proc where oid = 'public.tp_org(text,text,jsonb)'::regprocedure`);
  const trig = () => q1(`select pg_get_triggerdef(oid) d from pg_trigger where tgname = 'tp_release_spots_on_pickup'`);
  const publicFns = () => q1(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  const s63 = await src(), g63 = await grants(), t61 = await trig(), n = await publicFns();
  await seedStale(t);
  await t.db.exec(M65);
  assert.deepEqual(await grants(), g63);
  assert.deepEqual(await publicFns(), n, 'no new public function');
  for (const fn of ['tp_sec.tp_org_v63(text,text,jsonb)', 'tp_sec.heal_spots(text)']) {
    assert.equal((await t.db.query(`select has_function_privilege('anon', $1, 'execute') ok`, [fn])).rows[0].ok, false, fn);
  }
  await assert.rejects(t.db.exec(M65), /already applied/); await t.db.exec('rollback');
  await t.O('bindings');                                   // heals
  const released = (await q1(`select count(*)::int n from public.bin_bindings where state = 'released'`)).n;
  assert.equal(released, 7);
  await t.db.exec(R65);
  assert.deepEqual(await src(), s63);
  assert.deepEqual(await grants(), g63);
  assert.deepEqual(await trig(), t61);
  assert.equal((await q1(`select count(*)::int n from pg_trigger where tgname = 'tp_release_spots_on_delete'`)).n, 0);
  assert.equal((await q1(`select count(*)::int n from public.bin_bindings where state = 'released'`)).n, released, 'released rows stay released');
  await assert.rejects(t.db.exec(R65), /not in place/); await t.db.exec('rollback');
  await t.db.exec(M65);
  const no63 = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql'] });
  await assert.rejects(no63.exec(M65), /Apply 63_jobs_exclude_archived\.sql first/); await no63.exec('rollback');
});
