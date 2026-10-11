-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 67: the driver sees where the route is STAGED (STG),
-- never where it was stowed (LOC).
--
-- tp_driver 'bin_binding' returned {bin_code, location_code, state}: the
-- driver app showed "Pickup BIN 1 Location A-01", A-01 being the LOC the
-- PathIQ worker used while stowing. The driver needs the staging spot the
-- worker scanned (STG, bin_bindings.staging_code, migration 60) and must
-- never see the stow location.
--
-- Change, 'bin_binding' only: it answers, for the driver's own route,
--     [{bin_code, state, staging_code}]      -- staging_code null = not staged yet
-- with no location_code. The same checks as before apply first (the call
-- goes through the gateway in place: a driver session, the job must be the
-- driver's own or an open offer, not archived (64)), and only bindings of
-- that job and of the job's own company are returned. Every other action
-- is unchanged.
--
-- Wrapped like migrations 60, 63, 64: the gateway in place (64's wrapper)
-- moves to tp_sec.tp_driver_v64 (not callable with the public key); a new
-- public.tp_driver with the same name, arguments and grants answers
-- 'bin_binding' and passes everything to it. Still the nine public entry
-- points of migration 20. Only adds driver-visible data (the STG spot) and
-- removes the LOC from the driver's answer; nothing else.
--
-- Needs 60 (staging_code) and 64. Preflight stops, changing nothing, if 67
-- is already applied or one of them is missing.
-- Rollback: 67_driver_staging_spot.rollback.sql.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_driver_v10(text,text,jsonb)') is null or to_regprocedure('public.tp_driver(text,text,jsonb)') is null then
    raise exception 'Apply 64_driver_hide_archived.sql first. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bin_bindings' and column_name = 'staging_code') then
    raise exception 'Apply 60_pathiq_staging_reset.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_driver_v64(text,text,jsonb)') is not null then
    raise exception 'Migration 67 is already applied. Nothing was changed.';
  end if;
end $pre$;

alter function public.tp_driver(text,text,jsonb) rename to tp_driver_v64;
alter function public.tp_driver_v64(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_driver_v64(text,text,jsonb) from public, anon, authenticated;

create function public.tp_driver(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(p_args, '{}');
  jid text := coalesce(a->>'id', a->>'job_id');
  res jsonb;
begin
  if p_action is distinct from 'bin_binding' then
    return tp_sec.tp_driver_v64(p_token, p_action, p_args);
  end if;
  -- the gateway in place decides whether this driver may see this job
  -- (session, own route or open offer, not archived); it raises otherwise
  perform tp_sec.tp_driver_v64(p_token, p_action, p_args);
  select coalesce(jsonb_agg(jsonb_build_object('bin_code', b.bin_code, 'state', b.state,
                                               'staging_code', b.staging_code)), '[]') into res
    from public.bin_bindings b
    join public.jobs j on j.id::text = b.job_id::text
   where b.job_id::text = jid
     and b.state in ('open','ready')
     and (b.org_id is null or b.org_id::text = j.org_id::text);
  return res;
end $$;

revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

commit;
