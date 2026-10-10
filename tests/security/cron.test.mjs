// Migration 40: the swarm-watch-job pg_cron job sends x-tp-cron-secret, read
// from supabase_vault at run time. pg_cron, Vault and pg_net are stood in for
// with the same function signatures; net.http_post records what it would send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile } from './fixture.mjs';
import { guardRequest } from '../../supabase/functions/_shared/tp_security.js';

const URL_ = 'https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/swarm-watch';
const OLD_COMMAND = `
  select net.http_post(
      url:='${URL_}',
      headers:='{"Content-Type": "application/json"}'::jsonb,
      body:='{}'::jsonb
  ) as request_id;
`;
const SECRET = 'a'.repeat(16) + '0123456789abcdef0123456789abcdef';

const PLATFORM = `
create schema cron;
create table cron.job (jobid bigserial primary key, schedule text not null, command text not null,
  nodename text default 'localhost', nodeport int default 5432, database text default 'postgres',
  username text default 'postgres', active boolean default true, jobname text);
create function cron.alter_job(job_id bigint, schedule text default null, command text default null,
  database text default null, username text default null, active boolean default null) returns void
language sql as $$
  update cron.job set schedule = coalesce(alter_job.schedule, job.schedule), command = coalesce(alter_job.command, job.command),
    database = coalesce(alter_job.database, job.database), username = coalesce(alter_job.username, job.username),
    active = coalesce(alter_job.active, job.active) where jobid = job_id
$$;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create schema net;
create table net.sent (id bigserial primary key, url text, headers jsonb, body jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000) returns bigint
language sql as $$ insert into net.sent (url, headers, body) values (url, headers, body) returning id $$;
`;

async function setup({ secret = true } = {}) {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql'] });
  await db.exec(PLATFORM);
  await db.query(`insert into cron.job (schedule, command, jobname) values ('* * * * *', $1, 'swarm-watch-job')`, [OLD_COMMAND]);
  if (secret) await db.query(`select vault.create_secret($1, 'tp_cron_secret', 'swarm-watch cron header')`, [SECRET]);
  return db;
}
const job = async (db) => (await db.query(`select * from cron.job where jobname = 'swarm-watch-job'`)).rows[0];
// what pg_cron does every minute: run the command, then what the edge function sees
async function tick(db) {
  await db.exec((await job(db)).command);
  return (await db.query(`select * from net.sent order by id desc limit 1`)).rows[0];
}
const swarmWatchGuard = (headers) => guardRequest(
  new Request(URL_, { method: 'POST', headers, body: '{}' }),
  { rpc: async () => ({ data: { ok: false } }), cronSecret: SECRET }, { kinds: ['org'] });

test('before 40 the cron call carries no secret and the new swarm-watch answers 401', async () => {
  const db = await setup();
  const sent = await tick(db);
  assert.deepEqual(sent.headers, { 'Content-Type': 'application/json' });
  const g = await swarmWatchGuard(sent.headers);
  assert.equal(g.response.status, 401);
});

test('40 makes the job send the Vault secret; the secret is never in the cron command; swarm-watch accepts it', async () => {
  const db = await setup();
  const before = await job(db);
  await db.exec(sqlFile('40_swarm_watch_cron.sql'));
  const after = await job(db);
  assert.ok(!after.command.includes(SECRET), 'secret is not stored in cron.job');
  assert.match(after.command, /vault\.decrypted_secrets where name = 'tp_cron_secret'/);
  for (const k of ['jobid', 'schedule', 'database', 'username', 'active', 'jobname']) assert.equal(after[k], before[k], k);
  const sent = await tick(db);
  assert.equal(sent.url, URL_);
  assert.equal(sent.headers['x-tp-cron-secret'], SECRET);
  assert.equal(sent.headers['Content-Type'], 'application/json');
  const g = await swarmWatchGuard(sent.headers);
  assert.equal(g.response, undefined);
  assert.equal(g.session.kind, 'cron');
  // rotating the Vault secret needs no cron change
  await db.query(`update vault.secrets set secret = 'rotated-' || secret where name = 'tp_cron_secret'`);
  assert.equal((await tick(db)).headers['x-tp-cron-secret'], 'rotated-' + SECRET);
  // twice: refused
  await assert.rejects(db.exec(sqlFile('40_swarm_watch_cron.sql')), /already applied/);
  await db.exec('rollback');
});

test('40 changes nothing without the Vault secret, without the job, or before 10', async () => {
  const db = await setup({ secret: false });
  await assert.rejects(db.exec(sqlFile('40_swarm_watch_cron.sql')), /Create the Vault secret first/);
  await db.exec('rollback');
  assert.equal((await job(db)).command, OLD_COMMAND);
  await db.query(`select vault.create_secret('short', 'tp_cron_secret')`);
  await assert.rejects(db.exec(sqlFile('40_swarm_watch_cron.sql')), /Create the Vault secret first/);
  await db.exec('rollback');

  const nojob = await setup();
  await nojob.exec(`delete from cron.job`);
  await assert.rejects(nojob.exec(sqlFile('40_swarm_watch_cron.sql')), /found 0/);
  await nojob.exec('rollback');

  const pre10 = await freshDb();
  await pre10.exec(PLATFORM);
  await assert.rejects(pre10.exec(sqlFile('40_swarm_watch_cron.sql')), /Apply 10_sessions_and_rpcs.sql first/);
  await pre10.exec('rollback');
});

test('rollback of 40 restores the exact previous command; 10 cannot be rolled back while 40 is applied', async () => {
  const db = await setup();
  await db.exec(sqlFile('40_swarm_watch_cron.sql'));
  await assert.rejects(db.exec(sqlFile('10_sessions_and_rpcs.rollback.sql')), /Roll back migration 40 first/);
  await db.exec('rollback');
  await db.exec(sqlFile('40_swarm_watch_cron.rollback.sql'));
  assert.equal((await job(db)).command, OLD_COMMAND);
  assert.equal((await db.query(`select count(*)::int n from tp_sec.settings where key = 'swarm_watch_cron_before'`)).rows[0].n, 0);
  await assert.rejects(db.exec(sqlFile('40_swarm_watch_cron.rollback.sql')), /was not applied/);
  await db.exec('rollback');
  // and it can be applied again
  await db.exec(sqlFile('40_swarm_watch_cron.sql'));
  assert.equal((await tick(db)).headers['x-tp-cron-secret'], SECRET);
});
