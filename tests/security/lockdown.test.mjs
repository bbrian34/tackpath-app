// Migration 20 (Stage A lockdown) and both rollbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, rpc, as, sqlFile, ORG_A } from './fixture.mjs';

const TABLES = ['organizations', 'drivers', 'jobs', 'messages', 'driver_locations', 'driver_fcm_tokens',
  'agent_memory', 'shopify_connections', 'bin_bindings', 'events', 'invoices', 'work_items'];

const denied = async (db, role, sql) => {
  try { await as(db, role, sql); return false; } catch (e) { return /permission denied|row-level security/.test(e.message) ? true : e.message; }
};

// Production snapshot (00_production_snapshot.sql) without volatile fields.
async function snapshot(db) {
  const rows = (await db.query(sqlFile('00_production_snapshot.sql'))).rows;
  return rows.filter((r) => !r.object.startsWith('tp_sec') && r.section !== '12_migrations')
    .map((r) => {
      const d = r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? { ...r.detail } : r.detail;
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        delete d.est_rows;
        // a function's implicit default ACL (NULL = PUBLIC may execute) comes back as the
        // equivalent explicit grant; compare who may execute (exec_anon/exec_authenticated)
        if (r.section === '6_function') delete d.acl;
      }
      return r.section + ' | ' + r.object + ' | ' + JSON.stringify(d);
    });
}

test('after the lockdown the public key cannot read, add, change or delete anything in any table', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  // today: everything is open
  assert.equal((await as(db, 'anon', 'select count(*)::int n from public.organizations')).rows[0].n, 3);
  assert.match((await as(db, 'anon', 'select access_code from public.organizations where slug = $1', ['quickhaul'])).rows[0].access_code, /qh-portal/);
  await db.exec(sqlFile('20_lockdown.sql'));
  for (const role of ['anon', 'authenticated']) {
    for (const t of TABLES) {
      const col = (await db.query(`select attname from pg_attribute where attrelid = 'public.${t}'::regclass and attnum = 1`)).rows[0].attname;
      assert.equal(await denied(db, role, `select * from public.${t} limit 1`), true, `${role} SELECT ${t}`);
      assert.equal(await denied(db, role, `delete from public.${t}`), true, `${role} DELETE ${t}`);
      assert.equal(await denied(db, role, `update public.${t} set "${col}" = "${col}"`), true, `${role} UPDATE ${t}`);
    }
    assert.equal(await denied(db, role, `insert into public.jobs (title) values ('x')`), true);
    assert.equal(await denied(db, role, `insert into public.messages (body) values ('x')`), true);
    assert.equal(await denied(db, role, `select * from public.bin_shortfall`), true, 'views too');
    assert.equal(await denied(db, role, `select public.publish_surge_route('{}'::jsonb)`), true, 'publish gate only via tp_org');
    assert.equal(await denied(db, role, `select public.increment_address_failures('x')`), true);
  }
  // no permissive policy left on public tables (the restrictive ones stay); RLS on everywhere
  assert.deepEqual((await db.query(`select policyname, permissive from pg_policies where schemaname = 'public' order by 1`)).rows,
    [{ policyname: 'protect_operational_memory', permissive: 'RESTRICTIVE' },
     { policyname: 'protect_scoped_drivers', permissive: 'RESTRICTIVE' }]);
  assert.equal((await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows[0].n, 0);
  // tables created later are not handed to the public key
  await db.exec('create table public.later_table (id int); create function public.later_fn() returns int language sql as $$ select 1 $$;');
  assert.equal(await denied(db, 'anon', 'select * from public.later_table'), true);
  assert.equal(await denied(db, 'anon', 'select public.later_fn()'), true);
});

test('proof-of-delivery bucket becomes private; other buckets are untouched', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  const b = (await db.query(`select id, public from storage.buckets order by id`)).rows;
  assert.deepEqual(b, [{ id: 'avatars', public: true }, { id: 'pod', public: false }]);
  const pol = (await db.query(`select policyname from pg_policies where schemaname = 'storage' order by 1`)).rows.map((r) => r.policyname);
  assert.deepEqual(pol, ['avatars read'], 'anon upload/update/read policies for pod removed');
});

