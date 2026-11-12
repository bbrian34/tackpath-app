-- Migration 74: recovery rules for returned, damaged and missing boxes.
--
-- 1. A STAGED route is CLOSED. No box can be added to a route once it is staged, picked up or out
--    (the route's own boxes can still be taken off, e.g. a box received back). Recovered boxes join
--    only routes still open for additions, or the next route batch.
-- 2. Returns, three answers at the RECEIVED scan (tp_org receive_return condition):
--      intact            ready to go out again
--      carton_damaged    the contents are fine: hold "rebox" until the worker confirms the new carton
--                        (tp_org rebox_done; same box identity and label); it then goes out with a
--                        DIFFERENT driver than the route it came back from
--      contents_damaged  hold "contents_damaged": to the problem-solving station (Keel opens a problem)
--    ("damaged" from an older screen means contents_damaged.)
-- 3. A different driver: a box marked to avoid a driver cannot be on a route given to that driver
--    (claim or dispatcher assignment is refused with the reason; another driver takes the route).
-- 4. tp_org assign_piece: a box back in the warehouse joins an open route (not staged, not picked up,
--    same company, not the avoided driver), at its stop's address; piece_candidates lists the open
--    routes in the same ZIP code.
-- 5. Missing boxes: investigations, about five days. tp_svc_piece_tick (every 10 minutes) opens an
--    investigation for a box the driver reported as not delivered but the warehouse never received
--    within 2 hours of the route ending, and for a box still with a driver whose route has ended
--    without any report. Alerts on day 1 and 3, declared lost on day 5. Scanning it RECEIVED, or
--    tp_org mark_found, closes it at any time (also after "lost").
-- 6. Driver patterns: tp_org driver_patterns lists each driver's attempts and failed deliveries by
--    reason over the last N days, how many boxes another driver then delivered, and failures at
--    apartment/unit addresses. Suspicious patterns are flagged under Needs attention for the courier
--    operator to look into. Nothing is done to the driver automatically.
-- tp_org is wrapped like 60-73 (tp_sec.tp_org_v73). Needs 73. Roll back with 74_recovery_rules.rollback.sql.
begin;
do $pre$ begin
  if to_regclass('public.pieces') is null then raise exception 'Migration 73 is not applied. Nothing was changed.'; end if;
  if to_regprocedure('tp_sec.piece_tick_once(timestamptz)') is not null then raise exception 'Migration 74 is already applied. Nothing was changed.'; end if;
end $pre$;

alter table public.pieces add column avoid_driver text, add column avoid_driver_name text,
  add column investigation_opened_at timestamptz, add column investigation_reason text, add column investigation_level integer not null default 0;
alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed', 'piece_conflict',
  'investigation', 'piece_lost', 'driver_pattern', 'contents_damaged'));

-- is the route closed to additions?
create function tp_sec.route_closed(j public.jobs) returns boolean language sql stable as $$
  select j.staged_at is not null or j.picked_up_at is not null or coalesce(j.status, '') in ('in_transit', 'delivered', 'completed_with_exceptions', 'cancelled')
      or coalesce(j.archived, false);
$$;

-- 1 and 3: the rules on every change of a route
create function tp_sec.jobs_recovery_rules() returns trigger language plpgsql security definer set search_path = '' as $$
declare added text; avoid record;
begin
  if new.surge_stops is distinct from old.surge_stops and tp_sec.route_closed(old) then
    select x.pid into added from (select distinct p->>'piece_id' pid from jsonb_array_elements(coalesce(new.surge_stops, '[]'::jsonb)) s,
                                          jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p where nullif(p->>'piece_id', '') is not null) x
     where not exists (select 1 from jsonb_array_elements(coalesce(old.surge_stops, '[]'::jsonb)) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
                        where p->>'piece_id' = x.pid) limit 1;
    if added is not null then
      raise exception 'TP_CLOSED: route % is staged and closed; box % goes to the next route batch', coalesce(old.title, old.id::text), added;
    end if;
  end if;
  if (new.driver_name is distinct from old.driver_name or new.driver_id is distinct from old.driver_id)
     and (new.driver_name is not null or new.driver_id is not null) then
    select pc.piece_id, pc.avoid_driver_name into avoid from public.piece_assignments a join public.pieces pc on pc.org_id = a.org_id and pc.piece_id = a.piece_id
     where a.job_id = new.id and a.released_at is null and pc.avoid_driver is not null
       and (pc.avoid_driver = new.driver_id::text or pc.avoid_driver = new.driver_name) limit 1;
    if avoid.piece_id is not null then
      raise exception 'TP_DENIED: box % came back damaged from this driver''s route; another driver takes this route', avoid.piece_id;
    end if;
  end if;
  return new;
