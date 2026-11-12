const test = require('node:test');
const assert = require('node:assert');
const { loadApp, rpcCall, jsonResp, wait } = require('./helpers');

// PathIQ Returns (migrations 73-74): the worker scans a box a driver brought back and answers one
// question: intact, carton damaged (contents fine) or contents damaged. PathIQ then guides them:
// join an open route or the returns shelf; rebox with the same label; or the problem shelf.
function boot(answers) {
  const calls = [];
  const app = loadApp('stow.html', {
    initialStorage: { tp_worker: 'Tester', tp_dispatch_org: JSON.stringify({ id: 'org-1', slug: 'acme', name: 'Acme', token: 'org-session' }) },
    fetchHandler: async (url, opts) => {
      const c = rpcCall(url, opts);
      if (!c || c.fn !== 'tp_org') return undefined;
      if (answers[c.action]) { calls.push({ action: c.action, args: c.args }); return answers[c.action](c.args); }
      return jsonResp([]);
    },
  });
  return { ...app, calls, of: (a) => calls.filter((c) => c.action === a) };
}
const $ = (w, id) => w.document.getElementById(id);
const text = (w) => $(w, 'returnsResult').textContent;
const buttons = (w) => [...$(w, 'returnsNext').querySelectorAll('button')].map((b) => b.textContent);
const received = (extra = {}) => () => jsonResp({ ok: true, replayed: false, piece_id: 'O-100123-1', custody: 'warehouse_returns', attempts: 1, last_reason: 'business_closed', ...extra });

test('intact: RECEIVED with the reason and attempt; joins an open route in the same area, guided to its bin', async () => {
  const { dom, cleanup, of } = boot({ receive_return: received({ next: 'next_route', hold: null }),
    piece_candidates: () => jsonResp([{ job_id: 'j2', title: 'Route RT-044', avoided_driver: false }, { job_id: 'j3', title: 'Route RT-045', avoided_driver: true }]),
    assign_piece: () => jsonResp({ ok: true, title: 'Route RT-044', job_id: 'j2' }) });
  const w = dom.window; await wait(150);
  try {
    w.goTo('returns');
    w.handleReturnsScan(' o-100123-1 ');
    assert.strictEqual($(w, 'returnsAsk').style.display, 'flex');
    assert.strictEqual(of('receive_return').length, 0, 'nothing recorded before the answer');
    await w.returnsReceive('intact');
    assert.deepStrictEqual(of('receive_return')[0].args, { piece_id: 'O-100123-1', condition: 'intact', by: 'PathIQ' });
    assert.match(text(w), /RECEIVED.*O-100123-1 is back \(Business closed, attempt 1\)\. It can join an open route now:/);
    assert.deepStrictEqual(buttons(w), ['Add to Route RT-044', 'Next route batch instead'], 'a route with the avoided driver is not offered');
    await w.returnsAssign('j2');
    assert.deepStrictEqual(of('assign_piece')[0].args, { piece_id: 'O-100123-1', job_id: 'j2' });
    assert.match(text(w), /ON ROUTE RT-044.*Stow it in that route's bin/);
  } finally { cleanup(); }
});

test('intact with no open route: the next route batch, returns shelf', async () => {
  const { dom, cleanup } = boot({ receive_return: received({ next: 'next_route' }), piece_candidates: () => jsonResp([]) });
  const w = dom.window; await wait(150);
  try {
    w.goTo('returns'); w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match(text(w), /goes out on the next route batch\. Put it on the returns shelf\./);
    assert.deepStrictEqual(buttons(w), []);
  } finally { cleanup(); }
});

test('carton damaged: guided rebox, label reprinted with the same barcode, then out with another driver', async () => {
  const opened = [];
  const { dom, cleanup, of } = boot({ receive_return: received({ next: 'rebox', hold: 'rebox', avoid_driver: 'Dana Brooks' }),
    reprint_label: () => jsonResp({ ok: true, piece_id: 'O-100123-1', recipient: 'Pat Lee', address: '100 Main St', order_id: 'O-100123' }),
    rebox_done: () => jsonResp({ ok: true, piece_id: 'O-100123-1', avoid_driver: 'Dana Brooks' }), piece_candidates: () => jsonResp([]) });
  const w = dom.window; await wait(150);
  try {
    const doc = { html: '', write(h) { this.html += h; }, close() {} };
    w.open = () => { const win = { document: doc }; opened.push(win); return win; };
    w.goTo('returns'); w.handleReturnsScan('O-100123-1'); await w.returnsReceive('carton_damaged');
    assert.match(text(w), /REBOX.*keeps its identity\. 1\. Move the contents into a new carton\. 2\. Print its label \(the same barcode\)/);
    assert.deepStrictEqual(buttons(w), ['Print label', 'Reboxed and labeled']);
    await w.returnsPrint();
    assert.strictEqual(opened.length, 1);
    assert.match(doc.html, /JsBarcode\("#bc","O-100123-1",\{format:"CODE128"/);
    assert.match(doc.html, /Pat Lee/); assert.match(doc.html, /jsbarcode\.min\.js/);
    await w.returnsReboxed();
    assert.strictEqual(of('rebox_done').length, 1);
    assert.match(text(w), /REBOXED.*A driver other than Dana Brooks takes it/);
  } finally { cleanup(); }
});

test('contents damaged: problem shelf, Keel has opened a problem; not offered a route', async () => {
  const { dom, cleanup, of } = boot({ receive_return: received({ next: 'problem_station', hold: 'contents_damaged' }), piece_candidates: () => jsonResp([]) });
  const w = dom.window; await wait(150);
  try {
    w.goTo('returns'); w.handleReturnsScan('O-1-1'); await w.returnsReceive('contents_damaged');
    assert.strictEqual(of('receive_return')[0].args.condition, 'contents_damaged');
    assert.ok($(w, 'returnsResult').classList.contains('error'));
    assert.match(text(w), /PROBLEM SHELF.*contents damaged\. Take it to the problem-solving station\. Keel has opened a problem for it\./);
    assert.strictEqual(of('piece_candidates').length, 0);
  } finally { cleanup(); }
});

test('scanned twice, refused, or not switched on: says so plainly', async () => {
  let n = 0;
  const { dom, cleanup } = boot({ receive_return: () => (++n === 1 ? jsonResp({ ok: true, replayed: true, piece_id: 'O-1-1' })
    : n === 2 ? jsonResp({ message: 'TP_STATE: box O-1-1 is delivered; it cannot be received back' }, 400)
      : jsonResp({ message: 'unknown action' }, 400)) });
  const w = dom.window; await wait(150);
  try {
    w.goTo('returns');
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match(text(w), /O-1-1 was already received\./);
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match(text(w), /box O-1-1 is delivered; it cannot be received back/);
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match(text(w), /Returns are not switched on for this company yet\./);
  } finally { cleanup(); }
});
