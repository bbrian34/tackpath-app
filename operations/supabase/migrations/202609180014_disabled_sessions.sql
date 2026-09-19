begin;
create or replace function public.ops_create_session(p_org uuid,p_actor uuid,p_role text,p_token_hash text) returns void language plpgsql security definer set search_path=pg_catalog,operations as $$
begin
 if p_role='driver' and not exists(select 1 from public.drivers where id=p_actor and org_id=p_org and not ops_disabled) then raise exception 'Active driver membership required';end if;
 insert into operations.sessions(token_hash,org_id,actor_id,role,expires_at) values(p_token_hash,p_org,p_actor,p_role,now()+interval '12 hours');
end $$;
create or replace function operations.session(p_token text) returns operations.sessions language plpgsql security definer set search_path=pg_catalog,operations as $$
declare s operations.sessions;
begin
 select * into s from operations.sessions where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires_at>now() and revoked_at is null;
 if s.org_id is null or s.role='driver' and not exists(select 1 from public.drivers where id=s.actor_id and org_id=s.org_id and not ops_disabled) then raise exception 'Authentication required' using errcode='28000';end if;
 return s;
end $$;
commit;
