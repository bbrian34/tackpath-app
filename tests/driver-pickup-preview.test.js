const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// PICKUP PREVIEW (2026-10-12), the TP-PICKUP block: identical in tackpath-driver
// www/index.html and tackpath-app driver.html. After the bin scan the driver
// sees a read-only route preview inside the app (the TP-ROUTEMAP dots, no
// Google map) and a Load tab; Start Route stays off until every package is
// loaded, then runs the app's own confirmPickup (in_transit: the server
// releases the bin, location and STG spot as before). The harness is the
// core-flows one (same stand-in backend, Capacitor mocks on the phone app).
// APP_HTML is the page under test, SIBLING_HTML the other repo's copy.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// In transit on the route map (pickup done), ready to start stop 1.
async function inTransit(srv, storage = {}) {
  srv.jobs = [ROUTE({ status: 'in_transit' })];
  const a = boot(srv, { storage, routeState: { currentJob: ROUTE({ status: 'in_transit' }), screenContext: 'list' } });
  await settle(700);                         // restore window (auto-navigation suppressed) passes
  return a;
}
// Start stop 1: the stop opens and navigation starts.
async function startStop(a, i = 0) {
  a.w.eval(`surgeTapStop(${i})`);
  await settle(700);
}
const SIBLING = process.env.SIBLING_HTML || (NATIVE_REPO ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const block = (s, name) => (s.match(new RegExp('<!-- ' + name + ':BEGIN[\\s\\S]*?<!-- ' + name + ':END -->')) || [''])[0];
const BARCODES = ['720431958206', '720431958213', '720431958220'];   // stop 1 (two), stop 2 (one)

// Route accepted, bin ready: AT PICKUP, scan the bin. Lands on the pickup tabs.
async function atPickup(srv, opts = {}) {
  srv.binding = { bin_code: '2B', state: 'ready' };
  const a = boot(srv, Object.assign({ routeState: { currentJob: srv.jobs[0], surgeStops: srv.jobs[0].surge_stops, screenContext: 'accepted' } }, opts));
  await settle(700);
  a.w.eval('startBinScan()');
  await settle(400);                          // the phone app checks the warehouse binding first
  a.w.eval(`processScan(${JSON.stringify(NATIVE ? 'BIN:2B' : '2B')})`);
  await settle(1600);                         // the app holds "BIN 2B CONFIRMED" on screen first
  return a;
}
// One package scanned into the vehicle; then OK, as the driver taps it.
async function load(a, code) {
  a.w.eval(`processScan(${JSON.stringify(code)})`);
  await settle(100);
  const ok = a.w.document.querySelector('#loadPkgOkBtn, #loadPkgLastScan button');
  if (ok) { ok.click(); await settle(100); }
}
const dots = (a) => [...a.w.document.querySelectorAll('#scPickup .tprm-dot')].map((d) => d.textContent.trim());
const startBtn = (a) => a.$('tpPickStart');
const progress = (a) => a.w.eval('tpPickup.state().progress.done');
const lastScan = (a) => a.$('loadPkgLastScan').textContent.replace(/\s+/g, ' ').toUpperCase();

test('(a) the bin scan opens a route preview inside the app: numbered dots in route order, no Google Maps', async () => {
  const srv = server([ROUTE()]);
  const a = await atPickup(srv);
  try {
    assert.strictEqual(a.screen(), 'scPickup', 'the Route tab is showing');
    assert.match(a.$('scPickup').querySelector('.tpk-tabs').textContent, /Route\s*Load/);
    assert.deepStrictEqual(dots(a), ['1', '2'], 'one dot per stop, in route order');
    assert.deepStrictEqual([...a.w.document.querySelectorAll('#tpPickList .tpk-stop')].map((r) => r.getAttribute('data-stop')), ['1', '2']);
    assert.strictEqual(a.$('scPickup').querySelectorAll('iframe').length, 0, 'no map frame in the preview');
    assert.ok(!/google/i.test(a.$('scPickup').innerHTML), 'nothing from Google in the preview');
    assert.strictEqual(a.called('AppLauncher.openUrl').length, 0, 'Google Maps not opened');
    assert.strictEqual(a.called('window.open').length, 0, 'nothing opened');
    assert.strictEqual(a.called('ArrivalPlugin.start').length, 0, 'no navigation started');
    assert.strictEqual(srv.jobs[0].status, 'assigned', 'the route has not started');
    // 50 stops: 50 dots, 1..50 in order
    const many = Array.from({ length: 50 }, (_, i) => ({ order_id: 'O' + i, tracking_number: 'T' + i, recipient: 'R' + i, address: i + ' Main St', stop_number: i + 1,
      coords: { lat: 33.70 + (i % 7) * 0.012, lng: -84.45 + Math.floor(i / 7) * 0.014 }, pkgs: [{ order_id: 'O' + i, tracking_number: 'T' + i, required_count: 1 }] }));
    const srv2 = server([ROUTE({ surge_stops: many, total_stops: 50, total_packages: 50 })]);
    const b = await atPickup(srv2);
    try {
      assert.strictEqual(b.screen(), 'scPickup');
      assert.deepStrictEqual(dots(b), many.map((s) => String(s.stop_number)));
      assert.strictEqual(b.called('AppLauncher.openUrl').length, 0);
    } finally { b.close(); }
  } finally { a.close(); }
});

test('(b) Start Route is off, saying how many packages remain, until every package is loaded; then it starts the route', async () => {
  const srv = server([ROUTE()]);
  const a = await atPickup(srv);
  try {
    assert.ok(startBtn(a).disabled, 'off before loading');
    assert.match(startBtn(a).textContent, /3 packages left/);
    startBtn(a).click(); a.w.eval('tpPickup.start()'); await settle();
    assert.strictEqual(srv.jobs[0].status, 'assigned', 'cannot start with packages left');
    a.w.eval('tpPickup.showLoad()'); await settle();
    assert.strictEqual(a.screen(), 'scScan', 'Load tab: the scanner');
    assert.match(a.$('tpPickCount').textContent, /^0 of 3 loaded$/);
    assert.strictEqual(a.$('tpPickLeft').querySelectorAll('span').length, 3, 'packages still to scan are listed');
    await load(a, BARCODES[0]);
    assert.match(a.$('tpPickCount').textContent, /^1 of 3 loaded$/);
    assert.strictEqual(a.$('tpPickLeft').querySelectorAll('span').length, 2);
    a.w.eval('tpPickup.showRoute()'); await settle();
    assert.ok(startBtn(a).disabled); assert.match(startBtn(a).textContent, /2 packages left/);
    a.w.eval('tpPickup.showLoad()'); await settle();
    await load(a, BARCODES[1]);
    await load(a, BARCODES[2]);
    await settle(1000);                       // the last package: back to the Route tab
    assert.strictEqual(a.screen(), 'scPickup');
    assert.strictEqual(startBtn(a).disabled, false, 'on once everything is loaded');
    assert.match(startBtn(a).textContent, /START ROUTE/);
    assert.strictEqual(a.called('AppLauncher.openUrl').length, 0, 'still no Google Maps');
    startBtn(a).click(); await settle(300);
    assert.strictEqual(srv.jobs[0].status, 'in_transit', 'the app’s own pickup confirmation ran');
    assert.strictEqual(a.screen(), 'scSurgeMap');
    assert.strictEqual(a.called('AppLauncher.openUrl').length, 0, 'Google Maps opens only from a stop');
  } finally { a.close(); }
});

test('(c) a package scanned twice is ignored; a package not on this route is refused', async () => {
  const srv = server([ROUTE()]);
  const a = await atPickup(srv);
  try {
    a.w.eval('tpPickup.showLoad()'); await settle();
    await load(a, BARCODES[2]);
    assert.strictEqual(progress(a), 1);
    a.w.eval(`processScan('${BARCODES[2]}')`); await settle();
    assert.match(lastScan(a), /ALREADY/, 'short message for a repeat');
    assert.strictEqual(progress(a), 1, 'a repeat does not count');
    assert.match(a.$('tpPickCount').textContent, /^1 of 3 loaded$/);
    a.w.eval("processScan('999999999999')"); await settle();
    assert.match(lastScan(a), /NOT ON THIS ROUTE/, 'clear message for a package from another route');
    assert.strictEqual(progress(a), 1, 'a foreign package does not count');
    a.w.eval('tpPickup.showRoute()'); await settle();
    assert.ok(startBtn(a).disabled);
  } finally { a.close(); }
});

test('(d) loaded packages survive the app going to the background, and the app being closed and reopened', async () => {
  const srv = server([ROUTE()]);
  const storage = {};
  const a = await atPickup(srv, { storage });
  try {
    a.w.eval('tpPickup.showLoad()'); await settle();
    await load(a, BARCODES[0]);
    a.background(); await settle(300); a.foreground(); await settle(300);
    assert.strictEqual(progress(a), 1, 'still 1 loaded after the background');
    assert.match(a.$('tpPickCount').textContent, /^1 of 3 loaded$/);
  } finally { a.close(); }
  // closed and opened again: AT PICKUP, bin, and the count is where it was
  const b = await atPickup(srv, { storage });
  try {
    assert.strictEqual(b.screen(), 'scPickup');
    assert.strictEqual(progress(b), 1, 'still 1 loaded after reopening');
    assert.match(b.$('tpPickSum').textContent, /1 of 3 packages loaded/);
    assert.match(startBtn(b).textContent, /2 packages left/);
  } finally { b.close(); }
});

test('(e) after Start Route: navigation, the Back to TackPath / Arrived overlay, and the driver can always leave a delivery', async () => {
  const srv = server([ROUTE()]);
  const a = await atPickup(srv);
  try {
    a.w.eval('tpPickup.showLoad()'); await settle();
    for (const c of BARCODES) await load(a, c);
    await settle(1000);
    startBtn(a).click(); await settle(300);
    assert.strictEqual(a.screen(), 'scSurgeMap');
    await startStop(a, 0);
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
    if (NATIVE) {
      assert.strictEqual(a.called('AppLauncher.openUrl').length, 1, 'Google Maps opens after the route starts');
      assert.strictEqual(a.called('ArrivalPlugin.start').length, 1, 'the Back to TackPath / Arrived overlay service is running');
      a.w.eval('onDeepLinkArrived()'); await settle(300);
      assert.ok(a.visible(a.$('arrivalPrompt')), 'arrival prompt shown');
      a.w.eval('confirmArrival()'); await settle();
    } else {
      a.w.eval('sdAtStop()'); await settle();
    }
    assert.strictEqual(a.screen(), 'scScan', 'scanning the stop');
    a.w.eval('cancelDeliveryScan()'); await settle();
    assert.strictEqual(a.screen(), 'scSurgeDelivery', 'out of the delivery scan');
    const back = a.$('scSurgeDelivery').querySelector('button[onclick="showScreen(\'scSurgeMap\')"]');
    assert.ok(back, 'the delivery screen has its List button');
    back.click(); await settle();
    assert.strictEqual(a.screen(), 'scSurgeMap', 'back on the route list');
  } finally { a.close(); }
});

test('(f) the shared blocks are the same in driver.html and www/index.html, and each loads once', () => {
  for (const name of ['TP-PICKUP', 'TP-ROUTEMAP', 'TP-SCAN', 'TP-DX', 'TP-GONE']) {
    assert.ok(block(HTML, name).length > 1000, name + ' present');
    assert.strictEqual((HTML.match(new RegExp('<!-- ' + name + ':BEGIN', 'g')) || []).length, 1, name + ' once');
    if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8'), name), block(HTML, name), name + ' identical in both repos');
  }
});
