// PathIQ (stow.html) staging step and pickup release, end to end: the real
// page in jsdom against migrations 10, 20 and 60 in PGlite. Every call goes
// through tp_org / tp_driver as the anon role; a direct table request fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, rpc, ORG_A } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

const stop = (n, codes) => ({ stop_number: n, address: n + ' A St', tracking_number: codes[0],
  pkgs: codes.map((c) => ({ tracking_number: c, order_id: 'O-' + c, piece_id: c, required_count: 1 })) });

async function setup() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql'] });
  const ins = async (title, stops) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name, surge_stops) values ($1,$2,'assigned','surge','Dana Driver',$3) returning id`,
    [ORG_A, title, JSON.stringify(stops)])).rows[0].id;
  const a = await ins('Route A', [stop(1, ['PA1', 'PA2'])]);
  const b = await ins('Route B', [stop(1, ['PB1'])]);
  await ins('Route C', [stop(1, ['PC1'])]);           // no bin yet
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: token, p_action: action, p_args: args });
  await O('open_binding', { id: a, bin_code: '1A', location_code: 'A-07', opened_by: 'Sam' });
  await O('open_binding', { id: b, bin_code: '2A', location_code: 'A-08', opened_by: 'Sam' });
  const direct = [];
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const handler = async (url, opts) => {
    url = String(url);
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      try { return json(200, await rpc(db, m[1], JSON.parse((opts && opts.body) || '{}'), 'anon')); }
      catch (e) { return json(400, { message: e.message }); }
    }
    if (/\/rest\/v1\//.test(url)) { direct.push(url); return json(401, { message: 'permission denied' }); }
    return json(200, []);
  };
  const app = loadApp('stow.html', { fetchHandler: handler, initialStorage: { tp_worker: 'Sam',
    tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token }) } });
  const w = app.dom.window;
  await wait(500);
  const card = () => w.document.getElementById('stowResult').innerHTML.replace(/<br>|<\/div>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&#10003;/g, '✓').replace(/\s+/g, ' ').trim();
  const scan = async (code) => { await w.eval('handleStowScan(' + JSON.stringify(code) + ')'); await wait(30); };
  // typed on the keyboard (or the TC56's scanner keyboard), then Enter
  const type = async (code) => {
    const inp = w.document.getElementById('stowInput'); inp.value = code;
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(80);
  };
  const binding = async (jid) => (await db.query(
    `select bin_code, location_code, staging_code, state from public.bin_bindings where job_id = $1`, [jid])).rows[0];
  const panel = () => w.document.getElementById('binsPanel').textContent.replace(/\s+/g, ' ');
  return { db, a, b, O, w, app, card, scan, type, binding, panel, direct };
}

test('PathIQ: stow -> ready to stage -> STG (typed) -> staged; double STG refused; driver pickup frees BIN/LOC/STG', async () => {
  const t = await setup();
  try {
    // stow route A into bin 1A; the last package completes the route
    await t.scan('PA1'); await t.scan('BIN:1A');
    await t.scan('PA2'); await t.scan('BIN:1A');
    assert.match(t.card(), /Route complete\. Scan a STG code to stage this bin\./);
    assert.match(t.panel(), /ROUTE COMPLETE · SCAN STG TO STAGE/);
    assert.equal((await t.binding(t.a)).state, 'ready');
    assert.equal((await t.binding(t.a)).staging_code, null, 'complete is not staged');
    // a LOC code where STG is expected: clear message, nothing changes
    await t.scan('LOC:A-07');
    assert.match(t.card(), /Wrong Code.*location \(LOC\) code\. Scan a STG code to stage BIN 1A\. Nothing was changed\./);
    assert.equal((await t.binding(t.a)).staging_code, null);
    // typed entry stages it
    await t.type('stg:s-01');
    assert.match(t.card(), /Staged STG S-01 BIN 1A · Route A READY FOR PICKUP/);
    assert.deepEqual(await t.binding(t.a), { bin_code: '1A', location_code: 'A-07', staging_code: 'S-01', state: 'ready' });
    assert.match(t.panel(), /STAGED AT S-01 · READY FOR PICKUP/);
    // a STG code with nothing waiting
    await t.scan('STG:S-05');
    assert.match(t.card(), /Nothing To Stage.*No route is waiting to be staged/);
    // route B into bin 2A, then the same spot: refused with route A's name
    await t.scan('PB1'); await t.scan('BIN:2A');
    assert.match(t.card(), /Route complete\. Scan a STG code/);
    await t.scan('STG:S-01');
    assert.match(t.card(), /Staging Spot Taken STG S-01 Route A is already staged there\. Scan a different STG code for BIN 2A\./);
    assert.equal((await t.binding(t.b)).staging_code, null, 'refused: nothing changed');
    await t.scan('STG:S-02');
    assert.equal((await t.binding(t.b)).staging_code, 'S-02');
    // driver picks route A up (bin scan at pickup -> in transit): its spots are freed
    const issued = await rpc(t.db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
    const drv = (await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: issued.code })).token;
    const pickup = () => rpc(t.db, 'tp_driver', { p_token: drv, p_action: 'update_job',
      p_args: { id: t.a, patch: { status: 'in_transit', picked_up_at: new Date().toISOString(), driver_name: 'Dana Driver' } } });
    await pickup(); await pickup();
    assert.equal((await t.binding(t.a)).state, 'released');
    assert.equal((await t.binding(t.a)).staging_code, 'S-01', 'the record stays');
    assert.equal((await t.binding(t.b)).state, 'ready', 'route B keeps its bin and spot');
    // PathIQ sees bin 1A and spot S-01 free again
    await t.w.eval('loadBinBindings()'); await wait(50);
    assert.equal(t.w.eval('binCodeInUse("1A", "x")'), false);
    assert.equal(t.w.eval('binCodeInUse("2A", "x")'), true);
    assert.deepEqual(t.direct, [], 'no direct table access');
  } finally { t.app.cleanup(); }
});

test('PathIQ: a STG code while a package waits for its bin, or while opening a bin, changes nothing', async () => {
  const t = await setup();
  try {
    await t.scan('PA1');                       // waiting for bin 1A
    await t.scan('STG:S-01');
    assert.match(t.card(), /That Is A Staging Code.*Scan the BIN or LOCATION QR\. Nothing was changed\./);
    await t.scan('BIN:1A');                    // the placement still completes normally
    assert.match(t.card(), /Confirmed BIN 1A 1 of 2 sorted/);
    assert.equal((await t.binding(t.a)).staging_code, null);
    // scanning the BIN of a completed, unstaged route selects it for staging
    await t.scan('PA2'); await t.scan('BIN:1A');
    await t.scan('PB1'); await t.scan('BIN:2A');       // B completes last: it is the target now
    await t.scan('BIN:1A');
    assert.match(t.card(), /Ready To Stage BIN 1A Route A Scan a STG code to stage this bin\./);
    await t.scan('STG:S-07');
    assert.equal((await t.binding(t.a)).staging_code, 'S-07');
    assert.equal((await t.binding(t.b)).staging_code, null);
    // route C has no bin: its first package starts OPEN BIN; a STG code there changes nothing
    await t.scan('PC1');
    assert.ok(t.w.eval('!!openingBin'));
    await t.scan('STG:S-01');
    assert.match(t.card(), /That Is A Staging Code You are opening a bin\. Scan the BIN QR\. Nothing was changed\./);
    assert.ok(t.w.eval('!!openingBin && !openingBin.binCode'), 'still opening, no bin taken');
  } finally { t.app.cleanup(); }
});
