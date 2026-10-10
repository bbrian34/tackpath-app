// PathIQ (stow.html) route list: 60 archived routes (Clear board keeps their
// pending status) must not hide a newly uploaded route from Stow or Assign
// bins; archived routes never show; the list stays oldest first. The real
// page in jsdom against the real gateway in PGlite (10, 20, 60, 61), with and
// without migration 63 (tp_org 'jobs' exclude_archived).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

const M63 = sqlFile('63_jobs_exclude_archived.sql');
const R63 = sqlFile('63_jobs_exclude_archived.rollback.sql');
const BASE = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql'];
const stops = (tn) => JSON.stringify([{ stop_number: 1, address: '1 A St', tracking_number: tn,
  pkgs: [{ tracking_number: tn, order_id: 'O-' + tn, piece_id: tn, required_count: 1 }] }]);

async function setup({ m63 }) {
  const db = await freshDb({ migrate: BASE.concat(m63 ? ['63_jobs_exclude_archived.sql'] : []) });
  const ins = (org, title, tn, { archived = false, status = 'pending', at }) => db.query(
    `insert into public.jobs (org_id, title, status, job_type, surge_stops, archived, created_at)
     values ($1,$2,$3,'surge',$4,$5,$6) returning id`, [org, title, status, stops(tn), archived, at]);
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // 60 old routes, cleared from the board (archived), statuses kept
  for (let i = 0; i < 60; i++) {
    await ins(ORG_A, 'Archived ' + i, 'PARCH' + i, { archived: true, status: ['pending', 'assigned', 'in_transit'][i % 3], at: day(30 - i * 0.1) });
  }
  await ins(ORG_A, 'Older live route', 'POLD1', { at: day(40) });             // oldest, still on the board
  await ins(ORG_B, 'Other company route', 'POTHER1', { at: day(1) });
  await ins(ORG_A, 'New upload', 'PNEW1', { at: new Date().toISOString() });  // the manifest just uploaded
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const direct = [], jobsArgs = [];
  const app = loadApp('stow.html', { initialStorage: { tp_worker: 'Sam', tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token }) },
    fetchHandler: async (url, opts) => {
      url = String(url);
      const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
      if (m) {
        const body = JSON.parse((opts && opts.body) || '{}');
        if (m[1] === 'tp_org' && body.p_action === 'jobs') jobsArgs.push(body.p_args);
        try { return json(200, await rpc(db, m[1], body, 'anon')); } catch (e) { return json(400, { message: e.message }); }
      }
      if (/\/rest\/v1\//.test(url)) { direct.push(url); return json(401, { message: 'permission denied' }); }
      return json(200, []);
    } });
  const w = app.dom.window;
  await wait(600);
  return { db, token, app, w, direct, jobsArgs };
}

for (const m63 of [false, true]) {
  test(`60 archived routes + 1 new: the new route is in Stow and Assign bins, archived never, oldest first (${m63 ? 'with' : 'without'} migration 63)`, async () => {
    const t = await setup({ m63 });
    const { w } = t;
    try {
      // the request: newest first, 500, ask the server to leave archived out
      const poll = t.jobsArgs.find((a) => !a.unbinned);
      assert.deepEqual(poll, { statuses: ['pending', 'assigned', 'in_transit'], order: 'desc', limit: 500, exclude_archived: true });
      // Stow board: only the routes on the board, oldest first
      assert.deepEqual(JSON.parse(w.eval('JSON.stringify(jobs.map(j=>j.title))')), ['Older live route', 'New upload']);
      // the new route's package is found in Stow (no bin yet: it opens one)
      await w.eval('handleStowScan("PNEW1")'); await wait(60);
      assert.ok(w.eval('!!openingBin'), 'new route found in Stow');
      assert.match(w.document.getElementById('stowResult').textContent, /New upload/);
      w.eval('openingBin=null');
      // an archived route's package is not on the board
      await w.eval('handleStowScan("PARCH59")'); await wait(60);
      assert.ok(!w.eval('!!openingBin') && !w.eval('!!pendingPlacement'), 'archived route not in Stow');
      assert.doesNotMatch(w.document.getElementById('stowResult').textContent, /Archived/);
      // Assign bins: same rule, oldest first
      w.eval("goTo('assignbins')"); await wait(150);
      assert.deepEqual(t.jobsArgs.find((a) => a.unbinned),
        { statuses: ['pending', 'assigned', 'in_transit'], order: 'desc', limit: 500, exclude_archived: true, unbinned: true });
      w.eval('handleAssignBinScan("BIN:7A")');
      const list = w.document.getElementById('assignRouteList').textContent;
      assert.match(list, /Older live route.*New upload/s, 'oldest first');
      assert.doesNotMatch(list, /Archived|Other company/);
      assert.deepEqual(JSON.parse(w.eval('JSON.stringify(unassignedRoutes.map(j=>j.title))')), ['Older live route', 'New upload']);
      // assigning the bin to the new route works
      const id = w.eval('unassignedRoutes[1].id');
      await w.eval(`confirmBinAssignment(${JSON.stringify(id)})`); await wait(150);
      assert.equal((await t.db.query('select bin_label from public.jobs where id = $1', [id])).rows[0].bin_label, 'BIN:7A');
      assert.deepEqual(t.direct, [], 'no direct table access');
    } finally { t.app.cleanup(); }
  });
}

