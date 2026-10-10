-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK of migration 10 (sessions, sign-in, RPCs).
-- Roll back migration 20 FIRST (this refuses to run while it is applied).
-- Removes the tp_* functions and the private tp_sec schema (sessions, hashed
-- codes, rate limits, SMS log). No public table or row is touched; the
-- plaintext organizations.access_code values were never changed.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $chk$
begin
  if to_regclass('tp_sec.lockdown_backup') is not null then
    raise exception 'Roll back migration 20 first (20_lockdown.rollback.sql). Nothing was changed.';
  end if;
  if to_regclass('tp_sec.settings') is not null then
    if exists (select 1 from tp_sec.settings where key = 'swarm_watch_cron_before') then
      raise exception 'Roll back migration 40 first (40_swarm_watch_cron.rollback.sql). Nothing was changed.';
    end if;
  end if;
end
$chk$;

drop function if exists public.tp_org_lookup(text);
drop function if exists public.tp_org_sign_in(text, text);
drop function if exists public.tp_sign_out(text);
drop function if exists public.tp_org(text, text, jsonb);
drop function if exists public.tp_driver_sign_in(text, text);
drop function if exists public.tp_driver(text, text, jsonb);
drop function if exists public.tp_customer(text, jsonb);
drop function if exists public.tp_track(text, jsonb);
drop function if exists public.tp_driver_signup(jsonb);
drop function if exists public.tp_svc_driver_code(text);
drop function if exists public.tp_svc_assignment_sms(text, text);
drop function if exists public.tp_svc_pod(text, text, text);
drop function if exists public.tp_svc_session(text);
drop schema if exists tp_sec cascade;

commit;
