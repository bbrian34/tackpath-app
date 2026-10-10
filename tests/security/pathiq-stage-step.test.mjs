// PathIQ (stow.html) STAGE step: when the last package of a route is stowed,
// the big panel (the same one the BIN step uses) becomes a STAGE step, the
// step bar PACKAGE > BIN > LOCATION > STAGE shows STAGE as current, a STG
// scan (or typed entry) shows "STAGED at <spot>. Ready for pickup.", and a
// wrong scan says a STG code is needed and changes nothing. The real page in
// jsdom against the real gateway (migrations 10, 20, 50, 60-63, 65) in PGlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, sqlFile, rpc, ORG_A } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const MIG = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql',
  '61_staging_release_gaps.sql', '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '65_bins_self_heal.sql'];
const stop = (codes) => ({ stop_number: 1, address: '1 A St', tracking_number: codes[0],
  pkgs: codes.map((c) => ({ tracking_number: c, order_id: 'O-' + c, piece_id: c, required_count: 1 })) });

async function setup() {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  for (const f of MIG) await db.exec(sqlFile(f));
  const ins = async (title, codes) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, surge_stops) values ($1,$2,'pending','surge',$3) returning id`,
    [ORG_A, title, JSON.stringify([stop(codes)])])).rows[0].id;
  const a = await ins('Route A', ['PA1', 'PA2']);
  const b = await ins('Route B', ['PB1']);
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const O = (action, args = {}) => rpc(db, 'tp_org', { p_token: token, p_action: action, p_args: args });
  await O('open_binding', { id: a, bin_code: '1A', location_code: 'A-07', opened_by: 'Sam' });
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const app = loadApp('stow.html', { initialStorage: { tp_worker: 'Sam', tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token }) },
    fetchHandler: async (url, opts) => {
      const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)/);
      if (!m) return json(401, { message: 'no direct table access' });
      try { return json(200, await rpc(db, m[1], JSON.parse((opts && opts.body) || '{}'), 'anon')); } catch (e) { return json(400, { message: e.message }); }
    } });
  const w = app.dom.window;
  await wait(500);
  const $ = (id) => w.document.getElementById(id);
  const txt = (id) => ($(id).textContent || '').replace(/\s+/g, ' ').trim();
  const card = () => $('stowResult').innerHTML.replace(/<br>|<\/div>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&#10003;/g, '✓').replace(/\s+/g, ' ').trim();
  const scan = async (c) => { await w.eval('handleStowScan(' + JSON.stringify(c) + ')'); await wait(40); };
  const type = async (c) => {
    const inp = $('stowInput'); inp.value = c;
    inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(120);
  };
  const back = () => w.document.querySelector('#scanFlipInner .flip-card-back');
  const flipped = () => $('scanFlipInner').classList.contains('flipped');
  const current = () => { const on = w.document.querySelector('#stowSteps .st.on'); return on ? on.textContent : null; };
  const steps = () => [...w.document.querySelectorAll('#stowSteps .st')].map((e) => e.textContent + (e.classList.contains('on') ? '*' : e.classList.contains('done') ? '+' : ''));
  const spot = async (jid) => (await db.query(`select staging_code from public.bin_bindings where job_id = $1 and state in ('open','ready')`, [jid])).rows[0]?.staging_code ?? null;
  return { db, a, b, O, app, w, $, txt, card, scan, type, back, flipped, current, steps, spot };
}

test('after the last package: a full STAGE step on the big panel, STAGE current in the step bar', async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.steps(), ['PACKAGE*', 'BIN', 'LOCATION', 'STAGE'], 'starts on PACKAGE');
    await t.scan('PA1');
    assert.equal(t.current(), 'BIN', 'package scanned: BIN is next');
    assert.ok(t.flipped());
    await t.scan('BIN:1A');
    assert.equal(t.current(), 'PACKAGE');
    await t.scan('PA2'); await t.scan('BIN:1A');                  // the last package of Route A
    assert.match(t.card(), /Bin Complete BIN 1A Route complete\. Scan a STG code to stage this bin\./);
    // the STAGE step: same panel as BIN, flipped, its own colour, large
    assert.ok(t.flipped(), 'the big panel is showing');
    assert.ok(t.back().classList.contains('stage-mode'));
    assert.ok(t.$('scanFlipContainer').classList.contains('tall'));
    assert.equal(t.txt('flipBinNumber'), 'STAGE');
    assert.equal(t.txt('flipBinInstr'), 'Scan a STG code to stage this bin');
    assert.equal(t.txt('flipBinLoc'), 'BIN 1A · Route A');
    assert.equal(t.txt('flipBinStop'), 'STG codes look like STG:S-01');
    assert.deepEqual(t.steps(), ['PACKAGE+', 'BIN+', 'LOCATION+', 'STAGE*']);
    assert.equal(t.w.document.querySelector('#stowSteps .st.on').getAttribute('aria-current'), 'step');
    // the BIN step's size (2026-10-11): the same panel element and the BIN heading size, not larger
    // (stow-stage-size.test.js measures the panel in a real browser)
    const big = t.w.getComputedStyle(t.$('flipBinNumber')).fontSize;
    assert.ok(['2.2rem', '35.2px'].includes(big), 'STAGE heading size ' + big);
    assert.equal(t.$('stageLaterBtn').style.display, 'block');
  } finally { t.app.cleanup(); }
});

test('typed STG entry stages: "STAGED at S-01. Ready for pickup." with the spot large, then the normal flow returns', async () => {
  const t = await setup();
  try {
    await t.scan('PA1'); await t.scan('BIN:1A'); await t.scan('PA2'); await t.scan('BIN:1A');
    await t.type('stg:s-01');                                     // typed exactly like a scan
    assert.equal(await t.spot(t.a), 'S-01');
    assert.ok(t.back().classList.contains('staged-mode'));
    assert.equal(t.txt('flipBinNumber'), 'STAGED at S-01');
    assert.equal(t.txt('flipBinInstr'), 'Ready for pickup.');
    assert.equal(t.txt('flipBinLoc'), 'BIN 1A · Route A');
    assert.match(t.card(), /Staged STG S-01 BIN 1A · Route A READY FOR PICKUP/);
    assert.equal(t.current(), 'PACKAGE');
    assert.equal(t.$('stageLaterBtn').style.display, 'none');
    await wait(3700);                                             // then back to the normal flow
    assert.ok(!t.flipped());
    assert.ok(!t.back().classList.contains('staged-mode'));
    await t.scan('PB1');                                          // the next route starts normally
    assert.match(t.card(), /OPEN NEW BIN/);
    assert.equal(t.current(), 'BIN');
    await t.scan('BIN:2A');
    assert.equal(t.current(), 'LOCATION', 'opening a bin: LOCATION is next');
  } finally { t.app.cleanup(); }
});

test('a wrong scan at the STAGE step (LOC, BIN, package) says a STG code is needed and changes nothing', async () => {
  const t = await setup();
  try {
    await t.scan('PA1'); await t.scan('BIN:1A'); await t.scan('PA2'); await t.scan('BIN:1A');
    await t.scan('LOC:A-07');
    assert.match(t.card(), /Wrong Code LOC:A-07 That is a location \(LOC\) code\. Scan a STG code to stage BIN 1A\. Nothing was changed\./);
    await t.scan('BIN:9Z');
    assert.match(t.card(), /Wrong Code BIN:9Z That is a bin \(BIN\) code\. Scan a STG code to stage BIN 1A\. Nothing was changed\./);
    await t.type('PB1');                                          // a package barcode, typed
    assert.match(t.card(), /STG Code Needed STAGE BIN 1A That is a package barcode\. Scan a STG code, like STG:S-01, to stage BIN 1A\. Nothing was changed\./);
    assert.ok(t.$('stowResult').className.includes('error'));
    assert.equal(await t.spot(t.a), null, 'not staged');
    assert.equal(t.w.eval('!!openingBin||!!pendingPlacement'), false, 'the package was not taken into the stow flow');
    assert.equal(t.current(), 'STAGE', 'still on the STAGE step');
    assert.equal(t.txt('flipBinNumber'), 'STAGE');
  } finally { t.app.cleanup(); }
});

test('two routes waiting to be staged: the STAGE step says which bin the next STG scan stages', async () => {
  const t = await setup();
  try {
    await t.scan('PA1'); await t.scan('BIN:1A'); await t.scan('PA2'); await t.scan('BIN:1A');
    t.w.eval('stageLater()');                                     // Route A waits; the worker goes on
    assert.equal(t.current(), 'PACKAGE');
    assert.ok(!t.flipped());
    await t.scan('PB1'); await t.scan('BIN:2A'); await t.scan('LOC:A-08'); await t.scan('PB1'); await t.scan('BIN:2A');
    assert.equal(t.current(), 'STAGE');
    assert.equal(t.txt('flipBinLoc'), 'BIN 2A · Route B');
    assert.equal(t.txt('flipBinStop'), '2 bins waiting to stage. This STG scan stages BIN 2A.');
    await t.scan('BIN:1A');                                       // pick Route A instead
    assert.equal(t.txt('flipBinLoc'), 'BIN 1A · Route A');
    assert.equal(t.txt('flipBinStop'), '2 bins waiting to stage. This STG scan stages BIN 1A.');
    await t.scan('STG:S-01');
    assert.equal(await t.spot(t.a), 'S-01');
    assert.equal(await t.spot(t.b), null);
    assert.equal(t.txt('flipBinNumber'), 'STAGED at S-01');
    assert.equal(t.txt('flipBinStop'), 'Still to stage: BIN 2A. Scan its BIN, then a STG code.');
  } finally { t.app.cleanup(); }
});
