const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// "READY FOR PICKUP" ONLY AFTER STAGING (2026-10, v23). Wording and display
// only. While the route's bin binding has no staging spot (staging_code
// null) nothing the driver sees or hears says the route is ready for pickup:
// the status line says "Waiting for the warehouse to stage your route".
// Once staged (Refresh or the regular warehouse check): "Ready for pickup"
// with the STG spot and the Bin, as before, and the ready announcement.
// No bin binding: unchanged. The v22 BIN scan gate is unchanged. Same
// harness as bin-scan-staging.test.js; the same file runs in both repos.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 2 stops, 12 packages (stop 1: 7, stop 2: 5), real coordinates.
const PK = (n) => ({ order_id: 'O' + n, tracking_number: 'TN' + String(n).padStart(4, '0'), piece_id: 'TN' + String(n).padStart(4, '0'), required_count: 1 });
const STOPS = [
  { order_id: 'O1', tracking_number: 'TN0001', recipient: 'Test A', address: '260 Manning Rd SW', packages: 7, stop_number: 1,
    coords: { lat: 33.7301, lng: -84.4102 }, pkgs: [1, 2, 3, 4, 5, 6, 7].map(PK) },
  { order_id: 'O8', tracking_number: 'TN0008', recipient: 'Test B', address: '1 Peachtree St NE', packages: 5, stop_number: 2,
    coords: { lat: 33.7550, lng: -84.3900 }, pkgs: [8, 9, 10, 11, 12].map(PK) },
];
const ALL = STOPS.flatMap((s) => s.pkgs.map((p) => p.tracking_number));
const ROUTE = (extra) => Object.assign({ id: 'job-12', title: 'Route 12', job_type: 'surge', status: 'pending', driver_name: null,
  archived: false, surge_stops: STOPS, total_stops: 2, total_packages: 12, bin_label: null, created_at: new Date().toISOString() }, extra || {});

function server(jobs) {
  return { jobs: jobs || [], messages: [], updates: [], binding: null, online: true, overlay: true, location: true, calls: [] };
}

