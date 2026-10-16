const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// Scan camera size (2026-10-11): at pickup (loading) and at delivery the
// camera must get most of the screen on a small and a large phone in
// portrait. Measured in a real browser (jsdom has no layout): the part of the
// camera picture between the panel at the top and the panel at the bottom
// must be at least 60% of the screen height, with Back / Cancel and typed
// entry on screen and tappable. The same file runs in both repos; APP_HTML
// overrides the page under test.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);

const STOPS = [
  { stop_number: 1, recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 2, order_id: '100231', tracking_number: '720431958206', coords: { lat: 33.75, lng: -84.42 },
    pkgs: [{ order_id: '100231', tracking_number: '720431958206', required_count: 1 }, { order_id: '100232', tracking_number: '720431958213', required_count: 1 }] },
  { stop_number: 2, recipient: 'Test B', address: '1 Peachtree St NE', packages: 1, order_id: '100233', tracking_number: '720431958220', coords: { lat: 33.755, lng: -84.39 },
    pkgs: [{ order_id: '100233', tracking_number: '720431958220', required_count: 1 }] }];

let browser;
test.before(async () => { browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']); });
test.after(async () => { if (browser) await browser.close(); });

async function measure(width, height, mode) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  // Nothing leaves the machine: every network request answers empty.
  await p.route(/^https?:\/\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.addInitScript(() => { try { localStorage.setItem('tp_dx_perm_intro', '1'); } catch (e) {} });
  await p.goto('file://' + FILE);
  await p.waitForTimeout(500);
  await p.evaluate(({ mode, STOPS, NATIVE }) => {
    driver = { id: 'drv-1', name: 'Dana', phone: '4045550100', token: 't' };
    currentJob = { id: 'job-1', title: 'Route 7', status: mode === 'pickup' ? 'assigned' : 'in_transit', job_type: 'surge', surge_stops: STOPS, bin_label: '1A', driver_name: 'Dana' };
    surgeStops = STOPS; isSurgeJob = true; currentSurgeStop = 0;
    if (mode === 'pickup') { if (NATIVE) startPackageScan(); else startPackageLoadingVerification(); } else startDeliveryScan();
  }, { mode, STOPS, NATIVE });
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const vh = innerHeight;
    const r = (el) => (el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null);
    const v = r(document.getElementById('scanVideo'));
    const dlv = document.getElementById('dlvScanOverlay').style.display === 'block';
    // What covers the picture: the top bar / panel and the bottom sheet / typed-entry bar.
    const tops = dlv ? ['#tpScanUi .tp-top', '#scScan .scan-top'] : ['#loadPkgOverlay>div', '#scScan .scan-top'];
    const bots = dlv ? ['#dlvScanOverlay>div', '#scScan .scan-bottom'] : ['#scScan .scan-bottom'];
    let top = 0, bottom = vh;
    tops.forEach((s) => { const q = r(document.querySelector(s)); if (q && q.height && q.top < vh / 2) top = Math.max(top, q.bottom); });
    bots.forEach((s) => { const q = r(document.querySelector(s)); if (q && q.height && q.bottom > vh / 2) bottom = Math.min(bottom, q.top); });
    const cam = v ? Math.max(0, Math.min(v.bottom, bottom) - Math.max(v.top, top)) : 0;
    const tappable = (sel) => {
      const e = document.querySelector(sel); if (!e) return false;
      const q = e.getBoundingClientRect(); if (!q.height || q.top < 0 || q.bottom > vh) return false;
      const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return hit === e || e.contains(hit);
    };
    const controls = dlv ? { cancel: tappable('#tpCancelBtn'), typed: tappable('#tpType') }
      : { back: tappable('#loadPkgOverlay [onclick^="cancelPackageScan"]'), typed: tappable('#manualBarcodeInp') };
    return { dlv, cam, pct: cam / vh, videoWidth: v ? v.width : 0, vw: innerWidth, controls };
  });
  await ctx.close();
  return m;
}

for (const [w, h] of [[360, 640], [412, 915]]) {
  for (const mode of ['pickup', 'delivery']) {
    test(`scan camera at ${mode}, ${w}x${h}: at least 60% of the screen height, controls on screen`, async () => {
      const m = await measure(w, h, mode);
      assert.strictEqual(m.dlv, mode === 'delivery', 'the ' + mode + ' scanner opened');
      assert.ok(m.pct >= 0.6, `camera ${Math.round(m.pct * 100)}% of the height (${Math.round(m.cam)}px of ${h})`);
      assert.ok(m.videoWidth >= m.vw - 1, 'video fills the width');
      for (const [k, ok] of Object.entries(m.controls)) assert.ok(ok, k + ' is on screen and tappable');
    });
  }
}