end $$;
create trigger tp_recovery_rules before update on public.jobs for each row execute function tp_sec.jobs_recovery_rules();

-- 5: one pass of the investigations (the scheduler calls tp_svc_piece_tick)
create function tp_sec.piece_tick_once(p_now timestamptz) returns jsonb language plpgsql security definer set search_path = '' as $$
declare pc record; opened int := 0; lost int := 0; n_flagged int := 0; age interval; dr record;
begin
  -- not received back within 2 hours of the route ending, or still with a driver after the route ended with no report
  for pc in select p.*, a.released_at, a.job_id, j.title, j.driver_name
              from public.pieces p
              join lateral (select * from public.piece_assignments x where x.org_id = p.org_id and x.piece_id = p.piece_id order by x.assigned_at desc limit 1) a on true
              join public.jobs j on j.id = a.job_id
             where p.custody = 'with_driver' and p.investigation_opened_at is null and a.released_at is not null
               and a.released_at < p_now - interval '2 hours' loop
    update public.pieces set investigation_opened_at = p_now, investigation_level = 0,
           investigation_reason = case when pc.status = 'returning' then 'Reported not delivered, never received back' else 'Route ended without a delivery or a report' end,
           updated_at = p_now, version = version + 1
     where org_id = pc.org_id and piece_id = pc.piece_id;
    insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
    values (pc.org_id, 'investigation', pc.piece_id, pc.job_id::text, jsonb_build_object('route_title', pc.title, 'driver', pc.driver_name,
      'reason', case when pc.status = 'returning' then 'Reported not delivered, never received back' else 'Route ended without a delivery or a report' end, 'day', 0))
    on conflict do nothing;
    perform tp_sec.piece_event(pc.org_id, pc.piece_id, pc.job_id, 'investigation_opened', jsonb_build_object('driver', pc.driver_name));
    opened := opened + 1;
  end loop;
  -- escalation: day 1, day 3, lost on day 5
  for pc in select * from public.pieces where investigation_opened_at is not null and custody not in ('lost', 'delivered', 'warehouse_returns', 'returned_to_keel', 'cancelled') loop
    age := p_now - pc.investigation_opened_at;
    if age >= interval '5 days' then
      update public.pieces set custody = 'lost', investigation_level = 5, updated_at = p_now, version = version + 1 where org_id = pc.org_id and piece_id = pc.piece_id;
      perform tp_sec.release_piece(pc.org_id, pc.piece_id, 'lost');
      update public.dispatch_attention set resolved_at = p_now, resolved_by = 'system', resolution = 'declared lost after 5 days'
       where org_id = pc.org_id and kind = 'investigation' and piece_id = pc.piece_id and resolved_at is null;
      insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
      values (pc.org_id, 'piece_lost', pc.piece_id, pc.piece_id, jsonb_build_object('reason', pc.investigation_reason, 'opened', pc.investigation_opened_at))
      on conflict do nothing;
      perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'lost', jsonb_build_object('after_days', 5));
      lost := lost + 1;
    elsif (age >= interval '3 days' and pc.investigation_level < 3) or (age >= interval '1 day' and pc.investigation_level < 1) then
      update public.pieces set investigation_level = case when age >= interval '3 days' then 3 else 1 end, updated_at = p_now
       where org_id = pc.org_id and piece_id = pc.piece_id;
      update public.dispatch_attention set detail = detail || jsonb_build_object('day', case when age >= interval '3 days' then 3 else 1 end, 'escalated_at', p_now)
       where org_id = pc.org_id and kind = 'investigation' and piece_id = pc.piece_id and resolved_at is null;
      perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'investigation_escalated', jsonb_build_object('day', case when age >= interval '3 days' then 3 else 1 end));
    end if;
  end loop;
  -- 6: driver patterns worth a look (one open item per driver)
  for dr in select * from tp_sec.driver_pattern_rows(null, 14, p_now) r where r.flagged loop
    insert into public.dispatch_attention (org_id, kind, ref, detail)
    values (dr.org_id, 'driver_pattern', dr.driver, jsonb_build_object('driver', dr.driver, 'why', dr.why, 'attempts', dr.attempts, 'failures', dr.failures,
      'delivered_by_another', dr.delivered_by_another, 'unit_failures', dr.unit_failures, 'by_reason', dr.by_reason))
    on conflict do nothing;
    n_flagged := n_flagged + 1;
  end loop;
  return jsonb_build_object('opened', opened, 'lost', lost, 'flagged', n_flagged);
