const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { launch } = require('./browser');

// ROUTE MAP WITHOUT THE LINE (2026-10, v21). Routes have 30-75 stops; the
// dashed line joining the numbered dots in route order was noise. Neither the
// pickup Route preview nor the Route Map overlay draws a connector; the dots
// (one per stop, numbered in route order) stay exactly as they were. jsdom
// here, Chromium below; the same file runs in both repos.

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


const SIBLING = process.env.SIBLING_HTML || (fs.existsSync(path.join(ROOT, 'www', 'index.html'))
  ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
// n stops around Atlanta, one package each, in route order
const gen = (n) => Array.from({ length: n }, (_, i) => ({ stop_number: i + 1, recipient: 'R' + (i + 1), address: (100 + i) + ' Peachtree St NE', packages: 1,
  order_id: 'O' + i, tracking_number: 'TK' + String(i).padStart(4, '0'), coords: { lat: 33.70 + (i % 9) * 0.01, lng: -84.45 + Math.floor(i / 9) * 0.012 },
  pkgs: [{ order_id: 'O' + i, tracking_number: 'TK' + String(i).padStart(4, '0'), required_count: 1 }] }));
async function scanBin(a) {
  a.w.eval(`processScan(${JSON.stringify(NATIVE ? 'BIN:1' : '1')})`);
  await settle(NATIVE ? 1200 : 2200);
}
const CONNECTOR = '.tprm-line, svg polyline, svg line, svg path';
const look = (root) => ({
  connectors: root ? root.querySelectorAll(CONNECTOR).length : -1,
  dots: root ? Array.from(root.querySelectorAll('.tprm-dot')).map((d) => +d.dataset.stop) : [],
  off: root ? Array.from(root.querySelectorAll('.tprm-off b')).map((b) => +b.textContent) : [],
});

for (const n of [2, 30, 75]) {
  test(`jsdom, ${n} stops: BIN scan -> Route preview -> Load -> Start Route -> Route Map; no connector line anywhere, one numbered dot per stop in route order`, async () => {
    const srv = server();
    const a = boot(srv);
    try {
      await settle(700);
      const stops = gen(n);
      srv.jobs = [ROUTE(Object.assign({ surge_stops: stops, total_stops: n, total_packages: n, bin_label: '1' }, NATIVE ? { status: 'assigned', driver_name: 'Dana' } : {}))];
      await a.w.eval('pollJobs()'); await settle(300);
      if (!NATIVE) { await a.w.eval('acceptOffer()'); await settle(300); }
      srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
      if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
      await settle();
      a.$('scRouteAccepted').querySelector('button:not(.dx-btn)').click(); await settle(300);
      await scanBin(a);
      assert.strictEqual(a.screen(), 'scPickup');
      assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route');
      const pv = look(a.$('tpPickMap'));
      assert.strictEqual(pv.connectors, 0, 'no line in the Route preview');
      assert.deepStrictEqual([...pv.dots, ...pv.off].sort((x, y) => x - y), stops.map((s) => s.stop_number), 'one dot per stop');
      assert.deepStrictEqual(pv.dots, [...pv.dots].sort((x, y) => x - y), 'numbers in route order');
      assert.strictEqual(a.$('tpPickList').querySelectorAll('.tpk-stop').length, n, 'the stop list is still there');
      a.w.eval('tpPickup.showLoad()'); await settle();
      assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'load');
      for (const s of stops) { a.w.eval(`processScan(${JSON.stringify(s.tracking_number)})`); await settle(5); okLoad(a); }
      await settle(1200);
      assert.strictEqual(a.w.eval('tpPickup.state().tab'), 'route');
      assert.strictEqual(a.$('tpPickStart').disabled, false);
      a.$('tpPickStart').click(); await settle(300);
      assert.strictEqual(srv.jobs[0].status, 'in_transit');
      assert.deepStrictEqual(navCalls(a), [], 'no Maps before a stop is started');
      a.w.eval('showRouteMapOverlay()'); await settle(300);                // the Route Map button
      const ov = a.$('routeMapOverlay');
      assert.ok(ov && ov.style.display !== 'none', 'the Route Map opens');
      const o = look(ov);
      assert.strictEqual(o.connectors, 0, 'no line in the Route Map');
      assert.deepStrictEqual([...o.dots, ...o.off].sort((x, y) => x - y), stops.map((s) => s.stop_number));
    } finally { a.close(); }
  });
}

