const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Migration 70: SmartTrack, SmartComms, Ruby and the Swarm Coordinator run on the server.
// While they do, the dispatcher's own agents send nothing; if they are switched off, the
// dispatcher claims each action first (the same keys the server claims), so a check-in or
// alert is sent once however many tabs are open. The Intel feed shows the server's activity.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'dispatcher.html'), 'utf-8');
const block = (start, end) => HTML.slice(HTML.indexOf(start), HTML.indexOf(end, HTML.indexOf(start)));
const fn = (name) => { const i = HTML.indexOf('async function ' + name + '('); return HTML.slice(i, HTML.indexOf('\n}\n', i) + 2); };

function boot({ serverAgents, claims = new Set() }) {
  const dom = new JSDOM('<div id="intelFeed"></div><div id="opsDecisionsPanel" style="display:none"><div id="opsDecisionsBody"></div></div>', { runScripts: 'outside-only' });
  const w = dom.window; const calls = []; const posted = [];
  w.__tp = async (action, args) => {
    calls.push([action, args]);
    if (action === 'agent_mode') return { server_agents: serverAgents };
    if (action === 'agent_claim') { if (claims.has(args.key)) return { claimed: false }; claims.add(args.key); return { claimed: true }; }
    if (action === 'agent_memory') return [{ id: 7, agent_name: 'SmartTrack', event_type: 'stop_past_eta', driver_name: 'Dana Driver', details: { minutes_late: 25, stop_number: 2, source: 'server' } },
      { id: 8, agent_name: 'SmartComms', event_type: 'routine_checkin', details: { source: 'browser' } }];
    if (action === 'decisions') return [{ id: 'd-1', status: 'awaiting_approval', issue: 'Dana is 25 min behind with 3 stops left', expected_impact: 'x', recommendation: 'Review moving some of the remaining 3 stops', requires_approval: true, kind: 'reassign_review', prediction: {} }];
    if (action === 'decide') return { status: 'approved' };
    return [];
  };
  w.eval(`var tpOrg=(a,b)=>window.__tp(a,b), toasts=[], toast=(m)=>toasts.push(m), smartTrackEnabled=true,
    SMARTTRACK_LATE_TOLERANCE_MIN=20, SMARTTRACK_STOP_DEADLINE={}, SMARTTRACK_ALERTED=new Set(),
    SMARTCOMMS_CHECKIN_MINUTES=30, SMARTCOMMS_CHECKED_IN=new Set(), SMARTCOMMS_COMPLETED_MSG=new Set(),
    posted=[], sbPostMsg=async (j,b)=>{posted.push([j,b]);}, sbPatch=async()=>{}, logAgentMemory=async()=>{},
    runSwarmCoordinator=async()=>null, sharedKnowledgeIsRushHour=async()=>null, tpDone=(s)=>s==='delivered', jobs=[];
    function addIntelEvent(t){ const d=document.createElement('div'); d.innerHTML=t; document.getElementById('intelFeed').appendChild(d); }`
    + block('function opsEsc(', '// Tracks the locked deadline for each job') + fn('runSmartComms') + fn('runSmartTrack'));
  return { w, calls, dom };
}
const route = (o = {}) => ({ id: 'job-1', status: 'in_transit', driver_name: 'Dana Driver', stops_completed: 0,
  surge_stops: [{ stop_number: 1 }, { stop_number: 2 }], created_at: new Date(Date.now() - 35 * 60000).toISOString(), ...o });

test('server agents on: the dispatcher\'s own SmartComms and SmartTrack send nothing', async () => {
  const t = boot({ serverAgents: true });
  t.w.eval(`jobs=[${JSON.stringify(route({ estimated_delivery_at: new Date(Date.now() - 30 * 60000).toISOString() }))}]`);
  await t.w.runSmartComms(); await t.w.runSmartTrack(); await t.w.runSmartTrack();
  assert.strictEqual(t.w.eval('posted.length'), 0);
  assert.ok(!t.calls.some(([a]) => a === 'agent_claim'), 'not even a claim: the server does it');
  t.dom.window.close();
});

