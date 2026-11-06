// API v1: credentials, scopes, key management, who may call the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORDER, rpc } from './harness.mjs';

const t = await setup();
const { call, sessionA, newKey, db } = t;

test('no key, a malformed key, an unknown key and a wrong secret are all 401 with a request id', async () => {
  for (const key of [undefined, 'abc', 'tpk_live_123', 'tpk_live_aaaaaaaaaaaa_' + 'b'.repeat(64)]) {
    const r = await call('GET', '/orders', { key });
    assert.equal(r.status, 401, String(key));
    assert.match(r.body.error.code, /^invalid_api_key$/);
    assert.match(r.body.error.request_id, /^req_[0-9a-f]{24}$/);
    assert.equal(r.headers['X-Request-Id'], r.body.error.request_id);
  }
  const good = await newKey(sessionA);
  const wrong = good.key.slice(0, -4) + (good.key.endsWith('0000') ? '1111' : '0000');
  assert.equal((await call('GET', '/orders', { key: wrong })).status, 401, 'right prefix, wrong secret');
  assert.equal((await call('GET', '/orders', { key: good.key })).status, 200);
});

test('a new key is shown once; the database keeps only its SHA-256 and prefix', async () => {
  const k = await newKey(t.sessionA, { name: 'WMS' });
  assert.match(k.key, /^tpk_live_[0-9a-f]{12}_[0-9a-f]{64}$/);
  assert.equal(k.prefix, k.key.slice(0, 21));
  const list = await call('GET', '/admin/keys', { session: sessionA });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.every((x) => !('key' in x)), 'list never contains the secret');
  const stored = (await db.query('select * from tp_api.keys')).rows;
  assert.ok(stored.every((r) => !JSON.stringify(r).includes(k.key.slice(22))), 'no stored row contains the secret part');
  const audit = (await db.query('select * from tp_api.audit')).rows;
  assert.ok(audit.length > 0 && audit.every((r) => !JSON.stringify(r).includes(k.key.slice(22))), 'audit log has no secrets');
});

test('revoked and expired keys are refused at once; rotation keeps the old key for the grace period only', async () => {
  const k = await newKey(sessionA);
  const id = k.id;
  assert.equal((await call('POST', `/admin/keys/${id}/revoke`, { session: sessionA })).status, 200);
  const r = await call('GET', '/orders', { key: k.key });
  assert.equal(r.status, 401); assert.equal(r.body.error.code, 'api_key_revoked');

  const e = await newKey(sessionA, { expires_in_days: 1 });
  assert.equal((await call('GET', '/orders', { key: e.key })).status, 200);
  await db.query(`update tp_api.keys set expires_at = now() - interval '1 second' where id = tp_api.parse_id('key', $1)`, [e.id]);
  const x = await call('GET', '/orders', { key: e.key });
  assert.equal(x.status, 401); assert.equal(x.body.error.code, 'api_key_expired');

  const old = await newKey(sessionA, { name: 'Rotate me', scopes: ['orders:read'] });
  const rot = await call('POST', `/admin/keys/${old.id}/rotate`, { session: sessionA, body: { grace_hours: 2 } });
  assert.equal(rot.status, 201);
  assert.notEqual(rot.body.key, old.key);
  assert.deepEqual(rot.body.scopes, ['orders:read'], 'the new key keeps the scopes');
  assert.ok(Date.parse(rot.body.previous_key_expires_at) - Date.now() < 2.1 * 3600e3);
  assert.equal((await call('GET', '/orders', { key: old.key })).status, 200, 'old key works during the grace period');
  assert.equal((await call('GET', '/orders', { key: rot.body.key })).status, 200);
  await db.query(`update tp_api.keys set expires_at = now() - interval '1 second' where id = tp_api.parse_id('key', $1)`, [old.id]);
  assert.equal((await call('GET', '/orders', { key: old.key })).status, 401, 'old key stops after the grace period');
  const now = await call('POST', `/admin/keys/${rot.body.id}/rotate`, { session: sessionA, body: { grace_hours: 0 } });
  assert.equal((await call('GET', '/orders', { key: rot.body.key })).status, 401, 'grace 0 revokes the old key immediately');
  assert.equal((await call('GET', '/orders', { key: now.body.key })).status, 200);
});

