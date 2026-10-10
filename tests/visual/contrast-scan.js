// Runs inside the page: every visible piece of text, its colour against the
// colour actually behind it (background layers composited up the tree,
// opacity included), checked against WCAG AA. Returns the failures.
// eslint-disable-next-line no-unused-vars
function tpContrastScan() {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const gradientStops = (img) => (img.match(/rgba?\([^)]+\)/g) || []).map(parse);
  // A gradient counts as the average of its stops, each laid over what is beneath it.
  const layersBehind = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const bg = parse(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) {
        const stops = gradientStops(cs.backgroundImage);
        if (stops.length) layers.push(stops);
      }
      if (bg && bg[3] > 0) layers.push([bg]);
      if (bg && bg[3] >= 1) break;
    }
    let c = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) {
      const each = layers[i].map((stop) => over(stop, c));
      c = each.reduce((s, x) => [s[0] + x[0] / each.length, s[1] + x[1] / each.length, s[2] + x[2] / each.length, 1], [0, 0, 0, 0]);
    }
    return c;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    // something else drawn on top of it (a drawer, a modal) hides it
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'svg', 'path', 'OPTION', 'IFRAME'].includes(el.tagName)) continue;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!own || !/[A-Za-z0-9]/.test(own)) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    let fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;   // gradient-clipped text
    let opacity = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    const bg = layersBehind(el);
    fg = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const r = ratio(fg, bg);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (r + 1e-9 < need) {
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
      const key = own.slice(0, 40) + '|' + cls + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      out.push({ text: own.slice(0, 50), el: el.tagName.toLowerCase() + id + cls, fg: hex(fg), bg: hex(bg),
        ratio: Math.round(r * 100) / 100, need, opacity: Math.round(opacity * 100) / 100 });
    }
  }
  return out;
}
