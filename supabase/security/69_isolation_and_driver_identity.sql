-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 69: company isolation and driver identity
-- (SmartSort automation, step 1: safety fixes).
--
-- 1. General messages stay inside their company.
--    A message with no route (job_id null) was visible to EVERY company
--    (tp_org 'messages' showed job-less messages whenever the setting
--    include_null_org_rows is true, its default). messages gets an org_id:
--    'post_message' with no route stamps the poster's company, messages on a
--    route take the route's company (trigger), and 'messages' shows a
--    job-less message only to its own company. Old job-less messages with no
--    company stay in the table but are shown to nobody.
--
-- 2. A driver approved by a company belongs to that company.
--    Drivers who sign up on driversignup.html have no company. 'driver_approve'
--    set them active but left org_id empty, and a driver session with no
--    company sees routes of EVERY company (setting driver_without_org_sees_all).
--    Now: approving stamps the approving company; active drivers with no
--    company are matched to one company when it is certain (every route they
--    have driven belongs to one company), otherwise they are listed in
--    tp_sec.identity_review for a person to decide; then
--    driver_without_org_sees_all is switched off. Nothing is guessed.
--
-- 3. Routes are assigned to a driver id, not only a name.
--    jobs.driver_id (new). A trigger keeps it in step with driver_name: a name
--    that matches exactly one active driver of the route's company sets the
--    id; a name that matches none or several leaves the id empty and lists the
--    route in tp_sec.identity_review ("needs the driver confirmed"). Existing
--    routes are matched the same way, never guessed. The dispatcher assigns
--    by id ('update_job' with patch.driver_id); a driver's Accept stores the
--    driver's own id. A driver sees and works a route only if it carries
--    their id, or (no id yet) their name and that name is unique in the
--    company. driver_name stays for display and history.
--
-- 4. Drivers do not see customer details before the route is theirs.
--    Open routes (unassigned, routing or pending) were sent to drivers as the
--    whole row, stops, recipients and addresses included. Now an open route
--    is sent as a summary: stops, packages, miles, pay, pickup address, and
--    the delivery area (city, state, ZIP) for single deliveries. The full
--    route arrives with a successful Accept.
--
-- 5. One phone in two companies signs in to the company the driver chooses.
--    tp_driver_sign_in picked an arbitrary one. Now, when the code is right
--    and the phone is an approved driver in more than one company, it answers
--    {ok:false, error:'TP_CHOOSE_COMPANY', companies:[{slug,name}]} without
--    using up the code; the app calls again with p_org (the chosen slug).
--
-- Wrapped like 60-67: tp_org (65's wrapper) moves to tp_sec.tp_org_v65,
-- tp_driver (67's) to tp_sec.tp_driver_v67, migration 10's
-- tp_driver_sign_in to tp_sec.tp_driver_sign_in_v10; new public functions
-- with the same names and grants take their places (tp_driver_sign_in gains
-- an optional third argument). Still the nine public entry points.
--
-- Needs 10, 20, 64, 65, 67. Preflight stops, changing nothing, if 69 is
-- already applied or one of them is missing.
-- Rollback: 69_isolation_and_driver_identity.rollback.sql.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v63(text,text,jsonb)') is null then
    raise exception 'Apply 65_bins_self_heal.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_driver_v64(text,text,jsonb)') is null then
    raise exception 'Apply 67_driver_staging_spot.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_org_v65(text,text,jsonb)') is not null
     or to_regprocedure('tp_sec.tp_driver_v67(text,text,jsonb)') is not null then
    raise exception 'Migration 69 is already applied. Nothing was changed.';
  end if;
end $pre$;

-- ── what a person must look at: routes whose driver is uncertain, drivers with no company ──
create table if not exists tp_sec.identity_review (
  kind       text not null check (kind in ('route_driver', 'driver_company')),
  ref_id     text not null,              -- jobs.id or drivers.id
  org_id     text,                       -- the company that should see it (null: platform admin)
  name       text,
  reason     text not null,
  created_at timestamptz not null default now(),
  primary key (kind, ref_id)
);
revoke all on tp_sec.identity_review from public, anon, authenticated;

create function tp_sec.flag_identity(p_kind text, p_ref text, p_org text, p_name text, p_reason text) returns void
language sql set search_path = '' as $$
  insert into tp_sec.identity_review (kind, ref_id, org_id, name, reason)
  values (p_kind, p_ref, p_org, p_name, p_reason)
  on conflict (kind, ref_id) do update set org_id = excluded.org_id, name = excluded.name, reason = excluded.reason