test('TP-ROUTEMAP is the same in both repos and draws no connector line', () => {
  const block = (s) => (s.match(/<!-- TP-ROUTEMAP:BEGIN[\s\S]*?<!-- TP-ROUTEMAP:END -->/) || [''])[0];
  assert.ok(block(HTML).length > 1000);
  assert.ok(!/tprm-line|<polyline/.test(block(HTML)), 'no line drawing left in TP-ROUTEMAP');
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

// Chromium: the real layout (dots placed at real pixel positions)
let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });
for (const n of [2, 30, 75]) {
  test(`Chromium, ${n} stops: no connector line in the Route preview or the Route Map; one numbered dot per stop in route order`, async () => {
    const stops = gen(n);
    const JOB = { id: 'job-1', title: 'Route 7', status: 'assigned', job_type: 'surge', surge_stops: stops, bin_label: '1A', driver_name: 'Dana', archived: false };
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.route(/^https?:\/\//, (r) => {
      let body = '[]';
      try { const act = JSON.parse(r.request().postData() || '{}').p_action;
        if (act === 'job') body = JSON.stringify(JOB); else if (act === 'jobs') body = JSON.stringify([JOB]);
        else if (act === 'bin_binding') body = JSON.stringify([{ bin_code: '1A', state: 'ready', staging_code: 'S-01' }]); } catch (e) {}   // bin staged (v22)
      r.fulfill({ status: 200, contentType: 'application/json', body });
    });
    await p.addInitScript(() => { try { localStorage.setItem('tp_dx_perm_intro', '1');
      localStorage.setItem('tp_drv', JSON.stringify({ id: 'drv-1', name: 'Dana', phone: '4045551234', token: 't' })); } catch (e) {} });
    try {
      await p.goto('file://' + FILE);
      await p.waitForTimeout(2000);
      await p.evaluate((J) => { currentJob = J; surgeStops = J.surge_stops; isSurgeJob = true; currentSurgeStop = 0; startBinScan(); }, JOB);
      await p.waitForTimeout(500);
      await p.evaluate((N) => processScan(N ? 'BIN:1A' : '1A'), NATIVE);
      await p.waitForTimeout(2200);
      const read = (sel) => p.evaluate(([sel, C]) => { const r = document.querySelector(sel); if (!r) return null;
        const dots = Array.from(r.querySelectorAll('.tprm-dot')), q = (e) => e.getBoundingClientRect();
        return { connectors: r.querySelectorAll(C).length, dots: dots.map((d) => +d.dataset.stop), off: Array.from(r.querySelectorAll('.tprm-off b')).map((b) => +b.textContent),
          sizes: Array.from(new Set(dots.filter((d) => !d.classList.contains('st-cur')).map((d) => Math.round(q(d).width)))) }; }, [sel, CONNECTOR]);
      assert.strictEqual(await p.evaluate(() => (document.querySelector('.screen.on') || {}).id), 'scPickup');
      const pv = await read('#tpPickMap');
      assert.strictEqual(pv.connectors, 0, 'no line in the Route preview');
      assert.deepStrictEqual([...pv.dots, ...pv.off].sort((x, y) => x - y), stops.map((s) => s.stop_number));
      assert.deepStrictEqual(pv.dots, [...pv.dots].sort((x, y) => x - y), 'route order');
      assert.ok(pv.dots.length >= Math.min(n, 2), 'the dots are drawn');
      assert.strictEqual(pv.sizes.length, 1, 'dots all the same size');
      await p.evaluate(() => { currentJob.status = 'in_transit'; showRouteMapOverlay(); });
      await p.waitForTimeout(800);
      const ov = await read('#routeMapOverlay');
      assert.strictEqual(ov.connectors, 0, 'no line in the Route Map');
      assert.deepStrictEqual([...ov.dots, ...ov.off].sort((x, y) => x - y), stops.map((s) => s.stop_number));
      assert.deepStrictEqual(ov.dots, [...ov.dots].sort((x, y) => x - y), 'route order');
    } finally { await ctx.close(); }
  });
}
