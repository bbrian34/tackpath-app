// iq2.html on a simulated TC56: the real page in jsdom, its server calls
// routed into the real IQ2 SQL (PGlite) through a PostgREST-style adapter.
// Transport failures (offline, 500, response lost after commit) are
// injected at the fetch layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { freshDb, seed, scalar, ROOT } from './iq2-helpers.mjs';

const require = createRequire(import.meta.url);
const M = require('../iq2-manifest.js');
const HTML = fs.readFileSync(path.join(ROOT, 'iq2.html'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Boots iq2.html. `net.mode` controls the transport for the next calls:
//   'ok' | 'offline' | 'server500' | 'lost' (server commits, response lost)
function boot({ db, rpc, storage = {}, url = 'https://tackpath.com/iq2.html', referrer, native = false } = {}) {
  const net = { mode: 'ok', calls: [] };
  const zebra = { listeners: [] };
  const nav = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url, referrer, pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
      window.AudioContext = function () { return { createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; },
        createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }, currentTime: 0, destination: {} }; };
      window.Capacitor = {
        isNativePlatform: () => native,
        Plugins: { ZebraScanner: { addListener: (ev, fn) => { zebra.listeners.push(fn); return { remove() {} }; } } } };
      window.fetch = async (reqUrl, opts) => {
        const m = /\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(reqUrl);
        net.calls.push(m && m[1]);
        if (!m) return { ok: false, status: 404, json: async () => ({}) };
        const args = JSON.parse((opts && opts.body) || '{}');
        if (net.mode === 'offline') throw new TypeError('Failed to fetch');
        if (net.mode === 'server500') return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
        const result = await rpc(m[1], args);
        if (net.mode === 'lost') throw new TypeError('Network connection lost');
        return { ok: true, status: 200, json: async () => result };
      };
    },
  });
  const w = dom.window;
  w.iq2Navigate = (u) => nav.push(u);
  const scan = async (v) => { await w.iq2Scan(v); };
  const text = (id) => w.document.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
  const cls = (id) => w.document.getElementById(id).className;
  const on = (id) => w.document.getElementById(id).classList.contains('on');
  return { dom, w, net, zebra, nav, scan, text, cls, on, storage, ready: () => w.iq2Ready, close: () => w.close() };
}

async function setup() {
  const { db, rpc } = await freshDb();
  await seed(rpc, M);
  return { db, rpc };
}
const STORE = () => ({ iq2_warehouse: 'MAIN', tp_worker: 'Dana', tp_device: 'tc56abc123' });

// ── entry, warehouse, navigation ───────────────────────────────────────
test('first launch: choose the warehouse, then IQ2 home', async () => {
  const env = await setup();
  const storage = { tp_worker: 'Dana' };
  const a = boot({ ...env, storage });
  try {
    await a.ready();
    assert.ok(a.on('scSetup'));
    assert.match(a.text('whList'), /MAIN · Main DC/);
    a.w.iq2SetWarehouse('MAIN');
    assert.ok(a.on('scHome'));
    assert.equal(storage.iq2_warehouse, 'MAIN');
    await a.scan('PLT-0001');   // a scan on home is explicit, not silently accepted
    assert.match(a.text('homeResult'), /CHOOSE RECEIVE OR PUTAWAY/);
  } finally { a.close(); }
});

test('back to PathIQ: history when coming from PathIQ, else index.html in the APK / stow.html on the web', async () => {
  const env = await setup();
  const web = boot({ ...env, storage: STORE() });
  try { await web.ready(); web.w.iq2Back(); assert.deepEqual(web.nav, ['stow.html']); } finally { web.close(); }
  const apk = boot({ ...env, storage: STORE(), url: 'https://localhost/iq2.html', native: true });
  try { await apk.ready(); apk.w.iq2Back(); assert.deepEqual(apk.nav, ['index.html']); } finally { apk.close(); }
  const fromPathIQ = boot({ ...env, storage: STORE(), referrer: 'https://tackpath.com/stow.html' });
  try {
    await fromPathIQ.ready();
    let backs = 0; fromPathIQ.w.history.back = () => { backs++; };
    Object.defineProperty(fromPathIQ.w.history, 'length', { value: 2 });
    fromPathIQ.w.iq2Back();
    assert.equal(backs, 1); assert.deepEqual(fromPathIQ.nav, []);
  } finally { fromPathIQ.close(); }
  // inside a mode, back returns to IQ2 home first
  const b = boot({ ...env, storage: STORE() });
  try { await b.ready(); b.w.iq2Go('receive'); b.w.iq2Back(); assert.ok(b.on('scHome')); assert.deepEqual(b.nav, []); } finally { b.close(); }
});

