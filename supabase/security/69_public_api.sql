-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 69 (2026-10-15): Public API v1.
--
-- Everything the external API needs, additive and reversible:
--   - a private schema tp_api (API keys, orders, batches, idempotency,
--     webhook endpoints/events/deliveries, status log, audit log, outbox);
--   - one gateway, public.tp_svc_api(action, args), executable by the
--     service role ONLY (the "api" and "api-webhooks" edge functions call
--     it). anon/authenticated cannot call it, so the public key still reaches
--     exactly the nine tp_* entry points migration 20 verified;
--   - four AFTER triggers (jobs, messages, PathIQ events, bin bindings) that
--     only queue one row in tp_api.outbox, and only for a company that uses
--     the API (an active webhook endpoint or live API orders). They read one
--     indexed row and insert one row: no order state, no scan of the
--     company's jobs, no webhook work. Each also catches every error.
--     Everything else (status history, order states, webhook events) is
--     computed later from the outbox by tp_api.process: by the webhook
--     worker every minute, and for the calling company at the start of each
--     API read, outside every dispatcher, PathIQ and driver write.
--
-- Credentials: keys look like tpk_live_<12 hex>_<64 hex>. Only the SHA-256 of
-- the whole key is stored, with the 12-hex prefix for lookup. Each key belongs
-- to one company (organizations.id) and carries scopes; it can be limited to
-- the orders it (or keys with the same client label) created. Keys are managed
-- with a company (dispatcher) session; nothing is shared between companies.
-- Test-mode keys (tpk_test_) keep their orders apart and never create jobs.
--
-- Orders and routes: a live order becomes a pending job on the company board
-- (the existing intake path, tp_sec.insert_json). It moves onto a route ONLY
-- when dispatch writes its TackPath order id (tp_order_id: "ord_...") on a
-- route stop or package, and only for an order of the same company. Tracking
-- numbers and external ids chosen by the customer never link an order to
-- anything; an intake tracking number already on a job of the company is
-- refused. PathIQ scans count for an order only on the job that carries it.
--
-- Needs 10 (tp_sec helpers). Works with or without 20-68. Changes no existing
-- function, table, policy or grant. Rollback: 69_public_api.rollback.sql.
-- Off switch without dropping anything: see docs/api/DEPLOY.md.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regnamespace('tp_sec') is null or to_regprocedure('tp_sec.insert_json(regclass,jsonb,text[])') is null
     or to_regprocedure('tp_sec.rate_ok(text,text,integer,interval)') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first (tp_sec helpers). Nothing was changed.';
  end if;
  if to_regnamespace('tp_api') is not null then
    raise exception 'Migration 69 is already applied. Nothing was changed.';
  end if;
  if to_regclass('public.jobs') is null or to_regclass('public.messages') is null or to_regclass('public.organizations') is null then
    raise exception 'public.jobs, public.messages and public.organizations are needed. Nothing was changed.';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'jobs'
       and column_name in ('id','org_id','status','driver_name','surge_stops','archived','created_at')) < 7 then
    raise exception 'public.jobs lacks one of id, org_id, status, driver_name, surge_stops, archived, created_at. Nothing was changed.';
  end if;
end $pre$;

create schema tp_api;
revoke all on schema tp_api from public;

-- ── 1. TABLES (private) ─────────────────────────────────────────────────
-- Kill switch: enabled = false makes both API functions answer 503 and send nothing.
create table tp_api.settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into tp_api.settings default values;

create table tp_api.keys (
  id              uuid primary key default gen_random_uuid(),
  org_key         text not null,
  name            text not null,
  prefix          text not null unique,          -- 12 hex, shown in the key and in lists
  secret_hash     text not null,                 -- sha256 hex of the whole key
  mode            text not null default 'live' check (mode in ('live','test')),
  scopes          text[] not null,
  own_orders_only boolean not null default false,
  client_label    text,                          -- keys with the same label share "own orders"
  rate_per_minute integer not null default 120 check (rate_per_minute between 1 and 6000),
  created_by      text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  rotated_from    uuid
);
create index on tp_api.keys (org_key);

create table tp_api.batches (
  id          uuid primary key default gen_random_uuid(),
  org_key     text not null,
  key_id      uuid,
  received    integer not null,
  accepted    integer not null,
  duplicates  integer not null,
  rejected    integer not null,
  results     jsonb not null,
  created_at  timestamptz not null default now()
);

