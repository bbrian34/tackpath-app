-- ═══════════════════════════════════════════════════════════════════════════
-- TackPath — migration 70: the operations loop, server-side and per company.
--
-- Needs migration 69 (company isolation and driver identity, PR 89).
-- Additive and backward-compatible: new tables and functions; tp_org gains
-- new actions and keeps every existing one (the previous gateway is kept as
-- tp_sec.tp_org_v69 and still answers everything this one does not).
-- Rollback: 70_ops_loop.rollback.sql.
--
-- 1. Company isolation for agent data
--    swarm-watch wrote agent_memory rows with no org_id, and tp_org showed
--    org-less agent_memory rows to every company (include_null_org_rows), so
--    one company's SmartTrack exceptions fed another company's Brain.
--    - backfill agent_memory.org_id from the row's route;
--    - a trigger stamps org_id from the route on every new row;
--    - tp_org 'agent_memory' now shows only the signed-in company's rows;
--    - every server agent writes with its company (ops_tick, below).
--    messages already take the route's company (migration 69 trigger).
--
-- 2. Server-side agents
--    SmartTrack, SmartComms, Ruby and the Brain (Swarm Coordinator) ran in the
--    dispatcher's browser tab, so they stopped when the tab closed and every
--    open tab could send the same check-in again. tp_sec.ops_tick runs them
--    on the server, company by company, from the existing swarm-watch cron.
--    Every action is first CLAIMED in tp_sec.agent_actions with a key that
--    names the action (e.g. checkin:<route>:<window>). The claim is a primary
--    key, so exactly one caller wins: two ticks at once, a tick and an open
--    dispatcher tab, or two tabs. The dispatcher claims the same keys through
--    tp_org 'agent_claim', and stands down entirely while server agents are on.
--
-- 3. Decisions and outcomes (Detect, Predict, Evaluate, Execute, Measure)
--    public.ops_decisions records, per company: the issue detected, the
--    prediction and expected impact, the recommendation, whether it needs a
--    person's approval (policy engine tiers: notifications are automatic,
--    reassigning or moving stops needs approval), the decision and who made
--    it, the action actually performed, the actual result, and the difference
--    between predicted and actual. ops_tick measures each one when the stop
--    it is about is delivered. tp_org 'ops_insights' summarises them for the
--    Brain and OWL screens.
--
-- 4. Delivery promise, warehouse to door
--    A stop can carry deliver_by (Keel sends its same-day promise in the
--    SmartSort manifest). Every tick predicts each remaining stop's arrival
--    from the route's live ETA, the stops still ahead and this company's own
--    recent stop and pickup times, and stores it in public.ops_promise. Stops
--    heading past their promise become 'promise_risk' decisions with the
--    likely delay and a recommendation on the dispatcher's decisions list
--    (never in the driver's chat); anything that changes a route waits for
--    approval. Keel reads the
--    predictions through tp_org 'promise_watch' with its company session.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v65(text,text,jsonb)') is null or to_regclass('tp_sec.identity_review') is null then
    raise exception 'Apply 69_isolation_and_driver_identity.sql first. Nothing was changed.';
  end if;
  if to_regclass('tp_sec.agent_actions') is not null then
    raise exception 'Migration 70 is already applied. Nothing was changed.';
  end if;
end $pre$;

insert into tp_sec.settings values ('server_agents', 'true'), ('ops_timezone', '"America/New_York"')
  on conflict (key) do nothing;

-- ── 1. agent_memory belongs to a company ─────────────────────────────────
alter table public.agent_memory add column if not exists org_id uuid;
update public.agent_memory m set org_id = j.org_id from public.jobs j
 where m.org_id is null and m.job_id is not null and j.id = m.job_id;

create function tp_sec.agent_memory_org() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id is null and new.job_id is not null then
    select j.org_id into new.org_id from public.jobs j where j.id = new.job_id;
  end if;
  return new;
end $$;
create trigger tp_agent_memory_org before insert on public.agent_memory for each row execute function tp_sec.agent_memory_org();
create index if not exists agent_memory_org_time on public.agent_memory (org_id, created_at desc);

-- ── 2. claims, per-stop deadlines ────────────────────────────────────────
create table tp_sec.agent_actions (
  org_id     text not null,
  action_key text not null,
  agent      text not null,
  job_id     uuid,
  actor      text not null,                 -- 'server' | 'dispatcher'
  created_at timestamptz not null default now(),
  primary key (org_id, action_key));

-- true for exactly one caller per (company, action)
create function tp_sec.claim(p_org text, p_key text, p_agent text, p_job uuid, p_actor text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_org is null or nullif(p_key, '') is null then return false; end if;
  insert into tp_sec.agent_actions (org_id, action_key, agent, job_id, actor)
  values (p_org, left(p_key, 300), left(coalesce(p_agent, ''), 60), p_job, p_actor)
  on conflict do nothing;
  return found;
end $$;

-- SmartTrack locks the live ETA as the deadline the first time it sees a driver heading to a stop
create table tp_sec.stop_deadlines (
  job_id     uuid not null,
  stop_index integer not null,
  deadline   timestamptz not null,
  locked_at  timestamptz not null default now(),
  primary key (job_id, stop_index));

-- ── 3. decisions and outcomes ────────────────────────────────────────────
create table public.ops_decisions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null,
  kind               text not null,            -- late_stop | reassign_review | promise_risk
  job_id             uuid,
  stop_number        integer,
  ref                text not null,             -- the claim key that created it (one decision per issue)
  detected_at        timestamptz not null default now(),
  issue              text not null,
  prediction         jsonb not null default '{}',   -- predicted_at, deadline, expected_late_min, basis
  expected_impact    text,
  recommendation     text not null,
  recommended_action text not null,             -- notify_driver | notify_dispatcher | assign_driver | start_route | reassign_review
  risk               text not null default 'low' check (risk in ('low', 'medium')),
  requires_approval  boolean not null default false,
  status             text not null default 'open'
                       check (status in ('open', 'awaiting_approval', 'approved', 'rejected', 'executed', 'measured', 'expired')),
  decided_by         text,
  decided_at         timestamptz,
  decision_note      text,
  executed_action    text,
  executed_at        timestamptz,
  snapshot           jsonb not null default '{}',   -- route state when detected (driver, stops done)
  actual             jsonb,                         -- actual_at, actual_late_min
  error_min          numeric,                       -- actual minus predicted, minutes
  measured_at        timestamptz,
  unique (org_id, ref));
create index ops_decisions_org_time on public.ops_decisions (org_id, detected_at desc);
create index ops_decisions_open on public.ops_decisions (job_id) where measured_at is null;
alter table public.ops_decisions enable row level security;
revoke all on public.ops_decisions from anon, authenticated;

-- current prediction for every remaining stop that has a promise
create table public.ops_promise (
  org_id        uuid not null,
  job_id        uuid not null,
  stop_number   integer not null,
  order_ref     text,
  deliver_by    timestamptz not null,
  predicted_at  timestamptz not null,
  slack_min     numeric not null,
  risk          text not null check (risk in ('on_track', 'tight', 'at_risk', 'late', 'delivered')),
  basis         jsonb not null default '{}',
  delivered_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (job_id, stop_number));
create index ops_promise_org on public.ops_promise (org_id, updated_at desc);
alter table public.ops_promise enable row level security;
revoke all on public.ops_promise from anon, authenticated;

-- ── helpers ──────────────────────────────────────────────────────────────
create function tp_sec.ops_stops(j public.jobs) returns jsonb language sql immutable set search_path = '' as $$
  select case jsonb_typeof(j.surge_stops) when 'array' then j.surge_stops
              when 'string' then (case when left(j.surge_stops #>> '{}', 1) = '[' then (j.surge_stops #>> '{}')::jsonb else '[]'::jsonb end)
              else '[]'::jsonb end
$$;

create function tp_sec.ops_miles(a jsonb, b jsonb) returns double precision language sql immutable set search_path = '' as $$
  select case when a->>'lat' is null or b->>'lat' is null then null else
    3958.8 * 2 * asin(sqrt(power(sin(radians(((b->>'lat')::float8 - (a->>'lat')::float8) / 2)), 2)
      + cos(radians((a->>'lat')::float8)) * cos(radians((b->>'lat')::float8))
      * power(sin(radians(((b->>'lng')::float8 - (a->>'lng')::float8) / 2)), 2))) end
$$;

-- when each stop of a route was delivered (driver app STOP_DELIVERED, or the route's own delivered_at for a 1-stop route)
create function tp_sec.ops_delivered_at(p_job uuid, p_stop integer) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select coalesce(nullif(substr(m.body, 17)::jsonb->>'delivered_at', '')::timestamptz, m.created_at)
       from public.messages m
      where m.job_id = p_job and m.body like 'STOP_DELIVERED::%'
        and coalesce((substr(m.body, 17)::jsonb->>'stop_number')::int, 1) = p_stop
      order by m.created_at limit 1),
    (select (to_jsonb(j.*)->>'delivered_at')::timestamptz from public.jobs j
      where j.id = p_job and p_stop = 1 and coalesce(j.total_stops, 1) <= 1))
$$;

-- this company's typical minutes per stop, and from staging to pickup (30 days, 5+ samples, else defaults)
create function tp_sec.ops_pace(p_org uuid, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with done as (
    select (to_jsonb(j.*)->>'delivered_at')::timestamptz as d, j.picked_up_at as p, j.staged_at as s, greatest(coalesce(j.total_stops, 1), 1) as n
      from public.jobs j
     where j.org_id = p_org and j.status in ('delivered', 'completed_with_exceptions')
       and j.picked_up_at is not null and j.picked_up_at > p_now - interval '30 days')
  select jsonb_build_object(
    'per_stop_min', coalesce((select case when count(*) >= 5 then round(percentile_cont(0.75) within group (order by extract(epoch from (d - p)) / 60 / n)::numeric, 1) end
                                from done where d is not null and d > p), 12),
    'pickup_min', coalesce((select case when count(*) >= 5 then round(percentile_cont(0.75) within group (order by extract(epoch from (p - s)) / 60)::numeric, 1) end
                              from done where s is not null and p > s), 20),
    'learned', (select count(*) >= 5 from done where d is not null and d > p))
$$;

create function tp_sec.ops_day(p_now timestamptz) returns text language sql stable set search_path = '' as $$
  select to_char(p_now at time zone coalesce(tp_sec.setting('ops_timezone') #>> '{}', 'America/New_York'), 'YYYY-MM-DD')
$$;
create function tp_sec.ops_day_start(p_now timestamptz) returns timestamptz language sql stable set search_path = '' as $$
  select date_trunc('day', p_now at time zone coalesce(tp_sec.setting('ops_timezone') #>> '{}', 'America/New_York'))
           at time zone coalesce(tp_sec.setting('ops_timezone') #>> '{}', 'America/New_York')
$$;

create function tp_sec.ops_memory(p_org uuid, p_agent text, p_event text, p_job uuid, p_driver text, p_details jsonb, p_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_memory' and column_name = 'outcome') then
    execute 'insert into public.agent_memory (org_id, agent_name, event_type, job_id, driver_name, details, outcome) values ($1,$2,$3,$4,$5,$6,$7)'
      using p_org, p_agent, p_event, p_job, p_driver, coalesce(p_details, '{}'), p_outcome;
  else
    insert into public.agent_memory (org_id, agent_name, event_type, job_id, driver_name, details)
    values (p_org, p_agent, p_event, p_job, p_driver, coalesce(p_details, '{}') || jsonb_build_object('outcome', p_outcome));
  end if;
end $$;

create function tp_sec.ops_message(p_job uuid, p_sender text, p_body text) returns void
language sql security definer set search_path = '' as $$
  insert into public.messages (job_id, sender, sender_role, body) values (p_job, p_sender, 'dispatcher', p_body)
$$;

-- ── the tick: every agent, every company (or one company) ─────────────────
create function tp_sec.ops_tick(p_now timestamptz default now(), p_org uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o uuid; j public.jobs; jj jsonb; st jsonb; stops jsonb; total int; done int; i int;
  dl timestamptz; mins int; first_name text; started timestamptz; win int; pace jsonb; per_stop numeric; pickup numeric;
  arr timestamptz; base timestamptz; slack numeric; prisk text; rec text; act text; appr boolean; dref text; dec public.ops_decisions;
  spread double precision; pairs int; remaining int; agents_on boolean := coalesce((tp_sec.setting('server_agents'))::boolean, true);
  day text := tp_sec.ops_day(p_now); day0 timestamptz := tp_sec.ops_day_start(p_now);
  n_late int := 0; n_checkin int := 0; n_done int := 0; n_ruby int := 0; n_brain int := 0; n_promise int := 0; n_measured int := 0; n_risk int := 0;
  cats jsonb; m record; cnt int; drv record;
begin
  for o in select distinct x.org_id from public.jobs x
            where x.org_id is not null and (p_org is null or x.org_id = p_org)
              and (coalesce(x.archived, false) = false or x.created_at > p_now - interval '2 days')
  loop
    pace := tp_sec.ops_pace(o, p_now);
    per_stop := (pace->>'per_stop_min')::numeric; pickup := (pace->>'pickup_min')::numeric;

    for j in select * from public.jobs x where x.org_id = o and coalesce(x.archived, false) = false order by x.created_at loop
      jj := to_jsonb(j);
      stops := tp_sec.ops_stops(j);
      total := greatest((select count(*) from jsonb_array_elements(stops) e where coalesce((e->>'cancelled')::boolean, false) = false)::int, 1);
      done := coalesce(j.stops_completed, 0);
      first_name := split_part(coalesce(j.driver_name, ''), ' ', 1);

      -- ── SmartTrack (Todd): a driver past the deadline locked for their current stop ──
      if agents_on and j.status in ('in_transit', 'customer_confirmed') and j.driver_name is not null and done < total then
        dl := coalesce(j.estimated_delivery_at, j.original_eta_at);
        if dl is not null then
          insert into tp_sec.stop_deadlines (job_id, stop_index, deadline) values (j.id, done, dl) on conflict do nothing;
          if not found then
            select d.deadline into dl from tp_sec.stop_deadlines d where d.job_id = j.id and d.stop_index = done;
            mins := round(extract(epoch from (p_now - dl)) / 60);
            if mins >= 20 and tp_sec.claim(o::text, 'smarttrack:' || j.id || ':' || done, 'SmartTrack', j.id, 'server') then
              update public.jobs set exception_flag = true where id = j.id;
              perform tp_sec.ops_message(j.id, 'SmartTrack', 'SMARTTRACK:: ' || j.driver_name || ' is ' || mins || ' min past expected arrival at stop '
                || (done + 1) || ' of ' || total || '. Auto-flagged as exception.');
              perform tp_sec.ops_message(j.id, 'SmartTrack', 'Hey ' || first_name || ', you are running behind on stop ' || (done + 1)
                || '. Everything ok? Let us know if you need anything.');
              perform tp_sec.ops_memory(o, 'SmartTrack', 'stop_past_eta', j.id, j.driver_name,
                jsonb_build_object('minutes_late', mins, 'stop_number', done + 1, 'total_stops', total, 'stop_deadline', dl, 'source', 'server'), 'escalated');
              insert into public.ops_decisions (org_id, kind, job_id, stop_number, ref, detected_at, issue, prediction, expected_impact,
                  recommendation, recommended_action, risk, requires_approval, status, executed_action, executed_at, snapshot)
              values (o, 'late_stop', j.id, done + 1, 'smarttrack:' || j.id || ':' || done, p_now,
                j.driver_name || ' is ' || mins || ' min past the ETA for stop ' || (done + 1) || ' of ' || total,
                jsonb_build_object('deadline', dl, 'late_min_at_detection', mins),
                'Stop ' || (done + 1) || ' arrives at least ' || mins || ' min after its ETA',
                'Check in with the driver', 'notify_driver', 'low', false, 'executed', 'driver_messaged', p_now,
                jsonb_build_object('driver_name', j.driver_name, 'stops_completed', done));
              n_late := n_late + 1;

              -- Brain joint analysis: are the remaining stops tight enough for another driver to absorb?
              remaining := total - done; spread := 0; pairs := 0;
              for i in done .. total - 2 loop
                if tp_sec.ops_miles(stops->i->'coords', stops->(i + 1)->'coords') is not null then
                  spread := spread + tp_sec.ops_miles(stops->i->'coords', stops->(i + 1)->'coords'); pairs := pairs + 1;
                end if;
              end loop;
              perform tp_sec.ops_memory(o, 'SwarmCoordinator', 'joint_analysis', j.id, j.driver_name,
                jsonb_build_object('minutes_late', mins, 'current_stop', done + 1, 'total_stops', total, 'remaining_stops', remaining,
                  'avg_spread_miles', case when pairs > 0 then round((spread / pairs)::numeric, 1) end,
                  'cluster_tightness', case when pairs = 0 then 'unknown' when spread / pairs < 2 then 'tight' when spread / pairs < 5 then 'moderate' else 'scattered' end,
                  'source', 'server'), 'analyzed');
              if remaining >= 2 and pairs > 0 and spread / pairs < 2
                 and tp_sec.claim(o::text, 'reassign:' || j.id || ':' || done, 'SwarmCoordinator', j.id, 'server') then
                insert into public.ops_decisions (org_id, kind, job_id, stop_number, ref, detected_at, issue, prediction, expected_impact,
                    recommendation, recommended_action, risk, requires_approval, status, snapshot)
                values (o, 'reassign_review', j.id, done + 1, 'reassign:' || j.id || ':' || done, p_now,
                  j.driver_name || ' is ' || mins || ' min behind with ' || remaining || ' stops left',
                  jsonb_build_object('late_min_at_detection', mins, 'remaining_stops', remaining, 'avg_spread_miles', round((spread / pairs)::numeric, 1)),
                  'The remaining stops are close together (avg ' || round((spread / pairs)::numeric, 1) || ' mi apart), so a nearby driver could take some',
                  'Review moving some of the remaining ' || remaining || ' stops to a nearby driver', 'reassign_review', 'medium', true,
                  'awaiting_approval', jsonb_build_object('driver_name', j.driver_name, 'stops_completed', done));
              end if;
            end if;
          end if;
        end if;
      end if;

      -- ── SmartComms (Mario): a check-in every 30 minutes of an active route ──
      if agents_on and j.status in ('in_transit', 'customer_confirmed') and j.driver_name is not null and done < total then
        started := coalesce((jj->>'started_at')::timestamptz, j.created_at);
        win := floor(extract(epoch from (p_now - started)) / 1800);
        if win >= 1 and tp_sec.claim(o::text, 'checkin:' || j.id || ':' || win, 'SmartComms', j.id, 'server') then
          perform tp_sec.ops_message(j.id, 'SmartComms', 'Hey ' || first_name || ', quick check-in — how is the route going? You are on stop '
            || (done + 1) || ' of ' || total || '.');
          perform tp_sec.ops_memory(o, 'SmartComms', 'routine_checkin', j.id, j.driver_name,
            jsonb_build_object('stop_at_checkin', done + 1, 'total_stops', total, 'minutes_since_start', round(extract(epoch from (p_now - started)) / 60), 'source', 'server'), 'sent');
          n_checkin := n_checkin + 1;
        end if;
      end if;

      -- ── SmartComms: end-of-route confirmation, once, for routes finished in the last 2 hours ──
      if agents_on and j.status in ('delivered', 'completed_with_exceptions') and j.driver_name is not null
         and (jj->>'delivered_at')::timestamptz > p_now - interval '2 hours'
         and tp_sec.claim(o::text, 'complete:' || j.id, 'SmartComms', j.id, 'server') then
        perform tp_sec.ops_message(j.id, 'SmartComms', case when j.status = 'completed_with_exceptions'
          then 'Thanks ' || first_name || ', the route is finished. Some stops had problems: please bring those packages back to the station and confirm when you are on your way.'
          else 'Great work ' || first_name || '! All ' || total || ' stops complete on this route. Please confirm you are heading back or ready for your next assignment.' end);
        perform tp_sec.ops_memory(o, 'SmartComms', 'route_completed', j.id, j.driver_name, jsonb_build_object('total_stops', total, 'source', 'server'), 'sent');
        n_done := n_done + 1;
      end if;

      -- ── Delivery promise: predict every remaining stop that has a deliver_by ──
      if j.status not in ('cancelled') then
        base := case
          when j.status in ('in_transit', 'customer_confirmed') then greatest(p_now, coalesce(j.estimated_delivery_at, p_now + make_interval(mins => per_stop::int)))
          when j.staged_at is not null then p_now + make_interval(mins => pickup::int) + make_interval(mins => per_stop::int)
          else p_now + make_interval(mins => (pickup + 15)::int) + make_interval(mins => per_stop::int) end;
        for i in 0 .. jsonb_array_length(stops) - 1 loop
          st := stops->i;
          continue when nullif(st->>'deliver_by', '') is null or coalesce((st->>'cancelled')::boolean, false);
          if tp_sec.ops_delivered_at(j.id, i + 1) is not null or i < done or j.status in ('delivered', 'completed_with_exceptions') then
            update public.ops_promise set risk = 'delivered', delivered_at = coalesce(tp_sec.ops_delivered_at(j.id, i + 1), (jj->>'delivered_at')::timestamptz, delivered_at, p_now), updated_at = p_now
             where job_id = j.id and stop_number = i + 1 and risk <> 'delivered';
            continue;
          end if;
          arr := base + make_interval(mins => (per_stop * greatest(i - done, 0))::int);
          slack := round((extract(epoch from ((st->>'deliver_by')::timestamptz - arr)) / 60)::numeric, 1);
          prisk := case when p_now > (st->>'deliver_by')::timestamptz then 'late' when slack < 0 then 'at_risk' when slack < 15 then 'tight' else 'on_track' end;
          insert into public.ops_promise (org_id, job_id, stop_number, order_ref, deliver_by, predicted_at, slack_min, risk, basis, updated_at)
          values (o, j.id, i + 1, coalesce(st->>'order_id', st#>>'{pkgs,0,order_id}'), (st->>'deliver_by')::timestamptz, arr, slack, prisk,
                  jsonb_build_object('status', j.status, 'stops_ahead', greatest(i - done, 0), 'per_stop_min', per_stop, 'pickup_min', pickup,
                                     'live_eta', j.estimated_delivery_at, 'learned', pace->'learned'), p_now)
          on conflict (job_id, stop_number) do update set deliver_by = excluded.deliver_by, predicted_at = excluded.predicted_at,
            slack_min = excluded.slack_min, risk = excluded.risk, basis = excluded.basis, updated_at = excluded.updated_at, org_id = excluded.org_id;
          n_promise := n_promise + 1;

          if prisk in ('at_risk', 'late') and tp_sec.claim(o::text, 'promise:' || j.id || ':' || (i + 1), 'PromiseWatch', j.id, 'server') then
            if j.status in ('in_transit', 'customer_confirmed') and i > done then
              rec := 'Review moving stop ' || (i + 1) || ' to a driver who can reach it sooner'; act := 'reassign_review'; appr := true;
            elsif j.status in ('in_transit', 'customer_confirmed') then
              rec := 'Tell the customer the new arrival time'; act := 'notify_dispatcher'; appr := false;
            elsif j.driver_name is null then
              rec := 'Assign a driver to this route now'; act := 'assign_driver'; appr := false;
            else
              rec := 'Have the driver pick up and start the route now'; act := 'start_route'; appr := false;
            end if;
            insert into public.ops_decisions (org_id, kind, job_id, stop_number, ref, detected_at, issue, prediction, expected_impact,
                recommendation, recommended_action, risk, requires_approval, status, executed_action, executed_at, snapshot)
            values (o, 'promise_risk', j.id, i + 1, 'promise:' || j.id || ':' || (i + 1), p_now,
              'Stop ' || (i + 1) || ' is heading past its delivery promise',
              jsonb_build_object('predicted_at', arr, 'deliver_by', st->>'deliver_by', 'expected_late_min', -slack,
                                 'basis', jsonb_build_object('status', j.status, 'stops_ahead', greatest(i - done, 0), 'per_stop_min', per_stop, 'live_eta', j.estimated_delivery_at)),
              'Likely ' || abs(round(slack)) || ' min late if nothing changes', rec, act,
              case when appr then 'medium' else 'low' end, appr, case when appr then 'awaiting_approval' else 'open' end,
              'flagged_on_dispatch_board', p_now, jsonb_build_object('driver_name', j.driver_name, 'stops_completed', done, 'status', j.status));
            perform tp_sec.ops_memory(o, 'PromiseWatch', 'promise_at_risk', j.id, j.driver_name,
              jsonb_build_object('stop_number', i + 1, 'predicted_at', arr, 'deliver_by', st->>'deliver_by', 'expected_late_min', -slack, 'source', 'server'), 'flagged');
            n_risk := n_risk + 1;
          end if;
        end loop;
      end if;
    end loop;

    -- ── Measure: what actually happened to every open decision ──
    for dec in select * from public.ops_decisions d where d.org_id = o and d.measured_at is null and d.status <> 'expired' loop
      -- an approved route change counts as performed once the route's driver or stops change
      if dec.status = 'approved' and dec.recommended_action = 'reassign_review' and exists (
           select 1 from public.jobs x where x.id = dec.job_id
              and (coalesce(x.driver_name, '') <> coalesce(dec.snapshot->>'driver_name', '')
                   or jsonb_array_length(tp_sec.ops_stops(x)) <> coalesce((dec.snapshot->>'stops_total')::int, jsonb_array_length(tp_sec.ops_stops(x))))) then
        update public.ops_decisions set status = 'executed', executed_action = 'route_changed', executed_at = p_now where id = dec.id;
        dec.status := 'executed';
      end if;
      arr := tp_sec.ops_delivered_at(dec.job_id, dec.stop_number);
      if arr is not null then
        update public.ops_decisions set measured_at = p_now,
          status = case when status in ('awaiting_approval', 'open') then 'measured' when status = 'rejected' then 'rejected' else 'measured' end,
          actual = jsonb_build_object('actual_at', arr,
            'actual_late_min', case when kind = 'promise_risk' then round((extract(epoch from (arr - (prediction->>'deliver_by')::timestamptz)) / 60)::numeric, 1)
                                    else round((extract(epoch from (arr - (prediction->>'deadline')::timestamptz)) / 60)::numeric, 1) end,
            'decision', status),
          error_min = case when kind = 'promise_risk' then round((extract(epoch from (arr - (prediction->>'predicted_at')::timestamptz)) / 60)::numeric, 1)
                           when prediction ? 'deadline' then round((extract(epoch from (arr - (prediction->>'deadline')::timestamptz)) / 60)::numeric - (prediction->>'late_min_at_detection')::numeric, 1) end
         where id = dec.id;
        n_measured := n_measured + 1;
      elsif exists (select 1 from public.jobs x where x.id = dec.job_id and (x.status = 'cancelled' or (coalesce(x.archived, false) and x.status not in ('delivered', 'completed_with_exceptions')))) then
        update public.ops_decisions set status = 'expired', measured_at = p_now, actual = jsonb_build_object('reason', 'route cancelled or removed') where id = dec.id;
      end if;
    end loop;

    -- ── Ruby: what drivers said today, each message categorised once ──
    if agents_on then
      cats := '{}'; cnt := 0;
      for m in select x.id, lower(x.body) as b from public.messages x join public.jobs y on y.id = x.job_id
                where y.org_id = o and x.sender_role = 'driver' and x.created_at >= day0 and x.created_at <= p_now
                  and x.body not like 'STOP_DELIVERED::%' and x.body not like 'SCAN_REJECTED::%' and x.body not like 'STOP_EXCEPTION::%' and x.body not like 'STOP_DRIFT::%'
                order by x.id loop
        continue when not tp_sec.claim(o::text, 'ruby:msg:' || m.id, 'Ruby', null, 'server');
        cats := jsonb_set(cats, array[case
          when m.b ~ '(traffic|jam|backed up|accident on)' then 'traffic'
          when m.b ~ '(not home|no answer|refused|wrong address|can''t find|couldn''t find)' then 'customer_issue'
          when m.b ~ '(flat tire|breakdown|broke down|car trouble|engine)' then 'vehicle_issue'
          when m.b ~ '(rain|storm|flooding|\mice\M|snow)' then 'weather'
          when m.b ~ '^(ok|okay|yes|got it|on it|sure|k|yep|yeah)\W*$' then 'acknowledgment'
          when m.b ~ '(help|stuck|confused|lost|don''t know|not sure)' then 'need_help'
          else 'other' end], to_jsonb(coalesce((cats->>(case
          when m.b ~ '(traffic|jam|backed up|accident on)' then 'traffic'
          when m.b ~ '(not home|no answer|refused|wrong address|can''t find|couldn''t find)' then 'customer_issue'
          when m.b ~ '(flat tire|breakdown|broke down|car trouble|engine)' then 'vehicle_issue'
          when m.b ~ '(rain|storm|flooding|\mice\M|snow)' then 'weather'
          when m.b ~ '^(ok|okay|yes|got it|on it|sure|k|yep|yeah)\W*$' then 'acknowledgment'
          when m.b ~ '(help|stuck|confused|lost|don''t know|not sure)' then 'need_help'
          else 'other' end))::int, 0) + 1));
        cnt := cnt + 1;
      end loop;
      if cnt > 0 then
        perform tp_sec.ops_memory(o, 'Ruby', 'pattern_analysis', null, null,
          jsonb_build_object('messages_analyzed', cnt, 'category_breakdown', cats, 'source', 'server'), 'analyzed');
        n_ruby := n_ruby + cnt;
      end if;

      -- ── Brain (Swarm Coordinator): patterns across today's agent activity ──
      select count(*) into cnt from public.agent_memory a
       where a.org_id = o and a.agent_name = 'SmartTrack' and a.event_type = 'stop_past_eta' and a.created_at >= day0;
      if cnt >= 3 and tp_sec.claim(o::text, 'brain:repeated:' || day, 'SwarmCoordinator', null, 'server') then
        perform tp_sec.ops_memory(o, 'SwarmCoordinator', 'pattern_detected', null, null, jsonb_build_object('pattern', 'repeated_exceptions',
          'exception_count', cnt, 'affected_drivers', (select jsonb_agg(distinct a.driver_name) from public.agent_memory a
             where a.org_id = o and a.agent_name = 'SmartTrack' and a.event_type = 'stop_past_eta' and a.created_at >= day0),
          'insight', cnt || ' delivery exceptions flagged today. Worth reviewing whether SmartSort route estimates need adjustment for current conditions.',
          'source', 'server'), 'flagged');
        n_brain := n_brain + 1;
      end if;
      for drv in select distinct a.driver_name from public.agent_memory a
                  where a.org_id = o and a.agent_name = 'SmartTrack' and a.event_type = 'stop_past_eta' and a.created_at >= day0 and a.driver_name is not null loop
        select count(*) filter (where coalesce(x.exception_flag, false)), count(*) into i, cnt from public.jobs x
         where x.org_id = o and x.driver_name = drv.driver_name and x.created_at > p_now - interval '30 days';
        if cnt >= 3 and i * 100 / cnt >= 30 and tp_sec.claim(o::text, 'brain:driver:' || drv.driver_name || ':' || day, 'SwarmCoordinator', null, 'server') then
          perform tp_sec.ops_memory(o, 'SwarmCoordinator', 'historical_pattern', null, drv.driver_name, jsonb_build_object('pattern', 'driver_exception_history',
            'insight', drv.driver_name || ' has an exception rate of ' || (i * 100 / cnt) || '% across ' || cnt || ' recent jobs — worth checking if this is route-related or driver-specific.',
            'source', 'server'), 'flagged');
          n_brain := n_brain + 1;
        end if;
      end loop;
      for m in select a.id, a.details from public.agent_memory a
                where a.org_id = o and a.agent_name = 'SmartSort' and a.event_type = 'cluster_created' and a.created_at >= day0 loop
        if coalesce((m.details->>'total_stops')::numeric, 0) > 0
           and (m.details->>'failed_geocodes')::numeric * 100 / (m.details->>'total_stops')::numeric > 15
           and tp_sec.claim(o::text, 'brain:geocode:' || m.id, 'SwarmCoordinator', null, 'server') then
          perform tp_sec.ops_memory(o, 'SwarmCoordinator', 'pattern_detected', null, null, jsonb_build_object('pattern', 'high_geocode_failure',
            'failed_count', m.details->'failed_geocodes', 'total_stops', m.details->'total_stops',
            'insight', round((m.details->>'failed_geocodes')::numeric * 100 / (m.details->>'total_stops')::numeric) || '% of addresses in a recent manifest failed to geocode.',
            'source', 'server'), 'flagged');
          n_brain := n_brain + 1;
        end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('exceptions_flagged', n_late, 'checkins', n_checkin, 'route_completions', n_done, 'messages_categorized', n_ruby,
    'patterns_detected', n_brain, 'promises_predicted', n_promise, 'promises_at_risk', n_risk, 'decisions_measured', n_measured,
    'server_agents', agents_on);
end $$;
revoke all on function tp_sec.ops_tick(timestamptz, uuid) from public, anon, authenticated;

-- the scheduler (swarm-watch with the service role) runs every company; swarm-watch passes a
-- signed-in company's own id (from its verified session) so it runs only that company's routes
create function public.tp_svc_ops_tick(p_org uuid default null, p_now timestamptz default null) returns jsonb
language sql security definer set search_path = '' as $$
  select tp_sec.ops_tick(coalesce(p_now, now()), p_org)
$$;
revoke all on function public.tp_svc_ops_tick(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.tp_svc_ops_tick(uuid, timestamptz) to service_role;

-- ── gateway: new company actions, everything else unchanged ──────────────
alter function public.tp_org(text,text,jsonb) rename to tp_org_v69;
alter function public.tp_org_v69(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v69(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}'); s tp_sec.sessions; org text; lim integer; res jsonb; decided public.ops_decisions;
begin
  if p_action not in ('agent_memory', 'agent_claim', 'agent_mode', 'decisions', 'decide', 'promise_watch', 'ops_insights') then
    return tp_sec.tp_org_v69(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;

  if p_action = 'agent_memory' then   -- only this company's rows (no org-less rows from any company)
    lim := tp_sec.clamp_limit(a, 100, 500);
    select coalesce(jsonb_agg(x.r order by x.c desc), '[]') into res from (
      select to_jsonb(m.*) as r, m.created_at as c from public.agent_memory m
       where m.org_id::text = org
         and (a->>'agent_name' is null or m.agent_name = a->>'agent_name')
         and (a->>'event_type' is null or m.event_type = a->>'event_type')
         and (a->>'since' is null or m.created_at >= (a->>'since')::timestamptz)
       order by m.created_at desc limit lim) x;
    return res;
  end if;

  if p_action = 'agent_mode' then
    return jsonb_build_object('server_agents', coalesce((tp_sec.setting('server_agents'))::boolean, true));
  end if;

  if p_action = 'agent_claim' then    -- the dispatcher asks before acting; false = someone already did it
    if a->>'job_id' is not null and not exists (select 1 from public.jobs j where j.id::text = a->>'job_id' and j.org_id::text = org) then
      raise exception 'TP_FORBIDDEN: not your route';
    end if;
    return jsonb_build_object('claimed', tp_sec.claim(org, a->>'key', coalesce(a->>'agent', 'dispatcher'),
      nullif(a->>'job_id', '')::uuid, 'dispatcher'));
  end if;

  if p_action = 'decisions' then
    lim := tp_sec.clamp_limit(a, 50, 500);
    select coalesce(jsonb_agg(to_jsonb(x.*) order by x.detected_at desc), '[]') into res from (
      select * from public.ops_decisions d where d.org_id::text = org
         and (a->>'status' is null or d.status = any (string_to_array(a->>'status', ',')))
         and (a->>'job_id' is null or d.job_id::text = a->>'job_id')
       order by d.detected_at desc limit lim) x;
    return res;
  end if;

  if p_action = 'decide' then         -- a person approves or rejects a change that needs approval
    if a->>'verdict' not in ('approve', 'reject') then raise exception 'TP_INVALID: verdict must be approve or reject'; end if;
    update public.ops_decisions set status = case when a->>'verdict' = 'approve' then 'approved' else 'rejected' end,
           decided_by = left(coalesce(nullif(a->>'by', ''), 'dispatcher'), 120), decided_at = now(), decision_note = left(a->>'note', 1000),
           snapshot = snapshot || jsonb_build_object('stops_total', (select jsonb_array_length(tp_sec.ops_stops(j)) from public.jobs j where j.id = ops_decisions.job_id))
     where id::text = a->>'id' and org_id::text = org and requires_approval and status = 'awaiting_approval'
     returning * into decided;
    if decided.id is null then raise exception 'TP_INVALID: no decision of yours is waiting for approval with that id'; end if;
    return to_jsonb(decided);
  end if;

  if p_action = 'promise_watch' then
    lim := tp_sec.clamp_limit(a, 500, 2000);
    select coalesce(jsonb_agg(to_jsonb(x.*) order by x.deliver_by), '[]') into res from (
      select p.job_id, p.stop_number, p.order_ref, p.deliver_by, p.predicted_at, p.slack_min, p.risk, p.basis, p.delivered_at, p.updated_at
        from public.ops_promise p where p.org_id::text = org
         and (a->>'since' is null or p.updated_at >= (a->>'since')::timestamptz)
       order by p.deliver_by limit lim) x;
    return res;
  end if;

  if p_action = 'ops_insights' then   -- Brain / OWL: how well the loop predicts and what it changes
    select jsonb_build_object(
      'since', now() - interval '30 days',
      'by_kind', coalesce((select jsonb_object_agg(k.kind, k.v) from (
          select d.kind, jsonb_build_object('detected', count(*), 'awaiting_approval', count(*) filter (where d.status = 'awaiting_approval'),
            'approved', count(*) filter (where d.decided_at is not null and d.status <> 'rejected'), 'rejected', count(*) filter (where d.status = 'rejected'),
            'measured', count(*) filter (where d.actual ? 'actual_at'),
            'mean_abs_error_min', round(avg(abs(d.error_min))::numeric, 1),
            'ended_late', count(*) filter (where (d.actual->>'actual_late_min')::numeric > 0),
            'ended_on_time', count(*) filter (where (d.actual->>'actual_late_min')::numeric <= 0)) as v
          from public.ops_decisions d where d.org_id::text = org and d.detected_at > now() - interval '30 days' group by d.kind) k), '{}'),
      'promises_now', coalesce((select jsonb_object_agg(r.risk, r.n) from (select p.risk, count(*) as n from public.ops_promise p
          where p.org_id::text = org and p.updated_at > now() - interval '1 day' group by p.risk) r), '{}'))
      into res;
    return res;
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

commit;