test('every flow still works through the RPCs after the lockdown', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  const jid = (await db.query(`insert into public.jobs (org_id, title, status) values ($1, 'R', 'pending') returning id`, [ORG_A])).rows[0].id;
  const org = await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' });
  assert.equal(org.ok, true);
  const t = org.token;
  assert.equal((await rpc(db, 'tp_org_lookup', { p_slug: 'quickhaul' })).name, 'Quick Haul');
  assert.ok((await rpc(db, 'tp_org', { p_token: t, p_action: 'jobs' })).length >= 1);
  await rpc(db, 'tp_org', { p_token: t, p_action: 'post_message', p_args: { job_id: jid, body: 'hi' } });
  const pub = await rpc(db, 'tp_org', { p_token: t, p_action: 'publish_route', p_args: { payload: { title: 'S', master_code: 'M9', surge_stops: [] } } });
  assert.equal(pub.ok, true, 'publish_surge_route still reachable through tp_org');
  const code = await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role');
  const drv = await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: code.code });
  assert.equal(drv.ok, true);
  assert.equal((await rpc(db, 'tp_driver', { p_token: drv.token, p_action: 'claim', p_args: { id: jid } })).length, 1);
  await rpc(db, 'tp_driver', { p_token: drv.token, p_action: 'location', p_args: { job_id: jid, lat: 1, lng: 2 } });
  await rpc(db, 'tp_driver', { p_token: drv.token, p_action: 'fcm_token', p_args: { token: 'f' } });
  const order = await rpc(db, 'tp_customer', { p_action: 'create_order', p_args: { title: 'Order', org_slug: 'quickhaul' } });
  assert.ok(order.order_token);
  assert.equal((await rpc(db, 'tp_track', { p_action: 'job', p_args: { id: order.job.id } })).status, 'routing');
  assert.equal((await rpc(db, 'tp_driver_signup', { p_args: { name: 'X Y', phone: '4705550001' } })).ok, true);
  const sms = await rpc(db, 'tp_svc_assignment_sms', { p_token: t, p_job_id: jid }, 'service_role');
  assert.equal(sms.send, true);
});

test('rollback of 20 restores grants, policies, RLS flags, bucket and defaults exactly; rollback of 10 removes the rest', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  const before = await snapshot(db);
  await db.exec(sqlFile('20_lockdown.sql'));
  const locked = await snapshot(db);
  assert.notDeepEqual(locked, before);
  await db.exec(sqlFile('20_lockdown.rollback.sql'));
  const after = await snapshot(db);
  assert.deepEqual(after.filter((x) => !before.includes(x)), [], 'nothing new after rollback');
  assert.deepEqual(before.filter((x) => !after.includes(x)), [], 'nothing missing after rollback');
  // the anon key works again exactly as before
  assert.equal((await as(db, 'anon', 'select count(*)::int n from public.jobs')).rows[0].n, 0);
  await as(db, 'anon', `insert into public.messages (body) values ('back')`);
  // a future table is again auto-granted, as before
  await db.exec('create table public.after_rb (id int)');
  await as(db, 'anon', 'select * from public.after_rb');
  await db.exec('drop table public.after_rb');

  // 10's rollback refuses while 20 is applied, then removes everything it added
  const db2 = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  await assert.rejects(db2.exec(sqlFile('10_sessions_and_rpcs.rollback.sql')), /Roll back migration 20 first/);
  await db2.exec('rollback');
  const pristine = await freshDb();
  const original = await snapshot(pristine);
  await db.exec(sqlFile('10_sessions_and_rpcs.rollback.sql'));
  const fully = await snapshot(db);
  assert.deepEqual(fully.filter((x) => !original.includes(x)), [], 'nothing left behind');
  assert.deepEqual(original.filter((x) => !fully.includes(x)), [], 'production exactly as before');
});

test('migration 20 refuses to run twice or before 10', async () => {
  const db = await freshDb();
  await assert.rejects(db.exec(sqlFile('20_lockdown.sql')), /Apply 10_sessions_and_rpcs.sql first/);
  await db.exec('rollback');
  await db.exec(sqlFile('10_sessions_and_rpcs.sql'));
  await db.exec(sqlFile('20_lockdown.sql'));
  await assert.rejects(db.exec(sqlFile('20_lockdown.sql')), /already applied/);
  await db.exec('rollback');
});

// Public functions anon could execute in production on 2026-10-07 (besides tp_*).
const TODAY_ANON_FUNCTIONS = ['publish_surge_route', 'ops_command', 'ops_state', 'ops_revoke_session',
  'increment_address_failures', 'materialize_package_state', 'rls_auto_enable', 'touch_updated_at',
  'events_block_mutation'];
const ENTRY_POINTS = ['tp_customer(text,jsonb)', 'tp_driver(text,text,jsonb)', 'tp_driver_sign_in(text,text)',
  'tp_driver_signup(jsonb)', 'tp_org(text,text,jsonb)', 'tp_org_lookup(text)', 'tp_org_sign_in(text,text)',
  'tp_sign_out(text)', 'tp_track(text,jsonb)'];
