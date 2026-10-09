// PathIQ (stow.html) badge sign-in: the real page in jsdom against
// migrations 10, 20, 60 and 61 in PGlite. The badge is TP|<slug>|<code>; it
// signs in through the existing tp_org_sign_in, stores only the session
// (tp_dispatch_org with the token) and never stores, shows or logs the code.
// Every call goes through the public tp_* functions as anon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, rpc, ORG_A } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

const CODE = 'qh-portal-2026';                    // the fixture's test company code
const BADGE = `TP|quickhaul|${CODE}`;
const stop = (n, codes) => ({ stop_number: n, address: n + ' A St', tracking_number: codes[0],
  pkgs: codes.map((c) => ({ tracking_number: c, order_id: 'O-' + c, piece_id: c, required_count: 1 })) });

async function setup({ signedIn = false } = {}) {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql'] });
  const a = (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name, surge_stops) values ($1,'Route A','assigned','surge','Dana Driver',$2) returning id`,
    [ORG_A, JSON.stringify([stop(1, ['PA1', 'PA2'])])])).rows[0].id;
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: CODE })).token;
  await rpc(db, 'tp_org', { p_token: token, p_action: 'open_binding', p_args: { id: a, bin_code: '1A', location_code: 'A-07', opened_by: 'Sam' } });
  const direct = [], signIns = [];
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const handler = async (url, opts) => {
    url = String(url);
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      if (m[1] === 'tp_org_sign_in') signIns.push(JSON.parse(opts.body));
      try { return json(200, await rpc(db, m[1], JSON.parse((opts && opts.body) || '{}'), 'anon')); }
      catch (e) { return json(400, { message: e.message }); }
    }
    if (/\/rest\/v1\//.test(url)) { direct.push(url); return json(401, { message: 'permission denied' }); }
    return json(200, []);
  };
  const initialStorage = { tp_worker: 'Sam' };
  if (signedIn) initialStorage.tp_dispatch_org = JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token });
  const app = loadApp('stow.html', { fetchHandler: handler, initialStorage });
  const w = app.dom.window;
  // everything the page logs, to prove the code never reaches a log
  const logged = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = w.console[k];
    w.console[k] = (...args) => { logged.push(args.map(String).join(' ')); if (k === 'error') orig.apply(w.console, args); };
  }
  await wait(500);
  const $ = (id) => w.document.getElementById(id);
  const msg = () => ($('tpBadgeMsg') || {}).textContent || '';
  const onScreen = () => ['scHome', 'scStow', 'scReceive', 'scAssignbins'].find((s) => $(s).classList.contains('on'));
  // a hardware scan in keyboard-wedge mode: characters into the focused field, then Enter
  const wedge = async (value) => {
    const el = w.document.activeElement;
    assert.ok(el && el.tagName === 'INPUT', 'a scan input has focus');
    el.value = value;
    el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(120);
  };
  const scan = async (code) => { await w.eval('handleStowScan(' + JSON.stringify(code) + ')'); await wait(60); };
  // nothing the page keeps or shows may hold the code
  const noCodeAnywhere = () => {
    for (const [k, v] of Object.entries(app.storage)) assert.ok(!String(v).includes(CODE), `code not stored (${k})`);
    for (const l of logged) assert.ok(!l.includes(CODE), 'code not logged');
    assert.ok(!w.document.body.innerHTML.includes(CODE), 'code not shown');
    for (const i of w.document.querySelectorAll('input')) assert.ok(!i.value.includes(CODE), `code not left in #${i.id}`);
  };
  const events = async () => (await db.query(`select event_type, payload from public.events where org_id = $1 order by occurred_at`, [ORG_A])).rows;
  return { db, a, token, w, app, $, msg, onScreen, wedge, scan, noCodeAnywhere, events, logged, direct, signIns };
}

