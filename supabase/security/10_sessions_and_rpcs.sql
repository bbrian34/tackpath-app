-- ═══════════════════════════════════════════════════════════════════════
-- TackPath security hardening — migration 10: sessions, sign-in and RPCs
-- (ADDITIVE: nothing existing is changed, removed or locked here)
--
-- What it adds
--   * schema tp_sec (NOT exposed by the REST API): sessions, hashed company
--     codes, hashed one-time SMS sign-in codes, rate limits, the reviewer
--     demo account, order tokens and an SMS log.
--   * security-definer RPCs in public that every live page uses instead of
--     reading and writing tables directly:
--       tp_org_lookup, tp_org_sign_in, tp_sign_out, tp_org (dispatcher,
--       fleet, PathIQ stow, portal), tp_driver_sign_in, tp_driver,
--       tp_customer, tp_track, tp_driver_signup
--     and service-role-only RPCs for the edge functions:
--       tp_svc_driver_code (driver-login), tp_svc_assignment_sms (send-sms),
--       tp_svc_pod (pod), tp_svc_session (every other edge function)
--
-- Migration 20 (lockdown) is what removes the anon key's direct access.
-- Apply this file first, deploy the edge functions and pages, check every
-- flow, then apply 20. Rollback: 10_sessions_and_rpcs.rollback.sql.
--
-- Type-agnostic by design: ids are compared as text and optional columns are
-- read through to_jsonb(row), because the production table definitions are
-- not in the repository. The preflight below aborts (changing nothing) if a
-- column these RPCs depend on is missing.
-- ═══════════════════════════════════════════════════════════════════════
begin;

-- ── 0. PREFLIGHT ─────────────────────────────────────────────────────────
do $pre$
declare
  missing text[] := '{}';
  r record;
begin
  for r in select * from (values
    ('jobs','id'),('jobs','status'),('jobs','driver_name'),('jobs','org_id'),('jobs','title'),
    ('jobs','created_at'),('jobs','surge_stops'),('jobs','stops_completed'),('jobs','bin_label'),
    ('jobs','staged_at'),('jobs','job_type'),('jobs','archived'),('jobs','estimated_delivery_at'),
    ('drivers','id'),('drivers','name'),('drivers','phone'),('drivers','sms_consent'),('drivers','status'),
    ('messages','job_id'),('messages','sender'),('messages','sender_role'),('messages','body'),('messages','created_at'),
    ('driver_locations','job_id'),('driver_locations','driver_name'),('driver_locations','lat'),
    ('driver_locations','lng'),('driver_locations','updated_at'),
    ('driver_fcm_tokens','phone'),('driver_fcm_tokens','token'),
    ('organizations','id'),('organizations','slug'),('organizations','name'),('organizations','access_code'),
    ('bin_bindings','job_id'),('bin_bindings','bin_code'),('bin_bindings','state'),('bin_bindings','org_id'),
    ('events','event_type'),('events','idempotency_key'),('events','occurred_at'),('events','payload'),
    ('agent_memory','agent_name'),('agent_memory','event_type'),('agent_memory','created_at')
  ) v(t,c) loop
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name=r.t and column_name=r.c) then
      missing := missing || (r.t||'.'||r.c);
    end if;
  end loop;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null
     or to_regprocedure('extensions.crypt(text,text)') is null then
    missing := missing || 'pgcrypto in schema extensions'::text;
  end if;
  if to_regprocedure('public.publish_surge_route(jsonb)') is null then
    missing := missing || 'function public.publish_surge_route(jsonb)'::text;
  end if;
  if cardinality(missing) > 0 then
    raise exception 'TackPath security migration 10 stopped, nothing was changed. Production differs from what this migration expects: %', missing;
  end if;
end
$pre$;

-- ── 1. PRIVATE SCHEMA AND TABLES ─────────────────────────────────────────
create schema tp_sec;
revoke all on schema tp_sec from public;

create table tp_sec.settings (key text primary key, value jsonb not null);
insert into tp_sec.settings values
  -- Legacy rows with org_id NULL stay visible to every signed-in company until
  -- org_id is backfilled (Stage B). Set to false once every row has an org.
  ('include_null_org_rows', 'true'),
  -- Drivers whose drivers.org_id is NULL (or no such column) see jobs of every
  -- company, as today. Set to false once every driver has an org.
  ('driver_without_org_sees_all', 'true'),
  -- The single App Store / Google Play reviewer account (fictional 555-01xx).
  ('demo_phone', '"4045550199"'),
  ('demo_org_slug', '"tackpath-review"');

create table tp_sec.sessions (
  token_hash   text primary key,
  kind         text not null check (kind in ('org','driver')),
  org_key      text,
  driver_key   text,
  driver_name  text,
  driver_phone text,
  is_demo      boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index on tp_sec.sessions (driver_key);

create table tp_sec.org_codes (
  org_key    text primary key,
  code_hash  text not null,          -- bcrypt (pgcrypto crypt/gen_salt('bf'))
  updated_at timestamptz not null default now()
);

create table tp_sec.login_challenges (
  id         bigserial primary key,
  phone      text not null,
  salt       text not null,
  code_hash  text not null,          -- sha256(salt || code)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  used_at    timestamptz
);
create index on tp_sec.login_challenges (phone, created_at desc);

create table tp_sec.rate_events (
  id     bigserial primary key,
  bucket text not null,
  key    text not null,
  at     timestamptz not null default now()
);
create index on tp_sec.rate_events (bucket, key, at);

create table tp_sec.demo_code (
  only_row  boolean primary key default true check (only_row),
  code_hash text not null            -- bcrypt; set with tp_sec.admin_set_demo_code
);

create table tp_sec.order_tokens (
  job_key    text primary key,
  token_hash text not null,
  created_at timestamptz not null default now()
);

create table tp_sec.sms_log (
  id         bigserial primary key,
  kind       text not null,
  job_key    text,
  driver_key text,
  org_key    text,
  phone      text,
  at         timestamptz not null default now()
);
create index on tp_sec.sms_log (kind, driver_key, at);
create index on tp_sec.sms_log (kind, job_key, at);

-- ── 2. HELPERS (private) ─────────────────────────────────────────────────
create function tp_sec.sha256_hex(p text) returns text
language sql immutable set search_path = '' as
$$ select encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p,''), 'UTF8')), 'hex') $$;

create function tp_sec.random_hex(p_bytes integer) returns text
language sql volatile set search_path = '' as
$$ select encode(extensions.gen_random_bytes(p_bytes), 'hex') $$;

-- 10-digit US number or NULL. "(404) 555-0199", "+14045550199" -> "4045550199"
create function tp_sec.norm_phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := pg_catalog.regexp_replace(coalesce(p,''), '\D', '', 'g');
begin
  if length(d) = 11 and left(d,1) = '1' then d := substr(d, 2); end if;
  if d !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then return null; end if;
  return d;
