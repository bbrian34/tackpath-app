-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 65. Puts migration 63's tp_org back
-- under its own name with its grants, removes the self-healing and the
-- delete trigger, and returns the release trigger to migration 61's
-- statuses. Bindings already released stay released (history).
-- Stops, changing nothing, unless 65 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v63(text,text,jsonb)') is null or to_regprocedure('tp_sec.heal_spots(text)') is null then
    raise exception 'Migration 65 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_release_spots_on_delete on public.jobs;
drop function tp_sec.release_spots_on_delete();

drop trigger tp_release_spots_on_pickup on public.jobs;
create trigger tp_release_spots_on_pickup
  after update of status, picked_up_at on public.jobs
  for each row
  when ((new.status in ('in_transit','cancelled','delivered','completed_with_exceptions')
         and old.status is distinct from new.status)
        or (new.picked_up_at is not null and old.picked_up_at is null))
  execute function tp_sec.release_route_spots();

drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v63(text,text,jsonb) set schema public;
alter function public.tp_org_v63(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

drop function tp_sec.heal_spots(text);
drop function tp_sec.route_is_live(text);

commit;
