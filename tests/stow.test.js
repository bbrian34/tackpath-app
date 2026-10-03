const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait, rpcCall, jsonResp } = require('./helpers');

// PathIQ multi-piece scanning. A pkgs[] entry is one real barcode;
// required_count is how many physical packages share it.

const JOB_ID = 'job-aaaa1111-0000-0000-0000-000000000001';

function makeJob() {
  return {
    id: JOB_ID, title: 'Route A', org_id: 'org-1', status: 'assigned',
    surge_stops: [
      { stop_number: 1, address: '1 A St', tracking_number: 'TRACKING123', smart_id: 'SMART-1',
        pkgs: [{ tracking_number: 'TRACKING123', order_id: 'ORD-123', piece_id: 'TRACKING123', required_count: 3 }] },
      { stop_number: 2, address: '2 B St', tracking_number: 'TNA',
        pkgs: [{ tracking_number: 'TNA', order_id: 'ORD-A', piece_id: 'TNA', required_count: 1 },
               { tracking_number: 'TNB', order_id: 'ORD-B', piece_id: 'TNB', required_count: 1 }] },
      // No required_count at all (older row) -> defaults to 1
      { stop_number: 3, address: '3 C St', tracking_number: 'TNC',
        pkgs: [{ tracking_number: 'TNC', order_id: 'ORD-C', piece_id: 'TNC' }] },
    ],
  };
}

function boot({ events = [] } = {}) {
  const posted = [];
  const app = loadApp('stow.html', {
    initialStorage: { tp_worker: 'Tester',
      tp_dispatch_org: JSON.stringify({ id: 'org-1', slug: 'acme', name: 'Acme', token: 'org-session' }) },
    fetchHandler: async (url, opts) => {
      const c = rpcCall(url, opts);
      if (!c || c.fn !== 'tp_org') return undefined;
      if (c.action === 'log_event') { posted.push(c.args); return jsonResp({ id: posted.length }); }
      if (c.action === 'events') return jsonResp(events);
      if (c.action === 'bindings') return jsonResp([{ job_id: JOB_ID, bin_code: '1A', location_code: 'A-01', state: 'open' }]);
      if (c.action === 'jobs') return jsonResp([makeJob()]);
      return jsonResp([]);
    },
  });
  return { ...app, posted };
}

const ev = (w, js) => w.eval(js);
async function scan(w, code) { await w.eval('handleStowScan(' + JSON.stringify(code) + ')'); }
async function stow(w, code) { await scan(w, code); await scan(w, 'BIN:1A'); }
const cardText = (w) => w.document.getElementById('stowResult').textContent;
const progress = (w) => ev(w, 'JSON.stringify(binProgress["1A"])');

test('expected total sums required_count, not pkgs.length', async () => {
  const { dom, cleanup } = boot();
  try {
    await wait(300);
    const p = JSON.parse(progress(dom.window));
    // 3 (shared barcode) + 1 + 1 + 1 (defaulted)
    assert.strictEqual(p.total, 6);
    assert.strictEqual(p.sorted, 0);
  } finally { cleanup(); }
});

test('shared barcode qty 3: 1/3, 2/3, 3/3 COMPLETE, 4th scan rejected', async () => {
  const { dom, cleanup, posted } = boot();
  const w = dom.window;
  try {
    await wait(300);
    await scan(w, 'TRACKING123');
    assert.match(w.document.getElementById('flipBinStop').textContent, /PKG 1 OF 3/);
    await scan(w, 'BIN:1A');
    assert.match(cardText(w), /TRACKING123 · 1 of 3/);
    assert.doesNotMatch(cardText(w), /COMPLETE/);

    await stow(w, 'TRACKING123');
    assert.match(cardText(w), /2 of 3/);
    await stow(w, 'TRACKING123');
    assert.match(cardText(w), /3 of 3 COMPLETE/);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 3);

    await scan(w, 'TRACKING123');
    assert.match(cardText(w), /ALREADY SCANNED/);
    assert.match(cardText(w), /All 3 of 3 already stowed/);
    assert.strictEqual(ev(w, 'pendingPlacement'), null);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 3);

    const stows = posted.filter(e => e.event_type === 'package.stowed');
    assert.strictEqual(stows.length, 3);
    // Real identity preserved on every event; no invented #n identities
    for (const e of stows) {
      assert.strictEqual(e.payload.code, 'TRACKING123');
      assert.strictEqual(e.payload.piece, 'TRACKING123');
      assert.strictEqual(e.payload.required_count, 3);
      assert.ok(!JSON.stringify(e.payload).includes('#'));
    }
    assert.deepStrictEqual(stows.map(e => e.payload.unit), [1, 2, 3]);
    // Unit 1 keeps the pre-existing key exactly; later units are unique
    assert.strictEqual(stows[0].idempotency_key, 'stow:' + JOB_ID + ':TRACKING123:r0');
    assert.strictEqual(stows[1].idempotency_key, 'stow:' + JOB_ID + ':TRACKING123:r0:u2');
    assert.strictEqual(stows[2].idempotency_key, 'stow:' + JOB_ID + ':TRACKING123:r0:u3');
  } finally { cleanup(); }
});

