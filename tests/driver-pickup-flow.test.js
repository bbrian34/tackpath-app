const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// PICKUP FLOW after the BIN scan (2026-10, v19). v18 regression report: after
// the driver scanned the BIN at pickup the app went straight to delivery
// navigation instead of the v16 pickup flow (Route preview + Load tabs, Start
// Route only when every package is loaded). Driven end to end on the real
// page: route given to the driver -> Ready for pickup (staged, and not staged)
// -> AT PICKUP -> scan BIN -> Route tab, never Maps -> Load 12 packages ->
// Start Route -> only then navigation. Same harness as core-flows.test.js;
// the same file runs in both repos.

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

// The route reaches the driver (native: assigned by dispatch; web: the offer is accepted),
// the warehouse marks the bin ready (staged at S-01, or not staged), the driver taps AT PICKUP.
async function toBinScan(staged) {
  const srv = server();
  const a = boot(srv);
  try {
  a.w.eval(`window._taps=[];const _st=surgeTapStop;surgeTapStop=function(i){window._taps.push(i);return _st.apply(this,arguments);};`);
  await settle(700);
  // dispatch gives the route to this driver while the app is open
  srv.jobs = [ROUTE(NATIVE ? { status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { bin_label: '1' })];
  await a.w.eval('pollJobs()'); await settle(300);
  if (!NATIVE) { assert.strictEqual(a.screen(), 'scOffer'); await a.w.eval('acceptOffer()'); await settle(300); }
  assert.strictEqual(a.screen(), 'scRouteAccepted', 'Waiting for warehouse');
  srv.binding = { bin_code: '1', location_code: 'A-01', state: 'ready', staging_code: staged ? 'S-01' : null };
  if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
  await settle();
  const card = a.$('dxDayCard').textContent.replace(/\s+/g, ' ');
  if (staged) assert.match(card, /Pickup location: STG S-01\s*Bin 1/); else assert.match(card, /Bin 1\s*Not staged yet - check with the warehouse/);
  a.$('scRouteAccepted').querySelector('button:not(.dx-btn)').click();       // AT PICKUP
  await settle(300);
  assert.strictEqual(a.screen(), 'scScan', 'the bin scan opens');
  } catch (e) { a.close(); throw e; }
  return { a, srv };
}
async function scanBin(a) {
  a.w.eval(`processScan(${JSON.stringify(NATIVE ? 'BIN:1' : '1')})`);       // as pickup-preview.test.js
  await settle(NATIVE ? 1200 : 2200);                                         // bin confirmed -> loading (native 0.7 s, web 1.3 s hold)
}

for (const staged of [true, false]) {
  test(`${staged ? 'a' : 'b'}. ${staged ? 'staged' : 'not staged'} route, 2 stops / 12 packages: the BIN scan lands on the Route tab (Load next), never Maps`, async () => {
    const { a, srv } = await toBinScan(staged);
    try {
      await scanBin(a);
      assert.strictEqual(a.screen(), 'scPickup', 'pickup screen, not delivery: ' + a.screen());
      assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route');
      assert.ok(a.$('tpPickStart').disabled, 'Start Route off until every package is loaded');
      assert.match(a.$('tpPickStart').textContent, /12/);
      assert.deepStrictEqual(navCalls(a), [], 'no navigation, no Google Maps');
      assert.deepStrictEqual(Array.from(a.w._taps), [], 'no delivery stop opened');
      assert.notStrictEqual(srv.jobs[0].status, 'in_transit');
      // the Load tab
      a.w.eval('tpPickup.showLoad()'); await settle();
      assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'load');
      assert.deepStrictEqual(navCalls(a), []);
    } finally { a.close(); }
  });
}

test('c. navigation opens only after every package is loaded and Start Route is tapped', async () => {
  const { a, srv } = await toBinScan(true);
  try {
    await scanBin(a);
    a.w.eval('tpPickup.showLoad()'); await settle();
    for (let i = 0; i < ALL.length; i++) {
      a.w.eval(`processScan(${JSON.stringify(ALL[i])})`); await settle(30);
      okLoad(a);
      if (i === 5) { a.w.eval('tpPickup.start()'); await settle(); assert.notStrictEqual(srv.jobs[0].status, 'in_transit', 'Start Route refused mid-load'); a.w.eval('tpPickup.showLoad()'); await settle(); }
      assert.deepStrictEqual(navCalls(a), [], 'no navigation while loading (' + (i + 1) + ')');
    }
    await settle(1200);                                                       // the app finishes loading 0.8 s after the last package
    assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route', 'back on the Route tab');
    assert.strictEqual(a.$('tpPickStart').disabled, false, 'Start Route on');
    assert.strictEqual(a.w.eval('tpPickup.state().progress.done'), 12);
    a.$('tpPickStart').click(); await settle(300);                           // Start Route
    assert.strictEqual(srv.jobs[0].status, 'in_transit');
    assert.strictEqual(a.screen(), 'scSurgeMap');
    assert.deepStrictEqual(navCalls(a), [], 'still no Maps until a stop is started');
    a.w.eval('surgeTapStop(0)'); await settle(800);
    if (NATIVE) assert.ok(a.called('AppLauncher.openUrl').length === 1, 'now Google Maps opens for stop 1');
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
  } finally { a.close(); }
});

