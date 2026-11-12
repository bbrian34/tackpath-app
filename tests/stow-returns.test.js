const test = require('node:test');
const assert = require('node:assert');
const { loadApp, rpcCall, jsonResp, wait } = require('./helpers');

// PathIQ Returns (migration 73): a box a driver brought back is scanned RECEIVED with
// one question (intact or damaged); TackPath takes it off its old route and Keel sends
// it out again. A damaged box goes on hold.
function boot(answer) {
  const calls = [];
  const app = loadApp('stow.html', {
    initialStorage: { tp_worker: 'Tester', tp_dispatch_org: JSON.stringify({ id: 'org-1', slug: 'acme', name: 'Acme', token: 'org-session' }) },
    fetchHandler: async (url, opts) => {
      const c = rpcCall(url, opts);
      if (!c || c.fn !== 'tp_org') return undefined;
      if (c.action === 'receive_return') { calls.push(c.args); return answer(c.args); }
      return jsonResp([]);
    },
  });
  return { ...app, calls };
}
const $ = (w, id) => w.document.getElementById(id);

test('Returns: scan, intact, RECEIVED with the reason and attempt', async () => {
  const { dom, cleanup, calls } = boot(() => jsonResp({ ok: true, replayed: false, piece_id: 'O-100123-1', custody: 'warehouse_returns', condition: 'intact', hold: null, attempts: 1, last_reason: 'business_closed' }));
  const w = dom.window;
  await wait(150);   // the page's first route load
  try {
    w.goTo('returns');
    assert.ok($(w, 'scReturns').classList.contains('on'));
    assert.match($(w, 'returnsResult').textContent, /Scan a returned box/);
    w.handleReturnsScan(' o-100123-1 ');
    assert.strictEqual($(w, 'returnsAsk').style.display, 'flex', 'asks whether the box is intact');
    assert.strictEqual(calls.length, 0, 'nothing recorded before the answer');
    await w.returnsReceive('intact');
    assert.deepStrictEqual(calls, [{ piece_id: 'O-100123-1', condition: 'intact', by: 'PathIQ' }]);
    assert.ok($(w, 'returnsResult').classList.contains('success'));
    assert.match($(w, 'returnsResult').textContent, /RECEIVED.*O-100123-1 is back \(Business closed, attempt 1\)\. It will go out again\./);
    assert.strictEqual($(w, 'returnsAsk').style.display, 'none');
  } finally { cleanup(); }
});

test('Returns: a damaged box is put on hold', async () => {
  const { dom, cleanup, calls } = boot(() => jsonResp({ ok: true, piece_id: 'O-1-1', custody: 'warehouse_returns', condition: 'damaged', hold: 'damaged', attempts: 1 }));
  const w = dom.window;
  await wait(150);   // the page's first route load
  try {
    w.goTo('returns'); w.handleReturnsScan('O-1-1'); await w.returnsReceive('damaged');
    assert.strictEqual(calls[0].condition, 'damaged');
    assert.ok($(w, 'returnsResult').classList.contains('error'));
    assert.match($(w, 'returnsResult').textContent, /ON HOLD.*O-1-1 is damaged\. Put it on the problem shelf\./);
  } finally { cleanup(); }
});

test('Returns: scanned twice, or refused by TackPath, says so plainly', async () => {
  let n = 0;
  const { dom, cleanup } = boot(() => (++n === 1 ? jsonResp({ ok: true, replayed: true, piece_id: 'O-1-1', hold: null })
    : n === 2 ? jsonResp({ message: 'TP_STATE: box O-1-1 is delivered; it cannot be received back' }, 400)
      : jsonResp({ message: 'unknown action' }, 400)));
  const w = dom.window;
  await wait(150);   // the page's first route load
  try {
    w.goTo('returns');
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match($(w, 'returnsResult').textContent, /O-1-1 was already received\./);
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.ok($(w, 'returnsResult').classList.contains('error'));
    assert.match($(w, 'returnsResult').textContent, /box O-1-1 is delivered; it cannot be received back/);
    w.handleReturnsScan('O-1-1'); await w.returnsReceive('intact');
    assert.match($(w, 'returnsResult').textContent, /Returns are not switched on for this company yet\./);
  } finally { cleanup(); }
});
