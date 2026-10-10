-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 63. Puts migration 60's tp_org gateway
-- back under its own name with its grants; 'jobs' no longer understands
-- exclude_archived (it is ignored, archived routes are listed again).
-- PathIQ keeps working: it also drops archived routes on the device.
-- Stops, changing nothing, unless 63 is in place. Run it before rolling
-- back 60.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v60(text,text,jsonb)') is null then
    raise exception 'Migration 63 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v60(text,text,jsonb) set schema public;
alter function public.tp_org_v60(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

commit;
