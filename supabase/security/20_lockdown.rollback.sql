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
  -- remove any policy on public tables created after the lockdown, then replay
  for p in select policyname, schemaname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
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
delete from tp_sec.settings where key = 'lockdown_applied';
commit;
