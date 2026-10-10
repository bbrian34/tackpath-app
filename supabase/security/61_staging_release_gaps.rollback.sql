-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 61. Back to migration 60's behaviour:
-- Reset Bin no longer frees the STG spot, and only pickup (in_transit /
-- picked_up_at) releases a route's bindings. Bindings already closed as
-- 'reset' or 'released' stay as they are (history).
-- Stops, changing nothing, unless 61 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.free_spot_on_reset()') is null then
    raise exception 'Migration 61 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_free_spot_on_reset on public.jobs;
drop function tp_sec.free_spot_on_reset();

drop trigger tp_release_spots_on_pickup on public.jobs;
create trigger tp_release_spots_on_pickup
  after update of status, picked_up_at on public.jobs
  for each row
  when ((new.status = 'in_transit' and old.status is distinct from new.status)
        or (new.picked_up_at is not null and old.picked_up_at is null))
  execute function tp_sec.release_route_spots();

commit;
