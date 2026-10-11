const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// PICKUP LOCATION = STAGING SPOT (2026-10, v18). The driver must see where the
// route is STAGED ("Pickup location: STG S-01", then "Bin 1"), never the LOC
// the PathIQ worker used while stowing (A-01). The stand-in server below
// still sends location_code, as tp_driver did before migration 67, to prove
// the app drops it. Same harness as core-flows.test.js; same file in both repos.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const SIBLING = process.env.SIBLING_HTML || (NATIVE_REPO ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (s) => (s.match(/<!-- TP-STG:BEGIN[\s\S]*?<!-- TP-STG:END -->/) || [''])[0];

// One route, two stops; stop 1 has two different barcodes.
const STOPS = [
  { order_id: '100231', tracking_number: '720431958206', recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 2, stop_number: 1,
    coords: { lat: 33.7301, lng: -84.4102 },
    pkgs: [{ order_id: '100231', tracking_number: '720431958206', piece_id: '720431958206', required_count: 1 },
           { order_id: '100232', tracking_number: '720431958213', piece_id: '720431958213', required_count: 1 }] },
  { order_id: '100233', tracking_number: '720431958220', recipient: 'Test B', address: '1 Peachtree St NE', packages: 1, stop_number: 2,
    coords: { lat: 33.7550, lng: -84.3900 },
    pkgs: [{ order_id: '100233', tracking_number: '720431958220', piece_id: '720431958220', required_count: 1 }] },
];
const ROUTE = (extra) => Object.assign({ id: 'job-1', title: 'Surge Route RT-001', job_type: 'surge', status: 'assigned', driver_name: 'Dana',
  archived: false, surge_stops: STOPS, total_stops: 2, total_packages: 3, bin_label: '2B', created_at: new Date().toISOString() }, extra || {});

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
  const visible = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (w.getComputedStyle(n).display === 'none') return false; return !!el; };
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


const LOC = 'A-01';
// On Waiting for warehouse for the assigned route (app reopened there).
async function waiting(srv) {
  srv.jobs = [ROUTE({ bin_label: '1' })];
  const a = boot(srv, { routeState: { currentJob: ROUTE({ bin_label: '1' }), screenContext: 'accepted' } });
  await settle(700);
  assert.strictEqual(a.screen(), 'scRouteAccepted');
  return a;
}
const refresh = async (a) => { if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()'); await settle(); };
const card = (a) => a.$('dxDayCard');
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// The LOC must not be anywhere in the page: text, markup, hidden elements, or the app's state.
function noLoc(a) {
  const body = a.w.document.body.cloneNode(true);
  body.querySelectorAll('script,style').forEach((e) => e.remove());
  assert.ok(!body.innerHTML.includes(LOC), 'LOC in the DOM');
  assert.ok(!/location_code/.test(a.w.eval('JSON.stringify(dx.state.binding||null)')), 'LOC kept in app state');
  { const t = txt(body), i = t.search(/\bLocation\b(?! is off)/); assert.ok(i < 0, 'no "Location" line: ' + t.slice(Math.max(0, i - 60), i + 40)); }
}
const bindingRow = (staging) => ({ bin_code: '1', location_code: LOC, state: 'ready', staging_code: staging });

test('TP-STG is the same in the native app and the web app, and loads once', () => {
  assert.ok(block(HTML).length > 1000, 'TP-STG block present');
  assert.strictEqual((HTML.match(/<!-- TP-STG:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

test('a. staged route: "Pickup location: STG S-01" in large text, then "Bin 1"; the LOC is nowhere', async () => {
  const srv = server();
  const a = await waiting(srv);
  try {
    srv.binding = bindingRow('S-01');
    await refresh(a);
    const box = card(a).querySelector('.tp-stg');
    assert.ok(box, 'pickup box shown');
    const loc = box.querySelector('.tp-stg-loc'), bin = box.querySelector('.tp-stg-bin');
    assert.strictEqual(txt(loc), 'Pickup location: STG S-01');
    assert.strictEqual(txt(bin), 'Bin 1');
    assert.ok(loc.compareDocumentPosition(bin) & a.w.Node.DOCUMENT_POSITION_FOLLOWING, 'STG first, then the bin');
    assert.ok(a.$('scRouteAccepted').classList.contains('on') && !loc.closest('[style*="display: none"],[style*="display:none"],[hidden]'), 'on screen');
    assert.match(HTML, /#dxDayCard \.tp-stg-loc\{font-size:1\.5rem;font-weight:900/, 'large, clear text');
    assert.match(txt(card(a)), /Ready for pickup/);
    noLoc(a);
  } finally { a.close(); }
});

test('b. ready but not staged ("Stage later"): "Bin 1" and "Not staged yet - check with the warehouse"; no LOC', async () => {
  const srv = server();
  const a = await waiting(srv);
  try {
    srv.binding = bindingRow(null);
    await refresh(a);
    const box = card(a).querySelector('.tp-stg');
    assert.strictEqual(txt(box.querySelector('.tp-stg-bin')), 'Bin 1');
    assert.strictEqual(txt(box.querySelector('.tp-stg-note')), 'Not staged yet - check with the warehouse');
    assert.ok(!box.querySelector('.tp-stg-loc'), 'no STG yet');
    noLoc(a);
  } finally { a.close(); }
});

test('c. the worker stages while the card is open: it updates on the next refresh by itself', async () => {
  const srv = server();
  const a = await waiting(srv);
  try {
    srv.binding = bindingRow(null);
    await refresh(a);
    assert.match(txt(card(a)), /Not staged yet/);
    srv.binding = bindingRow('S-02');                         // PathIQ: STG S-02 scanned
    await settle(NATIVE ? 4600 : 6600);                         // the app's own warehouse poll, no tap
    assert.strictEqual(txt(card(a).querySelector('.tp-stg-loc')), 'Pickup location: STG S-02');
    assert.strictEqual(txt(card(a).querySelector('.tp-stg-bin')), 'Bin 1');
    assert.doesNotMatch(txt(card(a)), /Not staged yet/);
    noLoc(a);
  } finally { a.close(); }
});

test('not ready: Waiting for warehouse exactly as before, no pickup box', async () => {
  const srv = server();
  const a = await waiting(srv);
  try {
    srv.binding = null;
    await refresh(a);
    assert.match(txt(card(a)), /Waiting for warehouse/);
    assert.ok(!card(a).querySelector('.tp-stg'));
    srv.binding = { bin_code: '1', location_code: LOC, state: 'open', staging_code: null };   // stowing in progress
    await refresh(a);
    assert.match(txt(card(a)), /Staging in progress/);
    assert.ok(!card(a).querySelector('.tp-stg'));
    noLoc(a);
  } finally { a.close(); }
});

test('e. the BIN scan still confirms pickup, and after pickup nothing about STG or LOC is on screen', async () => {
  const srv = server();
  const a = await waiting(srv);
  try {
    srv.binding = bindingRow('S-01');
    await refresh(a);
    a.w.eval('startBinScan()'); await settle(300);
    assert.strictEqual(a.screen(), 'scScan', 'bin scan opens');
    assert.match(a.$('binScanHeading').textContent, /BIN 1/);
    assert.strictEqual(a.$('binScanOverlay').style.display, 'block');
    a.w.eval('cancelBinScan()'); await settle();
    await a.w.eval('confirmPickup()'); await settle();          // Start Route (in transit)
    assert.strictEqual(srv.jobs[0].status, 'in_transit');
    const on = a.w.document.querySelector('.screen.on');
    assert.doesNotMatch(txt(on), /STG|Not staged|A-01/);
    noLoc(a);
  } finally { a.close(); }
});
