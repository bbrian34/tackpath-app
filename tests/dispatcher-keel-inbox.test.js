const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers.js');

// Migration 71: a delivery Keel put in the company inbox is claimed once and
// runs through SmartSort like an upload (load, build); a dispatcher already
// working on another file is left alone.
const CSV = 'order_id,recipient,address,packages,tracking_number,phone,unit,delivery_notes,deliver_by\n' +
  'KEEL-O-100004,Test Customer,"260 Manning Rd SW, Marietta, GA 30064",1,O-100004-1,,,Same-day,\n';

test('a delivery from Keel is claimed once and built like an upload', async () => {
  const calls = [];
  const app = loadApp('dispatcher.html', { fetchHandler: async () => ({ status: 200, body: [] }) });
  const w = app.dom.window;
  try {
    w.tpSession = () => ({ token: 't' });
    w.tpRpc = async (fn, a) => { calls.push(a.p_action);
      if (a.p_action === 'inbox') return [{ id: 'i1', ref: 'SMARTSORT-1', filename: 'keel-O-100004.csv' }];
      if (a.p_action === 'inbox_claim') return calls.filter((c) => c === 'inbox_claim').length === 1 ? { ok: true, ref: 'SMARTSORT-1', filename: 'keel-O-100004.csv', csv: CSV } : { ok: false };
      return []; };
    let built = 0;
    w.eval('buildRoutes = async function () { window._built = (window._built || 0) + 1; window._pk = packages.map(p => p.tracking_number || p.order_id); packages = []; }');
    await w.eval('pullKeelInbox()');
    assert.deepEqual(calls, ['inbox', 'inbox_claim']);
    assert.equal(w._built, 1);
    assert.ok(JSON.stringify(w._pk).includes('O-100004'), JSON.stringify(w._pk));
    // already claimed elsewhere: nothing is built
    await w.eval('pullKeelInbox()');
    assert.equal(w._built, 1);
    // a dispatcher working on another file: the inbox waits
    calls.length = 0;
    w.eval('packages = [{ order_id: "MANUAL-1" }]');
    await w.eval('pullKeelInbox()');
    assert.deepEqual(calls, []);
  } finally { app.cleanup(); }
});
