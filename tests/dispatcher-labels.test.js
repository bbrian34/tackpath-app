const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

// Live-labels popup timing. Browsers only allow window.open() for a few
// seconds after the user's gesture (choosing the CSV). The labels window
// must therefore be opened synchronously when buildAndAutoDispatch()
// starts -- before the slow awaited work (routing, per-route publication
// RPC, self-check) -- and filled once the routes exist.

const ROUTES = [
  { id: 'R-1', stops: [{ order_id: 'ORD-1001' }, { order_id: 'ORD-1002' }] },
  { id: 'R-2', stops: [{ order_id: 'ORD-2001' }] },
];

function boot() {
  const { dom, cleanup } = loadApp('dispatcher.html');
  const w = dom.window;
  // Fake popup window that records what is written into it.
  w.eval(`
    window._opens = [];
    window.open = function(){
      if (window._blockPopups) { window._opens.push(null); return null; }
      const win = { closed:false, writes:[], onload:null,
        document:{ write:function(h){ win.writes.push(h); }, close:function(){} },
        close:function(){ win.closed=true; } };
      window._opens.push(win);
      return win;
    };
    window._toasts = [];
    toast = function(m){ window._toasts.push(m); };
    updateSmartSortStatus = function(){};
    // Slow, awaited pipeline stand-ins (the real ones hit the network).
    window._gate = { assigned:[] };
    buildRoutes = async function(){ await new Promise(r=>setTimeout(r,30)); ssRoutes = window._routes; };
    assignSSRoute = async function(id){ await new Promise(r=>setTimeout(r,30)); window._gate.assigned.push(id); };
    runSmartSortSelfCheck = async function(){ await new Promise(r=>setTimeout(r,30)); };
    ssRouteCountOverride = 0;
  `);
  w._routes = JSON.parse(JSON.stringify(ROUTES));
  return { w, cleanup };
}

test('labels window opens synchronously at the start, before any awaited work', async () => {
  const { w, cleanup } = boot();
  try {
    const run = w.eval('buildAndAutoDispatch()');
    // Same tick as the call: nothing has been awaited yet.
    assert.strictEqual(w._opens.length, 1, 'window.open must be called before the first await');
    assert.strictEqual(w._gate.assigned.length, 0);
    assert.match(w._opens[0].writes.join(''), /Building routes/);
    await run;
    // The SAME window is filled with the labels; no second, late window.open.
    assert.strictEqual(w._opens.length, 1);
    const html = w._opens[0].writes.join('');
    assert.match(html, /Live Labels - Just Created/);
    for (const id of ['ORD-1001', 'ORD-1002', 'ORD-2001']) assert.ok(html.includes(id), id);
    assert.strictEqual(typeof w._opens[0].onload, 'function');
    assert.deepStrictEqual(Array.from(w._gate.assigned), ['R-1', 'R-2']);
    assert.strictEqual(w._opens[0].closed, false);
  } finally { cleanup(); }
});

test('nothing dispatched: the pre-opened window is closed, not left blank', async () => {
  const { w, cleanup } = boot();
  try {
    w._routes = [];
    await w.eval('buildAndAutoDispatch()');
    assert.strictEqual(w._opens.length, 1);
    assert.strictEqual(w._opens[0].closed, true);
    assert.ok(w._toasts.includes('No routes to dispatch'));
  } finally { cleanup(); }
});

test('driver-count mismatch blocks dispatch and closes the pre-opened window', async () => {
  const { w, cleanup } = boot();
  try {
    w.eval('ssRouteCountOverride = 3');
    await w.eval('buildAndAutoDispatch()');
    assert.strictEqual(w._opens[0].closed, true);
    assert.strictEqual(w._gate.assigned.length, 0);
  } finally { cleanup(); }
});

test('a failure mid-pipeline closes the pre-opened window and still surfaces the error', async () => {
  const { w, cleanup } = boot();
  try {
    w.eval("assignSSRoute = async function(){ throw new Error('publish failed'); }");
    await assert.rejects(w.eval('buildAndAutoDispatch()'), /publish failed/);
    assert.strictEqual(w._opens[0].closed, true);
  } finally { cleanup(); }
});

test('popups blocked outright: the existing "allow popups" message still appears', async () => {
  const { w, cleanup } = boot();
  try {
    w._blockPopups = true;
    await w.eval('buildAndAutoDispatch()');
    assert.ok(w._toasts.includes('Please allow popups to view labels'));
    assert.deepStrictEqual(Array.from(w._gate.assigned), ['R-1', 'R-2']);   // dispatch itself is unaffected
  } finally { cleanup(); }
});

test('user closed the placeholder tab meanwhile: labels open in a new window', async () => {
  const { w, cleanup } = boot();
  try {
    const run = w.eval('buildAndAutoDispatch()');
    w._opens[0].closed = true;
    await run;
    assert.strictEqual(w._opens.length, 2);
    assert.match(w._opens[1].writes.join(''), /Live Labels - Just Created/);
  } finally { cleanup(); }
});