create table tp_api.orders (
  id              uuid primary key default gen_random_uuid(),
  org_key         text not null,
  mode            text not null default 'live' check (mode in ('live','test')),
  key_id          uuid,
  client_label    text,
  external_id     text not null,
  tracking_number text not null,
  job_id          uuid,                 -- live orders: the job created at intake; test orders: none
  batch_id        uuid,
  recipient       text not null,
  address         text not null,
  packages        integer not null,
  details         jsonb not null default '{}',
  status          text not null default 'received',  -- last computed status (lists and filters read this)
  snapshot        jsonb,                -- the order as last computed (lists return this, never recompute)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index orders_org_external on tp_api.orders (org_key, mode, external_id);
create unique index orders_org_tracking on tp_api.orders (org_key, mode, upper(tracking_number));
create index on tp_api.orders (job_id);
create index orders_list on tp_api.orders (org_key, mode, created_at desc, id desc);
create index orders_by_status on tp_api.orders (org_key, mode, status, created_at desc, id desc);

-- An order is on a route only when dispatch wrote its TackPath order id there.
create table tp_api.order_links (
  order_id    uuid not null references tp_api.orders(id) on delete cascade,
  job_id      uuid not null,
  stop_number integer not null,
  linked_at   timestamptz not null default now(),
  primary key (order_id, job_id)
);
create index on tp_api.order_links (job_id);

-- Companies the triggers queue for: an active webhook endpoint or live API orders.
create table tp_api.watch (
  org_key text primary key,
  since   timestamptz not null default now()
);

-- What the triggers queue (one row per change), processed by tp_api.process.
create table tp_api.outbox (
  id             bigserial primary key,
  org_key        text not null,
  job_id         uuid not null,
  kind           text not null check (kind in ('job','stops','message','scan','bin')),
  from_status    text,
  to_status      text,
  driver_name    text,
  driver_changed boolean not null default false,
  body           text,                  -- message records: the record itself (STOP_DELIVERED::... etc.)
  at             timestamptz not null default now(),
  processed_at   timestamptz,
  error          text
);
create index outbox_due_org on tp_api.outbox (org_key, id) where processed_at is null;
create index outbox_due on tp_api.outbox (id) where processed_at is null;
create index on tp_api.outbox (job_id) where processed_at is null;

create table tp_api.idempotency (
  key_id       uuid not null,
  idem_key     text not null,
  op           text not null,
  request_hash text not null,
  status       integer not null,
  response     jsonb not null,            -- never holds a key or webhook secret
  created_at   timestamptz not null default now(),
  primary key (key_id, idem_key)
);

-- Every status change of a job of a company that uses the API (jobs has no
-- assigned_at etc.), from the outbox, with the time of the change.
create table tp_api.job_status_log (
  id          bigserial primary key,
  job_id      uuid not null,
  org_key     text,
  from_status text,
  to_status   text,
  driver_name text,
  at          timestamptz not null default now()
);
create index on tp_api.job_status_log (job_id, at);

create table tp_api.webhook_endpoints (
  id           uuid primary key default gen_random_uuid(),
  org_key      text not null,
  client_label text,                    -- null = every event of the company
  url          text not null,
  description  text,
  events       text[] not null,
  secret       text not null,           -- signing secret (whsec_...), never returned after creation
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  disabled_at  timestamptz
);
create index on tp_api.webhook_endpoints (org_key);

create table tp_api.events (
  id           uuid primary key default gen_random_uuid(),
  org_key      text not null,
  client_label text,
  type         text not null,
  order_id     uuid,
  job_id       uuid,
  data         jsonb not null,
  created_at   timestamptz not null default now()
);
create index on tp_api.events (org_key, created_at desc);

create table tp_api.deliveries (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references tp_api.events(id) on delete cascade,
  endpoint_id     uuid not null references tp_api.webhook_endpoints(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_status_code integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (event_id, endpoint_id)
);
create index on tp_api.deliveries (status, next_attempt_at);

create table tp_api.delivery_attempts (
  id          bigserial primary key,
  delivery_id uuid not null references tp_api.deliveries(id) on delete cascade,
  attempt     integer not null,
  at          timestamptz not null default now(),
  status_code integer,
  error       text,
  duration_ms integer
);

create table tp_api.audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  org_key     text,
  key_id      uuid,
  key_prefix  text,
  actor       text,                     -- 'key' or 'session'
  request_id  text,
  method      text,
  path        text,
  op          text,
  status      integer,
  error_code  text
);
create index on tp_api.audit (org_key, at desc);

-- ── 2. HELPERS ──────────────────────────────────────────────────────────
-- Errors that become API responses: TPAPI:<http status>:<code>:<message>
create function tp_api.fail(p_status integer, p_code text, p_msg text) returns void
language plpgsql set search_path = '' as $$
begin raise exception 'TPAPI:%:%:%', p_status, p_code, p_msg; end $$;

create function tp_api.err(p_status integer, p_code text, p_msg text) returns jsonb
language sql immutable set search_path = '' as
$$ select jsonb_build_object('status', p_status, 'body', jsonb_build_object('error', jsonb_build_object('code', p_code, 'message', p_msg))) $$;

-- an exception (sqlerrm, sqlstate) as an API response; never the database's own text
create function tp_api.err_out(p_msg text, p_state text) returns jsonb
language plpgsql set search_path = '' as $$
declare parts text[];
begin
  if p_msg like 'TPAPI:%' then
    parts := regexp_match(p_msg, '^TPAPI:([0-9]{3}):([a-z_]+):(.*)$');
    return tp_api.err(parts[1]::int, parts[2], parts[3]);
  elsif p_state in ('22P02','22007','22008','22003','23514') then
    return tp_api.err(400, 'invalid_request', 'A value in the request is not valid');
  end if;
  raise warning 'tp_api: % %', p_state, p_msg;
  return tp_api.err(500, 'internal_error', 'Something went wrong on our side. Please retry later');
end $$;

create function tp_api.ext_id(p_prefix text, p_id uuid) returns text
language sql immutable set search_path = '' as
$$ select case when p_id is null then null else p_prefix || '_' || replace(p_id::text, '-', '') end $$;

create function tp_api.parse_id(p_prefix text, p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ ('^' || p_prefix || '_[0-9a-f]{32}$') then return null; end if;
  return regexp_replace(substr(p, length(p_prefix) + 2), '^(.{8})(.{4})(.{4})(.{4})(.{12})$', '\1-\2-\3-\4-\5')::uuid;
end $$;

create function tp_api.safe_json(p text) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin return p::jsonb; exception when others then return null; end $$;

-- the JSON of a message body with a marker (STOP_DELIVERED:: etc.), or null
create function tp_api.marked(p_body text, p_marker text) returns jsonb
language sql immutable set search_path = '' as
$$ select case when p_body like p_marker || '%' then tp_api.safe_json(substr(p_body, length(p_marker) + 1)) end $$;

create function tp_api.ts(p text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
begin return p::timestamptz; exception when others then return null; end $$;

-- "Dana Reyes" -> "Dana R." (no phone, no surname)
create function tp_api.driver_display(p text) returns text
language sql immutable set search_path = '' as $$
  select case when coalesce(btrim(p), '') = '' then null
              when position(' ' in btrim(p)) = 0 then btrim(p)
              else split_part(btrim(p), ' ', 1) || ' ' || upper(left(split_part(btrim(p), ' ', 2), 1)) || '.' end
$$;

create function tp_api.route_status(p text) returns text
language sql immutable set search_path = '' as $$
  select case p when 'routing' then 'awaiting_confirmation' when 'pending' then 'unassigned'
    when 'assigned' then 'assigned' when 'in_transit' then 'in_progress' when 'delivered' then 'completed'
    when 'completed_with_exceptions' then 'completed_with_exceptions' when 'closed_with_exceptions' then 'completed_with_exceptions'
    when 'cancelled' then 'cancelled' else 'unknown' end
$$;

-- a route's stops as a JSON array (the column may hold an array or a JSON string)
create function tp_api.stops_value(v jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case jsonb_typeof(v)
    when 'array' then v
    when 'string' then (select case when jsonb_typeof(x) = 'array' then x else '[]'::jsonb end
                          from (select tp_api.safe_json(v #>> '{}') as x) s)
    else '[]'::jsonb end
$$;

create function tp_api.stops_of(j public.jobs) returns jsonb
language sql stable set search_path = '' as
$$ select tp_api.stops_value(to_jsonb(j.surge_stops)) $$;

-- every package code a route's stops carry (stop and package tracking numbers, piece ids), upper case
create function tp_api.stop_codes(p_stops jsonb) returns setof text
language sql immutable set search_path = '' as $$
  select distinct upper(btrim(c)) from (
    select s->>'tracking_number' as c from jsonb_array_elements(p_stops) s
    union all
    select k->>f from jsonb_array_elements(p_stops) s,
                      jsonb_array_elements(case when jsonb_typeof(s->'pkgs') = 'array' then s->'pkgs' else '[]' end) k,
                      unnest(array['tracking_number', 'piece_id']) f
  ) x where coalesce(btrim(c), '') <> ''
$$;

-- every package code on any job of a company (intake refuses these as tracking numbers)
create function tp_api.company_codes(p_org text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(distinct c), '{}')
    from public.jobs j, lateral tp_api.stop_codes(tp_api.stops_value(to_jsonb(j.surge_stops))) c
   where j.org_id::text = p_org and j.surge_stops is not null
$$;

-- the TackPath order ids dispatch wrote on a stop or its packages
create function tp_api.stop_order_ids(p_stop jsonb) returns setof text
language sql immutable set search_path = '' as $$
  select p_stop->>'tp_order_id' where coalesce(p_stop->>'tp_order_id', '') <> ''
  union
  select k->>'tp_order_id' from jsonb_array_elements(case when jsonb_typeof(p_stop->'pkgs') = 'array' then p_stop->'pkgs' else '[]' end) k
   where coalesce(k->>'tp_order_id', '') <> ''
$$;

-- Rebuild the links of one job from its stops. Only live orders of the same
-- company are linked. Returns the orders linked before and after.
create function tp_api.relink(p_job uuid) returns uuid[]
language plpgsql set search_path = '' as $$
declare j public.jobs; before uuid[]; after uuid[];
begin
  select coalesce(array_agg(order_id), '{}') into before from tp_api.order_links where job_id = p_job;
  delete from tp_api.order_links where job_id = p_job;
  select * into j from public.jobs where id = p_job;
  if j.id is not null and j.org_id is not null then
    insert into tp_api.order_links (order_id, job_id, stop_number)
    select distinct on (o.id) o.id, j.id, e.n::int
      from jsonb_array_elements(tp_api.stops_of(j)) with ordinality e(v, n)
      cross join lateral tp_api.stop_order_ids(e.v) x(oid)
      join tp_api.orders o on o.id = tp_api.parse_id('ord', x.oid)
     where o.org_key = j.org_id::text and o.mode = 'live'
     order by o.id, e.n;
  end if;
  select coalesce(array_agg(order_id), '{}') into after from tp_api.order_links where job_id = p_job;
  return before || after;
end $$;

-- The job that carries the order, and its stop number: the newest route that
-- dispatch linked the order to by its TackPath id, else the intake job (stop 1).
create function tp_api.locate(o tp_api.orders) returns jsonb
language plpgsql stable set search_path = '' as $$
declare j public.jobs; jid uuid; n integer;
begin
  select l.job_id, l.stop_number into jid, n
    from tp_api.order_links l join public.jobs jj on jj.id = l.job_id
   where l.order_id = o.id and not coalesce(jj.archived, false)
   order by jj.created_at desc limit 1;
  if jid is not null then
    select * into j from public.jobs where id = jid;
    return jsonb_build_object('job', to_jsonb(j), 'stop_number', n, 'stop', tp_api.stops_of(j)->(n - 1), 'routed', true);
  end if;
  if o.job_id is null then return null; end if;
  select * into j from public.jobs where id = o.job_id;
  if j.id is null then return null; end if;
  return jsonb_build_object('job', to_jsonb(j), 'stop_number', 1, 'stop', null, 'routed', false);
end $$;

-- the package codes of an order: its tracking number, plus the codes dispatch
-- put with its TackPath id: the stop's own tracking number when the stop
-- carries the id, and the packages that carry the id (or, on a stop that
-- carries it, packages without an id of their own). Packages of other
-- orders at a shared stop are never included.
create function tp_api.order_codes(o tp_api.orders, p_stop jsonb) returns text[]
language sql stable set search_path = '' as $$
  select array_agg(distinct c) from (
    select upper(o.tracking_number) as c
    union all
    select upper(p_stop->>'tracking_number') where p_stop->>'tp_order_id' = tp_api.ext_id('ord', o.id)
    union all
    select upper(k->>f) from jsonb_array_elements(case when jsonb_typeof(p_stop->'pkgs') = 'array' then p_stop->'pkgs' else '[]' end) k,
                             unnest(array['tracking_number', 'piece_id']) f
     where k->>'tp_order_id' = tp_api.ext_id('ord', o.id)
        or (coalesce(k->>'tp_order_id', '') = '' and p_stop->>'tp_order_id' = tp_api.ext_id('ord', o.id))
  ) x where coalesce(c, '') <> ''
$$;

-- a job's status at a time: the last recorded change at or before it, else
-- the status before the first later change, else its status now
create function tp_api.job_status_at(p_job uuid, p_now text, p_at timestamptz) returns text
language sql stable set search_path = '' as $$
  with ch as (
    select at, id as seq, from_status, to_status from tp_api.job_status_log where job_id = p_job
    union all
    select at, id, from_status, to_status from tp_api.outbox
     where job_id = p_job and kind = 'job' and processed_at is null and from_status is distinct from to_status)
  select coalesce((select to_status from ch where at <= p_at order by at desc, seq desc limit 1),
                  (select from_status from ch where at > p_at order by at, seq limit 1),
                  p_now)
$$;

-- The stop's latest record of a kind (STOP_DELIVERED / STOP_EXCEPTION), by stop number only.
create function tp_api.stop_record(p_job uuid, p_stop integer, p_marker text, p_at timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  select r || jsonb_build_object('_recorded_at', m.created_at) from public.messages m,
         lateral (select tp_api.marked(m.body, p_marker) as r) x
   where m.job_id = p_job and r is not null and coalesce(r->>'stop_number', '') = p_stop::text
     and (p_at is null or m.created_at <= p_at)
   order by m.created_at desc limit 1
$$;

-- Everything we know about an order (now, or as it was at p_at), from the
-- apps' own records on the job that carries it.
create function tp_api.order_state(o tp_api.orders, p_at timestamptz default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  loc jsonb := tp_api.locate(o);
  j jsonb := loc->'job';
  jid uuid := (j->>'id')::uuid;
  sn integer := coalesce((loc->>'stop_number')::int, 1);
  st jsonb := loc->'stop';
  codes text[];
  dlv jsonb; exc jsonb;
  sorted_at timestamptz; staged_at timestamptz; staging text; bin text;
  s text := 'received'; js text;
begin
  if jid is null then return jsonb_build_object('status', 'received'); end if;   -- test orders; a removed job
  js := case when p_at is null then j->>'status' else tp_api.job_status_at(jid, j->>'status', p_at) end;
  dlv := tp_api.stop_record(jid, sn, 'STOP_DELIVERED::', p_at);
  exc := tp_api.stop_record(jid, sn, 'STOP_EXCEPTION::', p_at);
  codes := tp_api.order_codes(o, st);
  if to_regclass('public.events') is not null then
    execute $q$ select min(e.occurred_at) from public.events e
       where e.job_id = $1 and e.event_type = 'package.stowed'
         and (upper(coalesce(e.payload->>'code', '')) = any($2) or upper(coalesce(e.payload->>'piece', '')) = any($2))
         and ($3::timestamptz is null or e.recorded_at <= $3) $q$
      into sorted_at using jid, codes, p_at;
  end if;
  if to_regclass('public.bin_bindings') is not null then
    execute $q$ select b.bin_code, to_jsonb(b)->>'staging_code', tp_api.ts(to_jsonb(b)->>'staged_at')
                  from public.bin_bindings b where b.job_id = $1 order by b.opened_at desc limit 1 $q$
      into bin, staging, staged_at using jid;
    if p_at is not null and staged_at > p_at then staged_at := null; staging := null; end if;
  end if;
  if staged_at is null and to_regclass('public.events') is not null then
    execute $q$ select min(e.occurred_at) from public.events e where e.job_id = $1 and e.event_type = 'bin.staged'
                 and ($2::timestamptz is null or e.recorded_at <= $2) $q$
      into staged_at using jid, p_at;
  end if;

  if dlv is not null then s := 'delivered';
  elsif exc is not null then
    s := case when exc->>'reason' in ('no_access','business_closed') then 'delivery_attempted' else 'exception' end;
  elsif js = 'cancelled' or coalesce((st->>'cancelled')::boolean, false) then s := 'cancelled';
  elsif js in ('delivered','completed_with_exceptions','closed_with_exceptions') and not coalesce((loc->>'routed')::boolean, false) then
    s := 'delivered';             -- a single delivery finished without a stop record
  elsif js = 'in_transit' then s := 'out_for_delivery';
  elsif staged_at is not null then s := 'staged';
  elsif sorted_at is not null then s := 'sorted';
  elsif js = 'assigned' then s := 'assigned';
  end if;

  -- absent facts are left out (not JSON null), so callers can test them with IS NULL
  return jsonb_strip_nulls(jsonb_build_object('status', s, 'job', j, 'stop_number', sn, 'routed', coalesce((loc->>'routed')::boolean, false),
    'delivered', dlv, 'exception', exc, 'sorted_at', sorted_at, 'staged_at', staged_at, 'staging_spot', staging, 'bin', bin,
    'codes', to_jsonb(codes)));
end $$;

create function tp_api.order_json(o tp_api.orders, p_at timestamptz default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb := tp_api.order_state(o, p_at); j jsonb := s->'job';
begin
  return jsonb_build_object(
    'id', tp_api.ext_id('ord', o.id), 'object', 'order', 'mode', o.mode,
    'external_id', o.external_id, 'tracking_number', o.tracking_number,
    'status', s->>'status',
    'recipient', jsonb_build_object('name', o.recipient),
    'address', o.address, 'packages', o.packages,
    'details', o.details,
    'route', case when j is null then null else jsonb_build_object(
        'id', tp_api.ext_id('rte', (j->>'id')::uuid), 'status', tp_api.route_status(j->>'status'),
        'stop_number', (s->>'stop_number')::int,
        'driver', case when coalesce(j->>'driver_name','') = '' then null
                       else jsonb_build_object('name', tp_api.driver_display(j->>'driver_name')) end) end,
    'sorted_at', s->'sorted_at', 'staged_at', s->'staged_at', 'staging_spot', s->'staging_spot',
    'out_for_delivery_at', case when p_at is null or tp_api.ts(j->>'picked_up_at') <= p_at then j->'picked_up_at' end,
    'delivered_at', coalesce(s->'delivered'->'delivered_at', case when s->>'status' = 'delivered' then j->'delivered_at' end),
    'proof_of_delivery_available', (s->'delivered') is not null,
    'batch_id', tp_api.ext_id('bat', o.batch_id),
    'created_at', o.created_at);
end $$;

-- The order's lifecycle events, oldest first. Only what was recorded.
create function tp_api.order_events(o tp_api.orders) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb := tp_api.order_state(o); j jsonb := s->'job'; jid uuid := (j->>'id')::uuid;
  ev jsonb := '[]'; pq jsonb := '[]'; x jsonb := s->'exception'; d jsonb := s->'delivered';
  codes text[] := array(select jsonb_array_elements_text(coalesce(s->'codes', '[]')));
begin
  ev := ev || jsonb_build_array(jsonb_build_object('type','received','occurred_at', o.created_at, 'source','api'));
  if jid is not null and to_regclass('public.events') is not null then      -- PathIQ scans of this package on its job
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object(
               'type', case e.event_type when 'package.inducted' then 'received_at_warehouse' else 'sorted' end,
               'occurred_at', e.occurred_at, 'source', 'pathiq', 'bin', e.payload->'bin') order by e.occurred_at), '[]')
          from public.events e
         where e.job_id = $1 and e.event_type in ('package.inducted','package.stowed')
           and (upper(coalesce(e.payload->>'code','')) = any($2) or upper(coalesce(e.payload->>'piece','')) = any($2)) $q$
      into pq using jid, codes;
    ev := ev || pq;
  end if;
  if (s->>'staged_at') is not null then
    ev := ev || jsonb_build_array(jsonb_build_object('type','staged','occurred_at', s->'staged_at','source','pathiq',
                                                     'staging_spot', s->'staging_spot'));
  end if;
  if jid is not null then
    ev := ev || coalesce((select jsonb_agg(jsonb_build_object(
              'type', case l.to_status when 'assigned' then 'assigned' when 'in_transit' then 'out_for_delivery'
                        when 'cancelled' then 'cancelled' else 'unassigned' end,
              'occurred_at', l.at, 'source', 'dispatch',
              'driver', case when l.to_status = 'assigned' then tp_api.driver_display(l.driver_name) end) order by l.at)
            from tp_api.job_status_log l where l.job_id = jid
             and l.to_status in ('assigned','in_transit','cancelled','pending')), '[]');
    -- without a status log entry: the pickup time of migration 68, if recorded
    if (j->>'picked_up_at') is not null
       and not exists (select 1 from tp_api.job_status_log l where l.job_id = jid and l.to_status = 'in_transit') then
      ev := ev || jsonb_build_array(jsonb_build_object('type','out_for_delivery','occurred_at', j->'picked_up_at','source','driver'));
    end if;
    if x is not null then
      ev := ev || jsonb_build_array(jsonb_build_object(
        'type', case when x->>'reason' in ('no_access','business_closed') then 'delivery_attempted' else 'exception' end,
        'occurred_at', coalesce(x->'reported_at', x->'_recorded_at'), 'source','driver',
        'reason', x->'reason', 'reason_label', x->'reason_label'));
    end if;
    if d is not null then
      ev := ev || jsonb_build_array(jsonb_build_object('type','delivered',
        'occurred_at', coalesce(d->'delivered_at', d->'_recorded_at'), 'source','driver'));
    elsif s->>'status' = 'delivered' and (j->>'delivered_at') is not null then
      ev := ev || jsonb_build_array(jsonb_build_object('type','delivered','occurred_at', j->'delivered_at','source','driver'));
    end if;
  end if;
  select coalesce(jsonb_agg(e order by tp_api.ts(e->>'occurred_at') nulls last), '[]') into ev from jsonb_array_elements(ev) e;
  return ev;
end $$;

-- Proof of delivery: the delivery record and the media paths in the private
-- "pod" bucket (the edge function turns paths into short-lived signed links).
-- Only files under the carrying job's own folder are returned.
create function tp_api.order_pod(o tp_api.orders) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s jsonb := tp_api.order_state(o); d jsonb := s->'delivered'; jid uuid := (s->'job'->>'id')::uuid;
  sn integer := (s->>'stop_number')::int; media jsonb := '[]';
begin
  if d is null or jid is null then perform tp_api.fail(404, 'pod_not_available', 'No proof of delivery has been recorded for this order'); end if;
  if coalesce(d->>'pod_url','') <> '' then
    media := media || jsonb_build_array(jsonb_build_object('kind', coalesce(d->>'pod_kind','photo'), 'path', d->>'pod_url'));
  end if;
  media := media || coalesce((select jsonb_agg(jsonb_build_object('kind', r->>'kind', 'path', r->>'url') order by m.created_at)
      from public.messages m, lateral (select tp_api.marked(m.body, 'POD_ATTACHED::') as r) x
     where m.job_id = jid and r is not null and coalesce(r->>'stop','') = sn::text and r->>'problem' is null
       and coalesce(r->>'url','') <> ''), '[]');
  select coalesce(jsonb_agg(distinct x), '[]') into media from jsonb_array_elements(media) x
   where x->>'path' like jid::text || '/%' and x->>'path' not like '%..%';
  return jsonb_build_object('order_id', tp_api.ext_id('ord', o.id), 'object', 'proof_of_delivery',
    'delivered_at', d->'delivered_at', 'recorded_at', d->'_recorded_at',
    'recipient_name', coalesce(d->'signed_by', d->'recipient'),
    'delivery_method', d->'delivery_choice', 'delivery_method_label', d->'delivery_choice_label',
    'notes', d->'notes', 'packages_verified', d->'packages_verified',
    'media_pending', coalesce((d->>'pod_pending')::boolean, false) and jsonb_array_length(media) = 0,
    'media', media);
end $$;

create function tp_api.route_json(j public.jobs, p_detail boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare r jsonb := to_jsonb(j); stops jsonb := tp_api.stops_of(j); bb jsonb; res jsonb;
begin
  if to_regclass('public.bin_bindings') is not null then
    execute 'select to_jsonb(b) from public.bin_bindings b where b.job_id = $1 order by b.opened_at desc limit 1' into bb using j.id;
  end if;
  res := jsonb_build_object('id', tp_api.ext_id('rte', j.id), 'object', 'route',
    'type', case when r->>'job_type' = 'surge' then 'route' else 'single_delivery' end,
    'title', r->'title', 'status', tp_api.route_status(r->>'status'),
    'stops_total', coalesce((r->>'total_stops')::int, nullif(jsonb_array_length(stops), 0), 1),
    'stops_completed', coalesce((r->>'stops_completed')::int, 0),
    'packages_total', r->'total_packages',
    'driver', case when coalesce(r->>'driver_name','') = '' then null else jsonb_build_object('name', tp_api.driver_display(r->>'driver_name')) end,
    'bin', bb->'bin_code', 'staging_spot', bb->'staging_code', 'staged_at', bb->'staged_at',
    'estimated_delivery_at', r->'estimated_delivery_at', 'picked_up_at', r->'picked_up_at',
    'completed_at', r->'delivered_at', 'created_at', r->'created_at');
  if p_detail then
    res := res || jsonb_build_object('stops', coalesce((select jsonb_agg(jsonb_build_object(
        'stop_number', e.n, 'order_id', e.v->'order_id', 'tracking_number', e.v->'tracking_number',
        'recipient', e.v->'recipient', 'address', e.v->'address', 'packages', e.v->'packages',
        'status', case when tp_api.stop_record(j.id, e.n::int, 'STOP_DELIVERED::', null) is not null then 'delivered'
                       when tp_api.stop_record(j.id, e.n::int, 'STOP_EXCEPTION::', null) is not null then 'exception'
                       when coalesce((e.v->>'cancelled')::boolean, false) then 'cancelled' else 'pending' end) order by e.n)
      from jsonb_array_elements(stops) with ordinality e(v, n)), '[]'));
  end if;
  return res;
end $$;

-- ── 3. PRINCIPALS, SCOPES, RATE LIMITS ──────────────────────────────────
create function tp_api.all_scopes() returns text[]
language sql immutable set search_path = '' as
$$ select array['orders:write','orders:read','routes:read','tracking:read','pod:read','webhooks:manage'] $$;

create function tp_api.op_scope(p_op text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_op in ('orders.create','orders.batch') then 'orders:write'
    when p_op in ('orders.list','orders.get','batches.get') then 'orders:read'
    when p_op in ('orders.events','tracking.get') then 'tracking:read'
    when p_op = 'orders.pod' then 'pod:read'
    when p_op in ('routes.list','routes.get') then 'routes:read'
    when p_op like 'webhooks.%' or p_op = 'events.list' then 'webhooks:manage'
  end
$$;

-- The caller: an API key (Authorization: Bearer tpk_...) or a company session
-- (the developer page). Raises TPAPI:401 when neither is valid.
create function tp_api.principal(a jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare k tp_api.keys; s tp_sec.sessions; raw text := a->>'key'; pre text;
begin
  if a ? 'session' then
    begin s := tp_sec.session(a->>'session', 'org');
    exception when others then perform tp_api.fail(401, 'invalid_session', 'Sign in again'); end;
    return jsonb_build_object('kind','session','org_key', s.org_key, 'scopes', to_jsonb(tp_api.all_scopes()), 'mode', 'live',
      'own_orders_only', false, 'client_label', null, 'key_id', null, 'rate', 600);
  end if;
  if raw is null or raw !~ '^tpk_(live|test)_[0-9a-f]{12}_[0-9a-f]{64}$' then
    perform tp_api.fail(401, 'invalid_api_key', 'Missing or malformed API key');
  end if;
  pre := split_part(raw, '_', 3);
  select * into k from tp_api.keys where prefix = pre;
  if k.id is null or k.secret_hash <> tp_sec.sha256_hex(raw) then
    perform tp_api.fail(401, 'invalid_api_key', 'Invalid API key');
  end if;
  if k.revoked_at is not null then perform tp_api.fail(401, 'api_key_revoked', 'This API key was revoked'); end if;
  if k.expires_at is not null and k.expires_at <= now() then perform tp_api.fail(401, 'api_key_expired', 'This API key has expired'); end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update tp_api.keys set last_used_at = now() where id = k.id;
  end if;
  return jsonb_build_object('kind','key','org_key', k.org_key, 'scopes', to_jsonb(k.scopes), 'own_orders_only', k.own_orders_only,
    'client_label', coalesce(k.client_label, k.id::text), 'key_id', k.id, 'prefix', k.prefix, 'rate', k.rate_per_minute, 'mode', k.mode);
end $$;

-- may this caller see this order? (same company, same mode, and its own if limited)
create function tp_api.can_see(p jsonb, o tp_api.orders) returns boolean
language sql stable set search_path = '' as $$
  select o.org_key = p->>'org_key' and o.mode = coalesce(p->>'mode', 'live')
     and (not coalesce((p->>'own_orders_only')::boolean, false) or coalesce(o.client_label, '') = p->>'client_label')
$$;

create function tp_api.find_order(p jsonb, p_id text) returns tp_api.orders
language plpgsql stable set search_path = '' as $$
declare o tp_api.orders; u uuid := tp_api.parse_id('ord', p_id);
begin
  if u is not null then select * into o from tp_api.orders where id = u;
  else select * into o from tp_api.orders where org_key = p->>'org_key' and mode = coalesce(p->>'mode', 'live') and external_id = p_id; end if;
  if o.id is null or not tp_api.can_see(p, o) then perform tp_api.fail(404, 'not_found', 'No such order'); end if;
  return o;
end $$;

-- ── 4. QUEUE, WEBHOOK EVENTS, PROCESSING (never inside an operational write) ──
create function tp_api.all_events() returns text[]
language sql immutable set search_path = '' as $$
  select array['order.status_changed','route.assignment_changed','delivery.completed','delivery.exception','pod.available']
$$;

-- keep tp_api.watch true to "this company has an active endpoint or live API orders"
create function tp_api.rewatch(p_org text) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from tp_api.webhook_endpoints where org_key = p_org and active)
     or exists (select 1 from tp_api.orders where org_key = p_org and mode = 'live') then
    insert into tp_api.watch (org_key) values (p_org) on conflict do nothing;
  else
    delete from tp_api.watch where org_key = p_org;
  end if;
end $$;

create function tp_api.listens(p_org text, p_type text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from tp_api.webhook_endpoints w where w.org_key = p_org and w.active and p_type = any(w.events))
$$;

create function tp_api.emit(p_org text, p_type text, p_order uuid, p_job uuid, p_label text, p_data jsonb) returns void
language plpgsql set search_path = '' as $$
declare ev uuid;
begin
  if not tp_api.listens(p_org, p_type) then
    return;   -- nobody listens: nothing is stored
  end if;
  insert into tp_api.events (org_key, client_label, type, order_id, job_id, data)
  values (p_org, p_label, p_type, p_order, p_job, p_data) returning id into ev;
  insert into tp_api.deliveries (event_id, endpoint_id)
  select ev, w.id from tp_api.webhook_endpoints w
   where w.org_key = p_org and w.active and p_type = any(w.events)
     and (w.client_label is null or (p_label is not null and w.client_label = p_label))
     and (p_type <> 'route.assignment_changed' or w.client_label is null);
end $$;

-- orders carried by a job: created with it, or linked to it by dispatch
create function tp_api.orders_of_job(p_job uuid) returns setof tp_api.orders
language sql stable set search_path = '' as $$
  select o.* from tp_api.orders o where o.job_id = p_job
  union
  select o.* from tp_api.order_links l join tp_api.orders o on o.id = l.order_id where l.job_id = p_job
$$;

-- an order's status as it was at p_at: sent when it changed (only if someone listens)
create function tp_api.emit_status(p_order uuid, p_job uuid, p_at timestamptz) returns void
language plpgsql set search_path = '' as $$
declare o tp_api.orders; cur jsonb;
begin
  select * into o from tp_api.orders where id = p_order;
  if o.id is null or not tp_api.listens(o.org_key, 'order.status_changed') then return; end if;
  cur := tp_api.order_json(o, p_at);
  if cur->>'status' is distinct from o.status then
    update tp_api.orders set status = cur->>'status', updated_at = now() where id = o.id;
    perform tp_api.emit(o.org_key, 'order.status_changed', o.id, p_job, o.client_label,
      jsonb_build_object('order', cur, 'previous_status', o.status));
  end if;
end $$;

-- store an order as it is now (lists read this); send its status if it changed
create function tp_api.refresh(p_order uuid) returns void
language plpgsql set search_path = '' as $$
declare o tp_api.orders; cur jsonb;
begin
  select * into o from tp_api.orders where id = p_order;
  if o.id is null then return; end if;
  cur := tp_api.order_json(o);
  if cur->>'status' is distinct from o.status then
    perform tp_api.emit(o.org_key, 'order.status_changed', o.id, tp_api.parse_id('rte', cur->'route'->>'id'), o.client_label,
      jsonb_build_object('order', cur, 'previous_status', o.status));
  end if;
  update tp_api.orders set status = cur->>'status', snapshot = cur, updated_at = now() where id = o.id;
end $$;

-- one queued change: status history, route and delivery events, order statuses
create function tp_api.process_one(r tp_api.outbox) returns uuid[]
language plpgsql set search_path = '' as $$
declare j public.jobs; touched uuid[] := '{}'; o tp_api.orders; st jsonb; ord jsonb; rec jsonb; kind text;
begin
  select * into j from public.jobs where id = r.job_id;
  if j.id is null then return touched; end if;
  if r.kind = 'stops' then touched := touched || tp_api.relink(j.id); end if;
  if r.kind = 'job' then
    if r.from_status is distinct from r.to_status then
      insert into tp_api.job_status_log (job_id, org_key, from_status, to_status, driver_name, at)
      values (j.id, r.org_key, r.from_status, r.to_status, r.driver_name, r.at);
    end if;
    if r.driver_changed or (r.to_status = 'assigned' and r.from_status is distinct from 'assigned') then
      perform tp_api.emit(r.org_key, 'route.assignment_changed', null, j.id, null, jsonb_build_object('route', tp_api.route_json(j, false)));
    end if;
  end if;
  if r.kind = 'message' and r.body is not null then
    kind := split_part(r.body, '::', 1);
    rec := tp_api.safe_json(substr(r.body, length(kind) + 3));
  end if;
  for o in select * from tp_api.orders_of_job(j.id) loop
    touched := touched || o.id;
    if rec is not null and (tp_api.listens(o.org_key, 'delivery.completed') or tp_api.listens(o.org_key, 'delivery.exception')
                            or tp_api.listens(o.org_key, 'pod.available')) then
      st := tp_api.order_state(o, r.at);
      if (st->'job'->>'id')::uuid is not distinct from j.id
         and coalesce(case when kind = 'POD_ATTACHED' then rec->>'stop' else rec->>'stop_number' end, '') = (st->>'stop_number') then
        ord := tp_api.order_json(o, r.at);
        if kind = 'STOP_DELIVERED' then
          perform tp_api.emit(o.org_key, 'delivery.completed', o.id, j.id, o.client_label, jsonb_build_object('order', ord));
          if coalesce(rec->>'pod_url','') <> '' then
            perform tp_api.emit(o.org_key, 'pod.available', o.id, j.id, o.client_label, jsonb_build_object('order', ord));
          end if;
        elsif kind = 'STOP_EXCEPTION' then
          perform tp_api.emit(o.org_key, 'delivery.exception', o.id, j.id, o.client_label,
            jsonb_build_object('order', ord, 'reason', rec->'reason', 'reason_label', rec->'reason_label'));
        elsif kind = 'POD_ATTACHED' and rec->>'problem' is null and st->'delivered' is not null then
          perform tp_api.emit(o.org_key, 'pod.available', o.id, j.id, o.client_label, jsonb_build_object('order', ord));
        end if;
      end if;
    end if;
    perform tp_api.emit_status(o.id, j.id, r.at);
  end loop;
  return touched;
end $$;

-- Work through queued changes, oldest first: one company (p_org) or all.
-- Each row is processed on its own; a row that fails is marked with its
-- error and never blocks the rest. Stops after about 2 seconds.
create function tp_api.process(p_org text, p_limit integer) returns integer
language plpgsql set search_path = '' as $$
declare r tp_api.outbox; n integer := 0; touched uuid[] := '{}'; oid uuid;
begin
  for r in select * from tp_api.outbox
            where processed_at is null and (p_org is null or org_key = p_org)
            order by id limit greatest(least(coalesce(p_limit, 200), 1000), 1)
            for update skip locked loop
    exit when clock_timestamp() - statement_timestamp() > interval '2 seconds';
    begin
      touched := touched || tp_api.process_one(r);
      update tp_api.outbox set processed_at = now() where id = r.id;
    exception when others then
      update tp_api.outbox set processed_at = now(), error = left(sqlerrm, 300) where id = r.id;
    end;
    n := n + 1;
  end loop;
  for oid in select distinct x from unnest(touched) x loop
    begin perform tp_api.refresh(oid);
    exception when others then raise warning 'tp_api.refresh: %', sqlerrm; end;
  end loop;
  if random() < 0.01 then delete from tp_api.outbox where processed_at < now() - interval '2 days'; end if;
  return n;
end $$;

-- The triggers: one indexed read, at most one insert, every error caught.
create function tp_api.on_job_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.org_id is null then return null; end if;
    -- a company that does not use the API: one indexed read, nothing else
    if not exists (select 1 from tp_api.watch w where w.org_key = new.org_id::text) then return null; end if;
    if tg_op = 'INSERT' then
      if coalesce(new.surge_stops::text, '') like '%tp_order_id%' then
        insert into tp_api.outbox (org_key, job_id, kind) values (new.org_id::text, new.id, 'stops');
      end if;
      return null;
    end if;
    if new.surge_stops is distinct from old.surge_stops
       and (coalesce(new.surge_stops::text, '') like '%tp_order_id%' or coalesce(old.surge_stops::text, '') like '%tp_order_id%') then
      insert into tp_api.outbox (org_key, job_id, kind) values (new.org_id::text, new.id, 'stops');
    end if;
    if new.status is distinct from old.status or new.driver_name is distinct from old.driver_name then
      insert into tp_api.outbox (org_key, job_id, kind, from_status, to_status, driver_name, driver_changed)
      values (new.org_id::text, new.id, 'job', old.status, new.status, new.driver_name, new.driver_name is distinct from old.driver_name);
    end if;
  exception when others then
    raise warning 'tp_api.on_job_change: %', sqlerrm;   -- never fail the job write
  end;
  return null;
end $$;

create function tp_api.on_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare org uuid;
begin
  begin
    if new.job_id is null or new.body is null or new.body !~ '^(STOP_DELIVERED|STOP_EXCEPTION|POD_ATTACHED)::' then return null; end if;
    select j.org_id into org from public.jobs j where j.id = new.job_id;
    if org is null or not exists (select 1 from tp_api.watch w where w.org_key = org::text) then return null; end if;
    insert into tp_api.outbox (org_key, job_id, kind, body) values (org::text, new.job_id, 'message', left(new.body, 20000));
  exception when others then
    raise warning 'tp_api.on_message: %', sqlerrm;      -- never fail the driver's message
  end;
  return null;
end $$;

create function tp_api.on_scan() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.job_id is null or new.org_id is null or new.event_type not in ('package.stowed','package.inducted','bin.staged') then return null; end if;
    if not exists (select 1 from tp_api.watch w where w.org_key = new.org_id::text) then return null; end if;
    insert into tp_api.outbox (org_key, job_id, kind) values (new.org_id::text, new.job_id, 'scan');
  exception when others then
    raise warning 'tp_api.on_scan: %', sqlerrm;         -- never fail a PathIQ scan
  end;
  return null;
end $$;

create function tp_api.on_bin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.job_id is null or new.org_id is null then return null; end if;
    if not exists (select 1 from tp_api.watch w where w.org_key = new.org_id::text) then return null; end if;
    insert into tp_api.outbox (org_key, job_id, kind) values (new.org_id::text, new.job_id, 'bin');
  exception when others then
    raise warning 'tp_api.on_bin: %', sqlerrm;          -- never fail a bin binding
  end;
  return null;
end $$;

create trigger tp_api_job_change after insert or update of status, driver_name, surge_stops on public.jobs
  for each row execute function tp_api.on_job_change();
create trigger tp_api_message after insert on public.messages
  for each row execute function tp_api.on_message();
do $trg$
begin
  if to_regclass('public.events') is not null then
    execute 'create trigger tp_api_scan after insert on public.events for each row execute function tp_api.on_scan()';
  end if;
  if to_regclass('public.bin_bindings') is not null then
    execute 'create trigger tp_api_bin after insert or update on public.bin_bindings for each row execute function tp_api.on_bin()';
  end if;
end $trg$;

-- ── 5. OPERATIONS ───────────────────────────────────────────────────────
create function tp_api.page(a jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare lim integer := least(greatest(coalesce(nullif(a->>'limit','')::int, 50), 1), 200); c jsonb;
begin
  if coalesce(a->>'cursor','') <> '' then
    c := tp_api.safe_json(convert_from(decode(a->>'cursor', 'base64'), 'UTF8'));
    if c is null or tp_api.ts(c->>'t') is null then perform tp_api.fail(400, 'invalid_cursor', 'The cursor is not valid'); end if;
  end if;
  return jsonb_build_object('limit', lim, 't', c->'t', 'id', c->'id');
exception when invalid_parameter_value or invalid_text_representation or character_not_in_repertoire then
  perform tp_api.fail(400, 'invalid_cursor', 'The cursor is not valid'); return null;
end $$;

create function tp_api.cursor_of(p_t timestamptz, p_id uuid) returns text
language sql immutable set search_path = '' as
$$ select replace(encode(convert_to(jsonb_build_object('t', p_t, 'id', p_id)::text, 'UTF8'), 'base64'), E'\n', '') $$;

-- p_codes: the package codes already on the company's jobs (live orders only)
create function tp_api.create_order(p jsonb, o jsonb, p_batch uuid, p_codes text[]) returns jsonb
language plpgsql set search_path = '' as $$
declare
  md text := coalesce(p->>'mode', 'live');
  ext text := btrim(coalesce(o->>'external_id',''));
  rcp text := btrim(coalesce(o->>'recipient_name',''));
  addr text := btrim(coalesce(o->>'address',''));
  pk integer; trk text := upper(btrim(coalesce(o->>'tracking_number','')));
  ex tp_api.orders; v_job jsonb; v_ord tp_api.orders; det jsonb; summary text; cur jsonb;
begin
  if ext = '' or length(ext) > 64 or ext !~ '^[A-Za-z0-9._:-]+$' then
    return jsonb_build_object('status', 422, 'error', 'invalid_external_id', 'message', 'external_id: 1-64 letters, digits or . _ : -');
  end if;
  if rcp = '' or length(rcp) > 120 then return jsonb_build_object('status', 422, 'error', 'invalid_recipient', 'message', 'recipient_name: 1-120 characters'); end if;
  if length(addr) < 5 or length(addr) > 300 then return jsonb_build_object('status', 422, 'error', 'invalid_address', 'message', 'address: 5-300 characters'); end if;
  if coalesce(o->>'packages','1') !~ '^[0-9]{1,3}$' or coalesce((o->>'packages')::int, 1) not between 1 and 99 then
    return jsonb_build_object('status', 422, 'error', 'invalid_packages', 'message', 'packages: a whole number 1-99');
  end if;
  pk := coalesce((o->>'packages')::int, 1);
  if trk <> '' and (length(trk) < 6 or length(trk) > 40 or trk !~ '^[A-Z0-9-]+$') then
    return jsonb_build_object('status', 422, 'error', 'invalid_tracking_number', 'message', 'tracking_number: 6-40 letters, digits or -');
  end if;

  select * into ex from tp_api.orders where org_key = p->>'org_key' and mode = md and external_id = ext;
  if ex.id is not null then
    return jsonb_build_object('status', 409, 'error', 'duplicate_order',
      'message', 'An order with this external_id already exists', 'order_id', tp_api.ext_id('ord', ex.id));
  end if;
  if trk = '' then trk := 'TPA' || upper(tp_sec.random_hex(6)); end if;
  if exists (select 1 from tp_api.orders where org_key = p->>'org_key' and mode = md and upper(tracking_number) = trk)
     or (md = 'live' and trk = any(coalesce(p_codes, '{}'))) then
    return jsonb_build_object('status', 409, 'error', 'duplicate_tracking_number', 'message', 'This tracking_number is already in use');
  end if;

  det := jsonb_strip_nulls(jsonb_build_object(
    'phone', left(o->>'recipient_phone', 30), 'unit', left(o->>'unit', 40),
    'access_notes', left(o->>'access_notes', 500), 'gate_code', left(o->>'gate_code', 40),
    'delivery_notes', left(o->>'delivery_notes', 1000),
    'signature_required', case when o ? 'signature_required' then to_jsonb(coalesce((o->>'signature_required')::boolean, false)) end,
    'pickup_address', left(o->>'pickup_address', 300),
    'metadata', case when jsonb_typeof(o->'metadata') = 'object' and length((o->'metadata')::text) <= 2000 then o->'metadata' end));
  summary := left(concat_ws(' · ', rcp, pk || case when pk = 1 then ' package' else ' packages' end,
                            'Tracking ' || trk, det->>'unit', det->>'delivery_notes'), 1000);

  -- live: the existing intake path, a pending job on the company's board. test: no job at all.
  if md = 'live' then
    v_job := tp_sec.insert_json('public.jobs', jsonb_strip_nulls(jsonb_build_object(
      'title', left('API order ' || ext || ' · ' || rcp, 200),
      'pickup_address', det->>'pickup_address', 'dropoff_address', addr,
      'status', 'pending', 'org_id', p->>'org_key', 'source', 'api',
      'total_packages', pk, 'total_stops', 1, 'route_summary', summary, 'customer_confirmed', true)),
      array['title','pickup_address','dropoff_address','status','org_id','source','total_packages','total_stops',
            'route_summary','customer_confirmed']);
    insert into tp_api.watch (org_key) values (p->>'org_key') on conflict do nothing;
  end if;

  insert into tp_api.orders (org_key, mode, key_id, client_label, external_id, tracking_number, job_id, batch_id,
                             recipient, address, packages, details)
  values (p->>'org_key', md, (p->>'key_id')::uuid, p->>'client_label', ext, trk, (v_job->>'id')::uuid, p_batch,
          rcp, addr, pk, det)
  returning * into v_ord;
  cur := tp_api.order_json(v_ord);
  update tp_api.orders set status = cur->>'status', snapshot = cur where id = v_ord.id;
  return jsonb_build_object('status', 201, 'order', cur);
end $$;

create function tp_api.check_webhook_url(p_url text) returns text
language plpgsql immutable set search_path = '' as $$
declare host text;
begin
  if p_url is null or length(p_url) > 500 or p_url !~ '^https://[^/?#\s]+(/[^\s]*)?$' then
    perform tp_api.fail(422, 'invalid_url', 'url must be an https:// address');
  end if;
  host := lower(split_part(split_part(substr(p_url, 9), '/', 1), '?', 1));
  if host ~ '@' then perform tp_api.fail(422, 'invalid_url', 'url must not contain credentials'); end if;
  if host ~ ':' and host !~ ':443$' then perform tp_api.fail(422, 'invalid_url', 'url must use port 443'); end if;
  host := regexp_replace(host, ':443$', '');
  if host ~ '^[0-9.]+$' or host ~ '^\[' or host in ('localhost') or host ~ '\.(local|localhost|internal|lan|home|corp|intranet)$'
     or host !~ '\.[a-z]{2,}$' then
    perform tp_api.fail(422, 'invalid_url', 'url must use a public host name (no IP addresses or internal names)');
  end if;
  return host;
end $$;

create function tp_api.webhook_json(w tp_api.webhook_endpoints) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', tp_api.ext_id('whk', w.id), 'object', 'webhook_endpoint', 'url', w.url,
    'description', w.description, 'events', to_jsonb(w.events), 'active', w.active,
    'created_at', w.created_at, 'updated_at', w.updated_at)
$$;

create function tp_api.find_webhook(p jsonb, p_id text) returns tp_api.webhook_endpoints
language plpgsql stable set search_path = '' as $$
declare w tp_api.webhook_endpoints;
begin
  select * into w from tp_api.webhook_endpoints where id = tp_api.parse_id('whk', p_id);
  if w.id is null or w.org_key <> p->>'org_key'
     or (coalesce((p->>'own_orders_only')::boolean, false) and w.client_label is distinct from p->>'client_label') then
    perform tp_api.fail(404, 'not_found', 'No such webhook endpoint');
  end if;
  return w;
end $$;

create function tp_api.check_events(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare ev text[];
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    perform tp_api.fail(422, 'invalid_events', 'events: a non-empty list of event types');
  end if;
  select array_agg(distinct e) into ev from jsonb_array_elements_text(p) e;
  if not ev <@ tp_api.all_events() then
    perform tp_api.fail(422, 'invalid_events', 'Unknown event type. Use: ' || array_to_string(tp_api.all_events(), ', '));
  end if;
  return ev;
end $$;

-- one operation for a caller; returns {status, body}
create function tp_api.run(p jsonb, op text, a jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  b jsonb := coalesce(a->'body', '{}');
  q jsonb := coalesce(a->'query', '{}');
  md text := coalesce(p->>'mode', 'live');
  own boolean := coalesce((p->>'own_orders_only')::boolean, false);
  pg jsonb; res jsonb; o tp_api.orders; w tp_api.webhook_endpoints; j public.jobs; u uuid;
  rows jsonb; r jsonb; n_acc integer := 0; n_dup integer := 0; n_rej integer := 0; bid uuid := gen_random_uuid();
  sec text; ev text[]; i integer := 0; codes text[];
begin
  case op
  when 'orders.create' then
    codes := case when md = 'live' then tp_api.company_codes(p->>'org_key') end;
    res := tp_api.create_order(p, b, null, codes);
    if (res->>'status')::int <> 201 then
      return jsonb_build_object('status', (res->>'status')::int, 'body', jsonb_build_object('error',
        jsonb_build_object('code', res->>'error', 'message', res->>'message') || jsonb_strip_nulls(jsonb_build_object('order_id', res->'order_id'))));
    end if;
    return jsonb_build_object('status', 201, 'body', res->'order');

  when 'orders.batch' then
    if jsonb_typeof(b->'orders') <> 'array' or jsonb_array_length(b->'orders') = 0 or jsonb_array_length(b->'orders') > 500 then
      perform tp_api.fail(422, 'invalid_batch', 'orders: a list of 1-500 orders');
    end if;
    codes := case when md = 'live' then tp_api.company_codes(p->>'org_key') end;
    rows := '[]';
    for r in select x from jsonb_array_elements(b->'orders') x loop
      i := i + 1;
      begin
        res := tp_api.create_order(p, r, bid, codes);
      exception when others then
        res := jsonb_build_object('status', 422, 'error', 'invalid_order', 'message', 'This order could not be read');
      end;
      if (res->>'status')::int = 201 then n_acc := n_acc + 1;
        rows := rows || jsonb_build_array(jsonb_build_object('index', i - 1, 'result', 'created', 'order_id', res->'order'->'id',
                 'external_id', res->'order'->'external_id', 'tracking_number', res->'order'->'tracking_number'));
      elsif res->>'error' = 'duplicate_order' then n_dup := n_dup + 1;
        rows := rows || jsonb_build_array(jsonb_build_object('index', i - 1, 'result', 'duplicate', 'order_id', res->'order_id',
                 'external_id', r->'external_id'));
      else n_rej := n_rej + 1;
        rows := rows || jsonb_build_array(jsonb_build_object('index', i - 1, 'result', 'rejected', 'external_id', r->'external_id',
                 'error', jsonb_build_object('code', res->>'error', 'message', res->>'message')));
      end if;
    end loop;
    insert into tp_api.batches (id, org_key, key_id, received, accepted, duplicates, rejected, results)
    values (bid, p->>'org_key', (p->>'key_id')::uuid, i, n_acc, n_dup, n_rej, rows);
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('id', tp_api.ext_id('bat', bid), 'object', 'batch',
      'received', i, 'created', n_acc, 'duplicates', n_dup, 'rejected', n_rej, 'results', rows));

  when 'batches.get' then
    select jsonb_build_object('id', tp_api.ext_id('bat', x.id), 'object', 'batch', 'received', x.received, 'created', x.accepted,
             'duplicates', x.duplicates, 'rejected', x.rejected, 'results', x.results, 'created_at', x.created_at) into res
      from tp_api.batches x where x.id = tp_api.parse_id('bat', a->>'id') and x.org_key = p->>'org_key'
       and (not own or x.key_id::text = p->>'key_id'
            or exists (select 1 from tp_api.keys k where k.id = x.key_id and coalesce(k.client_label, k.id::text) = p->>'client_label'));
    if res is null then perform tp_api.fail(404, 'not_found', 'No such batch'); end if;
    return jsonb_build_object('status', 200, 'body', res);

  when 'orders.list' then
    -- stored values only: no order is recomputed here
    pg := tp_api.page(q);
    if q ? 'status' and not (q->>'status' = any(array['received','sorted','staged','assigned','out_for_delivery','delivered',
                                                   'delivery_attempted','exception','cancelled'])) then
      perform tp_api.fail(400, 'invalid_filter', 'Unknown status filter');
    end if;
    select coalesce(jsonb_agg(x.js order by x.c desc, x.id desc), '[]') into rows from (
      select coalesce(oo.snapshot, jsonb_build_object('id', tp_api.ext_id('ord', oo.id), 'object', 'order', 'status', oo.status,
                                                      'created_at', oo.created_at)) as js, oo.created_at as c, oo.id
        from tp_api.orders oo
       where oo.org_key = p->>'org_key' and oo.mode = md
         and (not own or coalesce(oo.client_label, '') = p->>'client_label')
         and (q->>'status' is null or oo.status = q->>'status')
         and (q->>'external_id' is null or oo.external_id = q->>'external_id')
         and (q->>'tracking_number' is null or upper(oo.tracking_number) = upper(q->>'tracking_number'))
         and (q->>'created_after' is null or oo.created_at >= tp_api.ts(q->>'created_after'))
         and (q->>'created_before' is null or oo.created_at < tp_api.ts(q->>'created_before'))
         and (pg->>'t' is null or (oo.created_at, oo.id) < ((pg->>'t')::timestamptz, (pg->>'id')::uuid))
       order by oo.created_at desc, oo.id desc
       limit (pg->>'limit')::int + 1) x;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list',
      'data', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(rows) e limit (pg->>'limit')::int) z), '[]'),
      'has_more', jsonb_array_length(rows) > (pg->>'limit')::int,
      'next_cursor', case when jsonb_array_length(rows) > (pg->>'limit')::int then
          tp_api.cursor_of((rows->((pg->>'limit')::int - 1)->>'created_at')::timestamptz,
                           tp_api.parse_id('ord', rows->((pg->>'limit')::int - 1)->>'id')) end));

  when 'orders.get' then
    o := tp_api.find_order(p, a->>'id');
    return jsonb_build_object('status', 200, 'body', tp_api.order_json(o));

  when 'orders.events' then
    o := tp_api.find_order(p, a->>'id');
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list', 'order_id', tp_api.ext_id('ord', o.id),
      'status', tp_api.order_state(o)->>'status', 'data', tp_api.order_events(o)));

  when 'tracking.get' then
    select * into o from tp_api.orders where org_key = p->>'org_key' and mode = md and upper(tracking_number) = upper(coalesce(a->>'id',''));
    if o.id is null or not tp_api.can_see(p, o) then perform tp_api.fail(404, 'not_found', 'No such tracking number'); end if;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'tracking', 'order', tp_api.order_json(o),
      'events', tp_api.order_events(o)));

  when 'orders.pod' then
    o := tp_api.find_order(p, a->>'id');
    return jsonb_build_object('status', 200, 'body', tp_api.order_pod(o));

  when 'routes.list' then
    pg := tp_api.page(q);
    if q ? 'status' and not (q->>'status' = any(array['awaiting_confirmation','unassigned','assigned','in_progress','completed',
                                                   'completed_with_exceptions','cancelled'])) then
      perform tp_api.fail(400, 'invalid_filter', 'Unknown status filter');
    end if;
    select coalesce(jsonb_agg(x.js order by x.c desc, x.id desc), '[]') into rows from (
      select tp_api.route_json(jj, false) as js, jj.created_at as c, jj.id from public.jobs jj
       where jj.org_id::text = p->>'org_key' and not coalesce(jj.archived, false)
         and (q->>'status' is null or tp_api.route_status(jj.status) = q->>'status')
         and (q->>'created_after' is null or jj.created_at >= tp_api.ts(q->>'created_after'))
         and (pg->>'t' is null or (jj.created_at, jj.id) < ((pg->>'t')::timestamptz, (pg->>'id')::uuid))
       order by jj.created_at desc, jj.id desc limit (pg->>'limit')::int + 1) x;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list',
      'data', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(rows) e limit (pg->>'limit')::int) z), '[]'),
      'has_more', jsonb_array_length(rows) > (pg->>'limit')::int,
      'next_cursor', case when jsonb_array_length(rows) > (pg->>'limit')::int then
          tp_api.cursor_of((rows->((pg->>'limit')::int - 1)->>'created_at')::timestamptz,
                           tp_api.parse_id('rte', rows->((pg->>'limit')::int - 1)->>'id')) end));

  when 'routes.get' then
    u := tp_api.parse_id('rte', a->>'id');
    select * into j from public.jobs where id = u and org_id::text = p->>'org_key';
    if j.id is null then perform tp_api.fail(404, 'not_found', 'No such route'); end if;
    return jsonb_build_object('status', 200, 'body', tp_api.route_json(j, true));

  when 'webhooks.create' then
    perform tp_api.check_webhook_url(b->>'url');
    ev := tp_api.check_events(coalesce(b->'events', to_jsonb(tp_api.all_events())));
    if (select count(*) from tp_api.webhook_endpoints where org_key = p->>'org_key' and active) >= 10 then
      perform tp_api.fail(422, 'too_many_endpoints', 'At most 10 active webhook endpoints per company');
    end if;
    sec := 'whsec_' || tp_sec.random_hex(32);
    insert into tp_api.webhook_endpoints (org_key, client_label, url, description, events, secret)
    values (p->>'org_key', case when own then p->>'client_label' end,
            b->>'url', left(b->>'description', 200), ev, sec) returning * into w;
    perform tp_api.rewatch(p->>'org_key');
    return jsonb_build_object('status', 201, 'body', tp_api.webhook_json(w) || jsonb_build_object('secret', sec));

  when 'webhooks.list' then
    select coalesce(jsonb_agg(tp_api.webhook_json(x) order by x.created_at desc), '[]') into rows
      from tp_api.webhook_endpoints x where x.org_key = p->>'org_key'
       and (not own or x.client_label = p->>'client_label');
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list', 'data', rows, 'has_more', false));

  when 'webhooks.get' then
    w := tp_api.find_webhook(p, a->>'id');
    return jsonb_build_object('status', 200, 'body', tp_api.webhook_json(w));

  when 'webhooks.update' then
    w := tp_api.find_webhook(p, a->>'id');
    if b ? 'url' then perform tp_api.check_webhook_url(b->>'url'); end if;
    if b ? 'events' then ev := tp_api.check_events(b->'events'); end if;
    update tp_api.webhook_endpoints set url = coalesce(b->>'url', url), events = coalesce(ev, events),
           description = case when b ? 'description' then left(b->>'description', 200) else description end,
           active = case when b ? 'active' then coalesce((b->>'active')::boolean, active) else active end,
           disabled_at = case when b ? 'active' and not coalesce((b->>'active')::boolean, true) then now()
                              when b ? 'active' then null else disabled_at end,
           updated_at = now()
     where id = w.id returning * into w;
    perform tp_api.rewatch(p->>'org_key');
    return jsonb_build_object('status', 200, 'body', tp_api.webhook_json(w));

  when 'webhooks.delete' then
    w := tp_api.find_webhook(p, a->>'id');
    update tp_api.webhook_endpoints set active = false, disabled_at = now(), updated_at = now() where id = w.id;
    update tp_api.deliveries set status = 'failed', last_error = 'endpoint deleted' where endpoint_id = w.id and status = 'pending';
    perform tp_api.rewatch(p->>'org_key');
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('id', tp_api.ext_id('whk', w.id), 'deleted', true));

  when 'webhooks.rotate' then
    w := tp_api.find_webhook(p, a->>'id');
    sec := 'whsec_' || tp_sec.random_hex(32);
    update tp_api.webhook_endpoints set secret = sec, updated_at = now() where id = w.id returning * into w;
    return jsonb_build_object('status', 200, 'body', tp_api.webhook_json(w) || jsonb_build_object('secret', sec));

  when 'webhooks.test' then
    w := tp_api.find_webhook(p, a->>'id');
    insert into tp_api.events (org_key, client_label, type, data) values (w.org_key, w.client_label, 'webhook.test',
      jsonb_build_object('message', 'Test event from TackPath')) returning id into u;
    insert into tp_api.deliveries (event_id, endpoint_id) values (u, w.id);
    return jsonb_build_object('status', 202, 'body', jsonb_build_object('event_id', tp_api.ext_id('evt', u), 'queued', true));

  when 'webhooks.deliveries' then
    w := tp_api.find_webhook(p, a->>'id');
    select coalesce(jsonb_agg(jsonb_build_object('id', tp_api.ext_id('dlv', d.id), 'event_id', tp_api.ext_id('evt', d.event_id),
             'event_type', e.type, 'status', d.status, 'attempts', d.attempts, 'last_status_code', d.last_status_code,
             'last_error', d.last_error, 'next_attempt_at', case when d.status = 'pending' then d.next_attempt_at end,
             'delivered_at', d.delivered_at, 'created_at', d.created_at) order by d.created_at desc), '[]') into rows
      from (select * from tp_api.deliveries where endpoint_id = w.id order by created_at desc limit 100) d
      join tp_api.events e on e.id = d.event_id;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list', 'data', rows, 'has_more', false));

  when 'events.list' then
    pg := tp_api.page(q);
    select coalesce(jsonb_agg(jsonb_build_object('id', tp_api.ext_id('evt', e.id), 'type', e.type, 'created_at', e.created_at, 'data', e.data)
             order by e.created_at desc), '[]') into rows
      from (select * from tp_api.events ee where ee.org_key = p->>'org_key'
              and (not own or ee.client_label = p->>'client_label')
              and (pg->>'t' is null or (ee.created_at, ee.id) < ((pg->>'t')::timestamptz, (pg->>'id')::uuid))
            order by ee.created_at desc, ee.id desc limit (pg->>'limit')::int) e;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list', 'data', rows,
      'has_more', jsonb_array_length(rows) = (pg->>'limit')::int,
      'next_cursor', case when jsonb_array_length(rows) = (pg->>'limit')::int then
         tp_api.cursor_of((rows->-1->>'created_at')::timestamptz, tp_api.parse_id('evt', rows->-1->>'id')) end));
  else
    perform tp_api.fail(404, 'unknown_endpoint', 'No such endpoint');
  end case;
  return null;
