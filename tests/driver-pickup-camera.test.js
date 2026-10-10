const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// Pickup Load tab camera (2026-10-12): after the bin scan, the Load tab adds
// the Route / Load tabs and the "N of M loaded" line to the scanner's top
// panel; the TP-SCAN camera must still get at least 60% of the screen height
// on a small and a large phone, with Back, the tabs and typed entry on screen
// and tappable. Real browser (jsdom has no layout). Same file in both repos.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);

const STOPS = Array.from({ length: 12 }, (_, i) => ({ stop_number: i + 1, recipient: 'Recipient ' + (i + 1), address: (100 + i) + ' Peachtree St NE',
  order_id: 'O' + i, tracking_number: '7204319582' + String(i).padStart(2, '0'), coords: { lat: 33.70 + (i % 4) * 0.015, lng: -84.45 + Math.floor(i / 4) * 0.02 },
  pkgs: [{ order_id: 'O' + i, tracking_number: '7204319582' + String(i).padStart(2, '0'), required_count: 1 }] }));
const JOB = { id: 'job-1', title: 'Route 7', status: 'assigned', job_type: 'surge', surge_stops: STOPS, bin_label: '1A', driver_name: 'Dana', archived: false };

let browser;
test.before(async () => { browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']); });
test.after(async () => { if (browser) await browser.close(); });

async function loadTab(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  // Nothing leaves the machine: a stand-in backend that knows this one route.
  await p.route(/^https?:\/\//, (r) => {
    let body = '[]';
    try { const a = JSON.parse(r.request().postData() || '{}').p_action;
      if (a === 'job') body = JSON.stringify(JOB); else if (a === 'jobs') body = JSON.stringify([JOB]);
      else if (a === 'bin_binding') body = JSON.stringify([{ bin_code: '1A', state: 'ready' }]); } catch (e) {}
    r.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await p.addInitScript(() => { try { localStorage.setItem('tp_dx_perm_intro', '1');
    localStorage.setItem('tp_drv', JSON.stringify({ id: 'drv-1', name: 'Dana', phone: '4045551234', token: 't' })); } catch (e) {} });
  await p.goto('file://' + FILE);
  await p.waitForTimeout(2500);
  await p.evaluate((J) => { currentJob = J; surgeStops = J.surge_stops; isSurgeJob = true; currentSurgeStop = 0; startBinScan(); }, JOB);
  await p.waitForTimeout(500);
  await p.evaluate((N) => processScan(N ? 'BIN:1A' : '1A'), NATIVE);
  await p.waitForTimeout(2000);
  const route = await p.evaluate(() => (document.querySelector('.screen.on') || {}).id);
  await p.evaluate(() => tpPickup.showLoad());
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const vh = innerHeight, r = (el) => (el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null);
    const v = r(document.getElementById('scanVideo')), top = r(document.querySelector('#loadPkgOverlay>div')), bot = r(document.querySelector('#scScan .scan-bottom'));
    const cam = v ? Math.max(0, Math.min(v.bottom, bot ? bot.top : vh) - Math.max(v.top, top ? top.bottom : 0)) : 0;
    const tappable = (sel) => {
      const e = document.querySelector(sel); if (!e) return false;
      const q = e.getBoundingClientRect(); if (!q.height || q.top < 0 || q.bottom > vh) return false;
      const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return hit === e || e.contains(hit);
    };
    return { cam, pct: cam / vh, count: (document.getElementById('tpPickCount') || {}).textContent,
      controls: { back: tappable('#loadPkgOverlay [onclick^="cancelPackageScan"]'), route: tappable('#loadPkgOverlay [data-tab="route"]'), typed: tappable('#manualBarcodeInp') } };
  });
  await ctx.close();
  return Object.assign(m, { route });
}

for (const [w, h] of [[360, 640], [412, 915]]) {
  test(`pickup Load tab at ${w}x${h}: camera at least 60% of the screen height, tabs and controls tappable`, async () => {
    const m = await loadTab(w, h);
    assert.strictEqual(m.route, 'scPickup', 'the bin scan opened the Route tab');
    assert.strictEqual(m.count, '0 of 12 loaded');
    assert.ok(m.pct >= 0.6, `camera ${Math.round(m.pct * 100)}% of the height (${Math.round(m.cam)}px of ${h})`);
    for (const [k, ok] of Object.entries(m.controls)) assert.ok(ok, k + ' is on screen and tappable');
  });
}
