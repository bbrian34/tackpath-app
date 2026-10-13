-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 69 (Public API v1).
--
-- Removes the two triggers (jobs, messages), the gateway public.tp_svc_api and
-- the private schema tp_api with everything in it (API keys, API orders,
-- webhook endpoints, events, deliveries, audit). The jobs the API created stay
-- on the board as ordinary jobs (source 'api'); nothing in public.jobs,
-- public.messages or any other existing table is changed.
--
-- First switch the API off (stop the "api" and "api-webhooks" edge functions
-- and, if migration 70 was applied, roll it back) so nothing calls the gateway.
-- Stops, changing nothing, unless 69 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regnamespace('tp_api') is null then
    raise exception 'Migration 69 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_api_job_change on public.jobs;
drop trigger if exists tp_api_message on public.messages;
drop function if exists public.tp_svc_api(text, jsonb);
drop schema tp_api cascade;

commit;
