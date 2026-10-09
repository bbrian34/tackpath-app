const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// driver.html login screen: only working controls are visible, and the
// login card shows the new TackPath symbol (same as the native app).
const HTML = fs.readFileSync(path.join(__dirname, '..', 'driver.html'), 'utf-8');

function visible(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.hasAttribute('hidden')) return false;
    // the login screen hides with the hidden attribute or inline styles
    // (jsdom's getComputedStyle trips over this page's clamp() font sizes)
    if (n.style.display === 'none' || n.style.visibility === 'hidden') return false;
  }
  return true;
}

test('no dead sign-in buttons are visible on the login screen (Google/Apple hidden until Stage B)', () => {
  const dom = new JSDOM(HTML, { url: 'https://tackpath.com/' });
  try {
    const doc = dom.window.document;
    const phase = doc.getElementById('loginPhasePhone');
    assert.ok(phase && visible(phase), 'login form shown');
    const dead = [...doc.querySelectorAll('button, a, [onclick]')].filter((el) =>
      visible(el) && (/return false/.test(el.getAttribute('onclick') || '') ||
        /^\s*(Google|Apple)\s*$/i.test(el.textContent) || !(el.getAttribute('onclick') || el.getAttribute('href') || el.type === 'submit')));
    assert.deepStrictEqual(dead.map((el) => el.outerHTML.slice(0, 80)), []);
    assert.ok(![...doc.querySelectorAll('*')].some((el) => visible(el) && el.children.length === 0 && /or continue with/i.test(el.textContent)),
      'no "or continue with" divider');
    // still in the page, easy to restore: one hidden container
    const social = doc.getElementById('socialSignIn');
    assert.ok(social && social.hasAttribute('hidden'));
    assert.match(social.textContent, /Google/);
    assert.match(social.textContent, /Apple/);
  } finally { dom.window.close(); }
});

test('driver.html login card shows the new TackPath symbol, not the old three bars', () => {
  const dom = new JSDOM(HTML, { url: 'https://tackpath.com/' });
  try {
    const sym = dom.window.document.getElementById('tpSymbol');
    assert.ok(sym, 'symbol present');
    assert.strictEqual(sym.getAttribute('viewBox'), '0 0 48 56');
    assert.deepStrictEqual([...sym.querySelectorAll('path')].map((p) => p.getAttribute('d')),
      ['M7 47V34Q7 30 11 26', 'M21 47V24Q21 20 25 16', 'M35 47V14Q35 10 39 6']);
    assert.ok(dom.window.document.getElementById('scLogin').contains(sym), 'on the login card');
  } finally { dom.window.close(); }
  assert.doesNotMatch(HTML, /viewBox="0 0 36 70"/);
});
