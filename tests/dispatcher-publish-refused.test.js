const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers.js');

// When the publication gate refuses a route, the SmartSort self-check panel
// says so and gives the gate's reason (it used to say only "could not match
// this build's routes in the database"; the reason was in a toast that
// disappears). Real case 2026-10-09: the gate counted a completed_with_exceptions
// route as live (fixed by supabase/security migration 50).
test('a route refused by the publication gate shows the gate\'s reason in the self-check', async () => {
  const reason = 'piece_id 720431958206 is already committed to live job f8f24737-758b-4080-85c2-b8aa025a2e36';
  const app = loadApp('dispatcher.html', { fetchHandler: async () => ({ status: 200, body: [{ id: 'old', master_code: 'TP-ROUTE-OLD', surge_stops: [] }] }) });
  const w = app.dom.window;
  try {
    w.eval(`ssRoutes = [{ id: 'RT-001', master_code: 'TP-ROUTE-NEW001', stops: [] }]; window._ssPublishFailures = [];`);
    w.eval(`ssNotePublishFailure('RT-001', ${JSON.stringify(reason)})`);
    w.eval(`renderSelfCheckPanel = function (checks) { window._checks = checks; };`);
    await w.eval(`runSmartSortSelfCheck([{ id: 'RT-001', master_code: 'TP-ROUTE-NEW001', stops: [] }], { expected: 3, assigned: 3, exceptions: 0, duplicates: 0, missing: 0 })`);
    const checks = Array.from(w._checks || []);
    const pub = checks.find((c) => c.name === 'Every route published');
    assert.ok(pub && pub.ok === false, JSON.stringify(checks.map((c) => c.name)));
    assert.match(pub.detail, /RT-001: piece_id 720431958206 is already committed to live job f8f24737/);
    assert.ok(!checks.some((c) => c.name === 'Routes matched by master code'), 'the vague message is not shown on top');
  } finally { app.cleanup(); }
});
