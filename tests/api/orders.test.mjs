// API v1: order intake (single and batch), validation, idempotency, listing,
// and tenant isolation between companies and between client keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORDER, ORG_A } from './harness.mjs';

const t = await setup();
const { call, sessionA, sessionB, newKey, db } = t;
const keyA = (await newKey(sessionA)).key;
const keyB = (await newKey(sessionB)).key;

test('an order becomes a pending job on the company board (the existing intake path), and the dispatcher sees it', async () => {
  const r = await call('POST', '/orders', { key: keyA, body: ORDER(1, { packages: 2, unit: 'Apt 4', delivery_notes: 'Leave at side door',
    tracking_number: 'qh-0001-a', metadata: { erp: 'X-77' } }) });
  assert.equal(r.status, 201);
  assert.match(r.body.id, /^ord_[0-9a-f]{32}$/);
  assert.equal(r.body.status, 'received');
  assert.equal(r.body.tracking_number, 'QH-0001-A');
  assert.equal(r.body.route.status, 'unassigned');
  assert.deepEqual(r.body.details, { unit: 'Apt 4', delivery_notes: 'Leave at side door', metadata: { erp: 'X-77' } });
  const board = await t.org(sessionA)('jobs');
  const job = board.find((j) => j.source === 'api' && /SO-1001/.test(j.title));
  assert.ok(job, 'on the dispatcher board');
  assert.equal(job.status, 'pending'); assert.equal(job.org_id, ORG_A);
  assert.equal(job.dropoff_address, '214 Maple Grove Ln, Marietta, GA 30064'); assert.equal(job.total_packages, 2);
  assert.match(job.route_summary, /Avery Collins · 2 packages · Tracking QH-0001-A · Apt 4 · Leave at side door/);
});

test('validation: each bad field is a 422 with its own code; nothing is created', async () => {
  const before = (await db.query('select count(*)::int n from public.jobs')).rows[0].n;
  const cases = [
    [{ external_id: '' }, 'invalid_external_id'], [{ external_id: 'has space' }, 'invalid_external_id'],
    [{ recipient_name: '' }, 'invalid_recipient'], [{ address: 'x' }, 'invalid_address'],
    [{ packages: 0 }, 'invalid_packages'], [{ packages: 1000 }, 'invalid_packages'], [{ packages: 'two' }, 'invalid_packages'],
    [{ tracking_number: 'ab' }, 'invalid_tracking_number'], [{ tracking_number: 'has space here' }, 'invalid_tracking_number'],
  ];
  for (const [patch, code] of cases) {
    const r = await call('POST', '/orders', { key: keyA, body: ORDER(2, patch) });
    assert.equal(r.status, 422, JSON.stringify(patch)); assert.equal(r.body.error.code, code);
  }
  assert.equal((await db.query('select count(*)::int n from public.jobs')).rows[0].n, before);
});

