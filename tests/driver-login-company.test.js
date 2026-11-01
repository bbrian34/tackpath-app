const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Migration 69: a phone that is a driver in two companies chooses the company at sign-in.
// tp_driver_sign_in answers TP_CHOOSE_COMPANY with the companies; the page shows one
// button per company and signs in again with the same code and p_org. The offer card of
// a single delivery shows the delivery area (the open offer has no street address).
const ROOT = path.join(__dirname, '..');
const NATIVE_REPO = fs.existsSync(path.join(ROOT, 'www', 'index.html'));
const FILE = process.env.APP_HTML || (NATIVE_REPO ? path.join(ROOT, 'www', 'index.html') : path.join(ROOT, 'driver.html'));
const HTML = fs.readFileSync(FILE, 'utf-8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const calls = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], speaking: false, pending: false };
      w.confirm = () => true;
      w.navigator.geolocation = { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} };
      const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      w.fetch = async (url, o) => {
        url = String(url);
        const body = o && o.body ? JSON.parse(o.body) : {};
        if (url.endsWith('/functions/v1/driver-login')) return json(200, { ok: true });
        const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (m && m[1] === 'tp_driver_sign_in') {
          calls.push(body);
          if (!body.p_org) return json(200, { ok: false, error: 'TP_CHOOSE_COMPANY', companies: [{ slug: 'otherco', name: 'Other Co' }, { slug: 'quickhaul', name: 'Quick Haul' }] });
          return json(200, { ok: true, token: 'tok-' + body.p_org, driver: { id: 'drv-1', name: 'Dana', phone: '4045551234' } });
        }
        return json(200, []);
      };
    },
  });
  return { dom, w: dom.window, calls };
}

test('one phone in two companies: the driver picks the company and the same code signs in to it', async () => {
  const { dom, w, calls } = boot();
  try {
    await wait(300);
    const d = w.document;
    d.getElementById('loginPhone').value = '4045551234';
    await w.requestCode(); await wait(50);
    d.getElementById('loginCode').value = '123456';
    await w.verifyCode(); await wait(50);
    const box = d.getElementById('loginPhaseCompany');
    assert.strictEqual(box.style.display, 'block', 'the company choice is shown');
    assert.strictEqual(d.getElementById('loginPhaseCode').style.display, 'none');
    const buttons = [...d.querySelectorAll('#loginCompanyList button')];
    assert.deepStrictEqual(buttons.map((b) => b.textContent), ['Other Co', 'Quick Haul']);
    buttons[1].click(); await wait(100);
    assert.deepStrictEqual(calls.map((c) => [c.p_code, c.p_org || null]), [['123456', null], ['123456', 'quickhaul']], 'same code, chosen company');
    assert.strictEqual(JSON.parse(w.localStorage.getItem('tp_drv')).token, 'tok-quickhaul', 'signed in to the chosen company');
  } finally { dom.window.close(); }
});

test('an open single-delivery offer shows the delivery area, not a street address', () => {
  assert.match(HTML, /job\.dropoff_address\|\|job\.dropoff_area\|\|'--'/);
});
