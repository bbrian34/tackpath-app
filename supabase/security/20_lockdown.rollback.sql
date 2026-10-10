-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK of migration 20 (Stage A lockdown).
-- Puts back exactly the grants, policies, RLS flags, default privileges and
-- pod bucket setting recorded in tp_sec.lockdown_backup when 20 was applied.
-- Migration 10 (sessions and RPCs) stays in place and keeps working.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $chk$
begin
  if to_regclass('tp_sec.lockdown_backup') is null then
    raise exception 'Migration 20 was not applied (no tp_sec.lockdown_backup). Nothing was changed.';
  end if;
end
$chk$;

-- Default privileges: step 5 only revoked defaults held by anon/authenticated
-- (and PUBLIC's EXECUTE on new functions); the recorded statements (steps 50
-- and 51) grant back exactly those that existed, so nothing else is needed.

do $replay$
declare b record; p record;
begin
  -- Remove every policy on public tables that is not exactly as recorded
  -- before the lockdown (i.e. created or changed after it), then replay.
  -- The restrictive policies the lockdown kept (protect_scoped_drivers,
  -- protect_operational_memory) match their recorded statement and are left
  -- untouched; replaying them is skipped as duplicate_object.
  for p in select pp.policyname, pp.schemaname, pp.tablename, tp_sec.policy_sql(pp) as stmt
             from pg_policies pp where pp.schemaname = 'public' loop
    if not exists (select 1 from tp_sec.lockdown_backup where step = 30 and statement = p.stmt) then
      execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    end if;
  end loop;
  for b in select statement from tp_sec.lockdown_backup order by step, id loop
    begin
      execute b.statement;
    exception when duplicate_object then
      null;  -- e.g. a storage policy that still exists
    end;
  end loop;
end
$replay$;

drop table tp_sec.lockdown_backup;
drop function tp_sec.policy_sql(pg_catalog.pg_policies);
delete from tp_sec.settings where key = 'lockdown_applied';
commit;
