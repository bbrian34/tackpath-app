-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 60 (PathIQ staging spots, release on pickup)
--
-- Removes the pickup trigger, puts the original tp_org gateway back under
-- its own name with its grants, and drops the one-route-per-spot index.
-- The staging_code / staged_at columns STAY, with their data: they are the
-- record of where routes were staged, and nothing reads them without 60.
-- Bindings already released by pickups stay released (that is history).
-- Stops, changing nothing, unless 60 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_core(text,text,jsonb)') is null then
    raise exception 'Migration 60 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_release_spots_on_pickup on public.jobs;
drop function if exists tp_sec.release_route_spots();

drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_core(text,text,jsonb) set schema public;
alter function public.tp_org_core(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

drop index if exists public.bin_bindings_one_route_per_staging_spot;

commit;