end $$;

create function tp_sec.setting(p_key text) returns jsonb
language sql stable set search_path = '' as
$$ select value from tp_sec.settings where key = p_key $$;

-- true and records the event when under the limit; false when over it
create function tp_sec.rate_ok(p_bucket text, p_key text, p_max integer, p_window interval)
returns boolean language plpgsql set search_path = '' as $$
begin
  if (select count(*) from tp_sec.rate_events
       where bucket = p_bucket and key = p_key and at > now() - p_window) >= p_max then
    return false;
  end if;
  insert into tp_sec.rate_events (bucket, key) values (p_bucket, p_key);
  if random() < 0.01 then delete from tp_sec.rate_events where at < now() - interval '2 days'; end if;
  return true;
end $$;

create function tp_sec.rate_count(p_bucket text, p_key text, p_window interval)
returns integer language sql stable set search_path = '' as
$$ select count(*)::int from tp_sec.rate_events where bucket = p_bucket and key = p_key and at > now() - p_window $$;

create function tp_sec.new_session(p_kind text, p_org_key text, p_driver_key text, p_driver_name text,
                                   p_driver_phone text, p_is_demo boolean, p_days integer)
returns text language plpgsql set search_path = '' as $$
declare tok text := tp_sec.random_hex(32);
begin
  insert into tp_sec.sessions (token_hash, kind, org_key, driver_key, driver_name, driver_phone, is_demo, expires_at)
  values (tp_sec.sha256_hex(tok), p_kind, p_org_key, p_driver_key, p_driver_name, p_driver_phone, p_is_demo,
          now() + make_interval(days => p_days));
  return tok;
end $$;

-- The session for a token, or an error starting with TP_AUTH (the pages send
-- the user back to sign-in on TP_AUTH).
create function tp_sec.session(p_token text, p_kind text) returns tp_sec.sessions
language plpgsql set search_path = '' as $$
declare s tp_sec.sessions;
begin
  select * into s from tp_sec.sessions where token_hash = tp_sec.sha256_hex(p_token);
  if not found or s.revoked_at is not null or s.expires_at < now() or s.kind <> p_kind then
    raise exception 'TP_AUTH: please sign in again' using errcode = '28000';
  end if;
  if s.last_seen_at < now() - interval '5 minutes' then
    update tp_sec.sessions set last_seen_at = now() where token_hash = s.token_hash;
  end if;
  return s;
end $$;

create function tp_sec.table_cols(p_table regclass) returns text[]
language sql stable set search_path = '' as
$$ select coalesce(array_agg(attname::text), '{}') from pg_catalog.pg_attribute
   where attrelid = p_table and attnum > 0 and not attisdropped $$;

-- INSERT one row from JSON, keeping only allowed keys that are real columns.
create function tp_sec.insert_json(p_table regclass, p_row jsonb, p_allowed text[]) returns jsonb
language plpgsql set search_path = '' as $$
declare cols text[]; list text; res jsonb;
begin
  select array_agg(k order by k) into cols from jsonb_object_keys(p_row) k
   where k = any(p_allowed) and k = any(tp_sec.table_cols(p_table));
  if cols is null then raise exception 'TP_INVALID: nothing to save'; end if;
  select string_agg(format('%I', c), ',') into list from unnest(cols) c;
  execute format('insert into %s as t (%s) select %s from jsonb_populate_record(null::%s, $1) returning to_jsonb(t.*)',
                 p_table, list, list, p_table)
    into res using p_row;
  return res;
end $$;

-- UPDATE rows WHERE id = p_id AND every p_expect key equals its value (NULL
-- matches NULL), setting only allowed keys of p_patch that are real columns.
-- Returns the updated rows as a JSON array (empty when nothing matched).
create function tp_sec.update_json(p_table regclass, p_id text, p_patch jsonb, p_allowed text[],
                                   p_expect jsonb default '{}') returns jsonb
language plpgsql set search_path = '' as $$
declare cols text[]; sets text; conds text := ''; k text; res jsonb;
begin
  select array_agg(c order by c) into cols from jsonb_object_keys(p_patch) c
   where c = any(p_allowed) and c = any(tp_sec.table_cols(p_table));
  if cols is null then raise exception 'TP_INVALID: nothing to change'; end if;
  select string_agg(format('%1$I = r.%1$I', c), ', ') into sets from unnest(cols) c;
  for k in select jsonb_object_keys(p_expect) loop
    conds := conds || format(' and (to_jsonb(t.*)->>%L) is not distinct from ($3->>%L)', k, k);
  end loop;
  execute format('with u as (update %s as t set %s from jsonb_populate_record(null::%s, $1) r
                   where t.id::text = $2 %s returning to_jsonb(t.*) as j)
                  select coalesce(jsonb_agg(j), ''[]'') from u', p_table, sets, p_table, conds)
    into res using p_patch, p_id, p_expect;
  return res;
end $$;

-- Is a row with this org in the signed-in company's scope?
create function tp_sec.org_in_scope(p_session_org text, p_row_org text) returns boolean
language sql stable set search_path = '' as $$
  select p_row_org = p_session_org
      or (p_row_org is null and coalesce((tp_sec.setting('include_null_org_rows'))::boolean, false))
$$;

create function tp_sec.clamp_limit(p jsonb, p_default integer, p_max integer) returns integer
language sql immutable set search_path = '' as
$$ select least(greatest(coalesce((p->>'limit')::int, p_default), 1), p_max) $$;

-- Columns a public tracking link may see.
create function tp_sec.public_job(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', j->'id', 'title', j->'title', 'status', j->'status',
    'pickup_address', j->'pickup_address', 'dropoff_address', j->'dropoff_address',
    'driver_name', j->'driver_name', 'total_packages', j->'total_packages', 'price', j->'price',
    'estimated_delivery_at', j->'estimated_delivery_at', 'driver_rating', j->'driver_rating',
    'stops_completed', j->'stops_completed')
$$;

-- ── 3. COMPANY (ORG) SIGN-IN ─────────────────────────────────────────────
-- Sign-in functions RETURN {ok:false, error} on failure instead of raising:
-- an exception would roll back the failed-attempt record that the lockout
-- counts.
-- Existing portal access codes are hashed into tp_sec.org_codes. Companies
-- without one cannot sign in until Bryan sets a code:
--   select tp_sec.admin_set_org_code('quickhaul', 'a long code');
insert into tp_sec.org_codes (org_key, code_hash)
select o.id::text, extensions.crypt(o.access_code, extensions.gen_salt('bf', 10))
from public.organizations o
where coalesce(btrim(o.access_code), '') <> '';