// Boot the real page. routeState: what the phone saved before (app reopened).
function boot(srv, { storage = {}, signedIn = true, routeState } = {}) {
  if (signedIn) storage.tp_drv = storage.tp_drv || JSON.stringify({ id: 'drv-1', name: 'Dana', phone: '4045551234', token: 'tok' });
  if (routeState) storage.tp_route_state = JSON.stringify(Object.assign({ surgeStops: STOPS, currentSurgeStop: 0, isSurgeJob: true,
    screenContext: 'list', savedAt: Date.now() }, routeState));
  const nat = [];          // native calls, in order
  const toasts = [];
  let hidden = false;
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], speaking: false, pending: false };
      w.confirm = () => true;
      w.open = (url) => { nat.push(['window.open', String(url)]); return null; };
      Object.defineProperty(w.navigator, 'vibrate', { configurable: true, value: () => true });
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: {
        watchPosition: () => 1, clearWatch() {},
        getCurrentPosition: (ok) => { nat.push(['geolocation.prompt']); srv.location = true; setTimeout(() => ok({ coords: { latitude: 33.7, longitude: -84.4, accuracy: 10 } }), 0); } } });
      Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      if (NATIVE) {
        w.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: {
          ArrivalPlugin: {
            start: async (o) => { if (!srv.location) { nat.push(['ArrivalPlugin.start-refused']); throw new Error('location permission not granted'); } await wait(20); nat.push(['ArrivalPlugin.start', o]); },
            stop: async () => { nat.push(['ArrivalPlugin.stop']); },
            overlayStatus: async () => { nat.push(['ArrivalPlugin.overlayStatus']); return { granted: srv.overlay }; },
            openOverlaySettings: async () => { nat.push(['ArrivalPlugin.openOverlaySettings']); },
          },
          AppLauncher: { openUrl: async (o) => { nat.push(['AppLauncher.openUrl', o.url]); return { completed: true }; } },
          LocalNotifications: {
            requestPermissions: async () => ({ display: 'granted' }), createChannel: async () => {},
            registerActionTypes: async (o) => { nat.push(['LocalNotifications.registerActionTypes', o]); },
            addListener: () => ({ remove() {} }),
            schedule: async (o) => { nat.push(['LocalNotifications.schedule', o]); },
            cancel: async () => { nat.push(['LocalNotifications.cancel']); },
          },
        } };
      }
      const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      w.fetch = async (url, o) => {
        url = String(url);
        if (!srv.online) throw new TypeError('Failed to fetch');
        const body = o && o.body ? JSON.parse(o.body) : {};
        if (url.endsWith('/functions/v1/driver-login')) return json(200, { ok: true });
        if (url.endsWith('/functions/v1/pod')) return json(200, { path: body.job_id + '/p.jpg' });
        const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (!m) return json(200, []);
        if (m[1] === 'tp_driver_sign_in') return json(200, body.p_code === '111111' ? { ok: true, token: 'tok', driver: { id: 'drv-1', name: 'Dana', phone: '4045551234' } } : { ok: false });
        const a = body.p_args || {};
        srv.calls.push(body.p_action);
        const deny = () => json(400, { message: 'TP_DENIED: this job is not available to you' });
        const sees = (j) => !j.archived && (j.driver_name === 'Dana' || (['routing', 'pending'].includes(j.status) && !j.driver_name));
        const byId = (id) => srv.jobs.find((j) => j.id === id);
        switch (body.p_action) {
          case 'me': return json(200, { name: 'Dana', dispatch_phone: '4045550100' });
          case 'jobs': return json(200, srv.jobs.filter((j) => sees(j) && (!a.statuses || a.statuses.includes(j.status))
            && (!a.mine || j.driver_name === 'Dana')
            && (!a.job_type || (a.job_type === 'not_surge' ? j.job_type !== 'surge' : j.job_type === a.job_type))));
          case 'job': { const j = byId(a.id); return j && sees(j) ? json(200, j) : deny(); }
          case 'claim': { const j = byId(a.id); if (!j || j.status !== 'pending' || j.driver_name) return json(200, []); j.status = 'assigned'; j.driver_name = 'Dana'; return json(200, [j]); }
          case 'update_job': { const j = byId(a.id); if (!j || !sees(j)) return deny(); Object.assign(j, a.patch || {}); srv.updates.push(a.patch); return json(200, [j]); }
          case 'messages': return json(200, srv.messages.filter((x) => x.job_id === a.job_id));
          case 'post_message': { const r = { id: srv.messages.length + 1, job_id: a.job_id, body: a.body, sender_role: 'driver', created_at: new Date().toISOString() }; srv.messages.push(r); return json(200, r); }
          case 'bin_binding': return json(200, srv.binding ? [srv.binding] : []);
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
  w.eval('startCamera=function(){};stopCamera=function(){};initSig=function(){};');
  const realToast = w.toast;
  w.toast = function (m) { toasts.push(String(m)); return realToast.apply(this, arguments); };
  const $ = (id) => w.document.getElementById(id);
  const text = () => w.document.body.textContent.replace(/\s+/g, ' ');
  // inline display only: the app repo's jsdom cannot compute every font-size
  const visible = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.style.display === 'none' || n.hidden) return false; return !!el; };
  return {
    w, srv, storage, nat, toasts, $, text, visible,
    screen: () => (w.document.querySelector('.screen.on') || {}).id,
    current: () => w.eval('currentJob&&currentJob.id'),
    // the driver leaves for Google Maps and comes back (Android back button)
    background: () => { hidden = true; w.document.dispatchEvent(new w.Event('visibilitychange')); },
    foreground: () => { hidden = false; w.document.dispatchEvent(new w.Event('visibilitychange')); },
    called: (name) => nat.filter((c) => c[0] === name),
    close: () => w.close(),
  };
}
const settle = (ms = 150) => wait(ms);

