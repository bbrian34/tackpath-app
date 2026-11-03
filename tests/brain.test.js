const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// The Brain reads only through the company gateway (tp_org) with the dispatcher's company
// session: since the October lockdown the public key can read no table, so the old direct
// reads showed nothing. It shows the company's own agent activity, decisions and outcomes.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'brain.html'), 'utf-8');

async function open({ session }) {
  const calls = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tackpath.com/brain.html', pretendToBeVisual: true,
    beforeParse(w) {
      if (session) w.localStorage.setItem('tp_dispatch_org', JSON.stringify({ token: 'tok-A', org: { id: 'org-A' } }));
      w.fetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        calls.push({ url: String(url), body });
        const json = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
        if (!String(url).endsWith('/rest/v1/rpc/tp_org')) return { ok: false, status: 401, text: async () => '{"message":"permission denied"}' };
        if (body.p_action === 'agent_memory') return json([
          { id: 1, agent_name: 'SmartTrack', event_type: 'stop_past_eta', driver_name: 'Dana <b>Driver</b>', details: { minutes_late: 25, stop_number: 2, source: 'server' }, created_at: new Date().toISOString() },
          { id: 2, agent_name: 'PromiseWatch', event_type: 'promise_at_risk', details: { stop_number: 3, expected_late_min: 9, source: 'server' }, created_at: new Date().toISOString() }]);
        if (body.p_action === 'ops_insights') return json({ by_kind: { promise_risk: { detected: 2, awaiting_approval: 1, mean_abs_error_min: 3 }, late_stop: { detected: 3, awaiting_approval: 0, mean_abs_error_min: 5 } }, promises_now: { at_risk: 1, late: 1, on_track: 4 } });
        if (body.p_action === 'decisions') return json([
          { kind: 'promise_risk', status: 'measured', issue: 'Stop 3 is heading past its delivery promise', recommendation: 'Review moving stop 3', requires_approval: true, actual: { actual_at: 'x', actual_late_min: 6 }, error_min: -3 },
          { kind: 'reassign_review', status: 'awaiting_approval', issue: 'Dana is 25 min behind with 3 stops left', recommendation: 'Review moving some of the remaining 3 stops', requires_approval: true }]);
        return json([]);
      };
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  return { dom, d: dom.window.document, calls };
}

test('signed in: activity, decisions and outcomes come from tp_org with the company session; nothing reads a table', async () => {
  const t = await open({ session: true });
  assert.ok(t.calls.length > 0);
  assert.ok(t.calls.every((c) => c.url.endsWith('/rest/v1/rpc/tp_org') && c.body.p_token === 'tok-A'), 'only the gateway, always with the session');
  assert.deepStrictEqual([...new Set(t.calls.map((c) => c.body.p_action))].sort(), ['agent_memory', 'decisions', 'ops_insights']);
  const feed = t.d.getElementById('feedList').textContent;
  assert.match(feed, /SmartTrack · server/);
  assert.match(feed, /Dana <b>Driver<\/b> is 25 min late on stop 2/, 'shown as text, not markup');
  assert.strictEqual(t.d.querySelectorAll('#feedList b').length, 0);
  assert.match(feed, /Stop 3 likely 9 min past its delivery promise/);
  assert.strictEqual(t.d.getElementById('statDecisions').textContent, '5');
  assert.strictEqual(t.d.getElementById('statAwaiting').textContent, '1');
  assert.strictEqual(t.d.getElementById('statError').textContent, '4.0');
  assert.strictEqual(t.d.getElementById('statPromises').textContent, '2');
  const dec = t.d.getElementById('decisionList').textContent;
  assert.match(dec, /Outcome: 6 min late · prediction off by 3 min/);
  assert.match(dec, /Waiting for a dispatcher to approve or reject/);
  assert.ok(t.d.querySelector('.stage') && t.d.getElementById('node-todd'), 'the agent visualization is still there');
  t.dom.window.close();
});

test('not signed in: the Brain asks for the dispatcher sign-in and reads nothing', async () => {
  const t = await open({ session: false });
  assert.strictEqual(t.calls.length, 0);
  assert.ok(t.d.getElementById('brainSignIn'));
  assert.match(t.d.getElementById('brainSignIn').innerHTML, /dispatcher\.html/);
  t.dom.window.close();
});

test('no direct table reads remain, and Sponge is called with the company session', () => {
  assert.doesNotMatch(HTML, /rest\/v1\/(?!rpc\/tp_org)/, 'no /rest/v1/<table> requests');
  assert.match(HTML, /'x-tp-session':\(tpSession\(\)\|\|\{\}\)\.token\|\|''/);
});
