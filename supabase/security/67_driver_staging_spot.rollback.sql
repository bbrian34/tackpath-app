-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 67. Puts migration 64's tp_driver back
-- under its own name with its grants: 'bin_binding' answers as before
-- ({bin_code, location_code, state}, no staging spot). The driver app keeps
-- hiding the LOC either way. Stops, changing nothing, unless 67 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_driver_v64(text,text,jsonb)') is null then
    raise exception 'Migration 67 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop function public.tp_driver(text,text,jsonb);
alter function tp_sec.tp_driver_v64(text,text,jsonb) set schema public;
alter function public.tp_driver_v64(text,text,jsonb) rename to tp_driver;
revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

commit;
