-- Migration 72: one box never blocks a whole route, and nothing that goes wrong is lost.
--
-- 1. Box-by-box publishing. The SmartSort publication gate (public.publish_surge_route)
--    refused a whole route when any one of its boxes was already on a live route. When the
--    dispatcher asks for it (payload "partial": true), the gate now publishes the route
--    without those boxes and answers which boxes it held back ("held"). Each held box is
--    written to public.dispatch_attention ("Needs attention") with the route it is already
--    on. If every box is held, the route is refused as before. Without "partial" the gate
--    answers exactly as before, so a dispatcher screen opened before this change keeps its
--    old behaviour. Every other check (duplicate box in the plan, declared totals, the
--    master_code retry, company isolation) is unchanged and runs on the whole plan first.
--    Publications of one company now run one at a time (a transaction lock), so two
--    screens publishing at the same moment can never both put the same box on a route.
-- 2. "Needs attention" for files from Keel. tp_org gains:
--      attention          open items for this company, plus inbox files claimed more than
--                         15 minutes ago and never finished (a screen closed mid-build)
--      attention_add      the dispatcher records a route or file it could not publish
--      attention_resolve  closes one item with a note (who and when are kept)
--      inbox_done         the dispatcher marks a claimed file finished, with its result
--      inbox_retry        puts a claimed file back in the inbox to be imported again
--    A retried file cannot create duplicates: the gate holds back boxes already on a live
--    route.
-- Additive: one table, two columns on smartsort_inbox; the gate is replaced; tp_org is
-- wrapped like 60-71 (the gateway in place moves to tp_sec.tp_org_v71). Needs 71.
-- Roll back with 72_box_by_box_publishing.rollback.sql: it puts back the gate exactly as it
-- was (saved here in tp_sec.m72_saved_gate) and the previous gateway.
begin;
do $pre$ declare d text; begin
  if to_regprocedure('tp_sec.tp_org_v70(text,text,jsonb)') is null or to_regclass('public.smartsort_inbox') is null then
    raise exception 'Migration 71 is not applied. Nothing was changed.'; end if;
  if to_regclass('public.dispatch_attention') is not null then raise exception 'Migration 72 is already applied. Nothing was changed.'; end if;
  d := pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure);
  if position($q$and coalesce(j.archived,false) = false$q$ in d) = 0
     or position($q$'piece_id %s is already committed to live job %s'$q$ in d) = 0 then
    raise exception 'publish_surge_route is not the version migration 62 left. Nothing was changed.'; end if;
end $pre$;

create table public.dispatch_attention (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  kind         text not null check (kind in ('piece_held', 'route_refused', 'file_failed')),
  piece_id     text,
  ref          text,                 -- master_code of the route, or the inbox file reference
  detail       jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  text,
  resolution   text
);
-- the same open problem is recorded once, however often it is retried
create unique index dispatch_attention_open on public.dispatch_attention (org_id, kind, coalesce(piece_id, ''), coalesce(ref, '')) where resolved_at is null;
create index dispatch_attention_org on public.dispatch_attention (org_id, created_at desc);
alter table public.dispatch_attention enable row level security;
revoke all on public.dispatch_attention from public, anon, authenticated;

-- the gate in place, exactly as it is (byte for byte), for the rollback
create table tp_sec.m72_saved_gate (id int primary key default 1 check (id = 1), def text not null, saved_at timestamptz not null default now());
revoke all on tp_sec.m72_saved_gate from public, anon, authenticated;
insert into tp_sec.m72_saved_gate (def) values (pg_get_functiondef('public.publish_surge_route(jsonb)'::regprocedure));

alter table public.smartsort_inbox add column done_at timestamptz, add column result jsonb;
-- files already taken before this change were handled by the screens of the time
update public.smartsort_inbox set done_at = claimed_at where claimed_at is not null;

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
  v_partial boolean := coalesce((payload->>'partial')::boolean, false);
  v_held jsonb := '[]'::jsonb;
  v_held_ids text[] := '{}';
  v_new_stops jsonb := '[]'::jsonb;
  v_keep jsonb;
  v_removed int;
  v_n int := 0;
  v_kept_packages int := 0;
