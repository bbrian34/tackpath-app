-- Rollback of migration 71: the previous gateway comes back; the inbox is dropped.
begin;
do $pre$ begin
  if to_regclass('public.smartsort_inbox') is null then raise exception 'Migration 71 was not applied. Nothing was changed.'; end if;
end $pre$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v70(text,text,jsonb) set schema public;
alter function public.tp_org_v70(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
drop table public.smartsort_inbox;
commit;
