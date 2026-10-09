-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 60: PathIQ staging spots, and release on driver pickup
--
-- 1. STAGING. A completed route's bin is staged at a staging spot, from a
--    STG:<code> QR (e.g. STG:S-01). bin_bindings gets two columns:
--      staging_code  the spot the bin was staged at (kept after release)
--      staged_at     when it was staged there
--    and one route per spot: a unique index over live bindings
--    (state open/ready) per company and staging_code. The company gateway
--    tp_org gets one action, stage_binding {id, staging_code}:
--      - the job must be one of the session's company's jobs
--      - its bin must be complete (state ready), otherwise nothing changes
--      - a spot that already holds another live route is refused with that
--        route's title ({ok:false, error:'spot_taken', route:...})
--      - staging the same route at the same spot again changes nothing
--      - on success: binding.staging_code/staged_at, and jobs.staged_at
--    tp_org is wrapped, not rewritten: the existing function moves to
--    tp_sec.tp_org_core (no longer callable with the public key) and a new
--    public.tp_org answers stage_binding and passes every other action to it
--    unchanged. Same name, same arguments, same grants: still the nine
--    public entry points of migration 20.
--
-- 2. RELEASE ON PICKUP. When a route goes to in_transit, or picked_up_at is
--    first set (the driver's bin scan at pickup), a trigger on public.jobs, in
--    the same transaction, sets that route's live binding(s) to state
--    'released' with released_at. That frees its BIN, its LOC and its STG spot
--    for the next manifest. Only bindings of that one job change; a second
--    pickup finds nothing live and changes nothing. Nothing is deleted: the
--    binding row keeps bin_code, location_code, staging_code and the times,
--    and the job keeps bin_label and staged_at.
--
-- Run after 10 (and 20 if applied). Preflight stops, changing nothing, if 60
-- is already applied or 10 is missing. Rollback: 60_pathiq_staging_reset.rollback.sql
-- (run it before rolling back 10 or 20).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regclass('tp_sec.sessions') is null or to_regprocedure('public.tp_org(text,text,jsonb)') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_org_core(text,text,jsonb)') is not null then
    raise exception 'Migration 60 is already applied. Nothing was changed.';
  end if;
  if to_regclass('public.bin_bindings') is null then
    raise exception 'public.bin_bindings does not exist here. Nothing was changed.';
  end if;
end $pre$;

-- ── 1a. where a bin was staged ─────────────────────────────────────────
alter table public.bin_bindings add column if not exists staging_code text;
alter table public.bin_bindings add column if not exists staged_at timestamptz;
create unique index bin_bindings_one_route_per_staging_spot
  on public.bin_bindings (org_id, staging_code)
  where staging_code is not null and state in ('open','ready');

-- ── 1b. tp_org: the existing gateway moves aside, a thin wrapper takes its place
alter function public.tp_org(text,text,jsonb) rename to tp_org_core;
alter function public.tp_org_core(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_core(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions;
  a jsonb := coalesce(p_args, '{}');
  org text;
  jid text := a->>'id';
  b public.bin_bindings;
  code text;
  other_job uuid;
  other_title text;
begin
  if p_action is distinct from 'stage_binding' then
    return tp_sec.tp_org_core(p_token, p_action, p_args);
  end if;

  -- PathIQ: stage a completed bin at a staging spot (STG:<code>)
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;
  if jid is null or not exists (select 1 from public.jobs j where j.id::text = jid and tp_sec.org_in_scope(org, j.org_id::text)) then
    raise exception 'TP_DENIED: not one of your jobs';
  end if;
  code := upper(btrim(regexp_replace(coalesce(a->>'staging_code', ''), '^(STG|STAGE|STAGING)[:[:space:]-]*', '', 'i')));
  if code = '' or length(code) > 40 then
    raise exception 'TP_INVALID: a staging code is required';
  end if;

  select * into b from public.bin_bindings bb
   where bb.job_id::text = jid and bb.state in ('open','ready')
   order by bb.opened_at desc limit 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_bin');
  end if;
  if b.state <> 'ready' then
    return jsonb_build_object('ok', false, 'error', 'not_complete', 'bin_code', b.bin_code);
  end if;
  if b.staging_code = code then
    return jsonb_build_object('ok', true, 'idempotent', true, 'staging_code', code, 'bin_code', b.bin_code);
  end if;

  select bb.job_id, j.title into other_job, other_title
    from public.bin_bindings bb left join public.jobs j on j.id::text = bb.job_id::text
   where bb.staging_code = code and bb.state in ('open','ready') and bb.id <> b.id
     and tp_sec.org_in_scope(org, coalesce(bb.org_id::text, j.org_id::text))
   limit 1;
  if other_job is not null then
    return jsonb_build_object('ok', false, 'error', 'spot_taken', 'staging_code', code,
                              'route', coalesce(other_title, 'another route'), 'job_id', other_job);
  end if;

  update public.bin_bindings set staging_code = code, staged_at = now() where id = b.id;
  perform tp_sec.update_json('public.jobs', jid, jsonb_build_object('staged_at', now()), array['staged_at']);
  return jsonb_build_object('ok', true, 'staging_code', code, 'bin_code', b.bin_code, 'location_code', b.location_code);
exception when unique_violation then   -- another device staged into this spot at the same moment
  return jsonb_build_object('ok', false, 'error', 'spot_taken', 'staging_code', code, 'route', 'another route');
end $$;

revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

-- ── 2. release a route's BIN / LOC / STG when the driver picks it up ────
create function tp_sec.release_route_spots() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.bin_bindings b set state = 'released', released_at = now()
   where b.job_id::text = new.id::text and b.state in ('open','ready');
  return null;
end $$;
revoke all on function tp_sec.release_route_spots() from public, anon, authenticated;

create trigger tp_release_spots_on_pickup
  after update of status, picked_up_at on public.jobs
  for each row
  when ((new.status = 'in_transit' and old.status is distinct from new.status)
        or (new.picked_up_at is not null and old.picked_up_at is null))
  execute function tp_sec.release_route_spots();

commit;
