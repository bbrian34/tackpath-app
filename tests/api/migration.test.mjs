// Migration 69 is additive and reversible, migration 70 schedules the worker,
// and the existing apps behave exactly the same with 69 applied (differential
// run of the dispatcher, PathIQ, driver, customer portal and tracking gateways).
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiDb, orgSession, rpc, sqlFile, ORG_A } from './db.mjs';

test('69 refuses to run twice, the rollback removes everything it added, and 69 applies again', async () => {
  const db = await apiDb();
  await assert.rejects(db.exec(sqlFile('69_public_api.sql')), /already applied/);
  await db.exec('rollback');
  const s = await orgSession(db);
  const k = await rpc(db, 'tp_svc_api', { p_action: 'request', p_args: { session: s, op: 'keys.create', body: { name: 'x' } } }, 'service_role');
  await rpc(db, 'tp_svc_api', { p_action: 'request', p_args: { key: k.body.key, op: 'orders.create',
    body: { external_id: 'R-1', recipient_name: 'A B', address: '1 Main Street, Atlanta' } } }, 'service_role');
  await db.exec(sqlFile('69_public_api.rollback.sql'));
  const left = (await db.query(`select
      (select count(*) from pg_namespace where nspname = 'tp_api')::int as schema,
      (select count(*) from pg_proc where proname = 'tp_svc_api')::int as gateway,
      (select count(*) from pg_trigger where tgname like 'tp_api%')::int as triggers`)).rows[0];
  assert.deepEqual(left, { schema: 0, gateway: 0, triggers: 0 });
  const job = (await db.query(`select status, source from public.jobs where title like 'API order R-1%'`)).rows;
  assert.deepEqual(job, [{ status: 'pending', source: 'api' }], 'the job the API created stays as an ordinary job');
  await assert.rejects(db.exec(sqlFile('69_public_api.rollback.sql')), /not in place/);
  await db.exec('rollback');
  await db.exec(sqlFile('69_public_api.sql'));
  assert.equal((await db.query(`select count(*)::int n from pg_trigger where tgname like 'tp_api%'`)).rows[0].n, 2);
});

test('69 stops, changing nothing, when migration 10 is missing', async () => {
  const { freshDb } = await import('../security/fixture.mjs');
  const db = await freshDb();
  await assert.rejects(db.exec(sqlFile('69_public_api.sql')), /Apply 10_sessions_and_rpcs.sql first/);
  await db.exec('rollback');
  assert.equal((await db.query(`select count(*)::int n from pg_namespace where nspname = 'tp_api'`)).rows[0].n, 0);
});

