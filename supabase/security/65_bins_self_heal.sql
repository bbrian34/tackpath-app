-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 65: bins, locations and staging spots free
-- themselves. No SQL is ever needed to free a BIN, LOC or STG spot.
--
-- Found 2026-10-10: PathIQ refused to open bins ("that bin already holds
-- another route") because bin_bindings rows were still open/ready for routes
-- that were already archived, cancelled, delivered, completed with
-- exceptions, picked up or deleted. Migrations 60, 61 and 62 release spots
-- when those events happen, but only from the moment they were applied, and
-- not for every status (closed_with_exceptions, a deleted job).
--
-- RULE: a route's BIN, LOC and STG spot are held only while the route is
-- live: status pending, assigned or routing (or any status not listed
-- below) and not archived. A binding whose route is
--     archived, cancelled, delivered, completed_with_exceptions,
--     closed_with_exceptions, in_transit, or missing (deleted / no job)
-- holds nothing.
--
-- 1. SELF-HEALING. Before PathIQ's company gateway (tp_org) checks or lists
--    held spots (bindings, open_binding, stage_binding, and the PathIQ route
--    poll: jobs with exclude_archived), tp_sec.heal_spots(company) marks
--    every binding of THAT company whose route is not live as released
--    (state 'released', released_at set; rows kept as history), in the same
--    transaction. Leftover rows from before this migration are released the
--    first time PathIQ asks (every 5 seconds while it is open). Bindings of
--    live routes are never touched; other companies are never touched; a
--    repeat finds nothing to change.
-- 2. open_binding refuses a bin that a live route of the same company
--    holds, naming it: {ok:false, error:'bin_taken', bin_code, route,
--    status, job_id}. (PathIQ checked this on the device only.)
--    bindings rows also carry job_title and job_status, so PathIQ can name
--    the holder, and stage_binding's spot_taken answer carries its status.
-- 3. TRIGGERS. The release trigger (60/61) now also fires for
--    closed_with_exceptions, and deleting a job releases its bindings first
--    (kept as history where the table keeps them).
--    Already covered: in_transit and picked_up_at (60), cancelled,
--    delivered, completed_with_exceptions and Reset Bin (61), archived (62).
--
-- tp_org is wrapped the same way as migrations 60 and 63: the gateway in
-- place (migration 63's wrapper) moves to tp_sec.tp_org_v63 (not callable
-- with the public key) and a new public.tp_org with the same name, arguments
-- and grants handles the actions above and passes everything to it. Still
-- the nine public entry points of migration 20.
--
-- Needs 60, 61, 62 and 63. Preflight stops, changing nothing, if 65 is
-- already applied or one of them is missing. Rollback:
-- 65_bins_self_heal.rollback.sql (bindings already released stay released).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_v60(text,text,jsonb)') is null then
    raise exception 'Apply 63_jobs_exclude_archived.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.free_spot_on_reset()') is null then
    raise exception 'Apply 61_staging_release_gaps.sql first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'tp_release_spots_on_archive' and tgrelid = 'public.jobs'::regclass) then
    raise exception 'Apply 62_gate_ignore_archived.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_org_v63(text,text,jsonb)') is not null or to_regprocedure('tp_sec.heal_spots(text)') is not null then
    raise exception 'Migration 65 is already applied. Nothing was changed.';
  end if;
end $pre$;

-- ── 1. a route that is not live holds nothing ──────────────────────────
create function tp_sec.route_is_live(p_job_id text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.jobs j
                  where j.id::text = p_job_id
                    and coalesce(j.archived, false) = false
                    and coalesce(j.status, '') not in
                        ('cancelled','delivered','completed_with_exceptions','closed_with_exceptions','in_transit'))
$$;
revoke all on function tp_sec.route_is_live(text) from public, anon, authenticated;