test('e2e. the whole core flow once: sign in -> route -> BIN scan -> Load all -> Start Route -> start delivery -> Back/Arrived -> complete stop', async () => {
  const srv = server();
  const storage = {};
  const a = boot(srv, { storage, signedIn: false });
  try {
    await settle();
    // sign in
    assert.strictEqual(a.screen(), 'scLogin');
    a.$('loginPhone').value = '(404) 555-1234';
    await a.w.eval('requestCode()');
    a.$('loginCode').value = '111111';
    a.$('loginCode').dispatchEvent(new a.w.Event('input'));
    await settle(400);
    assert.strictEqual(JSON.parse(storage.tp_drv).token, 'tok');
    if (NATIVE) { a.$('dxSheet').querySelector('.dx-btn.ok').click(); await settle(); }
    assert.notStrictEqual(a.screen(), 'scLogin');
    await settle(700);
    // the route: native = dispatch assigns it; web = the offer is accepted
    srv.jobs = [ROUTE(NATIVE ? { status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { bin_label: '1' })];
    await a.w.eval('pollJobs()'); await settle(300);
    if (!NATIVE) { assert.strictEqual(a.screen(), 'scOffer'); await a.w.eval('acceptOffer()'); await settle(300); }
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    assert.strictEqual(srv.jobs[0].driver_name, 'Dana');
    // the warehouse stages the bin; AT PICKUP; BIN scan
    srv.binding = { bin_code: '1', location_code: 'A-01', state: 'ready', staging_code: 'S-01' };
    if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
    await settle();
    assert.match(a.$('dxDayCard').textContent.replace(/\s+/g, ' '), /Pickup location: STG S-01\s*Bin 1/);
    a.$('scRouteAccepted').querySelector('button:not(.dx-btn)').click(); await settle(300);
    assert.strictEqual(a.screen(), 'scScan');
    await scanBin(a);
    assert.strictEqual(a.screen(), 'scPickup');
    assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route');
    assert.ok(a.$('tpPickStart').disabled);
    assert.deepStrictEqual(navCalls(a), []);
    // Load all 12
    a.w.eval('tpPickup.showLoad()'); await settle();
    for (const c of ALL) { a.w.eval(`processScan(${JSON.stringify(c)})`); await settle(30); okLoad(a); }
    await settle(1200);
    assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route');
    assert.strictEqual(a.$('tpPickStart').disabled, false);
    assert.deepStrictEqual(navCalls(a), [], 'no navigation before Start Route');
    // Start Route
    a.$('tpPickStart').click(); await settle(300);
    assert.strictEqual(srv.jobs[0].status, 'in_transit');
    assert.strictEqual(a.screen(), 'scSurgeMap');
    // start delivery: stop 1, navigation now
    a.w.eval('surgeTapStop(0)'); await settle(800);
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
    if (NATIVE) {
      assert.match(a.called('AppLauncher.openUrl')[0][1], /^google\.navigation:q=33\.7301,-84\.4102&mode=d$/);
      assert.strictEqual(a.called('ArrivalPlugin.start').length, 1);
      // Back out of Maps: same stop
      a.background(); await settle(300); a.foreground(); await settle(300);
      assert.strictEqual(a.screen(), 'scSurgeDelivery');
      assert.strictEqual(a.w.eval('currentSurgeStop'), 0);
      // Back to TackPath / Arrived over Maps
      a.w.eval('onDeepLinkArrived()'); await settle(300);
      assert.ok(a.visible(a.$('arrivalPrompt')), 'arrival prompt');
      a.w.eval('confirmArrival()'); await settle();
    } else {
      a.w.eval('sdAtStop()'); await settle();
    }
    assert.strictEqual(a.screen(), 'scScan');
    assert.match(a.$('dlvScanCount').textContent, /0 of 7/);
    // complete stop 1: 7 packages, proof of delivery
    for (const c of STOPS[0].pkgs.map((p) => p.tracking_number)) {
      a.w.eval(`processScan(${JSON.stringify(c)})`); await settle(30);
      const nx = a.$('dlvNextBtn'); if (nx && a.visible(nx) && !/ACCOUNTED FOR/.test(a.$('dlvScanResult').textContent)) nx.click();
    }
    assert.match(a.$('dlvScanResult').textContent, /ALL PACKAGES FOR STOP 1 ACCOUNTED FOR/);
    a.$('dlvProceedBtn').click();
    assert.ok(a.$('scPOD').classList.contains('on'), 'proof of delivery');
    a.w.eval("dx.choose('front_door')");
    a.w.eval("podPhotoData='data:image/jpeg;base64,AAAA'");
    await a.w.eval('submitPOD()'); await settle(300);
    const rec = srv.messages.filter((m) => m.body.startsWith('STOP_DELIVERED::')).map((m) => JSON.parse(m.body.slice(16)));
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].stop_number, 1);
    assert.strictEqual(a.w.eval('currentSurgeStop'), 1, 'the next stop is up');
  } finally { a.close(); }
});
