const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

// SIGN-IN SCREEN (2026-10, v17). The wordmark showed only "PATH": TACK was an
// inline #ffffff, and in light mode the sign-in card is white. Rendered in
// Chromium at 360x640 and 412x915, dark and light mode: both words show, TACK
// has at least 4.5:1 contrast on the card, inputs and buttons are at least
// 48 px tall, nothing overflows or overlaps, and the form stays reachable with
// the keyboard open. The same file runs in both repos (APP_HTML overrides);
// the TP-LOGIN block must be identical in both pages.

const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const SIBLING = process.env.SIBLING_HTML || (NATIVE_REPO ? path.join(ROOT, '..', 'tackpath-app', 'driver.html') : path.join(ROOT, '..', 'tackpath-driver', 'www', 'index.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const block = (s) => (s.match(/<!-- TP-LOGIN:BEGIN[\s\S]*?<!-- TP-LOGIN:END -->/) || [''])[0];

const SIZES = [[360, 640], [412, 915]];
const MODES = ['dark', 'light'];

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(width, height, mode, phase) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.route(/^https?:\/\//, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));   // no network
  await p.addInitScript((m) => { try { localStorage.setItem('tp_theme', m); } catch (e) {} }, mode);
  await p.goto('file://' + FILE);
  await p.waitForTimeout(300);
  if (phase === 'code') {                        // the second step, as requestCode() shows it
    await p.evaluate(() => { document.getElementById('loginPhasePhone').style.display = 'none'; document.getElementById('loginPhaseCode').style.display = 'block'; });
  }
  return { p, close: () => ctx.close() };
}

// What the eye sees: the element's colour against the backgrounds behind it, composited.
const MEASURE = () => {
  const rgba = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(',').map((x) => parseFloat(x)); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgBehind = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let col = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
    return col;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (el) => { const bg = bgBehind(el), fg = over(rgba(getComputedStyle(el).color), bg); const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const r = (el) => { const q = el.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right, height: q.height, width: q.width }; };
  const shown = (el) => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const wm = document.querySelector('#scLogin .wm');
  const t = wm.querySelector('.t'), pth = wm.querySelector('.p');
  const box = document.querySelector('#scLogin .lbox');
  const form = [...document.querySelectorAll('#scLogin .lbox-form')].find(shown);
  const parts = [...form.children].filter(shown).filter((e) => !e.hidden);
  return {
    words: wm.textContent.replace(/Ʌ/g, 'A').replace(/\s+/g, ''),
    tackText: t.textContent.replace(/Ʌ/g, 'A').replace(/\s+/g, ''),
    pathText: pth.textContent.replace(/Ʌ/g, 'A').replace(/\s+/g, ''),
    tackContrast: contrast(t), pathContrast: contrast(pth), tackColor: getComputedStyle(t).color,
    tackShown: shown(t) && r(t).width > 20 && getComputedStyle(t).visibility !== 'hidden' && parseFloat(getComputedStyle(t).opacity) > 0.9,
    wm: r(wm), wmClipped: wm.scrollWidth > wm.clientWidth + 1, box: r(box),
    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    controls: [...form.querySelectorAll('input,button')].filter(shown).map((e) => ({ id: e.id || e.textContent.trim(), h: r(e).height, left: r(e).left, right: r(e).right })),
    parts: parts.map((e) => ({ tag: e.tagName, id: e.id, ...r(e) })),
    vw: innerWidth,
  };
};

test('the sign-in look (TP-LOGIN) is the same in both repos, and loads once', () => {
  assert.ok(block(HTML).length > 500);
  assert.strictEqual((HTML.match(/<!-- TP-LOGIN:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

for (const mode of MODES) for (const [w, h] of SIZES) {
  test(`${mode} mode, ${w}x${h}: TACK and PATH both show, TACK has >= 4.5:1 contrast, nothing overflows or overlaps`, async () => {
    for (const phase of ['phone', 'code']) {
      const s = await open(w, h, mode, phase);
      try {
        const m = await s.p.evaluate(MEASURE);
        const at = `${mode} ${w}x${h} ${phase}`;
        assert.strictEqual(m.words, 'TACKPATH', at);
        assert.strictEqual(m.tackText, 'TACK'); assert.strictEqual(m.pathText, 'PATH');
        assert.ok(m.tackShown, 'TACK is drawn: ' + at);
        assert.ok(m.tackContrast >= 4.5, `TACK contrast ${m.tackContrast.toFixed(2)} (${m.tackColor}) ${at}`);
        assert.ok(m.pathContrast >= 3, `PATH contrast ${m.pathContrast.toFixed(2)} ${at}`);
        assert.ok(!m.wmClipped, 'wordmark not clipped: ' + at);
        assert.ok(m.wm.left >= m.box.left && m.wm.right <= m.box.right, 'wordmark inside the card: ' + at);
        assert.ok(!m.pageOverflow, 'no sideways scroll: ' + at);
        assert.ok(m.box.left >= 0 && m.box.right <= m.vw, 'card inside the screen: ' + at);
        for (const c of m.controls) {
          assert.ok(c.h >= 48, `${c.id} is ${c.h}px tall (${at})`);
          assert.ok(c.left >= m.box.left && c.right <= m.box.right, `${c.id} inside the card (${at})`);
        }
        for (let i = 1; i < m.parts.length; i++) {
          assert.ok(m.parts[i].top >= m.parts[i - 1].bottom - 0.5, `${m.parts[i - 1].id || m.parts[i - 1].tag} and ${m.parts[i].id || m.parts[i].tag} overlap (${at})`);
        }
      } finally { await s.close(); }
    }
  });
}

test('inputs and the primary buttons are at least 48 px tall, with labels', async () => {
  const s = await open(360, 640, 'dark', 'phone');
  try {
    const h = await s.p.evaluate(() => ['loginPhone', 'loginPhoneBtn', 'loginCode', 'loginVerifyBtn'].map((id) => {
      const e = document.getElementById(id); const was = e.closest('.lbox-form').style.display;
      e.closest('.lbox-form').style.display = 'block'; const v = e.getBoundingClientRect().height; e.closest('.lbox-form').style.display = was; return [id, v];
    }));
    for (const [id, v] of h) assert.ok(v >= 48, `${id}: ${v}px`);
    const labels = await s.p.evaluate(() => [...document.querySelectorAll('#scLogin .fl')].map((l) => l.textContent.trim()));
    assert.deepStrictEqual(labels, ['Mobile Number', 'Verification Code']);
  } finally { await s.close(); }
});

test('keyboard open (short viewport): the phone field and Send Code stay reachable on screen', async () => {
  for (const [w, h] of [[360, 330], [412, 480]]) {
    const s = await open(w, h, 'light', 'phone');
    try {
      await s.p.focus('#loginPhone');
      await s.p.evaluate(() => document.getElementById('loginPhoneBtn').scrollIntoView({ block: 'nearest' }));
      const r = await s.p.evaluate(() => ['loginPhone', 'loginPhoneBtn'].map((id) => { const q = document.getElementById(id).getBoundingClientRect(); return [id, q.top, q.bottom]; }));
      for (const [id, top, bottom] of r) assert.ok(top >= 0 && bottom <= h + 0.5, `${id} on screen at ${w}x${h}: ${top}-${bottom}`);
    } finally { await s.close(); }
  }
});
