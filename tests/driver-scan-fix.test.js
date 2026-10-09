const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const Barcodes = require('jsbarcode/bin/barcodes').default;

// Real-world delivery-scan failure (2026-10-09), reproduced and fixed.
// The same file runs in bbrian34/tackpath-driver (native app, www/index.html)
// and bbrian34/tackpath-app (web driver page, driver.html); APP_HTML picks
// the page, SIBLING_HTML the other repo's copy for the drift check.
//
// The manifest: order_id / tracking_number / address
//   100231 / 720431958206 / 260 Manning Rd SW Unit 37
//   100232 / 720431958213 / 260 Manning Rd SW Unit 37
//   100233 / 720431958220 / a second address
// published the way the dispatcher's Build Routes publishes it.

const ROOT = path.join(__dirname, '..');
const NATIVE = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const SIBLING = process.env.SIBLING_HTML || (NATIVE ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const VENDOR = NATIVE ? path.join(ROOT, 'www', 'vendor', 'zxing.min.js') : path.join(ROOT, 'vendor', 'zxing.min.js');
const HTML = fs.readFileSync(FILE, 'utf-8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = [
  { order_id: '100231', tracking_number: '720431958206', recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 1 },
  { order_id: '100232', tracking_number: '720431958213', recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 1 },
  { order_id: '100233', tracking_number: '720431958220', recipient: 'Test B', address: '1 Peachtree St NE', packages: 1 },
];
// dispatcher.html: parseCSV -> buildRoutes (normalizePackage, one stop per
// address) -> route objects -> the published job's surge_stops
function publishedStops(rows) {
  const normalizePackage = (pkg) => ({ piece_id: String(pkg.tracking_number || pkg.order_id || 'PKG'), order_id: pkg.order_id,
    tracking_number: pkg.tracking_number || null, recipient: pkg.recipient, required_count: Math.max(1, parseInt(pkg.packages) || 1) });
  const byAddress = new Map();
  for (const pkg of rows) {
    const key = pkg.address.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!byAddress.has(key)) byAddress.set(key, { address: pkg.address, recipient: pkg.recipient, pkgs: [], packages: 0 });
    const s = byAddress.get(key); s.pkgs.push(normalizePackage(pkg)); s.packages += parseInt(pkg.packages) || 1;
  }
  return Array.from(byAddress.values()).map((s, i) => ({
    order_id: s.pkgs[0].order_id, smart_id: s.pkgs[0].order_id + '-' + (i + 1), tracking_number: s.pkgs[0].tracking_number,
    recipient: s.recipient, address: s.address, packages: s.packages, stop_number: i + 1,
    pkgs: s.pkgs.map((p) => ({ order_id: p.order_id, tracking_number: p.tracking_number, piece_id: p.piece_id, required_count: p.required_count })),
  }));
}
const STOPS = publishedStops(MANIFEST);

function boot({ stop = 0 } = {}) {
  const storage = {};
  const posts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      delete w.speechSynthesis;
      w.Element.prototype.scrollIntoView = () => {};
      w.HTMLMediaElement.prototype.play = async () => {};
      w.fetch = async (url, opts) => {
        const m = String(url).match(/\/rest\/v1\/rpc\/(tp_driver)$/);
        if (m && opts && opts.body) {
          const c = JSON.parse(opts.body);
          if (c.p_action === 'post_message') posts.push(c.p_args);
          const list = ['jobs', 'messages', 'bin_binding', 'update_job', 'claim'].includes(c.p_action);
          return { ok: true, json: async () => (list ? [] : {}), text: async () => (list ? '[]' : '{}') };
        }
        if (opts && opts.method === 'POST' && opts.body) { try { posts.push(JSON.parse(opts.body)); } catch (e) {} }
        return { ok: true, json: async () => ([]), text: async () => '' };
      };
      w.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: {} };
      w.confirm = () => true;
      Object.defineProperty(w.navigator, 'vibrate', { configurable: true, value: () => true });
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
    },
  });
  const w = dom.window;
  w.eval(`
    window._cam = { starts: 0, stops: 0 };
    startCamera = function(){ window._cam.starts++; };
    stopCamera  = function(){ window._cam.stops++; };
    initSig = function(){};
    window._screens = [];
    const _ss = showScreen; showScreen = function(id){ window._screens.push(id); return _ss.apply(this, arguments); };`);
  w.eval(`driver = {name:'Dana Driver', id:'drv-1', token:'driver-session'};
    currentJob = {id:'job-1', job_type:'surge', status:'in_transit', stops_completed:${stop}, title:'Surge Route RT-001'};
    isSurgeJob = true; surgeStops = ${JSON.stringify(STOPS)}; currentSurgeStop = ${stop};
    deliveryScans = new Map(); deliveryDamaged = new Map(); window._deliveryScan = null; window._surgePODMode = false;`);
  const $ = (id) => w.document.getElementById(id);
  return {
    w, posts, $,
    open: () => w.eval('sdAtStop()'),
    scan: (code) => w.eval('processScan(' + JSON.stringify(code) + ')'),
    next: () => { if ($('dlvNextBtn')) w.eval('resumeDeliveryScan()'); },
    result: () => $('dlvScanResult').textContent.replace(/\s+/g, ' ').trim(),
    count: () => $('dlvScanCount').textContent,
    proceed: () => $('dlvProceedBtn'),
    rejected: () => posts.filter((p) => p && typeof p.body === 'string' && p.body.startsWith('SCAN_REJECTED::')).map((p) => JSON.parse(p.body.slice(15))),
    close: () => w.close(),
  };
}