$$;

-- active drivers of a company with exactly this name
create function tp_sec.drivers_named(p_org text, p_name text) returns setof uuid
language sql stable set search_path = '' as $$
  select d.id from public.drivers d
   where to_jsonb(d.*)->>'org_id' = p_org
     and lower(btrim(d.name)) = lower(btrim(p_name))
     and coalesce(d.status, '') not in ('removed', 'rejected')
$$;

-- ── 1. messages: a company ─────────────────────────────────────────────
alter table public.messages add column if not exists org_id uuid;
update public.messages m set org_id = j.org_id from public.jobs j
 where m.org_id is null and m.job_id is not null and j.id::text = m.job_id::text;

create function tp_sec.message_org() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null and new.job_id is not null then
    select j.org_id into new.org_id from public.jobs j where j.id::text = new.job_id::text;
  end if;
  return new;
end $$;
create trigger tp_message_org before insert on public.messages for each row execute function tp_sec.message_org();

-- ── 2 + 3. jobs.driver_id, kept in step with driver_name ───────────────
alter table public.jobs add column if not exists driver_id uuid;
create index if not exists jobs_driver_id on public.jobs (driver_id) where driver_id is not null;

create function tp_sec.job_driver_id() returns trigger language plpgsql set search_path = '' as $$
declare ids uuid[]; d record;
begin
  if tg_op = 'UPDATE' and new.driver_name is not distinct from old.driver_name
     and new.driver_id is not distinct from old.driver_id then
    return new;
  end if;
  if new.driver_name is null and new.driver_id is null then
    delete from tp_sec.identity_review where kind = 'route_driver' and ref_id = new.id::text;
    return new;
  end if;
  -- an id given on purpose (dispatcher by id, driver Accept): it must be a driver of this company
  if new.driver_id is not null and (tg_op = 'INSERT' or new.driver_id is distinct from old.driver_id) then
    select dd.id, dd.name, to_jsonb(dd.*)->>'org_id' as org_id, dd.status into d from public.drivers dd where dd.id = new.driver_id;
    if not found or coalesce(d.status, '') in ('removed', 'rejected')
       or (new.org_id is not null and d.org_id is distinct from new.org_id::text) then
      raise exception 'TP_INVALID: that driver is not a driver of this company';
    end if;
    new.driver_name := d.name;
    delete from tp_sec.identity_review where kind = 'route_driver' and ref_id = new.id::text;
    return new;
  end if;
  -- the name changed: set the id only when the name names exactly one driver of the company
  if new.driver_name is null then
    new.driver_id := null;
    delete from tp_sec.identity_review where kind = 'route_driver' and ref_id = new.id::text;
    return new;
  end if;
  ids := array(select tp_sec.drivers_named(new.org_id::text, new.driver_name));
  if cardinality(ids) = 1 then
    new.driver_id := ids[1];
    delete from tp_sec.identity_review where kind = 'route_driver' and ref_id = new.id::text;
  else
    new.driver_id := null;
    perform tp_sec.flag_identity('route_driver', new.id::text, new.org_id::text, new.driver_name,
      case when cardinality(ids) = 0 then 'no active driver of this company has this name'
           else cardinality(ids) || ' drivers of this company have this name' end);
  end if;
  return new;
end $$;
create trigger tp_job_driver_id before insert or update of driver_name, driver_id on public.jobs
  for each row execute function tp_sec.job_driver_id();

-- existing routes: matched only when certain; everything else is listed for a person
do $backfill$
declare j record; ids uuid[];
begin
  for j in select id, org_id, driver_name from public.jobs where driver_name is not null and driver_id is null loop
    ids := array(select tp_sec.drivers_named(j.org_id::text, j.driver_name));
    if cardinality(ids) = 1 then
      update public.jobs set driver_id = ids[1] where id = j.id;
    else
      perform tp_sec.flag_identity('route_driver', j.id::text, j.org_id::text, j.driver_name,
        case when cardinality(ids) = 0 then 'no active driver of this company has this name'
             else cardinality(ids) || ' drivers of this company have this name' end);
    end if;
  end loop;
end $backfill$;

