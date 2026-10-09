// Migration 50: the SmartSort publication gate (public.publish_surge_route,
// the production version read 2026-10-09, kept byte for byte in
// 50_publish_gate_statuses.rollback.sql) counted a route that finished as
// 'completed_with_exceptions' as still live, so its packages could never be
// routed again. Runs the real gate in PGlite with migrations 10 and 20 on top,
// as production is after the security release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, ORG_A } from './fixture.mjs';

const RB = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION'), RB.lastIndexOf('$function$;') + '$function$;'.length);
const M50 = sqlFile('50_publish_gate_statuses.sql');
const R50 = sqlFile('50_publish_gate_statuses.rollback.sql');

async function db() {
  const d = await freshDb();
  await d.exec('drop function public.publish_surge_route(jsonb);');
  await d.exec(PROD);
  await d.exec(sqlFile('10_sessions_and_rpcs.sql'));
  await d.exec(sqlFile('20_lockdown.sql'));
  return d;
}
const piece = (tn, oid) => ({ order_id: oid, tracking_number: tn, piece_id: tn, required_count: 1 });
const plan = (code, tns) => ({ title: 'Surge Route RT-001', job_type: 'surge', master_code: code, org_id: ORG_A,
  total_stops: 1, total_packages: tns.length,
  surge_stops: [{ address: '260 Manning Rd SW Unit 37', pkgs: tns.map((t, i) => piece(t, String(100231 + i))) }] });
async function oldRoute(d, status, tns) {
  const r = await rpc(d, 'publish_surge_route', { payload: plan('TP-ROUTE-OLD' + status.toUpperCase().slice(0, 6), tns) }, 'service_role');
  assert.equal(r.ok, true);
  await d.query('update public.jobs set status = $1, archived = true where id = $2', [status, r.job.id]);
  return r.job.id;
}
const publish = (d, code, tns) => rpc(d, 'publish_surge_route', { payload: plan(code, tns) }, 'service_role');
const def = async (d) => (await d.query(`select pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure) d`)).rows[0].d;
const acl = async (d) => (await d.query(`select proacl::text a, prosecdef s, proconfig::text c from pg_proc where oid = 'public.publish_surge_route(jsonb)'::regprocedure`)).rows[0];
const TNS = ['720431958206', '720431958213'];

test('production gate: packages of a completed_with_exceptions route are refused forever (the bug)', async () => {
  const d = await db();
  const old = await oldRoute(d, 'completed_with_exceptions', TNS);
  const r = await publish(d, 'TP-ROUTE-NEW001', TNS);
  assert.equal(r.ok, false);
  assert.equal(r.error, `piece_id 720431958206 is already committed to live job ${old}`);
});

test('migration 50: a finished-with-problems route no longer blocks; live routes still do', async () => {
  const d = await db();
  const before = await acl(d);
  await oldRoute(d, 'completed_with_exceptions', TNS);
  await d.exec(M50);
  assert.deepEqual(await acl(d), before, 'owner rights, search_path and grants unchanged');
  const r = await publish(d, 'TP-ROUTE-NEW001', TNS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.status, 'pending');
  // the new route is live: the same packages are refused for a third route
  const again = await publish(d, 'TP-ROUTE-NEW002', TNS);
  assert.equal(again.ok, false);
  assert.match(again.error, new RegExp('already committed to live job ' + r.job.id));
  for (const status of ['assigned', 'in_transit', 'routing', 'pending']) {
    const e = await db(); await e.exec(M50);
    await oldRoute(e, status, ['999']);
    assert.equal((await publish(e, 'TP-ROUTE-X', ['999'])).ok, false, status + ' is still live');
  }
  for (const status of ['delivered', 'cancelled', 'completed_with_exceptions']) {
    const e = await db(); await e.exec(M50);
    await oldRoute(e, status, ['999']);
    assert.equal((await publish(e, 'TP-ROUTE-X', ['999'])).ok, true, status + ' is finished');
  }
});

test('migration 50 through the dispatcher session (tp_org publish_route), as the page calls it', async () => {
  const d = await db();
  await oldRoute(d, 'completed_with_exceptions', TNS);
  const token = (await rpc(d, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const call = () => rpc(d, 'tp_org', { p_token: token, p_action: 'publish_route', p_args: { payload: plan('TP-ROUTE-NEW001', TNS) } });
  assert.equal((await call()).ok, false);
  await d.exec(M50);
  assert.equal((await call()).ok, true);
  assert.equal((await call()).idempotent, true, 'retrying the same master code returns the same row');
});

test('migration 50 refuses to run twice or on a different version; the rollback restores production exactly', async () => {
  const d = await db();
  const prod = await def(d), prodAcl = await acl(d);
  await d.exec(M50);
  await assert.rejects(d.exec(M50), /already applied/); await d.exec('rollback');
  await d.exec(R50);
  assert.equal(await def(d), prod, 'byte-for-byte the production definition');
  assert.deepEqual(await acl(d), prodAcl);
  await assert.rejects(d.exec(R50), /not in place/); await d.exec('rollback');
  const other = await freshDb();   // the fixture's stand-in gate, not the production one
  await assert.rejects(other.exec(M50), /not the version/); await other.exec('rollback');
});
