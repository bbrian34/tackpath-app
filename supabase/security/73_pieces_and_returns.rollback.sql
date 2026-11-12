-- Rollback of migration 73: the previous gateway comes back; box records, assignments, their
-- triggers and functions are dropped.
-- Lost on rollback: the box records and assignments (the piece.* rows in public.events stay:
-- that log is append-only), and Needs attention items of kind piece_conflict.
-- Kept: routes as they are. A box received back while 73 was in place stays off its old route
-- (listed on that stop under returned_pkgs).
begin;
do $pre$ begin
  if to_regclass('public.pieces') is null then raise exception 'Migration 73 was not applied. Nothing was changed.'; end if;
end $pre$;
drop function public.tp_org(text,text,jsonb);
alter function tp_sec.tp_org_v72(text,text,jsonb) set schema public;
alter function public.tp_org_v72(text,text,jsonb) rename to tp_org;
revoke all on function public.tp_org(text,text,jsonb) from public;
grant execute on function public.tp_org(text,text,jsonb) to anon, authenticated, service_role;
drop trigger tp_sync_pieces on public.jobs;
drop trigger tp_piece_stop_reports on public.messages;
drop trigger tp_piece_stowed on public.events;
drop function tp_sec.jobs_sync_pieces();
drop function tp_sec.messages_piece_state();
drop function tp_sec.events_piece_stowed();
drop function tp_sec.sync_route_pieces(uuid);
drop function tp_sec.release_piece(uuid,text,text,text);
drop function tp_sec.piece_event(uuid,text,uuid,text,jsonb);
drop function tp_sec.route_is_live(public.jobs);
drop table public.piece_assignments;
drop table public.pieces;
delete from public.dispatch_attention where kind = 'piece_conflict';
alter table public.dispatch_attention drop constraint dispatch_attention_kind_check;
alter table public.dispatch_attention add constraint dispatch_attention_kind_check check (kind in ('piece_held', 'route_refused', 'file_failed'));
commit;
