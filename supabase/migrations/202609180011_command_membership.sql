begin;


create or replace function operations.refresh_route(p_route uuid) returns void
language plpgsql security definer set search_path=pg_catalog,operations,public as $$
declare r operations.routes; ready boolean; unresolved integer; delivery_count integer; bin_label_value text; projection jsonb; final_status text;
begin
 perform set_config('tackpath.operational_write','on',true);
 select * into strict r from operations.routes where id=p_route for update;
 select not exists(select 1 from operations.packages p join operations.stops s on s.id=p.stop_id where p.route_id=r.id and s.status='pending' and (p.state not in ('stowed','loaded','out_for_delivery','delivered') or p.exception_code is not null)) into ready;
 select count(*) into unresolved from operations.stops where route_id=r.id and status='pending';
 select count(*) into delivery_count from operations.stops where route_id=r.id and status='delivered';
 if ready and exists(select 1 from operations.stops where route_id=r.id and status='pending') then
  update operations.routes set staged_at=coalesce(staged_at,now()) where id=r.id;
 else
  update operations.routes set staged_at=null where id=r.id and status not in ('in_transit','closed');
 end if;
 if unresolved=0 then
  if exists(select 1 from operations.packages where route_id=r.id and custody='driver') then
   update operations.routes set status='reconciling' where id=r.id;
  else
   update operations.routes set status='closed',closed_at=coalesce(closed_at,now()) where id=r.id;
  end if;
 end if;
 -- Release only after physical contents and outstanding placement obligations are gone.
 update operations.bin_reservations b set released_at=now() where b.route_id=r.id and b.released_at is null
 and not exists(select 1 from operations.packages p where p.bin_id=b.bin_id)
 and not exists(select 1 from operations.packages p where p.route_id=r.id and p.state in ('allocated','stowed'));
 select b.label into bin_label_value from operations.bin_reservations br join operations.bins b on b.id=br.bin_id where br.route_id=r.id and br.released_at is null;
 select coalesce(jsonb_agg(jsonb_build_object('stop_id',s.id,'stop_number',s.sequence,'recipient',s.recipient,'address',s.address,'coords',case when s.lat is null then null else jsonb_build_object('lat',s.lat,'lng',s.lng) end,'status',s.status,'cancelled',s.status='cancelled','packages',(select count(*) from operations.packages p where p.stop_id=s.id),'package_ids',(select jsonb_agg(p.id order by p.piece_number) from operations.packages p where p.stop_id=s.id),'order_id',(select min(p.order_id) from operations.packages p where p.stop_id=s.id)) order by s.sequence),'[]'::jsonb) into projection from operations.stops s where s.route_id=r.id;
 select * into r from operations.routes where id=r.id;
 final_status:=case r.status when 'planned' then 'pending' when 'closed' then case when exists(select 1 from operations.stops where route_id=r.id and status='cancelled') then 'closed_with_exceptions' else 'delivered' end else r.status end;
 update public.jobs set status=final_status,assigned_driver_id=r.driver_id,driver_name=(select name from public.drivers where id=r.driver_id),
 surge_stops=projection,bin_label=bin_label_value,stops_completed=delivery_count,total_stops=jsonb_array_length(projection),
 total_packages=(select count(*) from operations.packages where route_id=r.id),staged_at=r.staged_at,started_at=r.started_at,picked_up_at=r.started_at,
 delivered_at=case when final_status='delivered' then r.closed_at else null end where id=r.id;
