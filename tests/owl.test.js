const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// OWL (the owner's view) reads only through the company gateway (tp_org) with the
// dispatcher's company session; the lockdown closed direct table reads.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'owl.html'), 'utf-8');

async function open({ session }) {
  const calls = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tackpath.com/owl.html', pretendToBeVisual: true,
    beforeParse(w) {
      if (session) w.localStorage.setItem('tp_dispatch_org', JSON.stringify({ token: 'tok-A', org: { id: 'org-A' } }));
      w.fetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        calls.push({ url: String(url), body });
        const json = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
        if (!String(url).endsWith('/rest/v1/rpc/tp_org')) return { ok: false, status: 401, text: async () => '{"message":"permission denied"}' };
        if (body.p_action === 'jobs') return json([
          { id: 'j1', status: 'delivered', price: 44, customer_name: 'Bolt Apparel', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), driver_name: 'Brian' },
          { id: 'j2', status: 'in_transit', price: 18, customer_name: 'Bolt Apparel', created_at: new Date().toISOString(), driver_name: 'Priya' }]);
        if (body.p_action === 'decisions') return json([{ id: 'd1', kind: 'promise_risk', issue: 'Stop 5 is heading past its delivery promise', expected_impact: 'Likely 16 min late if nothing changes', recommendation: 'Review moving stop 5 to a driver who can reach it sooner', risk: 'medium', status: 'awaiting_approval' }]);
        if (body.p_action === 'agent_memory') return json([{ agent_name: 'PromiseWatch', event_type: 'promise_at_risk', details: { stop_number: 5, expected_late_min: 16 }, created_at: new Date().toISOString() }]);
        if (body.p_action === 'decide') return json({ ok: true });
        return json([]);
      };
      w.alert = () => {};
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  return { dom, d: dom.window.document, calls };
}

test('signed in: jobs, agent activity and decisions come from tp_org with the company session; nothing reads a table', async () => {
  const t = await open({ session: true });
  assert.ok(t.calls.length > 0);
  assert.ok(t.calls.every((c) => c.url.endsWith('/rest/v1/rpc/tp_org') && c.body.p_token === 'tok-A'), 'only the gateway, always with the session');
  assert.strictEqual(t.d.getElementById('tp1Delivered').textContent, '1');
  assert.strictEqual(t.d.getElementById('tp1Active').textContent, '1');
  assert.match(t.d.getElementById('tp1WorkItems').textContent, /Stop 5 is heading past its delivery promise/);
  assert.match(t.d.getElementById('tp1AgentFeed').textContent, /Stop 5 likely 16 min past its delivery promise/);
  t.dom.window.approveWI('d1'); await new Promise((r) => setTimeout(r, 50));
  assert.ok(t.calls.some((c) => c.body && c.body.p_action === 'decide' && c.body.p_args.id === 'd1' && c.body.p_args.verdict === 'approve'), 'approve goes through the gateway');
  t.dom.window.close();
});

test('not signed in: OWL asks for the dispatcher sign-in and reads nothing', async () => {
  const t = await open({ session: false });
  assert.ok(t.calls.every((c) => !c.body || !c.body.p_token));
  assert.ok(t.d.getElementById('owlSignIn'));
  t.dom.window.close();
});

test('no direct table reads and no em dash', () => {
  assert.doesNotMatch(HTML, /rest\/v1\/(?!rpc\/tp_org)[a-z]/);
  assert.doesNotMatch(HTML, /—/);
});
