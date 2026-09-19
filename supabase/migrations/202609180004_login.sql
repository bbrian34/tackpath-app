begin;
create table operations.login_attempts (key text primary key, attempts integer not null default 0, window_start timestamptz not null default now());
create table operations.challenges (id uuid primary key, org_id uuid not null references public.organizations(id), driver_id uuid not null references public.drivers(id), code_hash text not null, expires_at timestamptz not null, attempts integer not null default 0, consumed_at timestamptz);
create function public.ops_login_limit(p_key text) returns boolean language plpgsql security definer set search_path=pg_catalog,operations as $$
declare n integer;
begin
 insert into operations.login_attempts(key,attempts) values(p_key,1) on conflict(key) do update set attempts=case when operations.login_attempts.window_start<now()-interval '15 minutes' then 1 else operations.login_attempts.attempts+1 end,window_start=case when operations.login_attempts.window_start<now()-interval '15 minutes' then now() else operations.login_attempts.window_start end returning attempts into n;
 return n<=10;
end $$;
create function public.ops_login_challenge(p_id uuid,p_org uuid,p_driver uuid,p_hash text) returns void language sql security definer set search_path=pg_catalog,operations as $$
 insert into operations.challenges(id,org_id,driver_id,code_hash,expires_at) values(p_id,p_org,p_driver,p_hash,now()+interval '5 minutes');
$$;
create function public.ops_verify_challenge(p_id uuid,p_hash text,p_token_hash text) returns jsonb language plpgsql security definer set search_path=pg_catalog,operations,public as $$
declare c operations.challenges; d public.drivers;
begin
 select * into c from operations.challenges where id=p_id for update;
 if not found or c.expires_at<now() or c.consumed_at is not null or c.attempts>=5 then return jsonb_build_object('error','Invalid or expired verification'); end if;
 update operations.challenges set attempts=attempts+1 where id=p_id;
 if c.code_hash<>p_hash then return jsonb_build_object('error','Invalid verification code'); end if;
 select * into d from public.drivers where id=c.driver_id for update;
 if d.org_id is not null and d.org_id<>c.org_id then return jsonb_build_object('error','Driver belongs to a different organization'); end if;
 update public.drivers set org_id=c.org_id where id=d.id;
 update operations.challenges set consumed_at=now() where id=p_id;
 perform public.ops_create_session(c.org_id,d.id,'driver',p_token_hash);
 return jsonb_build_object('org_id',c.org_id,'actor_id',d.id,'role','driver','driver',jsonb_build_object('id',d.id,'org_id',c.org_id,'name',d.name,'phone',d.phone));
end $$;
revoke all on function public.ops_login_limit(text),public.ops_login_challenge(uuid,uuid,uuid,text),public.ops_verify_challenge(uuid,text,text) from public;
grant execute on function public.ops_login_limit(text),public.ops_login_challenge(uuid,uuid,uuid,text),public.ops_verify_challenge(uuid,text,text) to service_role;
revoke all on all tables in schema operations from public,anon,authenticated;
commit;