test('STOW is untouched and its IQ2 card still loads iq2.html', () => {
  const stow = fs.readFileSync(path.join(ROOT, 'stow.html'), 'utf8');
  assert.match(stow, /onclick="window\.location\.href='iq2\.html'"/);
  assert.doesNotMatch(HTML, /stow\.html['"]\s*>|<script[^>]+src=/); // IQ2 loads no STOW code or external scripts
});

// ── receiving ──────────────────────────────────────────────────────────
test('receive: pallet → cartons of mixed SKUs, quantity shown, prompt returns to SCAN CARTON', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready();
    a.w.iq2Go('receive');
    assert.equal(a.text('rxPrompt'), 'SCAN PALLET');
    await a.scan('PLT-0001');
    assert.match(a.text('rxCtx'), /PLT-0001.*0 \/ 12/);
    assert.match(a.text('rxResult'), /0 \/ 12 CARTONS RECEIVED/);
    assert.equal(a.text('rxPrompt'), 'SCAN CARTON');
    await a.scan('00012345600000000011');
    const r = a.text('rxResult');
    assert.match(r, /Received ✓/);
    assert.match(r, /WALLET-BLK/);
    assert.match(r, /Men's Wallet, Black Leather/);
    assert.match(r, /QTY 100/);
    assert.match(r, /CARTON 1 OF 1/);
    assert.match(r, /PALLET 1 OF 12/);
    assert.equal(a.text('rxPrompt'), 'SCAN CARTON');
    assert.match(a.text('rxCtx'), /1 \/ 12/);
    await a.scan('20012345678909');
    assert.match(a.text('rxResult'), /TSHIRT-M-NVY.*QTY 25.*CARTON 1 OF 3.*PALLET 2 OF 12/);
    assert.match(a.text('rxCtx'), /125 of 477 units/);
  } finally { a.close(); }
});

test('receive: shared barcode 1..5 of 5, sixth is OVER-RECEIVE and not counted', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    for (let i = 1; i <= 5; i++) {
      await a.scan('10012345678902');
      assert.match(a.text('rxResult'), new RegExp('CARTON ' + i + ' OF 5'));
      await wait(5);
    }
    await wait(450); // past the double-delivery guard
    await a.scan('10012345678902');
    assert.match(a.text('rxResult'), /Over-receive.*NOT COUNTED/);
    assert.match(a.cls('rxResult'), /dupe/);
    assert.match(a.text('rxCtx'), /5 \/ 12/);
    assert.equal(Number(await scalar(env.db, "select count(*) from iq2.movements where kind='receive'")), 5);
  } finally { a.close(); }
});

test('receive: unknown pallet, unknown carton, wrong pallet, duplicate unique carton', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive');
    await a.scan('PLT-DOES-NOT-EXIST');
    assert.match(a.text('rxResult'), /Unknown pallet.*NOTHING RECEIVED/);
    assert.equal(a.text('rxPrompt'), 'SCAN PALLET');
    await a.scan('PLT-0001');
    await a.scan('RANDOM-BARCODE-1');
    assert.match(a.text('rxResult'), /Unknown carton.*NOT RECEIVED/);
    assert.match(a.cls('rxResult'), /error/);
    await a.scan('40012345678903');
    assert.match(a.text('rxResult'), /Wrong pallet.*PLT-0002/);
    await a.scan('00012345600000000011');
    await wait(450);
    await a.scan('00012345600000000011');
    assert.match(a.text('rxResult'), /Already received.*NOT COUNTED/);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.skus')), 9);
  } finally { a.close(); }
});

