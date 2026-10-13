// The documentation matches the code: openapi.json is generated from
// build-openapi.mjs and lists exactly the routes the API serves, every error
// code the API can return is documented, and the webhook verification examples
// (Node and Python) accept real TackPath signatures and reject old or altered ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROUTES, signWebhook } from '../../supabase/functions/_shared/tp_api.js';
import { OPENAPI } from '../../docs/api/build-openapi.mjs';
import { verifyTackPathSignature } from '../../docs/api/examples/verify-webhook.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

test('openapi.json is up to date with build-openapi.mjs', () => {
  assert.deepEqual(JSON.parse(read('docs/api/openapi.json')), JSON.parse(JSON.stringify(OPENAPI)),
    'run: node docs/api/build-openapi.mjs');
  assert.match(OPENAPI.openapi, /^3\./);
});

test('openapi paths and methods are exactly the routes the API serves', () => {
  const served = ROUTES.map(([m, p]) => `${m} ${p.replace(/:id/g, '{id}')}`).sort();
  const documented = Object.entries(OPENAPI.paths).flatMap(([p, ops]) =>
    Object.keys(ops).filter((k) => k !== 'parameters').map((m) => `${m.toUpperCase()} ${p}`)).sort();
  assert.deepEqual(documented, served);
  assert.ok(OPENAPI.servers.every((s) => s.url.endsWith('/functions/v1/api/v1')), 'server URL carries the version');
});

test('every error code the SQL gateway and the edge function return is in the developer guide', () => {
  const sql = read('supabase/security/69_public_api.sql');
  const js = read('supabase/functions/_shared/tp_api.js');
  const codes = new Set([
    ...[...sql.matchAll(/fail\(\d{3},\s*'([a-z_]+)'/g)].map((m) => m[1]),
    ...[...sql.matchAll(/'error',\s*'([a-z_]+)',\s*'message'/g)].map((m) => m[1]),
    ...[...js.matchAll(/error\(\d{3},\s*'([a-z_]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(codes.size >= 20, `found ${codes.size} codes`);
  const guide = read('docs/api/README.md');
  const missing = [...codes].filter((c) => !guide.includes('`' + c + '`'));
  assert.deepEqual(missing, [], 'undocumented error codes');
});

test('Node example verifies TackPath signatures and rejects old or altered ones', async () => {
  const secret = 'whsec_' + 'a'.repeat(48), body = JSON.stringify({ id: 'evt_1', type: 'webhook.test' });
  const now = Date.now(), t = Math.floor(now / 1000);
  const header = await signWebhook(secret, body, t);
  assert.equal(verifyTackPathSignature(secret, body, header, 300, now), true);
  assert.equal(verifyTackPathSignature(secret, body + ' ', header, 300, now), false, 'altered body');
  assert.equal(verifyTackPathSignature('whsec_other', body, header, 300, now), false, 'wrong secret');
  assert.equal(verifyTackPathSignature(secret, body, await signWebhook(secret, body, t - 301), 300, now), false, 'replayed');
  assert.equal(verifyTackPathSignature(secret, body, '', 300, now), false, 'no header');
});

test('Python example verifies TackPath signatures and rejects old or altered ones', async () => {
  const secret = 'whsec_' + 'b'.repeat(48), body = '{"id":"evt_2","type":"order.status_changed"}';
  const t = Math.floor(Date.now() / 1000);
  const good = await signWebhook(secret, body, t), old = await signWebhook(secret, body, t - 301);
  const script = `
import sys, json
sys.path.insert(0, sys.argv[1])
from verify_webhook import verify_tackpath_signature as v
s, b, good, old, t = sys.argv[2:7]; b = b.encode(); t = int(t)
print(json.dumps([v(s, b, good, now=t), v(s, b + b" ", good, now=t), v("x", b, good, now=t), v(s, b, old, now=t), v(s, b, "", now=t), v(s, b, "t=abc,v1=00", now=t)]))`;
  const dir = new URL('docs/api/examples/', root).pathname;
  const out = execFileSync('python3', ['-I', '-B', '-c', script, dir, secret, body, good, old, String(t)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [true, false, false, false, false, false]);
});