const block = (html) => { const m = html.match(/<!-- TP-SCAN:BEGIN[\s\S]*?<!-- TP-SCAN:END -->/); return m ? m[0] : ''; };
test('the scanner layer is the same in the native app and the web app, and loads once', () => {
  assert.ok(block(HTML).length > 2000);
  assert.strictEqual((HTML.match(/<!-- TP-SCAN:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
  assert.ok(fs.existsSync(VENDOR), 'the barcode library ships with the page (no download at the stop)');
});

test('step 3: the published stop holds both real packages, and the gate expects exactly those codes', () => {
  const a = boot();
  try {
    const pieces = JSON.parse(a.w.eval('JSON.stringify([dsStopPieces(0), dsStopPieces(1)])'));
    assert.deepStrictEqual(pieces[0].map((p) => [p.key, p.required]), [['720431958206', 1], ['720431958213', 1]]);
    assert.deepStrictEqual(pieces[0].map((p) => p.aliases.slice().sort()), [['100231', '720431958206'], ['100232', '720431958213']]);
    assert.deepStrictEqual(pieces[1].map((p) => p.key), ['720431958220']);
  } finally { a.close(); }
});

test('step 2/4: the exact values through the real gate deliver stop 1 (2 packages), one scan each', () => {
  const a = boot();
  try {
    a.open();
    assert.match(a.count(), /0 of 2/);
    a.scan('720431958206');
    assert.match(a.result(), /PACKAGE SCANNED/);
    a.scan('720431958206');                       // same box still in view: paused, not counted twice
    assert.match(a.count(), /1 of 2/);
    a.next();
    a.scan('720431958213');
    assert.match(a.result(), /ALL PACKAGES FOR STOP 1 ACCOUNTED FOR/);
    assert.ok(a.proceed(), 'proof of delivery opens');
    assert.deepStrictEqual(a.rejected(), []);
  } finally { a.close(); }
});

test('the same normalisation for every scan: spaces, line ends, GS, AIM prefix, leading zero', () => {
  for (const read of [' 720431958206\n', '720431958206\r', ']C0720431958206', '\u001d720431958206', '720 431 958 206', '0720431958206', '100231']) {
    const a = boot();
    try {
      a.open();
      a.scan(read);
      assert.match(a.result(), /PACKAGE SCANNED/, JSON.stringify(read));
      assert.match(a.count(), /1 of 2/, JSON.stringify(read));
    } finally { a.close(); }
  }
});

test('a rejected scan shows what was read and why, and is logged once on the job', async () => {
  const a = boot();
  try {
    a.open();
    a.scan('720431958220');                        // stop 2's package at stop 1
    assert.match(a.result(), /WRONG STOP/);
    assert.match(a.result(), /Read 720431958220 · expected one of these 2 packages: 720431958206, 720431958213 · not matched/);
    a.scan('72043195820');                          // a short read is never a partial match
    assert.match(a.result(), /NOT ON THIS ROUTE/);
    assert.match(a.result(), /Read 72043195820 · expected one of these 2 packages/);
    a.scan('720431958220');
    await wait(20);
    const r = a.rejected();
    assert.deepStrictEqual(r.map((x) => [x.stop_number, x.read, x.reason]), [[1, '720431958220', 'wrong_stop'], [1, '72043195820', 'not_on_route']]);
    assert.deepStrictEqual(r[0].expected, ['720431958206', '720431958213']);
    assert.strictEqual(r[0].belongs_to_stop, 2);
    assert.match(a.count(), /0 of 2/);
  } finally { a.close(); }
});

test('"Type the number instead": typed numbers go through the same gate, one per package', () => {
  const a = boot();
  try {
    a.open();
    assert.ok(a.$('tpTypeBtn'), 'the typed-entry button is on the delivery scan screen');
    a.$('tpTypeBtn').click();
    assert.ok(a.w.document.body.classList.contains('tp-typing'));
    const type = (v) => { a.$('tpTypeInp').value = v; a.$('tpTypeGo').click(); };
    type('720431958213');
    assert.match(a.result(), /PACKAGE SCANNED/);
    type('720431958213');
    assert.match(a.count(), /1 of 2/, 'typing it again does not count a second box');
    a.next();
    type('720431958299');
    assert.match(a.result(), /Read 720431958299 .*not matched \(typed\)/);
    assert.strictEqual(a.rejected()[0].source, 'typed');
    type('720431958206');
    assert.ok(a.proceed());
  } finally { a.close(); }
});

test('label damaged is unchanged and still offered next to every package', () => {
  const a = boot();
  try {
    a.open();
    assert.strictEqual(a.$('dlvScanList').querySelectorAll('button').length, 2);
  } finally { a.close(); }
});

test('the camera uses every code in the picture, preferring this stop\'s package', async () => {
  const a = boot();
  try {
    a.open();
    a.w.eval(`
      HTMLCanvasElement.prototype.getContext = function(){ return { drawImage(){}, getImageData(){ return { data: new Uint8ClampedArray(4) }; } }; };
      window.BarcodeDetector = class { static async getSupportedFormats(){ return ['code_128','qr_code']; }
        async detect(){ return [{ rawValue: '720431958220' }, { rawValue: '720431958206' }]; } };
      scanStream = { getVideoTracks(){ return []; }, getTracks(){ return []; } };
      startBarcodeDetector({ readyState: 4, videoWidth: 1280, videoHeight: 720 });`);
    await wait(700);
    assert.match(a.count(), /1 of 2/);
    assert.strictEqual(a.w.eval("deliveryScans.get('0|720431958206')"), 1, 'the stop-1 package counted, not the stop-2 one in the same picture');
    assert.strictEqual(a.w.tpScan.decoder, 'barcode_detector');
    a.w.eval('clearInterval(barcodeInterval)');
  } finally { a.close(); }
});

test('without Code 128 support in BarcodeDetector the page falls back to the bundled reader', async () => {
  const a = boot();
  try {
    a.w.eval(`window._zx = 0; window.BarcodeDetector = class { static async getSupportedFormats(){ return ['qr_code']; } };
      const _z = startZXing; startZXing = function(){ window._zx++; };`);
    await a.w.eval('startBarcodeDetector({ readyState: 4, videoWidth: 10, videoHeight: 10 })');
    assert.strictEqual(a.w._zx, 1);
  } finally { a.close(); }
});

// ── decode test with real Code 128 images of the three values ──
// Each label is the real Code 128 symbol (JsBarcode's encoder), printed at
// 3 px per module with a quiet zone, on a 1280x720 "camera" picture,
// slightly blurred and noisy, with a second barcode (the next stop's) in view.
function cameraImage(code, other) {
  const W = 1280, H = 720, img = new Uint8ClampedArray(W * H * 4);
  const lum = new Float32Array(W * H).fill(196);   // a light parcel / screen around the label
  const draw = (value, x0, y0, scale) => {
    const bits = new Barcodes.CODE128(value, {}).encode().data;
    const quiet = 12 * scale, w = bits.length * scale + 2 * quiet, h = 150;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) lum[y * W + x] = 245;
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1')
      for (let y = y0 + 15; y < y0 + h - 15; y++) for (let x = 0; x < scale; x++) lum[y * W + x0 + quiet + i * scale + x] = 25;
  };
  draw(code, 300, 250, 3);
  if (other) draw(other, 820, 520, 2);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = x > 0 && x < W - 1 ? (lum[i - 1] + 2 * lum[i] + lum[i + 1]) / 4 : lum[i];
    const v = Math.max(0, Math.min(255, l + (rnd() - 0.5) * 24));
    img[i * 4] = v; img[i * 4 + 1] = v; img[i * 4 + 2] = v; img[i * 4 + 3] = 255;
  }
  return { data: img, w: W, h: H };
}
const VALUES = ['720431958206', '720431958213', '720431958220'];

test('step 4 (decode): the old fallback could not read any of the three labels; the fixed reader reads all of them', async () => {
  const ctx = { self: {}, window: {} }; ctx.globalThis = ctx;
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(VENDOR, 'utf-8'), ctx);
  const Z = ctx.ZXing || ctx.self.ZXing || ctx.window.ZXing;
  assert.ok(Z && Z.MultiFormatReader, 'bundled ZXing loads');
  const a = boot();
  try {
    a.w.ZXing = Z;
    for (let k = 0; k < VALUES.length; k++) {
      const im = cameraImage(VALUES[k], VALUES[(k + 1) % 3]);
      // the call the page made before this fix: canvas RGBA bytes handed over as brightness
      let old;
      try { old = new Z.MultiFormatReader().decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(im.data, im.w, im.h)))).getText(); }
      catch (e) { old = null; }
      assert.strictEqual(old, null, 'old fallback reads nothing: ' + VALUES[k]);
      const got = await a.w.tpScan.decodeRGBA(im.data, im.w, im.h);
      assert.ok(got === VALUES[k] || got === VALUES[(k + 1) % 3], 'fixed reader decodes a real label: ' + VALUES[k] + ' -> ' + got);
      const solo = await a.w.tpScan.decodeRGBA(cameraImage(VALUES[k]).data, im.w, im.h);
      assert.strictEqual(solo, VALUES[k]);
    }
  } finally { a.close(); }
});
