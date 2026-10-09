-- ═══════════════════════════════════════════════════════════════════════
-- TackPath security hardening — migration 20: STAGE A LOCKDOWN
--
-- Apply ONLY after migration 10 is applied, the new edge functions are
-- deployed, the updated pages are live on tackpath.com, and the updated
-- driver app has reached every tester (old app builds stop working here).
--
-- What it does (schema public unless noted):
--   1. Records every grant, policy, RLS flag, default privilege and bucket
--      setting it is about to change in tp_sec.lockdown_backup (the rollback
--      replays exactly those statements).
--   2. Removes ALL table, view, column and sequence privileges from anon and
--      authenticated: no SELECT, INSERT, UPDATE or DELETE with the public key
--      on any table. Every live page uses the tp_* RPCs from migration 10.
--   3. Turns RLS on for every table and drops every PERMISSIVE policy (the
--      always-true "allow all" ones included). RESTRICTIVE policies only ever
--      narrow access and are left exactly as they are (production:
--      protect_scoped_drivers on drivers, protect_operational_memory on
--      agent_memory). With no permissive policy, only the service role and
--      the tp_* functions (owned by postgres) can touch rows.
--   4. Removes EXECUTE on every other public function from anon and
--      authenticated, PUBLIC included (publish_surge_route is now reached
--      through tp_org). Production 2026-10-07: publish_surge_route,
--      ops_command, ops_state, ops_revoke_session, increment_address_failures,
--      materialize_package_state, rls_auto_enable, touch_updated_at,
--      events_block_mutation. Trigger and event-trigger functions keep
--      firing (EXECUTE is not checked when a trigger fires). The migration
--      then checks that the ONLY public functions anon or authenticated can
--      execute are the nine tp_* entry points, and stops (changing nothing)
--      otherwise, e.g. for a function owned by another role.
--   5. Stops future tables/functions in public from being granted to anon
--      and authenticated automatically.
--   6. Makes the "pod" bucket private and drops its anonymous policies.
--      Proof of delivery is uploaded and viewed through the pod edge function.
--
-- Rollback: 20_lockdown.rollback.sql
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
declare bad text;
begin
  if to_regprocedure('public.tp_org(text,text,jsonb)') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first. Nothing was changed.';
  end if;
  if exists (select 1 from tp_sec.settings where key = 'lockdown_applied') then
    raise exception 'Migration 20 is already applied. Nothing was changed.';
  end if;
  -- The tp_* functions run as their owner. Once the policies are gone the
  -- owner must bypass RLS (owner of the tables, or a BYPASSRLS role).
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
     and c.relname in ('jobs','drivers','messages','driver_locations','driver_fcm_tokens','organizations',
                       'agent_memory','bin_bindings','events')
     and pg_get_userbyid(c.relowner) <> current_user
     and not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user);
  if bad is not null then
    raise exception 'Run this as the role that owns the tables or one with BYPASSRLS (postgres). Not owned by %: %. Nothing was changed.', current_user, bad;
  end if;
end
$pre$;

-- ── 1. BACKUP (statements that restore the current state) ────────────────
create table tp_sec.lockdown_backup (
  id        bigserial primary key,
  step      integer not null,      -- replay order
  statement text not null,
  taken_at  timestamptz not null default now()
);

