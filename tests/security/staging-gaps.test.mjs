// Migration 61: Reset Bin frees the route's STG spot; cancelled / delivered /
// completed_with_exceptions release BIN, LOC and STG like pickup does.
// Real migrations 10, 20, 60, 61 in PGlite; every call through tp_org /
// tp_driver as the anon role. Plus the real stow.html Reset Bin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

async function setup() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql'] });
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: token, p_action: action, p_args: args });
  const route = async (title, orgId = ORG_A, stops = null) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name, surge_stops) values ($1,$2,'assigned','surge','Dana Driver',$3) returning id`,
    [orgId, title, stops && JSON.stringify(stops)])).rows[0].id;
  // stowed and staged: open the bin, complete it, scan STG
  const staged = async (title, bin, loc, spot) => {
    const id = await route(title);
    await O('open_binding', { id, bin_code: bin, location_code: loc, opened_by: 'Sam' });
    await O('binding_ready', { id });
    if (spot) assert.equal((await O('stage_binding', { id, staging_code: 'STG:' + spot })).ok, true);
    return id;
  };
  const rows = async (jid) => (await db.query(
    `select bin_code, location_code, staging_code, state, staged_at is not null as staged, released_at is not null as closed
       from public.bin_bindings where job_id = $1 order by opened_at, state`, [jid])).rows;
  const all = async () => (await db.query('select job_id, bin_code, staging_code, state, released_at from public.bin_bindings order by job_id, opened_at')).rows;
  // another company holding the same bin, location and spot names
  const other = await route('Other Co route', ORG_B);
  await db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, staging_code, staged_at)
                  values ($1,'1A','A-07',$2,'ready','S-01',now())`, [ORG_B, other]);
  return { db, O, route, staged, rows, all, other };
}

test('Reset Bin frees the STG spot (history kept, bin stays with the route); a second reset changes nothing', async () => {
  const t = await setup();
  const a = await t.staged('Route A', '1A', 'A-07', 'S-01');
  const b = await t.staged('Route B', '2A', 'A-08', 'S-02');
  const before = JSON.stringify(await t.rows(b));
  await t.O('set_staged', { id: a, staged: false });            // PathIQ Reset Bin
  assert.deepEqual(await t.rows(a), [
    { bin_code: '1A', location_code: 'A-07', staging_code: 'S-01', state: 'reset', staged: true, closed: true },   // the record
    { bin_code: '1A', location_code: 'A-07', staging_code: null, state: 'open', staged: false, closed: false },     // bin kept, from zero
  ]);
  assert.equal(JSON.stringify(await t.rows(b)), before, 'route B untouched');
  assert.equal((await t.db.query('select state, staging_code from public.bin_bindings where job_id = $1', [t.other])).rows[0].state, 'ready', 'other company untouched');
  // S-01 is free again: another route can be staged there
  const c = await t.staged('Route C', '3A', 'A-09', null);
  assert.equal((await t.O('stage_binding', { id: c, staging_code: 'S-01' })).ok, true);
  // second reset: nothing changes
  const snap = JSON.stringify(await t.all());
  await t.O('set_staged', { id: a, staged: false });
  assert.equal(JSON.stringify(await t.all()), snap);
  // route A is stowed again and can be staged somewhere else
  await t.O('binding_ready', { id: a });
  assert.equal((await t.O('stage_binding', { id: a, staging_code: 'S-04' })).ok, true);
});

test('Cancel frees BIN, LOC and STG (record kept); a second cancel changes nothing', async () => {
  const t = await setup();
  const a = await t.staged('Route A', '1A', 'A-07', 'S-01');
  const b = await t.staged('Route B', '2A', 'A-08', 'S-02');
  await t.O('update_job', { id: a, patch: { status: 'cancelled' } });      // dispatcher "Cancel This Job"
  assert.deepEqual(await t.rows(a), [{ bin_code: '1A', location_code: 'A-07', staging_code: 'S-01', state: 'released', staged: true, closed: true }]);
  assert.equal((await t.rows(b))[0].state, 'ready', 'route B untouched');
  assert.equal((await t.db.query('select state from public.bin_bindings where job_id = $1', [t.other])).rows[0].state, 'ready', 'other company untouched');
  assert.ok(!(await t.O('bindings')).some((x) => x.job_id === a), 'no longer live');
  const snap = JSON.stringify(await t.all());
  await t.O('update_job', { id: a, patch: { status: 'cancelled' } });
  assert.equal(JSON.stringify(await t.all()), snap, 'second cancel: nothing');
  // its bin, location and spot can be used by the next route
  const c = await t.staged('Route C', '1A', 'A-07', 'S-01');
  assert.equal((await t.rows(c))[0].state, 'ready');
  // cancelled before the bin was even complete
  const d = await t.route('Route D');
  await t.O('open_binding', { id: d, bin_code: '4A', location_code: 'A-10' });
  await t.O('update_job', { id: d, patch: { status: 'cancelled' } });
  assert.equal((await t.rows(d))[0].state, 'released');
});

