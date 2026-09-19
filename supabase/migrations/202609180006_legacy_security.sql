begin;
-- Preserve legacy rows while preventing public clients from bypassing authoritative operations.
create function operations.is_operational_job(p_id uuid) returns boolean language sql stable security definer set search_path=pg_catalog,operations as $$ select exists(select 1 from operations.routes where id=p_id) $$;
revoke all on function operations.is_operational_job(uuid) from public;
-- Policies call a public wrapper because operations is deliberately not an exposed schema.
create function public.is_operational_job(p_id uuid) returns boolean language sql stable security definer set search_path=pg_catalog,operations as $$ select operations.is_operational_job(p_id) $$;
revoke all on function public.is_operational_job(uuid) from public;
grant execute on function public.is_operational_job(uuid) to anon,authenticated,service_role;
alter table public.jobs enable row level security;
create policy protect_operational_jobs on public.jobs as restrictive for all to anon,authenticated using (not public.is_operational_job(id)) with check (not public.is_operational_job(id));
create function operations.protect_job_projection() returns trigger language plpgsql security definer set search_path=pg_catalog,operations as $$
begin
 if exists(select 1 from operations.routes where id=old.id) then
  if tg_op='DELETE' then raise exception 'Operational history cannot be deleted'; end if;
  if current_setting('tackpath.operational_write',true) is distinct from 'on' and (to_jsonb(new)-array['exception_flag','exception_detected_at','eta_minutes','estimated_delivery_at','original_eta_at']) is distinct from (to_jsonb(old)-array['exception_flag','exception_detected_at','eta_minutes','estimated_delivery_at','original_eta_at']) then raise exception 'Use authoritative operational commands'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_operational_projection before update or delete on public.jobs for each row execute function operations.protect_job_projection();
revoke all on function operations.protect_job_projection() from public,anon,authenticated;
-- Organization access codes must never be available through public REST reads.
revoke select on public.organizations from anon,authenticated;
commit;