test('receive: another pallet label switches pallets; closed pallet is refused', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    await a.scan('PLT-0003');
    assert.match(a.text('rxCtx'), /PLT-0003.*0 \/ 8/);
    await a.w.iq2FinishPallet(true);
    assert.match(a.text('rxResult'), /Closed short/);
    assert.equal(a.text('rxPrompt'), 'SCAN PALLET');
    await a.scan('PLT-0003');
    assert.match(a.text('rxResult'), /Pallet already received \/ closed/);
  } finally { a.close(); }
});

test('finish pallet: shortages shown, keep receiving or close short; never reported as full', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0003');
    for (let i = 0; i < 6; i++) { await a.scan('50012345678900'); await wait(5); }
    await a.scan('60012345678907');
    await a.w.iq2FinishPallet(false);
    const r = a.text('rxResult');
    assert.match(r, /Pallet is short.*1 CARTONS MISSING.*7 of 8 cartons received/);
    assert.match(r, /HOODIE-L-BLK.*1\/2/);
    assert.equal(await scalar(env.db, "select status from iq2.pallets where pallet_code='PLT-0003'"), 'receiving');
    a.w.iq2KeepReceiving();
    assert.equal(a.text('rxPrompt'), 'SCAN CARTON');
    await a.w.iq2FinishPallet(false);
    await a.w.iq2FinishPallet(true);
    assert.match(a.text('rxResult'), /Closed short.*7 of 8 cartons.*Shortages recorded/);
    assert.equal(Number(await scalar(env.db, "select count(*) from iq2.exceptions where kind='short_on_close'")), 1);
  } finally { a.close(); }
});

test('refresh/restart mid-pallet resumes from the database, not browser memory', async () => {
  const env = await setup();
  const storage = STORE();
  const a = boot({ ...env, storage });
  await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
  await a.scan('10012345678902'); await wait(450); await a.scan('10012345678902');
  a.close();
  // another device receives one more meanwhile
  const pid = await scalar(env.db, "select id from iq2.pallets where pallet_code='PLT-0001'");
  await env.rpc('iq2_receive_carton', { p_warehouse: 'MAIN', p_pallet_id: pid, p_code: '30012345678906', p_idem: 'other-device-0001' });
  const b = boot({ ...env, storage });
  try {
    await b.ready();
    assert.ok(b.on('scReceive'));
    assert.match(b.text('rxResult'), /Pallet resumed.*3 \/ 12/);
    await b.scan('10012345678902');
    assert.match(b.text('rxResult'), /CARTON 3 OF 5.*PALLET 4 OF 12/);
  } finally { b.close(); }
});

test('restart while offline keeps the remembered pallet for the next start', async () => {
  const env = await setup();
  const storage = STORE();
  const a = boot({ ...env, storage });
  await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0002'); a.close();
  const b = boot({ ...env, storage });
  b.net.mode = 'offline';
  await b.ready(); b.close();
  assert.equal(JSON.parse(storage.iq2_state).pallet, 'PLT-0002');
  const c = boot({ ...env, storage });
  try { await c.ready(); assert.match(c.text('rxCtx'), /PLT-0002/); } finally { c.close(); }
});

// ── transport failures ─────────────────────────────────────────────────
test('offline: NO CONNECTION · NOTHING RECORDED, and nothing is recorded', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    Object.defineProperty(a.w.navigator, 'onLine', { configurable: true, get: () => false });
    const before = a.net.calls.length;
    await a.scan('10012345678902');
    assert.match(a.text('rxResult'), /No connection.*NOTHING RECORDED/);
    assert.equal(a.net.calls.length, before);            // nothing was even sent
    assert.doesNotMatch(a.text('rxResult'), /Received/);
    assert.match(a.text('rxCtx'), /0 \/ 12/);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 0);
  } finally { a.close(); }
});

test('connection drops mid-request: NOT CONFIRMED, no success shown', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    a.net.mode = 'offline';
    await a.scan('10012345678902');
    assert.match(a.text('rxResult'), /No confirmation.*NOT CONFIRMED.*never be counted twice/);
    assert.doesNotMatch(a.text('rxResult'), /Received/);
    assert.match(a.text('rxCtx'), /0 \/ 12/);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 0);
  } finally { a.close(); }
});