-- active drivers with no company: matched only when every route they drove is one company's
do $drivers$
declare d record; orgs text[];
begin
  for d in select dd.id, dd.name from public.drivers dd
            where to_jsonb(dd.*)->>'org_id' is null and coalesce(dd.status, '') in ('', 'active', 'approved') loop
    orgs := array(select distinct j.org_id::text from public.jobs j
                   where j.org_id is not null and lower(btrim(j.driver_name)) = lower(btrim(d.name)));
    if cardinality(orgs) = 1 then
      update public.drivers set org_id = orgs[1]::uuid where id = d.id;
    else
      perform tp_sec.flag_identity('driver_company', d.id::text, null, d.name,
        case when cardinality(orgs) = 0 then 'approved driver with no company and no routes'
             else 'drove routes for ' || cardinality(orgs) || ' companies' end);
    end if;
  end loop;
end $drivers$;

-- a driver session with no company no longer sees every company's routes
update tp_sec.settings set value = 'false' where key = 'driver_without_org_sees_all';

-- ── route summary for drivers who have not got the route ───────────────
create function tp_sec.route_summary(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select (select coalesce(jsonb_object_agg(k, j->k), '{}') from unnest(array[
            'id','org_id','title','status','job_type','total_stops','total_packages','price','distance_miles',
            'pickup_address','created_at','estimated_delivery_at','archived','bin_label','staged_at','master_code']) k
          where j ? k)
         || jsonb_build_object('summary', true, 'driver_name', null, 'driver_id', null,
              'dropoff_area', nullif(btrim(regexp_replace(coalesce(j->>'dropoff_address', ''), '^[^,]*,\s*', '')), ''))
$$;

-- may this driver session work this route? (its id, or its name when the name is unique in the company)
create function tp_sec.route_is_mine(s tp_sec.sessions, j public.jobs) returns boolean
language sql stable set search_path = '' as $$
  select case
    when j.driver_id is not null then j.driver_id::text = s.driver_key
    when j.driver_name is null then false
    else lower(btrim(j.driver_name)) = lower(btrim(s.driver_name))
         and (select count(*) from tp_sec.drivers_named(j.org_id::text, j.driver_name)) <= 1
  end
$$;

-- ── gateways ───────────────────────────────────────────────────────────
alter function public.tp_org(text,text,jsonb) rename to tp_org_v65;
alter function public.tp_org_v65(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v65(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}');
  jid text := coalesce(a->>'id', a->>'job_id');
  s tp_sec.sessions; org text; lim integer; res jsonb; d record;
begin
  if p_action not in ('messages', 'post_message', 'update_job', 'driver_approve', 'identity_review') then
    return tp_sec.tp_org_v65(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;

  if p_action = 'messages' then
    lim := tp_sec.clamp_limit(a, 200, 2000);
    select coalesce(jsonb_agg(x.m order by x.c), '[]') into res from (
      select to_jsonb(m.*) as m, m.created_at as c from public.messages m
        left join public.jobs j on j.id::text = m.job_id::text
       where (case when m.job_id is null then m.org_id::text = org
                   else j.id is not null and tp_sec.org_in_scope(org, j.org_id::text) end)
         and (a->>'job_id' is null or m.job_id::text = a->>'job_id')
         and (a->>'sender_role' is null or m.sender_role = a->>'sender_role')
         and (a->>'since' is null or m.created_at >= (a->>'since')::timestamptz)
       order by m.created_at desc limit lim) x;
    if coalesce(a->>'order', 'desc') = 'desc' then
      select coalesce(jsonb_agg(e order by e->>'created_at' desc), '[]') into res from jsonb_array_elements(res) e;
    end if;
    return res;
  end if;

  if p_action = 'post_message' then
    if a->>'job_id' is not null then
      return tp_sec.tp_org_v65(p_token, p_action, p_args);    -- the route's company (trigger)
    end if;
    return tp_sec.insert_json('public.messages', jsonb_build_object(
      'job_id', null, 'org_id', org, 'sender', coalesce(nullif(a->>'sender', ''), 'Dispatcher'),
      'sender_role', case when a->>'sender_role' in ('dispatcher', 'system', 'agent') then a->>'sender_role' else 'dispatcher' end,
      'body', left(coalesce(a->>'body', ''), 4000)),
      array['job_id', 'org_id', 'sender', 'sender_role', 'body']);
  end if;

  if p_action = 'update_job' and a->'patch' ? 'driver_id' then
    -- assign by id: the driver must be an active driver of this company
    if nullif(a->'patch'->>'driver_id', '') is null then
      res := tp_sec.tp_org_v65(p_token, p_action, jsonb_set(a, '{patch}', (a->'patch') - 'driver_id' || '{"driver_name": null}'));
      return res;
    end if;
    select dd.id, dd.name into d from public.drivers dd
     where dd.id::text = a->'patch'->>'driver_id' and to_jsonb(dd.*)->>'org_id' = org
       and coalesce(dd.status, '') not in ('removed', 'rejected', 'pending_approval');
    if not found then raise exception 'TP_INVALID: that driver is not an active driver of your company'; end if;
    perform tp_sec.tp_org_v65(p_token, p_action, jsonb_set(a, '{patch}', ((a->'patch') - 'driver_id') || jsonb_build_object('driver_name', d.name)));
    update public.jobs set driver_id = d.id where id::text = jid;
    return (select coalesce(jsonb_agg(to_jsonb(j.*)), '[]') from public.jobs j where j.id::text = jid);
  end if;

  if p_action = 'driver_approve' then
    res := tp_sec.tp_org_v65(p_token, p_action, p_args);
    -- a driver who signed up with no company joins the company that approves them
    update public.drivers set org_id = org::uuid where id::text = jid and org_id is null;
    delete from tp_sec.identity_review where kind = 'driver_company' and ref_id = jid;
    return (select to_jsonb(dd.*) from public.drivers dd where dd.id::text = jid);
  end if;

  if p_action = 'identity_review' then
    select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'id', r.ref_id, 'name', r.name, 'reason', r.reason,
                                                 'title', j.title, 'status', j.status, 'created_at', r.created_at)
                              order by r.created_at), '[]') into res
      from tp_sec.identity_review r left join public.jobs j on r.kind = 'route_driver' and j.id::text = r.ref_id
     where r.org_id = org and (r.kind <> 'route_driver' or coalesce(j.archived, false) = false);
    return res;
  end if;

  return tp_sec.tp_org_v65(p_token, p_action, p_args);
