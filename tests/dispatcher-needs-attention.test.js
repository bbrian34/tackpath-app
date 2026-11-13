const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers.js');

// Migration 72 on the dispatcher: routes are published box by box (a box
// already on a live route is held back, the rest goes out), a Keel file whose
// routes could not all be published is recorded under Needs attention and the
// screen is cleared so the next file is never stuck, and the Needs attention
// panel closes items with a note or sends a file again.
const route = (id, pieces) => ({ id, master_code: 'MC-' + id, total_packages: pieces.length, est_miles: '3.0',
  stops: [{ order_id: 'O-' + id, address: '1 Main St', packages: pieces.length, coords: { lat: 33.9, lng: -84.5 },
    pkgs: pieces.map((p) => ({ order_id: 'O-' + id, piece_id: p, tracking_number: p, required_count: 1 })) }] });

function app(answers) {
  const calls = [];
  const a = loadApp('dispatcher.html', { fetchHandler: async () => ({ status: 200, ok: true, json: async () => [], text: async () => '[]' }) });
  const w = a.dom.window;
  w.tpSession = () => ({ token: 't' });
  w.tpRpc = async (fn, args) => { calls.push({ action: args.p_action, args: JSON.parse(JSON.stringify(args.p_args || {})) });
    const h = answers[args.p_action]; return typeof h === 'function' ? h(args.p_args, calls) : (h === undefined ? [] : h); };
  w.eval('window._toasts = []; toast = function (m) { window._toasts.push(m); }');
  return { a, w, calls, of: (action) => calls.filter((c) => c.action === action) };
}

test('routes are published box by box; held boxes are named and counted', async () => {
  const { a, w, of } = app({ publish_route: (args) => ({ ok: true, idempotent: false, job: { id: 'j2' }, held: [{ piece_id: 'B1', live_job_id: 'j1' }] }),
    attention: { items: [], stale_files: [] } });
  try {
    w.eval(`ssRoutes = [${JSON.stringify(route('R-1', ['B1', 'B2']))}]; keelInboxCurrent = { id: 'f1', ref: 'K1', published: 0, held: 0 };`);
    await w.eval(`assignSSRoute('R-1')`);
    await wait(50);
    assert.strictEqual(of('publish_route').length, 1);
    assert.strictEqual(of('publish_route')[0].args.payload.partial, true, 'the dispatcher asks for box-by-box publishing');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.eval('window._ssHeldPieces'))), ['B1']);
    assert.ok(w.eval('window._toasts').some((t) => /1 box held/.test(t)), JSON.stringify(w.eval('window._toasts')));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.eval('keelInboxCurrent'))), { id: 'f1', ref: 'K1', published: 1, held: 1 });
    assert.strictEqual(w.eval('ssRoutes.length'), 0);
  } finally { a.cleanup(); }
});

test('a Keel file with a refused route: recorded under Needs attention, finished, and the screen cleared for the next file', async () => {
  const { a, w, of } = app({ attention_add: { ok: true, new: true }, inbox_done: { ok: true }, attention: { items: [], stale_files: [] } });
  try {
    w.eval(`packages = [{ order_id: 'O-R-2' }]; ssRoutes = [${JSON.stringify(route('R-2', ['B5', 'B6']))}];
      window._ssPublishFailures = ['R-2: every box on this route is already on a live route'];
      keelInboxCurrent = { id: 'f2', ref: 'K2', filename: 'k2.csv', published: 1, held: 0 };`);
    await w.eval('keelInboxFinish()');
    const add = of('attention_add');
    assert.strictEqual(add.length, 1);
    assert.deepStrictEqual(add[0].args, { kind: 'route_refused', ref: 'MC-R-2', title: 'Route R-2', reason: 'every box on this route is already on a live route',
      file_ref: 'K2', file_id: 'f2', pieces: ['B5', 'B6'] });
    assert.deepStrictEqual(of('inbox_done')[0].args, { id: 'f2', result: { published: 1, held: 0, refused: 1, failed: false } });
    assert.strictEqual(w.eval('packages.length'), 0, 'the screen is cleared');
    assert.strictEqual(w.eval('ssRoutes.length'), 0);
    assert.strictEqual(w.eval('keelInboxCurrent'), null);
    assert.strictEqual(w.document.getElementById('buildBtn').disabled, false, 'nothing left that keeps the inbox waiting');
  } finally { a.cleanup(); }
});

test('a Keel file that publishes everything is finished without any Needs attention record', async () => {
  const { a, w, of } = app({ inbox_done: { ok: true }, attention: { items: [], stale_files: [] } });
  try {
    w.eval(`ssRoutes = []; keelInboxCurrent = { id: 'f3', ref: 'K3', published: 2, held: 0 };`);
    await w.eval('keelInboxFinish()');
    assert.strictEqual(of('attention_add').length, 0);
    assert.deepStrictEqual(of('inbox_done')[0].args.result, { published: 2, held: 0, refused: 0, failed: false });
  } finally { a.cleanup(); }
});