test('server error: no success shown, nothing counted', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    a.net.mode = 'server500';
    await a.scan('10012345678902');
    assert.match(a.text('rxResult'), /NOT CONFIRMED/);
    assert.doesNotMatch(a.text('rxResult'), /Received ✓/);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 0);
  } finally { a.close(); }
});

test('response lost after the server committed: retry is safe and counts once', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0001');
    a.net.mode = 'lost';
    await a.scan('10012345678902');
    assert.match(a.text('rxResult'), /NOT CONFIRMED/);
    a.net.mode = 'ok';
    await wait(450);
    await a.scan('10012345678902');     // worker scans the same carton again
    assert.match(a.text('rxResult'), /Received ✓ \(confirmed\).*CARTON 1 OF 5/);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 1);
    await wait(450);
    await a.scan('10012345678902');     // the next physical carton counts normally
    assert.match(a.text('rxResult'), /CARTON 2 OF 5/);
  } finally { a.close(); }
});

// ── putaway ────────────────────────────────────────────────────────────
async function receiveSome(env, pallet, codes) {
  const pid = await scalar(env.db, 'select id from iq2.pallets where pallet_code=$1', [pallet]);
  let i = 0;
  for (const c of codes) await env.rpc('iq2_receive_carton', { p_warehouse: 'MAIN', p_pallet_id: pid, p_code: c, p_idem: 'seed-' + pallet + '-' + (i++) });
}

test('putaway: SCAN CARTON → product + QTY → SCAN LOCATION → 100 × WALLET-BLK → B-4 → next carton', async () => {
  const env = await setup();
  await receiveSome(env, 'PLT-0001', ['00012345600000000011', '10012345678902', '10012345678902']);
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('putaway');
    assert.ok(!a.w.document.getElementById('paInner').classList.contains('flipped'));
    await a.scan('00012345600000000011');
    assert.ok(a.w.document.getElementById('paInner').classList.contains('flipped'));
    assert.equal(a.text('paDesc'), "Men's Wallet, Black Leather");
    assert.equal(a.text('paSku'), 'WALLET-BLK');
    assert.equal(a.text('paQty'), 'QTY 100');
    await a.scan('LOC:B-4');
    const r = a.text('paResult');
    assert.match(r, /Putaway complete ✓/);
    assert.match(r, /100 × WALLET-BLK\s*→ B-4/);
    assert.match(r, /B-4 NOW: 100/);
    assert.ok(!a.w.document.getElementById('paInner').classList.contains('flipped'));
    // two phone-case cartons into the same place accumulate
    await a.scan('10012345678902'); await a.scan('LOC:A-5-1');
    assert.match(a.text('paResult'), /40 × CASE-IP15-CLR\s*→ A-5-1.*A-5-1 NOW: 40.*1 more carton/);
    await wait(450);
    await a.scan('10012345678902'); await a.scan('LOC:A-5-1');
    assert.match(a.text('paResult'), /A-5-1 NOW: 80/);
    const audit = await env.rpc('iq2_admin_audit', { p_key: 'test-admin-key-123', p_warehouse: 'MAIN' });
    assert.equal(audit.balanced, true);
  } finally { a.close(); }
});

test('putaway: invalid/disabled location keeps the carton in hand; nothing moves', async () => {
  const env = await setup();
  await receiveSome(env, 'PLT-0001', ['00012345600000000011']);
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('putaway');
    await a.scan('00012345600000000011');
    await a.scan('LOC:NOWHERE');
    assert.match(a.text('paResult'), /Invalid location.*NOTHING MOVED.*Still holding WALLET-BLK/);
    await a.scan('LOC:C-1');
    assert.match(a.text('paResult'), /Location disabled/);
    assert.ok(a.w.document.getElementById('paInner').classList.contains('flipped'));
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.inventory')), 0);
    await a.scan('LOC:B-5');
    assert.match(a.text('paResult'), /B-5 NOW: 100/);
  } finally { a.close(); }
});