// A field is visible unless it, or an ancestor, is display:none, or it sits off-screen.
function visibleFields(w, root) {
  return [...root.querySelectorAll('input, textarea, select')].filter((el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = w.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const left = parseInt(el.style.left || '0', 10);
    return !(el.style.position === 'absolute' && left <= -1000);
  });
}

test('badge screen: one plain screen, no visible text field, scanner input already focused', async () => {
  const t = await setup();
  try {
    const si = t.$('tpSignIn');
    assert.ok(si, 'badge screen shown with no session');
    assert.equal(t.$('tpBadgeTitle').textContent, 'Scan your badge to start');
    assert.deepEqual(visibleFields(t.w, si), [], 'no text field visible on the badge screen');
    assert.equal(t.w.document.activeElement, t.$('tpBadgeInput'), 'scanner input focused');
    assert.equal(t.$('tpBadgeInput').getAttribute('inputmode'), 'none', 'no on-screen keyboard');
    assert.ok(t.$('tpTypeLink'), 'small "Type instead" link');
    assert.equal(t.$('tpTypeLink').textContent, 'Type instead');
    // a tap anywhere on the screen keeps the scanner input focused
    t.$('tpBadgeInput').blur(); si.click(); await wait(20);
    assert.equal(t.w.document.activeElement, t.$('tpBadgeInput'));
  } finally { t.app.cleanup(); }
});

test('a valid badge (hardware scan, Enter-terminated) signs in with tp_org_sign_in and lands on Stow; only the session is stored', async () => {
  const t = await setup();
  try {
    assert.equal(t.app.storage.tp_dispatch_org, undefined);
    await t.wedge(BADGE);
    assert.equal(t.$('tpSignIn'), null, 'badge screen gone');
    assert.equal(t.onScreen(), 'scStow', 'straight to Stow');
    assert.equal(t.w.document.activeElement, t.$('stowInput'), 'ready to scan packages');
    assert.deepEqual(t.signIns, [{ p_slug: 'quickhaul', p_code: CODE }], 'the existing company sign-in RPC, once');
    const s = JSON.parse(t.app.storage.tp_dispatch_org);
    assert.deepEqual(Object.keys(s).sort(), ['id', 'name', 'slug', 'token']);
    assert.equal(s.id, ORG_A); assert.equal(s.slug, 'quickhaul');
    assert.equal((await rpc(t.db, 'tp_org', { p_token: s.token, p_action: 'jobs', p_args: {} })).length >= 1, true, 'token works');
    t.noCodeAnywhere();
    // it works: the routes load and a package scan finds its bin
    await wait(300);
    await t.scan('PA1');
    assert.equal(t.w.eval('pendingPlacement && pendingPlacement.binNum'), '1A');
    assert.deepEqual(t.direct, [], 'no direct table access');
  } finally { t.app.cleanup(); }
});

test('a badge from the Zebra DataWedge bridge signs in too, and is never written to the debug panel', async () => {
  const t = await setup();
  try {
    let onScan = null;
    t.w.Capacitor.Plugins.ZebraScanner = { addListener: (name, fn) => { onScan = fn; } };
    await wait(600);                                   // the bridge attaches on its retry
    assert.ok(onScan, 'Zebra bridge attached');
    onScan({ value: 'BIN:1A' }); await wait(60);
    assert.match(t.msg(), /That is not a badge\. That is a BIN code\./);
    onScan({ value: BADGE + '\n' }); await wait(150);
    assert.equal(t.$('tpSignIn'), null);
    assert.equal(t.onScreen(), 'scStow');
    // signed in: a badge scanned again is swallowed, not treated as a package
    const before = t.$('stowResult').innerHTML;
    onScan({ value: BADGE }); await wait(60);
    assert.equal(t.$('stowResult').innerHTML, before, 'nothing happens');
    assert.ok(!t.$('debugPanel').textContent.includes('TP|'), 'badge not in the debug panel');
    t.noCodeAnywhere();
  } finally { t.app.cleanup(); }
});

