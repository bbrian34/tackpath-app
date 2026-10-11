const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// DIRTY PHONE (2026-10, v20). A real phone carries state from earlier test
// routes: a finished route saved on the phone (with the SAME tracking numbers
// and stop addresses as the new route), TP-DX's saved loaded counts, and the
// native arrival service of the last delivery. The new route must still go
// BIN scan -> Route tab -> Load, with nothing loaded, and Maps / "you have
// arrived" only after Start Route of THIS route. Same harness as
// pickup-flow.test.js; the same file runs in both repos.

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


const OLD = (extra) => ROUTE(Object.assign({ id: 'job-12', driver_name: 'Dana', bin_label: '1' }, extra));
const NEW = () => ROUTE(NATIVE ? { id: 'job-13', status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { id: 'job-13', bin_label: '1' });
const oldScans = () => JSON.stringify({ job: 'job-12', outcomes: {}, startedAt: Date.now(), loaded: ALL.map((c) => [c, 1]) });
const state = (a) => JSON.parse(a.w.eval('JSON.stringify({id:currentJob&&currentJob.id,status:currentJob&&currentJob.status,tab:tpPickup.state().tab,done:tpPickup.state().progress.done})'));
const arrived = (a) => a.$('arrivalPrompt') && a.$('arrivalPrompt').style.display === 'flex';

// The new route reaches the driver, the bin is staged, AT PICKUP, BIN scan.
async function newRouteToBin(a, srv) {
  srv.jobs.push(NEW());
  for (let i = 0; i < 3 && a.screen() !== 'scRouteAccepted' && a.screen() !== 'scOffer'; i++) {
    try { await a.w.eval('pollJobs()'); } catch (e) {} await settle(400);
  }
  if (a.screen() === 'scOffer') { await a.w.eval('acceptOffer()'); await settle(300); }
  assert.strictEqual(state(a).id, 'job-13', 'the new route is the driver\'s route (screen ' + a.screen() + ')');
  assert.strictEqual(a.screen(), 'scRouteAccepted');
  srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
  if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
  await settle();
  a.$('scRouteAccepted').querySelector('button:not(.dx-btn)').click(); await settle(300);
  assert.strictEqual(a.screen(), 'scScan', 'the bin scan opens');
  await scanBin(a);
}
function assertPickupTabs(a, srv, n0) {
  const s = state(a);
  assert.strictEqual(a.screen(), 'scPickup', 'Route preview after the BIN scan, not ' + a.screen());
  assert.strictEqual(s.tab, 'route');
  assert.strictEqual(s.id, 'job-13');
  assert.strictEqual(s.done, 0, 'nothing of the new route is loaded yet (old counts not inherited)');
  assert.ok(a.$('tpPickStart').disabled, 'Start Route off');
  assert.deepStrictEqual(navCalls(a).slice(n0), [], 'no Google Maps, no arrival service');
  assert.ok(!arrived(a), 'no "you have arrived"');
  assert.notStrictEqual(srv.jobs.find((j) => j.id === 'job-13').status, 'in_transit');
  a.w.eval('tpPickup.showLoad()');
  assert.strictEqual(state(a).tab, 'load');
}

// (a)+(b)+(c): the phone was closed during (or after) the last route, which dispatch then finished.
for (const ctx of ['delivery', 'list', 'accepted']) {
  test(`dirty ${ctx}: a finished route saved on the phone (same packages, same stops) does not take over the new route`, async () => {
    const srv = server([OLD({ status: 'delivered' })]);
    const storage = { tp_dx_route: oldScans(), tp_dx_perm_intro: '1' };
    const a = boot(srv, { storage, routeState: { currentJob: OLD({ status: ctx === 'accepted' ? 'assigned' : 'in_transit' }), screenContext: ctx, currentSurgeStop: 1 } });
    try {
      await settle(1200);
      if (NATIVE) { a.w.eval('onDeepLinkArrived()'); await settle(600); }      // the old delivery's arrival service fires
      assert.ok(!arrived(a), 'no "you have arrived" for a finished route');
      const n0 = navCalls(a).length;
      assert.strictEqual(n0, 0, 'no Maps on open');
      await newRouteToBin(a, srv);
      assertPickupTabs(a, srv, n0);
      assert.ok(!a.storage.tp_dx_route || JSON.parse(a.storage.tp_dx_route).job !== 'job-12', 'old saved counts dropped');
      assert.notStrictEqual(srv.jobs[0].status, 'in_transit', 'the finished route is not reopened on the server');
    } finally { a.close(); }
  });
}

test('dirty: dispatch finishes the route while the driver is mid-delivery (arrival service running); the next route starts clean', async () => {
  const { a, srv } = await toBinScan(true);
  try {
    await scanBin(a); a.w.eval('tpPickup.showLoad()'); await settle();
    for (const c of ALL) { a.w.eval(`processScan(${JSON.stringify(c)})`); await settle(30); okLoad(a); }
    await settle(1200); a.$('tpPickStart').click(); await settle(300);
    a.w.eval('surgeTapStop(0)'); await settle(800);                       // Maps + arrival service for route 1
    srv.jobs[0].status = 'delivered';                                     // finished from the dispatch board
    await settle(5600);                                                   // the next poll
    assert.notStrictEqual(state(a).id, 'job-12', 'the finished route is let go');
    const n0 = navCalls(a).length;
    await newRouteToBin(a, srv);
    assertPickupTabs(a, srv, n0);
    if (NATIVE) {                                                         // a late "arrived" from route 1's service
      a.w.eval('onDeepLinkArrived()'); await settle(600);
      assert.ok(!arrived(a), 'route 1\'s arrival does not say "you have arrived" on route 2');
    }
  } finally { a.close(); }
});

test('dirty: Google Maps never opens for a route that has not been started (Start Route), whatever the saved state', async () => {
  const srv = server([OLD({ status: 'assigned' })]);
  const a = boot(srv, { storage: { tp_dx_perm_intro: '1' }, routeState: { currentJob: OLD({ status: 'assigned' }), screenContext: 'accepted' } });
  try {
    await settle(1000);
    a.w.eval('surgeTapStop(0)'); await settle(800);                       // what a stale restore would do
    assert.deepStrictEqual(navCalls(a), [], 'no Maps before Start Route');
    if (NATIVE) { a.w.eval('onDeepLinkArrived()'); await settle(600); assert.ok(!arrived(a)); }
  } finally { a.close(); }
});

test('cleanup on app start: saved route data of a job that is not the driver\'s active job is dropped', async () => {
  const srv = server();
  const storage = { tp_dx_route: JSON.stringify({ job: 'job-99', outcomes: { 0: { kind: 'delivered' } }, loaded: ALL.map((c) => [c, 1]) }), tp_dx_perm_intro: '1' };
  const a = boot(srv, { storage });
  try {
    await settle(1200);
    assert.strictEqual(a.storage.tp_dx_route, undefined, 'job-99\'s saved counts are gone');
  } finally { a.close(); }
});

// The whole core flow twice in a row on the same page, same package numbers, same stops.
async function deliverStop(a, i) {
  a.w.eval(`surgeTapStop(${i})`); await settle(800);
  assert.strictEqual(a.screen(), 'scSurgeDelivery');
  if (NATIVE) {
    a.background(); await settle(300); a.foreground(); await settle(300);   // Back out of Maps
    assert.strictEqual(a.screen(), 'scSurgeDelivery');
    a.w.eval('onDeepLinkArrived()'); await settle(300);                     // Back to TackPath / Arrived
    assert.ok(arrived(a), 'arrival prompt');
    a.w.eval('confirmArrival()'); await settle();
  } else { a.w.eval('sdAtStop()'); await settle(); }
  assert.strictEqual(a.screen(), 'scScan');
  assert.match(a.$('dlvScanCount').textContent, new RegExp('0 of ' + STOPS[i].pkgs.length));
  for (const c of STOPS[i].pkgs.map((p) => p.tracking_number)) {
    a.w.eval(`processScan(${JSON.stringify(c)})`); await settle(30);
    const nx = a.$('dlvNextBtn'); if (nx && a.visible(nx) && !/ACCOUNTED FOR/.test(a.$('dlvScanResult').textContent)) nx.click();
  }
  assert.match(a.$('dlvScanResult').textContent, new RegExp('ALL PACKAGES FOR STOP ' + (i + 1) + ' ACCOUNTED FOR'));
  a.$('dlvProceedBtn').click();
  a.w.eval("dx.choose('front_door')"); a.w.eval("podPhotoData='data:image/jpeg;base64,AAAA'");
  await a.w.eval('submitPOD()'); await settle(600);
}
test('e2e twice in a row on the same page: sign in -> accept -> BIN -> Load all -> Start Route -> deliver -> Back/Arrived -> complete, then the same again', async () => {
  const srv = server();
  const storage = {};
  const a = boot(srv, { storage, signedIn: false });
  try {
    await settle();
    a.$('loginPhone').value = '(404) 555-1234';
    await a.w.eval('requestCode()');
    a.$('loginCode').value = '111111'; a.$('loginCode').dispatchEvent(new a.w.Event('input'));
    await settle(400);
    if (NATIVE) { a.$('dxSheet').querySelector('.dx-btn.ok').click(); await settle(); }
    assert.notStrictEqual(a.screen(), 'scLogin');
    await settle(700);
    for (const id of ['job-12', 'job-13']) {
      const n0 = navCalls(a).length;
      srv.binding = null;
      srv.jobs.push(ROUTE(NATIVE ? { id, status: 'assigned', driver_name: 'Dana', bin_label: '1' } : { id, bin_label: '1' }));
      for (let i = 0; i < 3 && a.screen() !== 'scRouteAccepted' && a.screen() !== 'scOffer'; i++) { try { await a.w.eval('pollJobs()'); } catch (e) {} await settle(400); }
      if (a.screen() === 'scOffer') { await a.w.eval('acceptOffer()'); await settle(300); }
      assert.strictEqual(state(a).id, id, id + ' accepted');
      srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
      if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
      await settle();
      a.$('scRouteAccepted').querySelector('button:not(.dx-btn)').click(); await settle(300);
      await scanBin(a);
      assert.strictEqual(a.screen(), 'scPickup', id + ': Route preview');
      assert.strictEqual(state(a).done, 0, id + ': nothing loaded yet');
      assert.ok(a.$('tpPickStart').disabled);
      assert.deepStrictEqual(navCalls(a).slice(n0), [], id + ': no Maps before Start Route');
      a.w.eval('tpPickup.showLoad()'); await settle();
      for (const c of ALL) { a.w.eval(`processScan(${JSON.stringify(c)})`); await settle(30); okLoad(a); }
      await settle(1200);
      assert.strictEqual(a.$('tpPickStart').disabled, false);
      a.$('tpPickStart').click(); await settle(300);
      assert.strictEqual(srv.jobs.find((j) => j.id === id).status, 'in_transit');
      await deliverStop(a, 0);
      await deliverStop(a, 1);
      assert.strictEqual(srv.jobs.find((j) => j.id === id).status, 'delivered', id + ' delivered');
      const rec = srv.messages.filter((m) => m.job_id === id && m.body.startsWith('STOP_DELIVERED::'));
      assert.strictEqual(rec.length, 2, id + ': both stops recorded');
      const d = a.$('dxSummaryDone'); if (d) d.click(); await settle(300);
    }
  } finally { a.close(); }
});

test('TP-RSTATE is the same in the native app and the web app, and loads once', () => {
  const block = (s) => (s.match(/<!-- TP-RSTATE:BEGIN[\s\S]*?<!-- TP-RSTATE:END -->/) || [''])[0];
  const SIBLING = NATIVE_REPO_FILE();
  assert.ok(block(HTML).length > 1000);
  assert.strictEqual((HTML.match(/<!-- TP-RSTATE:BEGIN/g) || []).length, 1);
  if (SIBLING && fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});
function NATIVE_REPO_FILE() {
  return process.env.SIBLING_HTML || (fs.existsSync(path.join(ROOT, 'www', 'index.html'))
    ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
}
