// Migration 62: the SmartSort publication gate (public.publish_surge_route)
// no longer counts an archived route as live, and only looks at the
// publishing company's jobs (live-package check and master_code retry).
// Archiving a route also frees its BIN, LOC and STG (PathIQ, 60/61).
// The real gate: the production version (50's rollback) with 10, 20, 50, 60
// and 61 on top, in PGlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const M62 = sqlFile('62_gate_ignore_archived.sql');
const R62 = sqlFile('62_gate_ignore_archived.rollback.sql');

async function db({ m62 = true } = {}) {
  const d = await freshDb();
  await d.exec('drop function public.publish_surge_route(jsonb);');
  await d.exec(PROD);
  for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql',
    '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql']) await d.exec(sqlFile(f));
  if (m62) await d.exec(M62);
  return d;
}
const piece = (tn, oid) => ({ order_id: oid, tracking_number: tn, piece_id: tn, required_count: 1 });
const plan = (code, tns, org = ORG_A) => ({ title: 'Surge Route RT-001', job_type: 'surge', master_code: code, org_id: org,
  total_stops: 1, total_packages: tns.length,
  surge_stops: [{ address: '260 Manning Rd SW Unit 37', pkgs: tns.map((t, i) => piece(t, String(100231 + i))) }] });
