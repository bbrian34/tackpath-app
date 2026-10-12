const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// ROUTE MAP ON A REAL MAP (2026-10, v26). The Route Map button and the pickup
// preview (TP-PICKUP) draw the numbered stop dots on OpenStreetMap tiles with
// Leaflet, shipped inside the app (vendor/leaflet, no CDN). The dots stay on
// their coordinates while panning and zooming, all stops fit on open, no line
// between dots, delivered stops are shown done. Offline: the dots on the plain
// background with "Map unavailable offline", never a crash. Tile requests are
// answered here by a stand-in (counted; nothing leaves the machine). Real
// Chromium, the real page; the same file runs in both repos.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const NATIVE = /ArrivalPlugin/.test(fs.readFileSync(FILE, 'utf-8').split('<!-- TP-DX:BEGIN')[0]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PK = (n) => ({ order_id: 'O' + n, tracking_number: 'TN' + n, piece_id: 'TN' + n, required_count: 1 });
const STOPS = [0, 1, 2, 3].map((i) => ({ stop_number: i + 1, recipient: 'R' + (i + 1), address: (100 + i) + ' Main St', packages: 1, order_id: 'O' + i,
  tracking_number: 'TN' + i, coords: { lat: 33.745 + i * 0.012, lng: -84.395 + (i % 2) * 0.015 }, pkgs: [PK(i)] }));

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function page({ offline = false, status = 'in_transit' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const job = { id: 'job-1', title: 'Route 7', status, job_type: 'surge', surge_stops: STOPS, bin_label: '1', driver_name: 'Dana', archived: false };
  const t = { tiles: [], errors: [] };
  p.on('pageerror', (e) => { if (!/ServiceWorkerRegistration/.test(e.message)) t.errors.push(String(e.message)); });   // (file:// in tests has no service worker)
  await p.route(/^https?:\/\//, (r) => {
    const url = r.request().url();
    if (/tile\.openstreetmap\.org/.test(url)) { t.tiles.push({ url, headers: r.request().headers() }); return offline ? r.abort('internetdisconnected') : r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); }
    let body = '[]';
    try { const b = JSON.parse(r.request().postData() || '{}'), a = b.p_action;
      if (a === 'job') body = JSON.stringify(job); else if (a === 'jobs') body = JSON.stringify([job]);
      else if (a === 'update_job') { Object.assign(job, b.p_args.patch || {}); body = JSON.stringify([job]); }
      else if (a === 'bin_binding') body = JSON.stringify([{ bin_code: '1', state: 'ready', staging_code: 'S-01' }]);
      else body = url.includes('/rpc/') ? '{"ok":true}' : '[]'; } catch (e) {}
    return offline ? r.abort('internetdisconnected') : r.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await p.addInitScript((native) => { localStorage.setItem('tp_dx_perm_intro', '1'); localStorage.setItem('tp_drv', JSON.stringify({ id: 'd', name: 'Dana', phone: '4045551234', token: 't' }));
    if (native) window.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: { ArrivalPlugin: { start: async () => {}, stop: async () => {}, overlayStatus: async () => ({ granted: true }), openOverlaySettings: async () => {} },
      AppLauncher: { openUrl: async () => ({ completed: true }) }, LocalNotifications: { requestPermissions: async () => ({ display: 'granted' }), createChannel: async () => {}, registerActionTypes: async () => {}, addListener: () => ({ remove() {} }), schedule: async () => {}, cancel: async () => {} } } }; }, NATIVE);
  await p.goto('file://' + FILE);
  if (offline) await ctx.setOffline(true);
  await p.waitForTimeout(1200);
  await p.evaluate((J) => { currentJob = J; surgeStops = J.surge_stops; isSurgeJob = true; currentSurgeStop = 0;
    loadedPackages = new Map(J.surge_stops.map((s) => [s.tracking_number, 1])); showSurgeRouteMap(); }, job);
  await p.waitForTimeout(300);
  return { p, ctx, t, job, close: () => ctx.close() };
}
// a real stop delivery: start the stop, arrive, scan its package, proof of delivery, then "Route list"
async function deliver(p, i) {
  await p.evaluate((i) => surgeTapStop(i), i); await p.waitForTimeout(900);
  await p.evaluate((n) => { if (n) { onDeepLinkArrived(); } }, NATIVE); await p.waitForTimeout(400);
  await p.evaluate((n) => { if (n) confirmArrival(); else sdAtStop(); }, NATIVE); await p.waitForTimeout(300);
  await p.evaluate((i) => processScan('TN' + i), i); await p.waitForTimeout(300);
  await p.evaluate(() => { const b = document.getElementById('dlvProceedBtn'); if (b) b.click(); dx.choose('front_door'); podPhotoData = 'data:image/jpeg;base64,AAAA'; submitPOD(); });
  await p.waitForTimeout(900);
  await p.evaluate(() => { const b = document.getElementById('dxNextList'); if (b) b.click(); }); await p.waitForTimeout(300);
}
// tap the Route Map button like a finger, and read what the map shows
async function tapRouteMap(p) {
  const pt = await p.evaluate(() => { const b = document.querySelector('#scSurgeMap [onclick^="showRouteMapOverlay"]'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await p.mouse.click(pt[0], pt[1]); await p.waitForTimeout(1200);
  return read(p, '#routeMapOverlay');
}
const read = (p, sel) => p.evaluate((sel) => {
  const root = document.querySelector(sel), ov = document.getElementById('routeMapOverlay');
  const dots = Array.from(root.querySelectorAll('.tprm-dot'));
  return { open: sel !== '#routeMapOverlay' || (ov.classList.contains('on') && getComputedStyle(ov).display !== 'none'),
    dots: dots.map((d) => +d.dataset.stop), states: dots.map((d) => (d.className.match(/st-(\w+)/) || [])[1]),
    tiles: root.querySelectorAll('.leaflet-tile-pane img.leaflet-tile').length,
    tileSrc: (root.querySelector('.leaflet-tile-pane img.leaflet-tile') || {}).src || '',
    attribution: (root.querySelector('.leaflet-control-attribution') || {}).textContent || '',
    lines: root.querySelectorAll('.tprm-line, svg polyline, svg path, svg line').length,
    offline: (root.querySelector('.tprm-offline') || { hidden: true }).hidden ? '' : root.querySelector('.tprm-offline').textContent };
}, sel);

test('a+b. Route Map opens before Start Route, in transit, after stop 1 and after stop 2: dots in route order, delivered ones done', async () => {
  const s = await page({ status: 'assigned' });
  try {
    let m = await tapRouteMap(s.p);
    assert.ok(m.open, 'opens before Start Route'); assert.deepStrictEqual(m.dots, [1, 2, 3, 4]);
    await s.p.evaluate(() => closeRouteMapOverlay());
    await s.p.evaluate(() => { currentJob.status = 'in_transit'; showSurgeRouteMap(); }); await s.p.waitForTimeout(300);
    m = await tapRouteMap(s.p);
    assert.ok(m.open, 'opens in transit'); assert.deepStrictEqual(m.dots, [1, 2, 3, 4]); assert.deepStrictEqual(m.states, ['cur', 'up', 'up', 'up']);
    await s.p.evaluate(() => closeRouteMapOverlay());
    await deliver(s.p, 0);
    m = await tapRouteMap(s.p);
    assert.ok(m.open, 'opens after stop 1'); assert.deepStrictEqual(m.dots, [1, 2, 3, 4], 'numbering kept'); assert.deepStrictEqual(m.states, ['done', 'cur', 'up', 'up']);
    await s.p.evaluate(() => closeRouteMapOverlay());
    await deliver(s.p, 1);
    m = await tapRouteMap(s.p);
    assert.ok(m.open, 'opens after stop 2'); assert.deepStrictEqual(m.states, ['done', 'done', 'cur', 'up']);
    assert.deepStrictEqual(s.t.errors, [], 'no page errors');
  } finally { await s.close(); }
});

test('c+e. a real map: OpenStreetMap tiles with visible attribution under the dots, all stops fitted, no line between dots, few tile requests', async () => {
  const s = await page();
  try {
    const m = await tapRouteMap(s.p);
    assert.ok(m.tiles > 0, 'map tiles drawn');
    assert.match(m.tileSrc, /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    assert.match(m.attribution, /OpenStreetMap/, 'attribution visible');
    assert.strictEqual(m.lines, 0, 'no line between the dots');
    const fit = await s.p.evaluate(() => { const map = tpRouteMap.leaflet(); const b = map.getBounds(); return surgeStops.every((st) => b.contains([st.coords.lat, st.coords.lng])); });
    assert.ok(fit, 'every stop inside the map on open');
    assert.ok(s.t.tiles.length > 0 && s.t.tiles.length <= 40, 'tile requests kept small: ' + s.t.tiles.length);
    assert.ok(s.t.tiles.every((x) => /tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png/.test(x.url)));
  } finally { await s.close(); }
});

test('dots stay on their coordinates while panning and zooming', async () => {
  const s = await page();
  try {
    await tapRouteMap(s.p);
    const off = async () => s.p.evaluate(() => { const map = tpRouteMap.leaflet(), box = map.getContainer().getBoundingClientRect();
      return Array.from(document.querySelectorAll('#routeMapOverlay .tprm-dot')).map((d) => { const st = surgeStops[+d.dataset.i], r = d.getBoundingClientRect();
        const q = map.latLngToContainerPoint([st.coords.lat, st.coords.lng]);
        return Math.hypot(r.left + r.width / 2 - box.left - q.x, r.top + r.height / 2 - box.top - q.y); }); });
    for (const v of await off()) assert.ok(v < 2, 'on its spot: ' + v);
    await s.p.evaluate(() => tpRouteMap.leaflet().panBy([90, -60], { animate: false })); await s.p.waitForTimeout(300);
    for (const v of await off()) assert.ok(v < 2, 'after pan: ' + v);
    await s.p.evaluate(() => { const m = tpRouteMap.leaflet(); m.setZoom(m.getZoom() + 1, { animate: false }); }); await s.p.waitForTimeout(400);
    for (const v of await off()) assert.ok(v < 2, 'after zoom: ' + v);
  } finally { await s.close(); }
});

test('the pickup preview shows the same real map under its dots', async () => {
  const s = await page({ status: 'assigned' });
  try {
    await s.p.evaluate(() => { loadedPackages = new Map(); startBinScan(); }); await s.p.waitForTimeout(400);
    await s.p.evaluate((n) => processScan(n ? 'BIN:1' : '1'), NATIVE); await s.p.waitForTimeout(2300);
    assert.strictEqual(await s.p.evaluate(() => (document.querySelector('.screen.on') || {}).id), 'scPickup');
    await s.p.waitForTimeout(600);
    const m = await read(s.p, '#tpPickMap');
    assert.deepStrictEqual(m.dots, [1, 2, 3, 4]);
    assert.ok(m.tiles > 0, 'tiles under the preview dots'); assert.match(m.attribution, /OpenStreetMap/);
    assert.strictEqual(m.lines, 0);
  } finally { await s.close(); }
});

test('d. offline: the dots on the plain background with "Map unavailable offline", no crash', async () => {
  const s = await page({ offline: true });
  try {
    const m = await tapRouteMap(s.p);
    assert.ok(m.open);
    assert.deepStrictEqual(m.dots, [1, 2, 3, 4]);
    assert.strictEqual(m.offline, 'Map unavailable offline');
    assert.deepStrictEqual(s.t.errors, []);
  } finally { await s.close(); }
});