test('aliases share one counter: order_id and tracking_number feed the same piece', async () => {
  const { dom, cleanup } = boot();
  const w = dom.window;
  try {
    await wait(300);
    await stow(w, 'ORD-123');
    assert.match(cardText(w), /TRACKING123 · 1 of 3/);
    await stow(w, 'TRACKING123');
    assert.match(cardText(w), /2 of 3/);
    await stow(w, 'ord-123');
    assert.match(cardText(w), /3 of 3 COMPLETE/);
    await scan(w, 'TRACKING123');
    assert.match(cardText(w), /ALREADY SCANNED/);
    await scan(w, 'ORD-123');
    assert.match(cardText(w), /ALREADY SCANNED/);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 3);

    // qty-1 piece: second alias is rejected, not counted again
    await stow(w, 'ORD-A');
    await scan(w, 'TNA');
    assert.match(cardText(w), /ALREADY SCANNED/);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 4);
  } finally { cleanup(); }
});

test('distinct qty-1 barcodes behave as before and complete the bin', async () => {
  const { dom, cleanup, posted } = boot();
  const w = dom.window;
  try {
    await wait(300);
    await stow(w, 'TNA');
    assert.match(cardText(w), /1 of 6 sorted/);
    assert.doesNotMatch(cardText(w), / of 1/);   // no piece line for qty 1
    assert.strictEqual(w.document.getElementById('flipBinStop').textContent, 'STOP 2');
    await scan(w, 'TNA');
    assert.match(cardText(w), /ALREADY SCANNED/);
    await stow(w, 'TNB');
    await stow(w, 'TNC');
    for (let i = 0; i < 3; i++) await stow(w, 'TRACKING123');
    assert.match(cardText(w), /Bin Complete/);
    assert.match(cardText(w), /all 6 packages sorted/);
    const k = posted.filter(e => e.event_type === 'package.stowed' && e.payload.code === 'TNA');
    assert.strictEqual(k.length, 1);
    assert.strictEqual(k[0].idempotency_key, 'stow:' + JOB_ID + ':TNA:r0');
    assert.strictEqual(posted.filter(e => e.event_type === 'bin.completed').length, 1);
  } finally { cleanup(); }
});

test('unknown barcode is rejected and nothing is counted', async () => {
  const { dom, cleanup, posted } = boot();
  const w = dom.window;
  try {
    await wait(300);
    await scan(w, 'NOT-ON-MANIFEST');
    assert.match(cardText(w), /Not On Any Route/);
    assert.strictEqual(ev(w, 'pendingPlacement'), null);
    // An invented suffix form is not a valid identity either
    await scan(w, 'TRACKING123#2');
    assert.match(cardText(w), /Not On Any Route/);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 0);
    assert.strictEqual(posted.filter(e => e.event_type === 'package.stowed').length, 0);
  } finally { cleanup(); }
});

test('refresh: event log reconstruction preserves partial multi-piece counts', async () => {
  const now = new Date().toISOString();
  const events = [
    { event_type: 'package.stowed', job_id: JOB_ID, actor: 'A', occurred_at: now,
      payload: { bin: '1A', code: 'TRACKING123', piece: 'TRACKING123', unit: 1, required_count: 3 } },
    { event_type: 'package.stowed', job_id: JOB_ID, actor: 'A', occurred_at: now,
      payload: { bin: '1A', code: 'ORD-123', piece: 'TRACKING123', unit: 2, required_count: 3 } },
    // Legacy event (pre-change): no piece, no unit, scanned by order_id alias
    { event_type: 'package.stowed', job_id: JOB_ID, actor: 'B', occurred_at: now,
      payload: { bin: '1A', code: 'ORD-A' } },
  ];
  const { dom, cleanup, posted } = boot({ events });
  const w = dom.window;
  try {
    await wait(300);
    assert.strictEqual(JSON.parse(progress(w)).sorted, 3);  // 2 of TRACKING123 + TNA
    // Legacy alias event folded onto its piece: the other alias is a duplicate
    await scan(w, 'TNA');
    assert.match(cardText(w), /ALREADY SCANNED/);
    // Third unit continues at 3 of 3, then a fourth is rejected
    await stow(w, 'TRACKING123');
    assert.match(cardText(w), /3 of 3 COMPLETE/);
    const last = posted.filter(e => e.event_type === 'package.stowed').pop();
    assert.strictEqual(last.payload.unit, 3);
    assert.strictEqual(last.idempotency_key, 'stow:' + JOB_ID + ':TRACKING123:r0:u3');
    await scan(w, 'TRACKING123');
    assert.match(cardText(w), /ALREADY SCANNED/);

    // Survives another poll (merge of local memory with the event stream)
    await w.eval('loadRoutes()');
    assert.strictEqual(JSON.parse(progress(w)).sorted, 4);
  } finally { cleanup(); }
});

test('reconstruction never overcounts: duplicate or excess unit events are capped', async () => {
  const now = new Date().toISOString();
  const mk = (unit) => ({ event_type: 'package.stowed', job_id: JOB_ID, actor: 'A', occurred_at: now,
    payload: { bin: '1A', code: 'TRACKING123', piece: 'TRACKING123', unit, required_count: 3 } });
  const { dom, cleanup } = boot({ events: [mk(1), mk(1), mk(2), mk(3), mk(4)] });
  try {
    await wait(300);
    assert.strictEqual(JSON.parse(progress(dom.window)).sorted, 3);
  } finally { cleanup(); }
});

test('bin reset clears multi-piece progress so the piece can be stowed again', async () => {
  const { dom, cleanup } = boot();
  const w = dom.window;
  try {
    await wait(300);
    await stow(w, 'TRACKING123');
    await stow(w, 'TRACKING123');
    w.eval('doResetBin("1A")');
    assert.strictEqual(JSON.parse(progress(w)).sorted, 0);
    await stow(w, 'TRACKING123');
    assert.match(cardText(w), /1 of 3/);
  } finally { cleanup(); }
});
