begin;
alter table public.drivers enable row level security;
create policy protect_scoped_drivers on public.drivers as restrictive for all to anon,authenticated using (org_id is null) with check (org_id is null);
-- Operational messages and locations are only available through session-scoped edge reads.
do $$ declare resource text; begin
 foreach resource in array array['messages','driver_locations'] loop
  if to_regclass('public.'||resource) is not null then
   execute format('alter table public.%I enable row level security',resource);
   execute format('create policy protect_operational_data on public.%I as restrictive for all to anon,authenticated using (not public.is_operational_job(job_id)) with check (not public.is_operational_job(job_id))',resource);
  end if;
 end loop;
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('ops-pod','ops-pod',false,10485760,array['image/png','image/jpeg']) on conflict(id) do update set public=false;
 end if;
end $$;
commit;
