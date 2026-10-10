-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 62: archived routes are not live.
--
-- 1. public.publish_surge_route (the SmartSort publication gate) refuses a
--    plan whose packages are already on a "live" job, and decided live by
--    status alone. A route archived with Clear board keeps its pending (or
--    other) status, so its packages stayed blocked forever. Found
--    2026-10-09: job e10a1fd5-1fd2-47b4-ac85-c39fc89f2dc2 was archived, not
--    on the board, and still blocked a rebuild.
--    Change: the live-package check also needs
--        coalesce(j.archived,false) = false
--
-- 2. Both lookups in the gate now only see jobs of the publishing company
--    (same org_id as the payload):
--      - the live-package check: another company's route never blocks;
--      - the master_code retry (at the start, and after a unique_violation):
--        another company's job is never returned. If a master code is
--        already taken by another company the gate answers
--        ok=false 'master_code ... is already in use' and returns no job.
--    Nothing else in the function changes; owner, SECURITY DEFINER,
--    search_path and EXECUTE grants stay as they are (CREATE OR REPLACE
--    keeps them).
--
-- 3. Same rule for PathIQ (migrations 60/61): archiving a route frees its
--    BIN, LOC and STG. A trigger on jobs.archived changing to true releases
--    the route's live binding with tp_sec.release_route_spots() (60), in the
--    same transaction: only that route, rows kept as 'released' with their
--    codes and times, a repeat finds nothing to change.
--
-- Needs 50 (the gate as migration 50 left it) and 60. Safe to run: the
-- preflight stops, changing nothing, if 62 is already applied, if the gate is
-- not the version 50 left, or if 60 is missing.
-- 62_gate_ignore_archived.rollback.sql restores migration 50's gate exactly
-- and drops the archive trigger.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
declare d text;
begin
  if to_regprocedure('public.publish_surge_route(jsonb)') is null then
    raise exception 'public.publish_surge_route(jsonb) does not exist here. Nothing was changed.';
  end if;
  d := pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure);
  if position($q$and coalesce(j.archived,false) = false$q$ in d) > 0
     or exists (select 1 from pg_trigger where tgname = 'tp_release_spots_on_archive' and tgrelid = 'public.jobs'::regclass) then
    raise exception 'Migration 62 is already applied. Nothing was changed.';
  end if;
  if position($q$where j.status not in ('cancelled','delivered','completed_with_exceptions')
        and (p->>'piece_id') = any(v_piece_ids)$q$ in d) = 0 then
    raise exception 'publish_surge_route is not the version this migration was written for (migration 50''s live-status check was not found). Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.release_route_spots()') is null then
    raise exception 'Apply 60_pathiq_staging_reset.sql first. Nothing was changed.';
  end if;
end $pre$;

CREATE OR REPLACE FUNCTION public.publish_surge_route(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing jobs%rowtype;
  v_stops jsonb;
  v_stop jsonb;
  v_pkg jsonb;
  v_piece_ids text[] := '{}';
  v_conflict_id uuid;
  v_conflict_piece text;
  v_declared_stops int;
  v_declared_packages int;
  v_counted_packages int := 0;
  v_row jobs%rowtype;
begin
  if payload->>'master_code' is not null then
    select * into v_existing from public.jobs where master_code = payload->>'master_code'
      and org_id is not distinct from (payload->>'org_id')::uuid limit 1;
    if found then
      return jsonb_build_object('ok', true, 'idempotent', true, 'job', to_jsonb(v_existing));
    end if;
  end if;

  v_stops := payload->'surge_stops';
  if v_stops is null or jsonb_typeof(v_stops) <> 'array' or jsonb_array_length(v_stops) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no stops in payload');
  end if;

  for v_stop in select * from jsonb_array_elements(v_stops)
  loop
    for v_pkg in select * from jsonb_array_elements(coalesce(v_stop->'pkgs', '[]'::jsonb))
    loop
      v_counted_packages := v_counted_packages + coalesce((v_pkg->>'required_count')::int, 1);
      if v_pkg->>'piece_id' is not null then
        if v_pkg->>'piece_id' = any(v_piece_ids) then
          return jsonb_build_object('ok', false, 'error',
            'duplicate piece_id within this plan: '||(v_pkg->>'piece_id'));
        end if;
        v_piece_ids := array_append(v_piece_ids, v_pkg->>'piece_id');
      end if;
    end loop;
  end loop;

  v_declared_packages := coalesce((payload->>'total_packages')::int, -1);
  if v_declared_packages >= 0 and v_declared_packages <> v_counted_packages then
    return jsonb_build_object('ok', false, 'error',
      format('total_packages (%s) does not match physical units actually present in surge_stops (%s)',
        v_declared_packages, v_counted_packages));
  end if;

  v_declared_stops := coalesce((payload->>'total_stops')::int, -1);
  if v_declared_stops >= 0 and v_declared_stops <> jsonb_array_length(v_stops) then
    return jsonb_build_object('ok', false, 'error', 'total_stops does not match surge_stops length');
  end if;

  if array_length(v_piece_ids, 1) > 0 then
    select j.id, p->>'piece_id'
      into v_conflict_id, v_conflict_piece
      from public.jobs j,
           jsonb_array_elements(coalesce(j.surge_stops, '[]'::jsonb)) s,
           jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
      where j.status not in ('cancelled','delivered','completed_with_exceptions')
        and coalesce(j.archived,false) = false
        and j.org_id is not distinct from (payload->>'org_id')::uuid
        and (p->>'piece_id') = any(v_piece_ids)
      limit 1;
    if v_conflict_id is not null then
      return jsonb_build_object('ok', false, 'error',
        format('piece_id %s is already committed to live job %s', v_conflict_piece, v_conflict_id));
    end if;
  end if;

  insert into public.jobs (
    org_id, title, job_type, status, bin_label,
    pickup_address, dropoff_address, surge_stops,
    master_code, total_stops, total_packages, price,
    distance_miles, estimated_delivery_at, original_eta_at, created_at
  )
  select
    (payload->>'org_id')::uuid, payload->>'title', payload->>'job_type',
    coalesce(payload->>'status','pending'), payload->>'bin_label',
    payload->>'pickup_address', payload->>'dropoff_address', v_stops,
    payload->>'master_code',
    (payload->>'total_stops')::int, (payload->>'total_packages')::int,
    (payload->>'price')::numeric, (payload->>'distance_miles')::numeric,
    (payload->>'estimated_delivery_at')::timestamptz,
    (payload->>'original_eta_at')::timestamptz,
    coalesce((payload->>'created_at')::timestamptz, now())
  returning * into v_row;

  return jsonb_build_object('ok', true, 'idempotent', false, 'job', to_jsonb(v_row));
exception when unique_violation then
  select * into v_existing from public.jobs where master_code = payload->>'master_code'
    and org_id is not distinct from (payload->>'org_id')::uuid limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'master_code '||(payload->>'master_code')||' is already in use');
  end if;
  return jsonb_build_object('ok', true, 'idempotent', true, 'job', to_jsonb(v_existing));
end;
$function$;

-- ── 3. Archiving a route frees its BIN, LOC and STG ─────────────────────
create trigger tp_release_spots_on_archive
  after update of archived on public.jobs
  for each row
  when (new.archived is true and old.archived is distinct from true)
  execute function tp_sec.release_route_spots();

commit;