test('delivered and completed_with_exceptions set without a pickup also release; pickup still does', async () => {
  const t = await setup();
  const a = await t.staged('Route A', '1A', 'A-07', 'S-01');
  const b = await t.staged('Route B', '2A', 'A-08', 'S-02');
  const c = await t.staged('Route C', '3A', 'A-09', 'S-03');
  const keep = await t.staged('Route K', '5A', 'A-11', 'S-05');
  await t.O('update_job', { id: a, patch: { status: 'delivered' } });
  await t.O('update_job', { id: b, patch: { status: 'completed_with_exceptions' } });
  const issued = await rpc(t.db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = (await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).token;
  await rpc(t.db, 'tp_driver', { p_token: drv, p_action: 'update_job', p_args: { id: c, patch: { status: 'in_transit', driver_name: 'Dana Driver' } } });
  for (const id of [a, b, c]) assert.equal((await t.rows(id))[0].state, 'released');
  assert.equal((await t.rows(keep))[0].state, 'ready');
  // delivered after pickup: already released, nothing more happens
  const snap = JSON.stringify(await t.all());
  await rpc(t.db, 'tp_driver', { p_token: drv, p_action: 'update_job', p_args: { id: c, patch: { status: 'delivered', driver_name: 'Dana Driver' } } });
  assert.equal(JSON.stringify(await t.all()), snap);
});

test('rollback of 61 restores migration 60 behaviour (pickup only, no reset/cancel release)', async () => {
  const t = await setup();
  await assert.rejects(t.db.exec(sqlFile('61_staging_release_gaps.sql')), /already applied/); await t.db.exec('rollback');
  await t.db.exec(sqlFile('61_staging_release_gaps.rollback.sql'));
  const a = await t.staged('Route A', '1A', 'A-07', 'S-01');
  const b = await t.staged('Route B', '2A', 'A-08', 'S-02');
  const c = await t.staged('Route C', '3A', 'A-09', 'S-03');
  await t.O('set_staged', { id: a, staged: false });
  assert.deepEqual((await t.rows(a)).map((r) => [r.state, r.staging_code]), [['ready', 'S-01']], 'reset no longer frees the spot');
  await t.O('update_job', { id: b, patch: { status: 'cancelled' } });
  assert.equal((await t.rows(b))[0].state, 'ready', 'cancel no longer releases');
  await t.O('update_job', { id: c, patch: { status: 'in_transit' } });
  assert.equal((await t.rows(c))[0].state, 'released', 'pickup still releases (60)');
  await assert.rejects(t.db.exec(sqlFile('61_staging_release_gaps.rollback.sql')), /not in place/); await t.db.exec('rollback');
  await t.db.exec(sqlFile('61_staging_release_gaps.sql'));     // and 61 applies again
});

test('PathIQ Reset Bin (stow.html) frees the spot on the server and forgets it on the page', async () => {
  const t = await setup();
  const stop = { stop_number: 1, address: '1 A St', tracking_number: 'PA1', pkgs: [{ tracking_number: 'PA1', order_id: 'O-PA1', piece_id: 'PA1', required_count: 1 }] };
  const a = await t.route('Route A', ORG_A, [stop]);
  await t.O('open_binding', { id: a, bin_code: '1A', location_code: 'A-07', opened_by: 'Sam' });
  const token = (await rpc(t.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const app = loadApp('stow.html', { initialStorage: { tp_worker: 'Sam', tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token }) },
    fetchHandler: async (url, opts) => {
      const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)/);
      if (!m) return json(401, { message: 'no direct access' });
      try { return json(200, await rpc(t.db, m[1], JSON.parse((opts && opts.body) || '{}'), 'anon')); } catch (e) { return json(400, { message: e.message }); }
    } });
  const w = app.dom.window;
  try {
    await wait(500);
    await w.eval('handleStowScan("PA1")'); await w.eval('handleStowScan("BIN:1A")'); await wait(80);
    await w.eval('handleStowScan("STG:S-01")'); await wait(80);
    assert.equal((await t.rows(a))[0].staging_code, 'S-01');
    w.eval('doResetBin("1A")'); await wait(200);
    assert.deepEqual((await t.rows(a)).map((r) => [r.state, r.staging_code]), [['reset', 'S-01'], ['open', null]]);
    assert.equal(w.eval(`JSON.stringify(binBindings[${JSON.stringify(a)}])`).includes('"staging_code":null'), true);
    assert.equal(w.eval(`binBindings[${JSON.stringify(a)}].state`), 'open');
    // re-stow: the route is ready to stage again, not shown as staged at the old spot
    await w.eval('handleStowScan("PA1")'); await w.eval('handleStowScan("BIN:1A")'); await wait(80);
    assert.match(w.document.getElementById('stowResult').textContent, /Route complete\. Scan a STG code/);
    assert.doesNotMatch(w.document.getElementById('binsPanel').textContent, /STAGED AT S-01/);
  } finally { app.cleanup(); }
});
