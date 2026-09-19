begin;
revoke all on public.organizations from anon,authenticated;
grant select,insert,update,delete on public.organizations,public.drivers,public.jobs to service_role;
do $$ declare resource text; begin
 foreach resource in array array['messages','driver_locations','agent_memory','driver_fcm_tokens'] loop
  if to_regclass('public.'||resource) is not null then execute format('grant select,insert,update on public.%I to service_role',resource); end if;
 end loop;
end $$;
commit;
