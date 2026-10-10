-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 62. Puts back public.publish_surge_route
-- exactly as migration 50 left it (archived routes count as live again, and
-- the checks look at every company's jobs), and drops the archive trigger
-- (archiving no longer frees BIN / LOC / STG). Owner, SECURITY DEFINER,
-- search_path and grants stay. Bindings already released stay released
-- (history). Stops, changing nothing, unless migration 62 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('public.publish_surge_route(jsonb)') is null then
    raise exception 'public.publish_surge_route(jsonb) does not exist here. Nothing was changed.';
  end if;
  if position($q$and coalesce(j.archived,false) = false$q$ in pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure)) = 0 then
    raise exception 'Migration 62 is not in place (its archived check was not found). Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_release_spots_on_archive on public.jobs;

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
    select * into v_existing from public.jobs where master_code = payload->>'master_code' limit 1;
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
  select * into v_existing from public.jobs where master_code = payload->>'master_code' limit 1;
  return jsonb_build_object('ok', true, 'idempotent', true, 'job', to_jsonb(v_existing));
end;
$function$;

commit;