begin
  -- one publication at a time per company: two screens publishing at the same moment
  -- could otherwise both put the same box on a route (neither sees the other's new row)
  perform pg_advisory_xact_lock(hashtext('tp_publish:' || coalesce(payload->>'org_id', '')));
  if payload->>'master_code' is not null then
    select * into v_existing from public.jobs where master_code = payload->>'master_code'
      and org_id is not distinct from (payload->>'org_id')::uuid limit 1;
    if found then
      return jsonb_build_object('ok', true, 'idempotent', true, 'job', to_jsonb(v_existing),
        'held', coalesce((select jsonb_agg(jsonb_build_object('piece_id', a.piece_id) || a.detail order by a.created_at)
                            from public.dispatch_attention a
                           where a.org_id is not distinct from (payload->>'org_id')::uuid and a.kind = 'piece_held'
                             and a.ref = payload->>'master_code'), '[]'::jsonb));
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
    if not v_partial then
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
    else
      -- every box of this plan that is already on a live route of this company, once each
      select coalesce(jsonb_agg(jsonb_build_object('piece_id', x.piece_id, 'live_job_id', x.job_id, 'live_job_title', x.title) order by x.piece_id), '[]'::jsonb),
             coalesce(array_agg(x.piece_id), '{}')
        into v_held, v_held_ids
        from (select distinct on (p->>'piece_id') p->>'piece_id' piece_id, j.id job_id, j.title
                from public.jobs j,
                     jsonb_array_elements(coalesce(j.surge_stops, '[]'::jsonb)) s,
                     jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
               where j.status not in ('cancelled','delivered','completed_with_exceptions')
                 and coalesce(j.archived,false) = false
                 and j.org_id is not distinct from (payload->>'org_id')::uuid
                 and (p->>'piece_id') = any(v_piece_ids)
               order by p->>'piece_id', j.created_at) x;
    end if;
  end if;

  if array_length(v_held_ids, 1) > 0 then
    -- the route without the held boxes; a stop left with no box is dropped; stops renumbered
    for v_stop in select * from jsonb_array_elements(v_stops)
    loop
      select coalesce(jsonb_agg(p), '[]'::jsonb) into v_keep
        from jsonb_array_elements(coalesce(v_stop->'pkgs', '[]'::jsonb)) p
       where p->>'piece_id' is null or not (p->>'piece_id' = any(v_held_ids));
      v_removed := jsonb_array_length(coalesce(v_stop->'pkgs', '[]'::jsonb)) - jsonb_array_length(v_keep);
      continue when v_removed > 0 and jsonb_array_length(v_keep) = 0;
      v_n := v_n + 1;
      v_stop := jsonb_set(v_stop, '{pkgs}', v_keep);
      if v_stop ? 'stop_number' then v_stop := jsonb_set(v_stop, '{stop_number}', to_jsonb(v_n)); end if;
      if v_removed > 0 and jsonb_typeof(v_stop->'packages') = 'number' then
        v_stop := jsonb_set(v_stop, '{packages}', to_jsonb((select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int from jsonb_array_elements(v_keep) p)));
      end if;
      v_kept_packages := v_kept_packages + (select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int from jsonb_array_elements(v_keep) p);
      v_new_stops := v_new_stops || jsonb_build_array(v_stop);
    end loop;

    -- recorded for the dispatcher, once per box and route, however often this is retried
    insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
    select (payload->>'org_id')::uuid, 'piece_held', h->>'piece_id', payload->>'master_code',
           jsonb_build_object('live_job_id', h->>'live_job_id', 'live_job_title', h->>'live_job_title', 'route_title', payload->>'title')
      from jsonb_array_elements(v_held) h
    on conflict do nothing;

    if jsonb_array_length(v_new_stops) = 0 then
      return jsonb_build_object('ok', false, 'error', 'every box on this route is already on a live route', 'held', v_held);
    end if;
    v_stops := v_new_stops;
    payload := payload || jsonb_build_object('total_stops', jsonb_array_length(v_new_stops), 'total_packages', v_kept_packages);
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

  return jsonb_build_object('ok', true, 'idempotent', false, 'job', to_jsonb(v_row), 'held', v_held);
exception when unique_violation then
  select * into v_existing from public.jobs where master_code = payload->>'master_code'
    and org_id is not distinct from (payload->>'org_id')::uuid limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'master_code '||(payload->>'master_code')||' is already in use');
  end if;
  return jsonb_build_object('ok', true, 'idempotent', true, 'job', to_jsonb(v_existing));
