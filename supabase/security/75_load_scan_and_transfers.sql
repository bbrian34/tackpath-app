-- Migration 75: per-box load scanning, driver custody, driver-to-driver transfers, holds, and the
-- exception feed Keel reads (one exception lifecycle across Keel and TackPath).
--
-- 1. Load scan (tp_driver load_scan / load_status / load_remove). The driver scans every box into the
--    van. Each scan is checked against the route: the box is on this route (loaded; custody with_driver,
--    custody driver recorded), already loaded (duplicate, nothing changes), on ANOTHER route (wrong
--    route), or unknown. Wrong-route and unknown boxes are load discrepancies; the driver hands them back
--    (load_remove) or a dispatcher resolves them.
-- 2. Departure gate. Once a route's loading is scanned box by box, it cannot go out (in_transit /
--    picked up) while boxes are missing or a load discrepancy is open, unless a dispatcher resolves it
--    (tp_org resolve_load: allow_departure, or remove_missing, which takes the missing boxes off the
--    route and opens a missing-at-load search). A route that leaves with no load scan at all (an older
--    driver app) is not blocked; it is listed as "departure not verified".
-- 3. Driver custody: pieces.custody_driver is the driver who has the box, set by the load scan, at
--    departure, and by a transfer.
-- 4. Transfers (breakdown, interrupted route, partial). The driver reports they cannot continue
--    (tp_driver cant_continue). A dispatcher starts a transfer to another driver (tp_org start_transfer:
--    all undelivered boxes, or some). The transfer creates a NEW rescue route for the receiving driver:
--    no box is ever added to a staged or departed route. The receiving driver scans each box
--    (tp_driver transfer_scan): in one transaction the box leaves the old route (assignment closed,
--    reason transferred), joins the rescue route, is loaded, and custody moves to the receiving driver.
--    A partial transfer is closed by the dispatcher (close_transfer); unscanned boxes stay with the
--    first driver. Identity, barcode, attempts and history are kept.
-- 5. Holds from Keel (tp_org hold_piece / release_hold): a box on hold is never put on a route; a
--    route published with it is published without it (listed under Needs attention).
-- 6. Exception feed (tp_org exceptions_feed): every Needs attention item created, changed or resolved
--    since a time, for Keel's exception queue; resolutions flow back with attention_resolve.
-- tp_org and tp_driver are wrapped like 60-74 (tp_sec.tp_org_v74, tp_sec.tp_driver_v69). Needs 74.
-- Roll back with 75_load_scan_and_transfers.rollback.sql.
begin;
do $pre$ begin
  if to_regprocedure('tp_sec.piece_tick_once(timestamptz)') is null then raise exception 'Migration 74 is not applied. Nothing was changed.'; end if;
  if to_regclass('public.transfers') is not null then raise exception 'Migration 75 is already applied. Nothing was changed.'; end if;
end $pre$;

