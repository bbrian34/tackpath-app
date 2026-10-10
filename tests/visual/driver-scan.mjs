// End-to-end scan run of the driver page in a real browser (Chromium) at
// phone size, against the same local backend the security tests use (real
// migrations in PGlite, RPCs as anon, the real driver-login handler).
//
// The route is the real-world test manifest, published the way the
// dispatcher's Build Routes publishes it (two packages at stop 1, one at
// stop 2). The camera is a canvas stream showing real Code 128 barcodes
// (drawn by JsBarcode), so the page's own camera loop and decoder read them.
//
//   node tests/visual/driver-scan.mjs [--file ../tackpath-driver/www/index.html]
//        [--zxing offline]      the decoder library cannot be downloaded
//        [--shots dir]          screenshots of the scan screens (412x915)
//
//        [--detector native]    give the page a BarcodeDetector (as Android Chrome has),
//                               built on ZXing here; default: none (the page's own fallback)
// The native app page drives the managed-dispatch flow (route assigned by the
// dispatcher, bin staged by PathIQ). Needs the operations dev dependencies
// (cd operations && npm ci) for Playwright and tests' jsbarcode for the labels.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freshDb, rpc, ORG_A } from '../security/fixture.mjs';
import { handleDriverLogin } from '../../supabase/functions/_shared/tp_security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(ROOT, 'operations/package.json'))('playwright');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FILE = path.resolve(arg('file', path.join(ROOT, 'driver.html')));
const ZXING_MODE = arg('zxing', 'online');
const SHOTS = arg('shots', null);
const ZXING_JS = process.env.ZXING_JS || path.join(ROOT, 'vendor', 'zxing.min.js');
const JSBARCODE_JS = process.env.JSBARCODE_JS || path.join(ROOT, 'tests', 'node_modules', 'jsbarcode', 'dist', 'JsBarcode.all.min.js');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ── the manifest, as uploaded ──
const MANIFEST = [
  { order_id: '100231', tracking_number: '720431958206', recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 1 },
  { order_id: '100232', tracking_number: '720431958213', recipient: 'Test A', address: '260 Manning Rd SW Unit 37', packages: 1 },
  { order_id: '100233', tracking_number: '720431958220', recipient: 'Test B', address: '1 Peachtree St NE', packages: 1 },
];
// ── Build Routes + publish, step for step as dispatcher.html does it ──
function publishedStops(rows) {
  const normalizePackage = (pkg) => ({ piece_id: String(pkg.tracking_number || pkg.order_id || 'PKG'), order_id: pkg.order_id,
    tracking_number: pkg.tracking_number || null, recipient: pkg.recipient, required_count: Math.max(1, parseInt(pkg.packages) || 1) });
  const stopMap = new Map();
  for (const pkg of rows) {
    const key = pkg.address.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!stopMap.has(key)) stopMap.set(key, { address: pkg.address, recipient: pkg.recipient, pkgs: [], packages: 0 });
    const s = stopMap.get(key); s.pkgs.push(normalizePackage(pkg)); s.packages += parseInt(pkg.packages) || 1;
  }
  return Array.from(stopMap.values()).map((s, si) => {
    const primary = s.pkgs[0];
    const st = { ...s, stop_number: si + 1, order_id: primary.order_id, tracking_number: primary.tracking_number,
      smart_id: primary.order_id + '-' + (si + 1), packages: s.packages };
    return { order_id: st.order_id, smart_id: st.smart_id, tracking_number: st.tracking_number || null, recipient: st.recipient,
      address: st.address, packages: st.packages, stop_number: si + 1, coords: null, phone: null, unit: null, access_notes: null,
      gate_code: null, delivery_notes: null, signature_required: false,
      pkgs: st.pkgs.map((p) => ({ order_id: p.order_id, tracking_number: p.tracking_number || null, piece_id: p.piece_id || null, required_count: p.required_count || 1 })) };
  });
}

