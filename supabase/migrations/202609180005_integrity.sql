begin;
alter table operations.packages add constraint package_stop_pair check((route_id is null)=(stop_id is null));
create function operations.verify_package_integrity() returns trigger language plpgsql set search_path=pg_catalog,operations as $$
declare p operations.packages; r operations.routes;
begin
 select * into p from operations.packages where id=coalesce(new.id,old.id);
 if not found then raise exception 'Physical package records cannot disappear'; end if;
 if p.bin_id is not null and not exists(select 1 from operations.bin_reservations where bin_id=p.bin_id and route_id=p.route_id and org_id=p.org_id and released_at is null) then raise exception 'Package bin requires its exclusive route reservation'; end if;
 if p.driver_id is not null and not exists(select 1 from operations.routes where id=p.route_id and driver_id=p.driver_id and org_id=p.org_id) then raise exception 'Package custody and driver assignment disagree'; end if;
 if p.state='delivered' and not exists(select 1 from operations.delivery_packages dp join operations.deliveries d on d.id=dp.delivery_id join operations.proofs pr on pr.id=d.proof_id where dp.package_id=p.id and d.stop_id=p.stop_id and pr.uploaded_at is not null) then raise exception 'Delivered package requires persisted proof and delivery'; end if;
 return null;
end $$;
create constraint trigger package_integrity after insert or update or delete on operations.packages deferrable initially deferred for each row execute function operations.verify_package_integrity();
create function operations.verify_manifest_balance() returns trigger language plpgsql set search_path=pg_catalog,operations as $$
declare m uuid; expected integer; actual integer;
begin
 if tg_table_name='manifests' then
  m:=new.id;
 else
  m:=new.manifest_id;
 end if;
 select expected_pieces into expected from operations.manifests where id=m;
 select count(*) into actual from operations.packages where manifest_id=m;
 if expected<>actual then raise exception 'Manifest package conservation violation: expected %, recorded %',expected,actual; end if;
 return null;
end $$;
create constraint trigger manifest_balance after insert or update on operations.manifests deferrable initially deferred for each row execute function operations.verify_manifest_balance();
create constraint trigger package_balance after insert or update on operations.packages deferrable initially deferred for each row execute function operations.verify_manifest_balance();
create function operations.verify_bin_release() returns trigger language plpgsql set search_path=pg_catalog,operations as $$
begin
 if new.released_at is not null and exists(select 1 from operations.packages where bin_id=new.bin_id) then raise exception 'Physical contents prevent bin release'; end if;
 return new;
end $$;
create trigger verify_bin_release before update on operations.bin_reservations for each row execute function operations.verify_bin_release();
revoke all on all functions in schema operations from public,anon,authenticated;
commit;
