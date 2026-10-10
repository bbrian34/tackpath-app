-- ═══════════════════════════════════════════════════════════════════════
-- TackPath security hardening — migration 40: swarm-watch cron secret
--
-- Production 2026-10-07: pg_cron job "swarm-watch-job" runs every minute and
-- calls the swarm-watch edge function with net.http_post and only a
-- Content-Type header. The new swarm-watch answers 401 to that, so the job
-- would silently stop. This changes the job's command to also send
--     x-tp-cron-secret: <Vault secret "tp_cron_secret">
-- The secret is read from supabase_vault each time the job runs; it is never
-- written into cron.job.command.
--
-- Before running: the Vault secret "tp_cron_secret" exists and the same value
-- is set as the edge function secret CRON_SECRET (README, deploy order).
-- Run BEFORE deploying the new swarm-watch: the current swarm-watch ignores
-- the extra header, so nothing breaks in between.
--
-- Changes only cron job "swarm-watch-job" (its command; schedule, database,
-- user and active flag stay). The previous command is kept in tp_sec.settings
-- ("swarm_watch_cron_before"); 40_swarm_watch_cron.rollback.sql restores it.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
declare n integer; cmd text; url text;
begin
  if to_regclass('tp_sec.settings') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from tp_sec.settings where key = 'swarm_watch_cron_before') then
    raise exception 'Migration 40 is already applied. Nothing was changed.';
  end if;
  if to_regclass('cron.job') is null or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    raise exception 'pg_cron is not installed here. Nothing was changed.';
  end if;
  select count(*) into n from cron.job where jobname = 'swarm-watch-job';
  if n <> 1 then
    raise exception 'Expected exactly one cron job named swarm-watch-job, found %. Nothing was changed.', n;
  end if;
  select command into cmd from cron.job where jobname = 'swarm-watch-job';
  url := substring(cmd from '(https://[A-Za-z0-9.-]+/functions/v1/swarm-watch[A-Za-z0-9/?=&_.-]*)');
  if url is null or cmd !~* 'net\.http_post' then
    raise exception 'swarm-watch-job does not look like net.http_post to /functions/v1/swarm-watch. Nothing was changed. Command: %', cmd;
  end if;
  if cmd ilike '%x-tp-cron-secret%' then
    raise exception 'swarm-watch-job already sends x-tp-cron-secret. Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase_vault is not installed (no vault.decrypted_secrets). Nothing was changed.';
  end if;
  if not exists (select 1 from vault.decrypted_secrets
                  where name = 'tp_cron_secret' and length(coalesce(decrypted_secret, '')) >= 32) then
    raise exception 'Create the Vault secret first: select vault.create_secret(encode(extensions.gen_random_bytes(32), ''hex''), ''tp_cron_secret'', ''swarm-watch cron header''); Nothing was changed.';
  end if;
end
$pre$;

-- keep the current command for the rollback
insert into tp_sec.settings (key, value)
select 'swarm_watch_cron_before', jsonb_build_object('jobid', jobid, 'command', command)
  from cron.job where jobname = 'swarm-watch-job';

-- same URL (taken from the current command), same schedule; adds the header.
-- The command text contains no secret, only the Vault lookup.
select cron.alter_job(
  job_id  := j.jobid,
  command := format($cmd$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-tp-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tp_cron_secret')),
    body := '{}'::jsonb
  ) as request_id$cmd$,
    substring(j.command from '(https://[A-Za-z0-9.-]+/functions/v1/swarm-watch[A-Za-z0-9/?=&_.-]*)')))
  from cron.job j where j.jobname = 'swarm-watch-job';

commit;
