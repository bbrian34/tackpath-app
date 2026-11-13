const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// TP-LOADCHECK (migration 75) on the driver page: every load scan is recorded by TackPath; a box of
// another route or an unknown box is handed back; the route leaves only when TackPath agrees; "Can't
// continue" reaches dispatch; a transferred route's boxes are received box by box.
// Runs against driver.html, or the phone app's page with APP_HTML=.../www/index.html.
const ROOT = path.join(__dirname, '..');
const FILE = process.env.APP_HTML || path.join(ROOT, 'driver.html');
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function boot(srv) {
  const storage = { tp_drv: JSON.stringify({ name: 'Dana', phone: '4045551234', token: 'tok' }) };
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://tackpath.com/driver.html',
    beforeParse(w) {
      delete w.speechSynthesis; w.Element.prototype.scrollIntoView = () => {}; w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.navigator.vibrate = () => true;
      w.fetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : {};
        const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        const json = (status, d) => ({ ok: status < 300, status, json: async () => d, text: async () => JSON.stringify(d) });
        if (!m || m[1] !== 'tp_driver') return json(200, []);
        srv.calls.push({ action: body.p_action, args: body.p_args || {} });
        if (srv.offline) throw new TypeError('Failed to fetch');
        const h = srv.answers[body.p_action];
        if (h) { const r = h(body.p_args || {}); return r && r.__status ? json(r.__status, r.body) : json(200, r); }
        if (body.p_action === 'jobs') return json(200, []);
        if (body.p_action === 'update_job') { srv.updates.push(body.p_args); return json(200, [{ id: body.p_args.id, ...(body.p_args.patch || {}) }]); }
        return json(200, []);
      };
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } } });
      w.Capacitor = { isNativePlatform: () => false, Plugins: {} };
    } });
  const w = dom.window;
  w.eval('startCamera=function(){};stopCamera=function(){};');
  w.eval(`currentJob={id:'job-1',title:'Route RT-1',status:'assigned',driver_name:'Dana',surge_stops:[{stop_number:1,address:'1 A St',pkgs:[{piece_id:'TN1',tracking_number:'TN1',order_id:'O1',required_count:1}]},{stop_number:2,address:'2 B St',pkgs:[{piece_id:'TN2',tracking_number:'TN2',order_id:'O2',required_count:1}]}]};surgeStops=currentJob.surge_stops;`);
  const $ = (id) => w.document.getElementById(id);
  return { w, $, storage, close: () => w.close(), of: (a) => srv.calls.filter((c) => c.action === a) };
}
const server = (answers = {}) => ({ calls: [], updates: [], answers, offline: false });
const startLoading = (a) => a.w.eval(NATIVE ? "window._scanMode='package';window._loadPaused=false;loadedPackages=new Map();" : "window._loadingPackages=true;loadedCounts=new Map();");

test('every load scan is recorded by TackPath; the page still answers at once', async () => {
  const srv = server({ load_scan: (x) => ({ ok: true, result: 'loaded', piece_id: x.code, stop_number: 1 }) });
  const a = boot(srv);
  try {
    startLoading(a);
    a.w.eval("processScan('TN1')");
    assert.match(a.$('loadPkgLastScan').textContent, NATIVE ? /LOADED/ : /PACKAGE VERIFIED/, 'immediate feedback from the page');
    await a.w.TPLoadCheck.pending;
    assert.deepStrictEqual(a.of('load_scan').map((c) => [c.args.id, c.args.code]), [['job-1', 'TN1']]);
  } finally { a.close(); }
});

test('a box of another route: TackPath says whose it is; the driver hands it back', async () => {
  const srv = server({ load_scan: () => ({ ok: false, result: 'wrong_route', piece_id: 'X9', belongs_to: 'Route RT-7' }), load_remove: () => ({ ok: true }) });
  const a = boot(srv);
  try {
    startLoading(a);
    a.w.eval("processScan('X9')");
    await a.w.TPLoadCheck.pending; await settle();
    assert.match(a.$('loadPkgLastScan').textContent, /WRONG ROUTE.*X9: This box belongs to Route RT-7\. Do not load it\. Hand it back to the dock\./);
    a.$('tpHandBack').click(); await settle();
    assert.deepStrictEqual(a.of('load_remove')[0].args, { id: 'job-1', code: 'X9' });
    assert.match(a.$('loadPkgLastScan').textContent, /Handed back/);
  } finally { a.close(); }
});

test('no connection: the scan is kept on the phone and sent when the connection is back', async () => {
  const srv = server({ load_scan: (x) => ({ ok: true, result: 'loaded', piece_id: x.code }) });
  const a = boot(srv);
  try {
    startLoading(a);
    srv.offline = true;
    a.w.eval("processScan('TN1')");
    await a.w.TPLoadCheck.pending;
    assert.strictEqual(JSON.parse(a.storage.tp_load_queue).length, 1);
    srv.offline = false;
    await a.w.TPLoadCheck.flush();
    assert.strictEqual(JSON.parse(a.storage.tp_load_queue).length, 0);
    assert.strictEqual(a.of('load_scan').length, 2, 'sent again');
  } finally { a.close(); }
});

