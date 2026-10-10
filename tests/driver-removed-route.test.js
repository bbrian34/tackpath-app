const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Removed routes (2026-10), the TP-GONE block: identical in tackpath-driver
// www/index.html (native app) and tackpath-app driver.html (web). The same
// file runs in both repos; APP_HTML is the page under test, SIBLING_HTML the
// other repo's copy for the drift check. The backend is a stand-in for
// tp_driver that keeps a jobs table (status, driver, archived) and answers
// either like migration 10 (archived jobs still returned) or like migration
// 64 (archived jobs left out of lists and refused by id).
// Dispatch's Clear board archives a job and leaves its status: the app must
// leave the Waiting for warehouse screen, forget the route, and never bring
// it back, from the server or from the phone.

const ROOT = path.join(__dirname, '..');
const NATIVE = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const SIBLING = process.env.SIBLING_HTML || (NATIVE ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (s) => (s.match(/<!-- TP-GONE:BEGIN[\s\S]*?<!-- TP-GONE:END -->/) || [''])[0];

const STOPS = [{ order_id: 'O-1', tracking_number: 'TN1', recipient: 'Ann', address: '1 A St', packages: 1,
  pkgs: [{ order_id: 'O-1', tracking_number: 'TN1', piece_id: 'TN1', required_count: 1 }] }];
const job = (id, extra) => Object.assign({ id, title: 'Route ' + id, job_type: 'surge', status: 'assigned', driver_name: 'Dana',
  archived: false, surge_stops: STOPS, total_stops: 1, total_packages: 1, created_at: new Date().toISOString() }, extra || {});

function server(jobs, { m64 = false } = {}) {
  return { jobs, m64, online: true, calls: [] };
}

function boot(srv, { storage = {}, routeState } = {}) {
  storage.tp_drv = storage.tp_drv || JSON.stringify({ id: 'drv-1', name: 'Dana', phone: '4045551234', token: 'tok' });
  if (routeState) storage.tp_route_state = JSON.stringify(Object.assign({ surgeStops: STOPS, currentSurgeStop: 0, isSurgeJob: true,
    screenContext: 'accepted', savedAt: Date.now() }, routeState));
  const toasts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], speaking: false, pending: false };
      w.confirm = () => true;
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} } });
      const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      const deny = (m) => json(400, { message: 'TP_DENIED: ' + m });
      w.fetch = async (url, o) => {
        url = String(url);
        if (!srv.online) throw new TypeError('Failed to fetch');
        const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (!m) return json(200, []);
        const body = o && o.body ? JSON.parse(o.body) : {};
        const a = body.p_args || {};
        srv.calls.push(body.p_action);
        const sees = (j) => j.driver_name === 'Dana' || (['routing', 'pending'].includes(j.status) && !j.driver_name);
        const byId = (id) => srv.jobs.find((j) => j.id === id);
        switch (body.p_action) {
          case 'me': return json(200, { name: 'Dana', dispatch_phone: '4045550100' });
          case 'jobs': return json(200, srv.jobs.filter((j) => sees(j) && !(srv.m64 && j.archived)
            && (!a.statuses || a.statuses.includes(j.status)) && (!a.mine || j.driver_name === 'Dana')
            && (!a.job_type || (a.job_type === 'not_surge' ? j.job_type !== 'surge' : j.job_type === a.job_type))));
          case 'job': case 'bin_binding': case 'claim': case 'update_job': case 'messages': {
            const j = byId(a.id || a.job_id);
            if (!j || !sees(j)) return deny('this job is not available to you');
            if (srv.m64 && j.archived) return deny('this route was removed by dispatch');
            if (body.p_action === 'job') return json(200, j);
            if (body.p_action === 'bin_binding') return json(200, []);
            if (body.p_action === 'messages') return json(200, []);
            return json(200, [j]);
          }
          default: return json(200, { ok: true });
        }
      };
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
    },
  });
  const w = dom.window;
  const realToast = w.toast;
  w.toast = function (msg, type) { toasts.push(String(msg)); return realToast.apply(this, arguments); };
  const $ = (id) => w.document.getElementById(id);
  return {
    w, storage, toasts, $,
    screen: () => (w.document.querySelector('.screen.on') || {}).id,
    current: () => w.eval('currentJob&&currentJob.id'),
    close: () => w.close(),
  };
}
const settle = () => wait(150);