test('wrong or malformed scans say "That is not a badge" (or "not accepted") and change nothing', async () => {
  const t = await setup();
  try {
    const cases = [
      ['BIN:1A', /That is not a badge\. That is a BIN code\. Scan your TackPath badge\./],
      ['LOC:A-07', /That is not a badge\. That is a location \(LOC\) code\./],
      ['STG:S-01', /That is not a badge\. That is a staging \(STG\) code\./],
      ['1Z999AA10123456784', /That is not a badge\. That looks like a package or other barcode\./],
      ['PA1', /That is not a badge\. That looks like a package/],
      ['XX|quickhaul|' + CODE, /That is not a badge\. That looks like a package or other barcode\./],   // wrong prefix
      ['TP|quickhaul', /That is not a badge\. The badge could not be read\./],                        // malformed
      ['TP|quickhaul|short', /That is not a badge\. The badge could not be read\./],
      ['TP|quick haul!|' + CODE, /That is not a badge\. The badge could not be read\./],
      ['TP|quickhaul|' + CODE + '|extra', /That is not a badge\. The badge could not be read\./],
      ['', /That is not a badge\./],
    ];
    for (const [value, want] of cases) {
      await t.wedge(value);
      assert.match(t.msg(), want, value);
      assert.ok(t.$('tpSignIn'), 'still on the badge screen: ' + value);
      assert.equal(t.app.storage.tp_dispatch_org, undefined, 'no session: ' + value);
    }
    assert.deepEqual(t.signIns, [], 'malformed scans never reach the server');
    // well formed but the wrong code: the server refuses it
    await t.wedge('TP|quickhaul|not-the-right-code');
    assert.match(t.msg(), /^Badge not accepted\. Ask your manager for a current badge\.$/);
    assert.equal(t.app.storage.tp_dispatch_org, undefined);
    assert.ok(!t.msg().includes('not-the-right-code'), 'the code is not echoed');
    // unknown company
    await t.wedge('TP|nobody|' + CODE);
    assert.match(t.msg(), /^Badge not accepted\./);
    assert.equal(t.app.storage.tp_dispatch_org, undefined);
    assert.equal(t.onScreen(), 'scHome', 'nothing changed');
    t.noCodeAnywhere();
    // and the right badge still works afterwards
    await t.wedge(BADGE);
    assert.equal(t.onScreen(), 'scStow');
  } finally { t.app.cleanup(); }
});

test('while signed in PathIQ opens straight into Stow with no login screen; Sign out is in the Settings menu', async () => {
  const t = await setup({ signedIn: true });
  try {
    assert.equal(t.$('tpSignIn'), null);
    assert.equal(t.onScreen(), 'scStow');
    assert.equal(t.$('tpSignOutBtn'), null, 'sign out is not on the main screen');
    t.w.eval("goTo('home')");
    t.w.confirm = () => true;
    t.w.eval('tpShowMenu()');
    assert.match(t.$('tpMenuWho').textContent, /Signed in: Quick Haul/);
    t.$('tpSignOutBtn').click(); await wait(80);
    assert.equal(t.app.storage.tp_dispatch_org, undefined);
    assert.ok(t.$('tpSignIn'), 'badge screen back');
    assert.equal(t.$('tpMenu'), null);
    await assert.rejects(rpc(t.db, 'tp_org', { p_token: t.token, p_action: 'jobs', p_args: {} }), /TP_AUTH/, 'session revoked on the server');
  } finally { t.app.cleanup(); }
});

