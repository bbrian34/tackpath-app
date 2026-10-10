-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 64. Puts migration 10's tp_driver back
-- under its own name with its grants: archived jobs are returned to drivers
-- again. The driver app still drops archived routes on the phone.
-- Stops, changing nothing, unless 64 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_driver_v10(text,text,jsonb)') is null then
    raise exception 'Migration 64 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop function public.tp_driver(text,text,jsonb);
alter function tp_sec.tp_driver_v10(text,text,jsonb) set schema public;
alter function public.tp_driver_v10(text,text,jsonb) rename to tp_driver;
revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

commit;