end;
$function$;

alter function public.tp_org(text,text,jsonb) rename to tp_org_v71;
alter function public.tp_org_v71(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v71(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; res jsonb; r public.smartsort_inbox; t public.dispatch_attention;
begin
  if p_action not in ('attention', 'attention_add', 'attention_resolve', 'inbox_done', 'inbox_retry') then
    return tp_sec.tp_org_v71(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;

  if p_action = 'attention' then
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'piece_id', d.piece_id, 'ref', d.ref,
                                  'detail', d.detail, 'created_at', d.created_at) order by d.created_at desc)
                           from (select * from public.dispatch_attention x where x.org_id::text = org and x.resolved_at is null
                                  order by x.created_at desc limit 200) d), '[]'::jsonb),
      'stale_files', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'ref', i.ref, 'filename', i.filename,
                                  'claimed_at', i.claimed_at, 'claimed_by', i.claimed_by) order by i.claimed_at)
                           from public.smartsort_inbox i where i.org_id::text = org and i.claimed_at < now() - interval '15 minutes'
                            and i.done_at is null), '[]'::jsonb))
      into res;
    return res;
  end if;

  if p_action = 'attention_add' then        -- a route or file the dispatcher could not publish
    if coalesce(a->>'kind', '') not in ('route_refused', 'file_failed') then raise exception 'TP_INVALID: kind must be route_refused or file_failed'; end if;
    if coalesce(a->>'ref', '') = '' then raise exception 'TP_INVALID: ref is required'; end if;
    insert into public.dispatch_attention (org_id, kind, ref, detail)
    values (org::uuid, a->>'kind', left(a->>'ref', 200),
            jsonb_build_object('reason', left(coalesce(a->>'reason', ''), 500), 'file_ref', left(a->>'file_ref', 200), 'file_id', left(a->>'file_id', 60),
                               'pieces', coalesce(a->'pieces', '[]'::jsonb), 'route_title', left(a->>'title', 200)))
    on conflict do nothing returning * into t;
    return jsonb_build_object('ok', true, 'new', t.id is not null);
  end if;

  if p_action = 'attention_resolve' then
    if coalesce(a->>'note', '') = '' then raise exception 'TP_INVALID: a note is required'; end if;
    update public.dispatch_attention set resolved_at = now(), resolved_by = left(coalesce(a->>'by', 'dispatcher'), 120), resolution = left(a->>'note', 500)
     where id::text = a->>'id' and org_id::text = org and resolved_at is null returning * into t;
    return jsonb_build_object('ok', t.id is not null);
  end if;

  if p_action = 'inbox_done' then           -- the claimed file was built and published (or recorded as failed)
    update public.smartsort_inbox set done_at = coalesce(done_at, now()), result = coalesce(a->'result', '{}'::jsonb)
     where id::text = a->>'id' and org_id::text = org and claimed_at is not null returning * into r;
    return jsonb_build_object('ok', r.id is not null);
  end if;

  if p_action = 'inbox_retry' then          -- back to the inbox; the gate holds back boxes already on a live route
    update public.smartsort_inbox set claimed_at = null, claimed_by = null, done_at = null, result = null
     where id::text = a->>'id' and org_id::text = org returning * into r;
    if r.id is not null then
      update public.dispatch_attention set resolved_at = now(), resolved_by = 'retry', resolution = 'file sent to the inbox again'
       where org_id::text = org and resolved_at is null and kind = 'file_failed' and ref = r.ref;
    end if;
    return jsonb_build_object('ok', r.id is not null);
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

commit;