test('session expires mid-work: the badge screen returns, the work is kept, and held writes are sent after the badge scan', async () => {
  const t = await setup({ signedIn: true });
  try {
    await t.scan('PA1');                                         // waiting for its bin
    assert.ok(t.w.eval('!!pendingPlacement'));
    const jobsBefore = t.w.eval('jobs.length');
    await t.db.query(`update tp_sec.sessions set expires_at = now() - interval '1 minute'`);
    // the placement's server writes fail with TP_AUTH while the worker scans the bin
    await t.scan('BIN:1A');
    assert.ok(t.$('tpSignIn'), 'badge screen back');
    assert.equal(t.app.storage.tp_dispatch_org, undefined, 'expired session dropped');
    assert.equal(t.w.eval('(binProgress["1A"]||{}).sorted'), 1, 'stowed package kept on the device');
    assert.ok(JSON.parse(t.app.storage.tp_piq_pending).some((x) => x.a === 'log_event' && x.org === ORG_A), 'stow event held');
    assert.ok(!t.app.storage.tp_piq_pending.includes(CODE));
    // the 5-second poll while signed out leaves the board alone
    await t.w.eval('loadRoutes()'); await wait(50);
    assert.equal(t.w.eval('jobs.length'), jobsBefore, 'routes kept');
    assert.equal((await t.events()).filter((e) => e.event_type === 'package.stowed').length, 0);
    // a package scanned now goes to the badge screen, not the stow flow
    await t.wedge('PA2');
    assert.match(t.msg(), /That is not a badge/);
    // badge: signed in again, still on Stow, the held stow event reaches the server once
    await t.wedge(BADGE); await wait(200);
    assert.equal(t.$('tpSignIn'), null);
    assert.equal(t.onScreen(), 'scStow');
    assert.equal(t.w.eval('(binProgress["1A"]||{}).sorted'), 1, 'progress still there');
    assert.equal((await t.events()).filter((e) => e.event_type === 'package.stowed').length, 1, 'held event sent');
    assert.equal(t.app.storage.tp_piq_pending, undefined, 'nothing left held');
    await t.scan('PA2'); await t.scan('BIN:1A');
    assert.match(t.$('stowResult').textContent, /Route complete/);
    t.noCodeAnywhere();
    assert.deepEqual(t.direct, []);
  } finally { t.app.cleanup(); }
});

test('typed fallback ("Type instead") still signs in, without a page reload, and clears the code field', async () => {
  const t = await setup();
  try {
    t.$('tpTypeLink').click();
    assert.equal(t.$('tpTypeForm').style.display, 'block');
    t.$('tpSiSlug').value = 'quickhaul'; t.$('tpSiCode').value = 'wrong-code-1';
    t.$('tpSiBtn').click(); await wait(120);
    assert.equal(t.$('tpSiErr').textContent, 'Company or code not recognised.');
    t.$('tpSiCode').value = CODE;
    t.$('tpSiCode').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter' })); await wait(150);
    assert.equal(t.$('tpSignIn'), null);
    assert.equal(t.onScreen(), 'scStow');
    assert.equal(JSON.parse(t.app.storage.tp_dispatch_org).slug, 'quickhaul');
    t.noCodeAnywhere();
  } finally { t.app.cleanup(); }
});

test('held writes go only to the company they were made for', async () => {
  const t = await setup({ signedIn: true });
  try {
    t.app.storage.tp_piq_pending = JSON.stringify([
      { org: 'someone-else', a: 'log_event', g: { event_type: 'package.stowed', idempotency_key: 'x-other' } },
      { org: ORG_A, a: 'log_event', g: { event_type: 'package.stowed', idempotency_key: 'x-mine', payload: {} } },
    ]);
    await t.w.eval('tpFlushHeld()'); await wait(50);
    assert.deepEqual((await t.events()).map((e) => e.event_type), ['package.stowed']);
    assert.deepEqual(JSON.parse(t.app.storage.tp_piq_pending).map((x) => x.org), ['someone-else'], 'other company kept, not sent');
    // non-replayable actions are never held
    t.app.storage.tp_dispatch_org = undefined; delete t.app.storage.tp_dispatch_org;
    await t.w.eval("tpOrgResp('open_binding',{id:'x'})");
    assert.deepEqual(JSON.parse(t.app.storage.tp_piq_pending).map((x) => x.a), ['log_event']);
  } finally { t.app.cleanup(); }
});
