-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK of migration 40 (swarm-watch cron secret).
-- Puts back the exact cron command recorded when 40 was applied (only a
-- Content-Type header). The NEW swarm-watch refuses that call (401), so roll
-- back 40 only together with redeploying the previous swarm-watch, or
-- accept that the every-minute check stops until 40 is applied again.
-- The Vault secret "tp_cron_secret" is left in place (delete it yourself
-- if wanted: delete from vault.secrets where name = 'tp_cron_secret';).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $chk$
begin
  if to_regclass('tp_sec.settings') is null
     or not exists (select 1 from tp_sec.settings where key = 'swarm_watch_cron_before') then
    raise exception 'Migration 40 was not applied (no saved cron command). Nothing was changed.';
  end if;
  if not exists (select 1 from cron.job j join tp_sec.settings s on s.key = 'swarm_watch_cron_before'
                  where j.jobid = (s.value->>'jobid')::bigint) then
    raise exception 'The swarm-watch-job cron job recorded by migration 40 no longer exists. Nothing was changed.';
  end if;
end
$chk$;

select cron.alter_job(job_id := (s.value->>'jobid')::bigint, command := s.value->>'command')
  from tp_sec.settings s where s.key = 'swarm_watch_cron_before';

delete from tp_sec.settings where key = 'swarm_watch_cron_before';
commit;