-- 0. Fix to 73's route sync: once a stop was delivered, any later change of that route (a box received back,
--    a box transferred) re-opened the delivered boxes on it. The sync in place is saved for the rollback.
create table tp_sec.m75_saved (name text primary key, def text not null);
insert into tp_sec.m75_saved values ('sync_route_pieces', pg_get_functiondef('tp_sec.sync_route_pieces(uuid)'::regprocedure));
create or replace function tp_sec.sync_route_pieces(p_job uuid) returns void language plpgsql security definer set search_path = '' as $$
declare j public.jobs; r record; asg public.piece_assignments; other public.jobs; want text[] := '{}';
begin
  select * into j from public.jobs where id = p_job;
  if j.id is null or j.org_id is null then return; end if;
  if not tp_sec.route_is_live(j) then
    -- the route is over: close what is still open; a box still in the warehouse waits for a route
    for asg in select * from public.piece_assignments a where a.job_id = j.id and a.released_at is null loop
      perform tp_sec.release_piece(j.org_id, asg.piece_id,
        case when coalesce(j.archived, false) then 'archived' when j.status = 'cancelled' then 'cancelled' else 'route_finished' end,
        (select case when p.custody in ('assigned', 'in_bin') then 'awaiting_route' end from public.pieces p where p.org_id = j.org_id and p.piece_id = asg.piece_id));
    end loop;
    return;
  end if;
  for r in select distinct on (p->>'piece_id') p->>'piece_id' piece_id, p->>'order_id' order_id,
                  coalesce((s->>'stop_number')::int, s_n::int) stop_number
             from jsonb_array_elements(coalesce(j.surge_stops, '[]'::jsonb)) with ordinality as st(s, s_n),
                  jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
            where nullif(p->>'piece_id', '') is not null
            order by p->>'piece_id', s_n loop
    want := want || r.piece_id;
    -- (75) a box released from this route (delivered, returned, transferred, removed) never rejoins it by
    -- itself, and a delivered or lost box is never put on a route again by a route change
    if exists (select 1 from public.piece_assignments x where x.org_id = j.org_id and x.piece_id = r.piece_id and x.job_id = j.id and x.released_at is not null)
       or exists (select 1 from public.pieces x where x.org_id = j.org_id and x.piece_id = r.piece_id and x.custody in ('delivered', 'lost', 'returned_to_keel', 'cancelled')) then
      continue;
    end if;
    insert into public.pieces (org_id, piece_id, keel_ref, custody) values (j.org_id, r.piece_id, r.order_id, 'handed_off')
    on conflict (org_id, piece_id) do nothing;
    select * into asg from public.piece_assignments a where a.org_id = j.org_id and a.piece_id = r.piece_id and a.released_at is null;
    if asg.id is not null and asg.job_id = j.id then
      if asg.stop_number is distinct from r.stop_number then update public.piece_assignments set stop_number = r.stop_number where id = asg.id; end if;
      continue;
    end if;
    if asg.id is not null then
      select * into other from public.jobs where id = asg.job_id;
      if other.id is not null and tp_sec.route_is_live(other) then
        -- never on two live routes: listed for the dispatcher instead
        insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
        values (j.org_id, 'piece_conflict', r.piece_id, coalesce(j.master_code, j.id::text),
                jsonb_build_object('live_job_id', other.id, 'live_job_title', other.title, 'route_title', j.title, 'job_id', j.id))
        on conflict do nothing;
        continue;
      end if;
      perform tp_sec.release_piece(j.org_id, r.piece_id, 'route_finished');
    end if;
    insert into public.piece_assignments (org_id, piece_id, job_id, stop_number) values (j.org_id, r.piece_id, j.id, r.stop_number) returning * into asg;
    update public.pieces set current_assignment_id = asg.id,
           custody = case when custody in ('in_bin', 'with_driver') then custody else 'assigned' end,
           keel_ref = coalesce(keel_ref, r.order_id), updated_at = now(), version = version + 1
     where org_id = j.org_id and piece_id = r.piece_id;
    perform tp_sec.piece_event(j.org_id, r.piece_id, j.id, 'assigned', jsonb_build_object('stop_number', r.stop_number, 'route', j.title));
  end loop;
  -- boxes taken off the route
  for asg in select * from public.piece_assignments a where a.job_id = j.id and a.released_at is null and not (a.piece_id = any(want)) loop
    perform tp_sec.release_piece(j.org_id, asg.piece_id, 'removed_from_route',
      (select case when p.custody in ('assigned', 'in_bin') then 'awaiting_route' end from public.pieces p where p.org_id = j.org_id and p.piece_id = asg.piece_id));
  end loop;
  -- picked up: everything still on the route is with the driver
  if j.picked_up_at is not null or j.status = 'in_transit' then
    update public.pieces p set custody = 'with_driver', updated_at = now(), version = p.version + 1
      from public.piece_assignments a
     where a.job_id = j.id and a.released_at is null and p.org_id = a.org_id and p.piece_id = a.piece_id and p.custody in ('assigned', 'in_bin');
  end if;
end $$;

alter table public.piece_assignments add column loaded_units integer not null default 0, add column loaded_at timestamptz, add column loaded_by text;
alter table public.pieces add column custody_driver text;
alter table public.jobs add column load_override_at timestamptz, add column load_override_by text, add column load_override_note text;
alter table public.dispatch_attention add column job_id uuid, add column updated_at timestamptz not null default now();
alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed', 'piece_conflict',
  'investigation', 'piece_lost', 'driver_pattern', 'contents_damaged',
  'load_wrong_route', 'load_unknown', 'load_missing', 'departure_unverified', 'cant_continue', 'transfer', 'piece_on_hold'));
create index dispatch_attention_updated on public.dispatch_attention (org_id, updated_at);
create function tp_sec.attention_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger tp_attention_touch before update on public.dispatch_attention for each row execute function tp_sec.attention_touch();

create table public.transfers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  from_job_id   uuid not null,
  to_job_id     uuid not null,
  from_driver   text,
  to_driver     text not null,
  pieces        text[] not null,
  scanned       text[] not null default '{}',
  status        text not null default 'open' check (status in ('open', 'complete', 'closed_partial', 'cancelled')),
  reason        text,
  created_by    text,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  note          text
);
create index transfers_open on public.transfers (org_id, status);
alter table public.transfers enable row level security;
revoke all on public.transfers from public, anon, authenticated;

-- how many boxes the route expects for one barcode (a shared label can cover several boxes)
create function tp_sec.route_required(p_job uuid, p_piece text) returns integer language sql stable set search_path = '' as $$
  select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int
    from public.jobs j, jsonb_array_elements(coalesce(j.surge_stops, '[]'::jsonb)) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
   where j.id = p_job and p->>'piece_id' = p_piece;
