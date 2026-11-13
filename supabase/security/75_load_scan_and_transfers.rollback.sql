-- Rollback of migration 75: the previous gateways come back; load scans, transfers, holds and the
-- exception feed are removed. Lost on rollback: load scan marks, transfer records, driver custody names
-- and Needs attention items of the kinds 75 added (their piece.* events stay). Routes created by a
-- transfer stay as routes.
begin;
do $pre$ begin
  if to_regclass('public.transfers') is null then raise exception 'Migration 75 was not applied. Nothing was changed.'; end if;
end $pre$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v74(text,text,jsonb) set schema public;
alter function public.tp_org_v74(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
drop function public.tp_driver(text,text,jsonb);
alter function tp_sec.tp_driver_v69(text,text,jsonb) set schema public;
alter function public.tp_driver_v69(text,text,jsonb) rename to tp_driver;
revoke all on function public.tp_driver(text,text,jsonb) from public;
grant execute on function public.tp_driver(text,text,jsonb) to anon, authenticated, service_role;
do $r$ begin execute (select def from tp_sec.m75_saved where name = 'sync_route_pieces'); end $r$;
drop table tp_sec.m75_saved;
drop trigger tp_load_rules on public.jobs;
drop trigger tp_attention_touch on public.dispatch_attention;
drop function tp_sec.jobs_load_rules();
drop function tp_sec.transfer_piece(public.transfers, text, text);
drop function tp_sec.finish_transfer(public.transfers, text, text);
drop function tp_sec.load_piece(public.jobs, text, text);
drop function tp_sec.load_state(uuid);
drop function tp_sec.route_required(uuid, text);
drop function tp_sec.attention_touch();
drop table public.transfers;
update public.pieces set hold = null where hold like 'keel:%';
alter table public.pieces drop column custody_driver;
alter table public.piece_assignments drop column loaded_units, drop column loaded_at, drop column loaded_by;
alter table public.jobs drop column load_override_at, drop column load_override_by, drop column load_override_note;
delete from public.dispatch_attention where kind in ('load_wrong_route', 'load_unknown', 'load_missing', 'departure_unverified', 'cant_continue', 'transfer', 'piece_on_hold');
drop index public.dispatch_attention_updated;
alter table public.dispatch_attention drop column job_id, drop column updated_at;
alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed', 'piece_conflict',
  'investigation', 'piece_lost', 'driver_pattern', 'contents_damaged'));
commit;
