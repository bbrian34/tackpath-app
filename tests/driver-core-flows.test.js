const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// DRIVER CORE FLOWS (2026-10). Locks in what a driver does every day, end to
// end on the real page, so a change elsewhere cannot silently break it:
// sign in, accept an offer, Waiting for warehouse, start delivery, navigation
// start, Arrived, scan two barcodes at one stop (one typed), complete the
// stop, a route removed by dispatch, and coming back from Google Maps (also
// after Android killed the app). The same file runs in both repos, on the
// native app (tackpath-driver www/index.html, with the Capacitor plugins
// mocked) and the web app (tackpath-app driver.html); APP_HTML overrides.
// The scan, TP-GONE, experience and drift tests run alongside this file.
// The backend is a stand-in for tp_driver that keeps state.

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

test('core 1. sign in: phone, 6-digit code, signed in with a server session, not on the login screen', async () => {
  const srv = server();
  const storage = {};
  const a = boot(srv, { storage, signedIn: false });
  try {
    await settle();
    assert.strictEqual(a.screen(), 'scLogin');
    a.$('loginPhone').value = '(404) 555-1234';
    await a.w.eval('requestCode()');
    const code = a.$('loginCode');
    code.value = '111111';
    code.dispatchEvent(new a.w.Event('input'));
    await settle(400);
    assert.strictEqual(JSON.parse(storage.tp_drv).token, 'tok');
    if (NATIVE) {                                                  // first sign-in: what the app will ask for, once
      assert.match(a.$('dxSheet').textContent, /Before your first route.*Appear on top/s);
      a.$('dxSheet').querySelector('.dx-btn.ok').click(); await settle();
    }
    assert.notStrictEqual(a.screen(), 'scLogin');
  } finally { a.close(); }
});

test('core 2/3. accept an offer -> Waiting for warehouse; bin ready -> Ready for pickup', async () => {
  const srv = server([{ id: 'job-9', title: 'Sprint 9', job_type: 'sprint', status: 'pending', driver_name: null, archived: false,
    pickup_address: '1 Hub Rd', dropoff_address: '9 Elm St', price: 20, created_at: new Date().toISOString() }]);
  const a = boot(srv);
  try {
    await settle(700);
    await a.w.eval('pollJobs()'); await settle();
    assert.strictEqual(a.screen(), 'scOffer', 'the offer is shown');
    await a.w.eval('acceptOffer()'); await settle(300);
    assert.strictEqual(srv.jobs[0].status, 'assigned');
    assert.strictEqual(srv.jobs[0].driver_name, 'Dana');
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    assert.match(a.$('scRouteAccepted').textContent, /Waiting for warehouse/i);
    srv.binding = { bin_code: '2B', location_code: 'A-07', state: 'ready' };
    if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
    await settle();
    assert.match(a.$('scRouteAccepted').textContent, /Ready for pickup/i);
  } finally { a.close(); }
});

test('core 4/5. start delivery: pickup -> in transit -> stop 1 opens and navigation starts to its coordinates', async () => {
  const srv = server([ROUTE()]);
  const a = boot(srv, { routeState: { currentJob: ROUTE(), screenContext: 'accepted' } });
  try {
    await settle(700);
    assert.strictEqual(a.screen(), 'scRouteAccepted');
    await a.w.eval('confirmPickup()'); await settle();
    assert.strictEqual(srv.jobs[0].status, 'in_transit');
    assert.strictEqual(a.screen(), 'scSurgeMap');
    await startStop(a, 0);
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
    assert.strictEqual(a.w.eval('currentSurgeStop'), 0);
    if (NATIVE) {
      assert.strictEqual(a.called('AppLauncher.openUrl').length, 1, 'Google Maps opened once');
      assert.match(a.called('AppLauncher.openUrl')[0][1], /^google\.navigation:q=33\.7301,-84\.4102&mode=d$/);
      assert.strictEqual(a.called('ArrivalPlugin.start').length, 1, 'arrival service started');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(a.called('ArrivalPlugin.start')[0][1])), { lat: 33.7301, lng: -84.4102, label: 'Test A', address: '260 Manning Rd SW Unit 37' });
    }
  } finally { a.close(); }
});