$$;

-- the route's loading: expected boxes, what is in the van, what is missing, open discrepancies
create function tp_sec.load_state(p_job uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  with e as (select a.piece_id, a.stop_number, greatest(tp_sec.route_required(a.job_id, a.piece_id), 1) required, a.loaded_units, a.loaded_at
               from public.piece_assignments a where a.job_id = p_job and a.released_at is null),
       d as (select x.id, x.kind, x.piece_id, x.detail from public.dispatch_attention x
              where x.job_id = p_job and x.resolved_at is null and x.kind in ('load_wrong_route', 'load_unknown'))
  select jsonb_build_object(
    'expected', (select count(*) from e), 'loaded', (select count(*) from e where loaded_units >= required),
    'missing', coalesce((select jsonb_agg(jsonb_build_object('piece_id', piece_id, 'stop_number', stop_number, 'required', required, 'loaded_units', loaded_units) order by stop_number, piece_id)
                           from e where loaded_units < required), '[]'::jsonb),
    'discrepancies', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'piece_id', piece_id) || detail) from d), '[]'::jsonb),
    'scanning_started', exists (select 1 from e where loaded_at is not null) or exists (select 1 from public.dispatch_attention x where x.job_id = p_job and x.kind in ('load_wrong_route', 'load_unknown')),
    'override', (select load_override_at is not null from public.jobs where id = p_job),
    'can_depart', (select load_override_at is not null from public.jobs where id = p_job)
                  or (not exists (select 1 from e where loaded_units < required) and not exists (select 1 from d)));
$$;