end $$;

-- per driver: attempts, failures by reason, failures another driver then delivered, failures at unit addresses
create function tp_sec.driver_pattern_rows(p_org uuid, p_days int, p_now timestamptz default now())
returns table (org_id uuid, driver text, attempts bigint, failures bigint, delivered_by_another bigint, unit_failures bigint, by_reason jsonb,
               fleet_rate numeric, flagged boolean, why text)
language sql stable security definer set search_path = '' as $$
  with a as (
    select x.org_id, coalesce(j.driver_name, '?') driver, x.piece_id, x.attempted, x.release_reason, x.assigned_at, x.job_id,
           (select st->>'unit' from jsonb_array_elements(coalesce(j.surge_stops, '[]'::jsonb)) st where (st->>'stop_number')::int = x.stop_number limit 1) unit,
           (select e.payload->>'reason' from public.events e where e.event_type = 'piece.not_delivered' and e.org_id = x.org_id and e.job_id = x.job_id
              and e.payload->>'piece_id' = x.piece_id order by e.id desc limit 1) reason
      from public.piece_assignments x join public.jobs j on j.id = x.job_id
     where x.assigned_at > p_now - make_interval(days => p_days) and (p_org is null or x.org_id = p_org) and j.driver_name is not null
       and (x.attempted or x.release_reason = 'delivered')),
  f as (
    select a.*, exists (select 1 from a b where b.org_id = a.org_id and b.piece_id = a.piece_id and b.assigned_at > a.assigned_at
                          and b.release_reason = 'delivered' and b.driver <> a.driver and not b.attempted) later_ok
      from a),
  d as (
    select org_id, driver, count(*) attempts, count(*) filter (where attempted) failures,
           count(*) filter (where attempted and later_ok) delivered_by_another,
           count(*) filter (where attempted and coalesce(unit, '') <> '') unit_failures,
           coalesce(jsonb_object_agg(coalesce(reason, 'unknown'), 1) filter (where attempted), '{}'::jsonb) reason_keys
      from f group by org_id, driver),
  r as (select org_id, driver, jsonb_object_agg(coalesce(reason, 'unknown'), n) by_reason
          from (select org_id, driver, reason, count(*) n from f where attempted group by 1, 2, 3) z group by 1, 2),
  fleet as (select org_id, sum(failures)::numeric / nullif(sum(attempts), 0) rate from d group by org_id)
  select d.org_id, d.driver, d.attempts, d.failures, d.delivered_by_another, d.unit_failures, coalesce(r.by_reason, '{}'::jsonb),
         round(coalesce(fl.rate, 0), 3),
         (d.delivered_by_another >= 3) or (d.failures >= 5 and d.attempts >= 20 and d.failures::numeric / d.attempts >= 2 * coalesce(fl.rate, 1)),
         concat_ws('; ',
           case when d.delivered_by_another >= 3 then d.delivered_by_another || ' boxes they could not deliver were delivered by another driver' end,
           case when d.failures >= 5 and d.attempts >= 20 and d.failures::numeric / d.attempts >= 2 * coalesce(fl.rate, 1)
                then 'failure rate ' || round(100.0 * d.failures / d.attempts) || '% against ' || round(100 * coalesce(fl.rate, 0)) || '% for the fleet' end)
    from d left join r on r.org_id = d.org_id and r.driver = d.driver left join fleet fl on fl.org_id = d.org_id;
$$;

