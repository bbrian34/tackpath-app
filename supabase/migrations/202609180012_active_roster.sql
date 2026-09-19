begin;
create or replace function public.ops_state(p_token text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,operations,public as $$
declare actor operations.sessions; result jsonb;
begin
 actor:=operations.session(p_token);
 select jsonb_build_object(
 'organization',jsonb_build_object('id',actor.org_id),'actor_id',actor.actor_id,'role',actor.role,
 'warehouses',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from operations.warehouses w where org_id=actor.org_id),
 'bins',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('route_id',(select route_id from operations.bin_reservations where bin_id=b.id and released_at is null),'present',(select count(*) from operations.packages where bin_id=b.id))),'[]') from operations.bins b where org_id=actor.org_id),
 'drivers',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'phone',d.phone,'disabled',d.ops_disabled)),'[]') from public.drivers d where d.org_id=actor.org_id and not d.ops_disabled and (actor.role<>'driver' or d.id=actor.actor_id)),
 'routes',(select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('job',to_jsonb(j))),'[]') from operations.routes r join public.jobs j on j.id=r.id where r.org_id=actor.org_id and (actor.role<>'driver' or r.driver_id=actor.actor_id or r.status='planned')),
 'stops',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from operations.stops s join operations.routes r on r.id=s.route_id where s.org_id=actor.org_id and (actor.role<>'driver' or r.driver_id=actor.actor_id)),
 'packages',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('barcode','TPP-'||upper(p.id::text),'aliases',(select coalesce(jsonb_agg(value),'[]') from operations.package_aliases a where a.package_id=p.id))),'[]') from operations.packages p where p.org_id=actor.org_id and (actor.role<>'driver' or exists(select 1 from operations.routes r where r.id=p.route_id and r.driver_id=actor.actor_id))),
 'manifests',(select coalesce(jsonb_agg(to_jsonb(m)),'[]') from operations.manifests m where org_id=actor.org_id and actor.role<>'driver'),
 'rows',(select coalesce(jsonb_agg(to_jsonb(mr)),'[]') from operations.manifest_rows mr where org_id=actor.org_id and actor.role<>'driver'),
 'deliveries',(select coalesce(jsonb_agg(to_jsonb(d)),'[]') from operations.deliveries d where org_id=actor.org_id and (actor.role<>'driver' or driver_id=actor.actor_id)),
 'proofs',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from operations.proofs p where org_id=actor.org_id and (actor.role<>'driver' or driver_id=actor.actor_id)),
 'accounting',(select jsonb_build_object('expected',(select coalesce(sum(expected_pieces),0) from operations.manifests where org_id=actor.org_id),'recorded',count(*),'delivered',count(*) filter(where state='delivered'),'returned_or_held',count(*) filter(where state in ('held','returned')),'exceptions',count(*) filter(where state not in ('delivered','held','returned') and exception_code is not null),'active',count(*) filter(where state not in ('delivered','held','returned') and exception_code is null),'unknown_quantity_rows',(select count(*) from operations.manifest_rows where org_id=actor.org_id and expected_pieces is null)) from operations.packages where org_id=actor.org_id)
 ) into result;
 return result;
end $$;
create or replace function public.ops_create_session(p_org uuid,p_actor uuid,p_role text,p_token_hash text) returns void
language plpgsql security definer set search_path=pg_catalog,operations as $$
begin
 if p_role='driver' and not exists(select 1 from public.drivers where id=p_actor and org_id=p_org) then raise exception 'Driver membership required'; end if;
 insert into operations.sessions(token_hash,org_id,actor_id,role,expires_at) values(p_token_hash,p_org,p_actor,p_role,now()+interval '12 hours');
end $$;
create or replace function public.ops_proof_uploaded(p_token text,p_proof uuid,p_hash text) returns void
language plpgsql security definer set search_path=pg_catalog,operations as $$
declare actor operations.sessions; p operations.proofs;
begin
 actor:=operations.session(p_token);
 select * into p from operations.proofs where id=p_proof and org_id=actor.org_id and driver_id=actor.actor_id for update;
 if not found or p.content_hash<>p_hash then raise exception 'Proof identity mismatch'; end if;
 -- The edge upload handler verifies bytes and storage success before calling this service-only RPC.
 update operations.proofs set uploaded_at=coalesce(uploaded_at,now()) where id=p.id;
end $$;
create or replace function public.ops_revoke_session(p_token text) returns void
language plpgsql security definer set search_path=pg_catalog,operations as $$
begin update operations.sessions set revoked_at=now() where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex'); end $$;
revoke all on function public.ops_state(text),public.ops_revoke_session(text),public.ops_create_session(uuid,uuid,text,text),public.ops_proof_uploaded(text,uuid,text) from public;
grant execute on function public.ops_state(text),public.ops_revoke_session(text) to anon,authenticated,service_role;
grant execute on function public.ops_create_session(uuid,uuid,text,text),public.ops_proof_uploaded(text,uuid,text) to service_role;
commit;
