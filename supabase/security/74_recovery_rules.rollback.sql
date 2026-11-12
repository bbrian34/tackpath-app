-- Rollback of migration 74: the previous gateway comes back; the recovery rules, investigations and
-- driver patterns are removed. Lost on rollback: the avoid-driver marks and open investigations on
-- boxes (their piece.* events stay), and Needs attention items of the kinds 74 added.
begin;
do $pre$ begin
  if to_regprocedure('tp_sec.piece_tick_once(timestamptz)') is null then raise exception 'Migration 74 was not applied. Nothing was changed.'; end if;
end $pre$;
do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'tp-piece-tick'$q$;
  end if;
end $cron$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v73(text,text,jsonb) set schema public;
alter function public.tp_org_v73(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
drop trigger tp_recovery_rules on public.jobs;
drop function public.tp_svc_piece_tick(timestamptz);
drop function tp_sec.piece_tick_once(timestamptz);
drop function tp_sec.driver_pattern_rows(uuid, int, timestamptz);
drop function tp_sec.jobs_recovery_rules();
drop function tp_sec.route_closed(public.jobs);
-- custody "lost" stays a valid custody of 73; holds rebox / contents_damaged stay readable text
alter table public.pieces drop column avoid_driver, drop column avoid_driver_name, drop column investigation_opened_at,
  drop column investigation_reason, drop column investigation_level;
delete from public.dispatch_attention where kind in ('investigation', 'piece_lost', 'driver_pattern', 'contents_damaged');
alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed', 'piece_conflict'));
commit;