end $$;
create or replace function public.ops_command(p_token text,p_id uuid,p_kind text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,operations,public as $$
declare
 actor operations.sessions; cached operations.commands; output jsonb:='{}';
 m operations.manifests; mr operations.manifest_rows; r operations.routes; st operations.stops; pkg operations.packages; bin operations.bins; proof operations.proofs;
 item jsonb; plan jsonb; stop_plan jsonb; geocode jsonb; row_uuid uuid; package_uuid uuid; route_uuid uuid; stop_uuid uuid; warehouse_uuid uuid; target_driver uuid;
 n integer; piece integer; total integer:=0; found_count integer; alias_value text; ns text; code text; err text; route_version integer;
begin
 actor:=operations.session(p_token);
 perform pg_advisory_xact_lock(hashtextextended(actor.org_id::text,0));
 select * into cached from operations.commands where org_id=actor.org_id and id=p_id;
 if found then
  if cached.actor_id<>actor.actor_id or cached.kind<>p_kind or cached.payload<>p_payload then raise exception 'Idempotency key reused for a different operation'; end if;
  return cached.result;
 end if;
 if actor.role='driver' and p_kind not in ('claim','load','start','proof_prepare','deliver','return_package','location') then raise exception 'Operation not permitted for driver'; end if;
 if actor.role='warehouse' and p_kind not in ('stow','receive','hold','return_package','reserve_bin','release_bin','intake','geocode','publish','correct_address') then raise exception 'Operation not permitted for warehouse'; end if;
 if p_kind in ('claim','load','start','proof_prepare','deliver') and actor.role<>'driver' then raise exception 'Driver authentication required'; end if;
 if p_payload ? 'route_id' then
  select * into r from operations.routes where id=(p_payload->>'route_id')::uuid and org_id=actor.org_id for update;
  if not found then raise exception 'Route not found'; end if;
  if actor.role='driver' and p_kind<>'claim' and (r.driver_id is distinct from actor.actor_id or (p_payload->>'version')::integer is distinct from r.version) then raise exception 'Assignment changed; refresh route'; end if;
 end if;
 case p_kind
 when 'register_driver' then
  if nullif(trim(p_payload->>'name'),'') is null or regexp_replace(coalesce(p_payload->>'phone',''),'[^0-9]','','g') !~ '^1?[0-9]{10}$' then raise exception 'Driver name and valid phone required'; end if;
  if exists(select 1 from public.drivers where org_id=actor.org_id and right(regexp_replace(phone,'[^0-9]','','g'),10)=right(regexp_replace(p_payload->>'phone','[^0-9]','','g'),10)) then raise exception 'Driver phone is already registered'; end if;
  insert into public.drivers(id,org_id,name,phone) values(gen_random_uuid(),actor.org_id,trim(p_payload->>'name'),p_payload->>'phone') returning id into target_driver;
  output:=jsonb_build_object('driver_id',target_driver);
 when 'correct_address' then
  select * into mr from operations.manifest_rows where id=(p_payload->>'row_id')::uuid and org_id=actor.org_id for update;
  if not found or exists(select 1 from operations.packages where row_id=mr.id and route_id is not null) then raise exception 'Only unrouted rows can be corrected'; end if;
  if nullif(trim(p_payload->>'address'),'') is null or mr.error is not null and mr.error<>'missing_address' then raise exception 'Address correction cannot resolve other row validation errors'; end if;
  update operations.manifest_rows set raw=raw||jsonb_build_object('address',trim(p_payload->>'address')),error=null where id=mr.id;
  update operations.packages set exception_code='awaiting_geocode',exception_detail=null,state='manifested' where row_id=mr.id and exception_code in ('missing_address','geocode_failed','awaiting_geocode');
 when 'warehouse' then
  if nullif(trim(p_payload->>'name'),'') is null or nullif(trim(p_payload->>'address'),'') is null then raise exception 'Warehouse name and physical pickup address required'; end if;
  insert into operations.warehouses(org_id,name,address) values(actor.org_id,p_payload->>'name',p_payload->>'address') returning id into warehouse_uuid;
  output:=jsonb_build_object('warehouse_id',warehouse_uuid);
 when 'bin' then
  insert into operations.bins(org_id,warehouse_id,label) values(actor.org_id,(p_payload->>'warehouse_id')::uuid,upper(trim(p_payload->>'label')))
  on conflict(org_id,warehouse_id,label) do update set enabled=true returning id into package_uuid;
  output:=jsonb_build_object('bin_id',package_uuid);
 when 'intake' then
  select * into m from operations.manifests where org_id=actor.org_id and source=p_payload->>'source' and external_id=p_payload->>'external_id';
  if found then
   if m.content_hash<>p_payload->>'content_hash' then raise exception 'Manifest identity already exists with different content'; end if;
   output:=jsonb_build_object('manifest_id',m.id,'duplicate',true);
  else
   warehouse_uuid:=(p_payload->>'warehouse_id')::uuid;
   insert into operations.manifests(org_id,warehouse_id,source,external_id,content_hash,raw_text,expected_pieces)
   values(actor.org_id,warehouse_uuid,p_payload->>'source',p_payload->>'external_id',p_payload->>'content_hash',p_payload->>'raw_text',0) returning * into m;
   for item in select value from jsonb_array_elements(p_payload->'rows') loop
    n:=case when (item->>'packages') ~ '^[1-9][0-9]{0,4}$' then (item->>'packages')::integer else null end;
    err:=nullif(item->>'error','');
    if n is null then err:=concat_ws('; ',err,'invalid_quantity'); end if;
    if nullif(trim(item->>'address'),'') is null then err:=concat_ws('; ',err,'missing_address'); end if;
    insert into operations.manifest_rows(org_id,manifest_id,row_number,raw,expected_pieces,error)
    values(actor.org_id,m.id,(item->>'row_number')::integer,item,n,err) returning id into row_uuid;
    if n is null then continue; end if;
    total:=total+n;
    for piece in 1..n loop
     insert into operations.packages(org_id,manifest_id,row_id,piece_number,order_id,tracking_number,exception_code)
     values(actor.org_id,m.id,row_uuid,piece,nullif(item->>'order_id',''),case when n=1 then nullif(item->>'tracking_number','') else nullif(item->'piece_tracking'->>(piece-1),'') end,coalesce(err,'awaiting_geocode')) returning id into package_uuid;
     insert into operations.package_aliases values(actor.org_id,'tackpath','TPP-'||upper(package_uuid::text),package_uuid);
     for ns,alias_value in select 'tracking',case when n=1 then item->>'tracking_number' else item->'piece_tracking'->>(piece-1) end union all select 'order',case when n=1 and coalesce((item->>'order_alias')::boolean,true) then item->>'order_id' else null end loop
      alias_value:=upper(trim(alias_value));
      if coalesce(alias_value,'')<>'' then
       insert into operations.package_aliases values(actor.org_id,ns,alias_value,package_uuid) on conflict do nothing;
       if not found then update operations.packages set exception_code='identity_conflict',exception_detail=ns||':'||alias_value where id=package_uuid; end if;
      end if;
     end loop;
    end loop;
   end loop;
   update operations.manifests set expected_pieces=total,status='processing' where id=m.id;
   output:=jsonb_build_object('manifest_id',m.id,'expected_pieces',total,'duplicate',false);
  end if;
 when 'geocode' then
  select * into mr from operations.manifest_rows where id=(p_payload->>'row_id')::uuid and org_id=actor.org_id;
  if not found then raise exception 'Manifest row not found'; end if;
  if p_payload->>'lat' is not null and p_payload->>'lng' is not null and (p_payload->>'lat')::double precision between -90 and 90 and (p_payload->>'lng')::double precision between -180 and 180 then
   update operations.manifest_rows set raw=raw||jsonb_build_object('coords',jsonb_build_object('lat',(p_payload->>'lat')::double precision,'lng',(p_payload->>'lng')::double precision),'geocode_provider',p_payload->>'provider','geocode_precision',p_payload->>'precision'),error=null where id=mr.id and error is null;
   update operations.packages set state='routable',exception_code=null,exception_detail=null where row_id=mr.id and route_id is null and exception_code in ('awaiting_geocode','geocode_failed');
  else
   update operations.packages set state='geocode_failed',exception_code='geocode_failed',exception_detail=coalesce(p_payload->>'error','Address could not be located') where row_id=mr.id and route_id is null and exception_code in ('awaiting_geocode','geocode_failed');
  end if;
  output:=jsonb_build_object('row_id',mr.id);
 when 'publish' then
  select * into m from operations.manifests where id=(p_payload->>'manifest_id')::uuid and org_id=actor.org_id for update;
  if not found then raise exception 'Manifest not found'; end if;
  for plan in select value from jsonb_array_elements(p_payload->'routes') loop
   select * into r from operations.routes where manifest_id=m.id and plan_key=plan->>'key';
   if found then continue; end if;
   route_uuid:=gen_random_uuid();
   insert into public.jobs(id,org_id,title,status,job_type,pickup_address,master_code) values(route_uuid,actor.org_id,'Route '||left(route_uuid::text,8),'pending','surge',(select address from operations.warehouses where id=m.warehouse_id),'TPR-'||route_uuid::text);
   insert into operations.routes(id,org_id,manifest_id,warehouse_id,plan_key) values(route_uuid,actor.org_id,m.id,m.warehouse_id,plan->>'key');
   n:=0;
   for stop_plan in select value from jsonb_array_elements(plan->'rows') loop
    select * into mr from operations.manifest_rows where id=(stop_plan#>>'{}')::uuid and manifest_id=m.id;
    if not found or mr.error is not null or not exists(select 1 from operations.packages where row_id=mr.id and route_id is null and state='routable' and exception_code is null) then raise exception 'Row not publishable'; end if;
    if exists(select 1 from operations.packages where row_id=mr.id and (route_id is not null or exception_code is not null)) then raise exception 'All pieces on a stop must be accounted before publication'; end if;
    n:=n+1;
    insert into operations.stops(org_id,route_id,sequence,recipient,address,lat,lng) values(actor.org_id,route_uuid,n,coalesce(mr.raw->>'recipient',''),mr.raw->>'address',(mr.raw->'coords'->>'lat')::double precision,(mr.raw->'coords'->>'lng')::double precision) returning id into stop_uuid;
    update operations.packages set route_id=route_uuid,stop_id=stop_uuid,state='allocated',exception_code='awaiting_bin' where row_id=mr.id;
   end loop;
   if n=0 then raise exception 'Empty route cannot be published'; end if;
   select b.* into bin from operations.bins b where b.org_id=actor.org_id and b.warehouse_id=m.warehouse_id and b.enabled and not exists(select 1 from operations.bin_reservations br where br.bin_id=b.id and br.released_at is null) and not exists(select 1 from operations.packages p where p.bin_id=b.id) order by b.label,b.id limit 1 for update;
   if found then
    insert into operations.bin_reservations(org_id,bin_id,route_id) values(actor.org_id,bin.id,route_uuid);
    update operations.packages set exception_code='awaiting_stow' where route_id=route_uuid;
   end if;
   perform operations.refresh_route(route_uuid);
  end loop;
  update operations.manifests set status=case when exists(select 1 from operations.packages where manifest_id=m.id and route_id is null) or exists(select 1 from operations.manifest_rows where manifest_id=m.id and error is not null) then 'exceptions' else 'published' end where id=m.id;
  output:=jsonb_build_object('manifest_id',m.id);
 when 'reserve_bin' then
  if r.id is null or r.status not in ('planned','assigned') then raise exception 'Route cannot reserve a bin'; end if;
  select * into bin from operations.bins where org_id=actor.org_id and warehouse_id=r.warehouse_id and label=upper(trim(p_payload->>'bin')) and enabled for update;
  if not found then raise exception 'Unknown physical bin'; end if;
  if exists(select 1 from operations.bin_reservations where bin_id=bin.id and released_at is null and route_id<>r.id) or exists(select 1 from operations.packages where bin_id=bin.id and route_id<>r.id) then raise exception 'Bin occupied'; end if;
  insert into operations.bin_reservations(org_id,bin_id,route_id) select actor.org_id,bin.id,r.id where not exists(select 1 from operations.bin_reservations where route_id=r.id and released_at is null);
  if not exists(select 1 from operations.bin_reservations where route_id=r.id and bin_id=bin.id and released_at is null) then raise exception 'Route already has a different bin'; end if;
  update operations.packages set exception_code='awaiting_stow' where route_id=r.id and exception_code='awaiting_bin';
  perform operations.refresh_route(r.id);
 when 'assign' then
  if r.id is null or r.status not in ('planned','assigned') or exists(select 1 from operations.packages where route_id=r.id and custody='driver') then raise exception 'Cannot reassign packages already in driver custody'; end if;
  target_driver:=nullif(p_payload->>'driver_id','')::uuid;
  if target_driver is not null and not exists(select 1 from public.drivers where id=target_driver and org_id=actor.org_id and not ops_disabled) then raise exception 'Driver is not a member of this organization'; end if;
  update operations.routes set driver_id=target_driver,status=case when target_driver is null then 'planned' else 'assigned' end,version=version+1 where id=r.id;
  perform operations.refresh_route(r.id);
 when 'claim' then
  if r.id is null or r.status<>'planned' or r.driver_id is not null then raise exception 'Route already assigned'; end if;
  if not exists(select 1 from public.drivers where id=actor.actor_id and org_id=actor.org_id and not ops_disabled) then raise exception 'Driver organization mismatch'; end if;
  update operations.routes set driver_id=actor.actor_id,status='assigned',version=version+1 where id=r.id;
  perform operations.refresh_route(r.id);
 when 'receive','stow','load','hold','return_package' then
  code:=upper(trim(p_payload->>'code'));
  select count(distinct package_id) into found_count from operations.package_aliases where org_id=actor.org_id and value=code;
  if found_count<>1 then raise exception 'Unknown or ambiguous package barcode'; end if;
  select p.* into pkg from operations.packages p where p.id=(select package_id from operations.package_aliases where org_id=actor.org_id and value=code limit 1) for update;
  if actor.role='driver' and (r.id is null or pkg.route_id<>r.id or pkg.driver_id is not null and pkg.driver_id<>actor.actor_id) then raise exception 'Package is not assigned to this driver'; end if;
  if p_kind='receive' then
   if pkg.custody='expected' then update operations.packages set custody='warehouse',updated_at=now() where id=pkg.id;
   elsif pkg.custody<>'warehouse' then raise exception 'Package already in another custody'; end if;
  elsif p_kind='stow' then
   select * into r from operations.routes where id=pkg.route_id and org_id=actor.org_id for update;
   if r.id is null or r.status not in ('planned','assigned') then raise exception 'Package is not on a stowable route'; end if;
   select b.* into bin from operations.bin_reservations br join operations.bins b on b.id=br.bin_id where br.route_id=r.id and br.released_at is null;
   if bin.id is null or bin.label<>upper(trim(p_payload->>'bin')) then raise exception 'Wrong bin'; end if;
   if pkg.state='stowed' and pkg.bin_id=bin.id then output:=jsonb_build_object('duplicate',true);
   elsif pkg.state='allocated' and pkg.custody in ('expected','warehouse') and (pkg.exception_code='awaiting_stow' or pkg.exception_code is null) then
    update operations.packages set state='stowed',custody='bin',bin_id=bin.id,exception_code=null,version=version+1,updated_at=now() where id=pkg.id;
   else raise exception 'Package cannot be stowed in its current state'; end if;
  elsif p_kind='load' then
   if r.staged_at is null or r.status<>'assigned' then raise exception 'Route is not ready for loading'; end if;
   if pkg.state='loaded' and pkg.driver_id=actor.actor_id then output:=jsonb_build_object('duplicate',true);
   elsif pkg.state='stowed' and pkg.exception_code is null then
    update operations.packages set state='loaded',custody='driver',driver_id=actor.actor_id,bin_id=null,version=version+1,updated_at=now() where id=pkg.id;
   else raise exception 'Package must be stowed before loading'; end if;
  elsif p_kind='hold' then
   if pkg.state='delivered' then raise exception 'Delivered package cannot be held'; end if;
   update operations.packages set state='held',exception_code=coalesce(nullif(p_payload->>'reason',''),'held'),version=version+1,updated_at=now() where id=pkg.id;
  else
   if pkg.state not in ('held','loaded','out_for_delivery') then raise exception 'Package is not returnable'; end if;
   -- Warehouse acknowledgement is required for custody transfer back into the warehouse.
   if actor.role='driver' then raise exception 'Warehouse must acknowledge physical return'; end if;
   update operations.packages set state='returned',custody='returned',driver_id=null,bin_id=null,exception_code=null,version=version+1,updated_at=now() where id=pkg.id;
  end if;
  if pkg.route_id is not null then perform operations.refresh_route(pkg.route_id); end if;
  output:=output||jsonb_build_object('package_id',pkg.id);
 when 'start' then
  if r.id is null or r.status<>'assigned' or r.staged_at is null then raise exception 'Route is not ready to depart'; end if;
  if not exists(select 1 from operations.packages where route_id=r.id and state='loaded') or exists(select 1 from operations.packages p join operations.stops s on s.id=p.stop_id where p.route_id=r.id and s.status='pending' and (p.state<>'loaded' or p.driver_id<>actor.actor_id or p.exception_code is not null)) then raise exception 'Incomplete driver load'; end if;
  update operations.routes set status='in_transit',started_at=now() where id=r.id;
  update operations.packages set state='out_for_delivery' where route_id=r.id and state='loaded';
  perform operations.refresh_route(r.id);
 when 'archive' then
  perform set_config('tackpath.operational_write','on',true);
  if r.status not in ('closed','cancelled') then raise exception 'Reconcile route before archival'; end if;
  update public.jobs set archived=true where id=r.id;
 when 'cancel_route' then
  if r.id is null or r.status='closed' then raise exception 'Route cannot be cancelled'; end if;
  update operations.stops set status='cancelled' where route_id=r.id and status='pending';
  update operations.packages set state='held',exception_code='cancelled_route',exception_detail=p_payload->>'reason' where route_id=r.id and state<>'delivered';
  update operations.routes set version=version+1 where id=r.id;
  perform operations.refresh_route(r.id);
 when 'cancel_stop' then
  select * into st from operations.stops where id=(p_payload->>'stop_id')::uuid and org_id=actor.org_id for update;
  if not found or st.status='delivered' then raise exception 'Stop cannot be cancelled'; end if;
  update operations.stops set status='cancelled' where id=st.id;
  update operations.packages set state='held',exception_code='cancelled_stop',exception_detail=p_payload->>'reason' where stop_id=st.id and state<>'delivered';
  update operations.routes set version=version+1 where id=st.route_id;
  perform operations.refresh_route(st.route_id);
 when 'proof_prepare' then
  select * into st from operations.stops where id=(p_payload->>'stop_id')::uuid and route_id=r.id and org_id=actor.org_id;
  if r.status<>'in_transit' or st.status is distinct from 'pending' then raise exception 'Stop is not deliverable'; end if;
  if exists(select 1 from operations.stops where route_id=r.id and sequence<st.sequence and status='pending') then raise exception 'Complete the preceding stop first'; end if;
  package_uuid:=(p_payload->>'proof_id')::uuid;
  insert into operations.proofs(id,org_id,route_id,stop_id,driver_id,object_path,kind,content_hash)
  values(package_uuid,actor.org_id,r.id,st.id,actor.actor_id,actor.org_id::text||'/'||r.id::text||'/'||st.id::text||'/'||package_uuid::text,p_payload->>'kind',p_payload->>'content_hash');
  output:=jsonb_build_object('proof_id',package_uuid,'object_path',actor.org_id::text||'/'||r.id::text||'/'||st.id::text||'/'||package_uuid::text);
 when 'deliver' then
  select * into st from operations.stops where id=(p_payload->>'stop_id')::uuid and route_id=r.id and org_id=actor.org_id for update;
  if r.status<>'in_transit' or st.status is distinct from 'pending' then raise exception 'Stop is not deliverable'; end if;
  select * into proof from operations.proofs where id=(p_payload->>'proof_id')::uuid and org_id=actor.org_id and route_id=r.id and stop_id=st.id and driver_id=actor.actor_id;
  if not found or proof.uploaded_at is null then raise exception 'Proof upload is not persisted'; end if;
  if exists(select 1 from operations.stops where route_id=r.id and sequence<st.sequence and status='pending') then raise exception 'Complete the preceding stop first'; end if;
  if exists(select 1 from operations.packages where stop_id=st.id and (state<>'out_for_delivery' or driver_id<>actor.actor_id or exception_code is not null)) then raise exception 'Package custody is not verified'; end if;
  insert into operations.deliveries(id,org_id,route_id,stop_id,driver_id,proof_id,recipient) values(p_id,actor.org_id,r.id,st.id,actor.actor_id,proof.id,p_payload->>'recipient');
  insert into operations.delivery_packages select p_id,id from operations.packages where stop_id=st.id;
  update operations.packages set state='delivered',custody='recipient',driver_id=null,version=version+1,updated_at=now() where stop_id=st.id;
  update operations.stops set status='delivered' where id=st.id;
  perform operations.refresh_route(r.id);
 when 'release_bin' then
  select * into bin from operations.bins where org_id=actor.org_id and id=(p_payload->>'bin_id')::uuid;
  if exists(select 1 from operations.packages where bin_id=bin.id) then raise exception 'Cannot release a nonempty bin'; end if;
  for r in select rr.* from operations.routes rr join operations.bin_reservations br on br.route_id=rr.id where br.bin_id=bin.id and br.released_at is null loop perform operations.refresh_route(r.id); end loop;
  if exists(select 1 from operations.bin_reservations where bin_id=bin.id and released_at is null) then raise exception 'Bin has outstanding placement obligations'; end if;
 else raise exception 'Unknown operational command: %',p_kind;
 end case;
 output:=output||jsonb_build_object('committed',true,'command_id',p_id);
 insert into operations.commands values(actor.org_id,p_id,actor.actor_id,p_kind,p_payload,output,now());
 insert into operations.events(org_id,command_id,actor_id,kind,payload) values(actor.org_id,p_id,actor.actor_id,p_kind,p_payload||output);
 return output;
end $$;
revoke all on function public.ops_command(text,uuid,text,jsonb) from public;
grant execute on function public.ops_command(text,uuid,text,jsonb) to anon,authenticated,service_role;
revoke all on all functions in schema operations from public,anon,authenticated;


commit;