test('scopes: a key can only do what its scopes allow', async () => {
  const ro = await newKey(sessionA, { scopes: ['orders:read'] });
  const r = await call('POST', '/orders', { key: ro.key, body: ORDER(1) });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'insufficient_scope');
  assert.equal((await call('GET', '/routes', { key: ro.key })).status, 403);
  assert.equal((await call('GET', '/webhooks', { key: ro.key })).status, 403);
  assert.equal((await call('GET', '/orders', { key: ro.key })).status, 200);
  const bad = await call('POST', '/admin/keys', { session: sessionA, body: { name: 'x', scopes: ['admin:all'] } });
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'invalid_scopes');
  const own = await call('POST', '/admin/keys', { session: sessionA, body: { name: 'x', own_orders_only: true, scopes: ['routes:read'] } });
  assert.equal(own.status, 422, 'a key limited to its own orders cannot read routes');
});

test('key management needs a company session: an API key cannot list, create or revoke keys', async () => {
  const k = await newKey(sessionA);
  for (const [m, p] of [['GET', '/admin/keys'], ['POST', '/admin/keys'], ['POST', `/admin/keys/${k.id}/revoke`]]) {
    const r = await call(m, p, { key: k.key, body: m === 'POST' ? { name: 'x' } : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const bad = await call('GET', '/admin/keys', { session: 'not-a-session' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'invalid_session');
  const other = await call('POST', `/admin/keys/${k.id}/revoke`, { session: t.sessionB });
  assert.equal(other.status, 404, "another company cannot revoke this company's key");
  assert.equal((await call('GET', '/orders', { key: k.key })).status, 200);
});

test('only the service role can call the gateway; the public key still reaches exactly the nine tp_* entry points', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(rpc(db, 'tp_svc_api', { p_action: 'request', p_args: {} }, role), /permission denied/);
    await db.exec(`set role ${role}`);
    try { await assert.rejects(db.query('select * from tp_api.keys'), /permission denied/); } finally { await db.exec('reset role'); }
  }
  const fns = async (role) => (await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege($1, p.oid, 'EXECUTE') order by 1`, [role])).rows.map((r) => r.proname);
  assert.deepEqual(await fns('anon'), ['tp_customer', 'tp_driver', 'tp_driver_sign_in', 'tp_driver_signup', 'tp_org', 'tp_org_lookup',
    'tp_org_sign_in', 'tp_sign_out', 'tp_track']);
  assert.ok((await fns('service_role')).includes('tp_svc_api'));
});

test('unknown paths, wrong methods, bad ids and unknown query parameters', async () => {
  const k = await newKey(sessionA);
  assert.equal((await call('GET', '/nothing', { key: k.key })).status, 404);
  assert.equal((await call('PUT', '/orders', { key: k.key })).status, 405);
  assert.equal((await call('GET', '/orders/%3Cscript%3E', { key: k.key })).status, 404);
  const q = await call('GET', '/orders?sort=desc', { key: k.key });
  assert.equal(q.status, 400); assert.equal(q.body.error.code, 'invalid_parameter');
  assert.equal((await call('GET', '/orders?limit=abc', { key: k.key })).status, 400);
  assert.equal((await call('GET', '/orders?created_after=yesterday', { key: k.key })).status, 400);
  assert.equal((await call('GET', '/orders?cursor=%%%', { key: k.key })).status, 400);
  const h = await call('GET', '/health');
  assert.equal(h.status, 200); assert.equal(h.body.api_version, 'v1');
});

test('rate limit: over the per-minute limit is 429 with Retry-After; headers show the remaining budget', async () => {
  const k = await newKey(sessionA, { rate_per_minute: 3 });
  const a = await call('GET', '/orders', { key: k.key });
  assert.equal(a.headers['X-RateLimit-Limit'], '3');
  assert.equal(a.headers['X-RateLimit-Remaining'], '2');
  await call('GET', '/orders', { key: k.key });
  await call('GET', '/orders', { key: k.key });
  const r = await call('GET', '/orders', { key: k.key });
  assert.equal(r.status, 429); assert.equal(r.body.error.code, 'rate_limited'); assert.equal(r.headers['Retry-After'], '60');
  const other = await newKey(sessionA);
  assert.equal((await call('GET', '/orders', { key: other.key })).status, 200, 'limits are per key');
});

test('every request is audited (who, what, result) without bodies or secrets', async () => {
  const k = await newKey(sessionA);
  await call('POST', '/orders', { key: k.key, body: ORDER(77, { recipient_phone: '4045559876' }) });
  const rows = (await db.query(`select * from tp_api.audit where key_prefix = $1 order by id`, [k.key.split('_')[2]])).rows;
  assert.equal(rows.at(-1).op, 'orders.create'); assert.equal(rows.at(-1).status, 201);
  assert.ok(!JSON.stringify(rows).includes('4045559876'), 'no personal data from the body');
});
