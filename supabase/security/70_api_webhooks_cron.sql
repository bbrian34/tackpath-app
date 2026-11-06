-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 70 (2026-10-13): run the API webhook worker every minute.
--
-- Adds pg_cron job "api-webhooks-job": every minute, net.http_post to the
-- api-webhooks edge function with the header x-tp-cron-secret, read from the
-- Vault secret "tp_cron_secret" each time the job runs (the same secret
-- swarm-watch uses, migration 40; never written into cron.job.command).
-- The function's CRON_SECRET must have the same value.
--
-- Optional: without this job, API webhook events are queued but not sent.
-- Needs 69, pg_cron, pg_net and the Vault secret. Changes nothing else; no
-- existing cron job is touched. Rollback: 70_api_webhooks_cron.rollback.sql.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regnamespace('tp_api') is null then
    raise exception 'Apply 69_public_api.sql first. Nothing was changed.';
  end if;
  if to_regclass('cron.job') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not installed here. Nothing was changed.';
  end if;
  if exists (select 1 from cron.job where jobname = 'api-webhooks-job') then
    raise exception 'Migration 70 is already applied (cron job api-webhooks-job exists). Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from vault.decrypted_secrets where name = 'tp_cron_secret' and length(coalesce(decrypted_secret, '')) >= 32) then
    raise exception 'The Vault secret tp_cron_secret is missing (see migration 40). Nothing was changed.';
  end if;
end $pre$;

select cron.schedule('api-webhooks-job', '* * * * *', $cmd$select net.http_post(
    url := 'https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-tp-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tp_cron_secret')),
    body := '{}'::jsonb
  ) as request_id$cmd$);

commit;
