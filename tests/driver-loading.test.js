const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Driver package-loading verification with multi-piece packages.
// A pkgs[] entry is one real barcode; required_count is how many physical
// packages share it. Mirrors tests/stow.test.js for PathIQ.
//
// Own loader (not helpers.loadApp): driver.html calls
// Capacitor.isNativePlatform(), which the shared helper's stub lacks.

const HTML = fs.readFileSync(path.join(__dirname, '..', 'driver.html'), 'utf-8');

function boot() {
  const storage = {};
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tackpath.com/driver.html', pretendToBeVisual: true,
    beforeParse(w) {
      delete w.speechSynthesis;
      w.Element.prototype.scrollIntoView = () => {};
      w.fetch = async () => ({ ok: true, json: async () => ([]), text: async () => '' });
      w.Capacitor = { isNativePlatform: () => false, Plugins: {} };
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
    },
  });
  const w = dom.window;
  // No camera in jsdom: record calls instead of opening one.
  w.eval(`
    window._cam = { starts: 0, stops: 0 };
    startCamera = function(){ window._cam.starts++; };
    stopCamera  = function(){ window._cam.stops++; };
    showPickupCompleteScreen = function(){ window._pickupComplete = true; window._loadingPackages = false; };
  `);
  const setStops = (stops) => w.eval('surgeStops = ' + JSON.stringify(stops) + '; loadedCounts = new Map(); window._loadingPackages = true; window._pickupComplete = false;');
  const scan = (code) => { w.eval('processScan(' + JSON.stringify(code) + ')'); };
  const last = () => w.document.getElementById('loadPkgLastScan').textContent.replace(/\s+/g, ' ').trim();
  const count = () => w.document.getElementById('loadPkgCount').textContent;
  const ok = () => w.eval('resumePackageScanning()');
  return { w, setStops, scan, last, count, ok, close: () => w.close() };
}

const ROUTE = [
  // stop 1: one shared barcode, 3 physical boxes
  { order_id: 'ORD-123', tracking_number: 'TRACKING123', address: '1 A St',
    pkgs: [{ order_id: 'ORD-123', tracking_number: 'TRACKING123', piece_id: 'TRACKING123', required_count: 3 }] },
  // stop 2: three DISTINCT real barcodes at one address
  { order_id: 'ORD-A', tracking_number: 'TNA', address: '2 B St',
    pkgs: [{ order_id: 'ORD-A', tracking_number: 'TNA', piece_id: 'TNA', required_count: 1 },
           { order_id: 'ORD-B', tracking_number: 'TNB', piece_id: 'TNB', required_count: 1 },
           { order_id: 'ORD-C', tracking_number: 'TNC', piece_id: 'TNC', required_count: 1 }] },
  // stop 3: older row with no required_count -> 1
  { order_id: 'ORD-D', tracking_number: 'TND', address: '3 C St',
    pkgs: [{ order_id: 'ORD-D', tracking_number: 'TND', piece_id: 'TND' }] },
];

test('expected total sums required_count, not stops or pkgs[] entries', () => {
  const a = boot();
  try {
    a.setStops(ROUTE);
    assert.strictEqual(a.w.eval('realPackageTotal()'), 3 + 3 + 1);
    a.w.eval('updateLoadingUI()');
    assert.strictEqual(a.count(), '0 of 7 packages scanned');
  } finally { a.close(); }
});

test('shared barcode qty 3: 1 of 3, 2 of 3, 3 of 3 COMPLETE, 4th rejected', () => {
  const a = boot();
  try {
    a.setStops(ROUTE);
    a.scan('TRACKING123');
    assert.match(a.last(), /PACKAGE VERIFIED.*STOP 1.*1 OF 3.*SCAN THE NEXT BOX/);
    assert.strictEqual(a.count(), '1 of 7 packages scanned');
    // camera stops after each counted box so one label is never read twice
    assert.strictEqual(a.w._cam.stops, 1);
    assert.strictEqual(a.w._loadingPackages, false);
    a.scan('TRACKING123');                           // camera off: nothing counted
    assert.strictEqual(a.count(), '1 of 7 packages scanned');
    a.ok();
    assert.strictEqual(a.w._loadingPackages, true);
    a.scan('TRACKING123');
    assert.match(a.last(), /2 OF 3/);
    a.ok();
    a.scan('TRACKING123');
    assert.match(a.last(), /3 OF 3 · COMPLETE/);
    assert.doesNotMatch(a.last(), /NEXT BOX/);
    a.ok();
    a.scan('TRACKING123');
    assert.match(a.last(), /PACKAGE ALREADY VERIFIED.*ALL 3 OF 3 SCANNED/);
    assert.strictEqual(a.count(), '3 of 7 packages scanned');
    assert.strictEqual(a.w.eval('loadedCounts.get("TRACKING123")'), 3);
  } finally { a.close(); }
});