// the OK between packages (native: #loadPkgOkBtn; web: the OK button in the result)
const okLoad = (a) => { const ok = a.$('loadPkgOkBtn') || a.$('loadPkgLastScan').querySelector('button'); if (ok) ok.click(); };
const navCalls = (a) => a.nat.filter((c) => c[0] === 'AppLauncher.openUrl' || c[0] === 'ArrivalPlugin.start'
  || (c[0] === 'window.open' && /google\.com\/maps|google\.navigation/.test(c[1])));


const MSG = 'Not staged yet. Wait for the warehouse to stage your route.';
const card = (a) => a.$('dxDayCard').textContent.replace(/\s+/g, ' ');
const gate = (a) => a.$('tpStgGate');
async function scanBin(a) {
  a.w.eval(`processScan(${JSON.stringify(NATIVE ? 'BIN:1' : '1')})`);
  await settle(NATIVE ? 1200 : 2200);
}
// The route reaches the driver and the warehouse marks the bin ready (staged at `spot`, or not).
async function readyForPickup(spot) {
  const srv = server();
  const a = boot(srv);
  try {
    await settle(700);
    srv.jobs = [ROUTE(NATIVE ? { status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { bin_label: '1' })];
    await a.w.eval('pollJobs()'); await settle(300);
    if (!NATIVE) { await a.w.eval('acceptOffer()'); await settle(300); }
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    srv.binding = { bin_code: '1', state: 'ready', staging_code: spot };
    if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
    await settle();
  } catch (e) { a.close(); throw e; }
  return { a, srv };
}
const atPickup = async (a) => { a.$('scRouteAccepted').querySelector('button[onclick^="startBinScan"]').click(); await settle(400); };

async function scanBin(a) {
  a.w.eval(`processScan(${JSON.stringify(NATIVE ? 'BIN:1' : '1')})`);
  await settle(NATIVE ? 1200 : 2200);
}

const WAIT = 'Waiting for the warehouse to stage your route';
const READY = /ready for pickup|route ready|go to your bin/i;
// everything the driver can see or hear: the screen, the toasts, the voice
function sensed(a) {
  const scr = a.$('scRouteAccepted');
  const vis = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.style.display === 'none' || n.hidden) return false; return true; };
  const tw = a.w.document.createTreeWalker(scr, a.w.NodeFilter.SHOW_TEXT), parts = [];
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.textContent.trim() && vis(n.parentElement)) parts.push(n.textContent.trim());
  const screenText = parts.join(' | ');
  return { screen: screenText.replace(/\s+/g, ' '), toasts: a.$('tw').textContent, said: a.w._said.join(' | ') };
}
function listen(a) { a.w._said = []; a.w.speechSynthesis.speak = (u) => { a.w._said.push(String(u && u.text)); }; }
async function poll(a) { if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()'); await settle(300); }
async function routeAccepted() {
  const srv = server();
  const a = boot(srv);
  try {
    await settle(700);
    listen(a);
    srv.jobs = [ROUTE(NATIVE ? { status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { bin_label: '1' })];
    await a.w.eval('pollJobs()'); await settle(300);
    if (!NATIVE) { await a.w.eval('acceptOffer()'); await settle(300); }
    assert.strictEqual(a.screen(), 'scRouteAccepted');
  } catch (e) { a.close(); throw e; }
  return { a, srv };
}

test('a. not staged: nothing says "ready for pickup" (screen, toasts, voice); the waiting line shows in the status place', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = { bin_code: '1', state: 'ready', staging_code: null };
    await poll(a); await poll(a);
    const s = sensed(a);
    assert.ok(!READY.test(s.screen), 'screen: ' + s.screen);
    assert.ok(!READY.test(s.toasts), 'toasts: ' + s.toasts);
    assert.ok(!READY.test(s.said), 'voice: ' + s.said);
    assert.strictEqual(a.$('dxStage').textContent, WAIT, 'the status line');
    assert.ok(!a.$('dxStage').classList.contains('dx-st-ready'), 'not the green ready style');
    assert.match(s.screen, /Bin 1/, 'the bin still shows');
    assert.match(s.screen, /Not staged yet - check with the warehouse/, 'the v18 pickup note stays');
  } finally { a.close(); }
});

