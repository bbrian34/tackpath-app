-- ═══════════════════════════════════════════════════════════════════════
-- TackPath — migration 64: the driver gateway never returns an archived job.
--
-- Clear board (dispatcher) archives jobs (archived = true) and leaves their
-- status as it was (pending, assigned, ...). tp_driver kept returning such a
-- job to the driver it was assigned to: in the job list, so the driver app
-- adopted it again as the active route, and by id, so the app's status
-- checks saw an ordinary assigned route. The app stayed on "Waiting for
-- warehouse", and reopening it brought the same screen back.
--
-- Change, for every driver session:
--   - 'jobs' (offers and the driver's own routes) leaves archived jobs out,
--     before the limit is applied;
--   - every action that names a job (job, claim, update_job, messages,
--     post_message, bin_binding) is refused for an archived job with
--         TP_DENIED: this route was removed by dispatch
--     (the same error a driver gets for a job that is not theirs, so the
--     app treats it as gone);
--   - 'location' for an archived job answers {ok:false} and stores nothing.
-- Everything else is unchanged.
--
-- tp_driver is wrapped, not rewritten (same way as migrations 60 and 63):
-- the function in place (migration 10's) moves to tp_sec.tp_driver_v10 (no
-- longer callable with the public key) and a new public.tp_driver answers
-- the cases above and passes every call to it. Same name, same arguments,
-- same grants: still the nine public entry points of migration 20.
--
-- Needs 10. Preflight stops, changing nothing, if 64 is already applied or
-- tp_driver is missing. Rollback: 64_driver_hide_archived.rollback.sql.
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $pre$
begin
  if to_regclass('tp_sec.sessions') is null or to_regprocedure('public.tp_driver(text,text,jsonb)') is null then
    raise exception 'Apply 10_sessions_and_rpcs.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('tp_sec.tp_driver_v10(text,text,jsonb)') is not null then
    raise exception 'Migration 64 is already applied. Nothing was changed.';
  end if;
end $pre$;

-- the gateway in place moves aside, a thin wrapper takes its place
alter function public.tp_driver(text,text,jsonb) rename to tp_driver_v10;
alter function public.tp_driver_v10(text,text,jsonb) set schema tp_sec;
revoke all on function tp_sec.tp_driver_v10(text,text,jsonb) from public, anon, authenticated;

create function public.tp_driver(p_token text, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s tp_sec.sessions;
  a jsonb := coalesce(p_args, '{}');
  jid text := coalesce(a->>'id', a->>'job_id');
  res jsonb;
  lim integer;
begin
  if p_action is distinct from 'jobs'
     and not (jid is not null and p_action in ('job','claim','update_job','messages','post_message','bin_binding','location')) then
    return tp_sec.tp_driver_v10(p_token, p_action, p_args);
  end if;

  s := tp_sec.session(p_token, 'driver');

  if p_action = 'jobs' then
    -- 'jobs' as in migration 10, plus: archived jobs left out before the limit
    lim := tp_sec.clamp_limit(a, 10, 50);
    select coalesce(jsonb_agg(x.r order by x.c desc), '[]') into res from (
      select to_jsonb(jj.*) as r, jj.created_at as c from public.jobs jj
       where tp_sec.driver_sees(s, jj)
         and coalesce(jj.archived, false) = false
         and (a->'statuses' is null or jj.status = any(array(select jsonb_array_elements_text(a->'statuses'))))
         and (coalesce((a->>'mine')::boolean, false) = false or jj.driver_name = s.driver_name)
         and (a->>'job_type' is null
              or (a->>'job_type' = 'not_surge' and (jj.job_type is null or jj.job_type <> 'surge'))
              or jj.job_type = a->>'job_type')
       order by jj.created_at desc limit lim) x;
    return res;
  end if;

  if exists (select 1 from public.jobs j where j.id::text = jid and coalesce(j.archived, false)) then
    if p_action = 'location' then
      return jsonb_build_object('ok', false);
    end if;
    raise exception 'TP_DENIED: this route was removed by dispatch';
  end if;
  return tp_sec.tp_driver_v10(p_token, p_action, p_args);
end $$;

revoke all on function public.tp_driver(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;

commit;