-- 1a. table / view / sequence privileges of anon, authenticated, PUBLIC
insert into tp_sec.lockdown_backup (step, statement)
select 10, format('grant %s on %s %s to %s', a.privilege_type,
         case when c.relkind = 'S' then 'sequence' else 'table' end,
         c.oid::regclass, case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace,
       lateral aclexplode(c.relacl) a
 where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'));

-- 1b. column privileges
insert into tp_sec.lockdown_backup (step, statement)
select 11, format('grant %s (%I) on table %s to %s', a.privilege_type, att.attname, c.oid::regclass,
         case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
  from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace,
       lateral aclexplode(att.attacl) a
 where n.nspname = 'public' and att.attnum > 0 and not att.attisdropped and att.attacl is not null
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'));

-- 1c. function EXECUTE privileges (a NULL acl means "PUBLIC may execute").
-- Functions of extensions installed in public are included: step 4 revokes
-- on every function in the schema.
insert into tp_sec.lockdown_backup (step, statement)
select 12, format('grant execute on routine %s to %s', p.oid::regprocedure,
         case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'public' and p.prokind in ('f','p','a','w')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'));

-- 1d. RLS flags
insert into tp_sec.lockdown_backup (step, statement)
select 20, format('alter table %s %s row level security; alter table %s %s row level security',
         c.oid::regclass, case when c.relrowsecurity then 'enable' else 'disable' end,
         c.oid::regclass, case when c.relforcerowsecurity then 'force' else 'no force' end)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p');

-- 1e. policies on public tables and the pod policies on storage.objects
-- (restrictive ones are not dropped; they are recorded so the rollback can
-- tell them apart from policies created after the lockdown)
create function tp_sec.policy_sql(p pg_catalog.pg_policies) returns text
language sql stable set search_path = '' as $$
  select format('create policy %I on %I.%I as %s for %s to %s%s%s',
         p.policyname, p.schemaname, p.tablename, p.permissive, p.cmd,
         (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(p.roles) r),
         case when p.qual is not null then ' using (' || p.qual || ')' else '' end,
         case when p.with_check is not null then ' with check (' || p.with_check || ')' else '' end)
$$;
revoke all on function tp_sec.policy_sql(pg_catalog.pg_policies) from public, anon, authenticated;

insert into tp_sec.lockdown_backup (step, statement)
select 30, tp_sec.policy_sql(p)
  from pg_policies p
 where p.schemaname = 'public'
    or (p.schemaname = 'storage' and p.tablename = 'objects'
        and (coalesce(p.qual,'') || coalesce(p.with_check,'')) like '%''pod''%'
        and (p.roles && array['public','anon','authenticated']::name[]));

-- 1f. bucket flags
insert into tp_sec.lockdown_backup (step, statement)
select 40, format('update storage.buckets set public = %L where id = %L', b.public, b.id)
  from storage.buckets b where b.id = 'pod';

-- 1g. default privileges that would hand future objects to anon/authenticated
insert into tp_sec.lockdown_backup (step, statement)
select 50, format('alter default privileges for role %I%s grant %s on %s to %s',
         pg_get_userbyid(d.defaclrole),
         case when d.defaclnamespace = 0 then '' else ' in schema ' || quote_ident(n.nspname) end,
         a.privilege_type,
         case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                              when 'T' then 'types' else 'schemas' end,
         case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace,
       lateral aclexplode(d.defaclacl) a
 where (d.defaclnamespace = 0 or n.nspname = 'public')
   and pg_get_userbyid(d.defaclrole) = current_user
   and pg_get_userbyid(a.grantee) in ('anon','authenticated');

-- 1h. PostgreSQL's built-in "PUBLIC may execute new functions" default
insert into tp_sec.lockdown_backup (step, statement)
values (51, format('alter default privileges for role %I grant execute on functions to public', current_user));

-- ── 2. NO DIRECT TABLE ACCESS WITH THE PUBLIC KEY ────────────────────────
revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;

-- ── 3. RLS ON EVERYWHERE, NO POLICIES ────────────────────────────────────
do $rls$
declare t record; p record;
begin
  for t in select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','p') loop
    execute format('alter table %s enable row level security', t.rel);
  end loop;
  for p in select policyname, schemaname, tablename from pg_policies
            where schemaname = 'public' and permissive = 'PERMISSIVE' loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$rls$;

-- ── 4. FUNCTIONS: ONLY THE tp_* ENTRY POINTS ARE CALLABLE ────────────────
-- The service role (edge functions: smartsort calls increment_address_failures)
-- keeps EXECUTE wherever it had it only through PUBLIC: it gets an explicit
-- grant, recorded so the rollback takes it back.
do $svc$
declare f record;
begin
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind in ('f','p','a','w')
              and has_function_privilege('service_role', p.oid, 'EXECUTE')
              and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               where a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE') loop
    insert into tp_sec.lockdown_backup (step, statement)
    values (13, format('revoke execute on routine %s from service_role', f.fn));
    execute format('grant execute on routine %s to service_role', f.fn);
  end loop;
end
$svc$;
revoke execute on all routines in schema public from public, anon, authenticated;  -- functions, procedures, aggregates
grant execute on function public.tp_org_lookup(text), public.tp_org_sign_in(text,text), public.tp_sign_out(text),
  public.tp_org(text,text,jsonb), public.tp_driver_sign_in(text,text), public.tp_driver(text,text,jsonb),
  public.tp_customer(text,jsonb), public.tp_track(text,jsonb), public.tp_driver_signup(jsonb)
  to anon, authenticated;

-- ── 5. FUTURE OBJECTS ARE NOT AUTO-GRANTED TO THE PUBLIC KEY ─────────────
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges revoke execute on functions from public;

-- ── 6. PROOF OF DELIVERY BUCKET PRIVATE ──────────────────────────────────
update storage.buckets set public = false where id = 'pod';
do $pod$
declare p record;
begin
  for p in select policyname from pg_policies
            where schemaname = 'storage' and tablename = 'objects'
              and (coalesce(qual,'') || coalesce(with_check,'')) like '%''pod''%'
              and (roles && array['public','anon','authenticated']::name[]) loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end
$pod$;

-- ── 7. CHECK: only the tp_* entry points are callable with the public key ─
do $post$
declare extra text; missing text;
  entry constant text[] := array['tp_org_lookup(text)', 'tp_org_sign_in(text,text)', 'tp_sign_out(text)',
    'tp_org(text,text,jsonb)', 'tp_driver_sign_in(text,text)', 'tp_driver(text,text,jsonb)',
    'tp_customer(text,jsonb)', 'tp_track(text,jsonb)', 'tp_driver_signup(jsonb)'];
begin
  select string_agg(p.oid::regprocedure::text || ' (owner ' || pg_get_userbyid(p.proowner) || ')', ', ') into extra
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p','a','w')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and replace(p.oid::regprocedure::text, 'public.', '') <> all(entry);
  if extra is not null then
    raise exception 'Migration 20 stopped, nothing was changed: still executable by anon/authenticated: %. Run this as the owner of those functions (or revoke execute from them first) and send this message for review.', extra;
  end if;
  select string_agg(e, ', ') into missing from unnest(entry) e
   where not has_function_privilege('anon', ('public.' || e)::regprocedure, 'EXECUTE');
  if missing is not null then
    raise exception 'Migration 20 stopped, nothing was changed: tp_* entry points not executable by anon: %', missing;
  end if;
  -- restrictive policies are untouched
  if exists (select 1 from tp_sec.lockdown_backup b where b.step = 30 and b.statement like '% as RESTRICTIVE %'
              and b.statement not like 'create policy % on storage.%'
              and b.statement not in (select tp_sec.policy_sql(p) from pg_policies p where p.schemaname = 'public')) then
    raise exception 'Migration 20 stopped, nothing was changed: a restrictive policy was altered';
  end if;
end
$post$;

insert into tp_sec.settings values ('lockdown_applied', to_jsonb(now()));
commit;