test('leaving: blocked with the list while boxes are missing; allowed once TackPath agrees', async () => {
  let st = { scanning_started: true, can_depart: false, missing: [{ piece_id: 'TN2', stop_number: 2, required: 1, loaded_units: 0 }], discrepancies: [{ kind: 'load_wrong_route', piece_id: 'X9', belongs_to: 'Route RT-7' }] };
  const srv = server({ load_status: () => st });
  const a = boot(srv);
  try {
    a.w.eval('window.__pickups=0; var __orig=window.__tpOrigPickup;');
    await a.w.confirmPickup(); await settle();
    const p = a.$('tpDepartPanel');
    assert.ok(p, 'blocked');
    assert.match(p.textContent, /You cannot leave yet.*Not scanned into the van:.*TN2 \(stop 2\).*Boxes to hand back:.*X9: belongs to Route RT-7/);
    assert.strictEqual(srv.updates.length, 0, 'the route did not go out');
    st = { scanning_started: true, can_depart: true, missing: [], discrepancies: [] };
    a.$('tpDepartCheck').click(); await settle(80);
    assert.ok(!a.$('tpDepartPanel'));
    assert.ok(srv.updates.some((u) => u.patch && u.patch.status === 'in_transit'), 'now it leaves');
  } finally { a.close(); }
});

test("can't continue: the driver tells dispatch what happened", async () => {
  const srv = server({ cant_continue: () => ({ ok: true }) });
  const a = boot(srv);
  try {
    a.w.eval("currentJob.status='in_transit'");
    await a.w.TPLoadCheck.tick(); await settle();
    assert.ok(a.$('tpCantContinue'), 'shown while delivering');
    a.$('tpCantContinue').click();
    a.$('tpCantNote').value = 'I-75 exit 260';
    a.w.document.querySelector('#tpCantPanel [data-r="breakdown"]').click(); await settle();
    assert.deepStrictEqual(a.of('cant_continue')[0].args, { id: 'job-1', reason: 'breakdown', note: 'I-75 exit 260' });
    assert.match(a.$('tpCantPanel').textContent, /Dispatch has been told.*Another driver will come and scan them over/);
  } finally { a.close(); }
});

test('receiving a transfer: scan each box; when all are in, the rescue route starts', async () => {
  const srv = server({
    transfers: () => [{ id: 't1', from_driver: 'Marcus', to_job_id: 'job-9', pieces: ['A-2', 'A-3'], scanned: [] }],
    transfer_scan: (x) => (x.code === 'A-2' ? { ok: true, result: 'received', piece_id: 'A-2', scanned: 1, total: 2 }
      : x.code === 'A-3' ? { ok: true, result: 'received', piece_id: 'A-3', scanned: 2, total: 2, complete: true, job_id: 'job-9' } : { ok: false, result: 'not_in_transfer' }) });
  const a = boot(srv);
  try {
    a.w.eval('currentJob=null');
    a.w.location.reload = () => { a.w.__reloaded = true; };
    await a.w.TPLoadCheck.tick(); await settle();
    assert.match(a.$('tpTransferBanner').textContent, /Receive 2 boxes from Marcus/);
    a.$('tpTransferBanner').click(); await settle();
    await a.w.processScan('ZZ');
    assert.match(a.$('tpTransferPanel').textContent, /ZZ is not one of these boxes/);
    await a.w.processScan('A-2');
    assert.match(a.$('tpTransferPanel').textContent, /Receiving from Marcus: 1 of 2.*A-2 is now in your van/);
    await a.w.processScan('A-3'); await settle();
    assert.deepStrictEqual([srv.updates.at(-1).id, srv.updates.at(-1).patch.status], ['job-9', 'in_transit'], 'the rescue route starts');
    assert.match(a.$('tpTransferPanel').textContent, /All 2 boxes are in your van/);
  } finally { a.close(); }
});

test('a TackPath without load checks: the page works exactly as before', async () => {
  const srv = server({ load_scan: () => ({ __status: 400, body: { message: 'unknown action' } }), load_status: () => ({ __status: 400, body: { message: 'unknown action' } }) });
  const a = boot(srv);
  try {
    startLoading(a);
    a.w.eval("processScan('TN1')"); await a.w.TPLoadCheck.pending;
    assert.ok(!a.storage.tp_load_queue || JSON.parse(a.storage.tp_load_queue).length === 0, 'not queued');
    await a.w.confirmPickup(); await settle(80);
    assert.ok(!a.$('tpDepartPanel'));
    assert.ok(srv.updates.some((u) => u.patch && u.patch.status === 'in_transit'));
  } finally { a.close(); }
});
