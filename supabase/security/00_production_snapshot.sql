-- TackPath production security snapshot (READ-ONLY).
-- Paste into Supabase Dashboard -> SQL Editor -> Run. It only reads system
-- catalogs: it creates, changes and deletes nothing.
-- Result: one row per item: section | object | detail (JSON).
-- To send it back: "Export" -> "Download CSV" (or select all rows and copy).
-- It contains no row data from your tables, no secrets and no passwords:
-- organizations.access_code values are NOT read, only column names/types.
-- Keys or tokens inside function bodies or cron commands are replaced by <redacted>.
with
pub_tables as (
  select c.oid, n.nspname as schema, c.relname as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         c.reloptions, c.reltuples::bigint as est_rows, pg_get_userbyid(c.relowner) as owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','storage','operations') and c.relkind in ('r','p','v','m','f')
),
fn as (
  select p.oid, n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','operations')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select * from (
  -- 1. Every table/view: RLS on/off, forced, owner, view options, estimated rows
  select '1_table' as section, schema||'.'||name as object,
    jsonb_build_object(
      'kind', case relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview' else 'foreign' end,
      'rls_enabled', relrowsecurity, 'rls_forced', relforcerowsecurity,
      'owner', owner, 'options', reloptions, 'est_rows', est_rows) as detail
  from pub_tables
  union all
  -- 2. Columns of public tables (names, types, defaults; no data)
  select '2_columns', t.schema||'.'||t.name,
    (select jsonb_agg(jsonb_build_object('col', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
              'not_null', a.attnotnull, 'default', pg_get_expr(ad.adbin, ad.adrelid)) order by a.attnum)
       from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped)
  from pub_tables t where t.schema = 'public'
  union all
  -- 3. Every RLS policy (public + storage)
  select '3_policy', schemaname||'.'||tablename||' :: '||policyname,
    jsonb_build_object('permissive', permissive, 'roles', roles, 'cmd', cmd, 'using', qual, 'with_check', with_check)
  from pg_policies where schemaname in ('public','storage','operations')
  union all
  -- 4. Table privileges held by anon / authenticated / PUBLIC
  select '4_table_grant', table_schema||'.'||table_name,
    jsonb_object_agg(grantee, privs)
  from (select table_schema, table_name, grantee, jsonb_agg(privilege_type order by privilege_type) as privs
          from information_schema.role_table_grants
         where grantee in ('anon','authenticated','PUBLIC') and table_schema in ('public','storage','operations')
         group by 1,2,3) g
  group by 1,2
  union all
  -- 5. Column-level privileges for anon / authenticated (only where granted per column)
  select '5_column_grant', table_schema||'.'||table_name||' :: '||grantee||' '||privilege_type,
    jsonb_agg(column_name order by column_name)
  from information_schema.column_privileges cp
  where grantee in ('anon','authenticated') and table_schema in ('public','storage','operations')
    and not exists (select 1 from information_schema.role_table_grants tg
                     where tg.grantee = cp.grantee and tg.table_schema = cp.table_schema
                       and tg.table_name = cp.table_name and tg.privilege_type = cp.privilege_type)
  group by 1,2
  union all
  -- 6. Functions: security definer flag, settings, who may execute, full definition
  select '6_function', f.schema||'.'||f.name||'('||f.args||')',
    jsonb_build_object(
      'security_definer', p.prosecdef, 'volatility', p.provolatile, 'owner', pg_get_userbyid(p.proowner),
      'config', p.proconfig, 'returns', pg_get_function_result(p.oid),
      'exec_anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'exec_authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'acl', p.proacl::text,
      'definition', case when p.prokind in ('f','p') then regexp_replace(pg_get_functiondef(p.oid), '(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|sb_secret_[A-Za-z0-9_-]+|AC[0-9a-f]{32}|AIza[0-9A-Za-z_-]{35})', '<redacted>', 'g') end)
  from fn f join pg_proc p on p.oid = f.oid
  union all
  -- 7. Triggers on public/storage tables
  select '7_trigger', n.nspname||'.'||c.relname||' :: '||t.tgname,
    jsonb_build_object('enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public','storage','operations')
  union all
  -- 8. Storage buckets (public flag, limits)
  select '8_bucket', b.id::text,
    jsonb_build_object('public', b.public, 'file_size_limit', b.file_size_limit, 'allowed_mime_types', b.allowed_mime_types)
  from storage.buckets b
  union all
  -- 9. Default privileges that auto-grant future tables/functions
  select '9_default_acl', coalesce(n.nspname, '(all schemas)')||' :: '||pg_get_userbyid(d.defaclrole)||' :: '||d.defaclobjtype::text,
    to_jsonb(d.defaclacl::text)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  -- 10. Schemas exposed through the REST API, installed extensions, realtime tables
  select '10_api_schemas', r.rolname, to_jsonb(r.rolconfig) from pg_roles r where r.rolname = 'authenticator'
  union all
  select '10_extension', e.extname, to_jsonb(e.extversion) from pg_extension e
  union all
  select '10_realtime_table', pt.pubname||' :: '||pt.schemaname||'.'||pt.tablename, '{}'::jsonb from pg_publication_tables pt
  union all
  -- 11. Schema-level USAGE for anon / authenticated
  select '11_schema_usage', n.nspname,
    jsonb_build_object('anon', has_schema_privilege('anon', n.oid, 'USAGE'),
                       'authenticated', has_schema_privilege('authenticated', n.oid, 'USAGE'))
  from pg_namespace n where n.nspname in ('public','storage','operations','graphql_public')
  union all
  -- 12. Which repo migrations were applied (if the CLI history table exists) and scheduled jobs (pg_cron)
  select '12_migrations', 'supabase_migrations.schema_migrations',
    case when to_regclass('supabase_migrations.schema_migrations') is not null
         then to_jsonb(query_to_xml('select version, name from supabase_migrations.schema_migrations order by version', false, false, '')::text)
         else to_jsonb('table not present'::text) end
  union all
  select '12_cron', 'cron.job',
    case when to_regclass('cron.job') is not null
         then to_jsonb(regexp_replace(query_to_xml('select jobname, schedule, command from cron.job', false, false, '')::text, '(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|sb_secret_[A-Za-z0-9_-]+|AC[0-9a-f]{32}|AIza[0-9A-Za-z_-]{35})', '<redacted>', 'g'))
         else to_jsonb('pg_cron not installed'::text) end
) s
order by section, object;
