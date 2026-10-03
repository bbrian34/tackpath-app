const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Delivery scan gate (driver.html): on a manifest (surge) route, proof of
// delivery for a stop opens -- and the stop can close -- only after every
// package for that stop is scanned (or recorded label-damaged).

const FILE = process.env.DRIVER_HTML || path.join(__dirname, '..', 'driver.html');
const HTML = fs.readFileSync(FILE, 'utf-8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTE = [
  // stop 1: one shared barcode, 3 physical boxes
  { order_id: 'ORD-123', tracking_number: 'TRACKING123', recipient: 'Ann', address: '1 A St',
    pkgs: [{ order_id: 'ORD-123', tracking_number: 'TRACKING123', piece_id: 'TRACKING123', required_count: 3 }] },
  // stop 2: three DISTINCT real barcodes
  { order_id: 'ORD-A', tracking_number: 'TNA', recipient: 'Bo', address: '2 B St',
    pkgs: [{ order_id: 'ORD-A', tracking_number: 'TNA', required_count: 1 },
           { order_id: 'ORD-B', tracking_number: 'TNB', required_count: 1 },
           { order_id: 'ORD-C', tracking_number: 'TNC', required_count: 1 }] },
  // stop 3: plain single package
  { order_id: 'ORD-D', tracking_number: 'TND', recipient: 'Cy', address: '3 C St',
    pkgs: [{ order_id: 'ORD-D', tracking_number: 'TND', required_count: 1 }] },
];

