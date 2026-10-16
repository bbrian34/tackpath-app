const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// DIRTY PHONE in a real browser (2026-10, v20): the same dirty start as
// dirty-state.test.js, driven in Chromium on the real page. A finished route
// (delivered) is still saved on the phone as in transit, with every package of
// the SAME tracking numbers "loaded" and the old delivery's arrival armed;
// the new route (same packages, same stops) is given to the driver, staged,
// BIN scanned: Route preview with nothing loaded, never Maps, never "you have
// arrived". Same file in both repos (APP_HTML overrides).

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);

const PK = (n) => ({ order_id: 'O' + n, tracking_number: 'TN' + String(n).padStart(4, '0'), piece_id: 'TN' + String(n).padStart(4, '0'), required_count: 1 });
const STOPS = [
  { order_id: 'O1', tracking_number: 'TN0001', recipient: 'Test A', address: '260 Manning Rd SW', packages: 7, stop_number: 1, coords: { lat: 33.7301, lng: -84.4102 }, pkgs: [1, 2, 3, 4, 5, 6, 7].map(PK) },
  { order_id: 'O8', tracking_number: 'TN0008', recipient: 'Test B', address: '1 Peachtree St NE', packages: 5, stop_number: 2, coords: { lat: 33.7550, lng: -84.3900 }, pkgs: [8, 9, 10, 11, 12].map(PK) },
];
const ALL = STOPS.flatMap((s) => s.pkgs.map((p) => p.tracking_number));
const ROUTE = (x) => Object.assign({ title: 'Route 12', job_type: 'surge', archived: false, surge_stops: STOPS, total_stops: 2, total_packages: 12,
  bin_label: '1', driver_name: 'Dana', created_at: new Date().toISOString() }, x);

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function dirtyPhone(ctxName) {
  const srv = { jobs: [ROUTE({ id: 'job-12', status: 'delivered' })], binding: null };
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  // A stand-in backend that answers like tp_driver; nothing leaves the machine.
  await p.route(/^https?:\/\//, (r) => {
    let body = '[]', status = 200;
    try {
      const b = JSON.parse(r.request().postData() || '{}'), a = b.p_args || {};
      const sees = (j) => !j.archived && (j.driver_name === 'Dana' || (j.status === 'pending' && !j.driver_name));
      const byId = (id) => srv.jobs.find((j) => j.id === id);
      switch (b.p_action) {
        case 'me': body = JSON.stringify({ name: 'Dana' }); break;
        case 'jobs': body = JSON.stringify(srv.jobs.filter((j) => sees(j) && (!a.statuses || a.statuses.includes(j.status)) && (!a.mine || j.driver_name === 'Dana')
          && (!a.job_type || (a.job_type === 'not_surge' ? j.job_type !== 'surge' : j.job_type === a.job_type)))); break;
        case 'job': { const j = byId(a.id); if (j && sees(j)) body = JSON.stringify(j); else { status = 400; body = JSON.stringify({ message: 'TP_DENIED' }); } break; }
        case 'claim': { const j = byId(a.id); if (j && j.status === 'pending') { j.status = 'assigned'; j.driver_name = 'Dana'; body = JSON.stringify([j]); } break; }
        case 'update_job': { const j = byId(a.id); if (j) { Object.assign(j, a.patch || {}); body = JSON.stringify([j]); } break; }
        case 'bin_binding': body = JSON.stringify(srv.binding ? [srv.binding] : []); break;
        default: body = r.request().url().includes('/rpc/') ? '{"ok":true}' : '[]';
      }
    } catch (e) {}
    r.fulfill({ status, contentType: 'application/json', body });
  });
  await p.addInitScript(([state, scans, native]) => {
    window.__nat = [];
    window.open = (u) => { window.__nat.push(['window.open', String(u)]); return null; };
    if (native) window.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: {
      ArrivalPlugin: { start: async (o) => { window.__nat.push(['ArrivalPlugin.start']); }, stop: async () => { window.__nat.push(['ArrivalPlugin.stop']); },
        overlayStatus: async () => ({ granted: true }), openOverlaySettings: async () => {} },
      AppLauncher: { openUrl: async (o) => { window.__nat.push(['AppLauncher.openUrl', o.url]); return { completed: true }; } },
      LocalNotifications: { requestPermissions: async () => ({ display: 'granted' }), createChannel: async () => {}, registerActionTypes: async () => {},
        addListener: () => ({ remove() {} }), schedule: async () => {}, cancel: async () => {} } } };
    try {
      if (!sessionStorage.getItem('seeded')) {           // the dirty phone, once
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('tp_dx_perm_intro', '1');
        localStorage.setItem('tp_drv', JSON.stringify({ id: 'drv-1', name: 'Dana', phone: '4045551234', token: 't' }));
        localStorage.setItem('tp_route_state', state); localStorage.setItem('tp_dx_route', scans);
      }
    } catch (e) {}
  }, [JSON.stringify({ currentJob: ROUTE({ id: 'job-12', status: ctxName === 'accepted' ? 'assigned' : 'in_transit' }), surgeStops: STOPS, currentSurgeStop: 1,
    isSurgeJob: true, screenContext: ctxName, savedAt: Date.now() }),
    JSON.stringify({ job: 'job-12', outcomes: {}, startedAt: Date.now(), loaded: ALL.map((c) => [c, 1]) }), NATIVE]);
  await p.goto('file://' + FILE);
  await p.waitForTimeout(2000);
  return { p, srv, close: () => ctx.close() };
}
const nav = (p) => p.evaluate(() => window.__nat.filter((c) => c[0] === 'AppLauncher.openUrl' || c[0] === 'ArrivalPlugin.start'
  || (c[0] === 'window.open' && /google\.com\/maps|google\.navigation/.test(c[1]))));
