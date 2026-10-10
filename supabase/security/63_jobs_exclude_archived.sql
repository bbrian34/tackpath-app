-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 63: the company gateway can leave out archived
-- routes when listing jobs.
--
-- PathIQ lists open routes (pending / assigned / in_transit) through
-- tp_org 'jobs'. A route archived with Clear board keeps its status, so it
-- was still listed, and PathIQ asked for the 50 oldest: once a company had
-- 50 archived routes, a newly uploaded manifest never reached Stow. Found
-- 2026-10-10: a manifest showed in Dispatcher and for drivers, not in Stow.
--
-- Change: tp_org 'jobs' takes one more optional argument,
--     exclude_archived: true   -> routes with archived = true are left out
--                                 before the limit is applied
-- Without it, 'jobs' answers exactly as before (every other caller is
-- unchanged). Every other action passes through unchanged.
--
-- tp_org is wrapped the same way as migration 60: the gateway in place
-- (migration 60's wrapper) moves to tp_sec.tp_org_v60 (not callable with the
-- public key) and a new public.tp_org answers 'jobs' with exclude_archived
-- and passes everything else to it. Same name, same arguments, same grants:
-- still the nine public entry points of migration 20.
--
-- PathIQ (stow.html) already drops archived routes on the device, so it
-- works with or without this migration; 63 makes the server do it so the
-- limit only counts routes on the board.
--
-- Needs 60. Preflight stops, changing nothing, if 63 is already applied or 60
-- is missing. Rollback: 63_jobs_exclude_archived.rollback.sql (run it before
-- rolling back 60).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regprocedure('tp_sec.tp_org_core(text,text,jsonb)') is null or to_regprocedure('public.tp_org(text,text,jsonb)') is null then
    raise exception 'Apply 60_pathiq_staging_reset.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_org_v60(text,text,jsonb)') is not null then
    raise exception 'Migration 63 is already applied. Nothing was changed.';
  end if;
end $pre$;

-- the gateway in place moves aside, a thin wrapper takes its place
alter function public.tp_org(text,text,jsonb) rename to tp_org_v60;
alter function public.tp_org_v60(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_org_v60(text,text,jsonb) from public, anon, authenticated;

create function public.tp_org(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions;
  a jsonb := coalesce(p_args, '{}');
  org text;
  res jsonb;
  lim integer;
begin
  if p_action is distinct from 'jobs' or coalesce((a->>'exclude_archived')::boolean, false) = false then
    return tp_sec.tp_org_v60(p_token, p_action, p_args);
  end if;

  -- 'jobs' as in migration 10, plus: archived routes left out before the limit
  s := tp_sec.session(p_token, 'org');
  org := s.org_key;
  lim := tp_sec.clamp_limit(a, 1000, 2000);
  select coalesce(jsonb_agg(x.j order by x.c desc), '[]') into res from (
    select to_jsonb(j.*) as j, j.created_at as c from public.jobs j
     where tp_sec.org_in_scope(org, j.org_id::text)
       and coalesce(j.archived, false) = false
       and (a->>'since' is null or j.created_at >= (a->>'since')::timestamptz)
       and (a->'statuses' is null or j.status = any(array(select jsonb_array_elements_text(a->'statuses'))))
       and (a->'ids' is null or j.id::text = any(array(select jsonb_array_elements_text(a->'ids'))))
       and (a->>'source' is null or to_jsonb(j.*)->>'source' = a->>'source')
       and (coalesce((a->>'unbinned')::boolean, false) = false or j.bin_label is null)
     order by case when a->>'order' = 'asc' then j.created_at end asc,
              case when coalesce(a->>'order','desc') <> 'asc' then j.created_at end desc
     limit lim) x;
  if a->>'order' = 'asc' then
    select coalesce(jsonb_agg(e order by (e->>'created_at')::timestamptz), '[]') into res from jsonb_array_elements(res) e;
  end if;
  return res;
end $$;

revoke all on function public.tp_org(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;

commit;