function boot({ jobType = 'surge', stops = ROUTE, stop = 0 } = {}) {
  const storage = {};
  const posts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tackpath.com/driver.html', pretendToBeVisual: true,
    beforeParse(w) {
      delete w.speechSynthesis;
      w.Element.prototype.scrollIntoView = () => {};
      w.fetch = async (url, opts) => {
        if (String(url).includes('anthropic.com')) throw new TypeError('offline');   // forces Ruby's keyword path
        if (opts && opts.method) posts.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
        return { ok: true, json: async () => ([]), text: async () => '' };
      };
      w.Capacitor = { isNativePlatform: () => false, Plugins: {} };
      w.confirm = () => true;
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
    const _ss = showScreen; showScreen = function(id){ window._screens.push(id); return _ss.apply(this, arguments); };
  `);
  w.eval(`driver = {name:'Dana', id:'drv-1'};
    currentJob = {id:'job-1', job_type:${JSON.stringify(jobType)}, status:'in_transit', stops_completed:${stop}, title:'Route'};
    isSurgeJob = true; surgeStops = ${JSON.stringify(stops)}; currentSurgeStop = ${stop};
    deliveryScans = new Map(); deliveryDamaged = new Map(); window._deliveryScan = null; window._surgePODMode = false;`);
  const api = {
    w, posts,
    podShown: () => w._screens[w._screens.length - 1] === 'scPOD',
    gateShown: () => w.document.getElementById('dlvScanOverlay') && w.document.getElementById('dlvScanOverlay').style.display === 'block',
    scan: (code) => w.eval('processScan(' + JSON.stringify(code) + ')'),
    type: (code) => { w.document.getElementById('manualBarcodeInp').value = code; w.eval('manualScan()'); },
    next: () => w.eval('resumeDeliveryScan()'),
    result: () => w.document.getElementById('dlvScanResult').textContent.replace(/\s+/g, ' ').trim(),
    count: () => w.document.getElementById('dlvScanCount').textContent,
    proceed: () => w.document.getElementById('dlvProceedBtn'),
    delivered: () => posts.filter((p) => p.body && typeof p.body.body === 'string' && p.body.body.startsWith('STOP_DELIVERED::')),
    jobDeliveredPatch: () => posts.filter((p) => p.method === 'PATCH' && p.body && p.body.status === 'delivered'),
    incidents: () => posts.filter((p) => p.body && typeof p.body.body === 'string' && p.body.body.startsWith('INCIDENT [LABEL_DAMAGED]')),
    close: () => w.close(),
  };
  return api;
}

// ── every path to "delivered" is blocked until the stop is scanned ──
const PATHS = {
  'Mark Arrived (geofence prompt)': (a) => a.w.eval('confirmArrival()'),
  'At Stop button': (a) => a.w.eval('sdAtStop()'),
  'notification "Arrived at Stop"': (a) => a.w.eval('handleArrivedFromNotification()'),
  'map Delivered / Final button': (a) => { a.w.eval('surgeArrived(0,3)'); a.w.eval('openSurgePOD()'); },
  'hidden Scan Package button + any barcode': (a) => { a.w.eval('sdScanPackage()'); a.scan('ANYTHING-123'); },
  'legacy _sdScanMode + any barcode': (a) => { a.w.eval('window._sdScanMode = true'); a.scan('ANYTHING-123'); },
};
for (const [name, go] of Object.entries(PATHS)) {
  test('blocked without a scan: ' + name, () => {
    const a = boot();
    try {
      go(a);
      assert.ok(!a.podShown(), 'proof of delivery must not open');
      assert.ok(a.gateShown(), 'the scan screen opens instead');
      assert.match(a.w.document.getElementById('dlvScanHeading').textContent, /SCAN PACKAGE FOR STOP 1/);
      assert.strictEqual(a.w._surgePODMode, false);
    } finally { a.close(); }
  });
}

test('blocked without a scan: Ruby "delivered" (keyword path) and "done"', async () => {
  for (const phrase of ['delivered', 'done']) {
    const a = boot();
    try {
      await a.w.eval('processRubyCmd(' + JSON.stringify(phrase) + ', false)');
      assert.ok(!a.podShown(), phrase);
      assert.ok(a.gateShown(), phrase);
    } finally { a.close(); }
  }
});

test('blocked without a scan: Ruby open_pod action', async () => {
  const a = boot();
  try {
    await a.w.eval("execRubyAction({action:'open_pod'}, 'delivered', false)");
    await wait(400);
    assert.ok(!a.podShown());
    assert.ok(a.gateShown());
  } finally { a.close(); }
});

test('POD screen reached directly cannot mark the job (or the stop) delivered', async () => {
  const a = boot();
  try {
    a.w.document.getElementById('podRecipient').value = 'Ann';
    a.w.eval("showScreen('scPOD')");               // old Ruby behaviour
    await a.w.eval('submitPOD()');
    assert.strictEqual(a.jobDeliveredPatch().length, 0, 'whole job must not be PATCHed delivered');
    assert.strictEqual(a.delivered().length, 0);
    assert.ok(a.gateShown());
    // and the close function itself refuses
    a.w.eval('window._deliveryScan=null; document.getElementById("dlvScanOverlay").style.display="none"');
    a.w.eval('confirmSurgeStop({recipient:"Ann"})');
    assert.strictEqual(a.delivered().length, 0);
    assert.ok(a.gateShown());
  } finally { a.close(); }
});

// ── counting ──
test('shared barcode: 1 of 3, 2 of 3, 3 of 3 COMPLETE, 4th rejected; then POD unlocks', () => {
  const a = boot();
  try {
    a.w.eval('sdAtStop()');
    assert.strictEqual(a.count(), '0 of 3 packages scanned');
    a.scan('TRACKING123');
    assert.match(a.result(), /PACKAGE SCANNED.*1 OF 3/);
    assert.strictEqual(a.w._cam.stops, 1, 'camera stops after each counted box');
    a.scan('TRACKING123');                                   // camera paused: not counted
    assert.match(a.result(), /Tap NEXT/);
    assert.strictEqual(a.count(), '1 of 3 packages scanned');
    a.next(); a.scan('TRACKING123');
    assert.match(a.result(), /2 OF 3/);
    a.next(); a.scan('TRACKING123');
    assert.match(a.result(), /3 OF 3 · COMPLETE.*ALL PACKAGES FOR STOP 1 ACCOUNTED FOR/);
    assert.ok(!a.podShown(), 'never opens by itself');
    a.scan('TRACKING123');
    assert.match(a.result(), /Tap NEXT|ALREADY SCANNED/);
    a.w.eval('window._deliveryScan.paused=false');
    a.scan('TRACKING123');
    assert.match(a.result(), /ALREADY SCANNED.*ALL 3 OF 3/);
    assert.strictEqual(a.count(), '3 of 3 packages scanned');
    a.proceed().click();
    assert.ok(a.podShown());
    assert.strictEqual(a.w._surgePODMode, true);
  } finally { a.close(); }
});

test('order_id and tracking_number feed one counter', () => {
  const a = boot();
  try {
    a.w.eval('sdAtStop()');
    a.scan('ORD-123'); a.next();
    a.scan('TRACKING123'); a.next();
    a.scan('ORD-123');
    assert.match(a.result(), /3 OF 3 · COMPLETE/);
    assert.strictEqual(a.count(), '3 of 3 packages scanned');
  } finally { a.close(); }
});

test('several distinct barcodes at one stop: every one is required', () => {
  const a = boot({ stop: 1 });
  try {
    a.w.eval('sdAtStop()');
    assert.strictEqual(a.count(), '0 of 3 packages scanned');
    a.scan('TNB'); a.next();
    a.scan('ORD-C'); a.next();
    assert.strictEqual(a.proceed(), null, 'not unlocked with one package missing');
    a.w.eval('openSurgePOD()');
    assert.ok(!a.podShown());
    a.scan('TNA');
    assert.ok(a.proceed());
    a.proceed().click();
    assert.ok(a.podShown());
  } finally { a.close(); }
});

test('wrong-stop package: "This package is for Stop X, not Stop N"', () => {
  const a = boot();
  try {
    a.w.eval('sdAtStop()');
    a.scan('TND');
    assert.match(a.result(), /This package is for Stop 3, not Stop 1/);
    a.scan('ORD-B');
    assert.match(a.result(), /This package is for Stop 2, not Stop 1/);
    assert.strictEqual(a.count(), '0 of 3 packages scanned');
  } finally { a.close(); }
});

test('unknown and prefix barcodes are rejected', () => {
  const a = boot();
  try {
    a.w.eval('sdAtStop()');
    for (const code of ['NOPE-999', 'TRACKING12', 'TRACKING1234', 'TRACKING123#2']) {
      a.scan(code);
      assert.match(a.result(), /NOT ON THIS ROUTE/, code);
    }
    assert.strictEqual(a.count(), '0 of 3 packages scanned');
    assert.strictEqual(a.w._cam.stops, 0);
  } finally { a.close(); }
});

test('typed entry is matched exactly', () => {
  const a = boot({ stop: 2 });
  try {
    a.w.eval('sdAtStop()');
    a.type('TN');                 // prefix
    assert.match(a.result(), /NOT ON THIS ROUTE/);
    a.type('tnd');                // web driver matching is exact, as in pickup loading
    assert.match(a.result(), /NOT ON THIS ROUTE/);
    a.type('TND');
    assert.match(a.result(), /PACKAGE SCANNED/);
    assert.ok(a.proceed());
  } finally { a.close(); }
});

test('label damaged: counts one unit, reports to dispatch, never opens POD or closes the stop', () => {
  const a = boot();
  try {
    a.w.eval('sdAtStop()');
    a.w.eval("dsLabelDamaged('TRACKING123')");
    assert.match(a.result(), /LABEL DAMAGED RECORDED.*1 OF 3/);
    assert.strictEqual(a.count(), '1 of 3 packages scanned');
    const inc = a.incidents();
    assert.strictEqual(inc.length, 1);
    const msg = inc[0].body;
    assert.strictEqual(msg.job_id, 'job-1');
    assert.strictEqual(msg.sender, 'Dana');
    assert.match(msg.body, /Dana · Stop 1 of 3 \(1 A St\) · package TRACKING123 box 1 of 3 .*label damaged.*\d{4}-\d\d-\d\dT/);
    // only packages from this stop's own list can be overridden
    a.w.eval("dsLabelDamaged('TND')");
    a.w.eval("dsLabelDamaged('SOMETHING-ELSE')");
    assert.strictEqual(a.incidents().length, 1);
    // completing the stop by override still requires the driver to proceed
    a.w.eval("dsLabelDamaged('TRACKING123')"); a.w.eval("dsLabelDamaged('TRACKING123')");
    assert.strictEqual(a.count(), '3 of 3 packages scanned');
    a.w.eval("dsLabelDamaged('TRACKING123')");            // beyond required: ignored
    assert.strictEqual(a.incidents().length, 3);
    assert.ok(!a.podShown());
    assert.strictEqual(a.delivered().length, 0);
    a.proceed().click();
    assert.ok(a.podShown());
  } finally { a.close(); }
});

test('full stop: scan, POD, confirm closes it and records the verified count', async () => {
  const a = boot({ stop: 2 });
  try {
    a.w.eval('sdAtStop()');
    a.scan('TND');
    a.proceed().click();
    a.w.document.getElementById('podRecipient').value = 'Cy';
    await a.w.eval('submitPOD()');
    const d = a.delivered();
    assert.strictEqual(d.length, 1);
    const rec = JSON.parse(d[0].body.body.replace('STOP_DELIVERED::', ''));
    assert.strictEqual(rec.stop_number, 3);
    assert.strictEqual(rec.packages_verified, 1);
    assert.strictEqual(rec.label_damaged_units, 0);
  } finally { a.close(); }
});

test('on-demand (sprint) jobs are unaffected: At Stop and Ruby go straight to POD', async () => {
  const a = boot({ jobType: 'single', stops: [
    { order_id: 'abcd1234-P', recipient: 'Pickup', address: 'X', job_type: 'sprint_pickup' },
    { order_id: 'abcd1234-D', recipient: 'Drop', address: 'Y', job_type: 'sprint' }] });
  try {
    a.w.eval('sdAtStop()');
    assert.ok(a.podShown());
    assert.ok(!a.gateShown());
    a.w.eval("showScreen('scHome')");
    await a.w.eval("processRubyCmd('delivered', false)");
    assert.ok(a.podShown());
    assert.ok(!a.gateShown());
  } finally { a.close(); }
});