const publish = (d, code, tns, org = ORG_A) => rpc(d, 'publish_surge_route', { payload: plan(code, tns, org) }, 'service_role');
let seq = 0;
async function route(d, { status = 'pending', archived = false, org = ORG_A, tns = ['999'] } = {}) {
  const r = await publish(d, 'TP-ROUTE-OLD' + (++seq), tns, org);
  assert.equal(r.ok, true, JSON.stringify(r));
  await d.query('update public.jobs set status = $1, archived = $2 where id = $3', [status, archived, r.job.id]);
  return r.job.id;
}
const def = async (d) => (await d.query(`select pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure) d`)).rows[0].d;
const acl = async (d) => (await d.query(`select proowner, proacl::text a, prosecdef s, proconfig::text c from pg_proc where oid = 'public.publish_surge_route(jsonb)'::regprocedure`)).rows[0];
const signIn = async (d) => (await rpc(d, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;

test('before 62: an archived pending route blocks its packages forever (the bug)', async () => {
  const d = await db({ m62: false });
  const old = await route(d, { status: 'pending', archived: true });
  const r = await publish(d, 'TP-ROUTE-NEW', ['999']);
  assert.equal(r.ok, false);
  assert.equal(r.error, `piece_id 999 is already committed to live job ${old}`);
});

test('62: an archived route no longer blocks, whatever its status; unarchived assigned / in_transit / routing / pending still do', async () => {
  for (const status of ['pending', 'assigned', 'in_transit', 'routing']) {
    const d = await db();
    await route(d, { status, archived: true });
    const r = await publish(d, 'TP-ROUTE-NEW', ['999']);
    assert.equal(r.ok, true, `archived ${status}: ${JSON.stringify(r)}`);
    // the new route is live and unarchived: it blocks a third plan
    const again = await publish(d, 'TP-ROUTE-NEW2', ['999']);
    assert.equal(again.error, `piece_id 999 is already committed to live job ${r.job.id}`);
  }
  for (const status of ['pending', 'assigned', 'in_transit', 'routing']) {
    const d = await db();
    const live = await route(d, { status, archived: false });
    const r = await publish(d, 'TP-ROUTE-NEW', ['999']);
    assert.equal(r.ok, false, status + ' (not archived) is still live');
    assert.equal(r.error, `piece_id 999 is already committed to live job ${live}`);
  }
  for (const status of ['delivered', 'cancelled', 'completed_with_exceptions']) {
    const d = await db();
    await route(d, { status, archived: false });
    assert.equal((await publish(d, 'TP-ROUTE-NEW', ['999'])).ok, true, status + ' is finished (50 kept)');
  }
  // archived = null counts as not archived
  const d = await db();
  const live = await route(d);
  await d.query('update public.jobs set archived = null where id = $1', [live]);
  assert.equal((await publish(d, 'TP-ROUTE-NEW', ['999'])).ok, false);
});

test('62: the archived job from 2026-10-09 through Clear board and the dispatcher session (tp_org)', async () => {
  const d = await db();
  const token = await signIn(d);
  const O = (action, args) => rpc(d, 'tp_org', { p_token: token, p_action: action, p_args: args });
  const old = await route(d, { status: 'pending', tns: ['720431958206', '720431958213'] });
  const call = (code) => O('publish_route', { payload: plan(code, ['720431958206', '720431958213']) });
  assert.match((await call('TP-ROUTE-NEW')).error, new RegExp('live job ' + old), 'on the board: blocks');
  assert.equal((await O('archive_jobs', { ids: [old] })).archived, 1);        // Clear board
  const r = await call('TP-ROUTE-NEW');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.org_id, ORG_A);
  assert.equal((await call('TP-ROUTE-NEW')).idempotent, true, 'retry returns the same row');
});

test("62: another company's live route never blocks; the same company's does", async () => {
  const d = await db();
  const theirs = await route(d, { status: 'assigned', org: ORG_B });
  const r = await publish(d, 'TP-ROUTE-NEW', ['999']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.org_id, ORG_A);
  assert.ok(!JSON.stringify(r).includes(theirs), 'nothing about the other company');
  // ORG_A's route now blocks ORG_A, but not ORG_B
  assert.match((await publish(d, 'TP-ROUTE-NEW2', ['999'])).error, new RegExp('live job ' + r.job.id));
  assert.match((await publish(d, 'TP-ROUTE-B2', ['999'], ORG_B)).error, new RegExp('live job ' + theirs));
  // through the dispatcher session the company comes from the session
  const token = await signIn(d);
  const viaPage = await rpc(d, 'tp_org', { p_token: token, p_action: 'publish_route', p_args: { payload: plan('TP-ROUTE-NEW3', ['998'], ORG_B) } });
  assert.equal(viaPage.ok, true);
  assert.equal(viaPage.job.org_id, ORG_A, 'payload org ignored; session company used');
});

test("62: a master_code retry returns only the same company's job", async () => {
  const d = await db();
  const b = await publish(d, 'TP-ROUTE-SAME', ['501'], ORG_B);
  assert.equal(b.ok, true);
  // same code, same company: the existing row (idempotent)
  const again = await publish(d, 'TP-ROUTE-SAME', ['501'], ORG_B);
  assert.equal(again.idempotent, true);
  assert.equal(again.job.id, b.job.id);
  // same code, other company: never the other company's job
  const a = await publish(d, 'TP-ROUTE-SAME', ['601'], ORG_A);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(a.job.org_id, ORG_A);
  assert.equal((await publish(d, 'TP-ROUTE-SAME', ['601'], ORG_A)).job.id, a.job.id);
  // where master codes are unique across companies (unique index), the
  // unique_violation retry also stays in the company: refused, no job returned
  const u = await db();
  await u.exec('create unique index jobs_master_code_key on public.jobs (master_code)');
  const ub = await publish(u, 'TP-ROUTE-UNIQ', ['701'], ORG_B);
  const ua = await publish(u, 'TP-ROUTE-UNIQ', ['702'], ORG_A);
  assert.deepEqual(ua, { ok: false, error: 'master_code TP-ROUTE-UNIQ is already in use' });
  assert.ok(!JSON.stringify(ua).includes(ub.job.id));
  // before 62 the other company's job came back
  const old = await db({ m62: false });
  await old.exec('create unique index jobs_master_code_key on public.jobs (master_code)');
  const ob = await publish(old, 'TP-ROUTE-UNIQ', ['701'], ORG_B);
  assert.equal((await publish(old, 'TP-ROUTE-UNIQ', ['702'], ORG_A)).job.id, ob.job.id, 'the leak 62 closes');
});

test('62: archiving a route frees its BIN, LOC and STG (same transaction, only that route, history kept, repeat-safe)', async () => {
  const d = await db();
  const token = await signIn(d);
  const O = (action, args = {}) => rpc(d, 'tp_org', { p_token: token, p_action: action, p_args: args });
  const staged = async (bin, loc, spot, tn) => {
    const id = await route(d, { status: 'assigned', tns: [tn] });
    await O('open_binding', { id, bin_code: bin, location_code: loc, opened_by: 'Sam' });
    await O('binding_ready', { id });
    assert.equal((await O('stage_binding', { id, staging_code: 'STG:' + spot })).ok, true);
    return id;
  };
  const a = await staged('1A', 'A-07', 'S-01', '801');
  const b = await staged('2A', 'A-08', 'S-02', '802');
  const other = await route(d, { status: 'assigned', org: ORG_B, tns: ['803'] });
  await d.query(`insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, staging_code, staged_at)
                 values ($1,'1A','A-07',$2,'ready','S-01',now())`, [ORG_B, other]);
  const rows = async (jid) => (await d.query(
    `select bin_code, location_code, staging_code, state, released_at is not null as closed from public.bin_bindings where job_id = $1`, [jid])).rows;
  const all = async () => JSON.stringify((await d.query('select * from public.bin_bindings order by job_id, opened_at')).rows);
  const bBefore = JSON.stringify(await rows(b));
  assert.equal((await O('archive_jobs', { ids: [a] })).archived, 1);         // Clear board
  assert.deepEqual(await rows(a), [{ bin_code: '1A', location_code: 'A-07', staging_code: 'S-01', state: 'released', closed: true }]);
  assert.equal(JSON.stringify(await rows(b)), bBefore, 'route B untouched');
  assert.equal((await rows(other))[0].state, 'ready', 'other company untouched');
  // repeat: archiving again changes nothing
  const snap = await all();
  await O('archive_jobs', { ids: [a] });
  await d.query('update public.jobs set archived = true where id = $1', [a]);
  assert.equal(await all(), snap);
  // BIN 1A, LOC A-07 and STG S-01 can be used by the next route
  const c = await staged('1A', 'A-07', 'S-01', '804');
  assert.equal((await rows(c))[0].state, 'ready');
  // a write that fails rolls the release back with it (same transaction)
  const e = await staged('5A', 'A-11', 'S-05', '805');
  await assert.rejects(d.exec(`begin; update public.jobs set archived = true where id = '${e}'; select 1/0;`));
  await d.exec('rollback');
  assert.equal((await rows(e))[0].state, 'ready');
});

test('62 refuses to run twice, without 50 or without 60; the rollback restores 50 exactly', async () => {
  const d = await db({ m62: false });
  const m50 = await def(d), m50Acl = await acl(d);
  await d.exec(M62);
  assert.deepEqual(await acl(d), m50Acl, 'owner, SECURITY DEFINER, search_path and grants unchanged');
  await assert.rejects(d.exec(M62), /already applied/); await d.exec('rollback');
  await d.exec(R62);
  assert.equal(await def(d), m50, "byte-for-byte migration 50's gate");
  assert.deepEqual(await acl(d), m50Acl);
  assert.equal((await d.query(`select count(*)::int n from pg_trigger where tgname = 'tp_release_spots_on_archive'`)).rows[0].n, 0);
  await assert.rejects(d.exec(R62), /not in place/); await d.exec('rollback');
  // old behaviour is back: archived blocks, archive does not free the bin
  const old = await route(d, { status: 'pending', archived: true, tns: ['901'] });
  assert.match((await publish(d, 'TP-ROUTE-NEW', ['901'])).error, new RegExp('live job ' + old));
  const token = await signIn(d);
  const id = await route(d, { status: 'assigned', tns: ['902'] });
  await rpc(d, 'tp_org', { p_token: token, p_action: 'open_binding', p_args: { id, bin_code: '9A', location_code: 'A-19' } });
  await rpc(d, 'tp_org', { p_token: token, p_action: 'archive_jobs', p_args: { ids: [id] } });
  assert.equal((await d.query('select state from public.bin_bindings where job_id = $1', [id])).rows[0].state, 'open');
  await d.exec(M62);                                                   // and 62 applies again
  // the production gate before 50: refused, nothing changed
  const pre50 = await freshDb();
  await pre50.exec('drop function public.publish_surge_route(jsonb);'); await pre50.exec(PROD);
  for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '60_pathiq_staging_reset.sql']) await pre50.exec(sqlFile(f));
  const before = await def(pre50);
  await assert.rejects(pre50.exec(M62), /not the version/); await pre50.exec('rollback');
  assert.equal(await def(pre50), before);
  // 50 but no 60: refused
  const no60 = await freshDb();
  await no60.exec('drop function public.publish_surge_route(jsonb);'); await no60.exec(PROD);
  await no60.exec(sqlFile('50_publish_gate_statuses.sql'));
  await assert.rejects(no60.exec(M62), /Apply 60_pathiq_staging_reset\.sql first/); await no60.exec('rollback');
});
