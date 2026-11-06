-- TackPath — rollback of migration 70: removes cron job "api-webhooks-job".
-- Queued webhook deliveries stay in tp_api.deliveries and are sent when the
-- job is scheduled again. Stops, changing nothing, unless the job exists.
begin;
do $pre$
begin
  if to_regclass('cron.job') is null or not exists (select 1 from cron.job where jobname = 'api-webhooks-job') then
    raise exception 'Migration 70 is not in place (no cron job api-webhooks-job). Nothing was changed.';
  end if;
end $pre$;
select cron.unschedule('api-webhooks-job');
commit;