test('the TP-GONE block is the same in the native app and the web app, and loads once', () => {
  assert.ok(block(HTML).length > 1000, 'TP-GONE block present');
  assert.strictEqual((HTML.match(/<!-- TP-GONE:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

for (const m64 of [false, true]) {
  const label = m64 ? 'server with migration 64' : 'server before migration 64';
  test(`archived while on Waiting for warehouse: home, "This route was removed by dispatch.", nothing kept (${label})`, async () => {
    const srv = server([job('job-1')], { m64 });
    const storage = {};
    const a = boot(srv, { storage, routeState: { currentJob: job('job-1') } });
    try {
      await settle();
      assert.strictEqual(a.screen(), 'scRouteAccepted', 'restored on Waiting for warehouse');
      assert.strictEqual(a.current(), 'job-1');
      storage.tp_dx_route = JSON.stringify({ job: 'job-1', outcomes: {}, startedAt: Date.now() });   // saved scans
      srv.jobs[0].archived = true;                        // dispatcher: Clear board
      await wait(5300);                                   // the next poll
      assert.strictEqual(a.screen(), 'scHome');
      assert.strictEqual(a.current(), null);
      assert.ok(a.toasts.includes('This route was removed by dispatch.'), a.toasts.join(' | '));
      assert.strictEqual(storage.tp_route_state, undefined, 'saved route cleared');
      assert.ok(!storage.tp_dx_route || !storage.tp_dx_route.includes('job-1'), 'saved scans cleared');
      assert.deepEqual(JSON.parse(storage.tp_removed_jobs), ['job-1']);
      // nothing re-saves it, and the next polls keep the driver home
      a.w.eval("currentJob={id:'job-1',status:'assigned'};saveRouteState('accepted');currentJob=null;");
      assert.strictEqual(storage.tp_route_state, undefined);
      await a.w.eval('pollJobs()'); await settle();
      assert.strictEqual(a.screen(), 'scHome');
      assert.strictEqual(a.current(), null);
    } finally { a.close(); }

    // reopen the app: the route does not come back (from the phone or the server)
    const b = boot(srv, { storage });
    try {
      await settle();
      await b.w.eval('pollJobs()'); await settle();
      assert.notStrictEqual(b.screen(), 'scRouteAccepted');
      assert.notStrictEqual(b.screen(), 'scOffer', 'not offered again');
      assert.strictEqual(b.current(), null);
    } finally { b.close(); }

    // even if an old saved route is still on the phone (e.g. written before the update)
    storage.tp_route_state = JSON.stringify({ currentJob: job('job-1'), surgeStops: STOPS, isSurgeJob: true, savedAt: Date.now() });
    const c = boot(srv, { storage });
    try {
      await settle();
      assert.strictEqual(c.screen(), 'scHome');
      assert.strictEqual(c.current(), null);
      assert.strictEqual(storage.tp_route_state, undefined);
    } finally { c.close(); }
  });
}

test('reopening the app after Clear board, before the phone had noticed: forgotten on open', async () => {
  const srv = server([job('job-1', { archived: true })]);
  const storage = {};
  const a = boot(srv, { storage, routeState: { currentJob: job('job-1', { archived: false }) } });
  try {
    await settle();
    assert.strictEqual(a.screen(), 'scHome');
    assert.strictEqual(a.current(), null);
    assert.ok(a.toasts.includes('This route was removed by dispatch.'));
    await a.w.eval('pollJobs()'); await settle();
    assert.strictEqual(a.current(), null, 'not adopted again from the server list');
    assert.notStrictEqual(a.screen(), 'scOffer');
  } finally { a.close(); }
});

test('deleted (server returns nothing) and cancelled routes are cleared the same way', async () => {
  const srv = server([]);
  const a = boot(srv, { routeState: { currentJob: job('job-gone') } });
  try {
    await settle();
    assert.strictEqual(a.screen(), 'scHome');
    assert.ok(a.toasts.includes('This route was removed by dispatch.'));
  } finally { a.close(); }
  const srv2 = server([job('job-2', { status: 'cancelled' })]);
  const b = boot(srv2, { routeState: { currentJob: job('job-2') } });
  try {
    await settle();
    assert.strictEqual(b.screen(), 'scHome');
    assert.strictEqual(b.current(), null);
    assert.ok(b.toasts.includes('This route was cancelled by dispatch.'), b.toasts.join(' | '));
  } finally { b.close(); }
});

test("a live route is unaffected, another driver's archived route changes nothing, no signal changes nothing", async () => {
  const srv = server([job('job-1'), job('job-9', { driver_name: 'Sam' })]);
  const storage = {};
  const a = boot(srv, { storage, routeState: { currentJob: job('job-1') } });
  try {
    await settle();
    srv.jobs[1].archived = true;                          // someone else's route is cleared
    for (let i = 0; i < 3; i++) { await a.w.eval('tpGone.check()'); await a.w.eval('pollJobs()'); await settle(); }
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    assert.strictEqual(a.current(), 'job-1');
    assert.ok(storage.tp_route_state.includes('job-1'), 'saved route kept');
    assert.ok(!a.toasts.some((t) => /removed|cancelled/.test(t)));
    srv.jobs[0].archived = true;                          // now ours, but the phone has no signal
    srv.online = false;
    await a.w.eval('tpGone.check()'); await settle();
    assert.strictEqual(a.current(), 'job-1', 'no signal: kept, asked again later');
    srv.online = true;
    await a.w.eval('tpGone.check()'); await settle();
    assert.strictEqual(a.current(), null);
    assert.strictEqual(a.screen(), 'scHome');
  } finally { a.close(); }
});

test('a route the server gives out again un-archived is a new assignment again', async () => {
  const srv = server([job('job-1')], { m64: true });
  const storage = { tp_removed_jobs: JSON.stringify(['job-1']) };
  const a = boot(srv, { storage });
  try {
    await settle();
    // web app: it is offered like any route; native app: it is adopted
    srv.jobs[0].status = 'pending'; srv.jobs[0].driver_name = null; srv.jobs[0].job_type = 'sprint';
    await a.w.eval('pollJobs()'); await settle();
    assert.strictEqual(a.screen(), 'scOffer');
    assert.ok(!JSON.parse(storage.tp_removed_jobs || '[]').includes('job-1'));
  } finally { a.close(); }
});
