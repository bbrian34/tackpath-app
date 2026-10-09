-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 61: free staging spots on Reset Bin, and free a
-- route's BIN / LOC / STG when it is cancelled or finished.
-- Follow-up to migration 60.
--
-- 1. RESET BIN (PathIQ). The worker's Reset Bin clears the route's
--    jobs.staged_at (tp_org set_staged false). A trigger on that change, in
--    the same transaction, frees the STG spot the route holds:
--      - the staged binding is closed as state 'reset' (released_at = now),
--        keeping bin_code, location_code, staging_code and staged_at: the
--        record that the route used that spot;
--      - a new 'open' binding for the same route, bin and location takes its
--        place, so the route keeps its bin and is stowed again from zero.
--    Only bindings of that one job that hold a staging spot change. A second
--    reset finds staged_at already empty (and no staged binding) and changes
--    nothing.
--
-- 2. CANCEL / FINISH. Migration 60 released a route's live binding at
--    pickup (status -> in_transit, or picked_up_at first set). The same
--    release now also happens when the status changes to cancelled,
--    delivered or completed_with_exceptions (a route can reach those without
--    passing through in_transit, e.g. cancelled before pickup, or set by the
--    dispatcher). Same rules: same transaction, only that job, a repeat finds
--    nothing live, rows kept as 'released' with their codes and times.
--
-- Needs 60. Preflight stops, changing nothing, if 61 is already applied or 60
-- is missing. Rollback: 61_staging_release_gaps.rollback.sql (run it before
-- rolling back 60).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.release_route_spots()') is null or to_regprocedure('tp_sec.tp_org_core(text,text,jsonb)') is null then
    raise exception 'Apply 60_pathiq_staging_reset.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.free_spot_on_reset()') is not null then
    raise exception 'Migration 61 is already applied. Nothing was changed.';
  end if;
end $pre$;

-- ── 1. Reset Bin frees the STG spot ────────────────────────────────────
create function tp_sec.free_spot_on_reset() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b public.bin_bindings;
begin
  for b in select * from public.bin_bindings bb
            where bb.job_id::text = new.id::text and bb.state in ('open','ready') and bb.staging_code is not null
            for update loop
    update public.bin_bindings set state = 'reset', released_at = now() where id = b.id;
    insert into public.bin_bindings (org_id, bin_code, location_code, job_id, state, opened_by)
    values (b.org_id, b.bin_code, b.location_code, b.job_id, 'open', b.opened_by);
  end loop;
  return null;
end $$;
revoke all on function tp_sec.free_spot_on_reset() from public, anon, authenticated;

create trigger tp_free_spot_on_reset
  after update of staged_at on public.jobs
  for each row
  when (old.staged_at is not null and new.staged_at is null)
  execute function tp_sec.free_spot_on_reset();

-- ── 2. Cancel / delivered / completed_with_exceptions release too ───────
drop trigger tp_release_spots_on_pickup on public.jobs;
create trigger tp_release_spots_on_pickup
  after update of status, picked_up_at on public.jobs
  for each row
  when ((new.status in ('in_transit','cancelled','delivered','completed_with_exceptions')
         and old.status is distinct from new.status)
        or (new.picked_up_at is not null and old.picked_up_at is null))
  execute function tp_sec.release_route_spots();

commit;
