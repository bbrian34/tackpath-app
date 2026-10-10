// Migration 64: the driver gateway (tp_driver) never returns an archived job
// (dispatcher Clear board), not in the list, not by id, and refuses every
// action on it. Real migrations 10, 20, 60, 61 (+64) in PGlite, every call as
// the anon role. Plus the real driver page (driver.html, and the native
// app's www/index.html when it is checked out next to this repo) against
// that gateway: archived while on Waiting for warehouse -> home, and not back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { freshDb, sqlFile, rpc, rpcError, ORG_A, ORG_B } from './fixture.mjs';

const M64 = sqlFile('64_driver_hide_archived.sql');
const R64 = sqlFile('64_driver_hide_archived.rollback.sql');
const BASE = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = [path.join(HERE, '..', '..', 'driver.html'), path.join(HERE, '..', '..', '..', 'tackpath-driver', 'www', 'index.html')].filter((p) => fs.existsSync(p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STOPS = [{ stop_number: 1, address: '1 A St', recipient: 'Ann', tracking_number: 'TN1', packages: 1,
  pkgs: [{ tracking_number: 'TN1', order_id: 'O-1', piece_id: 'TN1', required_count: 1 }] }];

async function setup({ m64 = true } = {}) {
  const db = await freshDb({ migrate: BASE.concat(m64 ? ['64_driver_hide_archived.sql'] : []) });
  const signIn = async (phone) => {
    const issued = await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role');
    return rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: issued.code });
  };
  const dana = await signIn('4045551234');
  const name = dana.driver.name;
  const ins = async (title, { status = 'assigned', driver = name, org = ORG_A, archived = false, type = 'surge' } = {}) => (await db.query(
    `insert into public.jobs (org_id, title, status, job_type, driver_name, surge_stops, archived) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [org, title, status, type, driver, JSON.stringify(STOPS), archived])).rows[0].id;
  const D = (action, args = {}, token = dana.token) => rpc(db, 'tp_driver', { p_token: token, p_action: action, p_args: args });
  const DE = (action, args = {}, token = dana.token) => rpcError(db, 'tp_driver', { p_token: token, p_action: action, p_args: args });
  const orgToken = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const clearBoard = (ids) => rpc(db, 'tp_org', { p_token: orgToken, p_action: 'archive_jobs', p_args: { ids } });
  return { db, dana, name, ins, D, DE, clearBoard, signIn };
}

test('before 64: an archived route is still given to its driver (the bug)', async () => {
  const t = await setup({ m64: false });
  const id = await t.ins('Route A');
  await t.clearBoard([id]);
  assert.equal((await t.D('job', { id })).id, id);
  assert.ok((await t.D('jobs', { statuses: ['assigned'], mine: true })).some((j) => j.id === id));
});

test('64: archived jobs are left out of every list and refused by id; live jobs and other drivers unaffected', async () => {
  const t = await setup();
  const mine = await t.ins('Route A');
  const live = await t.ins('Route B');
  const offer = await t.ins('Offer C', { status: 'pending', driver: null, type: 'sprint' });
  await t.db.query(`insert into public.drivers (name, phone, sms_consent, status, org_id) values ('Sam Second', '4045559999', true, 'active', $1)`, [ORG_A]);
  const sam = await t.signIn('4045559999');
  const samJob = await t.ins('Sam route', { driver: sam.driver.name });
  await t.clearBoard([mine, offer]);
  const ids = (rows) => rows.map((j) => j.id);
  assert.deepEqual(ids(await t.D('jobs', { statuses: ['assigned'], mine: true })), [live]);
  assert.ok(!ids(await t.D('jobs', { statuses: ['routing', 'pending'] })).includes(offer), 'archived offer not offered');
  assert.ok(!ids(await t.D('jobs', {})).includes(mine));
  for (const [action, args] of [['job', { id: mine }], ['claim', { id: offer }], ['update_job', { id: mine, patch: { status: 'in_transit' } }],
    ['messages', { job_id: mine }], ['post_message', { job_id: mine, body: 'hi' }], ['bin_binding', { job_id: mine }]]) {
    assert.equal(await t.DE(action, args), 'TP_DENIED: this route was removed by dispatch', action);
  }
  assert.deepEqual(await t.D('location', { job_id: mine, lat: 33.7, lng: -84.4 }), { ok: false });
  assert.equal((await t.db.query('select count(*)::int n from public.driver_locations')).rows[0].n, 0, 'nothing stored');
  assert.equal((await t.db.query('select status from public.jobs where id = $1', [mine])).rows[0].status, 'assigned', 'refused update changed nothing');
  // live route: everything as before
  assert.equal((await t.D('job', { id: live })).id, live);
  assert.equal((await t.D('update_job', { id: live, patch: { status: 'in_transit' } }))[0].status, 'in_transit');
  assert.deepEqual(await t.D('location', { job_id: live, lat: 33.7, lng: -84.4 }), { ok: true });
  // another driver: their live route still theirs; ours never visible to them
  assert.equal((await t.D('job', { id: samJob }, sam.token)).id, samJob);
  assert.match(await t.DE('job', { id: live }, sam.token), /TP_DENIED/);
  await t.clearBoard([samJob]);
  assert.equal((await t.D('job', { id: live })).id, live, "another driver's Clear board does not touch ours");
  // actions that name no job pass through unchanged
  assert.equal((await t.D('me')).name, t.name);
  assert.match(await t.DE('job', { id: mine }, 'not-a-token'), /TP_AUTH/);
});

test('64: the list limit counts only routes still on the board', async () => {
  const t = await setup();
  for (let i = 0; i < 12; i++) await t.clearBoard([await t.ins('Old ' + i, { status: 'pending', driver: null, type: 'sprint' })]);
  const fresh = await t.ins('New offer', { status: 'pending', driver: null, type: 'sprint' });
  const rows = await t.D('jobs', { statuses: ['routing', 'pending'], limit: 10 });
  assert.deepEqual(rows.map((j) => j.id), [fresh]);
});

test('64 refuses to run twice or without 10; the rollback restores migration 10 and the grants', async () => {
  const db = await freshDb({ migrate: BASE });
  const q1 = async (sql) => (await db.query(sql)).rows[0];
  const grants = () => q1(`select proacl::text a, prosecdef s from pg_proc where oid = 'public.tp_driver(text,text,jsonb)'::regprocedure`);
  const src = () => q1(`select prosrc from pg_proc where oid = 'public.tp_driver(text,text,jsonb)'::regprocedure`);
  const publicFns = () => q1(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  const g10 = await grants(), s10 = await src(), n10 = await publicFns();
  await db.exec(M64);
  assert.deepEqual(await grants(), g10, 'same grants, SECURITY DEFINER');
  assert.deepEqual(await publicFns(), n10, 'no new public function');
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, 'tp_sec.tp_driver_v10(text,text,jsonb)', 'execute') ok`, [role])).rows[0].ok, false);
  }
  await assert.rejects(db.exec(M64), /already applied/); await db.exec('rollback');
  await db.exec(R64);
  assert.deepEqual(await src(), s10, "migration 10's gateway is back");
  assert.deepEqual(await grants(), g10);
  assert.deepEqual(await publicFns(), n10);
  await assert.rejects(db.exec(R64), /not in place/); await db.exec('rollback');
  await db.exec(M64);
  const bare = await freshDb();
  await assert.rejects(bare.exec(M64), /Apply 10_sessions_and_rpcs\.sql first/); await bare.exec('rollback');
});