const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
const stops = publishedStops(MANIFEST);
const pub = await rpc(db, 'publish_surge_route', { payload: { title: 'Surge Route RT-001', master_code: 'TP-ROUTE-TEST01', org_id: ORG_A, surge_stops: stops } }, 'service_role');
const jobId = pub.job.id;
// the dispatcher assigns the route to Dana; PathIQ stages it in bin 1A
await db.query(`update public.jobs set bin_label = '1A', org_id = $2, status = 'assigned', driver_name = 'Dana Driver' where id = $1`, [jobId, ORG_A]);
await db.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, ready_at) values ($2, '1A', 'L-01', $1, 'ready', now())`, [jobId, ORG_A]);
const texts = [];
const deps = {
  rpc: async (fn, a) => { try { return { data: await rpc(db, fn, a, 'service_role') }; } catch (e) { return { error: { message: e.message } }; } },
  sms: async (to, body) => { texts.push({ to, body }); return { ok: true, sid: 'SM' + texts.length }; },
};
const json = (status, data) => ({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } });

const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
await ctx.addInitScript({ content: fs.readFileSync(JSBARCODE_JS, 'utf8') });
const DETECTOR = arg('detector', 'none');   // 'native': a BarcodeDetector like Android Chrome's (built on ZXing here)
if (DETECTOR === 'native') {
  await ctx.addInitScript({ content: fs.readFileSync(ZXING_JS, 'utf8') + ';window.__ZX=window.ZXing;delete window.ZXing;' });
  await ctx.addInitScript(() => {
    const ZX = window.__ZX;
    window.BarcodeDetector = class { constructor(o) { this.formats = (o && o.formats) || []; }
      static async getSupportedFormats() { return ['code_128', 'qr_code', 'ean_13']; }
      async detect(src) {
        const w = src.width, h = src.height; const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.drawImage(src, 0, 0); const d = x.getImageData(0, 0, w, h).data; const L = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        const hints = new Map([[ZX.DecodeHintType.TRY_HARDER, true]]); const r = new ZX.MultiFormatReader(); r.setHints(hints);
        try { const res = r.decodeWithState(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(L, w, h)))); return [{ rawValue: res.getText(), format: 'code_128' }]; } catch (e) { return []; }
      } };
  });
}
await ctx.addInitScript(() => {
  // fake rear camera: a 1280x720 canvas stream; window.__show(code) puts a label in front of it
  const cam = document.createElement('canvas'); cam.width = 1280; cam.height = 720;
  const g = cam.getContext('2d'); const lbl = document.createElement('canvas');
  window.__show = (code) => {
    g.fillStyle = '#c4c6c9'; g.fillRect(0, 0, 1280, 720);
    if (!code) return;
    JsBarcode(lbl, code, { format: 'CODE128', width: 5, height: 160, displayValue: true, fontSize: 26, margin: 40, background: '#ffffff' });
    g.drawImage(lbl, (1280 - lbl.width) / 2, (720 - lbl.height) / 2);
  };
  window.__show(null);
  // keep frames flowing: repaint one pixel of the background every 100 ms
  setInterval(() => { const d = g.getImageData(0, 0, 1, 1); g.putImageData(d, 0, 0); }, 100);
  window.__camRequests = [];
  const fake = async function (c) { window.__camRequests.push(JSON.stringify(c)); if (c && c.audio && !c.video) throw new Error('no mic'); return cam.captureStream(15); };
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, writable: true, value: fake });
  // a phone camera: torch and focus controls
  MediaStreamTrack.prototype.getCapabilities = function () { return { torch: true, focusMode: ['continuous', 'single-shot'] }; };
  MediaStreamTrack.prototype.applyConstraints = async function (c) { (window.__constraints = window.__constraints || []).push(JSON.stringify(c)); };
});
await ctx.route('**/*', async (route) => {
  const req = route.request(); const url = req.url();
  if (url.startsWith('https://app.test/vendor/') && ZXING_MODE !== 'offline') {
    const f = path.join(path.dirname(FILE), new URL(url).pathname);
    return fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f) }) : route.fulfill({ status: 404, body: '' });
  }
  if (url.startsWith('https://app.test/vendor/')) return route.abort('internetdisconnected');
  if (url.startsWith('https://app.test/')) return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(FILE) });
  if (/unpkg\.com\/@zxing\/library/.test(url) || /\/vendor\/zxing/.test(url)) {
    if (ZXING_MODE === 'offline') return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(ZXING_JS) });
  }
  if (url.includes('.supabase.co/')) {
    const body = req.postData() || '{}';
    let m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) { try { return route.fulfill(json(200, await rpc(db, m[1], JSON.parse(body), 'anon'))); } catch (e) { return route.fulfill(json(400, { message: e.message })); } }
    m = url.match(/\/functions\/v1\/([a-z-]+)/);
    if (m && m[1] === 'driver-login') { const out = await handleDriverLogin(new Request('https://x/driver-login', { method: 'POST', body }), deps); return route.fulfill(json(out.status, out.body)); }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    return route.fulfill(json(200, []));
  }
  return route.abort();
});

const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const reads = [];
await page.exposeFunction('__read', (v) => reads.push(v));
const log = (...a) => console.log(...a);
const text = (id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, id);
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return true; await page.waitForTimeout(100); } return false; };
const shot = async (name) => { if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('  screenshot', name + '.png'); } };

await page.goto('https://app.test/driver.html');
await page.evaluate(() => { const o = processScan; processScan = function (b) { window.__read(String(b)); return o.apply(this, arguments); }; });
// sign in with the texted code
await page.fill('#loginPhone', '(404) 555-1234');
await page.evaluate(() => requestCode());
await until(() => document.getElementById('loginPhaseCode').style.display === 'block');
const code = texts[0].body.match(/(\d{6})/)[1];
await page.fill('#loginCode', code);
await page.evaluate(() => verifyCode());
await page.evaluate(() => { const o = processScan; processScan = function (b) { window.__read(String(b)); return o.apply(this, arguments); }; });
log('signed in:', await page.evaluate(() => driver && driver.name));
// the offer, then accept
await page.evaluate(() => { if (!isOnline) toggleOnline(); });
// managed dispatch: the app takes over the route the dispatcher assigned
log('route adopted:', await until(() => !!currentJob && currentJob.status === 'assigned', 20000));
const data = await page.evaluate(() => ({ job_type: currentJob.job_type, stops: surgeStops.map((s) => ({ address: s.address, tracking_number: s.tracking_number,
  pkgs: (s.pkgs || []).map((p) => [p.order_id, p.tracking_number, p.required_count]) })), manifest: dsIsManifestRoute(), pieces: [0, 1].map((i) => dsStopPieces(i)) }));
log('route as the driver app holds it:', JSON.stringify(data));

const scanOnce = async (codeToShow, resultId, ms = 6000) => {
  const before = reads.length;
  await page.evaluate((c) => window.__show(c), codeToShow);
  const ok = await until(() => false, 0) || (await (async () => { const t = Date.now(); while (Date.now() - t < ms) { if (reads.length > before) return true; await page.waitForTimeout(100); } return false; })());
  await page.waitForTimeout(250);
  const res = await text(resultId);
  await page.evaluate(() => window.__show(null));
  return { decoded: ok ? reads.slice(before) : [], result: res };
};
// bin, then loading
await page.evaluate(() => { window.__stops = []; const o = stopCamera; stopCamera = function () { window.__stops.push(new Error().stack.split('\n').slice(1, 4).join(' / ')); return o.apply(this, arguments); }; });
await page.evaluate(() => startBinScan());
log('decoder:', await page.evaluate(() => ('BarcodeDetector' in window) ? 'BarcodeDetector' : 'ZXing (' + (window.ZXing ? 'loaded' : 'not loaded yet') + ')'));
await page.waitForTimeout(1500);
log('camera state:', JSON.stringify(await page.evaluate(() => { const v = document.getElementById('scanVideo'); return { zx: !!window.ZXing, interval: !!barcodeInterval, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, stream: !!scanStream, status: document.getElementById('scanStatus').textContent, stops: window.__stops, cams: window.__camRequests }; })));
if (process.env.DEBUG_FRAME) {
  await page.evaluate(() => window.__show('720431958206')); await page.waitForTimeout(1200);
  const dbg = await page.evaluate(async () => { const c = document.getElementById('scanCanvas'); let det = 'n/a';
    try { det = JSON.stringify(await new BarcodeDetector({ formats: ['code_128'] }).detect(c)); } catch (e) { det = 'ERR ' + e.message; }
    return { det, url: c.toDataURL('image/png'), w: c.width, h: c.height, mode: window._scanMode }; });
  fs.writeFileSync(process.env.DEBUG_FRAME, Buffer.from(dbg.url.split(',')[1], 'base64')); log('debug frame', dbg.w, dbg.h, dbg.det, dbg.mode);
}
let r = await scanOnce('1A', 'binScanLastResult');
log('bin scan 1A ->', JSON.stringify(r));
await until(() => window._scanMode === 'package');
await shot('loading-scan');
if (process.env.DEBUG_FRAME) {
  await page.evaluate(() => window.__show('720431958206')); await page.waitForTimeout(1500);
  const dbg = await page.evaluate(async () => { const c = document.getElementById('scanCanvas'); const v = document.getElementById('scanVideo'); let det = 'n/a';
    try { det = JSON.stringify(await new BarcodeDetector({ formats: ['code_128'] }).detect(c)); } catch (e) { det = 'ERR ' + e.message; }
    return { det, url: c.toDataURL('image/png'), w: c.width, h: c.height, mode: window._scanMode, paused: window._loadPaused, interval: !!barcodeInterval, ready: v.readyState, stream: !!scanStream }; });
  fs.writeFileSync(process.env.DEBUG_FRAME, Buffer.from(dbg.url.split(',')[1], 'base64')); delete dbg.url; log('debug loading frame', JSON.stringify(dbg));
  await page.evaluate(() => window.__show(null));
}
for (const m of MANIFEST) {
  r = await scanOnce(m.tracking_number, 'loadPkgLastScan');
  log('load scan', m.tracking_number, '->', JSON.stringify(r));
  await page.evaluate(() => { if (document.getElementById('loadPkgOkBtn')) resumePackageLoading(); });
}
log('status line:', await text('scanStatus'));
const pickedUp = await until(() => document.getElementById('scPickupComplete').classList.contains('on'), 3000);
log('pickup complete screen:', pickedUp);
await page.evaluate(() => confirmPickup());
await until(() => currentJob.status === 'in_transit');
// stop 1: deliver
await page.evaluate(() => { surgeTapStop(0); sdAtStop(); });
await page.waitForTimeout(400);
await page.evaluate(() => { if (!window._deliveryScan) openSurgePOD(); });
log('delivery gate open:', await page.evaluate(() => !!window._deliveryScan), '|', await text('dlvScanHeading'), '|', await text('dlvScanCount'));
await page.waitForTimeout(600);
await shot('delivery-scan');
r = await scanOnce('720431958220', 'dlvScanResult');
log('delivery scan of the stop-2 package at stop 1 ->', JSON.stringify(r));
await shot('delivery-scan-rejected');
await page.evaluate(() => { if (window.tpScan) { tpScan.openTyping(); document.getElementById('tpTypeInp').value = '7204319582'; } });
await page.waitForTimeout(300);
await shot('delivery-scan-typing');
await page.evaluate(() => { document.body.classList.remove('tp-typing'); document.getElementById('dlvScanResult').innerHTML = ''; if (document.activeElement) document.activeElement.blur(); });
await page.mouse.click(206, 300); await page.waitForTimeout(150);
log('torch button shown:', await page.evaluate(() => { const b = document.getElementById('tpTorchBtn'); return !!b && !b.hidden; }), '| constraints:', await page.evaluate(() => JSON.stringify(window.__constraints || [])));
for (const m of MANIFEST.slice(0, 2)) {
  r = await scanOnce(m.tracking_number, 'dlvScanResult');
  log('delivery scan', m.tracking_number, '->', JSON.stringify(r));
  if (r.decoded.length) await shot('delivery-scan-after-' + m.tracking_number);
  await page.evaluate(() => { if (document.getElementById('dlvNextBtn')) resumeDeliveryScan(); });
}
log('after stop 1:', await text('dlvScanCount'), '| proof of delivery button:', await page.evaluate(() => !!document.getElementById('dlvProceedBtn')));
log('camera requests:', await page.evaluate(() => window.__camRequests.length));
const geo = await page.evaluate(() => { const v = document.getElementById('scanVideo').getBoundingClientRect(); const o = document.getElementById('dlvScanOverlay').firstElementChild.getBoundingClientRect();
  return { video: [Math.round(v.top), Math.round(v.height)], overlayPanel: [Math.round(o.top), Math.round(o.height)], viewport: innerHeight }; });
log('delivery screen geometry (top,height):', JSON.stringify(geo));
if (errors.length) log('page errors:', [...new Set(errors)].slice(0, 5));
await browser.close();