create function tp_sec.admin_set_org_code(p_slug text, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if length(coalesce(p_code,'')) < 8 then raise exception 'Use a company code of at least 8 characters'; end if;
  select id::text into k from public.organizations where lower(slug) = lower(btrim(p_slug));
  if k is null then raise exception 'No organization with slug %', p_slug; end if;
  insert into tp_sec.org_codes (org_key, code_hash, updated_at)
  values (k, extensions.crypt(p_code, extensions.gen_salt('bf', 10)), now())
  on conflict (org_key) do update set code_hash = excluded.code_hash, updated_at = now();
  -- a new code signs out every existing company session
  update tp_sec.sessions set revoked_at = now() where kind = 'org' and org_key = k and revoked_at is null;
  return 'Company code set for ' || p_slug;
end $$;
revoke all on function tp_sec.admin_set_org_code(text, text) from public;

create function public.tp_org_lookup(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', o.id, 'slug', o.slug, 'name', o.name)
  from public.organizations o where lower(o.slug) = lower(btrim(p_slug)) limit 1
$$;

create function public.tp_org_sign_in(p_slug text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o record; h text; v_slug text := lower(btrim(coalesce(p_slug,'')));
begin
  if tp_sec.rate_count('org_fail', v_slug, interval '15 minutes') >= 10
     or tp_sec.rate_count('org_fail_all', 'all', interval '15 minutes') >= 200 then
    return jsonb_build_object('ok', false, 'error', 'TP_RATE: too many attempts, try again in 15 minutes');
  end if;
  select id, slug, name into o from public.organizations where lower(organizations.slug) = v_slug limit 1;
  if found then select code_hash into h from tp_sec.org_codes where org_key = o.id::text; end if;
  if o.id is null or h is null or extensions.crypt(coalesce(p_code,''), h) <> h then
    perform tp_sec.rate_ok('org_fail', v_slug, 1000000, interval '15 minutes');
    perform tp_sec.rate_ok('org_fail_all', 'all', 1000000, interval '15 minutes');
    return jsonb_build_object('ok', false, 'error', 'TP_DENIED: company or code not recognised');
  end if;
  return jsonb_build_object('ok', true,
    'token', tp_sec.new_session('org', o.id::text, null, null, null, false, 30),
    'org', jsonb_build_object('id', o.id, 'slug', o.slug, 'name', o.name));
end $$;

create function public.tp_sign_out(p_token text) returns jsonb
language sql security definer set search_path = '' as $$
  update tp_sec.sessions set revoked_at = now()
   where token_hash = tp_sec.sha256_hex(p_token) and revoked_at is null;
  select jsonb_build_object('ok', true)
$$;

-- ── 4. COMPANY GATEWAY: dispatcher, fleet, PathIQ stow, portal ───────────
create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions := tp_sec.session(p_token, 'org');
  a jsonb := coalesce(p_args, '{}');
  org text := s.org_key;
  res jsonb;
  jid text := a->>'id';
  lim integer;
  job_allowed constant text[] := array['status','driver_name','archived','exception_flag','exception_detected_at',
    'estimated_delivery_at','original_eta_at','eta_minutes','surge_stops','stops_completed','bin_label','staged_at'];
begin
  -- every action that names a job must name one of this company's jobs
  if jid is not null and p_action in ('job','update_job','set_bin_label','set_staged','open_binding','binding_ready') then
    if not exists (select 1 from public.jobs j where j.id::text = jid and tp_sec.org_in_scope(org, j.org_id::text)) then
      raise exception 'TP_DENIED: not one of your jobs';
    end if;
  end if;

  case p_action
  when 'me' then
    return (select jsonb_build_object('id', o.id, 'slug', o.slug, 'name', o.name)
              from public.organizations o where o.id::text = org);

  when 'jobs' then
    lim := tp_sec.clamp_limit(a, 1000, 2000);
    select coalesce(jsonb_agg(x.j order by x.c desc), '[]') into res from (
      select to_jsonb(j.*) as j, j.created_at as c from public.jobs j
       where tp_sec.org_in_scope(org, j.org_id::text)
         and (a->>'since' is null or j.created_at >= (a->>'since')::timestamptz)
         and (a->'statuses' is null or j.status = any(array(select jsonb_array_elements_text(a->'statuses'))))
         and (a->'ids' is null or j.id::text = any(array(select jsonb_array_elements_text(a->'ids'))))
         and (a->>'source' is null or to_jsonb(j.*)->>'source' = a->>'source')
         and (coalesce((a->>'unbinned')::boolean, false) = false or j.bin_label is null)
       order by case when a->>'order' = 'asc' then j.created_at end asc,
                case when coalesce(a->>'order','desc') <> 'asc' then j.created_at end desc
       limit lim) x;
    if a->>'order' = 'asc' then   -- oldest first (PathIQ), limit applied to the oldest rows
      select coalesce(jsonb_agg(e order by (e->>'created_at')::timestamptz), '[]') into res from jsonb_array_elements(res) e;
    end if;
    return res;

  when 'job' then
    return (select to_jsonb(j.*) from public.jobs j where j.id::text = jid);

  when 'update_job' then
    return tp_sec.update_json('public.jobs', jid, coalesce(a->'patch', '{}'), job_allowed,
                              coalesce(a->'expect', '{}'));

  when 'archive_jobs' then  -- "Clear board": archive instead of delete
    with u as (update public.jobs j set archived = true
                where tp_sec.org_in_scope(org, j.org_id::text)
                  and j.id::text = any(array(select jsonb_array_elements_text(a->'ids')))
                returning 1)
    select jsonb_build_object('archived', count(*)) into res from u;
    return res;

  when 'publish_route' then
    -- the RPC that validates piece conservation; the company comes from the session
    return public.publish_surge_route(jsonb_set(coalesce(a->'payload','{}'), '{org_id}', to_jsonb(org)));

  when 'drivers' then
    select coalesce(jsonb_agg(to_jsonb(d.*) order by d.name), '[]') into res from public.drivers d
     where coalesce(d.status,'') <> 'removed'
       and tp_sec.org_in_scope(org, to_jsonb(d.*)->>'org_id');
    return res;

  when 'driver_add' then
    return tp_sec.insert_json('public.drivers',
      jsonb_strip_nulls(jsonb_build_object('name', btrim(a->>'name'), 'phone', tp_sec.norm_phone(a->>'phone'),
                                           'org_id', org, 'status', 'active')),
      array['name','phone','org_id','status']);

  when 'driver_update', 'driver_remove', 'driver_approve' then
    if not exists (select 1 from public.drivers d where d.id::text = jid
                    and tp_sec.org_in_scope(org, to_jsonb(d.*)->>'org_id')) then
      raise exception 'TP_DENIED: not one of your drivers';
    end if;
    res := tp_sec.update_json('public.drivers', jid,
      case p_action
        when 'driver_remove'  then jsonb_build_object('status', 'removed')
        when 'driver_approve' then jsonb_build_object('status', 'active')
        else jsonb_strip_nulls(jsonb_build_object('name', btrim(a->>'name'),
                                                  'phone', tp_sec.norm_phone(a->>'phone'))) end,
      array['name','phone','status']);
    if p_action = 'driver_remove' then  -- removed drivers are signed out
      update tp_sec.sessions set revoked_at = now() where kind = 'driver' and driver_key = jid and revoked_at is null;
    end if;
    return res;

  when 'messages' then
    lim := tp_sec.clamp_limit(a, 200, 2000);
    select coalesce(jsonb_agg(x.m order by x.c), '[]') into res from (
      select to_jsonb(m.*) as m, m.created_at as c from public.messages m
        left join public.jobs j on j.id::text = m.job_id::text
       where (case when m.job_id is null then coalesce((tp_sec.setting('include_null_org_rows'))::boolean, false)
                   else j.id is not null and tp_sec.org_in_scope(org, j.org_id::text) end)
         and (a->>'job_id' is null or m.job_id::text = a->>'job_id')
         and (a->>'sender_role' is null or m.sender_role = a->>'sender_role')
         and (a->>'since' is null or m.created_at >= (a->>'since')::timestamptz)
       order by m.created_at desc limit lim) x;
    if coalesce(a->>'order','desc') = 'desc' then
      select coalesce(jsonb_agg(e order by e->>'created_at' desc), '[]') into res from jsonb_array_elements(res) e;
    end if;
    return res;

  when 'post_message' then
    if a->>'job_id' is not null and not exists (select 1 from public.jobs j
         where j.id::text = a->>'job_id' and tp_sec.org_in_scope(org, j.org_id::text)) then
      raise exception 'TP_DENIED: not one of your jobs';
    end if;
    return tp_sec.insert_json('public.messages', jsonb_build_object(
      'job_id', a->'job_id', 'sender', coalesce(nullif(a->>'sender',''), 'Dispatcher'),
      'sender_role', case when a->>'sender_role' in ('dispatcher','system','agent') then a->>'sender_role' else 'dispatcher' end,
      'body', left(coalesce(a->>'body',''), 4000)),
      array['job_id','sender','sender_role','body']);

  when 'locations' then
    lim := tp_sec.clamp_limit(a, 200, 1000);
    select coalesce(jsonb_agg(x.l order by x.u desc), '[]') into res from (
      select to_jsonb(l.*) as l, l.updated_at as u from public.driver_locations l
        left join public.jobs j on j.id::text = l.job_id::text
       where (j.id is not null and tp_sec.org_in_scope(org, j.org_id::text))
          or exists (select 1 from public.drivers d where d.name = l.driver_name
                      and tp_sec.org_in_scope(org, to_jsonb(d.*)->>'org_id'))
       order by l.updated_at desc limit lim) x;
    return res;

  when 'agent_memory' then
    lim := tp_sec.clamp_limit(a, 100, 500);
    select coalesce(jsonb_agg(x.r order by x.c desc), '[]') into res from (
      select to_jsonb(m.*) as r, m.created_at as c from public.agent_memory m
       where tp_sec.org_in_scope(org, to_jsonb(m.*)->>'org_id')
         and (a->>'agent_name' is null or m.agent_name = a->>'agent_name')
         and (a->>'event_type' is null or m.event_type = a->>'event_type')
         and (a->>'since' is null or m.created_at >= (a->>'since')::timestamptz)
       order by m.created_at desc limit lim) x;
    return res;

  when 'agent_memory_insert' then
    return tp_sec.insert_json('public.agent_memory',
      jsonb_strip_nulls(jsonb_build_object('agent_name', a->>'agent_name', 'event_type', a->>'event_type',
        'job_id', a->'job_id', 'driver_name', a->'driver_name', 'details', a->'details', 'org_id', org)),
      array['agent_name','event_type','job_id','driver_name','details','org_id']);

  when 'bin_shortfall' then
    if to_regclass('public.bin_shortfall') is null then return '[]'; end if;
    execute 'select coalesce(jsonb_agg(r), ''[]'') from (select to_jsonb(b.*) r from public.bin_shortfall b) x
              where tp_sec.org_in_scope($1, r->>''org_id'')' into res using org;
    return res;

  when 'shopify_connection' then
    if to_regclass('public.shopify_connections') is null then return '[]'; end if;
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''shop_domain'', r->''shop_domain'', ''active'', r->''active'',
               ''auto_dispatch'', r->''auto_dispatch'', ''org_id'', r->''org_id'', ''created_at'', r->''created_at'')), ''[]'')
             from (select to_jsonb(c.*) r from public.shopify_connections c) x
             where (r->>''active'')::boolean is true and tp_sec.org_in_scope($1, r->>''org_id'')' into res using org;
    return res;

  -- PathIQ stow
  when 'set_bin_label' then
    return tp_sec.update_json('public.jobs', jid, jsonb_build_object('bin_label', a->'bin_label'), array['bin_label']);
  when 'set_staged' then
    return tp_sec.update_json('public.jobs', jid,
      jsonb_build_object('staged_at', case when coalesce((a->>'staged')::boolean, false) then to_jsonb(now()) else 'null'::jsonb end),
      array['staged_at']);
  when 'bindings' then
    select coalesce(jsonb_agg(to_jsonb(b.*)), '[]') into res from public.bin_bindings b
      left join public.jobs j on j.id::text = b.job_id::text
     where b.state in ('open','ready')
       and (tp_sec.org_in_scope(org, b.org_id::text) or (j.id is not null and tp_sec.org_in_scope(org, j.org_id::text)))
       and (a->>'job_id' is null or b.job_id::text = a->>'job_id');
    return res;
  when 'open_binding' then
    return tp_sec.insert_json('public.bin_bindings', jsonb_build_object(
      'org_id', org, 'bin_code', a->>'bin_code', 'location_code', a->>'location_code',
      'job_id', jid, 'state', 'open', 'opened_by', left(coalesce(a->>'opened_by',''), 80)),
      array['org_id','bin_code','location_code','job_id','state','opened_by']);
  when 'binding_ready' then
    update public.bin_bindings b set state = 'ready', ready_at = now()
     where b.job_id::text = jid and b.state = 'open';
    return jsonb_build_object('ok', true);
  when 'log_event' then
    begin
      res := tp_sec.insert_json('public.events', jsonb_strip_nulls(jsonb_build_object(
        'org_id', org, 'event_type', a->>'event_type', 'job_id', a->'job_id', 'driver_name', a->'driver_name',
        'actor', left(coalesce(a->>'actor',''), 80), 'device_id', left(coalesce(a->>'device_id',''), 80),
        'payload', coalesce(a->'payload','{}'), 'idempotency_key', a->>'idempotency_key',
        'occurred_at', coalesce(a->>'occurred_at', now()::text))),
        array['org_id','event_type','job_id','driver_name','actor','device_id','payload','idempotency_key','occurred_at']);
    exception when unique_violation then
      res := jsonb_build_object('duplicate', true);     -- same as Prefer: resolution=ignore-duplicates
    end;
    return res;
  when 'events' then
    lim := tp_sec.clamp_limit(a, 5000, 5000);
    select coalesce(jsonb_agg(x.e order by x.t), '[]') into res from (
      select to_jsonb(e.*) as e, e.occurred_at as t from public.events e
       where tp_sec.org_in_scope(org, to_jsonb(e.*)->>'org_id')
         and (a->'types' is null or e.event_type = any(array(select jsonb_array_elements_text(a->'types'))))
         and (a->>'since' is null or e.occurred_at >= (a->>'since')::timestamptz)
       order by e.occurred_at asc limit lim) x;
    return res;

  when 'sign_out' then
    update tp_sec.sessions set revoked_at = now() where token_hash = s.token_hash;
    return jsonb_build_object('ok', true);
  else
    raise exception 'TP_INVALID: unknown action %', p_action;
  end case;