test('70 schedules api-webhooks-job with the Vault secret read at run time; its rollback removes only that job', async () => {
  const db = await apiDb();
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, jobname text, active boolean default true);
    insert into cron.job (schedule, command, jobname) values ('* * * * *', 'select 1', 'swarm-watch-job');
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as
      $$ insert into cron.job (schedule, command, jobname) values (schedule, command, job_name) returning jobid $$;
    create function cron.unschedule(job_name text) returns boolean language sql as
      $$ with d as (delete from cron.job where jobname = job_name returning 1) select count(*) > 0 from d $$;
    create schema vault;
    create table vault.secrets (name text unique, secret text);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;`);
  await assert.rejects(db.exec(sqlFile('70_api_webhooks_cron.sql')), /tp_cron_secret is missing/);
  await db.exec('rollback');
  await db.exec(`insert into vault.secrets values ('tp_cron_secret', '${'f'.repeat(64)}')`);
  await db.exec(sqlFile('70_api_webhooks_cron.sql'));
  const job = (await db.query(`select * from cron.job where jobname = 'api-webhooks-job'`)).rows[0];
  assert.equal(job.schedule, '* * * * *');
  assert.match(job.command, /functions\/v1\/api-webhooks/);
  assert.match(job.command, /x-tp-cron-secret', \(select decrypted_secret from vault.decrypted_secrets where name = 'tp_cron_secret'\)/);
  assert.ok(!job.command.includes('f'.repeat(64)), 'the secret is not in the command');
  await assert.rejects(db.exec(sqlFile('70_api_webhooks_cron.sql')), /already applied/);
  await db.exec('rollback');
  await db.exec(sqlFile('70_api_webhooks_cron.rollback.sql'));
  assert.deepEqual((await db.query('select jobname from cron.job')).rows, [{ jobname: 'swarm-watch-job' }]);
});

// The same operations through the apps' own gateways, with and without 69.
async function scenario(db) {
  const out = [];
  const log = (label, v) => out.push([label, v]);
  const token = await orgSession(db);
  const O = (a, args = {}) => rpc(db, 'tp_org', { p_token: token, p_action: a, p_args: args });
  const code = (await rpc(db, 'tp_svc_driver_code', { p_phone: '4045551234' }, 'service_role')).code;
  const dtok = (await rpc(db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: code })).token;
  const Dr = (a, args = {}) => rpc(db, 'tp_driver', { p_token: dtok, p_action: a, p_args: args });
  const stops = [{ stop_number: 1, order_id: 'M-1', tracking_number: 'TRKM00001', recipient: 'Riley Bennett', address: '402 Willow Bend Way',
    pkgs: [{ order_id: 'M-1', tracking_number: 'TRKM00001', piece_id: 'TRKM00001', required_count: 1 }] }];
  const pub = await O('publish_route', { payload: { title: 'Surge Route RT-001', job_type: 'surge', status: 'pending', master_code: 'TP-ROUTE-DIFF1',
    surge_stops: stops, total_stops: 1, total_packages: 1 } });
  log('publish', pub);
  const jid = (await db.query(`select id from public.jobs where master_code = 'TP-ROUTE-DIFF1'`)).rows[0].id;
  log('assign', await O('update_job', { id: jid, patch: { driver_name: 'Dana Driver', status: 'assigned' } }));
  log('stow', await O('log_event', { event_type: 'package.stowed', job_id: jid, payload: { code: 'TRKM00001' }, idempotency_key: 'diff-1' }));
  log('open', await O('open_binding', { id: jid, bin_code: '2B', location_code: 'A-02', opened_by: 'Keisha' }));
  log('ready', await O('binding_ready', { id: jid }));
  log('stage', await O('stage_binding', { id: jid, staging_code: 'STG:S-02' }));
  log('driver jobs', await Dr('jobs'));
  log('driver bin', await Dr('bin_binding', { id: jid }));
  log('pickup', await Dr('update_job', { id: jid, patch: { status: 'in_transit', picked_up_at: '2026-10-13T09:00:00Z' } }));
  log('delivered msg', await Dr('post_message', { id: jid, body: 'STOP_DELIVERED::' + JSON.stringify({ stop_number: 1, delivered_at: '2026-10-13T09:30:00Z' }) }));
  log('exception msg', await Dr('post_message', { id: jid, body: 'STOP_EXCEPTION::{"stop_number":1,"reason":"refused"}' }));
  log('done', await Dr('update_job', { id: jid, patch: { status: 'delivered', stops_completed: 1 } }));
  log('messages', await Dr('messages', { id: jid }));
  log('board', await O('jobs'));
  log('track', await rpc(db, 'tp_track', { p_action: 'stop', p_args: { tracking_number: 'TRKM00001' } }));
  const c = await rpc(db, 'tp_customer', { p_action: 'create_order', p_args: { org_slug: 'quickhaul', title: 'Portal order', pickup_address: '1 A St',
    dropoff_address: '2 B St' } });
  log('portal confirm', await rpc(db, 'tp_customer', { p_action: 'confirm', p_args: { id: c.job.id, order_token: c.order_token } }));
  log('archive', await O('archive_jobs', { ids: [jid] }));
  log('board after archive', await O('jobs', { exclude_archived: true }));
  log('rows', (await db.query(`select title, status, driver_name, archived, stops_completed, source from public.jobs order by title`)).rows);
  log('bindings', (await db.query(`select bin_code, location_code, state, staging_code from public.bin_bindings order by opened_at`)).rows);
  return out;
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(\+00(:00)?|Z)?/g;
const norm = (v) => JSON.stringify(v).replace(UUID, '<id>').replace(TS, '<time>').replace(/"id":\d+/g, '"id":<n>')
  .replace(/"order_token":"[0-9a-f]+"/g, '"order_token":"<t>"');

test('the apps behave exactly the same with migration 69: same answers, same rows, step by step', async () => {
  const before = await scenario(await apiDb({ with69: false }));
  const after = await scenario(await apiDb({ with69: true }));
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(norm(after[i][1]), norm(before[i][1]), `step "${before[i][0]}"`);
  }
  assert.ok(norm(before.find((s) => s[0] === 'rows')[1]).includes('delivered'), 'the scenario really ran');
});