-- one box scanned into a van (driver load scan, or the receiving driver of a transfer)
create function tp_sec.load_piece(j public.jobs, p_code text, p_driver text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare asg public.piece_assignments; pc public.pieces; other public.jobs; req int; code text := upper(trim(coalesce(p_code, '')));
begin
  select * into asg from public.piece_assignments a where a.job_id = j.id and a.released_at is null and a.piece_id in (code, trim(p_code)) for update;
  if asg.id is not null then
    req := greatest(tp_sec.route_required(j.id, asg.piece_id), 1);
    if asg.loaded_units >= req then
      return jsonb_build_object('ok', true, 'result', 'already_loaded', 'piece_id', asg.piece_id, 'stop_number', asg.stop_number, 'units', asg.loaded_units, 'required', req);
    end if;
    update public.piece_assignments set loaded_units = loaded_units + 1, loaded_at = coalesce(loaded_at, now()), loaded_by = p_driver where id = asg.id returning * into asg;
    update public.pieces set custody = 'with_driver', custody_driver = p_driver, updated_at = now(), version = version + 1
     where org_id = asg.org_id and piece_id = asg.piece_id;
    -- a box once reported missing at load and now scanned: its search ends
    update public.dispatch_attention set resolved_at = now(), resolved_by = 'load scan', resolution = 'scanned into the van'
     where org_id = asg.org_id and piece_id = asg.piece_id and kind = 'load_missing' and resolved_at is null;
    if asg.loaded_units = 1 then perform tp_sec.piece_event(asg.org_id, asg.piece_id, j.id, 'loaded', jsonb_build_object('driver', p_driver, 'stop_number', asg.stop_number)); end if;
    return jsonb_build_object('ok', true, 'result', 'loaded', 'piece_id', asg.piece_id, 'stop_number', asg.stop_number, 'units', asg.loaded_units, 'required', req);
  end if;
  select * into pc from public.pieces p where p.org_id = j.org_id and p.piece_id in (code, trim(p_code)) limit 1;
  if pc.piece_id is not null then
    select j2.* into other from public.piece_assignments a join public.jobs j2 on j2.id = a.job_id
     where a.org_id = pc.org_id and a.piece_id = pc.piece_id and a.released_at is null limit 1;
    insert into public.dispatch_attention (org_id, kind, piece_id, ref, job_id, detail)
    values (j.org_id, 'load_wrong_route', pc.piece_id, j.id::text, j.id, jsonb_build_object('route_title', j.title, 'driver', p_driver,
      'belongs_to', other.title, 'belongs_to_job_id', other.id, 'custody', pc.custody))
    on conflict do nothing;
    return jsonb_build_object('ok', false, 'result', 'wrong_route', 'piece_id', pc.piece_id, 'belongs_to', other.title, 'custody', pc.custody);
  end if;
  insert into public.dispatch_attention (org_id, kind, piece_id, ref, job_id, detail)
  values (j.org_id, 'load_unknown', code, j.id::text, j.id, jsonb_build_object('route_title', j.title, 'driver', p_driver))
  on conflict do nothing;
  return jsonb_build_object('ok', false, 'result', 'unknown', 'piece_id', code);
end $$;

-- 2: the departure gate, and 5: boxes on hold never join a route; additions to a closed route only through a transfer
create function tp_sec.jobs_load_rules() returns trigger language plpgsql security definer set search_path = '' as $$
declare st jsonb; held text[]; drv text;
begin
  -- 5: strip boxes on a Keel hold from a route being written (new boxes only)
  if new.surge_stops is not null and (tg_op = 'INSERT' or new.surge_stops is distinct from old.surge_stops) then
    select coalesce(array_agg(distinct p->>'piece_id'), '{}') into held
      from jsonb_array_elements(new.surge_stops) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
      join public.pieces pc on pc.org_id = new.org_id and pc.piece_id = p->>'piece_id' and pc.hold like 'keel:%'
     where tg_op = 'INSERT' or not exists (select 1 from jsonb_array_elements(coalesce(old.surge_stops, '[]'::jsonb)) s0,
                                             jsonb_array_elements(coalesce(s0->'pkgs', '[]'::jsonb)) p0 where p0->>'piece_id' = p->>'piece_id');
    if cardinality(held) > 0 then
      new.surge_stops := coalesce((select jsonb_agg(x order by n) from (
          select jsonb_set(s, '{pkgs}', coalesce((select jsonb_agg(p) from jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p where not (p->>'piece_id' = any(held))), '[]'::jsonb)) x, n
            from jsonb_array_elements(new.surge_stops) with ordinality t(s, n)) z
         where jsonb_array_length(x->'pkgs') > 0 or not exists (select 1 from jsonb_array_elements(new.surge_stops) with ordinality t2(s2, n2) where n2 = z.n and jsonb_array_length(coalesce(s2->'pkgs', '[]'::jsonb)) > 0)), '[]'::jsonb);
      new.total_packages := (select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int from jsonb_array_elements(new.surge_stops) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p);
      new.total_stops := jsonb_array_length(new.surge_stops);
      insert into public.dispatch_attention (org_id, kind, piece_id, ref, detail)
      select new.org_id, 'piece_on_hold', h, coalesce(new.master_code, new.id::text), jsonb_build_object('route_title', new.title,
             'reason', (select substring(hold from 6) from public.pieces where org_id = new.org_id and piece_id = h))
        from unnest(held) h
      on conflict do nothing;
    end if;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  -- 2: going out
  if (new.status = 'in_transit' and old.status is distinct from 'in_transit') or (new.picked_up_at is not null and old.picked_up_at is null) then
    st := tp_sec.load_state(new.id);
    if (st->>'scanning_started')::boolean and not (st->>'can_depart')::boolean then
      raise exception 'TP_LOAD: route % cannot leave: % box(es) not scanned into the van, % load problem(s) open; finish the load scan or ask dispatch',
        coalesce(new.title, new.id::text), jsonb_array_length(st->'missing'), jsonb_array_length(st->'discrepancies');
    end if;
    drv := coalesce(new.driver_name, old.driver_name);
    update public.pieces p set custody_driver = drv
      from public.piece_assignments a where a.job_id = new.id and a.released_at is null and p.org_id = a.org_id and p.piece_id = a.piece_id;
    if not (st->>'scanning_started')::boolean and (st->>'expected')::int > 0 then
      insert into public.dispatch_attention (org_id, kind, ref, job_id, detail)
      values (new.org_id, 'departure_unverified', new.id::text, new.id, jsonb_build_object('route_title', new.title, 'driver', drv, 'boxes', st->'expected'))
      on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
create trigger tp_load_rules before insert or update on public.jobs for each row execute function tp_sec.jobs_load_rules();

-- the closed-route rule (74) lets a transfer add boxes to its own rescue route: 74's trigger runs first and
-- refuses; the rescue route is created open ('assigned', not staged), so additions there are allowed by 74.

-- 4: move one box from its old route to the rescue route (receiving driver's scan)
create function tp_sec.transfer_piece(t public.transfers, p_code text, p_driver text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare code text := upper(trim(coalesce(p_code, ''))); pid text; src public.jobs; dst public.jobs; stop jsonb; pk jsonb; stops jsonb; at int; res jsonb;
begin
  select x into pid from unnest(t.pieces) x where x in (code, trim(p_code)) limit 1;
  if pid is null then return jsonb_build_object('ok', false, 'result', 'not_in_transfer', 'piece_id', code); end if;
  if pid = any(t.scanned) then return jsonb_build_object('ok', true, 'result', 'already_received', 'piece_id', pid); end if;
  select * into src from public.jobs where id = t.from_job_id for update;
  select * into dst from public.jobs where id = t.to_job_id for update;
  -- the stop and the box on the old route
  select s, p into stop, pk from jsonb_array_elements(coalesce(src.surge_stops, '[]'::jsonb)) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p
   where p->>'piece_id' = pid limit 1;
  if pk is null then return jsonb_build_object('ok', false, 'result', 'not_on_old_route', 'piece_id', pid); end if;
  -- off the old route (taking a box off a route is always allowed)
  select coalesce(jsonb_agg(z order by n), '[]'::jsonb) into stops from (
    select jsonb_set(s, '{pkgs}', coalesce((select jsonb_agg(p) from jsonb_array_elements(s->'pkgs') p where p->>'piece_id' <> pid), '[]'::jsonb))
             || case when exists (select 1 from jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p where p->>'piece_id' = pid)
                     then jsonb_build_object('transferred_pkgs', coalesce(s->'transferred_pkgs', '[]'::jsonb) || jsonb_build_array(pk || jsonb_build_object('to_driver', p_driver, 'at', now())))
                     else '{}'::jsonb end z, n
      from jsonb_array_elements(src.surge_stops) with ordinality t2(s, n)) q;
  update public.jobs set surge_stops = stops where id = src.id;
  -- onto the rescue route, at the same address if it already has that stop
  select n into at from jsonb_array_elements(coalesce(dst.surge_stops, '[]'::jsonb)) with ordinality t3(s, n) where lower(s->>'address') = lower(stop->>'address') limit 1;
  if at is not null then
    select jsonb_agg(case when n = at then jsonb_set(s, '{pkgs}', coalesce(s->'pkgs', '[]'::jsonb) || jsonb_build_array(pk)) else s end order by n)
      into stops from jsonb_array_elements(dst.surge_stops) with ordinality t4(s, n);
  else
    stops := coalesce(dst.surge_stops, '[]'::jsonb) || jsonb_build_array((stop - 'transferred_pkgs' - 'returned_pkgs')
             || jsonb_build_object('stop_number', jsonb_array_length(coalesce(dst.surge_stops, '[]'::jsonb)) + 1, 'pkgs', jsonb_build_array(pk)));
  end if;
  update public.jobs set surge_stops = stops, total_stops = jsonb_array_length(stops),
         total_packages = (select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int from jsonb_array_elements(stops) s, jsonb_array_elements(coalesce(s->'pkgs', '[]'::jsonb)) p)
   where id = dst.id returning * into dst;
  -- the sync (73) closed the old assignment and opened the new one; this scan is its load scan
  update public.piece_assignments set release_reason = 'transferred' where org_id = t.org_id and piece_id = pid and job_id = src.id and release_reason = 'removed_from_route';
  update public.piece_assignments set loaded_units = greatest(tp_sec.route_required(dst.id, pid), 1), loaded_at = now(), loaded_by = p_driver
   where org_id = t.org_id and piece_id = pid and job_id = dst.id and released_at is null;
  update public.pieces set custody = 'with_driver', custody_driver = p_driver, updated_at = now(), version = version + 1 where org_id = t.org_id and piece_id = pid;
  perform tp_sec.piece_event(t.org_id, pid, dst.id, 'transferred', jsonb_build_object('from_driver', t.from_driver, 'to_driver', p_driver, 'from_job_id', src.id));
  update public.transfers set scanned = scanned || pid where id = t.id returning * into t;
  res := jsonb_build_object('ok', true, 'result', 'received', 'piece_id', pid, 'scanned', cardinality(t.scanned), 'total', cardinality(t.pieces));
  if cardinality(t.scanned) >= cardinality(t.pieces) then
    perform tp_sec.finish_transfer(t, 'complete', null);
    res := res || jsonb_build_object('complete', true, 'job_id', dst.id);
  end if;
  return res;
end $$;

create function tp_sec.finish_transfer(t public.transfers, p_status text, p_note text) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.transfers set status = p_status, closed_at = now(), note = coalesce(p_note, note) where id = t.id;
  -- the old route has nothing left: it is over; a rescue route that received nothing is cancelled
  if not exists (select 1 from public.piece_assignments a where a.job_id = t.from_job_id and a.released_at is null) then
    update public.jobs set status = 'completed_with_exceptions' where id = t.from_job_id and status not in ('delivered', 'completed_with_exceptions', 'cancelled');
  end if;
  if not exists (select 1 from public.piece_assignments a where a.job_id = t.to_job_id and a.released_at is null) then
    update public.jobs set status = 'cancelled' where id = t.to_job_id and status not in ('delivered', 'completed_with_exceptions', 'cancelled');
  end if;
  update public.dispatch_attention set resolved_at = now(), resolved_by = 'transfer', resolution = 'transfer ' || p_status || ': ' || cardinality(t.scanned) || ' of ' || cardinality(t.pieces) || ' boxes moved'
   where org_id = t.org_id and kind in ('cant_continue', 'transfer') and job_id = t.from_job_id and resolved_at is null;
end $$;

-- ── tp_driver ───────────────────────────────────────────────────────────────
alter function public.tp_driver(text,text,jsonb) rename to tp_driver_v69;
alter function public.tp_driver_v69(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_driver_v69(text,text,jsonb) from public, anon, authenticated;

create function public.tp_driver(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); jid text := coalesce(a->>'id', a->>'job_id'); s tp_sec.sessions; j public.jobs; t public.transfers; res jsonb;
begin
  if p_action not in ('load_scan', 'load_status', 'load_remove', 'cant_continue', 'transfers', 'transfer_scan') then
    return tp_sec.tp_driver_v69(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'driver');

  if p_action = 'transfers' then        -- transfers waiting for this driver to receive
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'from_driver', x.from_driver, 'from_route', (select title from public.jobs where id = x.from_job_id),
             'to_job_id', x.to_job_id, 'pieces', to_jsonb(x.pieces), 'scanned', to_jsonb(x.scanned), 'reason', x.reason, 'created_at', x.created_at) order by x.created_at), '[]'::jsonb)
      into res from public.transfers x join public.jobs dj on dj.id = x.to_job_id
     where x.status = 'open' and tp_sec.route_is_mine(s, dj);
    return res;
  end if;
  if p_action = 'transfer_scan' then
    select * into t from public.transfers where id::text = a->>'transfer_id' for update;
    if t.id is null or t.status <> 'open' then raise exception 'TP_STATE: this transfer is not open'; end if;
    select * into j from public.jobs where id = t.to_job_id;
    if not tp_sec.route_is_mine(s, j) then raise exception 'TP_DENIED: this transfer is for another driver'; end if;
    return tp_sec.transfer_piece(t, a->>'code', s.driver_name);
  end if;

  -- the rest act on one of the driver's own routes (company, archived and ownership checks of the gateway in place)
  perform tp_sec.tp_driver_v69(p_token, 'job', jsonb_build_object('id', jid));
  select * into j from public.jobs where id::text = jid;
  if j.id is null or not tp_sec.route_is_mine(s, j) then raise exception 'TP_DENIED: not your route'; end if;

  if p_action = 'load_scan' then
    if tp_sec.route_closed(j) and j.status in ('delivered', 'completed_with_exceptions', 'cancelled') then raise exception 'TP_STATE: this route is finished'; end if;
    res := tp_sec.load_piece(j, a->>'code', s.driver_name);      -- its own statement: the state below sees this scan
    return res || jsonb_build_object('load', tp_sec.load_state(j.id));
  end if;
  if p_action = 'load_status' then return tp_sec.load_state(j.id); end if;
  if p_action = 'load_remove' then      -- the driver hands back a box that is not theirs
    update public.dispatch_attention set resolved_at = now(), resolved_by = left(s.driver_name, 120), resolution = 'driver handed it back to the dock'
     where job_id = j.id and piece_id = upper(trim(coalesce(a->>'code', ''))) and kind in ('load_wrong_route', 'load_unknown') and resolved_at is null;
    return jsonb_build_object('ok', true, 'load', tp_sec.load_state(j.id));
  end if;
  -- cant_continue: breakdown, accident, illness; the dispatcher moves the boxes to another driver
  insert into public.dispatch_attention (org_id, kind, ref, job_id, detail)
  values (j.org_id, 'cant_continue', j.id::text, j.id, jsonb_build_object('route_title', j.title, 'driver', s.driver_name,
    'reason', left(coalesce(a->>'reason', 'other'), 60), 'note', left(a->>'note', 300),
    'boxes_left', (select count(*) from public.piece_assignments x join public.pieces p on p.org_id = x.org_id and p.piece_id = x.piece_id
                    where x.job_id = j.id and x.released_at is null and p.custody = 'with_driver')))
  on conflict do nothing;
  update public.jobs set exception_flag = true where id = j.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.tp_driver(text,text,jsonb) from public;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

-- ── tp_org ──────────────────────────────────────────────────────────────────
alter function public.tp_org(text,text,jsonb) rename to tp_org_v74;
alter function public.tp_org_v74(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v74(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; j public.jobs; dj public.jobs; t public.transfers; res jsonb; ids text[]; pc public.pieces;
begin
  if p_action not in ('load_status', 'resolve_load', 'start_transfer', 'close_transfer', 'transfers', 'hold_piece', 'release_hold', 'exceptions_feed') then
    return tp_sec.tp_org_v74(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;
  if a ? 'job_id' or a ? 'from_job_id' then
    select * into j from public.jobs where id::text = coalesce(a->>'job_id', a->>'from_job_id') and org_id::text = org;
    if j.id is null then raise exception 'TP_DENIED: not one of your routes'; end if;
  end if;

  if p_action = 'load_status' then return tp_sec.load_state(j.id) || jsonb_build_object('title', j.title, 'driver', j.driver_name); end if;

  if p_action = 'resolve_load' then
    if coalesce(a->>'note', '') = '' then raise exception 'TP_INVALID: a note is required'; end if;
    if a->>'action' = 'allow_departure' then
      update public.jobs set load_override_at = now(), load_override_by = left(coalesce(a->>'by', 'dispatcher'), 120), load_override_note = left(a->>'note', 300) where id = j.id;
    elsif a->>'action' = 'remove_missing' then
      -- the missing boxes come off this route (taking off is always allowed) and a search starts
      select coalesce(array_agg(x->>'piece_id'), '{}') into ids from jsonb_array_elements(tp_sec.load_state(j.id)->'missing') x;
      update public.jobs set surge_stops = (select coalesce(jsonb_agg(z order by n), '[]'::jsonb) from (
               select jsonb_set(st, '{pkgs}', coalesce((select jsonb_agg(p) from jsonb_array_elements(coalesce(st->'pkgs', '[]'::jsonb)) p where not (p->>'piece_id' = any(ids))), '[]'::jsonb)) z, n
                 from jsonb_array_elements(surge_stops) with ordinality q(st, n)) w
              where jsonb_array_length(z->'pkgs') > 0)
       where id = j.id;
      update public.jobs set total_stops = jsonb_array_length(surge_stops),
             total_packages = (select coalesce(sum(coalesce((p->>'required_count')::int, 1)), 0)::int from jsonb_array_elements(surge_stops) s2, jsonb_array_elements(coalesce(s2->'pkgs', '[]'::jsonb)) p)
       where id = j.id;
      update public.pieces set investigation_opened_at = now(), investigation_reason = 'Not found when route ' || coalesce(j.title, '') || ' was loaded', investigation_level = 0
       where org_id = j.org_id and piece_id = any(ids);
      insert into public.dispatch_attention (org_id, kind, piece_id, ref, job_id, detail)
      select j.org_id, 'load_missing', x, j.id::text, j.id, jsonb_build_object('route_title', j.title, 'reason', 'Not found when the route was loaded; search the bins and the dock')
        from unnest(ids) x
      on conflict do nothing;
    else
      raise exception 'TP_INVALID: action must be allow_departure or remove_missing';
    end if;
    -- the wrong-route and unknown boxes of this load are settled by the dispatcher's decision
    update public.dispatch_attention set resolved_at = now(), resolved_by = left(coalesce(a->>'by', 'dispatcher'), 120), resolution = left(a->>'note', 500)
     where job_id = j.id and kind in ('load_wrong_route', 'load_unknown') and resolved_at is null;
    return tp_sec.load_state(j.id);
  end if;

  if p_action = 'start_transfer' then
    if coalesce(a->>'to_driver', '') = '' then raise exception 'TP_INVALID: to_driver is required'; end if;
    if not exists (select 1 from public.drivers d where d.org_id::text = org and lower(btrim(d.name)) = lower(btrim(a->>'to_driver')) and coalesce(d.status, 'active') = 'active') then
      raise exception 'TP_INVALID: % is not an active driver of this company', a->>'to_driver'; end if;
    if lower(btrim(a->>'to_driver')) = lower(btrim(coalesce(j.driver_name, ''))) then raise exception 'TP_INVALID: transfer to another driver'; end if;
    perform pg_advisory_xact_lock(hashtext('tp_publish:' || j.org_id::text));   -- two dispatchers at once: one transfer per box
    -- the boxes still with the first driver (all, or the ones listed)
    select coalesce(array_agg(x.piece_id order by x.stop_number, x.piece_id), '{}') into ids
      from public.piece_assignments x join public.pieces p on p.org_id = x.org_id and p.piece_id = x.piece_id
     where x.job_id = j.id and x.released_at is null and p.custody = 'with_driver'
       and (jsonb_typeof(a->'pieces') is distinct from 'array' or x.piece_id in (select jsonb_array_elements_text(a->'pieces')))
       and not exists (select 1 from public.transfers t2 where t2.status = 'open' and x.piece_id = any(t2.pieces));
    if cardinality(ids) = 0 then raise exception 'TP_STATE: no boxes on this route can be transferred (none with the driver, or already in a transfer)'; end if;
    insert into public.jobs (org_id, title, job_type, status, driver_name, surge_stops, total_stops, total_packages, master_code, pickup_address, dropoff_address)
    values (j.org_id, 'Transfer: ' || coalesce(j.title, 'route') || ' to ' || (a->>'to_driver'), 'surge', 'assigned', a->>'to_driver', '[]'::jsonb, 0, 0,
            'TRANSFER-' || gen_random_uuid(), 'Transfer from ' || coalesce(j.driver_name, 'another driver'), j.dropoff_address)
    returning * into dj;
    insert into public.transfers (org_id, from_job_id, to_job_id, from_driver, to_driver, pieces, reason, created_by)
    values (j.org_id, j.id, dj.id, j.driver_name, a->>'to_driver', ids, left(a->>'reason', 200), left(coalesce(a->>'by', 'dispatcher'), 120)) returning * into t;
    insert into public.dispatch_attention (org_id, kind, ref, job_id, detail)
    values (j.org_id, 'transfer', t.id::text, j.id, jsonb_build_object('route_title', j.title, 'from_driver', j.driver_name, 'to_driver', a->>'to_driver', 'boxes', cardinality(ids)))
    on conflict do nothing;
    return jsonb_build_object('ok', true, 'transfer_id', t.id, 'to_job_id', dj.id, 'pieces', to_jsonb(ids));
  end if;

  if p_action = 'close_transfer' then          -- partial: what was scanned moved; the rest stays with the first driver
    select * into t from public.transfers where id::text = a->>'transfer_id' and org_id::text = org for update;
    if t.id is null then raise exception 'TP_DENIED: not one of your transfers'; end if;
    if t.status <> 'open' then return jsonb_build_object('ok', true, 'replayed', true, 'status', t.status); end if;
    perform tp_sec.finish_transfer(t, case when cardinality(t.scanned) = 0 then 'cancelled' else 'closed_partial' end, left(a->>'note', 300));
    return jsonb_build_object('ok', true, 'moved', cardinality(t.scanned), 'stayed', cardinality(t.pieces) - cardinality(t.scanned));
  end if;

  if p_action = 'transfers' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'org_id' order by x.created_at desc), '[]'::jsonb) into res
      from (select * from public.transfers where org_id::text = org order by created_at desc limit 50) x;
    return res;
  end if;

  if p_action in ('hold_piece', 'release_hold') then   -- holds placed by Keel's exception queue
    select * into pc from public.pieces p where p.org_id::text = org and p.piece_id = upper(trim(coalesce(a->>'piece_id', ''))) for update;
    if pc.piece_id is null then return jsonb_build_object('ok', false, 'reason', 'unknown box'); end if;
    if p_action = 'hold_piece' then
      if pc.hold is not null and pc.hold not like 'keel:%' then return jsonb_build_object('ok', false, 'reason', 'already held: ' || pc.hold); end if;
      update public.pieces set hold = 'keel:' || left(coalesce(a->>'reason', 'hold'), 80), updated_at = now(), version = version + 1 where org_id = pc.org_id and piece_id = pc.piece_id;
      perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'hold', jsonb_build_object('reason', a->>'reason', 'ref', a->>'ref'));
    else
      if pc.hold is null or pc.hold not like 'keel:%' then return jsonb_build_object('ok', true, 'replayed', true); end if;
      update public.pieces set hold = null, updated_at = now(), version = version + 1 where org_id = pc.org_id and piece_id = pc.piece_id;
      update public.dispatch_attention set resolved_at = now(), resolved_by = 'keel', resolution = 'hold released'
       where org_id = pc.org_id and piece_id = pc.piece_id and kind = 'piece_on_hold' and resolved_at is null;
      perform tp_sec.piece_event(pc.org_id, pc.piece_id, null, 'hold_released', jsonb_build_object('ref', a->>'ref'));
    end if;
    return jsonb_build_object('ok', true);
  end if;

  -- exceptions_feed: every item created, changed or resolved since a time (Keel's exception queue reads this)
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'piece_id', d.piece_id, 'ref', d.ref, 'job_id', d.job_id, 'detail', d.detail,
           'created_at', d.created_at, 'updated_at', d.updated_at, 'resolved_at', d.resolved_at, 'resolved_by', d.resolved_by, 'resolution', d.resolution,
           'piece', (select jsonb_build_object('custody', p.custody, 'hold', p.hold, 'attempts', p.attempts, 'custody_driver', p.custody_driver, 'keel_ref', p.keel_ref)
                       from public.pieces p where p.org_id = d.org_id and p.piece_id = d.piece_id),
           'route', (select title from public.jobs where id = d.job_id)) order by d.updated_at, d.id), '[]'::jsonb)
    into res
    from (select * from public.dispatch_attention x where x.org_id::text = org and x.updated_at > coalesce((a->>'since')::timestamptz, '-infinity')
           order by x.updated_at, x.id limit 500) d;
  return res;
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
revoke all on function tp_sec.route_required(uuid, text), tp_sec.load_state(uuid), tp_sec.load_piece(public.jobs, text, text), tp_sec.jobs_load_rules(),
  tp_sec.transfer_piece(public.transfers, text, text), tp_sec.finish_transfer(public.transfers, text, text), tp_sec.attention_touch() from public, anon, authenticated;

commit;