test('order_id and tracking_number are aliases feeding one counter', () => {
  const a = boot();
  try {
    a.setStops(ROUTE);
    a.scan('ORD-123'); assert.match(a.last(), /1 OF 3/); a.ok();
    a.scan('TRACKING123'); assert.match(a.last(), /2 OF 3/); a.ok();
    a.scan('ORD-123'); assert.match(a.last(), /3 OF 3 · COMPLETE/); a.ok();
    a.scan('TRACKING123'); assert.match(a.last(), /ALREADY VERIFIED/);
    a.scan('ORD-123'); assert.match(a.last(), /ALREADY VERIFIED/);
    assert.strictEqual(a.w.eval('loadedCounts.size'), 1);
    assert.strictEqual(a.count(), '3 of 7 packages scanned');
    // qty-1 package: the second alias is a duplicate, not a second package
    a.scan('ORD-A'); a.ok();
    a.scan('TNA');
    assert.match(a.last(), /PACKAGE ALREADY VERIFIED/);
    assert.strictEqual(a.count(), '4 of 7 packages scanned');
  } finally { a.close(); }
});

test('distinct real barcodes at one stop each match and complete independently', () => {
  const a = boot();
  try {
    a.setStops(ROUTE);
    for (const code of ['TNB', 'ORD-C', 'TNA']) {   // 2nd/3rd barcodes never matched before
      a.scan(code);
      assert.match(a.last(), /PACKAGE VERIFIED.*STOP 2/, code);
      assert.doesNotMatch(a.last(), / OF /);        // no piece counter for qty 1
      a.ok();
    }
    assert.strictEqual(a.count(), '3 of 7 packages scanned');
    a.scan('TNB');
    assert.match(a.last(), /PACKAGE ALREADY VERIFIED/);
  } finally { a.close(); }
});

test('unknown barcode is rejected; prefix of a real barcode is not a match', () => {
  const a = boot();
  try {
    a.setStops(ROUTE);
    a.w.eval('updateLoadingUI()');
    for (const code of ['NOT-ON-ROUTE', 'TRACKING12', 'TRACKING1234', 'TRACKING123#2', 'tracking123']) {
      a.scan(code);
      assert.match(a.last(), /WRONG PACKAGE.*NOT ON THIS ROUTE/, code);
    }
    assert.strictEqual(a.count(), '0 of 7 packages scanned');
    assert.strictEqual(a.w._cam.stops, 0);
  } finally { a.close(); }
});

test('required_count 1 everywhere behaves exactly as before, and completes the route', () => {
  const a = boot();
  try {
    // Plain one-package stops, including a stop with no pkgs[] (sprint/older routes)
    a.setStops([
      { order_id: 'AB1', address: 'x', pkgs: [{ order_id: 'AB1', tracking_number: null, required_count: 1 }] },
      { order_id: 'AB12', address: 'y' },
    ]);
    assert.strictEqual(a.w.eval('realPackageTotal()'), 2);
    a.scan('AB1');
    // Byte-for-byte the markup the pre-change code produced for a verified package
    const ORIGINAL = '<div style="color:#4ade80;font-weight:900;font-size:1.3rem;">&#10003; PACKAGE VERIFIED</div>'
      + '<div style="color:#fff;font-weight:900;font-size:1.9rem;margin-top:6px;">STOP 1</div>'
      + '<button onclick="resumePackageScanning()" style="margin-top:14px;padding:12px 32px;border-radius:12px;background:#fff;color:#111;font-weight:900;font-size:1rem;border:none;cursor:pointer;">OK</button>';
    const tmp = a.w.document.createElement('div'); tmp.innerHTML = ORIGINAL;
    assert.strictEqual(a.w.document.getElementById('loadPkgLastScan').innerHTML, tmp.innerHTML);
    a.ok();
    a.scan('AB1');
    assert.strictEqual(a.last(), 'PACKAGE ALREADY VERIFIED');
    a.scan('AB12');
    assert.match(a.last(), /PACKAGE VERIFIED.*STOP 2/);
    assert.strictEqual(a.count(), '2 of 2 packages scanned');
    a.ok();
    assert.strictEqual(a.w._pickupComplete, true);
  } finally { a.close(); }
});

test('pickup completes only when every physical package is scanned', () => {
  const a = boot();
  try {
    a.setStops([ROUTE[0]]);
    a.scan('TRACKING123'); a.ok();
    a.scan('TRACKING123'); a.ok();
    assert.strictEqual(a.w._pickupComplete, false);
    a.scan('TRACKING123'); a.ok();
    assert.strictEqual(a.w._pickupComplete, true);
  } finally { a.close(); }
});

test('same real barcode listed twice on a route: counts add, one counter', () => {
  const a = boot();
  try {
    a.setStops([
      { order_id: 'X1', address: 'a', pkgs: [{ order_id: 'X1', tracking_number: 'TX', required_count: 2 }] },
      { order_id: 'X1', address: 'b', pkgs: [{ order_id: 'X1', tracking_number: 'TX', required_count: 1 }] },
    ]);
    assert.strictEqual(a.w.eval('realPackageTotal()'), 3);
    for (let i = 1; i <= 3; i++) { a.scan('TX'); assert.match(a.last(), new RegExp(i + ' OF 3')); a.ok(); }
    assert.strictEqual(a.w._pickupComplete, true);
    a.w.eval("handleLoadingScan('X1')");
    assert.match(a.last(), /ALREADY VERIFIED/);
  } finally { a.close(); }
});