test('b. staged: "Ready for pickup" with the STG spot and the Bin, and the ready announcement', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
    await poll(a);
    const s = sensed(a);
    assert.strictEqual(a.$('dxStage').textContent, 'Ready for pickup');
    assert.ok(a.$('dxStage').classList.contains('dx-st-ready'));
    assert.match(s.screen, /Pickup location: STG S-01 \| Bin 1/);
    if (NATIVE) assert.match(s.toasts + ' ' + s.said, /ready for pickup/i, 'announced');   // (the web app has no ready toast and its voice is off)
  } finally { a.close(); }
});

test('c. no bin binding: the wording is unchanged (Waiting for warehouse)', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = null;
    await poll(a);
    assert.strictEqual(a.$('dxStage').textContent, 'Waiting for warehouse');
    assert.ok(a.$('dxStage').classList.contains('dx-st-waiting'));
    assert.ok(!READY.test(sensed(a).screen));
    // and a bin still being stowed (open): unchanged too
    srv.binding = { bin_code: '1', state: 'open', staging_code: null };
    await poll(a);
    assert.strictEqual(a.$('dxStage').textContent, 'Staging in progress');
  } finally { a.close(); }
});

test('d. Refresh switches waiting to ready (and the ready announcement comes then, once)', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = { bin_code: '1', state: 'ready', staging_code: null };
    await poll(a);
    assert.strictEqual(a.$('dxStage').textContent, WAIT);
    a.$('scRouteAccepted').querySelector('button[onclick^="startBinScan"]').click(); await settle(400);   // v22: held, Refresh shows
    assert.ok(a.$('tpStgRefresh'));
    srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-02' };
    a.$('tpStgRefresh').click(); await settle(400);
    const s = sensed(a);
    assert.strictEqual(a.$('dxStage').textContent, 'Ready for pickup');
    assert.match(s.screen, /Pickup location: STG S-02 \| Bin 1/);
    if (NATIVE) assert.match(s.toasts + ' ' + s.said, /ready for pickup/i, 'announced once staged');
    const n = (s.toasts.match(/ready for pickup/gi) || []).length + (s.said.match(/ready for pickup/gi) || []).length;
    await poll(a); await poll(a);
    const s2 = sensed(a);
    assert.strictEqual((s2.toasts.match(/ready for pickup/gi) || []).length + (s2.said.match(/ready for pickup/gi) || []).length, n, 'not repeated by later checks');
  } finally { a.close(); }
});

test('d2. the regular warehouse check switches waiting to ready by itself', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = { bin_code: '1', state: 'ready', staging_code: null };
    await poll(a);
    assert.strictEqual(a.$('dxStage').textContent, WAIT);
    srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-03' };
    await poll(a);
    assert.strictEqual(a.$('dxStage').textContent, 'Ready for pickup');
    assert.match(sensed(a).screen, /Pickup location: STG S-03 \| Bin 1/);
  } finally { a.close(); }
});

test('e. the v22 BIN scan gate is unchanged: not staged holds the scan, staged opens it', async () => {
  const { a, srv } = await routeAccepted();
  try {
    srv.binding = { bin_code: '1', state: 'ready', staging_code: null };
    await poll(a);
    const btn = () => a.$('scRouteAccepted').querySelector('button[onclick^="startBinScan"]');
    btn().click(); await settle(400);
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    assert.strictEqual(a.$('tpStgGate').querySelector('.tp-stg-gate-msg').textContent, 'Not staged yet. Wait for the warehouse to stage your route.');
    srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
    a.$('tpStgRefresh').click(); await settle(400);
    btn().click(); await settle(400);
    assert.strictEqual(a.screen(), 'scScan');
    await scanBin(a);
    assert.strictEqual(a.screen(), 'scPickup');
  } finally { a.close(); }
});