const anonExec = async (db, role = 'anon') => (await db.query(`select replace(p.oid::regprocedure::text, 'public.', '') as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('${role}', p.oid, 'EXECUTE') order by 1`)).rows.map((r) => r.f);
const execBy = async (db, name, role) => (await db.query(`select bool_and(has_function_privilege('${role}', p.oid, 'EXECUTE')) b
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name])).rows[0].b;

test('migration 20 closes every function anon can execute today; only the nine tp_* entry points remain; rollback reopens them', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  // procedures and aggregates are covered too
  await db.exec(`create procedure public.some_proc() language sql as $$ select 1 $$;
    create aggregate public.some_agg(int) (sfunc = int4pl, stype = int);`);
  const others = ['some_proc', 'some_agg'];
  for (const f of [...TODAY_ANON_FUNCTIONS, ...others]) {
    assert.equal(await execBy(db, f, 'anon'), true, `${f} executable by anon today`);
  }
  await db.exec(sqlFile('20_lockdown.sql'));
  for (const f of TODAY_ANON_FUNCTIONS) {
    for (const role of ['anon', 'authenticated']) assert.equal(await execBy(db, f, role), false, `${role} ${f} after 20`);
    assert.equal(await execBy(db, f, 'service_role'), true, `service_role keeps ${f}`);
  }
  assert.deepEqual(await anonExec(db, 'anon'), ENTRY_POINTS, 'final anon-executable functions');
  assert.deepEqual(await anonExec(db, 'authenticated'), ENTRY_POINTS);
  // trigger functions still fire for a writer that has no EXECUTE on them
  await db.exec(`insert into public.events (event_type) values ('t');
    create role probe nologin bypassrls; grant usage on schema public to probe; grant update on public.events to probe;`);
  assert.equal(await execBy(db, 'events_block_mutation', 'probe'), false);
  await assert.rejects(as(db, 'probe', `update public.events set actor = 'x'`), /append-only/);
  for (const f of others) assert.equal(await execBy(db, f, 'anon'), false, `${f} after 20`);
  await db.exec(sqlFile('20_lockdown.rollback.sql'));
  for (const f of [...TODAY_ANON_FUNCTIONS, ...others]) {
    for (const role of ['anon', 'authenticated']) assert.equal(await execBy(db, f, role), true, `${role} ${f} after rollback`);
  }
});

test('migration 20 stops, changing nothing, if another public function would stay executable by anon', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  await db.exec(`create role helper nologin; grant helper to anon;
    create function public.sneaky() returns int language sql as $$ select 1 $$;
    revoke all on function public.sneaky() from public, anon, authenticated; grant execute on function public.sneaky() to helper;`);
  await assert.rejects(db.exec(sqlFile('20_lockdown.sql')), /still executable by anon\/authenticated: sneaky\(\)/);
  await db.exec('rollback');
  assert.equal((await db.query(`select to_regclass('tp_sec.lockdown_backup') t`)).rows[0].t, null);
  assert.equal(await execBy(db, 'ops_state', 'anon'), true, 'nothing was revoked');
});

test('restrictive policies protect_scoped_drivers and protect_operational_memory are untouched by 20 and its rollback', async () => {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  const pols = async () => (await db.query(`select p.oid::int as oid, p.polname, c.relname, p.polpermissive, p.polcmd,
      p.polroles::regrole[]::text as roles, pg_get_expr(p.polqual, p.polrelid) as q, pg_get_expr(p.polwithcheck, p.polrelid) as wc
    from pg_policy p join pg_class c on c.oid = p.polrelid where not p.polpermissive order by p.polname`)).rows;
  const before = await pols();
  assert.deepEqual(before.map((r) => [r.polname, r.relname, r.polcmd, r.roles, r.q, r.wc]), [
    ['protect_operational_memory', 'agent_memory', '*', '{anon,authenticated}', '(org_id IS NULL)', '(org_id IS NULL)'],
    ['protect_scoped_drivers', 'drivers', '*', '{anon,authenticated}', '(org_id IS NULL)', '(org_id IS NULL)']]);
  await db.exec(sqlFile('20_lockdown.sql'));
  assert.deepEqual(await pols(), before, 'same objects (same oid), same definition after 20');
  await db.exec(sqlFile('20_lockdown.rollback.sql'));
  assert.deepEqual(await pols(), before, 'same objects (same oid), same definition after the rollback');
  // a restrictive policy added after the lockdown is removed by the rollback like any other new policy
  await db.exec(sqlFile('20_lockdown.sql'));
  await db.exec(`create policy later_restrictive on public.jobs as restrictive for select to anon using (false)`);
  await db.exec(sqlFile('20_lockdown.rollback.sql'));
  assert.deepEqual(await pols(), before);
});