test('core 6. Arrived: the arrival prompt, then the stop is ready to scan; the arrival service stops', async () => {
  const srv = server();
  const a = await inTransit(srv);
  try {
    await startStop(a, 0);
    if (NATIVE) {
      a.w.eval('onDeepLinkArrived()'); await settle(300);          // Back to TackPath / Arrived tapped over Maps
      assert.ok(a.visible(a.$('arrivalPrompt')), 'arrival prompt shown');
      a.w.eval('confirmArrival()'); await settle();
      assert.ok(a.called('ArrivalPlugin.stop').length >= 1, 'arrival service stopped');
    } else {
      a.w.eval('sdAtStop()'); await settle();
    }
    assert.strictEqual(a.screen(), 'scScan', 'scanning the stop’s packages');
    assert.match(a.$('dlvScanCount').textContent, /0 of 2/);
  } finally { a.close(); }
});

test('core 7/8. two barcodes at one stop (one typed), then the stop completes with proof of delivery', async () => {
  const srv = server();
  const a = await inTransit(srv);
  try {
    await startStop(a, 0);
    a.w.eval('sdAtStop()'); await settle();
    a.w.eval('processScan("720431958206")');
    assert.match(a.$('dlvScanCount').textContent, /1 of 2/);
    if (a.$('dlvNextBtn')) a.$('dlvNextBtn').click();
    a.w.eval('tpScan.openTyping()');
    a.$('tpTypeInp').value = '720431958213';
    a.$('tpTypeInp').dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.match(a.$('dlvScanResult').textContent, /ALL PACKAGES FOR STOP 1 ACCOUNTED FOR/);
    a.$('dlvProceedBtn').click();
    assert.ok(a.$('scPOD').classList.contains('on'), 'proof of delivery');
    a.w.eval("dx.choose('front_door')");
    a.w.eval("podPhotoData='data:image/jpeg;base64,AAAA'");
    await a.w.eval('submitPOD()'); await settle(300);
    const rec = srv.messages.filter((m) => m.body.startsWith('STOP_DELIVERED::')).map((m) => JSON.parse(m.body.slice(16)));
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].stop_number, 1);
    assert.strictEqual(rec[0].delivery_choice, 'front_door');
  } finally { a.close(); }
});

test('core 9. a route cancelled or archived by dispatch returns the driver home', async () => {
  for (const change of [{ status: 'cancelled' }, { archived: true }]) {
    const srv = server();
    const a = await inTransit(srv);
    try {
      await startStop(a, 0);
      Object.assign(srv.jobs[0], change);
      await a.w.eval('tpGone.check()'); await settle();
      assert.strictEqual(a.screen(), 'scHome', JSON.stringify(change));
      assert.strictEqual(a.current(), null);
      assert.ok(a.toasts.some((t) => /removed|cancelled/.test(t)));
    } finally { a.close(); }
  }
});

test('core 10. backing out of Google Maps lands on the same delivery; after Android killed the app too', async () => {
  const srv = server();
  const storage = {};
  const a = await inTransit(srv, storage);
  try {
    await startStop(a, 0);
    const opened = a.called('AppLauncher.openUrl').length;
    a.background(); await settle(300);                            // Google Maps in front
    a.foreground(); await settle(300);                            // Android back from Maps
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
    assert.strictEqual(a.w.eval('currentSurgeStop'), 0);
    assert.strictEqual(a.current(), 'job-1');
    assert.strictEqual(a.called('AppLauncher.openUrl').length, opened, 'Maps is not reopened by coming back');
    if (NATIVE) assert.strictEqual(a.called('ArrivalPlugin.stop').length, 0, 'the arrival service keeps running');
  } finally { a.close(); }
  // Android killed TackPath while Maps was in front: reopening restores the same stop
  const b = boot(srv, { storage });
  try {
    await settle(900);
    assert.strictEqual(b.screen(), 'scSurgeDelivery');
    assert.strictEqual(b.w.eval('currentSurgeStop'), 0);
    assert.strictEqual(b.current(), 'job-1');
  } finally { b.close(); }
});
