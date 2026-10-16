const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Route map of numbered stops (2026-10-11), the TP-ROUTEMAP block: identical
// in tackpath-driver www/index.html (native app) and tackpath-app driver.html
// (web). The same file runs in both repos; APP_HTML is the page under test,
// SIBLING_HTML the other repo's copy for the drift check. The Route Map button
// shows one numbered dot per delivery stop (not per package); stops without a
// spot are listed under "Not on map", so dots + not on map = stops.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const SIBLING = process.env.SIBLING_HTML || (NATIVE_REPO ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (s) => (s.match(/<!-- TP-ROUTEMAP:BEGIN[\s\S]*?<!-- TP-ROUTEMAP:END -->/) || [''])[0];

const stop = (n, coords, pkgs) => ({ order_id: 'O-' + n, tracking_number: 'TN' + n, recipient: 'Recipient ' + n, address: n + ' Test St',
  stop_number: n, coords, pkgs: pkgs || [{ order_id: 'O-' + n, tracking_number: 'TN' + n, piece_id: 'TN' + n, required_count: 1 }] });
// Stop 1 has two packages (two barcodes): still one stop, one dot.
const TWO = [stop(1, { lat: 33.7301, lng: -84.4102 }, [
  { order_id: 'O-1', tracking_number: 'TN1', piece_id: 'TN1', required_count: 1 },
  { order_id: 'O-1b', tracking_number: 'TN1b', piece_id: 'TN1b', required_count: 1 }]),
  stop(2, { lat: 33.7550, lng: -84.3900 })];
const FIFTY = Array.from({ length: 50 }, (_, i) => stop(i + 1, { lat: 33.70 + (i % 7) * 0.012, lng: -84.45 + Math.floor(i / 7) * 0.014 }));

const opened = [];   // every page is closed at the end, also when a test fails
test.after(() => opened.forEach((w) => { try { w.close(); } catch (e) {} }));

function boot() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], speaking: false, pending: false };
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} } });
      // No backend: every request answers empty, so a geocode finds nothing.
      w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
      const storage = {};
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } } });
    },
  });
  opened.push(dom.window);
  return dom.window;
}

async function openMap(stops, cur) {
  const w = boot();
  w.__stops = stops;
  w.eval(`currentJob={id:'job-1',status:'in_transit',job_type:'surge'};surgeStops=window.__stops;isSurgeJob=true;currentSurgeStop=${cur || 0};
    if(typeof loadMapsApi==='function')loadMapsApi=function(){return Promise.reject(new Error('offline'));};`);
  w.showRouteMapOverlay();
  await wait(50);
  const dots = [...w.document.querySelectorAll('#routeMapOverlay .tprm-dot')];
  const off = [...w.document.querySelectorAll('#routeMapOverlay #tprmOff b')];
  return { w, dots, labels: dots.map((d) => d.textContent.trim()), off: off.map((b) => b.textContent.trim()) };
}

test('the TP-ROUTEMAP block is the same in the native app and the web app, and loads once', () => {
  assert.ok(block(HTML).length > 1000, 'TP-ROUTEMAP block present');
  assert.strictEqual((HTML.match(/<!-- TP-ROUTEMAP:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

test('a 2-stop route shows exactly 2 dots labelled 1 and 2; the stop with 2 packages is one dot', async () => {
  const { w, dots, labels, off } = await openMap(TWO);
  assert.ok(w.document.getElementById('routeMapOverlay').classList.contains('on'), 'the Route Map opens');
  assert.deepStrictEqual(labels, ['1', '2']);
  assert.deepStrictEqual(off, []);
  assert.strictEqual(dots.length + off.length, TWO.length, 'dots + not on map = stops');
  dots[0].click();
  const card = w.document.getElementById('tprmCard').textContent;
  assert.match(card, /Stop 1/); assert.match(card, /Recipient 1/); assert.match(card, /1 Test St/); assert.match(card, /2 packages/);
  w.close();
});

test('a 50-stop route shows 50 dots labelled 1-50, each fitted inside the map', async () => {
  const { w, dots, labels, off } = await openMap(FIFTY);
  assert.deepStrictEqual(labels, FIFTY.map((s) => String(s.stop_number)));
  assert.strictEqual(dots.length + off.length, 50);
  const ww = w.innerWidth, hh = w.innerHeight;
  for (const d of dots) {
    const x = parseFloat(d.style.left), y = parseFloat(d.style.top);
    assert.ok(x >= 0 && x <= ww && y >= 0 && y <= hh, 'dot ' + d.textContent + ' in view (' + x + ',' + y + ')');
  }
  w.close();
});

test('a stop without coordinates is listed under "Not on map"; dots + not on map = stops', async () => {
  const stops = [TWO[0], stop(2, null), TWO[1]].map((s, i) => Object.assign({}, s, { stop_number: i + 1 }));
  const { w, labels, off } = await openMap(stops);
  await wait(100);
  const now = [...w.document.querySelectorAll('#tprmOff b')].map((b) => b.textContent.trim());
  assert.deepStrictEqual(labels, ['1', '3']);
  assert.deepStrictEqual(off, ['2']); assert.deepStrictEqual(now, ['2']);
  assert.match(w.document.getElementById('tprmOff').textContent, /Not on map/);
  assert.strictEqual(w.document.querySelectorAll('.tprm-dot').length + now.length, stops.length);
  w.close();
});

test('done, current and upcoming stops look different (done gray with a check, current highlighted)', async () => {
  const stops = FIFTY.slice(0, 5);
  const { w, dots } = await openMap(stops, 2);
  const cls = dots.map((d) => (d.className.match(/st-(\w+)/) || [])[1]);
  assert.deepStrictEqual(cls, ['done', 'done', 'cur', 'up', 'up']);
  // the colour each state gets from the page's own stylesheet (jsdom has no layout)
  const rules = [...w.document.styleSheets].flatMap((sh) => [...sh.cssRules]);
  const bg = (sel) => (rules.find((r) => r.selectorText === '#routeMapOverlay ' + sel) || { style: {} }).style.backgroundColor;
  const done = bg('.tprm-dot.st-done'), cur = bg('.tprm-dot.st-cur'), up = bg('.tprm-dot');
  assert.ok(done && cur && up, 'each state has a colour');
  assert.notStrictEqual(done, cur); assert.notStrictEqual(cur, up); assert.notStrictEqual(done, up);
  assert.match(block(HTML), /\.tprm-dot\.st-done::after\{content:'\\2713'/, 'done dots carry a check');
  w.close();
});

test('the old directions map is not loaded; closing works as before', async () => {
  const { w } = await openMap(TWO);
  assert.strictEqual(w.document.getElementById('routeMapFrame').getAttribute('src') || '', '');
  w.closeRouteMapOverlay();
  assert.ok(!w.document.getElementById('routeMapOverlay').classList.contains('on'));
  w.close();
});