test('putaway: scanning another carton while holding one switches cartons, nothing moves', async () => {
  const env = await setup();
  await receiveSome(env, 'PLT-0001', ['00012345600000000011', '00012345600000000028']);
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('putaway');
    await a.scan('00012345600000000011');
    await a.scan('00012345600000000028');
    assert.match(a.text('paResult'), /Carton changed.*NOTHING MOVED/);
    assert.equal(a.text('paSku'), 'WALLET-BRN');
    await a.scan('00012345600000000028');
    assert.match(a.text('paResult'), /Same carton/);
    assert.equal(Number(await scalar(env.db, "select count(*) from iq2.movements where kind='putaway'")), 0);
  } finally { a.close(); }
});

test('putaway: not-received / already-put-away cartons and location lookups are explicit', async () => {
  const env = await setup();
  await receiveSome(env, 'PLT-0001', ['00012345600000000011']);
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('putaway');
    await a.scan('00012345600000000028');
    assert.match(a.text('paResult'), /Not received yet.*NOTHING MOVED/);
    await a.scan('00012345600000000011'); await a.scan('B-4');
    await wait(450);
    await a.scan('00012345600000000011');
    assert.match(a.text('paResult'), /Already put away/);
    await a.scan('LOC:B-4');
    assert.match(a.text('paResult'), /B-4.*100 units stored.*WALLET-BLK/);
  } finally { a.close(); }
});

test('putaway: restart with a carton in hand restores it', async () => {
  const env = await setup();
  await receiveSome(env, 'PLT-0003', ['50012345678900']);
  const storage = STORE();
  const a = boot({ ...env, storage });
  await a.ready(); a.w.iq2Go('putaway'); await a.scan('50012345678900');
  a.close();
  const b = boot({ ...env, storage });
  try {
    await b.ready();
    assert.ok(b.on('scPutaway'));
    assert.equal(b.text('paSku'), 'SOCKS-6PK');
    assert.equal(b.text('paQty'), 'QTY 144');
    await b.scan('LOC:A-5-3');
    assert.match(b.text('paResult'), /144 × SOCKS-6PK\s*→ A-5-3/);
  } finally { b.close(); }
});

// ── TC56 scanner bridge ────────────────────────────────────────────────
test('Zebra/DataWedge scans reach IQ2; one trigger pull delivered twice counts once', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready();
    assert.equal(a.zebra.listeners.length, 1);
    a.w.iq2Go('receive');
    const fire = (v) => a.zebra.listeners[0]({ value: v });
    fire('PLT-0001'); await a.w.iq2Scan('');   // drain queue
    assert.match(a.text('rxCtx'), /PLT-0001/);
    // one trigger pull delivered on two channels (intent + keystroke) counts once
    fire('10012345678902'); a.w.iq2Scan('10012345678902', 'keyboard');
    await a.w.iq2Scan(''); await wait(50);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 1);
    // two real cartons with the same shared barcode, scanned back-to-back, count twice
    fire('10012345678902'); fire('10012345678902');
    await a.w.iq2Scan(''); await wait(50);
    assert.equal(Number(await scalar(env.db, 'select count(*) from iq2.movements')), 3);
    assert.match(a.text('rxResult'), /CARTON 3 OF 5/);
    // keyboard-wedge path also works
    const input = a.w.document.getElementById('iq2Input');
    input.value = '20012345678909';
    input.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Enter' }));
    await a.w.iq2Scan(''); await wait(50);
    assert.match(a.text('rxResult'), /TSHIRT-M-NVY/);
  } finally { a.close(); }
});

test('rapid scans are processed in order, none dropped', async () => {
  const env = await setup();
  const a = boot({ ...env, storage: STORE() });
  try {
    await a.ready(); a.w.iq2Go('receive'); await a.scan('PLT-0002');
    const codes = ['40012345678903', 'IQ2:HU:8841-0007', '10012345678902', '40012345678903'];
    codes.forEach((c) => a.w.iq2Scan(c));
    await a.w.iq2Scan('');
    await wait(50);
    assert.equal(Number(await scalar(env.db, "select count(*) from iq2.movements where kind='receive'")), 4);
    assert.match(a.text('rxCtx'), /4 \/ 7/);
  } finally { a.close(); }
});
