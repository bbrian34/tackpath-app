// TackPath demo — automated validation.
// Runs the whole demo in a real browser (Playwright + Chromium) and checks
// what the user asked for: it finishes by itself, every status change is a
// legal one, package counts reconcile, the driver app and the dispatcher see
// the same GPS stream, nothing leaves the browser, there are no errors, and
// the controls (pause, next, previous, restart) work and reset cleanly.
//
// Usage (from the repo root, with the demo served on :8765):
//   python3 -m http.server 8765 &
//   node demo/test/validate.js [speed=4] [runs=2]
// Env: PLAYWRIGHT_MODULE (path to playwright), CHROMIUM (browser binary).
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.DEMO_URL || 'http://localhost:8765/demo/index.html';
const SPEED = process.argv[2] || '4';
const RUNS = +(process.argv[3] || 2);
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

const LEGAL = { pending: ['assigned'], assigned: ['in_transit', 'pending'], in_transit: ['delivered', 'completed_with_exceptions'], delivered: [], completed_with_exceptions: [] };

async function browser() {
  return chromium.launch({ executablePath: process.env.CHROMIUM || undefined,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings', '--disable-domain-reliability'] });
}
async function open(b, query) {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const net = { external: [], failed: [] };
  p.context().on('request', (r) => { const u = r.url(); if (!/^(http:\/\/localhost:8765\/|data:|about:|blob:)/.test(u)) net.external.push(u); });
  p.on('response', (r) => { if (r.status() >= 400) net.failed.push(r.status() + ' ' + r.url()); });
  const cons = [];
  p.on('console', (m) => { if (m.type() === 'error') cons.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => cons.push('pageerror: ' + e.message));
  await p.goto(BASE + '?' + query);
  await p.waitForFunction(() => window.DEMO && window.DEMO.hub, null, { timeout: 60000 });
  // record every status change and sample GPS agreement while it runs
  await p.evaluate(() => {
    const h = DEMO.hub, be = DEMO.be;
    window.__trace = { status: [], sync: [], scenes: [] };
    h.on('row', (d) => { if (d.table === 'jobs' && d.patch && d.patch.status) window.__trace.status.push([d.row.title, d.patch.status]); });
    h.on('row', (d) => { if (d.table === 'jobs' && d.created) window.__trace.status.push([d.row.title, 'pending']); });
    h.on('scene', (d) => window.__trace.scenes.push(d.n));
    const fixes = [];
    h.on('gps', (g) => { fixes.push([g.lat, g.lng]); if (fixes.length > 30) fixes.shift(); });
    // every location the driver app stores must be one of the GPS fixes it was given
    h.on('location', (l) => {
      if (l.driver_name !== 'Andre Coleman') return;
      window.__trace.sync.push(Math.min.apply(null, fixes.map((f) => DEMO_MAP.meters([l.lat, l.lng], f))));
    });
  });
  return { p, net, cons };
}
async function waitDone(p, sec) {
  await p.waitForFunction(() => window.DEMO.ctl.done, null, { timeout: sec * 1000, polling: 500 });
}
async function snapshot(p) {
  return p.evaluate(() => {
    const be = DEMO.be, h = DEMO.hub;
    // per route, in order; the dispatcher's own timed messages (SmartComms check-ins) are listed separately
    const title = (id) => (be.jobById(id) || {}).title || '-';
    const msgs = be.T.messages.filter((m) => m.sender_role !== 'dispatcher').map((m) => title(m.job_id) + ' ' + (m.body.match(/^[A-Z_]+::/) || ['text'])[0] + (/^STOP_[A-Z]+::/.test(m.body) ? JSON.parse(m.body.replace(/^[A-Z_]+::/, '')).stop_number : '')).sort();
    return {
      rec: DEMO.reconcile(), trace: window.__trace, errors: h.stats.errors, blocked: h.stats.blocked, denied: h.stats.denied,
      shape: { jobs: be.T.jobs.map((j) => j.title + ':' + j.status + ':' + j.driver_name + ':' + j.stops_completed + ':' + j.total_packages).sort(),
        events: be.T.events.map((e) => e.event_type).join(','), msgs: msgs.join(','), bindings: be.T.bin_bindings.map((x) => x.bin_code + '/' + x.location_code + '/' + x.state).sort().join(','),
        stops: be.T.jobs.map((j) => j.surge_stops.map((s) => s.recipient).join('>')).sort() }
    };
  });
}
function checkRun(tag, s, net, cons) {
  const r = s.rec;
  ok(tag + ' finished all 10 scenes', s.trace.scenes.join(',') === '1,2,3,4,5,6,7,8,9,10', s.trace.scenes.join(','));
  ok(tag + ' packages reconcile (received = delivered + returning)', r.received === 30 && r.routed === 30 && r.stowed === 30 && r.delivered + r.returning === r.received && r.returning === 3, JSON.stringify({ received: r.received, routed: r.routed, stowed: r.stowed, delivered: r.delivered, returning: r.returning }));
  ok(tag + ' final route states', JSON.stringify(r.routes.map((x) => x.s)) === JSON.stringify(['completed_with_exceptions', 'delivered', 'delivered']), r.routes.map((x) => x.t + '=' + x.s).join(', '));
  // status transitions
  const last = {}; const bad = [];
  s.trace.status.forEach(([t, st]) => { const prev = last[t]; if (prev !== undefined && prev !== st && !(LEGAL[prev] || []).includes(st)) bad.push(t + ': ' + prev + '→' + st); last[t] = st; });
  ok(tag + ' every status change is legal', !bad.length, bad.join('; ') || s.trace.status.length + ' changes');
  const sync = s.trace.sync; const worst = sync.length ? Math.max.apply(null, sync) : NaN;
  ok(tag + ' driver app location = demo GPS stream', sync.length > 50 && worst < 1, sync.length + ' fixes, worst gap ' + worst.toFixed(2) + ' m');
  ok(tag + ' no outside network requests', !net.external.length && !s.blocked.length, net.external.slice(0, 3).join(' ') || 'none');
  ok(tag + ' no failed local requests', !net.failed.length, net.failed.slice(0, 3).join(' ') || 'none');
  ok(tag + ' no app or console errors', !s.errors.length && !cons.length, JSON.stringify(s.errors.slice(0, 3)) + ' ' + cons.slice(0, 3).join(' | '));
}

(async () => {
  const b = await browser();
  const shapes = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    const { p, net, cons } = await open(b, 'autostart=1&sound=0&speed=' + SPEED);
    await waitDone(p, 900);
    // the dispatcher's fleet map shows Andre where the backend says he is
    const s = await snapshot(p);
    checkRun('run ' + i, s, net, cons);
    console.log('     run ' + i + ' took ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s at ' + SPEED + '×');
    shapes.push(JSON.stringify(s.shape));
    await p.close();
  }
  if (RUNS > 1) {
    const a = JSON.parse(shapes[0]), diff = [];
    shapes.slice(1).forEach((x) => { const o = JSON.parse(x); Object.keys(a).forEach((k) => { if (JSON.stringify(a[k]) !== JSON.stringify(o[k])) diff.push(k + ': ' + JSON.stringify(a[k]).slice(0, 400) + ' VS ' + JSON.stringify(o[k]).slice(0, 400)); }); });
    ok('runs are identical (routes, stops, statuses, events, messages, bins)', !diff.length, diff.join(' || '));
  }

  // dispatcher map and driver app use the same stream (checked mid-drive)
  {
    const { p } = await open(b, 'scene=5&sound=0&speed=1');
    await p.waitForFunction(() => DEMO.ctl.scene === 5 && !DEMO.ctl.turbo, null, { timeout: 120000 });
    await p.waitForTimeout(9000);
    const d = await p.evaluate(() => {
      const fm = DEMO.W.dispatcher.__demoFleetMap; const loc = DEMO.be.T.driver_locations.find((l) => l.driver_name === 'Andre Coleman');
      const pin = fm && Array.from(fm.view.markers).find((m) => /Andre/.test(m.el.textContent));
      return { backend: loc && [loc.lat, loc.lng], van: [DEMO.hub.lastFix().lat, DEMO.hub.lastFix().lng], pin: pin && [pin.pos.lat, pin.pos.lng], updated: loc && loc.updated_at };
    });
    const dist = await p.evaluate((d) => ({ vanBackend: DEMO_MAP.meters(d.van, d.backend), pinBackend: d.pin ? DEMO_MAP.meters(d.pin, d.backend) : null }), d);
    ok('mid-drive: stored location is the van’s latest fix (within one GPS step)', dist.vanBackend < 40, dist.vanBackend.toFixed(1) + ' m');
    ok('mid-drive: dispatcher map shows Andre on the same stream (≤ one 10-s refresh behind)', dist.pinBackend != null && dist.pinBackend < 400, (dist.pinBackend || 0).toFixed(0) + ' m behind the newest fix');
    await p.close();
  }

  // pause holds everything; resume continues
  {
    const { p } = await open(b, 'autostart=1&sound=0&speed=2');
    await p.waitForFunction(() => DEMO.ctl.scene >= 2, null, { timeout: 120000 });
    await p.click('#cPause');
    const a = await p.evaluate(() => ({ t: DEMO.hub.clock.now(), sc: DEMO.ctl.scene, ev: DEMO.be.T.events.length }));
    await p.waitForTimeout(4000);
    const c = await p.evaluate(() => ({ t: DEMO.hub.clock.now(), sc: DEMO.ctl.scene, ev: DEMO.be.T.events.length }));
    ok('pause freezes the demo clock and the apps', a.t === c.t && a.sc === c.sc && a.ev === c.ev, JSON.stringify({ before: a, after: c }));
    await p.click('#cPause');
    await p.waitForTimeout(3000);
    const e = await p.evaluate(() => DEMO.hub.clock.now());
    ok('resume continues', e > c.t);
    // next scene jumps forward through the real flow
    const before = await p.evaluate(() => DEMO.ctl.scene);
    await p.click('#cNext');
    await p.waitForFunction((n) => DEMO.ctl.scene > n && !DEMO.ctl.turbo, before, { timeout: 180000 });
    const after = await p.evaluate(() => ({ sc: DEMO.ctl.scene, err: DEMO.hub.stats.errors }));
    ok('next scene', after.sc === before + 1 && !after.err.length, 'scene ' + (before + 1) + ' → ' + (after.sc + 1));
    // previous scene rebuilds from a clean start and fast-forwards
    await Promise.all([p.waitForNavigation(), p.click('#cPrev')]);
    await p.waitForFunction(() => window.DEMO && DEMO.ctl.scene >= 0 && !DEMO.ctl.turbo, null, { timeout: 180000 });
    const prev = await p.evaluate(() => ({ sc: DEMO.ctl.scene, url: location.search, err: DEMO.hub.stats.errors }));
    ok('previous scene', prev.sc === after.sc - 1 && !prev.err.length, 'now scene ' + (prev.sc + 1) + ' (' + prev.url + ')');
    // restart resets everything
    await Promise.all([p.waitForNavigation(), p.click('#cRestart')]);
    await p.waitForFunction(() => window.DEMO && DEMO.ctl.running, null, { timeout: 60000 });
    const r = await p.evaluate(() => ({ jobs: DEMO.be.T.jobs.length, ev: DEMO.be.T.events.length, msgs: DEMO.be.T.messages.length, scene: DEMO.ctl.scene, clock: new Date(DEMO.hub.clock.now()).getHours() * 60 + new Date(DEMO.hub.clock.now()).getMinutes() }));
    ok('restart resets to an empty operation at 7:52', r.jobs === 0 && r.ev === 0 && r.msgs === 0 && r.scene === 0 && r.clock === 7 * 60 + 52, JSON.stringify(r));
    await p.close();
  }
  await b.close();
  const fails = results.filter((x) => !x.pass);
  console.log('\n' + (results.length - fails.length) + ' passed, ' + fails.length + ' failed');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
