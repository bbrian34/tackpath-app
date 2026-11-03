-- Rollback of migration 70: the previous gateway comes back; agent and decision data are dropped.
-- agent_memory.org_id values filled in by 70 stay (they are correct either way).
begin;
do $pre$ begin
  if to_regclass('tp_sec.agent_actions') is null then raise exception 'Migration 70 was not applied. Nothing was changed.'; end if;
end $pre$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v69(text,text,jsonb) set schema public;
alter function public.tp_org_v69(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
drop function public.tp_svc_ops_tick(uuid, timestamptz);
drop function tp_sec.ops_tick(timestamptz, uuid);
drop function tp_sec.ops_message(uuid, text, text);
drop function tp_sec.ops_memory(uuid, text, text, uuid, text, jsonb, text);
drop function tp_sec.ops_day_start(timestamptz);
drop function tp_sec.ops_day(timestamptz);
drop function tp_sec.ops_pace(uuid, timestamptz);
drop function tp_sec.ops_delivered_at(uuid, integer);
drop function tp_sec.ops_miles(jsonb, jsonb);
drop function tp_sec.ops_stops(public.jobs);
drop table public.ops_promise;
drop table public.ops_decisions;
drop table tp_sec.stop_deadlines;
drop function tp_sec.claim(text, text, text, uuid, text);
drop table tp_sec.agent_actions;
drop trigger tp_agent_memory_org on public.agent_memory;
drop function tp_sec.agent_memory_org();
drop index if exists public.agent_memory_org_time;
delete from tp_sec.settings where key in ('server_agents', 'ops_timezone');
commit;
