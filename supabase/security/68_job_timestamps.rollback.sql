-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — rollback of migration 68 (2026-10-11).
--
-- Removes the timestamp trigger and its function. A column that migration
-- 68 ADDED (marked 'added by migration 68') is dropped, so the table is
-- exactly as before. This loses the times recorded since then; a column that
-- was already there is kept with its values. Stops, changing nothing,
-- unless 68 is in place.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.set_job_timestamps()') is null then
    raise exception 'Migration 68 is not in place. Nothing was changed.';
  end if;
end $pre$;

drop trigger if exists tp_set_job_timestamps on public.jobs;
drop function tp_sec.set_job_timestamps();

do $cols$
declare
  t text;
begin
  foreach t in array array['picked_up_at', 'delivered_at'] loop
    if col_description('public.jobs'::regclass,
         (select attnum from pg_attribute where attrelid = 'public.jobs'::regclass and attname = t and not attisdropped)) = 'added by migration 68' then
      execute format('alter table public.jobs drop column %I', t);
      raise notice 'public.jobs.% removed (it was added by migration 68)', t;
    end if;
  end loop;
end $cols$;

commit;