-- Release every binding of this company whose route is not live. Returns how many.
create function tp_sec.heal_spots(p_org text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with h as (
    update public.bin_bindings b set state = 'released', released_at = coalesce(b.released_at, now())
     where b.state in ('open','ready')
       and (b.job_id is null or not tp_sec.route_is_live(b.job_id::text))
       and (tp_sec.org_in_scope(p_org, b.org_id::text)
            or (b.org_id is null and exists (select 1 from public.jobs j
                 where j.id::text = b.job_id::text and tp_sec.org_in_scope(p_org, j.org_id::text))))
    returning 1)
  select count(*) into n from h;
  return n;
end $$;
revoke all on function tp_sec.heal_spots(text) from public, anon, authenticated;

-- ── 2. the gateway: heal first, then check / list ──────────────────────
alter function public.tp_org(text,text,jsonb) rename to tp_org_v63;
alter function public.tp_org_v63(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v63(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions;
  a jsonb := coalesce(p_args, '{}');
  org text;
  jid text := a->>'id';
  res jsonb;
  code text;
  holder record;
begin
  if p_action is distinct from 'bindings' and p_action is distinct from 'open_binding'
     and p_action is distinct from 'stage_binding'
     and not (p_action = 'jobs' and coalesce((a->>'exclude_archived')::boolean, false)) then
    return tp_sec.tp_org_v63(p_token, p_action, p_args);
  end if;

  s := tp_sec.session(p_token, 'org');
  org := s.org_key;
  perform tp_sec.heal_spots(org);

  if p_action = 'bindings' then
    -- as in migration 10, plus the holding route's title and status
    select coalesce(jsonb_agg(to_jsonb(b.*) || jsonb_build_object('job_title', j.title, 'job_status', j.status)), '[]') into res
      from public.bin_bindings b
      left join public.jobs j on j.id::text = b.job_id::text
     where b.state in ('open','ready')
       and (tp_sec.org_in_scope(org, b.org_id::text) or (j.id is not null and tp_sec.org_in_scope(org, j.org_id::text)))
       and (a->>'job_id' is null or b.job_id::text = a->>'job_id');
    return res;
  end if;

  if p_action = 'open_binding' then
    code := upper(btrim(coalesce(a->>'bin_code', '')));
    if code <> '' then
      select b.job_id, j.title, j.status into holder
        from public.bin_bindings b left join public.jobs j on j.id::text = b.job_id::text
       where b.state in ('open','ready') and upper(btrim(b.bin_code)) = code
         and b.job_id::text is distinct from jid
         and (tp_sec.org_in_scope(org, b.org_id::text) or (b.org_id is null and j.id is not null and tp_sec.org_in_scope(org, j.org_id::text)))
       limit 1;
      if found then
        return jsonb_build_object('ok', false, 'error', 'bin_taken', 'bin_code', code,
          'route', coalesce(holder.title, 'another route'), 'status', holder.status, 'job_id', holder.job_id);
      end if;
    end if;
    return tp_sec.tp_org_v63(p_token, p_action, p_args);
  end if;

  res := tp_sec.tp_org_v63(p_token, p_action, p_args);
  if p_action = 'stage_binding' and res->>'error' = 'spot_taken' and res ? 'job_id' then
    res := res || jsonb_build_object('status', (select j.status from public.jobs j where j.id::text = res->>'job_id'));
  end if;
  return res;
end $$;

revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

-- ── 3. triggers: every way a route moves on ────────────────────────────
drop trigger tp_release_spots_on_pickup on public.jobs;
create trigger tp_release_spots_on_pickup
  after update of status, picked_up_at on public.jobs
  for each row
  when ((new.status in ('in_transit','cancelled','delivered','completed_with_exceptions','closed_with_exceptions')
         and old.status is distinct from new.status)
        or (new.picked_up_at is not null and old.picked_up_at is null))
  execute function tp_sec.release_route_spots();

create function tp_sec.release_spots_on_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.bin_bindings b set state = 'released', released_at = now()
   where b.job_id::text = old.id::text and b.state in ('open','ready');
  return old;
end $$;
revoke all on function tp_sec.release_spots_on_delete() from public, anon, authenticated;

create trigger tp_release_spots_on_delete
  before delete on public.jobs
  for each row
  execute function tp_sec.release_spots_on_delete();

commit;