// ── the real driver page against the real gateway ──
function openPage(file, db, storage) {
  const toasts = [];
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], speaking: false, pending: false };
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} } });
      w.fetch = async (url, o) => {
        const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (!m) return json(200, []);
        try { return json(200, await rpc(db, m[1], JSON.parse((o && o.body) || '{}'), 'anon')); }
        catch (e) { return json(400, { message: e.message }); }
      };
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
    },
  });
  const w = dom.window;
  const orig = w.toast; w.toast = function (m) { toasts.push(String(m)); return orig.apply(this, arguments); };
  return { w, toasts, screen: () => (w.document.querySelector('.screen.on') || {}).id, current: () => w.eval('currentJob&&currentJob.id'), close: () => w.close() };
}

for (const file of PAGES) {
  for (const m64 of [true, false]) {
    test(`${path.basename(path.dirname(file)) === 'www' ? 'native app' : 'web app'} against the real gateway ${m64 ? 'with' : 'without'} 64: Clear board while on Waiting for warehouse -> home; reopen -> not back`, async () => {
      const t = await setup({ m64 });
      const id = await t.ins('Route A');
      const row = (await t.D('job', { id }));
      const storage = {
        tp_drv: JSON.stringify({ id: t.dana.driver.id, name: t.name, phone: '4045551234', token: t.dana.token }),
        tp_route_state: JSON.stringify({ currentJob: row, surgeStops: STOPS, currentSurgeStop: 0, isSurgeJob: true, screenContext: 'accepted', savedAt: Date.now() }),
      };
      const a = openPage(file, t.db, storage);
      try {
        await wait(400);
        assert.equal(a.screen(), 'scRouteAccepted');
        assert.equal(a.current(), id);
        await a.w.eval('tpGone.check()'); await wait(100);
        assert.equal(a.current(), id, 'a live route stays');
        await t.clearBoard([id]);
        await a.w.eval('tpGone.check()'); await wait(100);
        assert.equal(a.screen(), 'scHome');
        assert.equal(a.current(), null);
        assert.ok(a.toasts.includes('This route was removed by dispatch.'), a.toasts.join(' | '));
        assert.equal(storage.tp_route_state, undefined);
        await a.w.eval('pollJobs()'); await wait(150);
        assert.notEqual(a.current(), id, 'not adopted again');
      } finally { a.close(); }
      // the driver's next live route (not archived) is still given out normally
      const other = await t.ins('Route B');
      const b = openPage(file, t.db, storage);
      try {
        await wait(400);
        await b.w.eval('pollJobs()'); await wait(200);
        assert.notEqual(b.current(), id);
        assert.notEqual(b.screen(), 'scRouteAccepted');
        assert.notEqual(b.w.eval('pendingJob&&pendingJob.id'), id, 'not offered');
        assert.ok([b.current(), b.w.eval('pendingJob&&pendingJob.id')].includes(other), 'the live route is given out (adopted or offered)');
      } finally { b.close(); }
    });
  }
}
