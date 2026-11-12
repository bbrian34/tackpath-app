-- Rollback of migration 72: the gate that was in place before 72 comes back exactly as it was
-- (saved by 72 in tp_sec.m72_saved_gate, byte for byte), the previous gateway comes back, and
-- "Needs attention" is dropped.
-- Lost on rollback: the "Needs attention" items, and the inbox files' done/result marks (the
-- files themselves stay). Routes published while 72 was in place stay as they are.
begin;
do $pre$ begin
  if to_regclass('public.dispatch_attention') is null or to_regclass('tp_sec.m72_saved_gate') is null then
    raise exception 'Migration 72 was not applied. Nothing was changed.'; end if;
end $pre$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v71(text,text,jsonb) set schema public;
alter function public.tp_org_v71(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
do $restore$ begin execute (select def from tp_sec.m72_saved_gate where id = 1); end $restore$;
drop table tp_sec.m72_saved_gate;
drop table public.dispatch_attention;
alter table public.smartsort_inbox drop column done_at, drop column result;
commit;