create function public.tp_svc_piece_tick(p_now timestamptz default now()) returns jsonb language sql security definer set search_path = '' as $$
  select tp_sec.piece_tick_once(p_now);
$$;
revoke all on function public.tp_svc_piece_tick(timestamptz) from public, anon, authenticated;
grant execute on function public.tp_svc_piece_tick(timestamptz) to service_role;
do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('tp-piece-tick', '*/10 * * * *', 'select public.tp_svc_piece_tick()')$q$;
  end if;
end $cron$;

alter function public.tp_org(text,text,jsonb) rename to tp_org_v73;
alter function public.tp_org_v73(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v73(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; res jsonb; pc public.pieces; j public.jobs; src record; cond text;
        stops jsonb; at int; pid text; prev public.jobs;
begin
  if p_action = 'receive_return' then
    -- the three answers; an older screen's "damaged" means the contents
    cond := case coalesce(nullif(a->>'condition', ''), 'intact') when 'damaged' then 'contents_damaged' else coalesce(nullif(a->>'condition', ''), 'intact') end;
    if cond not in ('intact', 'carton_damaged', 'contents_damaged') then raise exception 'TP_INVALID: condition must be intact, carton_damaged or contents_damaged'; end if;
    s := tp_sec.session(p_token, 'org'); org := s.org_key;
    pid := upper(trim(coalesce(a->>'piece_id', '')));
    select * into pc from public.pieces p where p.org_id::text = org and p.piece_id in (pid, trim(coalesce(a->>'piece_id', ''))) limit 1;
    -- a missing or lost box found: the investigation closes
    if pc.piece_id is not null and pc.custody = 'lost' then
      update public.pieces set custody = 'with_driver' where org_id = pc.org_id and piece_id = pc.piece_id;
    end if;
    select j2.* into prev from public.piece_assignments x join public.jobs j2 on j2.id = x.job_id
     where x.org_id = pc.org_id and x.piece_id = pc.piece_id order by x.assigned_at desc limit 1;
    res := tp_sec.tp_org_v73(p_token, p_action, a || jsonb_build_object('condition', case cond when 'contents_damaged' then 'damaged' else 'intact' end));
    if coalesce((res->>'replayed')::boolean, false) then return res; end if;
    update public.pieces set
        hold = case cond when 'carton_damaged' then 'rebox' when 'contents_damaged' then 'contents_damaged' else null end,
        condition = case cond when 'intact' then 'intact' else 'damaged' end,
        avoid_driver = case when cond = 'carton_damaged' then coalesce(prev.driver_id::text, prev.driver_name) else avoid_driver end,
        avoid_driver_name = case when cond = 'carton_damaged' then prev.driver_name else avoid_driver_name end,
        investigation_opened_at = null, investigation_level = 0, investigation_reason = null
     where org_id::text = org and piece_id = res->>'piece_id' returning * into pc;
    update public.dispatch_attention set resolved_at = now(), resolved_by = 'returns scan', resolution = 'received back'
     where org_id::text = org and piece_id = pc.piece_id and kind in ('investigation', 'piece_lost') and resolved_at is null;
    if cond = 'contents_damaged' then
      insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
      values (pc.org_id, 'contents_damaged', pc.piece_id, pc.piece_id, jsonb_build_object('reason', 'Contents damaged: problem-solving station'))
      on conflict do nothing;
    end if;
    perform tp_sec.piece_event(pc.org_id, pc.piece_id, prev.id, 'condition', jsonb_build_object('condition', cond));
    return res || jsonb_build_object('condition', cond, 'hold', pc.hold, 'avoid_driver', pc.avoid_driver_name,
      'next', case cond when 'carton_damaged' then 'rebox' when 'contents_damaged' then 'problem_station' else 'next_route' end);
  end if;

  if p_action = 'pieces' then                    -- 73's answer, plus any investigation (Keel tells the merchant)
    res := tp_sec.tp_org_v73(p_token, p_action, p_args);
    s := tp_sec.session(p_token, 'org');
    select coalesce(jsonb_agg(x || coalesce((select jsonb_build_object('investigation', pc2.investigation_reason, 'investigation_day', pc2.investigation_level,
             'investigation_opened_at', pc2.investigation_opened_at)
             from public.pieces pc2 where pc2.org_id::text = s.org_key and pc2.piece_id = x->>'piece_id' and pc2.investigation_opened_at is not null), '{}'::jsonb)), '[]'::jsonb)
      into res from jsonb_array_elements(res) x;
    return res;
  end if;

  if p_action not in ('rebox_done', 'mark_found', 'assign_piece', 'piece_candidates', 'driver_patterns', 'reprint_label') then
    return tp_sec.tp_org_v73(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;
  pid := upper(trim(coalesce(a->>'piece_id', '')));
  if p_action in ('rebox_done', 'mark_found', 'assign_piece', 'piece_candidates', 'reprint_label') then
    select * into pc from public.pieces p where p.org_id::text = org and p.piece_id in (pid, trim(coalesce(a->>'piece_id', ''))) limit 1;
    if pc.piece_id is null then raise exception 'TP_INVALID: this box is not known to TackPath'; end if;
  end if;

  if p_action = 'rebox_done' then                -- the contents are in a new carton with the same label
    if pc.hold is distinct from 'rebox' then return jsonb_build_object('ok', true, 'replayed', true, 'piece_id', pc.piece_id, 'hold', pc.hold); end if;
    update public.pieces set hold = null, condition = 'intact', updated_at = now(), version = version + 1
     where org_id = pc.org_id and piece_id = pc.piece_id returning * into pc;
    perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'reboxed', jsonb_build_object('by', left(coalesce(a->>'by', 'warehouse'), 80)));
    return jsonb_build_object('ok', true, 'piece_id', pc.piece_id, 'avoid_driver', pc.avoid_driver_name);
  end if;

  if p_action = 'reprint_label' then             -- the same barcode and the stop it belongs to, for a new label
    select st, j2.title, j2.id into src from public.jobs j2, jsonb_array_elements(j2.surge_stops) st
     where j2.org_id = pc.org_id and (exists (select 1 from jsonb_array_elements(coalesce(st->'pkgs', '[]'::jsonb)) p where p->>'piece_id' = pc.piece_id)
        or exists (select 1 from jsonb_array_elements(coalesce(st->'returned_pkgs', '[]'::jsonb)) p where p->>'piece_id' = pc.piece_id))
     order by j2.created_at desc limit 1;
    perform tp_sec.piece_event(pc.org_id, pc.piece_id, src.id, 'label_reprinted', '{}'::jsonb);
    return jsonb_build_object('ok', true, 'piece_id', pc.piece_id, 'order_id', pc.keel_ref, 'recipient', src.st->>'recipient', 'address', src.st->>'address',
      'unit', src.st->>'unit', 'attempts', pc.attempts);
  end if;

  if p_action = 'mark_found' then
    if pc.investigation_opened_at is null and pc.custody <> 'lost' then return jsonb_build_object('ok', true, 'replayed', true); end if;
    update public.pieces set custody = case when custody = 'lost' then 'warehouse_returns' else custody end,
           investigation_opened_at = null, investigation_level = 0, investigation_reason = null, updated_at = now(), version = version + 1
     where org_id = pc.org_id and piece_id = pc.piece_id returning * into pc;
    update public.dispatch_attention set resolved_at = now(), resolved_by = left(coalesce(a->>'by', 'dispatcher'), 120), resolution = left(coalesce(a->>'note', 'found'), 500)
     where org_id = pc.org_id and piece_id = pc.piece_id and kind in ('investigation', 'piece_lost') and resolved_at is null;
    perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'found', jsonb_build_object('note', left(a->>'note', 300)));
    return jsonb_build_object('ok', true, 'piece_id', pc.piece_id, 'custody', pc.custody);
  end if;

  if p_action = 'driver_patterns' then
    select coalesce(jsonb_agg(to_jsonb(r) - 'org_id' order by r.flagged desc, r.failures desc), '[]'::jsonb) into res
      from tp_sec.driver_pattern_rows(org::uuid, least(greatest(coalesce((a->>'days')::int, 14), 1), 90)) r;
    return res;
  end if;

  -- where the box is going: the stop it came from (kept on its old route under returned_pkgs)
  select st, j2.id job_id into src from public.jobs j2, jsonb_array_elements(j2.surge_stops) st
   where j2.org_id = pc.org_id and exists (select 1 from jsonb_array_elements(coalesce(st->'returned_pkgs', '[]'::jsonb) || coalesce(st->'pkgs', '[]'::jsonb)) p where p->>'piece_id' = pc.piece_id)
   order by j2.created_at desc limit 1;

  if p_action = 'piece_candidates' then        -- open routes in the same ZIP code, oldest first
    select coalesce(jsonb_agg(jsonb_build_object('job_id', j2.id, 'title', j2.title, 'status', j2.status, 'stops', j2.total_stops, 'driver', j2.driver_name,
             'avoided_driver', pc.avoid_driver is not null and (pc.avoid_driver in (j2.driver_id::text, j2.driver_name))) order by j2.created_at), '[]'::jsonb)
      into res from public.jobs j2
     where j2.org_id = pc.org_id and tp_sec.route_is_live(j2) and not tp_sec.route_closed(j2) and j2.id is distinct from src.job_id
       and exists (select 1 from jsonb_array_elements(coalesce(j2.surge_stops, '[]'::jsonb)) st2
                    where substring(st2->>'address' from '(\d{5})(?:-\d{4})?\s*$') = substring(src.st->>'address' from '(\d{5})(?:-\d{4})?\s*$'));
    return res;
  end if;

  -- assign_piece: the box joins an open route. One at a time per company (the publication gate's lock), and the
  -- box's record re-read under lock: two people putting the same box on two routes at once, only one succeeds.
  perform pg_advisory_xact_lock(hashtext('tp_publish:' || pc.org_id::text));
  select * into pc from public.pieces p where p.org_id = pc.org_id and p.piece_id = pc.piece_id for update;
  if pc.custody not in ('warehouse_returns', 'awaiting_route') or pc.hold is not null or pc.current_assignment_id is not null then
    raise exception 'TP_STATE: box % is not ready for a route (%)', pc.piece_id, pc.custody || coalesce(', hold ' || pc.hold, '');
  end if;
  select * into j from public.jobs where id::text = a->>'job_id' and org_id = pc.org_id for update;
  if j.id is null then raise exception 'TP_DENIED: not one of your routes'; end if;
  if not tp_sec.route_is_live(j) or tp_sec.route_closed(j) then raise exception 'TP_CLOSED: route % is staged or out; the box goes to the next route batch', j.title; end if;
  if pc.avoid_driver is not null and pc.avoid_driver in (j.driver_id::text, j.driver_name) then
    raise exception 'TP_DENIED: box % came back damaged from this driver''s route; choose another route', pc.piece_id;
  end if;
  if src.st is null then raise exception 'TP_INVALID: no delivery address is known for box %', pc.piece_id; end if;
  -- same address on the route: the box joins that stop; otherwise a new last stop
  select n into at from jsonb_array_elements(j.surge_stops) with ordinality t(st, n) where lower(st->>'address') = lower(src.st->>'address') limit 1;
  if at is not null then
    select jsonb_agg(case when n = at then jsonb_set(st, '{pkgs}', coalesce(st->'pkgs', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('order_id', pc.keel_ref,
             'tracking_number', pc.piece_id, 'piece_id', pc.piece_id, 'required_count', 1))) else st end order by n)
      into stops from jsonb_array_elements(j.surge_stops) with ordinality t(st, n);
  else
    stops := j.surge_stops || jsonb_build_array((src.st - 'returned_pkgs') || jsonb_build_object('stop_number', jsonb_array_length(j.surge_stops) + 1,
             'pkgs', jsonb_build_array(jsonb_build_object('order_id', pc.keel_ref, 'tracking_number', pc.piece_id, 'piece_id', pc.piece_id, 'required_count', 1))));
  end if;
  update public.jobs set surge_stops = stops, total_stops = jsonb_array_length(stops), total_packages = coalesce(total_packages, 0) + 1 where id = j.id;
  return jsonb_build_object('ok', true, 'piece_id', pc.piece_id, 'job_id', j.id, 'title', j.title, 'joined_stop', at);
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
revoke all on function tp_sec.route_closed(public.jobs), tp_sec.jobs_recovery_rules(), tp_sec.piece_tick_once(timestamptz),
  tp_sec.driver_pattern_rows(uuid, int, timestamptz) from public, anon, authenticated;

commit;
