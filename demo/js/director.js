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
  hub.seedStorage('dispatcher', { tp_dispatch_theme: 'light', tp_dispatch_org: sess(tok.org), ['tp_warehouse_address_' + C.id]: C.hub.address, ['tp_ss_policy_' + C.id]: JSON.stringify(C.policy) });
  hub.seedStorage('pathiq', { tp_dispatch_org: sess(tok.piq), tp_worker: 'Keisha Moore', tp_device: 'tc56-peachline-01' });
    // Andre signs in through the app's own sign-in screen, on camera (Part 3).
  hub.seedStorage('driver', { tp_dx_perm_intro: '1', tp_theme: 'light' });
  // a dispatcher who has already opened the board today: the once-per-session splash has played
  hub.sessionSeed = { dispatcher: { tackpath_splash_shown: '1' } };

  // Server-side pacing so the work is watchable (the apps make the same calls either way).
  hub.latencyFn = function (app, url, body) {
    if (pace.smartsort && app === 'dispatcher') {
      if (/geocode/.test(url) || (body && body.action === 'geocode')) return 1300;
      if (body && body.action === 'matrix') return 2600;
      if (body && body.action === 'routes') return 700;
      if (/tp_org/.test(url) && body && body.p_action === 'publish_route') return 1300;
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
  // Twilio: the two texts TackPath sends a driver, word for word (send-sms and
  // driver-login). The demo backend records them and sends nothing.
  hub.on('suppressed', (e) => {
    if (e.kind !== 'sms') return;
    if (e.what === 'sign-in code') { S.sms('TackPath sign-in code: <b>481562</b>. It expires in 10 minutes. Do not share this code. Reply STOP to opt out.'); return; }
    if (e.job_id) setTimeout(() => {
      const j = be.jobById(e.job_id);
      if (j && j.driver_name === 'Andre Coleman') S.sms('TackPath: You have been assigned a new route: ' + j.title + '. Open the TackPath driver app for details. Reply STOP to opt out.', 7000);
    }, 200);
  });
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

  // Drive at real road speed (on camera): no time-lapse. Stops after `maxSec`
  // or at the destination; easeIn pulls away from a stop, easeOut parks.
  async function driveReal(dest, maxSec, opts) {
    opts = opts || {};
    setRate(1);
    const r = M.route([van.lat, van.lng], [dest.lat, dest.lng]);
    const v = 11, acc = 2.4;               // 11 m/s (25 mph) in town, gentle starts and stops
    const t0 = hub.clock.now();
    let s = 0;
    for (;;) {
      const t = (hub.clock.now() - t0) / 1000;
      const left = r.meters - s;
      let speed = v;
      if (opts.easeIn) speed = Math.min(speed, 1 + acc * t);
      if (opts.easeOut) speed = Math.min(speed, Math.max(2.5, Math.sqrt(2 * acc * 1.25 * Math.max(0, left))));
      const dt = 0.12;
      s = Math.min(r.meters, s + speed * dt);
      const p = M.along(r.coords, s);
      fix(p, s < r.meters ? speed : 0);
      if (s >= r.meters || t >= maxSec) break;
      await wait(dt);
    }
    if (s >= r.meters) { const end = r.coords[r.coords.length - 1]; fix({ lat: end[0], lng: end[1], heading: van.heading }, 0); }
    return r;
  }
  // a point `meters` before the destination along the road from where the van is
  const before = (dest, meters) => { const r = M.route([van.lat, van.lng], [dest.lat, dest.lng]); return M.along(r.coords, Math.max(0, r.meters - meters)); };

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

  // PathIQ 2026-10: a completed bin is staged by scanning a STG spot QR.
  const STG = { '001': 'S-01', '002': 'S-02', '003': 'S-03' };
  async function stageBin(job, narrate) {
    const n = routeNo(job), b = BIN[n];
    if (narrate) { S.highlight('pathiq', '#scanFlipContainer', 'Scan a staging spot', 'amber'); S.caption('Route complete. PathIQ asks for a <b>staging spot</b>: Keisha scans <b>STG ' + STG[n] + '</b>.'); await wait(1.8); }
    S.rack.feed('STG ' + STG[n], 'qr');
    await piqScan('STG:' + STG[n], /Staged|STAGED/);
    S.rack.ready(b.code, STG[n]);
    if (narrate) { S.highlight('pathiq', '#stowResult', 'Staged at ' + STG[n], 'green'); await wait(2); S.unhighlight(); }
  }

  // ── editing: nothing on camera is ever sped up. Repeated work is done off
  //    air (the recorder drops those frames) and the film cuts to the result. ──
  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function air(on) {
    if (S.onAir() === on) return;
    if (on) {
      ctl.turbo = ctl.scene < ctl.target; applySpeed();
      await realSleep(450);                 // let the screens settle before the camera comes back
      S.air(true);
    } else { S.air(false); ctl.turbo = true; applySpeed(); }
  }
  async function offAir(fn) { await air(false); try { await fn(); } finally { S.unhighlight(); S.flow(''); await air(true); } }
  // a cut with a chapter card in front of it
  async function cut(title, sub, fn) {
    S.chapter('', title, sub); await wait(2.2);
    await offAir(fn);
    await wait(0.6); S.chapter(null); await wait(0.8);
  }
  async function opener(n, title, sub) { S.chapter(n, title, sub); await wait(1.9); S.chapter(null); await wait(0.6); }
  // typing into a real field, one character at a time
  async function typeInto(app, sel, text, cps) {
    const el = S.find(app, sel); if (!el) throw new Error('typeInto: not found ' + app + ' ' + sel);
    const w = W[app];
    try { el.focus(); } catch (e) {}
    el.value = '';
    for (const ch of String(text)) {
      el.value += ch;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      await wait(1 / (cps || 13));
    }
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
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
  // Everything on camera happens at real speed. Where the same work repeats,
  // the film cuts (offAir / cut), the way an editor would.
  const SCENES = [];
  const scene = (n, title, run) => SCENES.push({ n, title, run });
  // ── 1. Intake / SmartSort ──
  scene('1', 'SmartSort builds the routes', async () => {
    S.layout('intake'); S.stage(0);
    await opener('Step 1 of 4 · Route Planning', 'SmartSort builds the routes', 'A client’s manifest becomes optimized routes on real road time.');
    setRate(1);
    jumpTo(7, 52);
    S.caption('<b>7:52 AM.</b> A client sends today’s manifest: <b>21 lines</b>, <b>30 packages</b> for <b>17 addresses</b>.');
    S.manifest(D.manifestCsv());
    await wait(3.6);
    const btn = byText('dispatcher', 'button', /\+ New Route/);
    S.highlight('dispatcher', btn, 'Dispatcher: + New Route');
    S.caption('The dispatcher uploads it to <b>SmartSort</b>.');
    await wait(2);
    S.ripple(...(() => { const r = S.rectOf('dispatcher', btn); return [r.x + r.w / 2, r.y + r.h / 2]; })());
    S.unhighlight();
    pace.smartsort = true;
    W.dispatcher.openSmartSortDrawer();
    await wait(0.6);
    S.layout('build');                     // push in on SmartSort while it works
    await wait(0.9);
    W.dispatcher.handleFile(new W.dispatcher.File([D.manifestCsv()], 'peachline-manifest.csv', { type: 'text/csv' }));
    const status = () => txt('dispatcher', '#statusMsg') || '';
    await until(() => /Geocoding/.test(status()), 'SmartSort geocoding', 20);
    S.caption('SmartSort groups the 21 lines into <b>17 stops</b> and finds each address on the map.');
    await until(() => !/Geocoding/.test(status()), 'geocoding done', 60);
    S.caption('It measures <b>real road time</b> between every pair of stops, then orders each route.');
    const grid = () => { const g = S.find('dispatcher', '#routeGrid'); return g && g.children.length && g.offsetParent !== null ? g : null; };
    await until(grid, 'SmartSort route cards', 90);
    await wait(0.3);
    S.highlight('dispatcher', S.find('dispatcher', '#smartSortDrawer'), '3 routes · 30 packages accounted for', 'green');
    S.caption('<b>3 routes</b> built on real road time. Every package is accounted for before anything is published.');
    await until(() => routes().length === 3, '3 routes published', 40);
    await until(() => !S.find('dispatcher', '#smartSortDrawer').classList.contains('open'), 'SmartSort done', 20);
    pace.smartsort = false;
    S.unhighlight();
    S.layout('board');
    await wait(1.4);
    const rows = Array.prototype.filter.call(W.dispatcher.document.querySelectorAll('tr[onclick*="openDrawer"]'), (r) => /Surge Route/.test(r.textContent));
    if (rows.length) {
      const a = S.rectOf('dispatcher', rows[0]), b = S.rectOf('dispatcher', rows[rows.length - 1]);
      S.highlightBox(a.x - 6, a.y - 6, a.w + 12, b.y + b.h - a.y + 12, 'Published · waiting for a driver', 'green');
    }
    S.caption('Published to the board as <b>pending</b>. No driver yet.');
    await wait(3);
    S.unhighlight();
  });

  // ── 2. The driver signs in with a texted code (Twilio) ──
  scene('2', 'The driver signs in', async () => {
    W.dispatcher.closeSmartSortDrawer();
    S.layout('signin'); S.stage(0);
    await opener('Step 1 of 4 · Route Planning', 'The driver signs in', 'No passwords: TackPath texts a one-time code.');
    jumpTo(7, 55);
    S.caption('<b>7:55 AM.</b> Andre Coleman, a Peachline driver, opens the <b>TackPath driver app</b> and enters his number.');
    await wait(1.6);
    S.highlight('driver', '#loginPhone', 'His phone number');
    await typeInto('driver', '#loginPhone', '(404) 555-0161', 10);
    await wait(0.6);
    S.highlight('driver', '#loginPhoneBtn', 'Send Code');
    await wait(1);
    await tap('driver', '#loginPhoneBtn', 0.6);
    S.unhighlight();
    await until(() => visible('driver', '#loginCode'), 'code field', 15);
    S.caption('<b>Twilio</b> texts him a one-time sign-in code from TackPath’s number.');
    await wait(4.2);
    S.highlight('driver', '#loginCode', 'Code from the text');
    S.caption('He types the code. With the sixth digit, the app signs him in.');
    await typeInto('driver', '#loginCode', '481562', 4);
    S.unhighlight();
    await until(() => onScreen('scHome'), 'driver home after sign-in', 20);
    S.caption('Signed in. His phone now waits for work.');
    await wait(2.8);
  });

  // ── 3. Dispatcher assigns ──
  scene('3', 'Dispatch assigns drivers', async () => {
    S.layout('assign'); S.stage(0);
    await opener('Step 1 of 4 · Route Planning', 'Dispatch assigns drivers', 'One click on the board, and the route is on the driver’s phone.');
    S.caption('Three new routes on the board. On the right, Andre’s phone, signed in and waiting.');
    await wait(1.8);
    const r1 = routes()[0];
    const row = 'tr[onclick*="' + r1.id + '"]';
    await until(() => S.find('dispatcher', row), 'route row on board', 20);
    S.highlight('dispatcher', row, 'RT-001 · 7 stops · 16 packages');
    await wait(1.6);
    await tap('dispatcher', row, 1);
    for (const r of routes()) {
      const who = OWNER[routeNo(r)], first = r === r1;
      if (!first) { await air(false); W.dispatcher.openDrawer(r.id); await wait(0.9); }
      const sel = await until(() => { const s = S.find('dispatcher', '#assignDriverSelect'); return s && s.options.length > 1 && s; }, 'driver list', 15);
      S.highlight('dispatcher', sel, first ? 'Pick the driver' : who);
      // focusing the picker holds the drawer still (the board refreshes every 2 s)
      sel.dispatchEvent(new W.dispatcher.FocusEvent('focusin', { bubbles: true }));
      await wait(first ? 1.2 : 0.8);
      const sel2 = S.find('dispatcher', '#assignDriverSelect');
      sel2.value = who; sel2.dispatchEvent(new W.dispatcher.Event('change', { bubbles: true }));
      await wait(first ? 0.9 : 0.6);
      const assign = byText('dispatcher', '#drawer button', /^Assign$/);
      S.highlight('dispatcher', assign, first ? 'Assign to ' + who : null);
      await wait(first ? 0.8 : 0.5);
      await tap('dispatcher', assign, 0.6);
      await until(() => be.jobById(r.id).status === 'assigned', 'assigned ' + r.title, 10);
      if (first) {
        S.unhighlight();
        S.caption('Assigned. <b>Twilio</b> texts Andre his new route at that moment.');
        await wait(3.6);
        await until(() => onScreen('scRouteAccepted'), 'Andre sees his route', 20);
        await wait(0.6);
        S.link({ app: 'dispatcher', sel: row + ' td:nth-child(2)' }, { app: 'driver', sel: '#dxDayCard' }, 'Dispatch assigns RT-001', 'Andre’s phone: his route', 'amber');
        S.caption('One click at dispatch, and <b>his</b> route is on his phone: 7 stops, 16 packages. Pickup stays locked: <b>Waiting for warehouse</b>.');
        await wait(4.4);
        S.unlink();
      }
    }
    W.dispatcher.closeDrawer();
    await air(true);
    S.caption('Priya Nair and Luis Ortega take RT-002 and RT-003.');
    await wait(2.2);
  });

  // ── 4. PathIQ sort on the TC56 ──
  const SORT = { held: [] };
  const EXC = 5;   // stop 6 · Gilbert Street Bakery · 3 packages
  scene('4', 'PathIQ · sort and stage', async () => {
    S.layout('sort'); S.stage(1);
    await opener('Step 2 of 4 · Package Sorting', 'PathIQ sorts the warehouse', 'Every package scanned into its route’s bin, every bin staged for pickup.');
    jumpTo(8, 4);
    setRate(1);
    const rs = routes();
    S.rack.reset(rs.map((r) => BIN[routeNo(r)]));
    S.caption('<b>8:04 AM.</b> Keisha sorts on a Zebra TC56: scan the package, scan its bin.');
    await wait(2.2);
    await tap('pathiq', '.big-card[onclick*="stow"]', 1.2);
    // packages come off the truck mixed up; RT-001’s last package is held back for part 6
    const lists = rs.map(unitsOf);
    const order = [];
    let i = 0;
    while (lists.some((l) => l.length)) { const l = lists[i % lists.length]; if (l.length) order.push(l.shift()); i++; }
    const r1 = rs[0];
    SORT.held = order.filter((u) => u.job === r1).slice(-1);
    const run = order.filter((u) => !SORT.held.includes(u));
    const lastIdx = new Map(); run.forEach((u, k) => lastIdx.set(u.job.id, k));
    let stagedShown = 0;
    for (let k = 0; k < run.length; k++) {
      const u = run[k];
      const completes = lastIdx.get(u.job.id) === k && u.job !== r1;
      // on camera: the first packages (new bins, a wrong bin) and each route's last package
      const show = k === 0 || k === 3 || k === 4 || (completes && stagedShown === 0);
      if (!show && S.onAir()) { await air(false); }
      if (show && !S.onAir()) { await air(true); if (completes) S.caption('Later in the sort: the last package for <b>' + u.job.title.replace('Surge Route ', '') + '</b>.'); }
      const gap = k === 0 ? 1.4 : 1.0;
      if (k === 3) S.caption('PathIQ flips the card to the package’s bin; the bin scan confirms it. Every scan is counted.');
      await stowUnit(u, gap, { narrate: k === 0, wrongFirst: k === 4 });
      if (k === 0) {
        // the first package in RT-001's bin: Andre's phone notices on its own warehouse check
        await until(() => /Staging in progress/i.test(txt('driver', '#dxStage')), 'driver app shows staging', 12);
        S.unhighlight();
        S.link({ app: 'pathiq', sel: '#stowResult' }, { app: 'driver', sel: '#dxStage' }, 'Zebra: first package in bin 1A', 'Andre’s phone: Staging in progress', 'amber');
        S.caption('The scan on the Zebra reaches Andre’s phone: his route is now <b>Staging in progress</b>.');
        await wait(4);
        S.unlink();
      }
      if (/Bin Complete/.test(txt('pathiq', '#stowResult'))) {
        if (S.onAir()) { S.highlight('pathiq', '#stowResult', u.job.title.replace('Surge Route ', '') + ' complete', 'green'); S.caption('<b>' + u.job.title.replace('Surge Route ', '') + '</b> is complete: every package is in its bin.'); await wait(2); S.unhighlight(); }
        await stageBin(u.job, S.onAir() && stagedShown++ === 0);
        const who = OWNER[routeNo(u.job)];
        if (who !== 'Andre Coleman' && !sims.some((x) => x.name === who)) planSim(who, u.job, hub.clock.now() + 7 * 60000);
      }
      await wait(gap * 0.5);
    }
    await air(true);
    S.highlightBox(...(() => { const r = $('rack').getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale(); return [(r.left - sr.left) / k - 6, (r.top - sr.top) / k - 6, r.width / k + 12, r.height / k + 12]; })(), 'RT-002 and RT-003 sorted and staged', 'green');
    S.caption('RT-002 and RT-003 are sorted and staged. RT-001 has one package to go.');
    await wait(3.2);
    S.unhighlight();
  });

  // ── 5. Route ready: WAITING → READY across apps ──
  scene('5', 'Route ready for pickup', async () => {
    S.layout('ready'); S.stage(1);
    await opener('Step 2 of 4 · Package Sorting', 'Ready for pickup', 'The warehouse and the driver’s phone stay in step.');
    S.caption('RT-001’s last package. Watch both screens.');
    await wait(1.8);
    for (let k = 0; k < SORT.held.length; k++) await stowUnit(SORT.held[k], 1.0, {});
    await until(() => /Bin Complete/.test(txt('pathiq', '#stowResult')), 'RT-001 complete', 10);
    await until(() => /stage your route|Waiting for warehouse/i.test(txt('driver', '#dxStage')), 'driver app waits for staging', 20);
    S.unhighlight();
    S.link({ app: 'pathiq', sel: '#stowResult' }, { app: 'driver', sel: '#dxStage' }, 'Zebra: bin 1A complete, 16 of 16', 'Andre’s phone: waiting for staging', 'amber');
    S.caption('All 16 packages are in bin 1A. Andre’s app still waits: the route is <b>not staged</b> yet.');
    await wait(3.6);
    S.unlink();
    S.caption('Keisha moves bin 1A to the staging area and scans <b>STG S-01</b>.');
    await stageBin(routes()[0], false);
    await until(() => /ready for pickup/i.test(txt('driver', '#dxStage')), 'driver app turns READY', 20);
    S.link({ app: 'pathiq', sel: '#stowResult' }, { app: 'driver', sel: '#dxDayCard' }, 'Zebra: STG S-01 scanned', 'Andre’s phone: Ready for pickup', 'green');
    S.caption('That STG scan is what unlocks Andre’s pickup: his app turns <b>Ready for pickup</b>, staging spot S-01.');
    await wait(4.6);
    S.unlink();
    // the result of the sort: every bin staged
    S.layout('sort');
    await wait(1.2);
    S.highlightBox(...(() => { const r = $('rack').getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale(); return [(r.left - sr.left) / k - 6, (r.top - sr.top) / k - 6, r.width / k + 12, r.height / k + 12]; })(), 'Sorting complete · 3 bins staged', 'green');
    S.caption('Sorting complete: <b>30 packages in 3 bins</b>, every bin staged for pickup.');
    await wait(3.4);
    S.unhighlight();
  });

  // ── 6. Driver pickup ──
  scene('6', 'Driver pickup', async () => {
    S.layout('pickup'); S.stage(2);
    await opener('Step 3 of 4 · Driver Handoff', 'Driver pickup', 'The right bin, every package scanned into the van.');
    hub.clock.jump(4 * 60000);   // Andre walks over from the drivers' lounge
    setRate(1);
    fix({ lat: C.hub.lat, lng: C.hub.lng, heading: 90 });
    S.caption('Andre is at the staging spot. He taps <b>At pickup</b>.');
    const rs = routes();
    S.rack.picked('2A'); S.rack.picked('3A');
    await wait(1.8);
    const atPickup = W.driver.document.querySelector('#scRouteAccepted button:not(.dx-btn)');
    hub.showCamera({ kind: 'bin', code: 'BIN:2A' }, false);   // in view when the scanner opens
    await tap('driver', atPickup, 0.9);
    await until(() => visible('driver', '#binScanOverlay'), 'bin scan screen', 10);
    S.caption('He grabs <b>bin 2A</b> by mistake…');
    await wait(1);
    await cameraScan('BIN:2A', '#binScanLastResult', /WRONG BIN/, 'bin');
    S.highlight('driver', '#binScanLastResult', 'Wrong bin · rejected', 'red');
    S.caption('<b>Wrong bin.</b> The app checks the scan against PathIQ: this route is in bin 1A.');
    await wait(2.8);
    S.unhighlight();
    await cameraScan('BIN:1A', '#binScanLastResult', /CONFIRMED/, 'bin');
    S.highlight('driver', '#binScanLastResult', 'Bin 1A confirmed', 'green');
    S.caption('<b>Bin 1A confirmed.</b>');
    await until(() => onScreen('scPickup'), 'pickup route tab', 10);
    await wait(0.6); S.unhighlight();
    S.highlight('driver', '#tpPickMap', 'Today’s stops, in delivery order', 'green');
    S.caption('The app shows today’s <b>7 stops</b> on the map, in delivery order.');
    await wait(3);
    S.unhighlight();
    const loadTab = S.find('driver', '#scPickup [data-tab="load"]');
    S.highlight('driver', loadTab, 'Load');
    S.caption('On <b>Load</b>, every package goes into the van with a scan.');
    hub.showCamera({ kind: 'label', code: unitsOf(rs[0])[0].code }, false);
    await wait(1.4);
    await tap('driver', loadTab, 0.6);
    await until(() => visible('driver', '#loadPkgOverlay'), 'loading screen', 10);
    await wait(0.6); S.unhighlight();
    const units = unitsOf(rs[0]);
    S.rack.clearFeed();
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      const show = k < 1;
      if (show !== S.onAir()) await air(show);
      await cameraScan(u.code, '#loadPkgLastScan', /LOADED/);
      S.rack.take('1A');
      if (k === 0) { S.highlight('driver', '#loadPkgOverlay', 'Loaded · stop number shown', 'green'); S.caption('Each scan is counted against the route and shows its stop.'); await wait(1.8); S.unhighlight(); }
      if (k < units.length - 1) {
        const ok = await until(() => S.find('driver', '#loadPkgOkBtn'), 'OK button', 10);
        await wait(0.7);
        await tap('driver', ok, 0.4);
      }
    }
    await air(true);
    const go = await until(() => { const x = onScreen('scPickup') && S.find('driver', '#tpPickStart'); return x && !x.disabled && x; }, 'Start Route enabled', 15);
    S.rack.picked('1A');
    S.highlight('driver', go, '16 of 16 loaded', 'green');
    S.caption('All 16 loaded. Andre taps <b>Start Route</b>.');
    await wait(2.2);
    S.unhighlight();
    await tap('driver', go, 0.8);
    await until(() => be.jobById(rs[0].id).status === 'in_transit', 'route in transit', 10);
    // the result at dispatch: RT-001 is on the road
    S.layout('assign');
    try { await W.dispatcher.loadJobs(); } catch (e) {}
    const moving = await until(() => S.find('dispatcher', '#pp-transit .pcard'), 'RT-001 in transit on the board', 15);
    await wait(1.2);
    S.link({ app: 'driver', sel: '#scSurgeMap' }, { app: 'dispatcher', sel: moving }, 'Andre: route started', 'Dispatch: RT-001 in transit', 'green');
    S.caption('The handoff is done: Andre’s route is loaded, and dispatch sees RT-001 <b>in transit</b>.');
    await wait(4);
    S.unlink();
  });

  // stop 1 of Andre’s route
  const firstStop = () => routes()[0].surge_stops[0];

  // ── 7. On the road: navigation, live map, back to TackPath ──
  scene('7', 'On the road', async () => {
    S.layout('drive'); S.stage(3);
    await opener('Step 4 of 4 · Delivery', 'On the road', 'Turn-by-turn on the phone and a live map at dispatch.');
    await tap('dispatcher', '.tbtab[onclick*="smarttrack"]', 0.6);
    try { await W.dispatcher.refreshFleetMap(); } catch (e) {}
    S.highlight('driver', '#surgeRow0', 'Stop 1 · tap to navigate');
    S.caption('Andre taps <b>stop 1</b>. TackPath hands the trip to Google Maps.');
    await wait(2);
    S.unhighlight();
    await tap('driver', '#surgeRow0', 0.2);
    await until(() => S.nav.isOpen(), 'navigation opens', 10);
    await wait(0.6);
    const st = firstStop();
    S.flow('one GPS stream → driver phone + dispatcher map', 470, 110);
    S.caption('The <b>same GPS stream</b> moves the phone’s navigation and Andre’s dot on the dispatcher’s map.');
    await driveReal(st.coords, 5, { easeIn: true });
    S.flow('');
    // cut to half a mile out: the floating button appears over Maps
    await offAir(async () => { await driveTo(before(st.coords, 860), 2); });
    S.caption('Inside half a mile, TackPath’s <b>floating button</b> appears over Maps.');
    await driveReal(st.coords, 5);
    await offAir(async () => { await driveTo(before(st.coords, 150), 2); });
    S.caption('Andre pulls up at ' + st.recipient + '’s address.');
    const park = driveReal(st.coords, 30, { easeOut: true });
    await until(() => S.bubble.state() === 'arrived', 'arrived bubble', 30);
    S.highlightBox(...(() => { const b = S.bubble.el().getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale(); return [(b.left - sr.left) / k - 6, (b.top - sr.top) / k - 6, b.width / k + 12, b.height / k + 12]; })(), 'Arrived · tap to deliver', 'green');
    S.caption('Within 80 m it turns green: <b>Arrived · tap here to deliver</b>.');
    await wait(2.6);
    await offAir(async () => { await park; });   // cut: the last few metres of parking
    await returnToApp();
    S.caption('One tap and Andre is back in TackPath, on this stop.');
    await wait(2);
  });
  async function returnToApp() {
    const b = S.bubble.el().getBoundingClientRect(), sr = $('stage').getBoundingClientRect(), k = S.stageScale();
    S.ripple((b.left + b.width / 2 - sr.left) / k, (b.top + b.height / 2 - sr.top) / k);
    S.unhighlight();
    await wait(0.4);
    S.nav.hide();
    W.driver.onDeepLinkArrived();            // what tackpath://arrived does
    await until(() => visible('driver', '#arrivalPrompt'), 'arrival prompt', 10);
  }

  // one delivery, start (arrival prompt) to the next stop's countdown; `quick`
  // only shortens the pauses (used off camera)
  async function deliver(i, opts) {
    const job = routes()[0], st = job.surge_stops[i], quick = opts.quick;
    setRate(1);
    const pieces = unitsOf(job).filter((u) => u.stop === i + 1);
    hub.showCamera({ kind: 'label', code: pieces[0].code }, false);   // the label is in view when the scanner opens
    await tap('driver', '#arrivalPrompt button', quick ? 0.4 : 1.1);
    await until(() => visible('driver', '#dlvScanOverlay'), 'delivery scan', 10);
    if (!quick) { S.caption('Before proof of delivery, every package for this stop is scanned.'); await wait(1.2); }
    for (let k = 0; k < pieces.length; k++) {
      await cameraScan(pieces[k].code, '#dlvScanResult', /PACKAGE SCANNED|ACCOUNTED/);
      if (k < pieces.length - 1) { const nx = await until(() => S.find('driver', '#dlvNextBtn'), 'NEXT', 10); await wait(quick ? 0.2 : 0.8); await tap('driver', nx, 0.4); }
    }
    const go = await until(() => S.find('driver', '#dlvProceedBtn'), 'proof of delivery button', 10);
    if (!quick) { S.highlight('driver', go, 'All packages for stop ' + (i + 1), 'green'); await wait(1.6); S.unhighlight(); }
    await tap('driver', go, quick ? 0.4 : 1);
    await until(() => onScreen('scPOD'), 'proof of delivery screen', 10);
    const sig = !!st.signature_required;
    if (sig) {
      if (!quick) S.caption('This stop needs a signature: <b>Handed to customer</b>, then the customer signs.');
      await tap('driver', '.dx-choice[data-c="handed"]', quick ? 0.4 : 1.1);
      await sign(st.recipient);
      await wait(quick ? 0.3 : 0.9);
    } else {
      if (!quick) S.caption('Left at the front door: <b>a photo is required</b>.');
      await tap('driver', '.dx-choice[data-c="front_door"]', quick ? 0.3 : 1.1);
      hub.showCamera({ kind: 'door', unit: st.unit || '' }, false);
      await tap('driver', '#podCameraBtn', quick ? 0.6 : 1.4);
      await until(() => visible('driver', '#podCaptureBtn'), 'camera ready', 10);
      await tap('driver', '#podCaptureBtn', quick ? 0.3 : 1);
    }
    if (!quick) { S.highlight('driver', sig ? '#sigPad' : '#podPhotoPreview', sig ? 'Signed' : 'Photo taken', 'green'); await wait(1.6); S.unhighlight(); }
    const before = be.T.messages.filter((m) => /^STOP_DELIVERED::/.test(m.body)).length;
    await tap('driver', '#podSubmitBtn', 0.5);
    await until(() => be.T.messages.filter((m) => /^STOP_DELIVERED::/.test(m.body)).length > before, 'delivery recorded', 15);
  }
  // off camera only: drive the whole leg, deliver
  async function driveStop(i, notBefore) {
    const st = routes()[0].surge_stops[i];
    await until(() => S.nav.isOpen(), 'navigation opens for stop ' + (i + 1), 15);
    await wait(0.4);
    await driveTo(st.coords, 3, notBefore);
    await until(() => S.bubble.state() === 'arrived', 'arrived bubble', 10);
    await wait(0.6);
    await returnToApp();
  }

  // ── 8. One delivery, start to finish; the next stop opens by itself ──
  scene('8', 'Delivery · proof', async () => {
    S.layout('drive'); S.stage(3);
    S.caption('<b>Mark arrived</b>, then scan the stop’s packages.');
    await deliver(0, {});
    await until(() => S.find('driver', '#dxNext'), 'next-stop countdown', 10);
    S.highlight('driver', '#dxNext', 'Stop 1 delivered', 'green');
    S.caption('<b>Delivered.</b> The next stop opens by itself.');
    await wait(1.2);
    // the delivery reaches dispatch
    await tap('dispatcher', '.tbtab[onclick*="\'dispatch\'"]', 0.4);
    try { await W.dispatcher.loadJobs(); } catch (e) {}
    const done = await until(() => S.find('dispatcher', '#pp-delivered .pcard'), 'delivery on the dispatch board', 15);
    S.unhighlight();
    S.link({ app: 'driver', sel: '#dxNext' }, { app: 'dispatcher', sel: done }, 'Andre: stop 1 delivered', 'Dispatch: delivered, with photo proof', 'green');
    S.caption('The delivery is on the dispatch board at once: <b>stop 1 of 7 delivered</b>, with the photo proof.');
    await wait(4.4);
    S.unlink();
    await until(() => S.nav.isOpen(), 'navigation opens for stop 2', 15);
    S.caption('…and Maps is already guiding Andre to stop 2.');
    await wait(2.6);
    // close the loop where the morning began: the dispatcher's board
    S.layout('board');
    await wait(1.4);
    S.highlight('dispatcher', '#pp-delivered .pcard', 'Stop 1 of 7 · delivered', 'green');
    S.caption('Back at dispatch, where the morning began: the first delivery is complete and RT-001 is still <b>in transit</b>.');
    await wait(4);
    S.unhighlight();
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
    S.stage(null); ctl.done = true; ctl.running = false; markScene();
    hub.emit('done', {});
    S.caption('');
    $('titleCard').classList.add('end'); S.title(true);   // closing card: the logo and the line
    $('cPause').disabled = true;
  }
  function start(sceneIdx) {
    if (ctl.running) return;
    ctl.target = sceneIdx || 0;
    S.title(false);
    hub.clock.resume(); applySpeed();
    $('cStart').disabled = true; $('cPause').disabled = false;
    document.body.classList.remove('idle');
    setTimeout(runFrom, sceneIdx ? 0 : 1000);   // the title fades out before Part 1
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
  ready.then(async () => {
    // The driver app's street map loads OpenStreetMap tiles. Offline, the demo
    // draws its own street tiles instead (same streets as every demo map).
    (function tiles(n) {
      const L = W.driver.L;                 // Leaflet loads a moment after the page
      if (!L || !L.GridLayer) { if (n < 150) setTimeout(() => tiles(n + 1), 200); else console.error('[demo] map tiles: Leaflet did not load'); return; }
      const Demo = L.GridLayer.extend({ createTile: function (c) { return M.tile(W.driver.document.createElement('canvas'), c.z, c.x, c.y); } });
      L.tileLayer = function (url, o) { return new Demo({ maxZoom: (o && o.maxZoom) || 19, attribution: 'Demo map (offline)' }); };
    })(0);
    // let the apps finish their first load before the show
    await new Promise((r) => setTimeout(r, 1200));
    hub.clock.resume();
    await new Promise((r) => setTimeout(r, 900)); hub.clock.pause();
    $('bigStart').disabled = false; $('bigStart').textContent = '▶ START DEMO';
    hub.emit('ready', {});
    const sc = params.get('scene');
    if (sc != null) start(+sc);
    else if (params.get('autostart') === '1') start(0);
  });
})(window);
