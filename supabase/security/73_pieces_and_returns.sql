-- Migration 73: one record per box, and returns with the right custody.
--
-- 1. public.pieces: one row per box (the box label barcode, e.g. O-100123-1), per company:
--    where it is (custody), whether it is coming back (status), its condition, a hold,
--    delivery attempts so far and the last reason.
--    custody: handed_off, assigned, in_bin, with_driver, delivered, warehouse_returns,
--             awaiting_route, returned_to_keel, lost, cancelled
-- 2. public.piece_assignments: which route a box is on, and when and why that ended. The
--    database allows only ONE open assignment per box.
-- 3. Kept in step automatically, from what the apps already do (no app change needed):
--      a route is published or changed     -> its boxes are assigned to it
--      PathIQ stows a box (package.stowed) -> in_bin
--      the route is picked up              -> with_driver
--      the driver delivers the stop        -> delivered, assignment closed
--      the driver can't deliver the stop   -> status returning, attempts + 1, the reason kept
--      the route ends, is cancelled or archived -> its open assignments close; a box still in
--        the warehouse goes to awaiting_route
--    A box offered to a second live route is never assigned twice: it is listed under Needs
--    attention (piece_conflict) instead.
-- 4. tp_org gains:
--      receive_return  the warehouse scans a box that came back (RECEIVED): custody
--                      warehouse_returns, its assignment closes (reason returned), and the box
--                      leaves its old route (kept on the stop under returned_pkgs), so it can
--                      go out again at once. Damaged boxes are put on hold. Repeats change nothing.
--      pieces          custody of up to 500 boxes (Keel follows this)
--      piece_history   one box: its assignments and every change
-- Every change writes one row to public.events (piece.*).
-- Additive: two tables, three triggers, tp_org wrapped like 60-72 (the gateway in place moves
-- to tp_sec.tp_org_v72). The SmartSort gate is not changed. Needs 72.
-- Roll back with 73_pieces_and_returns.rollback.sql.
begin;
do $pre$ begin
  if to_regclass('public.dispatch_attention') is null or to_regprocedure('tp_sec.tp_org_v71(text,text,jsonb)') is null then
    raise exception 'Migration 72 is not applied. Nothing was changed.'; end if;
  if to_regclass('public.pieces') is not null then raise exception 'Migration 73 is already applied. Nothing was changed.'; end if;
end $pre$;

create table public.pieces (
  org_id                 uuid not null,
  piece_id               text not null,
  keel_ref               text,
  custody                text not null default 'handed_off' check (custody in ('handed_off', 'assigned', 'in_bin', 'with_driver', 'delivered',
                           'warehouse_returns', 'awaiting_route', 'returned_to_keel', 'lost', 'cancelled')),
  status                 text not null default 'normal' check (status in ('normal', 'returning')),
  condition              text not null default 'intact' check (condition in ('intact', 'damaged', 'unknown')),
  hold                   text,
  attempts               integer not null default 0,
  last_reason            text,
  current_assignment_id  uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  version                integer not null default 1,
  primary key (org_id, piece_id)
);
create table public.piece_assignments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  piece_id        text not null,
  job_id          uuid not null,
  stop_number     integer,
  assigned_at     timestamptz not null default now(),
  released_at     timestamptz,
  release_reason  text,
  attempted       boolean not null default false     -- the driver reported this stop as not delivered
);
-- the rule: one open assignment per box
create unique index piece_assignments_one_open on public.piece_assignments (org_id, piece_id) where released_at is null;
create index piece_assignments_job on public.piece_assignments (job_id) where released_at is null;
create index piece_assignments_piece on public.piece_assignments (org_id, piece_id, assigned_at);
alter table public.pieces enable row level security;
alter table public.piece_assignments enable row level security;
revoke all on public.pieces, public.piece_assignments from public, anon, authenticated;

alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed', 'piece_conflict'));

