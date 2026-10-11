const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// PICKUP TEXT COLOUR (2026-10, v19). "Pickup location: STG S-01" and "Bin 1"
// were blue (and dark blue on the dark card in light mode). They must be the
// card's normal readable text colour (white on the dark card), all three
// parts the same font size and weight, and at least 4.5:1 against the card in
// dark and light mode. Rendered in Chromium; same file in both repos.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function card(mode, spot) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.route(/^https?:\/\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.addInitScript((m) => { try { localStorage.setItem('tp_theme', m); localStorage.setItem('tp_dx_perm_intro', '1'); } catch (e) {} }, mode);
  await p.goto('file://' + FILE);
  await p.waitForTimeout(400);
  const m = await p.evaluate((spot) => {
    driver = { id: 'd', name: 'Dana', phone: '4045551234', token: 't' };
    currentJob = { id: 'job-1', title: 'Route 12', job_type: 'surge', status: 'assigned', bin_label: '1', surge_stops: [{ address: '1 A St', pkgs: [] }] };
    surgeStops = currentJob.surge_stops; isSurgeJob = true;
    showScreen('scRouteAccepted');
    dx.state.stage = 'ready'; dx.state.binding = { bin_code: '1', state: 'ready', staging_code: spot };
    dx.renderDay(); tpStg.apply();
    const rgba = (s) => { const v = String(s).match(/[\d.]+/g).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
    const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
    const bg = (el) => { const L = []; for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c.a > 0) { L.push(c); if (c.a >= 1) break; } }
      let c = { r: 255, g: 255, b: 255, a: 1 }; for (let i = L.length - 1; i >= 0; i--) c = over(L[i], c); return c; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const info = (sel) => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e), b = bg(e), f = over(rgba(cs.color), b);
      return { text: e.textContent, color: cs.color, size: cs.fontSize, weight: cs.fontWeight, contrast: (Math.max(lum(f), lum(b)) + 0.05) / (Math.min(lum(f), lum(b)) + 0.05), bg: b }; };
    return { loc: info('#dxDayCard .tp-stg-loc'), bin: info('#dxDayCard .tp-stg-bin'), ink: getComputedStyle(document.getElementById('dxDayCard')).color };
  }, spot);
  await ctx.close();
  return m;
}
// "blue": the blue channel clearly dominates (e.g. #19b7ef, #0a6496)
const isBlue = (c) => { const v = String(c).match(/[\d.]+/g).map(Number); return v[2] > v[0] + 40 && v[2] > v[1] - 10 && !(v[0] > 230 && v[1] > 230); };
const cardIsDark = (b) => (0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b) < 128;

for (const mode of ['dark', 'light']) {
  test(`d. ${mode} mode: "Pickup location: STG S-01" and "Bin 1" are the card's readable text colour (white on the dark card), same size and weight, >= 4.5:1, no blue`, async () => {
    const m = await card(mode, 'S-01');
    assert.strictEqual(m.loc.text, 'Pickup location: STG S-01');
    assert.strictEqual(m.bin.text, 'Bin 1');
    for (const part of [m.loc, m.bin]) {
      assert.ok(!isBlue(part.color), `${part.text}: ${part.color} is blue`);
      assert.ok(part.contrast >= 4.5, `${part.text}: contrast ${part.contrast.toFixed(2)} (${part.color})`);
      if (cardIsDark(part.bg)) assert.strictEqual(part.color, 'rgb(255, 255, 255)', `${part.text} is white on the dark card`);
      else assert.strictEqual(part.color, m.ink, `${part.text} uses the card's text colour`);
    }
    assert.strictEqual(m.loc.size, m.bin.size, 'same font size');
    assert.strictEqual(m.loc.weight, m.bin.weight, 'same font weight');
    // not staged: the Bin line keeps the same look
    const n = await card(mode, null);
    assert.strictEqual(n.bin.text, 'Bin 1');
    assert.strictEqual(n.bin.color, m.bin.color);
    assert.strictEqual(n.bin.size, m.bin.size);
  });
}