test('a Keel file with no deliverable packages is recorded as failed and finished, and the inbox moves on', async () => {
  let n = 0;
  const { a, w, of } = app({
    inbox: () => (++n === 1 ? [{ id: 'f4', ref: 'K4', filename: 'k4.csv' }] : []),
    inbox_claim: { ok: true, ref: 'K4', filename: 'k4.csv', csv: 'order_id,recipient,address\n' },
    attention_add: { ok: true, new: true }, inbox_done: { ok: true }, attention: { items: [], stale_files: [] } });
  try {
    w.eval('buildRoutes = async function () { window._built = (window._built || 0) + 1; }');
    await w.eval('pullKeelInbox()');
    assert.strictEqual(w.eval('window._built'), undefined, 'nothing to build');
    assert.strictEqual(of('attention_add')[0].args.kind, 'file_failed');
    assert.strictEqual(of('attention_add')[0].args.file_id, 'f4');
    assert.strictEqual(of('inbox_done')[0].args.result.failed, true);
    assert.strictEqual(w.eval('keelInboxBusy'), false);
  } finally { a.cleanup(); }
});

test('Needs attention: the count, closing with a note, sending a file again', async () => {
  const items = [
    { id: 'a1', kind: 'piece_held', piece_id: 'B1', ref: 'MC-R-1', detail: { live_job_title: 'Surge Route RT-7', route_title: 'Surge Route R-1' }, created_at: '2026-11-12T15:00:00Z' },
    { id: 'a2', kind: 'route_refused', ref: 'MC-R-2', detail: { route_title: 'Route R-2', reason: 'no stops in payload', file_id: 'f2', pieces: ['B5'] }, created_at: '2026-11-12T15:01:00Z' }];
  const { a, w, of } = app({ attention: { items, stale_files: [{ id: 'f9', ref: 'K9', filename: 'k9.csv', claimed_at: '2026-11-12T14:00:00Z', claimed_by: 'dispatcher' }] },
    attention_resolve: { ok: true }, inbox_retry: { ok: true } });
  try {
    const $ = (id) => w.document.getElementById(id);
    assert.strictEqual($('attnBtn').hidden, true, 'hidden until something needs attention');
    await w.eval('loadAttention()');
    assert.strictEqual($('attnBtn').hidden, false);
    assert.strictEqual($('attnCount').textContent, '3');
    await w.eval('openAttention()');
    const text = $('attnBody').textContent;
    assert.match(text, /Box B1 was held back from Surge Route R-1: it is already on live route Surge Route RT-7/);
    assert.match(text, /Route R-2 was not published: no stops in payload \(1 box\)/);
    assert.match(text, /Keel file k9\.csv was taken by dispatcher/);
    // a held box offers no "send again"; a refused route and a stale file do
    assert.strictEqual($('attnBody').querySelectorAll('button').length, 1 + 1 + 2);   // stale file: send again; held box: close; refused route: send again, close
    w.prompt = () => '  ';
    await w.eval(`attnResolve('a1')`);
    assert.strictEqual(of('attention_resolve').length, 0, 'a note is required');
    w.prompt = () => 'B1 stays on RT-7';
    await w.eval(`attnResolve('a1')`);
    assert.deepStrictEqual(of('attention_resolve')[0].args, { id: 'a1', note: 'B1 stays on RT-7', by: 'dispatcher' });
    await w.eval(`attnRetry('f2')`);
    assert.deepStrictEqual(of('inbox_retry')[0].args, { id: 'f2' });
  } finally { a.cleanup(); }
});

test('before migration 72 is applied the panel stays hidden and nothing breaks', async () => {
  const { a, w } = app({ attention: {} });
  try {
    await w.eval('loadAttention()');
    assert.strictEqual(w.document.getElementById('attnBtn').hidden, true);
  } finally { a.cleanup(); }
});