const look = (p) => p.evaluate(() => ({ screen: (document.querySelector('.screen.on') || {}).id, id: currentJob && currentJob.id,
  tab: tpPickup.state().tab, done: tpPickup.state().progress.done, arrived: (document.getElementById('arrivalPrompt') || {}).style?.display === 'flex',
  start: document.getElementById('tpPickStart') && document.getElementById('tpPickStart').disabled }));

for (const ctxName of ['delivery', 'accepted']) {
  test(`Chromium, dirty ${ctxName}: the new route's BIN scan opens the Route preview with nothing loaded; no Maps, no "you have arrived"`, async () => {
    const s = await dirtyPhone(ctxName);
    try {
      if (NATIVE) { await s.p.evaluate(() => onDeepLinkArrived()); await s.p.waitForTimeout(800); }
      assert.ok(!(await look(s.p)).arrived, 'no "you have arrived" for the finished route');
      s.srv.jobs.push(ROUTE(NATIVE ? { id: 'job-13', status: 'assigned' } : { id: 'job-13', status: 'pending', driver_name: null }));
      for (let i = 0; i < 4 && !['scRouteAccepted', 'scOffer'].includes((await look(s.p)).screen); i++) {
        await s.p.evaluate(() => pollJobs().catch(() => {})); await s.p.waitForTimeout(600);
      }
      if ((await look(s.p)).screen === 'scOffer') { await s.p.evaluate(() => acceptOffer()); await s.p.waitForTimeout(600); }
      let m = await look(s.p);
      assert.strictEqual(m.id, 'job-13', 'the new route is shown (screen ' + m.screen + ', job ' + m.id + ')');
      s.srv.binding = { bin_code: '1', state: 'ready', staging_code: 'S-01' };
      await s.p.evaluate((n) => (n ? tpRefreshStage() : dx.pollStage()), NATIVE); await s.p.waitForTimeout(400);
      await s.p.click('#scRouteAccepted button:not(.dx-btn)'); await s.p.waitForTimeout(600);
      await s.p.evaluate((n) => processScan(n ? 'BIN:1' : '1'), NATIVE); await s.p.waitForTimeout(2300);
      m = await look(s.p);
      assert.strictEqual(m.screen, 'scPickup', 'Route preview, not ' + m.screen);
      assert.strictEqual(m.tab, 'route');
      assert.strictEqual(m.done, 0, 'nothing loaded for the new route');
      assert.strictEqual(m.start, true, 'Start Route off');
      assert.ok(!m.arrived);
      assert.deepStrictEqual(await nav(s.p), [], 'no Google Maps, no arrival service');
      assert.notStrictEqual(s.srv.jobs[0].status, 'in_transit', 'the finished route is not reopened');
    } finally { await s.close(); }
  });
}
