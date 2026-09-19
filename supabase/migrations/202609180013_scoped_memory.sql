begin;
do $$ begin
 if to_regclass('public.agent_memory') is not null then
  alter table public.agent_memory add column if not exists org_id uuid references public.organizations(id);
  alter table public.agent_memory enable row level security;
  create policy protect_operational_memory on public.agent_memory as restrictive for all to anon,authenticated using (org_id is null) with check (org_id is null);
 end if;
end $$;
commit;
