// developers.html in Chromium: company sign-in, create a key (shown once),
// revoke it, add a webhook endpoint. Network: the page's calls go to the real
// API handler and the real gateways in PGlite (no outside requests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setup, rpc } from './harness.mjs';
import { handleApi } from '../../supabase/functions/_shared/tp_api.js';

const require = createRequire(import.meta.url);
const { launch } = require('../browser.js');
const PAGE = 'file://' + path.resolve(new URL('.', import.meta.url).pathname, '../../developers.html');

test('developers.html: sign in, create a key and see it once, revoke it, add a webhook endpoint', async () => {
  const t = await setup();
  const browser = await launch();
  const outside = [];
  try {
    const ctx = await browser.newContext();
    await ctx.route(/^https?:\/\//, async (route) => {
      const r = route.request(); const url = r.url();
      const m = url.match(/supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (m) {
        try { return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await rpc(t.db, m[1], JSON.parse(r.postData() || '{}'), 'anon')) }); }
        catch (e) { return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: e.message }) }); }
      }
      if (/supabase\.co\/functions\/v1\/api\//.test(url)) {
        const headers = r.headers();
        const res = await handleApi(new Request(url, { method: r.method(), headers, body: ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postData() }), t.deps);
        return route.fulfill({ status: res.status, headers: { ...res.headers, 'access-control-allow-origin': '*' }, body: JSON.stringify(res.body) });
      }
      outside.push(url); return route.abort();
    });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(PAGE);
    await page.fill('#slug', 'quickhaul'); await page.fill('#code', 'wrong');
    await page.click('#signinBtn');
    await page.waitForFunction(() => /not recognised/.test(document.getElementById('signinMsg').textContent));
    await page.fill('#code', 'qh-portal-2026'); await page.click('#signinBtn');
    await page.waitForSelector('#app:not(.hidden)');
    assert.equal(await page.inputValue('#code'), '', 'the code is not kept in the form');
    assert.ok(!(await page.evaluate(() => localStorage.getItem('tp_dispatch_org'))).includes('qh-portal'), 'the code is never stored');

    await page.fill('#kName', 'Warehouse system'); await page.click('#kCreate');
    await page.waitForSelector('#kSecret:not(.hidden)');
    const secret = await page.textContent('#kSecretVal');
    assert.match(secret, /^tpk_live_[0-9a-f]{12}_[0-9a-f]{64}$/);
    await page.waitForFunction(() => document.querySelectorAll('#keys tr').length === 1 && /Warehouse system/.test(document.getElementById('keys').textContent));
    assert.ok(!(await page.textContent('#keys')).includes(secret.slice(22)), 'the list shows only the prefix');
    assert.equal((await t.call('GET', '/orders', { key: secret })).status, 200, 'the key works');

    await page.click('#keys button.danger');
    await page.waitForFunction(() => /revoked/.test(document.getElementById('keys').textContent));
    assert.equal((await t.call('GET', '/orders', { key: secret })).status, 401, 'revoked at once');

    await page.fill('#wUrl', 'https://10.0.0.1/hook'); await page.click('#wCreate');
    await page.waitForFunction(() => /public host name/.test(document.getElementById('wMsg').textContent));
    await page.fill('#wUrl', 'https://hooks.example.com/tp'); await page.click('#wCreate');
    await page.waitForSelector('#wSecret:not(.hidden)');
    assert.match(await page.textContent('#wSecretVal'), /^whsec_/);
    await page.waitForFunction(() => /hooks\.example\.com\/tp/.test(document.getElementById('hooks').textContent));
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, [], 'no request leaves the page except to TackPath');
  } finally { await browser.close(); }
});