end $$;

-- ── 5. DRIVER SIGN-IN (one-time SMS codes) ───────────────────────────────
-- Code SMS is sent by the driver-login edge function, which calls this with
-- the service-role key. Returns the code only to that function.
create function public.tp_svc_driver_code(p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph text := tp_sec.norm_phone(p_phone);
  d record;
  code text; salt text;
begin
  if ph is null then return jsonb_build_object('send', false, 'reason', 'invalid_phone'); end if;
  if ph = (tp_sec.setting('demo_phone')#>>'{}') then          -- reviewer account: fixed code, never texted
    return jsonb_build_object('send', false, 'reason', 'demo');
  end if;
  if not tp_sec.rate_ok('code_global', 'all', 300, interval '1 hour') then
    return jsonb_build_object('send', false, 'reason', 'rate_global');
  end if;
  if tp_sec.rate_count('code_phone_min', ph, interval '60 seconds') >= 1
     or tp_sec.rate_count('code_phone_hour', ph, interval '1 hour') >= 5 then
    return jsonb_build_object('send', false, 'reason', 'rate_phone');
  end if;
  perform tp_sec.rate_ok('code_phone_min', ph, 1000000, interval '60 seconds');
  perform tp_sec.rate_ok('code_phone_hour', ph, 1000000, interval '1 hour');
  select d2.id, d2.status into d from public.drivers d2
   where tp_sec.norm_phone(d2.phone) = ph and coalesce(d2.status,'') <> 'removed'
   order by (coalesce(d2.status,'') in ('','active','approved')) desc limit 1;
  if not found then return jsonb_build_object('send', false, 'reason', 'not_registered'); end if;
  if coalesce(d.status,'') in ('pending_approval','rejected','inactive','suspended') then
    return jsonb_build_object('send', false, 'reason', 'not_approved');
  end if;
  code := lpad(((('x' || tp_sec.random_hex(4))::bit(32)::bigint) % 1000000)::text, 6, '0');
  salt := tp_sec.random_hex(16);
  update tp_sec.login_challenges set used_at = now() where phone = ph and used_at is null;  -- one live code per phone
  insert into tp_sec.login_challenges (phone, salt, code_hash, expires_at)
  values (ph, salt, tp_sec.sha256_hex(salt || code), now() + interval '10 minutes');
  return jsonb_build_object('send', true, 'to', '+1' || ph, 'code', code);
end $$;

create function public.tp_driver_sign_in(p_phone text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph text := tp_sec.norm_phone(p_phone);
  code text := regexp_replace(coalesce(p_code,''), '\D', '', 'g');
  c tp_sec.login_challenges;
  d record;
  dh text;
  demo boolean := false;
  org text;
begin
  if ph is null or length(code) <> 6 then return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code'); end if;
  if tp_sec.rate_count('signin_fail', ph, interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'TP_RATE: too many wrong codes, try again later');
  end if;

  if ph = (tp_sec.setting('demo_phone')#>>'{}') then
    -- The fixed reviewer code is only ever compared for this one number.
    select code_hash into dh from tp_sec.demo_code;
    if dh is null or extensions.crypt(code, dh) <> dh then
      perform tp_sec.rate_ok('signin_fail', ph, 1000000, interval '1 hour');
      return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code');
    end if;
    demo := true;
  else
    select * into c from tp_sec.login_challenges
     where phone = ph and used_at is null and expires_at > now()
     order by created_at desc limit 1 for update;
    if not found or c.attempts >= 5 then
      perform tp_sec.rate_ok('signin_fail', ph, 1000000, interval '1 hour');
      return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code');
    end if;
    if tp_sec.sha256_hex(c.salt || code) <> c.code_hash then
      update tp_sec.login_challenges set attempts = attempts + 1,
             used_at = case when attempts + 1 >= 5 then now() else null end
       where id = c.id;
      perform tp_sec.rate_ok('signin_fail', ph, 1000000, interval '1 hour');
      return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code');
    end if;
    update tp_sec.login_challenges set used_at = now() where id = c.id;   -- single use
  end if;

  select d2.id, d2.name, d2.phone, d2.status, to_jsonb(d2.*)->>'org_id' as org_id into d
    from public.drivers d2
   where tp_sec.norm_phone(d2.phone) = ph and coalesce(d2.status,'') <> 'removed'
   order by (coalesce(d2.status,'') in ('','active','approved')) desc limit 1;
  if not found or coalesce(d.status,'') in ('pending_approval','rejected','inactive','suspended') then
    return jsonb_build_object('ok', false, 'error', 'TP_DENIED: this number is not an approved TackPath driver');
  end if;
  org := d.org_id;
  if demo then  -- the reviewer only ever sees the review company's jobs
    select id::text into org from public.organizations where slug = (tp_sec.setting('demo_org_slug')#>>'{}');
    if org is null then return jsonb_build_object('ok', false, 'error', 'TP_DENIED: review account is not set up'); end if;
  end if;
  return jsonb_build_object('ok', true,
    'token', tp_sec.new_session('driver', org, d.id::text, d.name, ph, demo, 30),
    'driver', jsonb_build_object('id', d.id, 'name', d.name, 'phone', ph));
end $$;

create function tp_sec.admin_set_demo_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_code,'') !~ '^[0-9]{6}$' then raise exception 'The review code must be 6 digits'; end if;
  insert into tp_sec.demo_code (only_row, code_hash) values (true, extensions.crypt(p_code, extensions.gen_salt('bf', 10)))
  on conflict (only_row) do update set code_hash = excluded.code_hash;
  update tp_sec.sessions set revoked_at = now() where is_demo and revoked_at is null;
  return 'Review code set for ' || (tp_sec.setting('demo_phone')#>>'{}');
end $$;
revoke all on function tp_sec.admin_set_demo_code(text) from public;

-- Can this driver session see this job?
create function tp_sec.driver_sees(s tp_sec.sessions, j public.jobs) returns boolean
language sql stable set search_path = '' as $$
  select (case
            when s.is_demo then j.org_id::text = s.org_key
            when s.org_key is null then coalesce((tp_sec.setting('driver_without_org_sees_all'))::boolean, false)
                                        or j.org_id is null
            else tp_sec.org_in_scope(s.org_key, j.org_id::text) end)
     and (j.driver_name = s.driver_name
          or (j.status in ('routing','pending') and j.driver_name is null))
$$;

-- ── 6. DRIVER GATEWAY ────────────────────────────────────────────────────
create function public.tp_driver(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions := tp_sec.session(p_token, 'driver');
  a jsonb := coalesce(p_args, '{}');
  jid text := coalesce(a->>'id', a->>'job_id');
  j public.jobs;
  res jsonb;
  lim integer;
begin
  if jid is not null and p_action in ('job','claim','update_job','messages','post_message','bin_binding') then
    select * into j from public.jobs where id::text = jid;
    if not found or not tp_sec.driver_sees(s, j) then
      raise exception 'TP_DENIED: this job is not available to you';
    end if;
  end if;

  case p_action
  when 'me' then
    return jsonb_build_object('id', s.driver_key, 'name', s.driver_name, 'phone', s.driver_phone, 'demo', s.is_demo);

  when 'jobs' then
    lim := tp_sec.clamp_limit(a, 10, 50);
    select coalesce(jsonb_agg(x.r order by x.c desc), '[]') into res from (
      select to_jsonb(jj.*) as r, jj.created_at as c from public.jobs jj
       where tp_sec.driver_sees(s, jj)
         and (a->'statuses' is null or jj.status = any(array(select jsonb_array_elements_text(a->'statuses'))))
         and (coalesce((a->>'mine')::boolean, false) = false or jj.driver_name = s.driver_name)
         and (a->>'job_type' is null
              or (a->>'job_type' = 'not_surge' and (jj.job_type is null or jj.job_type <> 'surge'))
              or jj.job_type = a->>'job_type')
       order by jj.created_at desc limit lim) x;
    return res;

  when 'job' then
    return to_jsonb(j);

  when 'claim' then   -- accept an offer: only while still pending and unassigned
    return tp_sec.update_json('public.jobs', jid,
      jsonb_build_object('status', 'assigned', 'driver_name', s.driver_name),
      array['status','driver_name'], jsonb_build_object('status', 'pending', 'driver_name', null));

  when 'update_job' then
    if j.driver_name is distinct from s.driver_name then
      raise exception 'TP_DENIED: this route is assigned to someone else';
    end if;
    if a->'patch' ? 'status' and a->'patch'->>'status' not in ('assigned','in_transit','delivered') then
      raise exception 'TP_INVALID: status % is not a driver status', a->'patch'->>'status';
    end if;
    if a->'patch' ? 'driver_name' and a->'patch'->>'driver_name' is distinct from s.driver_name then
      raise exception 'TP_INVALID: a driver can only keep the route on their own name';
    end if;
    return tp_sec.update_json('public.jobs', jid, coalesce(a->'patch','{}'),
      array['status','driver_name','stops_completed','picked_up_at','started_at','delivered_at'],
      jsonb_build_object('driver_name', s.driver_name));

  when 'messages' then
    lim := tp_sec.clamp_limit(a, 200, 500);
    select coalesce(jsonb_agg(x.m order by x.c), '[]') into res from (
      select to_jsonb(m.*) as m, m.created_at as c from public.messages m
       where m.job_id::text = jid
         and (a->>'sender_role' is null or m.sender_role = a->>'sender_role')
       order by m.created_at desc limit lim) x;
    if coalesce(a->>'order','asc') = 'desc' then
      select coalesce(jsonb_agg(e order by e->>'created_at' desc), '[]') into res from jsonb_array_elements(res) e;
    end if;
    return res;

  when 'post_message' then
    return tp_sec.insert_json('public.messages', jsonb_build_object(
      'job_id', jid,
      'sender', case when a->>'sender' = 'system' then 'system' else s.driver_name end,
      'sender_role', case when a->>'sender' = 'system' then 'dispatcher' else 'driver' end,
      'body', left(coalesce(a->>'body',''), 8000)),
      array['job_id','sender','sender_role','body']);

  when 'location' then
    if a->>'job_id' is not null then
      select * into j from public.jobs where id::text = a->>'job_id';
      if not found or j.driver_name is distinct from s.driver_name then return jsonb_build_object('ok', false); end if;
    end if;
    res := jsonb_strip_nulls(jsonb_build_object('job_id', a->'job_id', 'driver_name', s.driver_name,
             'name', s.driver_name, 'lat', a->'lat', 'lng', a->'lng', 'accuracy', a->'accuracy',
             'speed', a->'speed', 'updated_at', now()));
    begin
      perform tp_sec.insert_json('public.driver_locations', res,
        array['job_id','driver_name','name','lat','lng','accuracy','speed','updated_at']);
    exception when unique_violation then   -- one row per driver: update it
      update public.driver_locations l set
        lat = (jsonb_populate_record(null::public.driver_locations, res)).lat,
        lng = (jsonb_populate_record(null::public.driver_locations, res)).lng,
        job_id = (jsonb_populate_record(null::public.driver_locations, res)).job_id,
        updated_at = now()
       where l.driver_name = s.driver_name;
    end;
    return jsonb_build_object('ok', true);

  when 'fcm_token' then
    res := jsonb_build_object('phone', s.driver_phone, 'driver_name', s.driver_name,
                              'token', left(coalesce(a->>'token',''), 4096), 'updated_at', now());
    begin
      perform tp_sec.insert_json('public.driver_fcm_tokens', res, array['phone','driver_name','token','updated_at']);
    exception when unique_violation then
      update public.driver_fcm_tokens t set token = res->>'token', driver_name = s.driver_name
       where t.phone = s.driver_phone;
    end;
    return jsonb_build_object('ok', true);

  when 'bin_binding' then
    select coalesce(jsonb_agg(jsonb_build_object('bin_code', b.bin_code, 'location_code', b.location_code,
                                                 'state', b.state)), '[]') into res
      from public.bin_bindings b where b.job_id::text = jid and b.state in ('open','ready');
    return res;

  when 'sign_out' then
    update tp_sec.sessions set revoked_at = now() where token_hash = s.token_hash;
    return jsonb_build_object('ok', true);
  else
    raise exception 'TP_INVALID: unknown action %', p_action;
  end case;
end $$;

-- ── 7. CUSTOMER ORDERS (customer.html) ───────────────────────────────────
-- Creating an order returns an order token; reading, confirming, cancelling
-- and messaging that order need it. Global and per-company caps stop floods.
create function public.tp_customer(p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}');
  jid text := a->>'id';
  org text;
  v_row jsonb;
  tok text;
begin
  if p_action <> 'create_order' then
    if jid is null or not exists (select 1 from tp_sec.order_tokens
                                   where job_key = jid and token_hash = tp_sec.sha256_hex(a->>'order_token')) then
      raise exception 'TP_DENIED: order not found';
    end if;
  end if;

  case p_action
  when 'create_order' then
    if a->>'org_slug' is not null then
      select id::text into org from public.organizations where lower(slug) = lower(a->>'org_slug');
    end if;
    if not tp_sec.rate_ok('order_global', 'all', 60, interval '1 hour')
       or not tp_sec.rate_ok('order_org', coalesce(org,'none'), 30, interval '1 hour') then
      raise exception 'TP_RATE: too many orders right now, please try again shortly';
    end if;
    v_row := tp_sec.insert_json('public.jobs', jsonb_strip_nulls(jsonb_build_object(
      'title', left(a->>'title', 200), 'pickup_address', left(a->>'pickup_address', 300),
      'dropoff_address', left(a->>'dropoff_address', 300), 'status', 'routing',
      'price', a->'price', 'distance_miles', a->'distance_miles', 'route_summary', a->'route_summary',
      'customer_confirmed', false, 'org_id', org, 'estimated_delivery_at', a->'estimated_delivery_at')),
      array['title','pickup_address','dropoff_address','status','price','distance_miles','route_summary',
            'customer_confirmed','org_id','estimated_delivery_at']);
    tok := tp_sec.random_hex(24);
    insert into tp_sec.order_tokens (job_key, token_hash) values (v_row->>'id', tp_sec.sha256_hex(tok));
    return jsonb_build_object('job', v_row, 'order_token', tok);

  when 'get' then
    return (select to_jsonb(j.*) from public.jobs j where j.id::text = jid);

  when 'confirm' then
    return tp_sec.update_json('public.jobs', jid, jsonb_build_object('status', 'pending', 'customer_confirmed', true),
                              array['status','customer_confirmed'], jsonb_build_object('status', 'routing'));

  when 'cancel' then
    if (select status from public.jobs where id::text = jid) not in ('routing','pending') then
      raise exception 'TP_DENIED: a driver is already on the way; contact dispatch to cancel';
    end if;
    return tp_sec.update_json('public.jobs', jid, jsonb_build_object('status', 'cancelled'), array['status']);

  when 'post_message' then
    if not tp_sec.rate_ok('order_msg', jid, 30, interval '1 hour') then return jsonb_build_object('ok', false); end if;
    return tp_sec.insert_json('public.messages', jsonb_build_object('job_id', jid, 'sender', 'CommAgent',
      'sender_role', 'agent', 'body', left(coalesce(a->>'body',''), 1000)), array['job_id','sender','sender_role','body']);
  else
    raise exception 'TP_INVALID: unknown action %', p_action;
  end case;
end $$;

-- ── 8. PUBLIC TRACKING (track.html, tracking.html) ───────────────────────
-- Exact job id or exact tracking number only (no prefix search), tracking
-- columns only, and only the customer's own stop of a multi-stop route.
create function public.tp_track(p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}');
  j public.jobs;
  tn text := upper(btrim(coalesce(a->>'tracking_number','')));
  st jsonb;
  rj jsonb;
  res jsonb;
begin
  if not tp_sec.rate_ok('track', 'all', 6000, interval '1 minute') then
    raise exception 'TP_RATE: tracking is busy, try again shortly';
  end if;
  case p_action
  when 'job' then
    select * into j from public.jobs where id::text = btrim(coalesce(a->>'id',''));
    if not found then return null; end if;
    return tp_sec.public_job(to_jsonb(j));

  when 'stop' then   -- tracking.html: one stop of a route, by its tracking number
    if length(tn) < 6 then return null; end if;
    select to_jsonb(jj.*), e.value into rj, st from public.jobs jj,
           jsonb_array_elements(case when jsonb_typeof(jj.surge_stops::jsonb) = 'array' then jj.surge_stops::jsonb else '[]' end) e
     where upper(e.value->>'tracking_number') = tn
     order by jj.created_at desc limit 1;
    if rj is null then return null; end if;
    return jsonb_build_object('id', rj->'id', 'status', rj->'status', 'stops_completed', rj->'stops_completed',
      'estimated_delivery_at', rj->'estimated_delivery_at', 'driver_name', rj->'driver_name',
      'surge_stops', jsonb_build_array(jsonb_build_object(
          'tracking_number', st->'tracking_number', 'stop_number', st->'stop_number',
          'recipient', st->'recipient', 'address', st->'address', 'status', st->'status',
          'delivered', st->'delivered', 'delivered_at', st->'delivered_at', 'cancelled', st->'cancelled',
          'lat', st->'lat', 'lng', st->'lng', 'eta', st->'eta')));

  when 'location' then   -- live driver position only while the delivery is under way
    select * into j from public.jobs where id::text = btrim(coalesce(a->>'id',''));
    if not found or j.status not in ('assigned','in_transit') then return null; end if;
    select jsonb_build_object('lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at) into res
      from public.driver_locations l where l.job_id::text = j.id::text order by l.updated_at desc limit 1;
    return res;

  when 'rate' then   -- once, after delivery
    if coalesce((a->>'rating')::int, 0) not between 1 and 5 then raise exception 'TP_INVALID: rating 1-5'; end if;
    return tp_sec.update_json('public.jobs', a->>'id', jsonb_build_object('driver_rating', (a->>'rating')::int),
                              array['driver_rating'], jsonb_build_object('status', 'delivered', 'driver_rating', null));
  else
    raise exception 'TP_INVALID: unknown action %', p_action;
  end case;
end $$;

-- ── 9. DRIVER APPLICATION (driversignup.html) ────────────────────────────
create function public.tp_driver_signup(p_args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'); ph text := tp_sec.norm_phone(a->>'phone');
begin
  if ph is null or coalesce(btrim(a->>'name'),'') = '' then raise exception 'TP_INVALID: name and a valid phone are required'; end if;
  if not tp_sec.rate_ok('signup', 'all', 30, interval '1 hour') then
    raise exception 'TP_RATE: too many applications right now, try again later';
  end if;
  if exists (select 1 from public.drivers d where tp_sec.norm_phone(d.phone) = ph) then
    return jsonb_build_object('exists', true);
  end if;
  perform tp_sec.insert_json('public.drivers', jsonb_build_object(
    'name', left(btrim(a->>'name'), 100), 'phone', ph, 'date_of_birth', a->'date_of_birth',
    'vehicle', left(a->>'vehicle', 100), 'sms_consent', coalesce((a->>'sms_consent')::boolean, false),
    'status', 'pending_approval'),
    array['name','phone','date_of_birth','vehicle','sms_consent','status']);
  return jsonb_build_object('ok', true);
end $$;

-- ── 10. SERVICE-ROLE RPCs FOR EDGE FUNCTIONS ─────────────────────────────
-- send-sms: the dispatcher passes its session and a job id; recipient and
-- text are decided here. Returns {send:false, reason} or {send:true, to, body}.
create function public.tp_svc_assignment_sms(p_token text, p_job_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions := tp_sec.session(p_token, 'org');
  j public.jobs;
  n integer;
  d record;
  ph text;
  title text;
begin
  select * into j from public.jobs where id::text = p_job_id;
  if not found or not tp_sec.org_in_scope(s.org_key, j.org_id::text) then
    return jsonb_build_object('send', false, 'reason', 'not_your_job');
  end if;
  if j.status <> 'assigned' or j.driver_name is null then
    return jsonb_build_object('send', false, 'reason', 'not_assigned');
  end if;
  select count(*) into n from public.drivers dd
   where dd.name = j.driver_name and coalesce(dd.status,'') <> 'removed'
     and tp_sec.org_in_scope(s.org_key, to_jsonb(dd.*)->>'org_id');
  if n <> 1 then return jsonb_build_object('send', false, 'reason', 'driver_ambiguous'); end if;
  select dd.id::text as id, dd.phone, dd.sms_consent into d from public.drivers dd
   where dd.name = j.driver_name and coalesce(dd.status,'') <> 'removed'
     and tp_sec.org_in_scope(s.org_key, to_jsonb(dd.*)->>'org_id');
  if d.sms_consent is not true then return jsonb_build_object('send', false, 'reason', 'no_consent'); end if;
  ph := tp_sec.norm_phone(d.phone);
  if ph is null or ph ~ '^[0-9]{3}55501[0-9]{2}$' then   -- invalid, or a fictional 555-01xx number
    return jsonb_build_object('send', false, 'reason', 'invalid_phone');
  end if;
  -- rate limits: once per job per 10 min, 10/driver/hour, 30/driver/day, 200/company/day, 500/day overall
  if exists (select 1 from tp_sec.sms_log where kind = 'assignment' and job_key = p_job_id and at > now() - interval '10 minutes')
     or (select count(*) from tp_sec.sms_log where kind = 'assignment' and driver_key = d.id and at > now() - interval '1 hour') >= 10
     or (select count(*) from tp_sec.sms_log where kind = 'assignment' and driver_key = d.id and at > now() - interval '1 day') >= 30
     or (select count(*) from tp_sec.sms_log where kind = 'assignment' and org_key = s.org_key and at > now() - interval '1 day') >= 200
     or (select count(*) from tp_sec.sms_log where at > now() - interval '1 day') >= 500 then
    return jsonb_build_object('send', false, 'reason', 'rate_limited');
  end if;
  insert into tp_sec.sms_log (kind, job_key, driver_key, org_key, phone) values ('assignment', p_job_id, d.id, s.org_key, ph);
  -- route title, cleaned: letters, digits and simple punctuation, no links, 60 chars
  title := btrim(left(regexp_replace(regexp_replace(coalesce(j.title,''), '(https?://|www\.)\S*', '', 'gi'),
                                     '[^A-Za-z0-9 #&()\-.,:/]', '', 'g'), 60));
  if title = '' then title := 'a new route'; end if;
  return jsonb_build_object('send', true, 'to', '+1' || ph,
    'body', 'TackPath: You have been assigned a new route: ' || title ||
            '. Open the TackPath driver app for details. Reply STOP to opt out.');
end $$;

-- pod: may this session upload proof for this job (driver) or view it (company)?
create function public.tp_svc_pod(p_token text, p_kind text, p_job_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tp_sec.sessions; j public.jobs;
begin
  select * into j from public.jobs where id::text = p_job_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_kind = 'driver' then
    s := tp_sec.session(p_token, 'driver');
    return jsonb_build_object('ok', j.driver_name = s.driver_name);
  else
    s := tp_sec.session(p_token, 'org');
    return jsonb_build_object('ok', tp_sec.org_in_scope(s.org_key, j.org_id::text));
  end if;
end $$;

-- Other edge functions (smooth-api, nav-proxy, smartsort, sponge,
-- swarm-watch): is this a live TackPath session, and of which kind?
create function public.tp_svc_session(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tp_sec.sessions;
begin
  select * into s from tp_sec.sessions where token_hash = tp_sec.sha256_hex(p_token);
  if not found or s.revoked_at is not null or s.expires_at < now() then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'kind', s.kind, 'org_id', s.org_key, 'driver_name', s.driver_name);
end $$;

-- ── 11. WHO MAY CALL WHAT ────────────────────────────────────────────────
-- Supabase's default privileges grant EXECUTE on every new function to anon
-- and authenticated, so revoking from PUBLIC alone is not enough.
revoke all on all functions in schema tp_sec from public, anon, authenticated;
revoke all on all tables in schema tp_sec from public, anon, authenticated;
revoke all on all sequences in schema tp_sec from public, anon, authenticated;

revoke all on function public.tp_org_lookup(text), public.tp_org_sign_in(text,text), public.tp_sign_out(text),
  public.tp_org(text,text,jsonb), public.tp_driver_sign_in(text,text), public.tp_driver(text,text,jsonb),
  public.tp_customer(text,jsonb), public.tp_track(text,jsonb), public.tp_driver_signup(jsonb),
  public.tp_svc_driver_code(text), public.tp_svc_assignment_sms(text,text), public.tp_svc_pod(text,text,text),
  public.tp_svc_session(text)
  from public, anon, authenticated;
grant execute on function public.tp_org_lookup(text), public.tp_org_sign_in(text,text), public.tp_sign_out(text),
  public.tp_org(text,text,jsonb), public.tp_driver_sign_in(text,text), public.tp_driver(text,text,jsonb),
  public.tp_customer(text,jsonb), public.tp_track(text,jsonb), public.tp_driver_signup(jsonb)
  to anon, authenticated, service_role;
grant execute on function public.tp_svc_driver_code(text), public.tp_svc_assignment_sms(text,text),
  public.tp_svc_pod(text,text,text), public.tp_svc_session(text) to service_role;

commit;
