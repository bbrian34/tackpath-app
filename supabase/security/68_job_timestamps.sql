-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 68 (2026-10-11): the server records WHEN a route was
-- picked up and delivered.
--
-- No app code writes jobs.picked_up_at or jobs.delivered_at
-- (tests/KNOWN_ISSUES.md). Start Route sets status 'in_transit'; the last
-- stop sets 'delivered' (or 'completed_with_exceptions'). So the
-- dispatcher's "Picked up" and "Delivered" times, its on-time result and
-- progress bar stayed empty, and the "Driver dark" timer counted from
-- created_at.
--
-- Change: one BEFORE UPDATE trigger on public.jobs,
--   status changes to 'in_transit' and picked_up_at is null
--     -> picked_up_at = now()
--   status changes to 'delivered' or 'completed_with_exceptions' and
--   delivered_at is null
--     -> delivered_at = now()
-- An existing value is never overwritten (a second update changes nothing).
-- Cancelled and other statuses get neither. INSERTs are untouched.
--
-- Additive only:
--   - no existing function, trigger or policy is changed;
--   - no gateway (tp_org, tp_driver, publish_surge_route) is replaced;
--   - the two columns are only checked, and added as nullable timestamptz
--     only if missing.
-- tp_org 'jobs' already returns every jobs column (to_jsonb(j.*)), so the
-- dispatcher reads the values with no app change.
--
-- Trigger order:
--   - BEFORE UPDATE triggers fire in name order, so this one
--     (tp_set_job_timestamps) runs after protect_operational_projection.
--     That guard still decides, on the row as sent, before anything is added.
--   - The release triggers (tp_release_spots_on_pickup,
--     tp_release_spots_on_archive, tp_free_spot_on_reset) are AFTER
--     triggers, run exactly as before, and see the final row.
--
-- Backfill: none. To count existing rows without the times, see the
-- optional query at the end (commented out; this migration does not run it).
-- Preflight stops, changing nothing, if 68 is already applied, or if a
-- column exists with a type that is not a timestamp.
-- Rollback: 68_job_timestamps.rollback.sql.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
declare
  t text;
begin
  if to_regclass('public.jobs') is null then
    raise exception 'public.jobs not found. Nothing was changed.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'tp_set_job_timestamps' and not tgisinternal)
     or to_regprocedure('tp_sec.set_job_timestamps()') is not null then
    raise exception 'Migration 68 is already applied. Nothing was changed.';
  end if;
  if to_regnamespace('tp_sec') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first (schema tp_sec). Nothing was changed.';
  end if;
  foreach t in array array['picked_up_at', 'delivered_at'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = t
                 and data_type not in ('timestamp with time zone', 'timestamp without time zone')) then
      raise exception 'public.jobs.% exists but is not a timestamp (%). Nothing was changed.', t,
        (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = t);
    end if;
  end loop;
end $pre$;

-- The two columns: checked, added only if missing (nullable, no default).
-- The comment marks a column this migration added, so the rollback removes
-- only those.
do $cols$
declare
  t text;
begin
  foreach t in array array['picked_up_at', 'delivered_at'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = t) then
      execute format('alter table public.jobs add column %I timestamptz', t);
      execute format('comment on column public.jobs.%I is %L', t, 'added by migration 68');
      raise notice 'public.jobs.% added (timestamptz, nullable)', t;
    else
      raise notice 'public.jobs.% already there (%), kept as it is', t,
        (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = t);
    end if;
  end loop;
end $cols$;

create function tp_sec.set_job_timestamps() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'in_transit' and new.picked_up_at is null then
      new.picked_up_at := now();
    elsif new.status in ('delivered', 'completed_with_exceptions') and new.delivered_at is null then
      new.delivered_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function tp_sec.set_job_timestamps() from public, anon, authenticated;

create trigger tp_set_job_timestamps
  before update of status on public.jobs
  for each row
  when (new.status is distinct from old.status
        and new.status in ('in_transit', 'delivered', 'completed_with_exceptions'))
  execute function tp_sec.set_job_timestamps();

commit;

-- ───────────────────────────────────────────────────────────────────────
-- OPTIONAL, NOT RUN BY THIS MIGRATION: how many existing routes have no
-- pickup / delivery time. Read-only; nothing is backfilled. Paste it alone
-- into the SQL Editor if you want to see the numbers.
--
-- select
--   count(*) filter (where status in ('in_transit','delivered','completed_with_exceptions') and picked_up_at is null)
--     as picked_up_or_later_without_picked_up_at,
--   count(*) filter (where status in ('delivered','completed_with_exceptions') and delivered_at is null)
--     as delivered_without_delivered_at,
--   count(*) as all_jobs
-- from public.jobs;
-- ───────────────────────────────────────────────────────────────────────
