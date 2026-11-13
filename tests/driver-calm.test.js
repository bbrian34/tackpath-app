const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// LESS CLUTTER AT A STOP (TP-CALM, 2026-11). One main action per screen and ONE Problem menu,
// like the delivery apps drivers know. Visible controls are counted in real Chromium on the stop,
// scan and proof-of-delivery screens; every action moved into the menu still works from it.
// (Setup below shared with the route-map test.) ROUTE MAP ON A REAL MAP (2026-10, v26). The Route Map button and the pickup
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
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 33.78, longitude: -84.41, accuracy: 10 } });
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

const visible = (p) => p.evaluate(() => [...document.querySelectorAll('button, a[role=button]')].filter((b) => {
  const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.top < innerHeight && r.bottom > 0 && !b.closest('#dxSheet');
}).map((b) => (b.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
const menu = (p) => p.evaluate(() => [...document.querySelectorAll('#tpCalmMenu button')].map((b) => b.firstChild.textContent.trim()));
async function atStop(p) {
  const c = await p.evaluate(() => surgeStops[0].coords); await p.context().setGeolocation({ latitude: c.lat, longitude: c.lng, accuracy: 10 });
  await p.evaluate(() => surgeTapStop(0)); await p.waitForTimeout(900);
}

test('stop screen: Navigate, Deliver and one Problem button; Message, Ruby and Can\'t continue are in the Problem menu', async () => {
  const s = await page(); try {
    await atStop(s.p);
    const v = await visible(s.p);
    for (const gone of ['Ruby', 'Message', "Can't continue"]) assert.ok(!v.some((t) => t.includes(gone)), gone + ' is not on the stop screen: ' + v.join(' | '));
    assert.ok(v.some((t) => /Navigate/.test(t)) && v.includes('Deliver ›') && v.filter((t) => t === 'Problem').length === 1, v.join(' | '));
    await s.p.click('#dxProblemBtn'); await s.p.waitForTimeout(200);
    const m = await menu(s.p);
    assert.deepStrictEqual(m, ["Can't deliver this stop", 'Message dispatch', 'Ruby (voice help)', "Can't continue the route", 'Close']);
    // a menu entry does what the old button did: Can't continue opens the same panel
    await s.p.evaluate(() => [...document.querySelectorAll('#tpCalmMenu button')].find((b) => /continue/.test(b.textContent)).click()); await s.p.waitForTimeout(200);
    assert.ok(await s.p.$('#tpCantPanel'), "Can't continue panel opens");
    await s.p.click('#tpCantCancel');
    // Can't deliver opens the existing problem reasons
    await s.p.click('#dxProblemBtn'); await s.p.waitForTimeout(150);
    await s.p.evaluate(() => [...document.querySelectorAll('#tpCalmMenu button')].find((b) => /deliver this stop/.test(b.textContent)).click()); await s.p.waitForTimeout(200);
    assert.match(await s.p.evaluate(() => document.querySelector('#dxSheet h3').textContent), /What went wrong at stop 1/);
    assert.deepStrictEqual(s.t.errors, []);
  } finally { await s.close(); }
});

test('scan screen: Cancel, the typed number and one Problem button; Label damaged is in the menu and still counts the box', async () => {
  const s = await page(); try {
    await atStop(s.p);
    await s.p.evaluate((n) => { if (n) { onDeepLinkArrived(); confirmArrival(); } else sdAtStop(); }, NATIVE); await s.p.waitForTimeout(600);
    const v = await visible(s.p);
    for (const gone of ['Label damaged', 'Problem? Tell dispatch', "Can't continue"]) assert.ok(!v.includes(gone), gone + ' is not on the scan screen: ' + v.join(' | '));
    assert.ok(v.includes('Cancel') && v.includes('Check') && v.filter((t) => t === 'Problem').length === 1, v.join(' | '));
    await s.p.click('#tpCalmProbScan'); await s.p.waitForTimeout(200);
    assert.deepStrictEqual(await menu(s.p), ["Can't deliver this stop", "Label damaged or won't scan", 'Message dispatch', "Can't continue the route", 'Close']);
    s.p.once('dialog', (d) => d.accept());
    await s.p.evaluate(() => [...document.querySelectorAll('#tpCalmMenu button')].find((b) => /Label damaged/.test(b.textContent)).click()); await s.p.waitForTimeout(500);
    assert.ok(await s.p.evaluate(() => /1 of 1|ACCOUNTED|PROOF OF DELIVERY/i.test(document.getElementById('dlvScanOverlay').innerText)), 'the box is counted');
    assert.deepStrictEqual(s.t.errors, []);
  } finally { await s.close(); }
});

test('proof of delivery: two usual choices, the photo and Confirm; the rest under More options; Problem in the corner', async () => {
  const s = await page(); try {
    await atStop(s.p);
    await s.p.evaluate((n) => { if (n) { onDeepLinkArrived(); confirmArrival(); } else sdAtStop(); }, NATIVE); await s.p.waitForTimeout(500);
    await s.p.evaluate(() => processScan('TN0')); await s.p.waitForTimeout(400);
    await s.p.evaluate(() => document.getElementById('dlvProceedBtn').click()); await s.p.waitForTimeout(600);
    let v = await visible(s.p);
    for (const gone of ['Mailroom', 'Back door', 'Signature', "Can't continue", 'Can’t deliver? Report a problem']) assert.ok(!v.some((t) => t.includes(gone)), gone + ' hidden: ' + v.join(' | '));
    for (const want of ['Handed to customer', 'Front door', 'More options', 'Problem']) assert.ok(v.some((t) => t.includes(want)), want + ' shown: ' + v.join(' | '));
    assert.ok(!(await s.p.isVisible('#podNotes')) && !(await s.p.isVisible('#podRecipient')), 'notes and name under More options');
    await s.p.click('#tpCalmMore'); await s.p.waitForTimeout(200);
    v = await visible(s.p);
    for (const want of ['Mailroom', 'Back door', 'Signature']) assert.ok(v.some((t) => t.includes(want)), want + ' under More options');
    assert.ok(await s.p.isVisible('#podNotes'), 'notes under More options');
    // delivering still works the usual way
    await s.p.evaluate(() => { dx.choose('front_door'); podPhotoData = 'data:image/jpeg;base64,AAAA'; submitPOD(); }); await s.p.waitForTimeout(900);
    assert.ok(await s.p.evaluate(() => !document.getElementById('scPOD').classList.contains('on')), 'stop completed');
    assert.ok(!(await s.p.evaluate(() => document.body.classList.contains('tp-calm-more'))), 'More options closes after the stop');
    assert.deepStrictEqual(s.t.errors, []);
  } finally { await s.close(); }
});

test('one notice at a time: a new notice replaces the old one on screen', async () => {
  const s = await page(); try {
    await s.p.evaluate(() => { toast('First'); toast('Second'); toast('Third'); }); await s.p.waitForTimeout(100);
    assert.deepStrictEqual(await s.p.evaluate(() => [...document.querySelectorAll('#tw .toast')].filter((t) => getComputedStyle(t).display !== 'none').map((t) => t.textContent)), ['✓ Third']);
  } finally { await s.close(); }
});
