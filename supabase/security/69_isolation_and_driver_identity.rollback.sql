-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 69. Puts back 65's tp_org, 67's
-- tp_driver and migration 10's tp_driver_sign_in under their own names with
-- their grants, removes the two triggers and helper functions, and switches
-- driver_without_org_sees_all back on. Data written while 69 was in place is
-- kept: messages.org_id, jobs.driver_id, drivers.org_id stamped by approvals
-- and backfill, and tp_sec.identity_review (dropped only by the last line,
-- commented out, if you want it gone). Stops, changing nothing, unless 69 is
-- in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v65(text,text,jsonb)') is null
     or to_regprocedure('tp_sec.tp_driver_v67(text,text,jsonb)') is null
     or to_regprocedure('tp_sec.tp_driver_sign_in_v10(text,text)') is null then
    raise exception 'Migration 69 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v65(text,text,jsonb) set schema public;
alter function public.tp_org_v65(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

drop function public.tp_driver(text,text,jsonb);
alter function tp_sec.tp_driver_v67(text,text,jsonb) set schema public;
alter function public.tp_driver_v67(text,text,jsonb) rename to tp_driver;
revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

drop function public.tp_driver_sign_in(text,text,text);
alter function tp_sec.tp_driver_sign_in_v10(text,text) set schema public;
alter function public.tp_driver_sign_in_v10(text,text) rename to tp_driver_sign_in;
revoke all on function public.tp_driver_sign_in(text,text) from public, anon, authenticated;
grant execute on function public.tp_driver_sign_in(text,text) to anon, authenticated, service_role;

drop trigger tp_job_driver_id on public.jobs;
drop trigger tp_message_org on public.messages;
drop function tp_sec.job_driver_id();
drop function tp_sec.message_org();
drop function tp_sec.route_is_mine(tp_sec.sessions, public.jobs);
drop function tp_sec.route_summary(jsonb);
drop function tp_sec.drivers_named(text, text);
drop function tp_sec.flag_identity(text, text, text, text, text);
update tp_sec.settings set value = 'true' where key = 'driver_without_org_sees_all';
-- drop table tp_sec.identity_review;

commit;
