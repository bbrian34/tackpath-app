const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait, legacyRest, rpcCall, jsonResp } = require('./helpers');

// Driver experience (2026-10): a route that ends with problem stops finishes
// as completed_with_exceptions. Dispatch shows it as finished (not in
// progress, not "delivered"), flags it as an exception, and lets the company
// set the dispatch phone its drivers can call.

function backend(jobs, phone) {
  const rest = legacyRest(async (url) => {
    if (url.includes('/organizations')) return { ok: true, json: async () => [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }] };
    if (url.includes('/jobs')) return { ok: true, json: async () => jobs };
    return undefined;
  });
  return async (url, opts, storage) => {
    const c = rpcCall(url, opts);
    if (c && c.fn === 'tp_org' && c.action === 'dispatch_phone') return jsonResp({ dispatch_phone: phone.value });
    if (c && c.fn === 'tp_org' && c.action === 'set_dispatch_phone') {
      const d = String(c.args.phone || '').replace(/\D/g, '');
      if (d && d.length !== 10) return jsonResp({ message: 'TP_INVALID: enter a 10-digit phone number' }, 400);
      phone.value = d || null; return jsonResp({ dispatch_phone: phone.value });
    }
    return rest(url, opts, storage);
  };
}

test('dispatcher.html: a route finished with problems shows as finished with problems and is an exception', async () => {
  const jobs = [
    { id: 'job-exc-1', title: 'Route 7', org_id: 'org-demo-uuid', status: 'completed_with_exceptions', job_type: 'surge',
      archived: false, driver_name: 'Marcus', created_at: new Date().toISOString(), total_stops: 3, stops_completed: 3 },
    { id: 'job-ok-1', title: 'Route 8', org_id: 'org-demo-uuid', status: 'delivered', archived: false, driver_name: 'Ana', created_at: new Date().toISOString() },
  ];
  const phone = { value: null };
  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler: backend(jobs, phone) });
  try {
    const w = dom.window;
    w.google = { maps: { Map: function () {}, Marker: function () {}, SymbolPath: { CIRCLE: 0 } } };
    w.document.getElementById('loginOrgCode').value = 'demo';
    await w.doLogin();
    await wait(400);
    assert.strictEqual(w.eval('jobs.length'), 2);
    assert.ok(w.eval("tpDone('completed_with_exceptions') && tpDone('delivered') && !tpDone('in_transit')"));
    assert.ok(w.document.body.textContent.includes('Finished · problems'), 'board label');
    const exc = w.eval('getRealExceptions().map(e=>e.job.id+":"+e.reason).join(",")');
    assert.match(exc, /job-exc-1:Finished with problems/);
    assert.ok(!/job-ok-1/.test(exc));
    assert.strictEqual(w.eval("tpStatusText('completed_with_exceptions')"), 'finished with problems');
    // dispatch phone for this company's drivers
    w.eval("setTab('drivers',null)");
    await wait(50);
    const inp = w.document.getElementById('dispatchPhoneInput');
    inp.value = '404 555 01';
    await w.saveDispatchPhone();
    assert.match(w.document.getElementById('dispatchPhoneNote').textContent, /10-digit/);
    inp.value = '(404) 555-0123';
    await w.saveDispatchPhone();
    assert.strictEqual(phone.value, '4045550123');
    assert.strictEqual(inp.value, '(404) 555-0123');
    assert.match(w.document.getElementById('dispatchPhoneNote').textContent, /Drivers now see a call button/);
  } finally { cleanup(); }
});
