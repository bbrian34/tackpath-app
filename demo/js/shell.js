/* TackPath live demo — the presentation shell: stage scaling, device layout,
   captions, highlights and taps, the warehouse-rack illustration, and the
   phone's system layer (navigation app, floating return button, heads-up
   notifications, spoken prompts). It only draws; the director decides what
   happens and the real TackPath pages do the work. */
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const D = root.DEMO_DATA, M = root.DEMO_MAP;
  const S = {};
  root.SHOW = S;

  // ── stage: 1920×1080 scaled to the window ──
  const stage = $('stage');
  let scale = 1;
  function fit() {
    const w = innerWidth, h = innerHeight;
    scale = Math.min(w / 1920, h / 1080);
    stage.style.transform = 'translate(' + ((w - 1920 * scale) / 2) + 'px,' + ((h - 1080 * scale) / 2) + 'px) scale(' + scale + ')';
  }
  addEventListener('resize', fit); fit();
  S.stageScale = () => scale;

  // ── layouts ──
  const DEV = { desk: $('devDesk'), tc56: $('devTc56'), phone: $('devPhone'), rack: $('rack'), manifest: $('manifest') };
  const LAYOUTS = {
    intro:    {},
    intake:   { desk: [470, 92, 0.94], manifest: [44, 150, 1] },
    assign:   { desk: [40, 112, 0.93], phone: [1446, 104, 0.92] },
    sort:     { tc56: [120, 96, 1.06], rack: [650, 150, 1], phone: [1452, 124, 0.86] },
    ready:    { tc56: [300, 104, 1.04], phone: [1120, 96, 0.96], rack: [700, 640, 0.0001, true] },
    pickup:   { rack: [110, 200, 1], phone: [1060, 96, 0.96] },
    drive:    { phone: [96, 96, 0.96], desk: [600, 150, 0.875] },
    wrap:     { desk: [40, 118, 0.8], phone: [1290, 650, 0.0001, true] }
  };
  let current = 'intro';
  S.layout = function (name, opts) {
    const L = LAYOUTS[name] || {};
    current = name;
    Object.keys(DEV).forEach((k) => {
      const el = DEV[k], p = L[k];
      if (!p || p[3]) { el.classList.add('off'); return; }
      el.classList.remove('off');
      el.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px) scale(' + p[2] + ')';
    });
    (opts && opts.dim || []).forEach((k) => DEV[k].classList.add('dim'));
    Object.keys(DEV).forEach((k) => { if (!(opts && opts.dim || []).includes(k)) DEV[k].classList.remove('dim'); });
  };
  S.dim = (k, on) => DEV[k].classList.toggle('dim', !!on);
  // instant placement (used while fast-forwarding)
  S.instant = function (on) { document.body.classList.toggle('instant', !!on); Object.values(DEV).forEach((el) => { el.style.transition = on ? 'none' : ''; }); };

  // ── act title + caption ──
  S.act = function (n, title) { $('actTitle').innerHTML = n ? '<span class="n">' + n + '</span>' + title : ''; };
  let capTimer = null;
  S.caption = function (html) {
    const c = $('caption');
    if (S.quiet) { c.classList.remove('show'); return; }
    clearTimeout(capTimer);
    if (!html) { c.classList.remove('show'); return; }
    if (c.classList.contains('show') && c.innerHTML !== html) {
      c.classList.remove('show');
      capTimer = setTimeout(() => { c.innerHTML = html; c.classList.add('show'); }, 220);
    } else { c.innerHTML = html; c.classList.add('show'); }
  };

  // ── mapping an element inside an app to stage coordinates ──
  const FRAME = { dispatcher: 'fDisp', pathiq: 'fPiq', driver: 'fDrv' };
  S.frame = (app) => $(FRAME[app]);
  function stageRect(app, el) {
    const fr = $(FRAME[app]).getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const k = fr.width / $(FRAME[app]).offsetWidth;
    const r = el.getBoundingClientRect();
    return { x: (fr.left + r.left * k - sr.left) / scale, y: (fr.top + r.top * k - sr.top) / scale, w: r.width * k / scale, h: r.height * k / scale };
  }
  function find(app, sel) {
    if (sel && sel.nodeType) return sel;
    const w = root.__TPDEMO__.win(app);
    return w && w.document.querySelector(sel);
  }
  S.find = find;
  S.highlight = function (app, sel, tag, color) {
    const hl = $('hl');
    const el = find(app, sel);
    if (!el || S.quiet) { hl.hidden = true; return; }
    const r = stageRect(app, el), pad = 6;
    hl.className = 'hl' + (color ? ' ' + color : '');
    hl.style.left = (r.x - pad) + 'px'; hl.style.top = (r.y - pad) + 'px';
    hl.style.width = (r.w + pad * 2) + 'px'; hl.style.height = (r.h + pad * 2) + 'px';
    hl.innerHTML = tag ? '<span class="hl-tag">' + tag + '</span>' : '';
    hl.hidden = false;
  };
  S.highlightBox = function (x, y, w, h, tag, color) {
    const hl = $('hl'); if (S.quiet) { hl.hidden = true; return; }
    hl.className = 'hl' + (color ? ' ' + color : '');
    Object.assign(hl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    hl.innerHTML = tag ? '<span class="hl-tag">' + tag + '</span>' : ''; hl.hidden = false;
  };
  S.unhighlight = () => { $('hl').hidden = true; };
  S.ripple = function (x, y) {
    if (S.quiet) return;
    const r = document.createElement('div'); r.className = 'ripple'; r.style.left = x + 'px'; r.style.top = y + 'px';
    $('ripples').appendChild(r); setTimeout(() => r.remove(), 700);
  };
  // Tap a real control inside an app: show the touch, then click it.
  S.tap = function (app, sel) {
    const el = find(app, sel);
    if (!el) throw new Error('tap: not found ' + app + ' ' + sel);
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    const r = stageRect(app, el);
    S.ripple(r.x + r.w / 2, r.y + r.h / 2);
    el.click();
    return el;
  };
  S.rectOf = stageRect;

  // ── TC56 scan beam ──
  S.beam = function (ok) {
    const d = DEV.tc56; if (S.quiet) return;
    d.classList.remove('scan', 'err'); void d.offsetWidth;
    d.classList.add('scan'); if (ok === false) d.classList.add('err');
    setTimeout(() => d.classList.remove('scan', 'err'), 260);
  };

  // ── warehouse rack illustration ──
  const bins = {};
  S.rack = {
    reset(list) {
      $('rackBins').innerHTML = ''; $('rackFeed').innerHTML = '<span class="lbl">Scanned</span>';
      list.forEach((b) => {
        const el = document.createElement('div'); el.className = 'bin';
        el.innerHTML = '<div class="b-state">EMPTY</div><div class="b-loc">LOCATION ' + b.loc + '</div><div class="b-code">BIN ' + b.code + '</div><div class="b-route"></div><div class="b-tub"><div class="b-fill"></div></div><div class="b-count">0 packages</div>';
        $('rackBins').appendChild(el); bins[b.code] = { el, n: 0, total: 0 };
      });
    },
    open(code, route, total) { const b = bins[code]; if (!b) return; b.total = total; b.el.classList.add('open'); b.el.querySelector('.b-state').textContent = 'OPEN'; b.el.querySelector('.b-route').textContent = route; this.count(code); },
    add(code) { const b = bins[code]; if (!b) return; b.n++; const i = document.createElement('i'); b.el.querySelector('.b-fill').appendChild(i); this.count(code); this.flash(code); },
    count(code) { const b = bins[code]; b.el.querySelector('.b-count').textContent = b.n + (b.total ? ' of ' + b.total : '') + ' packages'; },
    ready(code) { const b = bins[code]; if (!b) return; b.el.classList.remove('open'); b.el.classList.add('ready'); b.el.querySelector('.b-state').textContent = 'READY'; },
    take(code) { const b = bins[code]; if (!b) return; const f = b.el.querySelector('.b-fill'); if (f.lastChild) f.lastChild.remove(); b.n = Math.max(0, b.n - 1); b.el.querySelector('.b-count').textContent = b.n + ' left in bin'; },
    clearFeed() { $('rackFeed').innerHTML = '<span class="lbl">Scanned</span>'; },
    picked(code) { const b = bins[code]; if (!b) return; b.el.classList.remove('ready', 'open'); b.el.classList.add('picked'); b.el.querySelector('.b-state').textContent = 'PICKED UP'; },
    flash(code) { const b = bins[code]; if (!b || S.quiet) return; b.el.classList.add('flash'); setTimeout(() => b.el.classList.remove('flash'), 300); },
    feed(html, cls) {
      const f = $('rackFeed'); const c = document.createElement('div'); c.className = 'pkg-chip' + (cls ? ' ' + cls : ''); c.innerHTML = html;
      f.insertBefore(c, f.children[1] || null); while (f.children.length > 4) f.lastChild.remove();
    }
  };

  // ── manifest card ──
  S.manifest = function (csv) {
    const lines = csv.trim().split('\n');
    $('mfMeta').textContent = (lines.length - 1) + ' lines · from the client’s system · 7:52 AM';
    $('mfPreview').textContent = lines.slice(0, 26).map((l) => l.split(',').slice(0, 4).join(',')).join('\n');
    DEV.manifest.classList.remove('fly'); void DEV.manifest.offsetWidth; DEV.manifest.classList.add('fly');
  };

  // ── flow note between devices ──
  S.flow = function (text, x, y, green) {
    const f = $('flow');
    if (!text || S.quiet) { f.hidden = true; return; }
    $('flowText').innerHTML = text; f.style.left = x + 'px'; f.style.top = y + 'px';
    f.className = 'flow' + (green ? ' green' : ''); f.hidden = false; void f.offsetWidth; f.classList.add('pulse');
  };

  // ── reconciliation card ──
  S.recon = function (html) { const r = $('recon'); if (!html) { r.hidden = true; return; } r.innerHTML = html; r.hidden = false; };

  // ── phone: heads-up notification, spoken prompt ──
  let notifT = null;
  S.notify = function (title, body, action, app) {
    if (S.quiet) return;
    const n = $('notif');
    n.innerHTML = '<div class="n-app"><b>●</b> ' + (app || 'TackPath') + ' · now</div><div class="n-t">' + title + '</div>' + (body ? '<div class="n-b">' + body + '</div>' : '') + (action ? '<div class="n-act">' + action + '</div>' : '');
    n.hidden = false; void n.offsetWidth; n.classList.add('show');
    clearTimeout(notifT); notifT = setTimeout(() => { n.classList.remove('show'); setTimeout(() => { n.hidden = true; }, 500); }, 3600);
  };
  let speechT = null;
  S.speak = function (text) {
    if (S.quiet || !text) return;
    const s = $('speech'); s.textContent = text; s.hidden = false; void s.offsetWidth; s.classList.add('show');
    clearTimeout(speechT); speechT = setTimeout(() => { s.classList.remove('show'); }, 2600);
  };

  // ── phone: the navigation app (simulated) + the native floating button ──
  const nav = { open: false, view: null, line: null, route: null, dest: null, arrival: null, bubble: null, lastDraw: 0, man: null, from: null };
  const navEl = $('navApp');
  function fmtMi(m) { const mi = m / 1609.34; return mi < 0.1 ? Math.max(50, Math.round(m * 3.28084 / 50) * 50) + ' ft' : mi.toFixed(1) + ' mi'; }
  const ARROW = { 'Turn right': '↱', 'Turn left': '↰', Continue: '↑', Head: '↑' };
  S.nav = {
    show(dest, from) {
      nav.dest = dest; nav.from = from;
      nav.route = M.route([from.lat, from.lng], [dest.lat, dest.lng]);
      nav.man = M.maneuvers(nav.route);
      navEl.hidden = false; navEl.classList.add('hide'); void navEl.offsetWidth; navEl.classList.remove('hide');
      if (!nav.view) {
        nav.view = new M.MapView($('navMap'), { theme: 'light', mpp: 2.3, labels: true });
        const car = document.createElement('div');
        car.style.cssText = 'position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);z-index:2;pointer-events:none';
        car.innerHTML = '<svg class="nav-car" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#fff"/><path d="M20 6 L31 31 L20 25 L9 31 Z" fill="#1a73e8"/></svg>';
        navEl.appendChild(car);
        const pin = document.createElement('div'); pin.id = 'navPin'; navEl.appendChild(pin);
      }
      if (nav.line) nav.line.remove();
      if (nav.pin) nav.pin.remove();
      nav.line = new M.RouteLine(nav.view, nav.route.coords, { color: '#1a73e8', width: 6, casing: '#185abc', doneColor: 'rgba(160,170,180,.9)' });
      nav.pin = new M.PinMarker(nav.view, dest, '<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 0C7 0 1 6 1 14c0 10 14 26 14 26s14-16 14-26C29 6 23 0 15 0z" fill="#ea4335"/><circle cx="15" cy="14" r="5" fill="#a50e0e"/></svg>', { style: 'margin-top:-18px' });
      nav.open = true;
      S.nav.update(from);
    },
    hide() { if (!nav.open) return; nav.open = false; navEl.classList.add('hide'); setTimeout(() => { if (!nav.open) navEl.hidden = true; }, 450); S.bubble.render(); },
    isOpen: () => nav.open,
    update(pos) {
      if (!nav.open || !nav.route) return;
      const now = performance.now();
      // where along the route is this fix?
      let best = 0, bestD = 1e9, acc = 0; const c = nav.route.coords;
      for (let i = 1; i < c.length; i++) {
        const a = c[i - 1], b = c[i], seg = M.meters(a, b);
        const t = Math.max(0, Math.min(1, ((pos.lat - a[0]) * (b[0] - a[0]) + (pos.lng - a[1]) * (b[1] - a[1])) / (((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) || 1)));
        const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], d = M.meters(p, [pos.lat, pos.lng]);
        if (d < bestD) { bestD = d; best = acc + seg * t; }
        acc += seg;
      }
      const left = Math.max(0, nav.route.meters - best);
      if (now - nav.lastDraw > 60) {
        nav.lastDraw = now;
        // keep the car low on the screen, heading up
        const h = pos.heading || 0;
        const off = 0.08 * 826 * nav.view.mpp; // shift view centre ahead of the car
        const ahead = { lat: pos.lat + Math.cos(h * Math.PI / 180) * off / 111320, lng: pos.lng + Math.sin(h * Math.PI / 180) * off / (111320 * Math.cos(pos.lat * Math.PI / 180)) };
        nav.view.setView(ahead, 2.3);
        nav.view.setRotation(h);
        nav.line.setDone(best);
      }
      // next maneuver
      const next = nav.man.find((m) => m.at > best + 8);
      if (left < 60) { $('navTurn').textContent = '⚑'; $('navDist').textContent = 'Arriving'; $('navStreet').textContent = 'Destination on your right'; $('navThen').textContent = ''; }
      else if (next) { $('navTurn').textContent = ARROW[next.turn] || '↑'; $('navDist').textContent = fmtMi(next.at - best); $('navStreet').textContent = (next.turn === 'Continue' ? 'Continue onto ' : '') + next.street; $('navThen').textContent = ''; }
      else { $('navTurn').textContent = '↑'; $('navDist').textContent = fmtMi(left); $('navStreet').textContent = 'Toward destination'; $('navThen').textContent = ''; }
      const secs = nav.route.seconds * (left / Math.max(1, nav.route.meters));
      const eta = new Date(root.__TPDEMO__.clock.now() + secs * 1000);
      $('navEtaMin').textContent = Math.max(1, Math.round(secs / 60)) + ' min';
      $('navEtaInfo').textContent = fmtMi(left) + ' · ' + eta.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  };
  // Native ArrivalService: armed when the app starts navigation, shown only
  // while TackPath is NOT on screen; faded inside ½ mile, green inside 80 m.
  S.bubble = {
    arm(dest) { nav.arrival = { lat: dest.lat, lng: dest.lng, state: null }; this.render(); },
    disarm() { nav.arrival = null; this.render(); },
    state: () => nav.arrival && nav.arrival.state,
    onFix(pos) {
      if (!nav.arrival) return;
      const d = M.meters([pos.lat, pos.lng], [nav.arrival.lat, nav.arrival.lng]);
      const st = d <= 80 ? 'arrived' : d <= 805 ? 'approach' : null;
      if (st !== nav.arrival.state) {
        const was = nav.arrival.state; nav.arrival.state = st;
        if (st === 'arrived' && was !== 'arrived' && nav.open) S.notify('TackPath — ARRIVED', 'Tap to return and deliver', 'RETURN TO TACKPATH');
        this.render();
      }
    },
    render() {
      const b = $('arrBubble'), st = nav.arrival && nav.arrival.state;
      if (!st || !nav.open) { b.hidden = true; return; }
      b.hidden = false;
      b.className = 'arr-bubble ' + st;
      b.textContent = st === 'arrived' ? '✓ ARRIVED\nTap here to deliver' : '↩ TackPath';
    },
    el: () => $('arrBubble')
  };

  // ── clocks ──
  S.tickClock = function () {
    const t = new Date(root.__TPDEMO__.clock.now());
    $('demoClock').textContent = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('phoneTime').textContent = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ [AP]M/, '');
  };

  S.busy = function (text) { const b = $('busy'); if (!text) { b.hidden = true; return; } $('busyText').textContent = text; b.hidden = false; };
  S.title = function (on) { $('titleCard').classList.toggle('gone', !on); };
})(window);
