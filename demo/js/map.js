/* TackPath demo — offline map.
   A street graph built from demo/js/data.js, shortest-path routing on it, an
   SVG map renderer, and a small Google-Maps-compatible shim so the real
   dispatcher's fleet map draws on this map instead of loading Google Maps.
   No network. Route geometry is computed once and cached. */
(function (root) {
  'use strict';
  const D = root.DEMO_DATA;
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  function meters(a, b) {
    const dLa = toRad(b[0] - a[0]), dLn = toRad(b[1] - a[1]);
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLn / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  const SPEED = { major: 13.4, street: 9.8 }; // m/s (~30 and ~22 mph, city traffic)

  // ── GRAPH ──
  const nodes = []; // [lat,lng]
  const key = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  const nodeIndex = new Map();
  function nodeFor(p) {
    const k = key(p);
    if (nodeIndex.has(k)) return nodeIndex.get(k);
    const id = nodes.length; nodes.push([p[0], p[1]]); nodeIndex.set(k, id); return id;
  }
  const adj = []; // id -> [{to, m, s, street}]
  function addEdge(a, b, cls, name) {
    const ia = nodeFor(a), ib = nodeFor(b);
    if (ia === ib) return;
    const m = meters(a, b), s = m / SPEED[cls];
    (adj[ia] = adj[ia] || []).push({ to: ib, m, s, street: name });
    (adj[ib] = adj[ib] || []).push({ to: ia, m, s, street: name });
  }
  function segIntersect(p1, p2, p3, p4) {
    const d = (p2[1] - p1[1]) * (p4[0] - p3[0]) - (p2[0] - p1[0]) * (p4[1] - p3[1]);
    if (Math.abs(d) < 1e-14) return null;
    const t = ((p3[1] - p1[1]) * (p4[0] - p3[0]) - (p3[0] - p1[0]) * (p4[1] - p3[1])) / d;
    const u = ((p3[1] - p1[1]) * (p2[0] - p1[0]) - (p3[0] - p1[0]) * (p2[1] - p1[1])) / d;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]), t];
  }
  const driven = D.STREETS.filter((s) => s[1] !== 'highway');
  // split every segment at every crossing with another driven street
  const segs = [];
  driven.forEach(([name, cls, pts]) => { for (let i = 0; i < pts.length - 1; i++) segs.push({ name, cls, a: pts[i], b: pts[i + 1], cuts: [] }); });
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (segs[i].name === segs[j].name) continue;
    const x = segIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
    if (!x) continue;
    const p = [x[0], x[1]];
    segs[i].cuts.push(p); segs[j].cuts.push(p);
  }
  segs.forEach((s) => {
    const pts = [s.a, ...s.cuts, s.b];
    const len = meters(s.a, s.b) || 1;
    pts.sort((p, q) => meters(s.a, p) / len - meters(s.a, q) / len);
    for (let i = 0; i < pts.length - 1; i++) addEdge(pts[i], pts[i + 1], s.cls, s.name);
  });

  // nearest point on the graph (projected onto an edge)
  function snap(lat, lng) {
    let best = null;
    const cosL = Math.cos(toRad(lat));
    for (let a = 0; a < nodes.length; a++) for (const e of adj[a] || []) {
      if (e.to < a) continue;
      const A = nodes[a], B = nodes[e.to];
      const ax = A[1] * cosL, ay = A[0], bx = B[1] * cosL, by = B[0], px = lng * cosL, py = lat;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-18;
      let t = ((px - ax) * dx + (py - ay) * dy) / L; t = Math.max(0, Math.min(1, t));
      const q = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])];
      const d = meters([lat, lng], q);
      if (!best || d < best.d) best = { d, a, b: e.to, t, q, e };
    }
    return best;
  }
  function dijkstra(srcList, dstSet) {
    const dist = new Map(), prev = new Map(), done = new Set();
    const pq = [];
    srcList.forEach(([n, c, via]) => { dist.set(n, c); prev.set(n, via); pq.push([c, n]); });
    while (pq.length) {
      let bi = 0; for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
      const [c, n] = pq.splice(bi, 1)[0];
      if (done.has(n)) continue; done.add(n);
      if (dstSet.has(n)) return { n, dist, prev };
      for (const e of adj[n] || []) {
        const nc = c + e.s;
        if (nc < (dist.has(e.to) ? dist.get(e.to) : Infinity)) { dist.set(e.to, nc); prev.set(e.to, n); pq.push([nc, e.to]); }
      }
    }
    return null;
  }
  const cache = new Map();
  // Road route between two points: {coords:[[lat,lng]...], meters, seconds}
  function route(from, to) {
    const ck = key(from) + '>' + key(to);
    if (cache.has(ck)) return cache.get(ck);
    const s = snap(from[0], from[1]), t = snap(to[0], to[1]);
    const segSec = (snp, toNode) => meters(snp.q, nodes[toNode]) / SPEED[snp.e ? 'major' : 'major'];
    let out;
    if (s.a === t.a && s.b === t.b) {
      out = { coords: [from, s.q, t.q, to], meters: meters(s.q, t.q), seconds: meters(s.q, t.q) / SPEED.major };
    } else {
      const res = dijkstra([[s.a, segSec(s, s.a), -1], [s.b, segSec(s, s.b), -1]], new Set([t.a, t.b]));
      const path = [];
      let n = res.n; while (n !== -1 && n !== undefined) { path.unshift(n); n = res.prev.get(n); }
      const coords = [from, s.q, ...path.map((i) => nodes[i]), t.q, to];
      let m = 0; for (let i = 1; i < coords.length - 1; i++) m += meters(coords[i - 1], coords[i]);
      out = { coords, meters: m, seconds: res.dist.get(res.n) + meters(nodes[res.n], t.q) / SPEED.major };
    }
    // drop zero-length points
    out.coords = out.coords.filter((p, i, arr) => i === 0 || meters(arr[i - 1], p) > 0.5);
    cache.set(ck, out);
    return out;
  }
  // Point and heading at a distance along a polyline
  function along(coords, m) {
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = meters(coords[i - 1], coords[i]);
      if (acc + seg >= m) {
        const t = seg ? (m - acc) / seg : 0;
        const a = coords[i - 1], b = coords[i];
        return { lat: a[0] + t * (b[0] - a[0]), lng: a[1] + t * (b[1] - a[1]), heading: bearing(a, b), index: i };
      }
      acc += seg;
    }
    const L = coords[coords.length - 1], P = coords[coords.length - 2] || L;
    return { lat: L[0], lng: L[1], heading: bearing(P, L), index: coords.length - 1 };
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function polyLength(c) { let m = 0; for (let i = 1; i < c.length; i++) m += meters(c[i - 1], c[i]); return m; }
  // Turn-by-turn style instructions from the street names along a route.
  function maneuvers(r) {
    const out = []; let cur = null, acc = 0;
    const streetOf = (a, b) => { const sa = snap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); return sa && sa.e ? sa.e.street : ''; };
    for (let i = 1; i < r.coords.length; i++) {
      const a = r.coords[i - 1], b = r.coords[i], seg = meters(a, b);
      if (seg < 1) continue;
      const st = streetOf(a, b);
      if (st !== cur) {
        const prevH = out.length ? out[out.length - 1].heading : null, h = bearing(a, b);
        let turn = 'Head';
        if (prevH != null) { const d = ((h - prevH + 540) % 360) - 180; turn = Math.abs(d) < 25 ? 'Continue' : d > 0 ? 'Turn right' : 'Turn left'; }
        out.push({ street: st, at: acc, heading: h, turn });
        cur = st;
      }
      acc += seg;
    }
    return out;
  }

  // ── SVG RENDERER ──
  const THEMES = {
    dark: { bg: '#0b1b2e', park: '#123526', campus: '#14263c', district: '#132a40', major: '#2b4a6b', majorCase: '#0b1b2e', street: '#1f3956',
      highway: '#3a5f86', highwayCase: '#0b1b2e', label: 'rgba(200,220,240,.55)', area: 'rgba(160,220,190,.6)', streetLabel: 'rgba(190,210,230,.62)' },
    light: { bg: '#eef1f4', park: '#cdebd2', campus: '#e4e1f0', district: '#e6edf5', major: '#ffffff', majorCase: '#c9d1da', street: '#ffffff',
      highway: '#f7d27a', highwayCase: '#d9ab45', label: 'rgba(60,72,88,.6)', area: 'rgba(40,110,60,.75)', streetLabel: 'rgba(70,82,96,.8)' }
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  function el(doc, tag, attrs) { const e = doc.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

  class MapView {
    constructor(container, opts) {
      opts = opts || {};
      this.doc = container.ownerDocument;
      this.c = container;
      this.theme = THEMES[opts.theme || 'dark'];
      this.center = opts.center || { lat: 33.7780, lng: -84.3900 };
      this.mpp = opts.mpp || 3.2; // metres per pixel
      this.rotate = 0;
      this.markers = new Set(); this.lines = new Set();
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.style.overflow = 'hidden';
      container.style.background = this.theme.bg;
      this.wrap = this.doc.createElement('div');
      this.wrap.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%;';
      this.svg = el(this.doc, 'svg', { width: '100%', height: '100%' });
      this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      this.gBase = el(this.doc, 'g', {}); this.gLines = el(this.doc, 'g', {}); this.gLabels = el(this.doc, 'g', {});
      this.svg.append(this.gBase, this.gLines, this.gLabels);
      this.overlay = this.doc.createElement('div');
      this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      this.wrap.append(this.svg, this.overlay);
      container.appendChild(this.wrap);
      this.labels = opts.labels !== false;
      this.ro = new (this.doc.defaultView.ResizeObserver)(() => this.draw());
      this.ro.observe(container);
      this.draw();
    }
    size() { return { w: this.c.clientWidth || 400, h: this.c.clientHeight || 300 }; }
    px(lat, lng) {
      const { w, h } = this.size();
      const cosL = Math.cos(toRad(this.center.lat));
      const x = (lng - this.center.lng) * (Math.PI / 180) * R * cosL / this.mpp;
      const y = -(lat - this.center.lat) * (Math.PI / 180) * R / this.mpp;
      return [w / 2 + x, h / 2 + y];
    }
    setView(center, mpp) { if (center) this.center = { lat: center.lat, lng: center.lng }; if (mpp) this.mpp = mpp; this.draw(); }
    setRotation(deg) { this.rotate = deg; this.wrap.style.transform = 'rotate(' + (-deg) + 'deg) scale(' + (deg ? 1.45 : 1) + ')'; }
    fit(points, pad) {
      if (!points.length) return;
      let la0 = 90, la1 = -90, ln0 = 180, ln1 = -180;
      points.forEach((p) => { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); ln0 = Math.min(ln0, p.lng); ln1 = Math.max(ln1, p.lng); });
      const { w, h } = this.size(); pad = pad == null ? 40 : pad;
      const cosL = Math.cos(toRad((la0 + la1) / 2));
      const mw = toRad(ln1 - ln0) * R * cosL, mh = toRad(la1 - la0) * R;
      this.center = { lat: (la0 + la1) / 2, lng: (ln0 + ln1) / 2 };
      this.mpp = Math.max(mw / Math.max(10, w - 2 * pad), mh / Math.max(10, h - 2 * pad), 1.2);
      this.draw();
    }
    draw() {
      const T = this.theme, g = this.gBase, doc = this.doc;
      g.textContent = ''; this.gLabels.textContent = '';
      const pathOf = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + this.px(p[0], p[1]).map((v) => v.toFixed(1)).join(',')).join('');
      D.AREAS.forEach((a) => {
        g.appendChild(el(doc, 'path', { d: pathOf(a.poly) + 'Z', fill: T[a.kind] || T.district, stroke: 'none' }));
      });
      const z = 3.2 / this.mpp; // stroke scale
      const order = ['street', 'major', 'highway'];
      order.forEach((cls) => D.STREETS.filter((s) => s[1] === cls).forEach(([, , pts]) => {
        const d = pathOf(pts);
        const wFill = cls === 'highway' ? 9 : cls === 'major' ? 7 : 4.6;
        g.appendChild(el(doc, 'path', { d, fill: 'none', stroke: T[cls === 'highway' ? 'highwayCase' : 'majorCase'], 'stroke-width': Math.max(1.5, (wFill + 2.4) * z), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        g.appendChild(el(doc, 'path', { d, fill: 'none', stroke: T[cls], 'stroke-width': Math.max(1, wFill * z), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }));
      if (!this.labels) return;
      const fs = Math.max(8, Math.min(13, 11 * z));
      D.STREETS.forEach(([name, cls, pts]) => {
        if (cls === 'street' && z < 0.75) return;
        // label on the longest segment
        let bi = 0, bl = 0;
        for (let i = 0; i < pts.length - 1; i++) { const l = meters(pts[i], pts[i + 1]); if (l > bl) { bl = l; bi = i; } }
        const a = this.px(pts[bi][0], pts[bi][1]), b = this.px(pts[bi + 1][0], pts[bi + 1][1]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < name.length * fs * 0.62) return;
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const t = el(doc, 'text', { x: mx, y: my, 'font-size': fs, fill: T.streetLabel, 'text-anchor': 'middle', 'dominant-baseline': 'central',
          'font-family': 'Inter, DM Sans, system-ui, sans-serif', 'font-weight': cls === 'highway' ? 700 : 600, transform: 'rotate(' + ang + ' ' + mx + ' ' + my + ')',
          'paint-order': 'stroke', stroke: T.bg, 'stroke-width': 3 });
        t.textContent = name; this.gLabels.appendChild(t);
      });
      D.AREAS.forEach((a) => {
        if (a.kind === 'district') return;
        let la = 0, ln = 0; a.poly.forEach((p) => { la += p[0]; ln += p[1]; });
        const [x, y] = this.px(la / a.poly.length, ln / a.poly.length);
        const t = el(doc, 'text', { x, y, 'font-size': fs * 0.95, fill: T.area, 'text-anchor': 'middle', 'font-family': 'Inter, DM Sans, system-ui, sans-serif', 'font-weight': 600 });
        t.textContent = a.name; this.gLabels.appendChild(t);
      });
      D.LABELS.forEach((l) => {
        const [x, y] = this.px(l.lat, l.lng);
        const t = el(doc, 'text', { x, y, 'font-size': fs * 1.05, fill: T.label, 'text-anchor': 'middle', 'letter-spacing': '0.18em', 'font-family': 'Inter, DM Sans, system-ui, sans-serif', 'font-weight': 700 });
        t.textContent = l.text; this.gLabels.appendChild(t);
      });
      this.lines.forEach((l) => l.render());
      this.markers.forEach((m) => m.place());
    }
  }

  class RouteLine {
    constructor(view, coords, opts) {
      this.view = view; this.coords = coords; this.opts = Object.assign({ color: '#19b7ef', width: 5, opacity: 0.95, dash: null, done: 0 }, opts || {});
      this.g = el(view.doc, 'g', {}); view.gLines.appendChild(this.g); view.lines.add(this); this.render();
    }
    setDone(m) { this.opts.done = m; this.render(); }
    render() {
      const v = this.view, o = this.opts, doc = v.doc;
      this.g.textContent = '';
      const z = Math.max(0.6, 3.2 / v.mpp);
      const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + v.px(p[0], p[1]).map((x) => x.toFixed(1)).join(',')).join('');
      const casing = el(doc, 'path', { d: path(this.coords), fill: 'none', stroke: o.casing || 'rgba(0,0,0,.35)', 'stroke-width': (o.width + 3) * z, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: o.opacity });
      const line = el(doc, 'path', { d: path(this.coords), fill: 'none', stroke: o.color, 'stroke-width': o.width * z, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: o.opacity });
      if (o.dash) line.setAttribute('stroke-dasharray', o.dash);
      this.g.append(casing, line);
      if (o.done > 0) {
        const pts = []; let acc = 0;
        for (let i = 0; i < this.coords.length; i++) {
          if (i === 0) { pts.push(this.coords[0]); continue; }
          const seg = meters(this.coords[i - 1], this.coords[i]);
          if (acc + seg >= o.done) { const p = along(this.coords, o.done); pts.push([p.lat, p.lng]); break; }
          pts.push(this.coords[i]); acc += seg;
        }
        this.g.appendChild(el(doc, 'path', { d: path(pts), fill: 'none', stroke: o.doneColor || 'rgba(140,155,170,.85)', 'stroke-width': o.width * z, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
    }
    remove() { this.g.remove(); this.view.lines.delete(this); }
  }

  class PinMarker {
    constructor(view, pos, html, opts) {
      this.view = view; this.pos = pos; this.opts = opts || {};
      this.el = view.doc.createElement('div');
      this.el.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-50%);' + (this.opts.style || '');
      this.el.innerHTML = html;
      view.overlay.appendChild(this.el); view.markers.add(this); this.place();
    }
    setPosition(pos) { this.pos = { lat: pos.lat, lng: pos.lng }; this.place(); }
    setHtml(h) { this.el.innerHTML = h; }
    place() {
      const [x, y] = this.view.px(this.pos.lat, this.pos.lng);
      this.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%)' + (this.opts.rot != null ? ' rotate(' + this.opts.rot + 'deg)' : '');
    }
    remove() { this.el.remove(); this.view.markers.delete(this); }
  }

  // ── GOOGLE MAPS SHIM (subset the real dispatcher uses) ──
  // Map, Marker (circle symbol + label), SymbolPath, LatLng, LatLngBounds,
  // event.addListener. Markers re-created for the same driver glide from the
  // previous position instead of jumping (presentation only).
  function makeGoogleShim(win) {
    const last = new Map(); // label -> {pos, at}
    function ll(p) { return typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: +p.lat, lng: +p.lng }; }
    class LatLng { constructor(a, b) { this._a = +a; this._b = +b; } lat() { return this._a; } lng() { return this._b; } }
    class GMap {
      constructor(div, opts) {
        // follow the page's theme (the dispatcher has a light theme)
        const light = win.document.documentElement.getAttribute('data-theme') === 'light';
        this.view = new MapView(div, { theme: light ? 'light' : 'dark', center: opts && opts.center ? ll(opts.center) : null, mpp: 4.2 });
        win.__demoFleetMap = this;
        // keep the whole service area (hub + every stop) in view
        const pts = D.STOPS.map((s) => ({ lat: s.lat, lng: s.lng })).concat([{ lat: D.COMPANY.hub.lat, lng: D.COMPANY.hub.lng }]);
        this.view.fit(pts, 46);
      }
      setCenter() { /* the demo keeps the whole service area in view */ }
      setZoom() {} fitBounds() {} panTo() {} getZoom() { return 13; }
    }
    class Marker {
      constructor(o) {
        this.o = o || {}; this.map = null; this.pin = null;
        if (o && o.map) this.setMap(o.map);
      }
      setMap(m) {
        if (this.pin) { this.pin.remove(); this.pin = null; clearInterval(this.anim); }
        this.map = m;
        if (!m) return;
        const o = this.o, label = o.label && (o.label.text || o.label) || '';
        const color = o.icon && o.icon.fillColor || '#19b7ef', op = o.icon && o.icon.fillOpacity != null ? o.icon.fillOpacity : 1;
        const target = ll(o.position);
        const prev = last.get(label);
        const start = prev ? prev.pos : target;
        const html = '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;opacity:' + op + '">'
          + '<div style="width:34px;height:34px;border-radius:50%;background:' + color + ';border:2.5px solid #fff;box-shadow:0 0 0 6px ' + color + '33,0 4px 14px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:800 10px Inter,system-ui;color:#fff;">'
          + String(label).slice(0, 6) + '</div></div>';
        this.pin = new PinMarker(m.view, start, html);
        const now = win.performance.now(), gap = prev ? Math.min(6000, Math.max(600, now - prev.at)) : 0;
        last.set(label, { pos: target, at: now });
        if (prev && (prev.pos.lat !== target.lat || prev.pos.lng !== target.lng)) {
          const t0 = now, dur = gap * 0.92;
          this.anim = setInterval(() => {
            const f = Math.min(1, (win.performance.now() - t0) / dur), e = f;
            this.pin && this.pin.setPosition({ lat: start.lat + (target.lat - start.lat) * e, lng: start.lng + (target.lng - start.lng) * e });
            if (f >= 1) clearInterval(this.anim);
          }, 33);
        }
      }
      setPosition(p) { this.o.position = p; if (this.pin) this.pin.setPosition(ll(p)); }
      getPosition() { return new LatLng(ll(this.o.position).lat, ll(this.o.position).lng); }
      addListener() { return { remove() {} }; }
    }
    class LatLngBounds { constructor() { this.pts = []; } extend(p) { this.pts.push(ll(p)); return this; } }
    const noop = function () { return { remove() {} }; };
    return {
      maps: {
        Map: GMap, Marker, LatLng, LatLngBounds,
        SymbolPath: { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1 },
        event: { addListener: noop, removeListener() {}, clearInstanceListeners() {} },
        InfoWindow: class { open() {} close() {} setContent() {} },
        Size: class { constructor(w, h) { this.width = w; this.height = h; } },
        Point: class { constructor(x, y) { this.x = x; this.y = y; } },
        __demo: true
      }
    };
  }

  root.DEMO_MAP = { meters, snap, route, along, bearing, polyLength, maneuvers, MapView, RouteLine, PinMarker, makeGoogleShim, nodes, adj };
})(typeof window !== 'undefined' ? window : globalThis);