test('Needs attention: missing boxes, lost boxes, damaged returns and driver patterns, with Found it', async () => {
  const items = [
    { id: 'i1', kind: 'investigation', piece_id: 'O-1-1', ref: 'j1', detail: { reason: 'Reported not delivered, never received back', route_title: 'Route RT-9', driver: 'Dana Brooks', day: 3 }, created_at: '2026-11-12T15:00:00Z' },
    { id: 'i2', kind: 'piece_lost', piece_id: 'O-2-1', ref: 'O-2-1', detail: { reason: 'Route ended without a delivery or a report' }, created_at: '2026-11-12T15:00:00Z' },
    { id: 'i3', kind: 'contents_damaged', piece_id: 'O-3-1', ref: 'O-3-1', detail: {}, created_at: '2026-11-12T15:00:00Z' },
    { id: 'i4', kind: 'driver_pattern', ref: 'Avoider', detail: { driver: 'Avoider', why: '3 boxes they could not deliver were delivered by another driver', failures: 4, attempts: 10, by_reason: { no_access: 3, refused: 1 }, unit_failures: 2 }, created_at: '2026-11-12T15:00:00Z' }];
  const { a, w, of } = app({ attention: { items, stale_files: [] }, mark_found: { ok: true } });
  try {
    await w.eval('openAttention()');
    const t = w.document.getElementById('attnBody').textContent;
    assert.match(t, /Box O-1-1 is missing \(day 3 of 5\): Reported not delivered, never received back\. Route Route RT-9, driver Dana Brooks/);
    assert.match(t, /Box O-2-1 was declared lost after a 5-day investigation/);
    assert.match(t, /Box O-3-1 came back with damaged contents: it is at the problem-solving station/);
    assert.match(t, /Driver Avoider: 3 boxes they could not deliver were delivered by another driver \(4 not delivered of 10 in 14 days: no access 3, refused 1; 2 at apartment or unit addresses\)\. For you to look into; nothing is done to the driver automatically\./);
    assert.strictEqual([...w.document.querySelectorAll('#attnBody button')].filter((b) => b.textContent === 'Found it').length, 2);
    w.prompt = () => 'under the seat';
    await w.eval(`attnFound('O-1-1')`);
    assert.deepStrictEqual(of('mark_found')[0].args, { piece_id: 'O-1-1', note: 'under the seat', by: 'dispatcher' });
  } finally { a.cleanup(); }
});

test('Needs attention: load problems, a driver who cannot continue, transfers and held boxes, each with its action', async () => {
  const items = [
    { id: 'l1', kind: 'load_wrong_route', piece_id: 'X9', ref: 'job-1', detail: { route_title: 'Route RT-1', driver: 'Dana', belongs_to: 'Route RT-7' }, created_at: '2026-11-13T15:00:00Z' },
    { id: 'c1', kind: 'cant_continue', ref: 'job-2', detail: { route_title: 'Route RT-2', driver: 'Marcus', reason: 'breakdown', note: 'I-75', boxes_left: 6 }, created_at: '2026-11-13T15:00:00Z' },
    { id: 't1', kind: 'transfer', ref: 'tr-1', detail: { route_title: 'Route RT-2', from_driver: 'Marcus', to_driver: 'Lena', boxes: 6 }, created_at: '2026-11-13T15:00:00Z' },
    { id: 'h1', kind: 'piece_on_hold', piece_id: 'O-5-1', ref: 'R9', detail: { route_title: 'Route RT-9', reason: 'merchant hold' }, created_at: '2026-11-13T15:00:00Z' },
    { id: 'd1', kind: 'departure_unverified', ref: 'job-3', detail: { route_title: 'Route RT-3', driver: 'Old App', boxes: 4 }, created_at: '2026-11-13T15:00:00Z' }];
  const { a, w, of } = app({ attention: { items, stale_files: [] }, resolve_load: { can_depart: true }, drivers: [{ name: 'Lena', status: 'active' }, { name: 'Gone', status: 'removed' }],
    start_transfer: { ok: true, pieces: ['A', 'B'] }, close_transfer: { ok: true, moved: 4, stayed: 2 } });
  try {
    await w.eval('openAttention()');
    const t = w.document.getElementById('attnBody').textContent;
    assert.match(t, /Box X9 was scanned into Route RT-1 \(Dana\) but belongs to Route RT-7\. The route cannot leave/);
    assert.match(t, /Marcus cannot continue Route RT-2: breakdown \(I-75\)\. 6 boxes are still in the van/);
    assert.match(t, /Transfer of 6 boxes from Marcus to Lena/);
    assert.match(t, /Box O-5-1 is on hold in Keel \(merchant hold\) and was left off Route RT-9/);
    assert.match(t, /Route RT-3 left without a box-by-box load scan \(4 boxes, driver Old App\)/);
    let asked = '';
    w.prompt = (q) => { asked = q; return 'ok by Sam'; };
    await w.eval(`attnLoad('job-1','allow_departure')`);
    assert.deepStrictEqual(of('resolve_load')[0].args, { job_id: 'job-1', action: 'allow_departure', note: 'ok by Sam', by: 'dispatcher' });
    w.prompt = (q) => { asked = q; return 'Lena'; };
    await w.eval(`attnTransfer('job-2')`);
    assert.match(asked, /Which driver takes the boxes\?\nLena$/, 'only active drivers offered');
    assert.deepStrictEqual(of('start_transfer')[0].args, { job_id: 'job-2', to_driver: 'Lena', reason: 'cannot continue', by: 'dispatcher' });
    w.prompt = () => 'Lena had to leave';
    await w.eval(`attnCloseTransfer('tr-1')`);
    assert.deepStrictEqual(of('close_transfer')[0].args, { transfer_id: 'tr-1', note: 'Lena had to leave' });
  } finally { a.cleanup(); }
});