test('server agents off: the dispatcher sends a check-in only after winning the claim the server also uses', async () => {
  const claims = new Set();
  const a = boot({ serverAgents: false, claims });
  a.w.eval(`jobs=[${JSON.stringify(route())}]`);
  await a.w.runSmartComms();
  assert.strictEqual(a.w.eval('posted').length, 1, 'one check-in');
  assert.ok(claims.has('checkin:job-1:1'), 'claimed with the server\'s key for that 30-minute window');
  // a second tab (or the server) already holds the claim: nothing is sent
  const b = boot({ serverAgents: false, claims });
  b.w.eval(`jobs=[${JSON.stringify(route())}]`);
  await b.w.runSmartComms();
  assert.strictEqual(b.w.eval('posted.length'), 0);
  a.dom.window.close(); b.dom.window.close();
});

test('server agents off: a SmartTrack alert is claimed per route and stop', async () => {
  const claims = new Set(['smarttrack:job-1:0']);            // the server flagged this stop already
  const t = boot({ serverAgents: false, claims });
  t.w.eval(`jobs=[${JSON.stringify(route({ estimated_delivery_at: new Date(Date.now() - 30 * 60000).toISOString() }))}]`);
  await t.w.runSmartTrack(); await t.w.runSmartTrack();
  assert.strictEqual(t.w.eval('posted.length'), 0, 'already done by the server: no second alert');
  t.dom.window.close();
});

test('the Intel feed shows what the server agents did (once), and the decisions waiting for approval', async () => {
  const t = boot({ serverAgents: true });
  await t.w.showServerAgentActivity(); await t.w.eval('serverFeedSince=null'); await t.w.showServerAgentActivity();
  const feed = [...t.w.document.querySelectorAll('#intelFeed div')].map((d) => d.textContent);
  assert.strictEqual(feed.length, 1, 'one server event, shown once; the browser-written row is not repeated');
  assert.match(feed[0], /SmartTrack flagged Dana Driver — 25 min late on stop 2/);
  await t.w.loadOpsDecisions();
  assert.strictEqual(t.w.document.getElementById('opsDecisionsPanel').style.display, '');
  assert.match(t.w.document.getElementById('opsDecisionsBody').textContent, /Review moving some of the remaining 3 stops · needs approval/);
  await t.w.decideOps('d-1', 'approve');
  assert.strictEqual(JSON.stringify(t.calls.find(([a]) => a === 'decide')[1]), JSON.stringify({ id: 'd-1', verdict: 'approve', by: 'Dispatcher' }));
  t.dom.window.close();
});

test('a SmartSort manifest can carry each stop\'s delivery promise (deliver_by) into the published route', () => {
  assert.match(HTML, /deliver_by:headers\.indexOf\('deliver_by'\)/);
  assert.match(HTML, /deliver_by:tpPromise\(opt\(c,'deliver_by'\)\)/);
  assert.match(HTML, /if\(pkg\.deliver_by&&\(!stop\.deliver_by\|\|pkg\.deliver_by<stop\.deliver_by\)\)stop\.deliver_by=pkg\.deliver_by;/);
  assert.match(HTML, /deliver_by: s\.deliver_by\|\|null,/);
  const w = new JSDOM('', { runScripts: 'outside-only' }).window;
  w.eval(HTML.slice(HTML.indexOf('function tpPromise('), HTML.indexOf('\n', HTML.indexOf('function tpPromise('))));
  assert.strictEqual(w.tpPromise('2026-11-02T23:59:00-05:00'), '2026-11-03T04:59:00.000Z');
  assert.strictEqual(w.tpPromise('not a time'), null);
  assert.strictEqual(w.tpPromise(''), null);
});
