-- Operational authority. Additive: legacy records are retained, never deleted.
begin;
create schema if not exists operations;
revoke all on schema operations from public;
create table operations.sessions (
 token_hash text primary key, org_id uuid not null references public.organizations(id),
 actor_id uuid not null, role text not null check(role in ('dispatcher','warehouse','driver','system')),
 expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now()
);
create table operations.warehouses (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id),
 name text not null, address text not null, unique(org_id,id)
);
create table operations.bins (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, warehouse_id uuid not null,
 label text not null check(length(trim(label))>0), enabled boolean not null default true,
 unique(org_id,warehouse_id,label), unique(org_id,id),
 foreign key(org_id,warehouse_id) references operations.warehouses(org_id,id)
);
create table operations.manifests (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id),
 warehouse_id uuid not null, source text not null, external_id text not null, content_hash text not null,
 raw_text text not null, expected_pieces integer not null check(expected_pieces>=0),
 status text not null default 'received' check(status in ('received','processing','published','exceptions')),
 created_at timestamptz not null default now(), unique(org_id,source,external_id), unique(org_id,id),
 foreign key(org_id,warehouse_id) references operations.warehouses(org_id,id)
);
create table operations.manifest_rows (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, manifest_id uuid not null,
 row_number integer not null, raw jsonb not null, expected_pieces integer check(expected_pieces>0),
 error text, unique(manifest_id,row_number), unique(org_id,id),
 foreign key(org_id,manifest_id) references operations.manifests(org_id,id)
);
create table operations.routes (
 id uuid primary key references public.jobs(id), org_id uuid not null references public.organizations(id),
 manifest_id uuid not null, warehouse_id uuid not null, plan_key text not null,
 driver_id uuid references public.drivers(id), version integer not null default 1,
 status text not null default 'planned' check(status in ('planned','assigned','in_transit','reconciling','closed','cancelled')),
 staged_at timestamptz, started_at timestamptz, closed_at timestamptz,
 unique(org_id,id), unique(manifest_id,plan_key),
 foreign key(org_id,manifest_id) references operations.manifests(org_id,id),
 foreign key(org_id,warehouse_id) references operations.warehouses(org_id,id)
);
create table operations.stops (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, route_id uuid not null,
 sequence integer not null check(sequence>0), recipient text not null, address text not null,
 lat double precision check(lat between -90 and 90), lng double precision check(lng between -180 and 180),
 status text not null default 'pending' check(status in ('pending','delivered','cancelled')),
 unique(route_id,sequence), unique(org_id,id), unique(org_id,route_id,id),
 foreign key(org_id,route_id) references operations.routes(org_id,id)
);
create table operations.packages (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, manifest_id uuid not null, row_id uuid not null,
 piece_number integer not null check(piece_number>0), order_id text, tracking_number text,
 route_id uuid, stop_id uuid, bin_id uuid, driver_id uuid references public.drivers(id),
 state text not null default 'manifested' check(state in ('manifested','routable','geocode_failed','allocated','stowed','loaded','out_for_delivery','delivered','held','returned')),
 custody text not null default 'expected' check(custody in ('expected','warehouse','bin','driver','recipient','returned')),
 exception_code text default 'awaiting_processing', exception_detail text,
 version integer not null default 1, updated_at timestamptz not null default now(),
 unique(row_id,piece_number), unique(org_id,id),
 foreign key(org_id,manifest_id) references operations.manifests(org_id,id),
 foreign key(org_id,row_id) references operations.manifest_rows(org_id,id),
 foreign key(org_id,route_id,stop_id) references operations.stops(org_id,route_id,id),
 foreign key(org_id,bin_id) references operations.bins(org_id,id),
 check((custody='bin')=(bin_id is not null)),
 check((custody='driver')=(driver_id is not null)),
 check(state<>'delivered' or custody='recipient'),
 check(state not in ('loaded','out_for_delivery') or custody='driver'),
 check(state<>'stowed' or custody='bin')
);
-- Aliases resolve to a physical piece, never to its current route position.
create table operations.package_aliases (
 org_id uuid not null, namespace text not null, value text not null check(length(value)>0),
 package_id uuid not null, primary key(org_id,namespace,value),
 foreign key(org_id,package_id) references operations.packages(org_id,id)
);
create table operations.bin_reservations (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, bin_id uuid not null, route_id uuid not null,
 reserved_at timestamptz not null default now(), released_at timestamptz,
 foreign key(org_id,bin_id) references operations.bins(org_id,id),
 foreign key(org_id,route_id) references operations.routes(org_id,id)
);
create unique index one_active_route_per_bin on operations.bin_reservations(bin_id) where released_at is null;
create unique index one_active_bin_per_route on operations.bin_reservations(route_id) where released_at is null;
create table operations.proofs (
 id uuid primary key, org_id uuid not null, route_id uuid not null, stop_id uuid not null,
 driver_id uuid not null references public.drivers(id), object_path text not null unique,
 kind text not null check(kind in ('photo','signature')), content_hash text not null,
 uploaded_at timestamptz, created_at timestamptz not null default now(),
 unique(org_id,id), foreign key(org_id,route_id,stop_id) references operations.stops(org_id,route_id,id)
);
create table operations.deliveries (
 id uuid primary key, org_id uuid not null, route_id uuid not null, stop_id uuid not null unique,
 driver_id uuid not null references public.drivers(id), proof_id uuid not null, recipient text not null check(length(trim(recipient))>0),
 delivered_at timestamptz not null default now(),
 foreign key(org_id,route_id,stop_id) references operations.stops(org_id,route_id,id),
 foreign key(org_id,proof_id) references operations.proofs(org_id,id)
);
create table operations.delivery_packages (
 delivery_id uuid not null references operations.deliveries(id), package_id uuid not null unique references operations.packages(id),
 primary key(delivery_id,package_id)
);
create table operations.commands (
 org_id uuid not null, id uuid not null, actor_id uuid not null, kind text not null, payload jsonb not null,
 result jsonb not null, created_at timestamptz not null default now(), primary key(org_id,id)
);
create table operations.events (
 id bigint generated always as identity primary key, org_id uuid not null, command_id uuid not null,
 actor_id uuid not null, kind text not null, payload jsonb not null, occurred_at timestamptz not null default now(),
 foreign key(org_id,command_id) references operations.commands(org_id,id) deferrable initially deferred
);
create function operations.block_event_mutation() returns trigger language plpgsql as $$
begin raise exception 'Operational history is immutable'; end $$;
create trigger immutable_events before update or delete on operations.events for each row execute function operations.block_event_mutation();
create index packages_route on operations.packages(org_id,route_id);
create index packages_manifest on operations.packages(org_id,manifest_id);
create index packages_bin on operations.packages(bin_id) where bin_id is not null;
create index packages_exceptions on operations.packages(org_id,exception_code) where exception_code is not null;
create function operations.session(p_token text) returns operations.sessions
language plpgsql security definer set search_path=pg_catalog,operations as $$
declare s operations.sessions;
begin
 select * into s from operations.sessions where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires_at>now() and revoked_at is null;
 if s.org_id is null then raise exception 'Authentication required' using errcode='28000'; end if;
 return s;
end $$;
-- All changes go through authenticated transactional commands. No browser table writes.
revoke all on all tables in schema operations from public, anon, authenticated;
revoke all on all functions in schema operations from public, anon, authenticated;
commit;
