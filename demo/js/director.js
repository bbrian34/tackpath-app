/* TackPath live demo — the director: a fixed, scripted timeline that operates
   the real TackPath pages the way people would (tapping their buttons,
   scanning with the handheld, holding labels to the phone camera, driving),
   plus the controller (start, pause, speed, scene jumps, restart).
   Every run is identical: same data, same seed, same script. */
(function (root) {
  'use strict';
  const D = root.DEMO_DATA, M = root.DEMO_MAP, S = root.SHOW, C = D.COMPANY;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // ════════════════ boot: hub, sessions, the three real apps ════════════════
  const hub = root.__TPDEMO__ = root.createDemoHub({});
  const be = hub.backend();
  const W = {};
  const tok = { org: be.orgToken(), piq: be.orgToken() };
  const DRV = {};
  D.DRIVERS.forEach((d) => { DRV[d.name] = { d, token: be.driverToken(d.name) }; });
  const sess = (t) => JSON.stringify({ id: C.id, slug: C.slug, name: C.name, token: t });
  hub.seedStorage('dispatcher', { tp_dispatch_org: sess(tok.org), ['tp_warehouse_address_' + C.id]: C.hub.address, ['tp_ss_policy_' + C.id]: JSON.stringify(C.policy) });
  hub.seedStorage('pathiq', { tp_dispatch_org: sess(tok.piq), tp_worker: 'Keisha Moore', tp_device: 'tc56-peachline-01' });
    // Andre signs in through the app's own sign-in screen at boot (see signIn below).
  hub.seedStorage('driver', { tp_dx_perm_intro: '1' });

  // Server-side pacing so the work is watchable (the apps make the same calls either way).
  hub.latencyFn = function (app, url, body) {
    if (pace.smartsort && app === 'dispatcher') {
      if (/geocode/.test(url) || (body && body.action === 'geocode')) return 260;
      if (body && body.action === 'matrix') return 1400;
      if (/tp_org/.test(url) && body && body.p_action === 'publish_route') return 2400;
    }
    return 35;
  };
  const pace = { smartsort: false };

  const base = new URL('../', location.href).href;
  const ready = Promise.all([
    root.loadDemoApp($('fDisp'), '../dispatcher.html', 'dispatcher', base),
    root.loadDemoApp($('fPiq'), '../stow.html', 'pathiq', base),
    root.loadDemoApp($('fDrv'), 'vendor/driver-app.html', 'driver', new URL('vendor/', location.href).href)
  ]).then(() => Promise.all(['dispatcher', 'pathiq', 'driver'].map((a) => hub.whenReady(a).then((w) => { W[a] = w; }))));

  // phone system layer follows what the driver app asks the phone to do
  hub.on('openUrl', (e) => {
    if (e.app !== 'driver' || !/^google\.navigation:/.test(e.url || '')) return;
    const m = /q=([-\d.]+),([-\d.]+)/.exec(e.url);
    if (!m) return;
    const fix = hub.lastFix();
    S.nav.show({ lat: +m[1], lng: +m[2] }, fix || { lat: C.hub.lat, lng: C.hub.lng, heading: 0 });
  });
  hub.on('arrivalStart', (e) => S.bubble.arm({ lat: e.lat, lng: e.lng }));
  hub.on('arrivalStop', () => S.bubble.disarm());
  hub.on('gps', (p) => { S.nav.update(p); S.bubble.onFix(p); });
  hub.on('speak', (e) => { if (e.app === 'driver') S.speak(e.text); });
  hub.on('notification', (e) => { const n = e.n || {}; if (n.title || n.body) S.notify(n.title || 'TackPath', n.body || ''); });

  // ════════════════ timing primitives (pause- and speed-aware) ════════════════
  const ctl = { userSpeed: 1, turbo: false, scene: -1, target: -1, running: false, done: false };
  function applySpeed() { hub.clock.setSpeed(ctl.userSpeed * (ctl.turbo ? 14 : 1)); S.quiet = ctl.turbo; }
  function wait(sec) {
    return new Promise((res) => {
      let left = sec * 1000, last = performance.now();
      (function tick() {
        const now = performance.now();
        if (!hub.clock.paused()) left -= (now - last) * hub.clock.speed();
        last = now;
        if (left <= 0) return res();
        setTimeout(tick, Math.max(8, Math.min(60, left / hub.clock.speed())));
      })();
    });
  }
  async function until(fn, label, maxSec) {
    const limit = (maxSec || 30) * 1000;
    let spent = 0, last = performance.now();
    for (;;) {
      let v = null; try { v = fn(); } catch (e) {}
      if (v) return v;
      const now = performance.now();
      if (!hub.clock.paused()) spent += (now - last) * Math.min(4, hub.clock.speed());
      last = now;
      if (spent > limit) throw new Error('timed out waiting for: ' + label);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  const txt = (app, sel) => { const e = S.find(app, sel); return e ? e.textContent : ''; };
  const visible = (app, sel) => { const e = S.find(app, sel); return !!(e && e.offsetParent !== null && getComputedStyle(e).display !== 'none'); };
  const onScreen = (id) => { const e = W.driver.document.getElementById(id); return !!(e && e.classList.contains('on')); };
  const setRate = (r) => hub.clock.setRate(r);
  const at = (h, m) => { const t = new Date(hub.clock.now()); t.setHours(h, m, 0, 0); return t.getTime(); };
  const jumpTo = (h, m) => { const d = at(h, m) - hub.clock.now(); if (d > 0) hub.clock.jump(d); };
  async function tap(app, sel, pause) { S.tap(app, sel); await wait(pause == null ? 0.5 : pause); }
  function byText(app, sel, re) {
    const w = W[app]; if (!w) return null;
    return Array.prototype.find.call(w.document.querySelectorAll(sel), (e) => re.test(e.textContent || ''));
  }

  // ════════════════ helpers for the operation ════════════════
  const routes = () => be.T.jobs.filter((j) => j.job_type === 'surge').sort((a, b) => a.title.localeCompare(b.title));
  const routeNo = (j) => (/RT-(\d+)/.exec(j.title) || [])[1];
  const BIN = { '001': { code: '1A', loc: 'A-01' }, '002': { code: '2A', loc: 'A-02' }, '003': { code: '3A', loc: 'A-03' } };
  const OWNER = { '001': 'Andre Coleman', '002': 'Priya Nair', '003': 'Luis Ortega' };
  // Every physical unit to stow, per route, with its stop number.
  function unitsOf(j) {
    const out = [];
    (j.surge_stops || []).forEach((s, i) => (s.pkgs || []).forEach((pk) => {
      const n = Math.max(1, parseInt(pk.required_count) || 1);
      for (let u = 1; u <= n; u++) out.push({ code: String(pk.tracking_number || pk.order_id).toUpperCase(), stop: i + 1, unit: u, of: n, job: j, recipient: s.recipient });
    }));
    return out;
  }

  // ── simulated drivers (Priya, Luis): the same driver calls their phones
  //    would make, timed from the demo clock ──
  const sims = [];
  function planSim(name, job, departAt) {
    const stops = job.surge_stops, legs = [];
    let t = departAt, from = [C.hub.lat, C.hub.lng];
    stops.forEach((s, i) => {
      const to = [s.coords.lat, s.coords.lng], r = M.route(from, to);
      legs.push({ i, r, t0: t, t1: t + r.seconds * 1000 * 1.1 });
      t = legs[legs.length - 1].t1 + 2 * 60000; // 2 minutes at each stop
      from = to;
    });
    sims.push({ name, job, token: DRV[name].token, legs, next: 0, started: false, finished: false, lastPost: 0, endsAt: legs[legs.length - 1].t1 + 90000 });
  }
  function drv(token, action, args) { return be.rpc('tp_driver', { p_token: token, p_action: action, p_args: args }); }
  function simTick() {
    const now = hub.clock.now();
    sims.forEach((s) => {
      if (s.finished || now < s.legs[0].t0) return;
      if (!s.started) {
        s.started = true;
        drv(s.token, 'update_job', { id: s.job.id, patch: { status: 'in_transit', picked_up_at: new Date(s.legs[0].t0).toISOString() } });
      }
      // deliveries whose time has come
      while (s.next < s.legs.length && now >= s.legs[s.next].t1 + 90000) {
        const L = s.legs[s.next], st = s.job.surge_stops[L.i], total = s.legs.length;
        drv(s.token, 'post_message', { job_id: s.job.id, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: L.i + 1, stop_total: total, recipient: st.recipient, address: st.address, order_id: st.order_id, delivered_at: new Date(L.t1 + 90000).toISOString(), packages_verified: (st.pkgs || []).reduce((n, p) => n + (parseInt(p.required_count) || 1), 0), label_damaged_units: 0 }) });
        s.next++;
        drv(s.token, 'update_job', { id: s.job.id, patch: s.next >= total ? { status: 'delivered', stops_completed: total } : { stops_completed: s.next } });
        if (s.next >= total) s.finished = true;
      }
      if (s.finished) return;
      // position: driving a leg, or parked at a stop
      const L = s.legs.find((l) => now >= l.t0 && now < l.t1);
      let p;
      if (L) { const f = (now - L.t0) / (L.t1 - L.t0); p = M.along(L.r.coords, L.r.meters * f); }
      else { const prev = s.legs.filter((l) => now >= l.t1).pop(); const c = prev ? prev.r.coords[prev.r.coords.length - 1] : [C.hub.lat, C.hub.lng]; p = { lat: c[0], lng: c[1] }; }
      if (now - s.lastPost >= 15000) { s.lastPost = now; drv(s.token, 'location', { job_id: s.job.id, lat: p.lat, lng: p.lng, accuracy: 8, speed: L ? 11 : 0 }); }
    });
  }
  setInterval(() => { if (ctl.running && !hub.clock.paused()) simTick(); }, 250);

  // ── Andre's van: one GPS stream feeds his app (and through it the
  //    dispatcher) and the phone's navigation screen ──
  let van = { lat: C.hub.lat, lng: C.hub.lng, heading: 0 };
  hub.lastFix = () => van;
  function fix(p, speed) { van = { lat: p.lat, lng: p.lng, heading: p.heading || van.heading }; hub.gpsFix(van.lat, van.lng, van.heading, speed || 0); }
  // Drive to a point along real streets; `realSec` is how long it takes on screen at 1×.
  async function driveTo(dest, realSec, notBefore) {
    const r = M.route([van.lat, van.lng], [dest.lat, dest.lng]);
    const t0 = hub.clock.now();
    const dur = Math.max(r.seconds * 1.15 * 1000, notBefore ? notBefore - t0 : 0);
    setRate(Math.max(1, dur / 1000 / realSec));
    for (;;) {
      const f = Math.min(1, (hub.clock.now() - t0) / dur);
      // ease in and out of each leg (pulling away, slowing for the stop)
      const a = 0.1, g = f < a ? (f * f) / (2 * a) : f > 1 - a ? (1 - a) - ((1 - f) * (1 - f)) / (2 * a) : f - a / 2;
      const p = M.along(r.coords, r.meters * Math.max(0, Math.min(1, g / (1 - a))));
      fix(p, f < 1 ? 11 : 0);
      if (f >= 1) break;
      await new Promise((res) => setTimeout(res, 120));
      while (hub.clock.paused()) await new Promise((res) => setTimeout(res, 100));
    }
    const end = r.coords[r.coords.length - 1];
    fix({ lat: end[0], lng: end[1], heading: van.heading }, 0);
    setRate(1);
    return r;
  }

  // ── PathIQ scanning ──
  const piqCard = () => (txt('pathiq', '#stowResult') || '') + ' ' + (S.find('pathiq', '#scanFlipInner') && S.find('pathiq', '#scanFlipInner').classList.contains('flipped') ? 'FLIPPED ' + txt('pathiq', '#flipBinNumber') : '');
  // PathIQ rebuilds its package index on every 5-second poll and the index is
  // empty while the poll waits for the server (a real race — see findings).
  // The demo scans between polls, like a worker who rescans after a miss.
  const piqIndexed = () => { return W.pathiq.__demoPeek('binMapSize') > 0; };
  async function piqScan(code, expectRe, ok) {
    await until(piqIndexed, 'PathIQ package index', 10);
    S.beam(ok);
    hub.scan(code);
    if (expectRe) await until(() => expectRe.test(piqCard()), 'PathIQ shows ' + expectRe, 15);
  }
  const shownBins = {};
  async function stowUnit(u, gap, opts) {
    opts = opts || {};
    const b = BIN[routeNo(u.job)];
    S.rack.feed('<b>' + u.code + '</b><span>' + u.recipient + '</span><span>' + (u.of > 1 ? 'box ' + u.unit + ' of ' + u.of : '1 box') + '</span>');
    if (!shownBins[b.code]) {
      // First package for this route: PathIQ asks for an empty bin.
      await piqScan(u.code, /OPEN NEW BIN/);
      if (opts.narrate) { S.highlight('pathiq', '#stowResult', 'No bin yet for ' + u.job.title.replace('Surge Route ', ''), 'amber'); S.caption('First package for <b>' + u.job.title.replace('Surge Route ', '') + '</b>: PathIQ asks for an empty bin.'); }
      await wait(gap * 1.6);
      S.rack.feed('BIN ' + b.code, 'qr');
      await piqScan('BIN:' + b.code, /SCAN LOCATION QR/);
      await wait(gap);
      S.rack.feed('LOC ' + b.loc, 'qr');
      await piqScan('LOC:' + b.loc, /Bin Open/);
      S.rack.open(b.code, u.job.title.replace('Surge Route ', ''), unitsOf(u.job).length);
      shownBins[b.code] = true;
      if (opts.narrate) { S.highlight('pathiq', '#stowResult', 'Bin ' + b.code + ' opened at ' + b.loc, 'green'); S.caption('Bin <b>' + b.code + '</b> at location <b>' + b.loc + '</b> now belongs to ' + u.job.title.replace('Surge Route ', '') + '. Scan the package again.'); }
      await wait(gap * 1.6);
      S.unhighlight();
    }
    await piqScan(u.code, /FLIPPED BIN/);
    if (opts.narrate) { S.highlight('pathiq', '#scanFlipContainer', 'Put it in BIN ' + b.code, 'green'); }
    await wait(gap);
    if (opts.wrongFirst) {
      const wrong = Object.values(BIN).find((x) => x.code !== b.code && shownBins[x.code]);
      S.rack.feed('BIN ' + wrong.code, 'qr');
      await piqScan('BIN:' + wrong.code, /Wrong Bin/, false);
      S.highlight('pathiq', '#stowResult', 'Wrong bin — nothing counted', 'red');
      S.caption('Wrong bin? PathIQ rejects it and keeps the package waiting for <b>BIN ' + b.code + '</b>.');
      await wait(2.6);
      S.unhighlight();
    }
    const useLoc = opts.useLoc;
    S.rack.feed((useLoc ? 'LOC ' + b.loc : 'BIN ' + b.code), 'qr');
    const before = be.T.events.filter((e) => e.event_type === 'package.stowed').length;
    await piqScan(useLoc ? 'LOC:' + b.loc : 'BIN:' + b.code, null);
    await until(() => be.T.events.filter((e) => e.event_type === 'package.stowed').length > before, 'stow recorded', 15);
    S.rack.add(b.code);
    if (opts.narrate) S.unhighlight();
  }

  // ── driver phone camera ──
  async function cameraScan(code, resultSel, expectRe, kind) {
    S.find('driver', resultSel); // ensure exists
    hub.showCamera({ kind: kind || 'label', code });
    await until(() => expectRe.test(txt('driver', resultSel)), 'driver app shows ' + expectRe + ' for ' + code, 20);
  }

  // signature: real strokes on the app's own signature pad
  async function sign(name) {
    const pad = S.find('driver', '#sigPad'); if (!pad) return;
    const r = pad.getBoundingClientRect(), w = W.driver;
    const fire = (type, x, y) => pad.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y }));
    const W0 = r.width, H0 = r.height, n = 70;
    let x0 = W0 * 0.12, y0 = H0 * 0.6;
    fire('mousedown', x0, y0);
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = W0 * (0.12 + 0.72 * t), y = H0 * (0.55 + 0.18 * Math.sin(t * 19) * (1 - t * 0.4) - 0.1 * Math.sin(t * 5));
      fire('mousemove', x, y);
      if (i % 6 === 0) await wait(0.03);
    }
    fire('mouseup', W0 * 0.84, H0 * 0.5);
    fire('mousedown', W0 * 0.2, H0 * 0.78); fire('mousemove', W0 * 0.5, H0 * 0.8); fire('mousemove', W0 * 0.78, H0 * 0.76); fire('mouseup', W0 * 0.78, H0 * 0.76);
  }

  // ════════════════ the scenes ════════════════
  const SCENES = [];
  const scene = (n, title, run) => SCENES.push({ n, title, run });

  // ── 1. Intake / SmartSort ──
  scene('1', 'Intake · SmartSort', async () => {
    S.layout('intake'); S.act('Act 1', 'Intake · SmartSort');
    setRate(1);
    S.caption('<b>7:52 AM.</b> Peachline Courier’s client sends today’s manifest: <b>30 packages</b> for <b>17 addresses</b>.');
    S.manifest(D.manifestCsv());
    await wait(4);
    const btn = byText('dispatcher', 'button', /\+ New Route/);
    S.highlight('dispatcher', btn, 'Dispatcher: + New Route');
    S.caption('The dispatcher uploads it to <b>SmartSort</b>.');
    await wait(2.2);
    S.ripple(...(() => { const r = S.rectOf('dispatcher', btn); return [r.x + r.w / 2, r.y + r.h / 2]; })());
    S.unhighlight();
    pace.smartsort = true;
    W.dispatcher.openSmartSortDrawer();
    W.dispatcher.handleFile(new W.dispatcher.File([D.manifestCsv()], 'peachline-manifest.csv', { type: 'text/csv' }));
    await wait(1.2);
    S.caption('SmartSort reads every line, finds each address, and measures real road time between every pair of stops.');
    const grid = () => { const g = S.find('dispatcher', '#routeGrid'); return g && g.children.length && g.offsetParent !== null ? g : null; };
    await until(grid, 'SmartSort route cards', 90);
    await wait(0.4);
    S.highlight('dispatcher', S.find('dispatcher', '#smartSortDrawer'), '3 routes · 30 packages accounted for', 'green');
    S.caption('<b>3 routes</b> built on real road time. Every package is accounted for before anything is published.');
    await until(() => routes().length === 3, '3 routes published', 40);
    await until(() => !S.find('dispatcher', '#smartSortDrawer').classList.contains('open'), 'SmartSort done', 20);
    pace.smartsort = false;
    S.unhighlight();
    await wait(0.6);
    const rows = Array.prototype.filter.call(W.dispatcher.document.querySelectorAll('tr[onclick*="openDrawer"]'), (r) => /Surge Route/.test(r.textContent));
    if (rows.length) {
      const a = S.rectOf('dispatcher', rows[0]), b = S.rectOf('dispatcher', rows[rows.length - 1]);
      S.highlightBox(a.x - 6, a.y - 6, a.w + 12, b.y + b.h - a.y + 12, 'Published · waiting for a driver', 'green');
    }
    S.caption('Published to the board as <b>pending</b>. No driver yet.');
    await wait(4.5);
    S.unhighlight();
  });

  // ── 2. Dispatcher assigns ──
  scene('2', 'Dispatch assigns drivers', async () => {
    W.dispatcher.closeSmartSortDrawer();
    S.layout('assign'); S.act('Act 2', 'Dispatch assigns drivers');
    S.caption('Dispatch board: three new routes waiting. On the right, Andre Coleman’s phone — signed in, waiting for work.');
    await wait(3.5);
    const r1 = routes()[0];
    const row = 'tr[onclick*="' + r1.id + '"]';
    await until(() => S.find('dispatcher', row), 'route row on board', 20);
    S.highlight('dispatcher', row, 'RT-001 · 7 stops · 16 packages');
    await wait(2);
    await tap('dispatcher', row, 1.2);
    for (const r of routes()) {
      const who = OWNER[routeNo(r)];
      if (r !== r1) { W.dispatcher.openDrawer(r.id); await wait(0.6); }
      const sel = await until(() => { const s = S.find('dispatcher', '#assignDriverSelect'); return s && s.options.length > 1 && s; }, 'driver list', 15);
      S.highlight('dispatcher', sel, r === r1 ? 'Pick the driver' : null);
      // focusing the picker holds the drawer still (the board refreshes every 2 s)
      sel.dispatchEvent(new W.dispatcher.FocusEvent('focusin', { bubbles: true }));
      await wait(r === r1 ? 1.4 : 0.5);
      const sel2 = S.find('dispatcher', '#assignDriverSelect');
      sel2.value = who; sel2.dispatchEvent(new W.dispatcher.Event('change', { bubbles: true }));
      await wait(r === r1 ? 1.0 : 0.4);
      const assign = byText('dispatcher', '#drawer button', /^Assign$/);
      S.highlight('dispatcher', assign, r === r1 ? 'Assign to ' + who : null);
      await wait(r === r1 ? 0.8 : 0.3);
      await tap('dispatcher', assign, r === r1 ? 0.6 : 0.3);
      await until(() => be.jobById(r.id).status === 'assigned', 'assigned ' + r.title, 10);
      if (r === r1) {
        S.unhighlight();
        S.caption('Assigned. In production TackPath also texts Andre; the demo records that text and <b>does not send it</b>.');
        S.flow('route assignment → Andre’s app', 1160, 300);
        await until(() => onScreen('scRouteAccepted'), 'Andre sees his route', 20);
        await wait(0.8);
        S.flow('');
        S.highlight('driver', '#dxDayCard', 'Andre’s route — WAITING FOR WAREHOUSE', 'amber');
        S.caption('Andre’s app picks up <b>his</b> route: 7 stops, 16 packages. Pickup stays locked: <b>Waiting for warehouse</b>.');
        await wait(5);
        S.unhighlight();
        S.caption('Priya Nair takes RT-002 and Luis Ortega RT-003.');
      }
    }
    W.dispatcher.closeDrawer();
    await wait(2);
  });

  // ── 3. PathIQ sort on the TC56 ──
  const SORT = { held: [] };
  scene('3', 'PathIQ · sort and stage', async () => {
    S.layout('sort'); S.act('Act 3', 'PathIQ · sort and stage');
    jumpTo(8, 4);
    const rs = routes();
    S.rack.reset(rs.map((r) => BIN[routeNo(r)]));
    S.caption('<b>8:04 AM.</b> The truck is unloaded. Keisha sorts with PathIQ on a Zebra TC56: scan the package, scan the bin.');
    await wait(2.5);
    await tap('pathiq', '.big-card[onclick*="stow"]', 1.4);
    // packages come off the truck mixed up; RT-001’s last three are held back for act 4
    const lists = rs.map(unitsOf);
    const order = [];
    let i = 0;
    while (lists.some((l) => l.length)) { const l = lists[i % lists.length]; if (l.length) order.push(l.shift()); i++; }
    const r1 = rs[0];
    const r1Units = order.filter((u) => u.job === r1);
    SORT.held = r1Units.slice(-3);
    const run = order.filter((u) => !SORT.held.includes(u));
    setRate(14);
    for (let k = 0; k < run.length; k++) {
      const u = run[k];
      const detailed = k < 2;
      const gap = detailed ? 1.5 : Math.max(0.12, 0.85 * Math.pow(0.86, k - 2));
      if (k === 0) S.caption('Each package shows its route’s bin. A route’s first package opens a bin and binds it to a location.');
      if (k === 2) S.caption('Card flips to the bin, the bin scan confirms it. Every scan is recorded.');
      if (k === 9) S.caption('The floor speeds up. PathIQ counts every package against its route.');
      await stowUnit(u, gap, { narrate: detailed, wrongFirst: k === 6, useLoc: k === 4 });
      if (k === 6) S.caption('The floor speeds up. PathIQ counts every package against its route.');
      const b = BIN[routeNo(u.job)];
      if (/Bin Complete/.test(txt('pathiq', '#stowResult'))) {
        S.rack.ready(b.code);
        const who = OWNER[routeNo(u.job)];
        if (who !== 'Andre Coleman' && !sims.some((x) => x.name === who)) planSim(who, u.job, hub.clock.now() + 7 * 60000);
        S.highlight('pathiq', '#stowResult', u.job.title.replace('Surge Route ', '') + ' staged', 'green');
        S.caption('<b>' + u.job.title.replace('Surge Route ', '') + '</b> is complete: bin <b>' + b.code + '</b> is <b>ready for pickup</b>.');
        await wait(2.6);
        S.unhighlight();
      }
      await wait(gap * 0.5);
    }
    setRate(1);
    S.caption('RT-002 and RT-003 are staged. RT-001 has three packages to go. Andre’s app already reads <b>Staging in progress</b>.');
    S.highlight('driver', '#dxStage', 'Staging in progress', 'amber');
    await wait(4);
    S.unhighlight();
  });

  // ── 4. Route ready: WAITING → READY across apps ──
  scene('4', 'Route ready for pickup', async () => {
    S.layout('ready'); S.act('Act 4', 'Route ready for pickup');
    S.caption('The last three RT-001 packages. Watch both screens.');
    S.flow('PathIQ bin status → driver app', 812, 250);
    await wait(2.5);
    for (let k = 0; k < SORT.held.length; k++) await stowUnit(SORT.held[k], 1.0, {});
    await until(() => /Bin Complete/.test(txt('pathiq', '#stowResult')), 'RT-001 complete', 10);
    S.rack.ready('1A');
    S.highlight('pathiq', '#stowResult', 'Bin 1A complete · staged', 'green');
    S.caption('PathIQ: <b>Bin complete · staged · ready for pickup</b>. All 16 RT-001 packages are in bin 1A.');
    await until(() => /ready for pickup/i.test(txt('driver', '#dxStage')), 'driver app turns READY', 20);
    S.flow('bin 1A ready → Andre: READY FOR PICKUP', 760, 250, true);
    S.highlight('driver', '#dxDayCard', 'READY FOR PICKUP · Bin 1A · A-01', 'green');
    S.caption('Seconds later Andre’s app turns <b>Ready for pickup</b>, names <b>bin 1A at A-01</b>, and unlocks pickup.');
    await wait(5.5);
    S.flow(''); S.unhighlight();
  });

  // ── 5. Driver pickup ──
  scene('5', 'Driver pickup', async () => {
    S.layout('pickup'); S.act('Act 5', 'Driver pickup');
    hub.clock.jump(4 * 60000);   // Andre walks over from the drivers' lounge
    fix({ lat: C.hub.lat, lng: C.hub.lng, heading: 90 });
    S.caption('A few minutes later Andre is at bin 1A. He taps <b>At pickup</b>.');
    // Priya and Luis picked their bins up a few minutes ago and are on the road.
    const rs = routes();
    S.rack.picked('2A'); S.rack.picked('3A');
    await wait(2.5);
    const atPickup = W.driver.document.querySelector('#scRouteAccepted button:not(.dx-btn)');
    await tap('driver', atPickup, 1.2);
    await until(() => visible('driver', '#binScanOverlay'), 'bin scan screen', 10);
    S.caption('First the bin. Andre grabs <b>bin 2A</b> by mistake…');
    await wait(1.5);
    await cameraScan('BIN:2A', '#binScanLastResult', /WRONG BIN/, 'bin');
    S.highlight('driver', '#binScanLastResult', 'Wrong bin — rejected', 'red');
    S.caption('<b>Wrong bin.</b> The app checks the scan against PathIQ’s binding: this route is in bin 1A.');
    await wait(3.4);
    S.unhighlight();
    await cameraScan('BIN:1A', '#binScanLastResult', /CONFIRMED/, 'bin');
    S.highlight('driver', '#binScanLastResult', 'Bin 1A confirmed', 'green');
    S.caption('<b>Bin 1A confirmed.</b> Now every package goes into the van with a scan.');
    await until(() => visible('driver', '#loadPkgOverlay'), 'loading screen', 10);
    await wait(1.2); S.unhighlight();
    const units = unitsOf(rs[0]);
    S.rack.clearFeed();
    setRate(9);   // loading 16 boxes takes a few minutes of real time
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      await cameraScan(u.code, '#loadPkgLastScan', /LOADED/);
      S.rack.take('1A');
      if (k === 0) { S.highlight('driver', '#loadPkgOverlay', 'Loaded · stop number shown', 'green'); S.caption('Each scan is counted against the route and says which stop it is for.'); await wait(2.2); S.unhighlight(); }
      if (k === 3) S.caption('Faster now — 16 packages.');
      if (k < units.length - 1) {
        const ok = await until(() => S.find('driver', '#loadPkgOkBtn'), 'OK button', 10);
        await wait(k < 2 ? 0.8 : Math.max(0.1, 0.45 * Math.pow(0.8, k)));
        await tap('driver', ok, Math.max(0.08, 0.3 * Math.pow(0.8, k)));
      }
    }
    await until(() => onScreen('scPickupComplete'), 'pickup complete', 10);
    setRate(1);
    S.rack.picked('1A');
    S.highlight('driver', '#scPickupComplete', '16 packages loaded', 'green');
    S.caption('All 16 loaded. Andre starts the route.');
    await wait(2.6);
    S.unhighlight();
    await tap('driver', '#scPickupComplete button', 1);
    await until(() => be.jobById(rs[0].id).status === 'in_transit', 'route in transit', 10);
    S.caption('RT-001 is now <b>in transit</b> on every screen.');
    await wait(2.5);
  });

  // ── 6. Live map + handoff to navigation ──
  let stopIdx = 0;
  scene('6', 'On the road · live map', async () => {
    S.layout('drive'); S.act('Act 6', 'On the road · live map');
    await tap('dispatcher', '.tbtab[onclick*="smarttrack"]', 1.2);
    try { await W.dispatcher.refreshFleetMap(); } catch (e) {}
    S.caption('Dispatch switches to <b>SmartTrack</b>. Priya and Luis are already out; their dots move from their phones’ GPS.');
    await wait(3.5);
    S.highlight('driver', '#surgeRow0', 'Stop 1 · tap to navigate');
    S.caption('Andre taps <b>stop 1</b>. TackPath hands the trip to Google Maps and starts its arrival watcher.');
    await wait(2.2);
    S.unhighlight();
    await tap('driver', '#surgeRow0', 0.2);
    await until(() => S.nav.isOpen(), 'navigation opens', 10);
    await wait(1.2);
    S.flow('one GPS stream → driver phone + dispatcher map', 560, 120);
    S.caption('The <b>same GPS stream</b> drives the phone’s navigation and Andre’s dot on the dispatcher’s map.');
    const st = routes()[0].surge_stops[0];
    // drive most of the way here; the arrival happens in the next act
    const r = M.route([van.lat, van.lng], [st.coords.lat, st.coords.lng]);
    const stopShort = M.along(r.coords, Math.max(0, r.meters - 900));
    await driveTo(stopShort, 14);
    S.flow('');
  });

  // ── 7. Arrival: back to TackPath ──
  scene('7', 'Arrival · back to TackPath', async () => {
    S.layout('drive'); S.act('Act 7', 'Arrival · back to TackPath');
    const st = routes()[0].surge_stops[0];
    S.caption('Inside half a mile, TackPath’s floating button appears over Maps (faded, so it doesn’t distract).');
    await driveTo(st.coords, 9);
    await until(() => S.bubble.state() === 'arrived', 'arrived bubble', 10);
    S.highlightBox(...(() => { const b = S.bubble.el().getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale(); return [(b.left - sr.left) / k - 6, (b.top - sr.top) / k - 6, b.width / k + 12, b.height / k + 12]; })(), 'Arrived · tap to deliver', 'green');
    S.caption('Within 80 m it turns green: <b>Arrived — tap here to deliver</b>.');
    await wait(3.2);
    await returnToApp();
    S.caption('One tap brings Andre straight back to TackPath, on this stop.');
    await wait(2.6);
  });
  async function returnToApp() {
    const b = S.bubble.el().getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale();
    S.ripple((b.left + b.width / 2 - sr.left) / k, (b.top + b.height / 2 - sr.top) / k);
    S.unhighlight();
    await wait(0.3);
    S.nav.hide();
    W.driver.onDeepLinkArrived();            // what tackpath://arrived does
    await until(() => visible('driver', '#arrivalPrompt'), 'arrival prompt', 10);
  }

  // one delivery, start (arrival prompt) to the next stop's countdown
  async function deliver(i, opts) {
    const job = routes()[0], st = job.surge_stops[i], fast = opts.fast;
    setRate(fast ? 12 : 4);   // parking, walking to the door, scanning, proof: a few minutes per stop
    await tap('driver', '#arrivalPrompt button', fast ? 0.4 : 1);
    await until(() => visible('driver', '#dlvScanOverlay'), 'delivery scan', 10);
    if (!fast) { S.caption('Before proof of delivery, every package for this stop is scanned.'); }
    const pieces = unitsOf(job).filter((u) => u.stop === i + 1);
    for (let k = 0; k < pieces.length; k++) {
      await cameraScan(pieces[k].code, '#dlvScanResult', /PACKAGE SCANNED|ACCOUNTED/);
      if (k < pieces.length - 1) { const nx = await until(() => S.find('driver', '#dlvNextBtn'), 'NEXT', 10); await wait(fast ? 0.2 : 0.6); await tap('driver', nx, 0.3); }
    }
    const go = await until(() => S.find('driver', '#dlvProceedBtn'), 'proof of delivery button', 10);
    if (!fast) { S.highlight('driver', go, 'All packages for stop ' + (i + 1), 'green'); await wait(1.4); S.unhighlight(); }
    await tap('driver', go, fast ? 0.4 : 0.9);
    await until(() => onScreen('scPOD'), 'proof of delivery screen', 10);
    const sig = !!st.signature_required;
    if (sig) {
      if (!fast) S.caption('This stop needs a signature: <b>Handed to customer</b>, then the customer signs.');
      await tap('driver', '.dx-choice[data-c="handed"]', fast ? 0.4 : 1);
      await sign(st.recipient);
      await wait(fast ? 0.3 : 0.8);
    } else {
      if (!fast) S.caption('Left at the front door: <b>a photo is required</b>.');
      await tap('driver', '.dx-choice[data-c="front_door"]', fast ? 0.3 : 1);
      hub.showCamera({ kind: 'door', unit: st.unit || '' }, false);
      await tap('driver', '#podCameraBtn', fast ? 0.6 : 1.2);
      await until(() => visible('driver', '#podCaptureBtn'), 'camera ready', 10);
      await tap('driver', '#podCaptureBtn', fast ? 0.3 : 0.9);
    }
    if (!fast) { S.highlight('driver', sig ? '#sigPad' : '#podPhotoPreview', sig ? 'Signed' : 'Photo taken', 'green'); await wait(1.4); S.unhighlight(); }
    const before = be.T.messages.filter((m) => /^STOP_DELIVERED::/.test(m.body)).length;
    setRate(1);   // the next-stop countdown runs in real seconds
    await tap('driver', '#podSubmitBtn', 0.4);
    await until(() => be.T.messages.filter((m) => /^STOP_DELIVERED::/.test(m.body)).length > before, 'delivery recorded', 15);
  }
  async function driveStop(i, realSec, notBefore) {
    const st = routes()[0].surge_stops[i];
    await until(() => S.nav.isOpen(), 'navigation opens for stop ' + (i + 1), 15);
    await wait(0.4);
    await driveTo(st.coords, realSec, notBefore);
    await until(() => S.bubble.state() === 'arrived', 'arrived bubble', 10);
    await wait(0.6);
    await returnToApp();
  }

  // ── 8. Deliveries ──
  scene('8', 'Delivery · proof', async () => {
    S.layout('drive'); S.act('Act 8', 'Delivery · proof of delivery');
    S.caption('<b>Mark arrived</b>, then the stop’s packages.');
    await deliver(0, {});
    await until(() => S.find('driver', '#dxNext'), 'next-stop countdown', 10);
    S.highlight('driver', '#dxNext', 'Next stop in 5 s', 'green');
    S.caption('<b>Delivered.</b> Dispatch sees it now; the next stop opens by itself after 5 seconds.');
    const dispDone = S.find('dispatcher', '#tab-smarttrack');
    await wait(3);
    S.unhighlight();
    // stops 2..5, faster
    for (let i = 1; i < 5; i++) {
      S.caption('Stop ' + (i + 1) + ' of 7 · ' + routes()[0].surge_stops[i].recipient + (i === 1 ? ' — the same loop, faster.' : ''));
      await driveStop(i, i === 1 ? 7 : 4.5);
      await deliver(i, { fast: true });
    }
  });

  // ── 9. A problem at a stop: the driver reports it, dispatch sees it ──
  const EXC = 5;   // stop 6 · Gilbert Street Bakery · 3 packages
  scene('9', 'Exception · business closed', async () => {
    S.layout('drive'); S.act('Act 9', 'Exception · business closed');
    const job = routes()[0], st = job.surge_stops[EXC];
    S.caption('Stop 6: <b>' + st.recipient + '</b>, 3 packages.');
    // Priya and Luis finish their routes while Andre is on this leg.
    const others = sims.length ? Math.max.apply(null, sims.map((x) => x.endsAt)) + 60000 : 0;
    await driveStop(EXC, 7, others);
    setRate(3);
    await tap('driver', '#arrivalPrompt button', 0.8);
    await until(() => visible('driver', '#dlvScanOverlay'), 'delivery scan', 10);
    S.caption('The shop is closed and nobody answers. Andre can’t deliver, so he reports it.');
    await wait(2);
    await tap('driver', '#dlvScanOverlay button[onclick="cancelDeliveryScan()"]', 0.4);
    await until(() => onScreen('scSurgeDelivery'), 'stop screen', 10);
    await wait(0.6);
    S.highlight('driver', '#dxProblemBtn', 'Problem', 'red');
    await wait(1.6);
    await tap('driver', '#dxProblemBtn', 1.2);
    const closed = await until(() => byText('driver', '#dxSheet button', /Business closed/), 'problem list', 10);
    S.highlight('driver', closed, 'Business closed', 'red');
    S.caption('Six supported reasons. With <b>Business closed</b> the packages go back to the station.');
    await wait(2.4);
    await tap('driver', closed, 1.4);
    const rep = await until(() => S.find('driver', '#dxSheet .dx-btn.bad'), 'report button', 10);
    S.highlight('driver', rep, 'Report and go to the next stop', 'red');
    S.caption('One tap: dispatch is told, the 3 packages are marked to return, and the route moves on.');
    await wait(2);
    setRate(1);
    await tap('driver', rep, 0.6);
    await until(() => be.T.messages.some((m) => /^STOP_EXCEPTION::/.test(m.body)), 'problem recorded', 15);
    S.unhighlight();
    // dispatcher: the driver chat shows the report as a plain alert
    await tap('dispatcher', '#chatFab', 0.8);
    const tabBtn = S.find('dispatcher', '.oc-tab[onclick*="drivers"]'); if (tabBtn) await tap('dispatcher', tabBtn, 0.6);
    const alertBubble = await until(() => byText('dispatcher', '#msgs-drivers .oc-msg', /PROBLEM/), 'problem in dispatcher chat', 20);
    alertBubble.scrollIntoView({ block: 'center' });
    await wait(0.3);
    S.highlight('dispatcher', alertBubble, 'Dispatch sees it right away', 'red');
    S.caption('Dispatch: <b>⚠ PROBLEM — Stop 6: Business closed · 3 packages returning to station</b>.');
    await wait(5.5);
    S.unhighlight();
    await tap('dispatcher', '#chatFab', 0.5);
    // the last stop
    const last = job.surge_stops.length - 1;
    S.caption('Andre carries on to the last stop, <b>' + job.surge_stops[last].recipient + '</b>.');
    await driveStop(last, 6);
    await deliver(last, { fast: true });
    await until(() => ['completed_with_exceptions', 'delivered'].includes(be.jobById(job.id).status), 'route finished', 15);
  });

  // ── 10. Route complete + the day reconciled ──
  scene('10', 'Route complete · the day reconciled', async () => {
    S.layout('drive'); S.act('Act 10', 'Route complete · the day reconciled');
    await until(() => S.find('driver', '#dxSummary'), 'driver summary', 15);
    S.highlight('driver', '#dxSummary', 'Route finished with problems', 'amber');
    S.caption('Andre’s summary: <b>6 stops, 13 packages delivered</b>, 1 problem, <b>3 packages to bring back</b>.');
    await wait(5.5);
    S.unhighlight();
    await tap('dispatcher', '.tbtab[onclick*="dispatch"]', 0.4);
    try { await W.dispatcher.loadJobs(); } catch (e) {}
    S.layout('wrap');
    await wait(1.4);
    const row1 = S.find('dispatcher', 'tr[onclick*="' + routes()[0].id + '"]');
    if (row1) S.highlight('dispatcher', row1, 'RT-001 · finished with problems', 'amber');
    S.caption('The board: RT-002 and RT-003 <b>delivered</b>; RT-001 <b>finished · problems</b>.');
    await wait(5);
    S.unhighlight();
    S.recon(reconHtml());
    S.caption('Every package accounted for: <b>30 received = 27 delivered + 3 returning to the station</b>.');
    await wait(9);
  });

  // ════════════════ reconciliation from the demo backend ════════════════
  function reconcile() {
    const T = be.T, rs = routes();
    const received = D.totals().packages;
    const routed = rs.reduce((n, j) => n + (+j.total_packages || 0), 0);
    const stowed = T.events.filter((e) => e.event_type === 'package.stowed').length;
    const pk = (j, n) => ((j.surge_stops[n - 1] || {}).pkgs || []).reduce((a, p) => a + (parseInt(p.required_count) || 1), 0);
    let delivered = 0, returning = 0, stopsDone = 0, problems = 0;
    T.messages.forEach((m) => {
      const j = be.jobById(m.job_id); if (!j) return;
      if (/^STOP_DELIVERED::/.test(m.body)) { const x = JSON.parse(m.body.slice(16)); delivered += pk(j, x.stop_number); stopsDone++; }
      if (/^STOP_EXCEPTION::/.test(m.body)) { const x = JSON.parse(m.body.slice(16)); returning += x.packages; problems++; }
    });
    return { received, routed, stowed, delivered, returning, stopsDone, problems, sms: be.suppressed.length, pods: be.podFiles.size, routes: rs.map((j) => ({ t: j.title, s: j.status, d: j.driver_name })) };
  }
  root.DEMO_RECONCILE = reconcile;
  function reconHtml() {
    const r = reconcile(), ext = hub.stats.blocked.length;
    const row = (a, b) => '<tr><td>' + a + '</td><td class="n">' + b + '</td></tr>';
    return '<h3>The day, reconciled</h3><div class="sub">Counted from what the apps recorded — not from the script.</div><table>'
      + row('Packages on the manifest', r.received) + row('Packages on SmartSort routes', r.routed) + row('Packages stowed in PathIQ', r.stowed)
      + row('Delivered (' + r.stopsDone + ' stops, with proof)', r.delivered) + row('Returning to station (' + r.problems + ' problem stop)', r.returning)
      + '</table><div class="eq">' + r.received + ' = ' + r.delivered + ' delivered + ' + r.returning + ' returning</div>'
      + '<div class="note">Routes: ' + r.routes.map((x) => x.t.replace('Surge Route ', '') + ' ' + x.s.replace(/_/g, ' ') + ' (' + x.d + ')').join(' · ')
      + '<br>Demo safety: ' + r.sms + ' driver texts recorded, not sent · ' + r.pods + ' proof photos/signatures kept in this browser only · ' + ext + ' outside network calls attempted.</div>';
  }

  // ════════════════ controller ════════════════
  const dots = $('cScenes');
  SCENES.forEach((s, i) => { const d = document.createElement('i'); d.title = s.n + ' · ' + s.title; d.onclick = () => go(i); dots.appendChild(d); });
  function markScene() { Array.prototype.forEach.call(dots.children, (d, i) => { d.className = i === ctl.scene ? 'on' : i < ctl.scene ? 'done' : ''; }); }
  setInterval(S.tickClock, 200);

  async function runFrom() {
    ctl.running = true;
    for (let i = 0; i < SCENES.length; i++) {
      ctl.scene = i; markScene();
      ctl.turbo = i < ctl.target; applySpeed();
      S.busy(ctl.turbo ? 'Jumping to scene ' + SCENES[ctl.target].n + ' · ' + SCENES[ctl.target].title + '…' : '');
      S.instant(ctl.turbo);
      S.flow(''); S.unhighlight(); hub.showCamera(null);
      hub.emit('scene', { i, n: SCENES[i].n, title: SCENES[i].title, at: hub.clock.now() });
      try { await SCENES[i].run(); }
      catch (e) { hub.report('director', 'demo', String(e && e.message || e), 'scene ' + SCENES[i].n); console.error('[demo] scene ' + SCENES[i].n + ':', e); }
    }
    ctl.turbo = false; applySpeed(); S.busy('');
    S.act('', ''); ctl.done = true; ctl.running = false; markScene();
    hub.emit('done', {});
    S.caption('That’s the whole operation. <b>Restart</b> to watch it again.');
    $('cPause').disabled = true;
  }
  function start(sceneIdx) {
    if (ctl.running) return;
    ctl.target = sceneIdx || 0;
    S.title(false);
    hub.clock.resume(); applySpeed();
    $('cStart').disabled = true; $('cPause').disabled = false;
    document.body.classList.remove('idle');
    runFrom();
  }
  function go(i) {
    i = Math.max(0, Math.min(SCENES.length - 1, i));
    if (ctl.running && i > ctl.scene) { ctl.target = i; ctl.turbo = true; applySpeed(); S.busy('Jumping to scene ' + SCENES[i].n + ' · ' + SCENES[i].title + '…'); S.instant(true); return; }
    // going back (or jumping before the show starts): rebuild from a clean start, then fast-forward
    const q = new URLSearchParams(); q.set('scene', String(i)); q.set('speed', String(ctl.userSpeed)); if (!hub.sound()) q.set('sound', '0');
    location.search = q.toString();
  }
  function togglePause() {
    if (!ctl.running) return;
    if (hub.clock.paused()) { hub.clock.resume(); $('cPause').textContent = '❚❚'; document.body.classList.remove('paused'); }
    else { hub.clock.pause(); $('cPause').textContent = '▶'; document.body.classList.add('paused'); }
  }
  $('cStart').onclick = () => start(0);
  $('bigStart').onclick = () => start(0);
  $('cPause').onclick = togglePause;
  $('cRestart').onclick = () => { const q = new URLSearchParams(); q.set('autostart', '1'); q.set('speed', String(ctl.userSpeed)); if (!hub.sound()) q.set('sound', '0'); location.search = q.toString(); };
  $('cPrev').onclick = () => go((ctl.scene < 0 ? 0 : ctl.scene) - 1);
  $('cNext').onclick = () => { if (!ctl.running) start(1); else go(ctl.scene + 1); };
  Array.prototype.forEach.call($('cSpeed').children, (b) => { b.onclick = () => { ctl.userSpeed = +b.dataset.s; Array.prototype.forEach.call($('cSpeed').children, (x) => x.classList.toggle('on', x === b)); applySpeed(); }; });
  $('cSound').onclick = () => { hub.setSound(!hub.sound()); $('cSound').textContent = hub.sound() ? '🔊' : '🔇'; };
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); ctl.running ? togglePause() : start(0); }
    else if (e.key === 'ArrowRight') $('cNext').click();
    else if (e.key === 'ArrowLeft') $('cPrev').click();
    else if (e.key === 'r' || e.key === 'R') $('cRestart').click();
    else if (['1', '2', '4'].includes(e.key)) { const b = Array.prototype.find.call($('cSpeed').children, (x) => x.dataset.s === e.key); if (b) b.click(); }
  });
  let idleT = null;
  addEventListener('mousemove', () => { $('controls').classList.add('wake'); clearTimeout(idleT); idleT = setTimeout(() => $('controls').classList.remove('wake'), 2500); });

  // speed / sound / scene from the URL (used by Restart and Previous)
  const sp = +params.get('speed'); if ([1, 2, 4].includes(sp)) { const b = Array.prototype.find.call($('cSpeed').children, (x) => x.dataset.s === String(sp)); if (b) b.click(); }
  if (params.get('sound') === '0') { hub.setSound(false); $('cSound').textContent = '🔇'; }
  document.body.classList.add('idle');
  S.layout('intro');

  root.DEMO = { hub, be, W, ctl, SCENES, start, go, reconcile, ready, sims };
  // Andre signs in on his phone with the texted code, exactly as a driver does.
  async function signIn() {
    const d = W.driver.document;
    d.getElementById('loginPhone').value = '(404) 555-0161';
    await W.driver.requestCode();
    const code = d.getElementById('loginCode');
    code.value = '481562';
    await W.driver.verifyCode();
    await until(() => onScreen('scHome'), 'driver home after sign-in', 20);
  }
  ready.then(async () => {
    // let the apps finish their first load before the show
    await new Promise((r) => setTimeout(r, 1200));
    hub.clock.resume();
    try { await signIn(); } catch (e) { hub.report('director', 'demo', String(e.message || e), 'sign-in'); }
    await new Promise((r) => setTimeout(r, 900)); hub.clock.pause();
    $('bigStart').disabled = false; $('bigStart').textContent = '▶ START DEMO';
    hub.emit('ready', {});
    const sc = params.get('scene');
    if (sc != null) start(+sc);
    else if (params.get('autostart') === '1') start(0);
  });
})(window);