end $$;

-- key management (company session only)
create function tp_api.key_json(k tp_api.keys) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', tp_api.ext_id('key', k.id), 'object', 'api_key', 'name', k.name,
    'prefix', 'tpk_' || k.mode || '_' || k.prefix, 'mode', k.mode, 'scopes', to_jsonb(k.scopes),
    'own_orders_only', k.own_orders_only, 'client_label', k.client_label, 'rate_per_minute', k.rate_per_minute,
    'created_at', k.created_at, 'expires_at', k.expires_at, 'revoked_at', k.revoked_at, 'last_used_at', k.last_used_at,
    'status', case when k.revoked_at is not null then 'revoked' when k.expires_at is not null and k.expires_at <= now() then 'expired' else 'active' end)
$$;

create function tp_api.new_key(p_org text, b jsonb, p_from uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare sc text[]; md text := coalesce(b->>'mode', 'live'); pre text := tp_sec.random_hex(6); raw text; k tp_api.keys;
  own boolean := coalesce((b->>'own_orders_only')::boolean, false); days integer;
begin
  if coalesce(btrim(b->>'name'), '') = '' or length(b->>'name') > 80 then perform tp_api.fail(422, 'invalid_name', 'name: 1-80 characters'); end if;
  if md not in ('live','test') then perform tp_api.fail(422, 'invalid_mode', 'mode: live or test'); end if;
  select array_agg(distinct s) into sc from jsonb_array_elements_text(coalesce(b->'scopes', to_jsonb(tp_api.all_scopes()))) s;
  if sc is null or not sc <@ tp_api.all_scopes() then
    perform tp_api.fail(422, 'invalid_scopes', 'Unknown scope. Use: ' || array_to_string(tp_api.all_scopes(), ', '));
  end if;
  if own and 'routes:read' = any(sc) then
    perform tp_api.fail(422, 'invalid_scopes', 'A key limited to its own orders cannot read routes');
  end if;
  if b ? 'expires_in_days' then
    if coalesce(b->>'expires_in_days','') !~ '^[0-9]{1,4}$' or (b->>'expires_in_days')::int not between 1 and 3650 then
      perform tp_api.fail(422, 'invalid_expiry', 'expires_in_days: 1-3650');
    end if;
    days := (b->>'expires_in_days')::int;
  end if;
  if (select count(*) from tp_api.keys where org_key = p_org and revoked_at is null) >= 25 then
    perform tp_api.fail(422, 'too_many_keys', 'At most 25 active API keys per company');
  end if;
  raw := 'tpk_' || md || '_' || pre || '_' || tp_sec.random_hex(32);
  insert into tp_api.keys (org_key, name, prefix, secret_hash, mode, scopes, own_orders_only, client_label,
                           rate_per_minute, created_by, expires_at, rotated_from)
  values (p_org, btrim(b->>'name'), pre, tp_sec.sha256_hex(raw), md, sc, own, nullif(left(btrim(b->>'client_label'), 80), ''),
          least(greatest(coalesce(nullif(b->>'rate_per_minute','')::int, 120), 1), 600), 'dispatcher',
          case when days is not null then now() + make_interval(days => days) end, p_from)
  returning * into k;
  return tp_api.key_json(k) || jsonb_build_object('key', raw);
end $$;

create function tp_api.run_admin(p jsonb, op text, a jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare b jsonb := coalesce(a->'body', '{}'); k tp_api.keys; res jsonb; grace integer;
begin
  case op
  when 'keys.list' then
    select coalesce(jsonb_agg(tp_api.key_json(x) order by x.created_at desc), '[]') into res from tp_api.keys x where x.org_key = p->>'org_key';
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('object', 'list', 'data', res, 'has_more', false));
  when 'keys.create' then
    return jsonb_build_object('status', 201, 'body', tp_api.new_key(p->>'org_key', b, null));
  when 'keys.revoke' then
    update tp_api.keys set revoked_at = coalesce(revoked_at, now())
     where id = tp_api.parse_id('key', a->>'id') and org_key = p->>'org_key' returning * into k;
    if k.id is null then perform tp_api.fail(404, 'not_found', 'No such API key'); end if;
    return jsonb_build_object('status', 200, 'body', tp_api.key_json(k));
  when 'keys.rotate' then
    select * into k from tp_api.keys where id = tp_api.parse_id('key', a->>'id') and org_key = p->>'org_key';
    if k.id is null then perform tp_api.fail(404, 'not_found', 'No such API key'); end if;
    if k.revoked_at is not null then perform tp_api.fail(409, 'api_key_revoked', 'A revoked key cannot be rotated'); end if;
    grace := least(greatest(coalesce(nullif(b->>'grace_hours','')::int, 24), 0), 168);
    res := tp_api.new_key(k.org_key, jsonb_build_object('name', k.name, 'mode', k.mode, 'scopes', to_jsonb(k.scopes),
             'own_orders_only', k.own_orders_only, 'client_label', k.client_label, 'rate_per_minute', k.rate_per_minute), k.id);
    if grace = 0 then update tp_api.keys set revoked_at = now() where id = k.id;
    else update tp_api.keys set expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => grace)) where id = k.id; end if;
    return jsonb_build_object('status', 201, 'body', res || jsonb_build_object('previous_key_expires_at',
      (select coalesce(revoked_at, expires_at) from tp_api.keys where id = k.id)));
  else
    return tp_api.run(p, op, a);   -- webhooks etc., for the developer page
  end case;