test('malformed requests: not JSON, not an object, wrong content type, over 1 MB', async () => {
  let r = await call('POST', '/orders', { key: keyA, raw: '{"external_id":', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'invalid_json');
  r = await call('POST', '/orders', { key: keyA, raw: '[1,2]', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/orders', { key: keyA, raw: 'external_id=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  r = await call('POST', '/orders', { key: keyA, raw: JSON.stringify({ x: 'y'.repeat(1_000_100) }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 413); assert.equal(r.body.error.code, 'payload_too_large');
});

test('duplicates: the same external_id is refused with the existing order id; the same tracking number too', async () => {
  const a = await call('POST', '/orders', { key: keyA, body: ORDER(3) });
  const b = await call('POST', '/orders', { key: keyA, body: ORDER(3) });
  assert.equal(b.status, 409); assert.equal(b.body.error.code, 'duplicate_order'); assert.equal(b.body.error.order_id, a.body.id);
  const c = await call('POST', '/orders', { key: keyA, body: ORDER(4, { tracking_number: a.body.tracking_number }) });
  assert.equal(c.status, 409); assert.equal(c.body.error.code, 'duplicate_tracking_number');
  const other = await call('POST', '/orders', { key: keyB, body: ORDER(3) });
  assert.equal(other.status, 201, 'another company may use the same external_id');
});

test('idempotency: a retried request returns the first response; reusing the key for another request is 409', async () => {
  const body = ORDER(5);
  const a = await call('POST', '/orders', { key: keyA, body, headers: { 'idempotency-key': 'retry-5' } });
  const b = await call('POST', '/orders', { key: keyA, body, headers: { 'idempotency-key': 'retry-5' } });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.deepEqual(b.body, a.body); assert.equal(b.headers['Idempotent-Replayed'], 'true');
  assert.equal((await db.query(`select count(*)::int n from tp_api.orders where external_id = 'SO-1005'`)).rows[0].n, 1);
  const c = await call('POST', '/orders', { key: keyA, body: ORDER(6), headers: { 'idempotency-key': 'retry-5' } });
  assert.equal(c.status, 409); assert.equal(c.body.error.code, 'idempotency_conflict');
});

test('batch manifest: created, duplicate and rejected per line; the batch can be read back', async () => {
  const r = await call('POST', '/orders/batch', { key: keyA, headers: { 'idempotency-key': 'manifest-0930' },
    body: { orders: [ORDER(10), ORDER(11, { packages: 3 }), ORDER(3), ORDER(12, { address: '' }), 'not an order'] } });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^bat_/);
  assert.deepEqual([r.body.received, r.body.created, r.body.duplicates, r.body.rejected], [5, 2, 1, 2]);
  assert.deepEqual(r.body.results.map((x) => x.result), ['created', 'created', 'duplicate', 'rejected', 'rejected']);
  assert.equal(r.body.results[3].error.code, 'invalid_address');
  const again = await call('POST', '/orders/batch', { key: keyA, headers: { 'idempotency-key': 'manifest-0930' },
    body: { orders: [ORDER(10), ORDER(11, { packages: 3 }), ORDER(3), ORDER(12, { address: '' }), 'not an order'] } });
  assert.deepEqual(again.body, r.body, 'a retried batch creates nothing new');
  const g = await call('GET', `/batches/${r.body.id}`, { key: keyA });
  assert.equal(g.status, 200); assert.equal(g.body.created, 2);
  assert.equal((await call('GET', `/batches/${r.body.id}`, { key: keyB })).status, 404);
  const o = await call('GET', `/orders/${r.body.results[1].order_id}`, { key: keyA });
  assert.equal(o.body.packages, 3); assert.equal(o.body.batch_id, r.body.id);
  for (const n of [0, 501]) {
    const bad = await call('POST', '/orders/batch', { key: keyA, body: { orders: Array.from({ length: n }, (_, i) => ORDER(2000 + i)) } });
    assert.equal(bad.status, 422, `${n} orders`);
  }
});

test('reading orders: by id or external_id, filters, cursor pagination', async () => {
  for (let i = 20; i < 25; i++) await call('POST', '/orders', { key: keyA, body: ORDER(i) });
  const byExt = await call('GET', '/orders/SO-1020', { key: keyA });
  assert.equal(byExt.status, 200); assert.equal(byExt.body.external_id, 'SO-1020');
  const f = await call('GET', '/orders?external_id=SO-1021', { key: keyA });
  assert.deepEqual(f.body.data.map((o) => o.external_id), ['SO-1021']);
  const seen = new Set(); let cursor = ''; let pages = 0;
  do {
    const p = await call('GET', `/orders?limit=3${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { key: keyA });
    assert.equal(p.status, 200);
    p.body.data.forEach((o) => { assert.ok(!seen.has(o.id), 'no order twice'); seen.add(o.id); });
    cursor = p.body.next_cursor; pages++;
    assert.equal(p.body.has_more, Boolean(cursor));
  } while (cursor && pages < 20);
  const total = (await db.query(`select count(*)::int n from tp_api.orders where org_key = $1`, [ORG_A])).rows[0].n;
  assert.equal(seen.size, total, 'every order exactly once');
  const st = await call('GET', '/orders?status=received&limit=200', { key: keyA });
  assert.ok(st.body.data.length > 0 && st.body.data.every((o) => o.status === 'received'));
  assert.equal((await call('GET', '/orders?status=lost', { key: keyA })).status, 400);
});

test('tenant isolation: another company never sees, finds or counts these orders', async () => {
  const mine = await call('POST', '/orders', { key: keyA, body: ORDER(40, { tracking_number: 'ISO-40-ABC' }) });
  for (const p of [`/orders/${mine.body.id}`, '/orders/SO-1040', `/orders/${mine.body.id}/events`, `/orders/${mine.body.id}/proof-of-delivery`,
                   '/tracking/ISO-40-ABC', `/routes/${mine.body.route.id}`]) {
    const r = await call('GET', p, { key: keyB });
    assert.equal(r.status, 404, p);
  }
  const listB = await call('GET', '/orders?limit=200', { key: keyB });
  assert.ok(listB.body.data.every((o) => o.external_id !== 'SO-1040'));
  const routesB = await call('GET', '/routes?limit=200', { key: keyB });
  assert.ok(routesB.body.data.every((r) => r.id !== mine.body.route.id));
});

test('client keys (own_orders_only): two shippers of one courier only see their own orders', async () => {
  const s1 = (await newKey(sessionA, { own_orders_only: true, client_label: 'shipper-1', scopes: ['orders:write', 'orders:read', 'tracking:read', 'pod:read'] })).key;
  const s2 = (await newKey(sessionA, { own_orders_only: true, client_label: 'shipper-2', scopes: ['orders:write', 'orders:read', 'tracking:read'] })).key;
  const s1b = (await newKey(sessionA, { own_orders_only: true, client_label: 'shipper-1', scopes: ['orders:read'] })).key;
  const o1 = await call('POST', '/orders', { key: s1, body: ORDER(50) });
  const o2 = await call('POST', '/orders', { key: s2, body: ORDER(51) });
  assert.equal((await call('GET', `/orders/${o2.body.id}`, { key: s1 })).status, 404);
  assert.equal((await call('GET', `/orders/${o1.body.id}`, { key: s2 })).status, 404);
  assert.equal((await call('GET', `/orders/${o1.body.id}`, { key: s1b })).status, 200, 'same client label shares orders');
  const l1 = await call('GET', '/orders?limit=200', { key: s1 });
  assert.deepEqual(l1.body.data.map((o) => o.external_id), ['SO-1050']);
  assert.equal((await call('GET', `/orders/${o1.body.id}`, { key: keyA })).status, 200, 'the company key sees all orders');
  assert.equal((await call('GET', '/routes', { key: s1 })).status, 403);
});