end $$;
revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

alter function public.tp_driver(text,text,jsonb) rename to tp_driver_v67;
alter function public.tp_driver_v67(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_driver_v67(text,text,jsonb) from public, anon, authenticated;

create function public.tp_driver(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}');
  jid text := coalesce(a->>'id', a->>'job_id');
  s tp_sec.sessions; j public.jobs; res jsonb; e jsonb; out jsonb := '[]';
begin
  if p_action not in ('jobs', 'job', 'claim', 'update_job', 'messages', 'post_message', 'bin_binding', 'location') then
    return tp_sec.tp_driver_v67(p_token, p_action, p_args);
  end if;
  s := tp_sec.session(p_token, 'driver');

  if p_action = 'jobs' then
    res := tp_sec.tp_driver_v67(p_token, p_action, p_args);
    for e in select * from jsonb_array_elements(coalesce(res, '[]')) loop
      j := null;
      select * into j from public.jobs where id::text = e->>'id';
      if j.id is null then continue; end if;
      if tp_sec.route_is_mine(s, j) then
        out := out || jsonb_build_array(to_jsonb(j));
      elsif j.driver_name is null and j.driver_id is null and j.status in ('routing', 'pending') then
        out := out || jsonb_build_array(tp_sec.route_summary(to_jsonb(j)));   -- an open offer: no customer details
      end if;
    end loop;
    return out;
  end if;

  if jid is not null then select * into j from public.jobs where id::text = jid; end if;

  if p_action = 'job' then
    res := tp_sec.tp_driver_v67(p_token, p_action, p_args);       -- session, company, archived checks
    if j.id is not null and tp_sec.route_is_mine(s, j) then return to_jsonb(j); end if;
    if j.id is not null and j.driver_name is null and j.driver_id is null then return tp_sec.route_summary(to_jsonb(j)); end if;
    raise exception 'TP_DENIED: this route is assigned to someone else';
  end if;

  if p_action = 'claim' then
    -- atomic: only while pending and unassigned; answers [row] when won, [] when someone else was first
    res := tp_sec.tp_driver_v67(p_token, p_action, p_args);
    if jsonb_typeof(res) = 'array' and jsonb_array_length(res) > 0 then
      update public.jobs set driver_id = s.driver_key::uuid
       where id::text = jid and driver_name = s.driver_name and driver_id is distinct from s.driver_key::uuid;
      return (select jsonb_agg(to_jsonb(jj.*)) from public.jobs jj where jj.id::text = jid);
    end if;
    return res;
  end if;

  -- working a route: only the driver it belongs to (an open offer may still be looked at)
  if j.id is not null and (j.driver_name is not null or j.driver_id is not null) and not tp_sec.route_is_mine(s, j) then
    if j.driver_id is null and lower(btrim(j.driver_name)) = lower(btrim(s.driver_name)) then
      raise exception 'TP_DENIED: dispatch needs to confirm the driver for this route';
    end if;
    raise exception 'TP_DENIED: this route is assigned to someone else';
  end if;
  return tp_sec.tp_driver_v67(p_token, p_action, p_args);
end $$;
revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

-- ── 5. sign-in when one phone is a driver in more than one company ─────
alter function public.tp_driver_sign_in(text,text) rename to tp_driver_sign_in_v10;
alter function public.tp_driver_sign_in_v10(text,text) set schema tp_sec;
revoke all on function tp_sec.tp_driver_sign_in_v10(text,text) from public, anon, authenticated;

create function public.tp_driver_sign_in(p_phone text, p_code text, p_org text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ph text := tp_sec.norm_phone(p_phone);
  code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  c tp_sec.login_challenges; d record; n integer; comp jsonb;
begin
  -- only phones that are approved drivers in two or more companies need a choice; everything else is unchanged
  select count(distinct to_jsonb(d2.*)->>'org_id') into n from public.drivers d2
   where tp_sec.norm_phone(d2.phone) = ph and coalesce(d2.status, '') in ('', 'active', 'approved')
     and to_jsonb(d2.*)->>'org_id' is not null;
  if ph is null or n < 2 or ph = (tp_sec.setting('demo_phone')#>>'{}') then
    return tp_sec.tp_driver_sign_in_v10(p_phone, p_code);
  end if;

  if length(code) <> 6 then return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code'); end if;
  if tp_sec.rate_count('signin_fail', ph, interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'TP_RATE: too many wrong codes, try again later');
  end if;
  select * into c from tp_sec.login_challenges
   where phone = ph and used_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if not found or c.attempts >= 5 then
    perform tp_sec.rate_ok('signin_fail', ph, 1000000, interval '1 hour');
    return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code');
  end if;
  if tp_sec.sha256_hex(c.salt || code) <> c.code_hash then
    update tp_sec.login_challenges set attempts = attempts + 1,
           used_at = case when attempts + 1 >= 5 then now() else null end where id = c.id;
    perform tp_sec.rate_ok('signin_fail', ph, 1000000, interval '1 hour');
    return jsonb_build_object('ok', false, 'error', 'TP_DENIED: wrong or expired code');
  end if;

  if nullif(btrim(coalesce(p_org, '')), '') is null then
    -- right code, more than one company: the driver chooses; the code stays usable until it expires
    select coalesce(jsonb_agg(jsonb_build_object('slug', o.slug, 'name', o.name) order by o.name), '[]') into comp
      from public.organizations o
     where o.id::text in (select to_jsonb(d2.*)->>'org_id' from public.drivers d2
                           where tp_sec.norm_phone(d2.phone) = ph and coalesce(d2.status, '') in ('', 'active', 'approved'));
    return jsonb_build_object('ok', false, 'error', 'TP_CHOOSE_COMPANY', 'companies', comp);
  end if;

  select d2.id, d2.name, to_jsonb(d2.*)->>'org_id' as org_id into d
    from public.drivers d2 join public.organizations o on o.id::text = to_jsonb(d2.*)->>'org_id'
   where tp_sec.norm_phone(d2.phone) = ph and coalesce(d2.status, '') in ('', 'active', 'approved')
     and lower(o.slug) = lower(btrim(p_org))
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'TP_DENIED: you are not a driver of that company'); end if;
  update tp_sec.login_challenges set used_at = now() where id = c.id;   -- single use
  return jsonb_build_object('ok', true,
    'token', tp_sec.new_session('driver', d.org_id, d.id::text, d.name, ph, false, 30),
    'driver', jsonb_build_object('id', d.id, 'name', d.name, 'phone', ph));
end $$;
revoke all on function public.tp_driver_sign_in(text,text,text) from public, anon, authenticated;
grant execute on function public.tp_driver_sign_in(text,text,text) to anon, authenticated, service_role;

commit;