end $$;

-- ── 6. THE GATEWAY (service role only) ──────────────────────────────────
create function tp_api.enabled() returns boolean
language sql stable set search_path = '' as
$$ select coalesce((select enabled from tp_api.settings), true) $$;

-- One API request. Order: kill switch; failed-sign-in limits (address, key
-- prefix); who is calling; the per-key rate limit, counted for every request
-- before anything can fail; then the operation in its own error block. The
-- counts are written outside that block, so a failing request cannot undo them.
create function tp_api.handle(a jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p jsonb; op text := a->>'op'; out jsonb; scope text; remaining integer; hdr jsonb := '{}';
  writes constant text[] := array['orders.create','orders.batch','webhooks.create','webhooks.rotate','keys.create','keys.rotate'];
  reads constant text[] := array['orders.get','orders.list','orders.events','orders.pod','tracking.get','routes.list','routes.get','events.list'];
  idem text := nullif(btrim(coalesce(a->>'idempotency_key','')), ''); hsh text; prev tp_api.idempotency;
  ip text := nullif(left(btrim(coalesce(a->>'ip', '')), 64), '');
  pre text := case when coalesce(a->>'key', '') ~ '^tpk_(live|test)_[0-9a-f]{12}_' then split_part(a->>'key', '_', 3) end;
begin
  if not tp_api.enabled() then
    out := tp_api.err(503, 'api_disabled', 'The TackPath API is switched off for maintenance. Please retry later');
  elsif ip is not null and tp_sec.rate_count('api_authfail_ip', ip, interval '1 minute') >= 30 then
    out := tp_api.err(429, 'rate_limited', 'Too many failed sign-ins from this address. Retry after the time in Retry-After');
  else
    begin
      p := tp_api.principal(a);
    exception when others then
      out := tp_api.err_out(sqlerrm, sqlstate);
    end;
    if (out->>'status')::int = 401 then
      if pre is not null and out->'body'->'error'->>'code' = 'invalid_api_key'
         and tp_sec.rate_count('api_authfail_key', pre, interval '1 minute') >= 10 then
        out := tp_api.err(429, 'rate_limited', 'Too many failed attempts for this key. Retry after the time in Retry-After');
      end if;
      if ip is not null then insert into tp_sec.rate_events (bucket, key) values ('api_authfail_ip', ip); end if;
      if pre is not null then insert into tp_sec.rate_events (bucket, key) values ('api_authfail_key', pre); end if;
    end if;
  end if;

  if out is null and p->>'kind' = 'key' then
    if not tp_sec.rate_ok('api_req', p->>'key_id', (p->>'rate')::int, interval '1 minute') then
      out := tp_api.err(429, 'rate_limited', 'Too many requests. Retry after the time in Retry-After');
    elsif op = 'orders.batch' and not tp_sec.rate_ok('api_batch', p->>'org_key', 120, interval '1 hour') then
      out := tp_api.err(429, 'rate_limited', 'Too many batches this hour');
    end if;
    remaining := greatest((p->>'rate')::int - tp_sec.rate_count('api_req', p->>'key_id', interval '1 minute'), 0);
    hdr := jsonb_build_object('X-RateLimit-Limit', (p->>'rate'), 'X-RateLimit-Remaining', remaining::text);
  elsif out is null and p->>'kind' = 'session' and not tp_sec.rate_ok('api_admin', p->>'org_key', 600, interval '1 minute') then
    out := tp_api.err(429, 'rate_limited', 'Too many requests');
  end if;

  if out is null then
    begin
      if p->>'kind' = 'key' then
        if op like 'keys.%' then perform tp_api.fail(403, 'forbidden', 'API keys are managed on the TackPath developer page'); end if;
        scope := tp_api.op_scope(op);
        if scope is null then perform tp_api.fail(404, 'unknown_endpoint', 'No such endpoint'); end if;
        if not (scope = any(array(select jsonb_array_elements_text(p->'scopes')))) then
          perform tp_api.fail(403, 'insufficient_scope', 'This API key does not have the ' || scope || ' scope');
        end if;
      end if;

      if p->>'kind' = 'session' then idem := null; end if;   -- idempotency is per API key
      if op = any(writes) and idem is not null then
        if length(idem) > 200 then perform tp_api.fail(400, 'invalid_idempotency_key', 'Idempotency-Key: at most 200 characters'); end if;
        hsh := tp_sec.sha256_hex(op || '|' || coalesce(a->>'id','') || '|' || coalesce((a->'body')::text, ''));
        select * into prev from tp_api.idempotency
         where key_id = (p->>'key_id')::uuid and idem_key = idem and created_at > now() - interval '24 hours';
        if prev.key_id is not null then
          if prev.request_hash <> hsh or prev.op <> op then
            perform tp_api.fail(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different request');
          end if;
          out := jsonb_build_object('status', prev.status, 'body', prev.response, 'headers', jsonb_build_object('Idempotent-Replayed', 'true'));
        end if;
      end if;

      if out is null then
        -- reads see the company's latest changes: work through its queue first (bounded, never blocking)
        if op = any(reads) then
          begin perform tp_api.process(p->>'org_key', 200);
          exception when others then raise warning 'tp_api.process: %', sqlerrm; end;
        end if;
        out := case when p->>'kind' = 'session' then tp_api.run_admin(p, op, a) else tp_api.run(p, op, a) end;
        if op = any(writes) and idem is not null and (out->>'status')::int < 500 then
          delete from tp_api.idempotency where key_id = (p->>'key_id')::uuid and idem_key = idem;
          insert into tp_api.idempotency (key_id, idem_key, op, request_hash, status, response)
          values ((p->>'key_id')::uuid, idem, op, hsh, (out->>'status')::int, (out->'body') - 'secret' - 'key');   -- never a secret
          if random() < 0.01 then delete from tp_api.idempotency where created_at < now() - interval '2 days'; end if;
        end if;
      end if;
    exception when others then
      out := tp_api.err_out(sqlerrm, sqlstate);
    end;
  end if;

  out := out || jsonb_build_object('headers', hdr || coalesce(out->'headers', '{}')
    || case when (out->>'status')::int = 429 then jsonb_build_object('Retry-After', '60')
            when (out->>'status')::int = 503 then jsonb_build_object('Retry-After', '300') else '{}' end);
  insert into tp_api.audit (org_key, key_id, key_prefix, actor, request_id, method, path, op, status, error_code)
  values (p->>'org_key', (p->>'key_id')::uuid, coalesce(p->>'prefix', pre),
          p->>'kind', left(a->>'request_id', 64), left(a->>'method', 10), left(a->>'path', 300), left(op, 40),
          (out->>'status')::int, out->'body'->'error'->>'code');
  return out;
end $$;

-- webhook worker: take due deliveries (locked for 2 minutes)
create function tp_api.claim(p_limit integer) returns jsonb
language plpgsql set search_path = '' as $$
declare res jsonb;
begin
  if not tp_api.enabled() then return '[]'; end if;
  with due as (
    select d.id from tp_api.deliveries d join tp_api.webhook_endpoints w on w.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and (d.locked_until is null or d.locked_until < now()) and w.active
     order by d.next_attempt_at limit least(greatest(coalesce(p_limit, 25), 1), 100)
     for update of d skip locked),
  upd as (update tp_api.deliveries d set locked_until = now() + interval '2 minutes', attempts = d.attempts + 1
           from due where d.id = due.id returning d.*)
  select coalesce(jsonb_agg(jsonb_build_object('delivery_id', tp_api.ext_id('dlv', u.id), 'attempt', u.attempts,
           'url', w.url, 'secret', w.secret,
           'event', jsonb_build_object('id', tp_api.ext_id('evt', e.id), 'object', 'event', 'type', e.type,
                                       'api_version', 'v1', 'created_at', e.created_at, 'data', e.data))), '[]') into res
    from upd u join tp_api.webhook_endpoints w on w.id = u.endpoint_id join tp_api.events e on e.id = u.event_id;
  return res;
end $$;

-- 8 attempts over ~1.6 days: now, 1m, 5m, 30m, 2h, 6h, 12h, 24h
create function tp_api.report(a jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare d tp_api.deliveries; ok boolean := coalesce((a->>'ok')::boolean, false);
  waits constant interval[] := array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours',
                                     interval '6 hours', interval '12 hours', interval '24 hours'];
begin
  select * into d from tp_api.deliveries where id = tp_api.parse_id('dlv', a->>'delivery_id');
  if d.id is null then return jsonb_build_object('ok', false); end if;
  insert into tp_api.delivery_attempts (delivery_id, attempt, status_code, error, duration_ms)
  values (d.id, d.attempts, nullif(a->>'status_code','')::int, left(a->>'error', 300), nullif(a->>'duration_ms','')::int);
  if ok then
    update tp_api.deliveries set status = 'delivered', delivered_at = now(), locked_until = null,
           last_status_code = nullif(a->>'status_code','')::int, last_error = null where id = d.id;
  elsif d.attempts >= 8 then
    update tp_api.deliveries set status = 'failed', locked_until = null,
           last_status_code = nullif(a->>'status_code','')::int, last_error = left(a->>'error', 300) where id = d.id;
  else
    update tp_api.deliveries set next_attempt_at = now() + waits[d.attempts], locked_until = null,
           last_status_code = nullif(a->>'status_code','')::int, last_error = left(a->>'error', 300) where id = d.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.tp_svc_api(p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  case p_action
  when 'request' then return tp_api.handle(coalesce(p_args, '{}'));
  when 'process' then
    if not tp_api.enabled() then return jsonb_build_object('disabled', true); end if;
    return jsonb_build_object('processed', tp_api.process(null, coalesce(nullif(p_args->>'limit','')::int, 500)));
  when 'claim'   then return tp_api.claim(nullif(p_args->>'limit','')::int);
  when 'report'  then return tp_api.report(coalesce(p_args, '{}'));
  else raise exception 'TP_INVALID: unknown action %', p_action;
  end case;
end $$;

-- ── 7. WHO MAY CALL WHAT ────────────────────────────────────────────────
revoke all on all functions in schema tp_api from public, anon, authenticated;
revoke all on all tables in schema tp_api from public, anon, authenticated;
revoke all on all sequences in schema tp_api from public, anon, authenticated;
revoke all on function public.tp_svc_api(text, jsonb) from public, anon, authenticated;
grant execute on function public.tp_svc_api(text, jsonb) to service_role;

commit;
