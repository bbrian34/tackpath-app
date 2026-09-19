begin;
alter table public.drivers add column if not exists ops_disabled boolean not null default false;
create function public.ops_manage_driver(p_token text,p_driver uuid,p_name text default null,p_phone text default null,p_disabled boolean default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,operations,public as $$
declare actor operations.sessions; d public.drivers; r operations.routes;
begin
 actor:=operations.session(p_token);if actor.role<>'dispatcher' then raise exception 'Dispatcher authentication required';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor.org_id::text,0));
 select * into d from public.drivers where id=p_driver and org_id=actor.org_id for update;if not found then raise exception 'Driver not found';end if;
 if p_disabled=true and exists(select 1 from operations.routes where driver_id=d.id and status not in ('closed','cancelled')) then raise exception 'Reassign or reconcile active routes before disabling driver';end if;
 if p_name is not null and nullif(trim(p_name),'') is null then raise exception 'Driver name required';end if;
 if p_phone is not null and regexp_replace(p_phone,'[^0-9]','','g') !~ '^1?[0-9]{10}$' then raise exception 'Valid phone required';end if;
 if p_phone is not null and exists(select 1 from public.drivers where id<>d.id and org_id=actor.org_id and right(regexp_replace(phone,'[^0-9]','','g'),10)=right(regexp_replace(p_phone,'[^0-9]','','g'),10)) then raise exception 'Driver phone already registered';end if;
 update public.drivers set name=coalesce(trim(p_name),name),phone=coalesce(p_phone,phone),ops_disabled=coalesce(p_disabled,ops_disabled) where id=d.id;
 if p_disabled=true or p_phone is not null and p_phone is distinct from d.phone then update operations.sessions set revoked_at=now() where org_id=actor.org_id and actor_id=d.id;end if;
 for r in select * from operations.routes where driver_id=d.id loop perform operations.refresh_route(r.id);end loop;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function public.ops_manage_driver(text,uuid,text,text,boolean) from public;
grant execute on function public.ops_manage_driver(text,uuid,text,text,boolean) to service_role;
commit;