-- one change of one box, written to the event log
create function tp_sec.piece_event(p_org uuid, p_piece text, p_job uuid, p_kind text, p_payload jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.events (org_id, event_type, job_id, payload)
  values (p_org, 'piece.' || p_kind, p_job, jsonb_build_object('piece_id', p_piece) || coalesce(p_payload, '{}'::jsonb));
$$;

create function tp_sec.route_is_live(j public.jobs) returns boolean language sql stable as $$
  select coalesce(j.status, '') not in ('cancelled', 'delivered', 'completed_with_exceptions', 'closed_with_exceptions', 'deleted')
     and not coalesce(j.archived, false);
$$;

-- close one box's open assignment
create function tp_sec.release_piece(p_org uuid, p_piece text, p_reason text, p_custody text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare asg public.piece_assignments;
begin
  update public.piece_assignments set released_at = now(), release_reason = p_reason
   where org_id = p_org and piece_id = p_piece and released_at is null returning * into asg;
  update public.pieces set current_assignment_id = null, custody = coalesce(p_custody, custody), updated_at = now(), version = version + 1
   where org_id = p_org and piece_id = p_piece;
  if asg.id is not null then
    perform tp_sec.piece_event(p_org, p_piece, asg.job_id, 'released', jsonb_build_object('reason', p_reason, 'stop_number', asg.stop_number, 'custody', p_custody));
  end if;
end $$;

-- make a route's assignments match the route: called for every published or changed route
create function tp_sec.sync_route_pieces(p_job uuid) returns void language plpgsql security definer set search_path = '' as $$
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

create function tp_sec.jobs_sync_pieces() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.surge_stops is not distinct from old.surge_stops and new.status is not distinct from old.status
     and new.archived is not distinct from old.archived and new.picked_up_at is not distinct from old.picked_up_at then
    return null;
  end if;
  perform tp_sec.sync_route_pieces(new.id);
  return null;
end $$;
create trigger tp_sync_pieces after insert or update on public.jobs for each row execute function tp_sec.jobs_sync_pieces();

-- the driver's stop reports
create function tp_sec.messages_piece_state() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text; x jsonb; j public.jobs; asg public.piece_assignments;
begin
  k := substring(new.body from '^STOP_(DELIVERED|EXCEPTION)::');
  if k is null or new.job_id is null then return null; end if;
  begin x := substring(new.body from length('STOP_' || k || '::') + 1)::jsonb; exception when others then return null; end;
  select * into j from public.jobs where id = new.job_id;
  if j.id is null or j.org_id is null then return null; end if;
  for asg in select * from public.piece_assignments a where a.job_id = j.id and a.released_at is null
              and a.stop_number = coalesce((x->>'stop_number')::int, 1) loop
    if k = 'DELIVERED' then
      perform tp_sec.release_piece(j.org_id, asg.piece_id, 'delivered', 'delivered');
      update public.pieces set status = 'normal' where org_id = j.org_id and piece_id = asg.piece_id;
      perform tp_sec.piece_event(j.org_id, asg.piece_id, j.id, 'delivered', jsonb_build_object('stop_number', asg.stop_number));
    elsif not asg.attempted then      -- once per stop, however often the report is sent
      update public.piece_assignments set attempted = true where id = asg.id;
      update public.pieces set status = 'returning', attempts = attempts + 1, last_reason = left(coalesce(x->>'reason', 'unknown'), 60),
             updated_at = now(), version = version + 1
       where org_id = j.org_id and piece_id = asg.piece_id;
      perform tp_sec.piece_event(j.org_id, asg.piece_id, j.id, 'not_delivered',
        jsonb_build_object('stop_number', asg.stop_number, 'reason', x->>'reason', 'reason_label', x->>'reason_label'));
    end if;
  end loop;
  return null;
end $$;
create trigger tp_piece_stop_reports after insert on public.messages for each row execute function tp_sec.messages_piece_state();

-- PathIQ's stow scans
create function tp_sec.events_piece_stowed() returns trigger language plpgsql security definer set search_path = '' as $$
declare pid text;
begin
  if new.event_type <> 'package.stowed' or new.org_id is null then return null; end if;
  pid := coalesce(nullif(new.payload->>'piece', ''), nullif(new.payload->>'code', ''));
  if pid is null then return null; end if;
  update public.pieces p set custody = 'in_bin', updated_at = now(), version = p.version + 1
    from public.piece_assignments a
   where p.org_id = new.org_id and p.piece_id = pid and p.custody = 'assigned'
     and a.id = p.current_assignment_id and a.released_at is null and (new.job_id is null or a.job_id = new.job_id);
  return null;
end $$;
create trigger tp_piece_stowed after insert on public.events for each row execute function tp_sec.events_piece_stowed();

-- routes that are live now get their assignments (no route row is changed)
do $backfill$ declare j record; begin
  for j in select id from public.jobs where org_id is not null and tp_sec.route_is_live(jobs) order by created_at loop
    perform tp_sec.sync_route_pieces(j.id);
  end loop;
end $backfill$;

alter function public.tp_org(text,text,jsonb) rename to tp_org_v72;
alter function public.tp_org_v72(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v72(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; res jsonb; pc public.pieces; asg public.piece_assignments; j public.jobs;
        cond text; stops jsonb;
begin
  if p_action not in ('receive_return', 'pieces', 'piece_history') then
    return tp_sec.tp_org_v72(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;

  if p_action = 'pieces' then
    if jsonb_typeof(a->'ids') <> 'array' or jsonb_array_length(a->'ids') > 500 then raise exception 'TP_INVALID: ids must be a list of at most 500 boxes'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('piece_id', p.piece_id, 'custody', p.custody, 'status', p.status, 'condition', p.condition,
             'hold', p.hold, 'attempts', p.attempts, 'last_reason', p.last_reason, 'job_id', x.job_id, 'stop_number', x.stop_number,
             'updated_at', p.updated_at) order by p.piece_id), '[]'::jsonb)
      into res
      from public.pieces p left join public.piece_assignments x on x.id = p.current_assignment_id
     where p.org_id::text = org and p.piece_id in (select jsonb_array_elements_text(a->'ids'));
    return res;
  end if;

  if p_action = 'piece_history' then
    select jsonb_build_object(
      'piece', (select to_jsonb(p) - 'org_id' from public.pieces p where p.org_id::text = org and p.piece_id = a->>'piece_id'),
      'assignments', coalesce((select jsonb_agg(to_jsonb(x) - 'org_id' order by x.assigned_at) from public.piece_assignments x
                                where x.org_id::text = org and x.piece_id = a->>'piece_id'), '[]'::jsonb),
      'events', coalesce((select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'job_id', e.job_id, 'payload', e.payload, 'occurred_at', e.occurred_at) order by e.id)
                           from public.events e where e.org_id::text = org and e.event_type like 'piece.%' and e.payload->>'piece_id' = a->>'piece_id'), '[]'::jsonb))
      into res;
    return res;
  end if;

  -- receive_return: the box is physically back in the warehouse
  cond := coalesce(nullif(a->>'condition', ''), 'intact');
  if cond not in ('intact', 'damaged') then raise exception 'TP_INVALID: condition must be intact or damaged'; end if;
  select * into pc from public.pieces p where p.org_id::text = org and p.piece_id = upper(trim(coalesce(a->>'piece_id', ''))) for update;
  if pc.piece_id is null then
    select * into pc from public.pieces p where p.org_id::text = org and p.piece_id = trim(coalesce(a->>'piece_id', '')) for update;
  end if;
  if pc.piece_id is null then raise exception 'TP_INVALID: this box is not known to TackPath'; end if;
  if pc.custody = 'warehouse_returns' then
    return jsonb_build_object('ok', true, 'replayed', true, 'piece_id', pc.piece_id, 'custody', pc.custody, 'condition', pc.condition, 'hold', pc.hold);
  end if;
  if pc.custody in ('delivered', 'returned_to_keel', 'lost', 'cancelled') then
    raise exception 'TP_STATE: box % is %; it cannot be received back', pc.piece_id, pc.custody;
  end if;
  select * into asg from public.piece_assignments x where x.id = pc.current_assignment_id and x.released_at is null;
  perform tp_sec.release_piece(pc.org_id, pc.piece_id, 'returned', 'warehouse_returns');
  update public.pieces set status = 'normal', condition = cond, hold = case when cond = 'damaged' then 'damaged' else hold end,
         updated_at = now(), version = version + 1
   where org_id = pc.org_id and piece_id = pc.piece_id returning * into pc;
  -- the box leaves its old route: kept on the stop under returned_pkgs, so the route still shows it
  if asg.id is not null then
    select * into j from public.jobs where id = asg.job_id;
    if j.id is not null and not tp_sec.job_locked(j.id::text) then
      select coalesce(jsonb_agg(case when (
                 select bool_or(p->>'piece_id' = pc.piece_id) from jsonb_array_elements(coalesce(st->'pkgs', '[]'::jsonb)) p) then
               jsonb_set(jsonb_set(st, '{pkgs}', coalesce((select jsonb_agg(p) from jsonb_array_elements(st->'pkgs') p where p->>'piece_id' <> pc.piece_id), '[]'::jsonb)),
                         '{returned_pkgs}', coalesce(st->'returned_pkgs', '[]'::jsonb)
                           || coalesce((select jsonb_agg(p || jsonb_build_object('received_at', now(), 'condition', cond)) from jsonb_array_elements(st->'pkgs') p where p->>'piece_id' = pc.piece_id), '[]'::jsonb))
             else st end order by n), '[]'::jsonb)
        into stops from jsonb_array_elements(j.surge_stops) with ordinality as t(st, n);
      update public.jobs set surge_stops = stops where id = j.id;
    end if;
  end if;
  perform tp_sec.piece_event(pc.org_id, pc.piece_id, asg.job_id, 'received_return',
    jsonb_build_object('condition', cond, 'by', left(coalesce(a->>'by', 'warehouse'), 80), 'note', left(a->>'note', 300)));
  return jsonb_build_object('ok', true, 'replayed', false, 'piece_id', pc.piece_id, 'custody', pc.custody, 'condition', pc.condition, 'hold', pc.hold,
    'from_job_id', asg.job_id, 'attempts', pc.attempts, 'last_reason', pc.last_reason);
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
revoke all on function tp_sec.piece_event(uuid,text,uuid,text,jsonb), tp_sec.release_piece(uuid,text,text,text), tp_sec.sync_route_pieces(uuid),
  tp_sec.route_is_live(public.jobs), tp_sec.jobs_sync_pieces(), tp_sec.messages_piece_state(), tp_sec.events_piece_stowed() from public, anon, authenticated;

commit;