test('migration 63: exclude_archived leaves archived routes out before the limit; without it, jobs answers as before', async () => {
  const t = await setup({ m63: true });
  t.app.cleanup();
  const J = (args) => rpc(t.db, 'tp_org', { p_token: t.token, p_action: 'jobs', p_args: args });
  const titles = (rows) => rows.map((j) => j.title);
  const st = ['pending', 'assigned', 'in_transit'];
  // the old PathIQ request (oldest first, 50): only archived routes, the new one missing (the bug)
  const old = await J({ statuses: st, order: 'asc', limit: 50 });
  assert.equal(old.length, 50);
  assert.ok(!titles(old).includes('New upload'));
  // same request, archived left out by the server: both live routes, oldest first
  assert.deepEqual(titles(await J({ statuses: st, order: 'asc', limit: 50, exclude_archived: true })), ['Older live route', 'New upload']);
  assert.deepEqual(titles(await J({ statuses: st, order: 'desc', limit: 1, exclude_archived: true })), ['New upload'], 'limit counts board routes only');
  assert.deepEqual(titles(await J({ statuses: st, unbinned: true, exclude_archived: true })), ['New upload', 'Older live route']);
  // without the flag (dispatcher and others): exactly migration 60's answer
  await t.db.exec(R63);
  const before = await J({ statuses: st, order: 'desc', limit: 500 });
  await t.db.exec(M63);
  assert.deepEqual(await J({ statuses: st, order: 'desc', limit: 500 }), before);
  assert.equal(before.length, 62);
  // other actions pass through; other company never listed; a bad token is refused
  assert.ok(!titles(await J({ exclude_archived: true })).includes('Other company route'));
  assert.equal((await rpc(t.db, 'tp_org', { p_token: t.token, p_action: 'me', p_args: {} })).slug, 'quickhaul');
  await assert.rejects(rpc(t.db, 'tp_org', { p_token: 'nope', p_action: 'jobs', p_args: { exclude_archived: true } }), /TP_AUTH/);
  // the moved-aside gateway is not callable with the public key
  await assert.rejects(rpc(t.db, 'tp_org_v60', { p_token: t.token, p_action: 'me', p_args: {} }));
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await t.db.query(`select has_function_privilege($1, 'tp_sec.tp_org_v60(text,text,jsonb)', 'execute') ok`, [role])).rows[0].ok, false);
  }
});

test('migration 63 refuses to run twice or without 60; the rollback restores 60 and grants', async () => {
  const db = await freshDb({ migrate: BASE });
  const grants = async () => (await db.query(
    `select proacl::text a, prosecdef s from pg_proc where oid = 'public.tp_org(text,text,jsonb)'::regprocedure`)).rows[0];
  const publicFns = async () => (await db.query(
    `select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`)).rows[0].n;
  const g60 = await grants(), n60 = await publicFns();
  const src60 = (await db.query(`select prosrc from pg_proc where oid = 'public.tp_org(text,text,jsonb)'::regprocedure`)).rows[0].prosrc;
  await db.exec(M63);
  assert.deepEqual(await grants(), g60, 'same grants, SECURITY DEFINER');
  assert.equal(await publicFns(), n60, 'no new public function');
  await assert.rejects(db.exec(M63), /already applied/); await db.exec('rollback');
  await db.exec(R63);
  assert.equal((await db.query(`select prosrc from pg_proc where oid = 'public.tp_org(text,text,jsonb)'::regprocedure`)).rows[0].prosrc, src60, "migration 60's gateway is back");
  assert.deepEqual(await grants(), g60);
  assert.equal(await publicFns(), n60);
  assert.equal((await db.query(`select to_regprocedure('tp_sec.tp_org_v60(text,text,jsonb)') is null as gone`)).rows[0].gone, true);
  await assert.rejects(db.exec(R63), /not in place/); await db.exec('rollback');
  await db.exec(M63);                                                  // and 63 applies again
  const no60 = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  await assert.rejects(no60.exec(M63), /Apply 60_pathiq_staging_reset\.sql first/); await no60.exec('rollback');
});
