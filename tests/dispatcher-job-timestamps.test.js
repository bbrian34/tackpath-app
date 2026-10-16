const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers');

// Migration 68 (server) fills jobs.picked_up_at at in_transit and
// jobs.delivered_at at delivered / completed_with_exceptions. The dispatcher
// already reads both (tp_org 'jobs' returns every column); this checks, with
// no dispatcher change, that its "Picked up" / "Delivered" times, the on-time
// result and the "Driver dark" timer use them once they are there.
const H = 3600e3, M = 60e3;
const iso = (ms) => new Date(Date.now() - ms).toISOString();

test('dispatcher: Picked up, Delivered and the on-time result show once the server records the times', () => {
  const { dom, cleanup } = loadApp('dispatcher.html');
  try {
    const w = dom.window;
    const job = { id: 'j1', title: 'Route 7', status: 'delivered', created_at: iso(5 * H), picked_up_at: iso(3 * H), delivered_at: iso(1 * H),
      estimated_delivery_at: iso(1 * H - 12 * M) };
    const html = w.renderTimingBreakdown(job);
    const cell = (label) => (html.match(new RegExp(label + '</div><div>([^<]*)</div>')) || [])[1];
    assert.notStrictEqual(cell('PICKED UP'), '—', 'Picked up time shown');
    assert.notStrictEqual(cell('DELIVERED'), '—', 'Delivered time shown');
    assert.match(html, /12 min early/, 'on-time result shown');
    // before 68: both empty, no result
    const old = w.renderTimingBreakdown(Object.assign({}, job, { picked_up_at: null, delivered_at: null }));
    assert.strictEqual((old.match(/PICKED UP<\/div><div>([^<]*)</) || [])[1], '—');
    assert.strictEqual((old.match(/DELIVERED<\/div><div>([^<]*)</) || [])[1], '—');
    assert.ok(!/min (early|late)/.test(old));
  } finally { cleanup(); }
});

test('dispatcher: "Driver dark" counts from the pickup time, not from when the route was created', () => {
  const { dom, cleanup } = loadApp('dispatcher.html');
  try {
    const w = dom.window;
    const dark = (j) => { w.eval('jobs=' + JSON.stringify([j]) + ';driverLastSeen={};');
      return Array.from(w.getRealExceptions()).filter((e) => e.reason === 'Driver Dark').length; };
    const base = { id: 'j2', title: 'Route 8', status: 'in_transit', driver_name: 'Dana', created_at: iso(4 * H), estimated_delivery_at: iso(-3 * H) };
    assert.strictEqual(dark(Object.assign({}, base, { picked_up_at: iso(10 * M) })), 0, 'picked up 10 min ago: not dark');
    assert.strictEqual(dark(Object.assign({}, base, { picked_up_at: null })), 1, 'without the pickup time (before 68) it was flagged dark');
    assert.strictEqual(dark(Object.assign({}, base, { picked_up_at: iso(45 * M) })), 1, 'really silent for 45 min: dark');
  } finally { cleanup(); }
});
