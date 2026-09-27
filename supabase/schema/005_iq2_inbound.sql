-- ════════════════════════════════════════════════════════════════════
-- 005 — IQ2 inbound operations: receiving + putaway
--
-- ADDITIVE ONLY. Creates a new private schema `iq2` and new public
-- functions prefixed iq2_. Touches nothing that exists: no STOW table
-- (jobs, bin_bindings, events, packages, bin_shortfall) is read, written
-- or altered.
--
-- Security shape:
--   * All IQ2 tables live in schema `iq2`, which PostgREST does not
--     expose. anon/authenticated have no privilege on the schema or its
--     tables, and RLS is enabled with no policies as a second wall.
--   * The ONLY way in is the public.iq2_* functions below. They are
--     SECURITY DEFINER with a pinned search_path, and every inventory
--     rule (over-receive, double putaway, invalid location, idempotency)
--     is enforced here, inside one transaction, with row locks -- never
--     by the browser.
--   * Master-data functions (warehouses, manifest import, location
--     registry, reports) additionally require an IQ2 admin key whose
--     SHA-256 hash is stored in iq2.admin_keys. Create one manually:
--       insert into iq2.admin_keys(key_hash,label) values
--         (encode(sha256(convert_to('<secret>','UTF8')),'hex'),'office');
--   * Receiving/putaway functions are callable with the publishable key,
--     exactly like PathIQ STOW today. There is no worker login yet, so
--     `actor`/`device` are self-reported by the device. See IQ2 docs.
--
-- Quantity model (never mixed):
--   cartons = physical handling units scanned (1 scan = 1 carton)
--   units   = inventory units inside them (units_per_carton each)
--
-- Rollback: drop schema iq2 cascade; drop function public.iq2_*.
-- ════════════════════════════════════════════════════════════════════

begin;

create schema if not exists iq2;
revoke all on schema iq2 from public;

-- ── helpers ─────────────────────────────────────────────────────────
-- Decoded scan values are matched exactly, ignoring surrounding
-- whitespace/CR/LF a scanner may append, and ignoring case.
create or replace function iq2.norm(t text) returns text
language sql immutable as $$
  select nullif(upper(btrim(coalesce(t,''), E' \t\r\n')), '')
$$;

-- Location labels may encode "LOC:B-4" or just "B-4".
create or replace function iq2.loc_norm(t text) returns text
language sql immutable as $$
  select iq2.norm(regexp_replace(btrim(coalesce(t,''), E' \t\r\n'),
                                 '^(LOC|LOCATION)[:\s-]*', '', 'i'))
$$;

-- ── master data ─────────────────────────────────────────────────────
create table iq2.warehouses (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name       text not null,
  org_id     uuid,                       -- optional link to organizations
  created_at timestamptz not null default now()
);

create table iq2.admin_keys (
  key_hash   text primary key,           -- hex sha256 of the secret
  label      text,
  created_at timestamptz not null default now()
);

create table iq2.skus (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references iq2.warehouses(id),
  sku          text not null check (length(btrim(sku)) > 0),
  description  text not null default '',
  created_at   timestamptz not null default now(),
  unique (warehouse_id, sku)
);

-- Permanent storage positions. The printed label is the identity.
create table iq2.locations (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references iq2.warehouses(id),
  code         text not null,             -- as registered, e.g. B-4
  code_norm    text not null,
  aisle        text,
  bay          text,
  shelf        text,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (warehouse_id, code_norm)
);

-- ── inbound ─────────────────────────────────────────────────────────
create table iq2.manifests (
  id              uuid primary key default gen_random_uuid(),
  warehouse_id    uuid not null references iq2.warehouses(id),
  source_name     text,
  content_hash    text not null,
  load_refs       text[] not null,
  row_count       integer not null,
  pallet_count    integer not null,
  expected_cartons integer not null,
  expected_units  bigint not null,
  imported_by     text,
  imported_at     timestamptz not null default now(),
  unique (warehouse_id, content_hash)
);

create table iq2.pallets (
  id                uuid primary key default gen_random_uuid(),
  warehouse_id      uuid not null references iq2.warehouses(id),
  manifest_id       uuid not null references iq2.manifests(id),
  load_ref          text not null,
  pallet_code       text not null,          -- real pallet label value
  pallet_norm       text not null,
  status            text not null default 'open'
                    check (status in ('open','receiving','closed')),
  first_received_at timestamptz,
  closed_at         timestamptz,
  closed_by         text,
  closed_device     text,
  created_at        timestamptz not null default now(),
  check ((status = 'closed') = (closed_at is not null))
);
-- A physical pallet label can be live on only one inbound pallet at a time.
create unique index pallets_one_live_label
  on iq2.pallets (warehouse_id, pallet_norm) where status <> 'closed';
create index pallets_label on iq2.pallets (warehouse_id, pallet_norm);

-- One expected handling-unit group: a real carton barcode on a pallet,
-- what it contains, and how many physical cartons carry that barcode.
-- A uniquely-labelled carton is simply expected_cartons = 1. No per-carton
-- identity is ever invented for shared barcodes -- they are counted.
create table iq2.lines (
  id               uuid primary key default gen_random_uuid(),
  warehouse_id     uuid not null references iq2.warehouses(id),
  pallet_id        uuid not null references iq2.pallets(id),
  row_number       integer not null,       -- source manifest row
  carton_code      text not null,          -- as supplied by the manifest
  carton_norm      text not null,
  sku_id           uuid not null references iq2.skus(id),
  units_per_carton integer not null check (units_per_carton > 0),
  expected_cartons integer not null check (expected_cartons > 0),
  received_cartons integer not null default 0,
  putaway_cartons  integer not null default 0,
  unique (pallet_id, carton_norm),
  -- Last line of defence: over-receive and double putaway are impossible
  -- even if a function had a bug.
  check (received_cartons between 0 and expected_cartons),
  check (putaway_cartons between 0 and received_cartons)
);
create index lines_code on iq2.lines (warehouse_id, carton_norm);

-- ── inventory ───────────────────────────────────────────────────────
-- Current balance per location + SKU. Derived from the ledger and kept
-- in the same transaction; iq2_audit() proves they agree.
create table iq2.inventory (
  warehouse_id uuid not null references iq2.warehouses(id),
  location_id  uuid not null references iq2.locations(id),
  sku_id       uuid not null references iq2.skus(id),
  units        bigint  not null check (units >= 0),
  cartons      integer not null check (cartons >= 0),
  updated_at   timestamptz not null default now(),
  primary key (location_id, sku_id)
);

-- ── authoritative, append-only ledger ──────────────────────────────
create table iq2.movements (
  id           bigint generated always as identity primary key,
  warehouse_id uuid not null references iq2.warehouses(id),
  kind         text not null check (kind in ('receive','putaway')),
  idem_key     text not null unique,
  pallet_id    uuid not null references iq2.pallets(id),
  line_id      uuid not null references iq2.lines(id),
  sku_id       uuid not null references iq2.skus(id),
  scanned_code text not null,                 -- exact decoded value
  cartons      integer not null check (cartons > 0),
  units        bigint  not null check (units > 0),
  location_id  uuid references iq2.locations(id),
  cart_code    text,                          -- reserved: putaway cart (not tracked in v1)
  device_id    text,
  actor        text,
  occurred_at  timestamptz not null default now(),
  check ((kind = 'putaway') = (location_id is not null))
);
create index movements_line on iq2.movements (line_id);
create index movements_loc  on iq2.movements (location_id, sku_id) where location_id is not null;
create index movements_time on iq2.movements (warehouse_id, occurred_at desc);

create or replace function iq2.block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'iq2.% is append-only: % is not permitted', tg_table_name, tg_op;
end $$;
create trigger movements_append_only before update or delete on iq2.movements
  for each row execute function iq2.block_mutation();
create trigger movements_no_truncate before truncate on iq2.movements
  for each statement execute function iq2.block_mutation();

-- ── exceptions: every rejected or discrepant scan ───────────────────
create table iq2.exceptions (
  id               bigint generated always as identity primary key,
  warehouse_id     uuid not null references iq2.warehouses(id),
  kind             text not null check (kind in (
                     'unknown_pallet','pallet_closed','unknown_carton','wrong_pallet',
                     'over_receive','duplicate_carton','not_received','already_putaway',
                     'ambiguous_carton','invalid_location','disabled_location',
                     'short_on_close')),
  scanned_code     text,
  pallet_id        uuid references iq2.pallets(id),
  line_id          uuid references iq2.lines(id),
  location_id      uuid references iq2.locations(id),
  expected_cartons integer,
  actual_cartons   integer,
  detail           text,
  device_id        text,
  actor            text,
  occurred_at      timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text,
  resolution       text
);
create index exceptions_open on iq2.exceptions (warehouse_id, occurred_at desc) where resolved_at is null;
create trigger exceptions_no_delete before delete on iq2.exceptions
  for each row execute function iq2.block_mutation();
create trigger exceptions_no_truncate before truncate on iq2.exceptions
  for each statement execute function iq2.block_mutation();

-- Second wall: even if the schema were ever exposed, no policy = no rows.
alter table iq2.warehouses enable row level security;
alter table iq2.admin_keys enable row level security;
alter table iq2.skus       enable row level security;
alter table iq2.locations  enable row level security;
alter table iq2.manifests  enable row level security;
alter table iq2.pallets    enable row level security;
alter table iq2.lines      enable row level security;
alter table iq2.inventory  enable row level security;
alter table iq2.movements  enable row level security;
alter table iq2.exceptions enable row level security;

-- ── internal helpers ────────────────────────────────────────────────
create or replace function iq2.wh(p_code text) returns uuid
language sql stable as $$
  select id from iq2.warehouses where code = iq2.norm(p_code)
$$;

create or replace function iq2.is_admin(p_key text) returns boolean
language sql stable as $$
  select p_key is not null and length(p_key) >= 8 and exists (
    select 1 from iq2.admin_keys
    where key_hash = encode(sha256(convert_to(p_key,'UTF8')),'hex'))
$$;

create or replace function iq2.pallet_summary(p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p.id, 'code', p.pallet_code, 'load_ref', p.load_ref, 'status', p.status,
    'lines', count(l.id),
    'skus', count(distinct l.sku_id),
    'expected_cartons', coalesce(sum(l.expected_cartons),0),
    'received_cartons', coalesce(sum(l.received_cartons),0),
    'expected_units',   coalesce(sum(l.expected_cartons::bigint*l.units_per_carton),0),
    'received_units',   coalesce(sum(l.received_cartons::bigint*l.units_per_carton),0),
    'closed_at', p.closed_at,
    'shortages', coalesce(jsonb_agg(jsonb_build_object(
        'carton_code', l.carton_code, 'sku', s.sku, 'description', s.description,
        'units_per_carton', l.units_per_carton,
        'expected_cartons', l.expected_cartons, 'received_cartons', l.received_cartons,
        'short_cartons', l.expected_cartons - l.received_cartons)
        order by l.row_number) filter (where l.received_cartons < l.expected_cartons), '[]'::jsonb))
  from iq2.pallets p
  left join iq2.lines l on l.pallet_id = p.id
  left join iq2.skus  s on s.id = l.sku_id
  where p.id = p_id
  group by p.id
$$;

-- Records the exception and builds the rejection result in one step, so a
-- rejected scan is always durable even though nothing else is written.
create or replace function iq2.reject(
  p_wh uuid, p_kind text, p_result text, p_message text, p_scanned text,
  p_device text, p_actor text,
  p_pallet uuid default null, p_line uuid default null, p_location uuid default null,
  p_expected integer default null, p_actual integer default null,
  p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
  insert into iq2.exceptions(warehouse_id,kind,scanned_code,pallet_id,line_id,location_id,
                             expected_cartons,actual_cartons,detail,device_id,actor)
  values (p_wh,p_kind,left(p_scanned,200),p_pallet,p_line,p_location,
          p_expected,p_actual,p_message,left(p_device,100),left(p_actor,100));
  return jsonb_build_object('ok',false,'code',p_result,'message',p_message) || coalesce(p_extra,'{}'::jsonb);
end $$;

create or replace function iq2.fail(p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok',false,'code',p_code,'message',p_message) || coalesce(p_extra,'{}'::jsonb)
$$;

create or replace function iq2.location_json(p_loc uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'code', l.code, 'aisle', l.aisle, 'bay', l.bay, 'shelf', l.shelf, 'enabled', l.enabled,
    'total_units', coalesce((select sum(units) from iq2.inventory i where i.location_id=l.id),0),
    'contents', coalesce((select jsonb_agg(jsonb_build_object(
        'sku', s.sku, 'description', s.description, 'units', i.units, 'cartons', i.cartons)
        order by s.sku)
      from iq2.inventory i join iq2.skus s on s.id=i.sku_id
      where i.location_id=l.id and i.units>0), '[]'::jsonb))
  from iq2.locations l where l.id = p_loc
$$;

-- ════════════════════════════════════════════════════════════════════
-- PUBLIC API — TC56 (publishable key)
-- ════════════════════════════════════════════════════════════════════

create or replace function public.iq2_list_warehouses() returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code',code,'name',name) order by code),'[]'::jsonb)
  from iq2.warehouses
$$;

-- Identify a pallet. Read-only apart from recording a rejected scan.
create or replace function public.iq2_open_pallet(
  p_warehouse text, p_code text, p_device text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_norm text := iq2.norm(p_code);
  v_pal iq2.pallets;
  v_other text;
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','This device is not set to a known IQ2 warehouse.'); end if;
  if v_norm is null or length(v_norm) > 200 then return iq2.fail('BAD_SCAN','Empty or unreadable scan.'); end if;

  select * into v_pal from iq2.pallets
   where warehouse_id=v_wh and pallet_norm=v_norm and status<>'closed';
  if found then
    return jsonb_build_object('ok',true,'code','PALLET','pallet',iq2.pallet_summary(v_pal.id));
  end if;

  select * into v_pal from iq2.pallets
   where warehouse_id=v_wh and pallet_norm=v_norm
   order by closed_at desc limit 1;
  if found then
    return iq2.reject(v_wh,'pallet_closed','PALLET_CLOSED',
      'Pallet '||v_pal.pallet_code||' was already received and closed. It is not reopened.',
      p_code,p_device,p_actor,v_pal.id,null,null,null,null,
      jsonb_build_object('pallet',iq2.pallet_summary(v_pal.id)));
  end if;

  select p.pallet_code into v_other from iq2.lines l join iq2.pallets p on p.id=l.pallet_id
   where l.warehouse_id=v_wh and l.carton_norm=v_norm and p.status<>'closed' limit 1;
  if v_other is not null then
    return iq2.fail('NOT_A_PALLET','That is a carton on pallet '||v_other||'. Scan the pallet label.',
                    jsonb_build_object('pallet_code',v_other));
  end if;

  return iq2.reject(v_wh,'unknown_pallet','UNKNOWN_PALLET',
    'No inbound manifest lists this pallet. Nothing was received.',p_code,p_device,p_actor);
end $$;

-- Receive ONE physical carton against a pallet.
create or replace function public.iq2_receive_carton(
  p_warehouse text, p_pallet_id uuid, p_code text, p_idem text,
  p_device text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_norm text := iq2.norm(p_code);
  v_pal iq2.pallets;
  v_line iq2.lines;
  v_sku iq2.skus;
  v_mv iq2.movements;
  v_other text;
  v_replay boolean := false;
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','This device is not set to a known IQ2 warehouse.'); end if;
  if p_idem is null or length(p_idem) < 8 or length(p_idem) > 100 then return iq2.fail('BAD_REQUEST','Missing request key.'); end if;
  if v_norm is null or length(v_norm) > 200 then return iq2.fail('BAD_SCAN','Empty or unreadable scan.'); end if;

  -- Serialize all receiving on this pallet: two devices can never both
  -- see "4 of 5" and both add the 5th.
  select * into v_pal from iq2.pallets where id=p_pallet_id and warehouse_id=v_wh for update;
  if not found then return iq2.fail('UNKNOWN_PALLET','That pallet is not on file in this warehouse.'); end if;

  -- Idempotent retry: the same request key returns the original result.
  select * into v_mv from iq2.movements where idem_key=p_idem;
  if found then
    if v_mv.kind<>'receive' or v_mv.pallet_id<>v_pal.id then
      return iq2.fail('IDEMPOTENCY_CONFLICT','Request key already used for a different operation.');
    end if;
    select * into v_line from iq2.lines where id=v_mv.line_id;
    v_replay := true;
  else
    if v_pal.status='closed' then
      return iq2.reject(v_wh,'pallet_closed','PALLET_CLOSED',
        'Pallet '||v_pal.pallet_code||' is closed. Nothing was received.',
        p_code,p_device,p_actor,v_pal.id);
    end if;

    select * into v_line from iq2.lines where pallet_id=v_pal.id and carton_norm=v_norm for update;
    if not found then
      -- Another pallet label: the client switches pallets, nothing recorded.
      if exists (select 1 from iq2.pallets where warehouse_id=v_wh and pallet_norm=v_norm and status<>'closed') then
        return iq2.fail('PALLET_SCANNED','That is a pallet label.', jsonb_build_object('pallet',
          iq2.pallet_summary((select id from iq2.pallets where warehouse_id=v_wh and pallet_norm=v_norm and status<>'closed'))));
      end if;
      select p.pallet_code into v_other from iq2.lines l join iq2.pallets p on p.id=l.pallet_id
       where l.warehouse_id=v_wh and l.carton_norm=v_norm and p.status<>'closed' and p.id<>v_pal.id
       order by p.created_at limit 1;
      if v_other is not null then
        return iq2.reject(v_wh,'wrong_pallet','WRONG_PALLET',
          'This carton is listed on pallet '||v_other||', not '||v_pal.pallet_code||'. Nothing was received.',
          p_code,p_device,p_actor,v_pal.id,null,null,null,null,jsonb_build_object('pallet_code',v_other));
      end if;
      return iq2.reject(v_wh,'unknown_carton','UNKNOWN_CARTON',
        'This barcode is not on pallet '||v_pal.pallet_code||'''s manifest. Nothing was received.',
        p_code,p_device,p_actor,v_pal.id);
    end if;

    if v_line.received_cartons >= v_line.expected_cartons then
      select * into v_sku from iq2.skus where id=v_line.sku_id;
      if v_line.expected_cartons = 1 then
        return iq2.reject(v_wh,'duplicate_carton','ALREADY_RECEIVED',
          'This carton was already received. Nothing was counted.',
          p_code,p_device,p_actor,v_pal.id,v_line.id,null,1,1,
          jsonb_build_object('sku',v_sku.sku,'description',v_sku.description,
            'expected_cartons',1,'received_cartons',1));
      end if;
      return iq2.reject(v_wh,'over_receive','OVER_RECEIVE',
        'All '||v_line.expected_cartons||' cartons of this barcode are already received. Nothing was counted.',
        p_code,p_device,p_actor,v_pal.id,v_line.id,null,v_line.expected_cartons,v_line.expected_cartons+1,
        jsonb_build_object('sku',v_sku.sku,'description',v_sku.description,
          'expected_cartons',v_line.expected_cartons,'received_cartons',v_line.received_cartons));
    end if;

    update iq2.lines set received_cartons = received_cartons + 1 where id=v_line.id
      returning * into v_line;
    if v_pal.status='open' then
      update iq2.pallets set status='receiving', first_received_at=now() where id=v_pal.id;
    end if;
    insert into iq2.movements(warehouse_id,kind,idem_key,pallet_id,line_id,sku_id,scanned_code,
                              cartons,units,device_id,actor)
    values (v_wh,'receive',p_idem,v_pal.id,v_line.id,v_line.sku_id,left(p_code,200),
            1,v_line.units_per_carton,left(p_device,100),left(p_actor,100));
  end if;

  select * into v_sku from iq2.skus where id=v_line.sku_id;
  return jsonb_build_object(
    'ok',true,'code','RECEIVED','replay',v_replay,
    'carton_code',v_line.carton_code,'sku',v_sku.sku,'description',v_sku.description,
    'units',v_line.units_per_carton,
    'carton_index',case when v_replay then null else v_line.received_cartons end,
    'expected_cartons',v_line.expected_cartons,'received_cartons',v_line.received_cartons,
    'pallet',iq2.pallet_summary(v_pal.id));
end $$;

-- Close a pallet. With shortages, requires explicit confirmation and
-- records one short_on_close exception per short line.
create or replace function public.iq2_close_pallet(
  p_warehouse text, p_pallet_id uuid, p_confirm_short boolean default false,
  p_device text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_pal iq2.pallets;
  v_short integer;
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','This device is not set to a known IQ2 warehouse.'); end if;
  select * into v_pal from iq2.pallets where id=p_pallet_id and warehouse_id=v_wh for update;
  if not found then return iq2.fail('UNKNOWN_PALLET','That pallet is not on file in this warehouse.'); end if;
  if v_pal.status='closed' then
    return jsonb_build_object('ok',true,'code','ALREADY_CLOSED','pallet',iq2.pallet_summary(v_pal.id));
  end if;

  select count(*) into v_short from iq2.lines where pallet_id=v_pal.id and received_cartons<expected_cartons;
  if v_short > 0 and not coalesce(p_confirm_short,false) then
    return iq2.fail('SHORT_CONFIRM_REQUIRED','Pallet is short. Confirm to close it short.',
                    jsonb_build_object('pallet',iq2.pallet_summary(v_pal.id)));
  end if;

  insert into iq2.exceptions(warehouse_id,kind,scanned_code,pallet_id,line_id,expected_cartons,actual_cartons,detail,device_id,actor)
  select v_wh,'short_on_close',l.carton_code,v_pal.id,l.id,l.expected_cartons,l.received_cartons,
         'Closed short: '||(l.expected_cartons-l.received_cartons)||' of '||l.expected_cartons||' cartons ('
           ||s.sku||') not received.',left(p_device,100),left(p_actor,100)
    from iq2.lines l join iq2.skus s on s.id=l.sku_id
   where l.pallet_id=v_pal.id and l.received_cartons<l.expected_cartons;

  update iq2.pallets set status='closed', closed_at=now(), closed_by=left(p_actor,100), closed_device=left(p_device,100)
   where id=v_pal.id;
  return jsonb_build_object('ok',true,'code', case when v_short>0 then 'CLOSED_SHORT' else 'CLOSED' end,
                            'pallet',iq2.pallet_summary(v_pal.id));
end $$;

-- Identify a received carton for putaway. Read-only apart from recording
-- a rejected scan. A location scanned here returns its contents.
create or replace function public.iq2_putaway_lookup(
  p_warehouse text, p_code text, p_device text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_norm text := iq2.norm(p_code);
  v_loc uuid;
  v_kinds integer;
  v_line iq2.lines;
  v_sku iq2.skus;
  v_remaining integer;
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','This device is not set to a known IQ2 warehouse.'); end if;
  if v_norm is null or length(v_norm) > 200 then return iq2.fail('BAD_SCAN','Empty or unreadable scan.'); end if;

  if not exists (select 1 from iq2.lines where warehouse_id=v_wh and carton_norm=v_norm) then
    select id into v_loc from iq2.locations where warehouse_id=v_wh and code_norm=iq2.loc_norm(p_code);
    if v_loc is not null then
      return jsonb_build_object('ok',false,'code','LOCATION_SCANNED','message','Scan a carton first.',
                                'location',iq2.location_json(v_loc));
    end if;
    if exists (select 1 from iq2.pallets where warehouse_id=v_wh and pallet_norm=v_norm) then
      return iq2.fail('PALLET_SCANNED','That is a pallet label. Scan a carton.');
    end if;
    return iq2.reject(v_wh,'unknown_carton','UNKNOWN_CARTON',
      'This barcode is not on any inbound manifest. Nothing was moved.',p_code,p_device,p_actor);
  end if;

  select count(distinct (sku_id, units_per_carton)) into v_kinds from iq2.lines
   where warehouse_id=v_wh and carton_norm=v_norm and received_cartons>putaway_cartons;
  if v_kinds = 0 then
    if exists (select 1 from iq2.lines where warehouse_id=v_wh and carton_norm=v_norm and received_cartons>0) then
      return iq2.reject(v_wh,'already_putaway','ALREADY_PUT_AWAY',
        'Every received carton with this barcode is already put away. Nothing was moved.',p_code,p_device,p_actor);
    end if;
    return iq2.reject(v_wh,'not_received','NOT_RECEIVED',
      'This carton has not been received yet. Receive it first.',p_code,p_device,p_actor);
  end if;
  if v_kinds > 1 then
    return iq2.reject(v_wh,'ambiguous_carton','AMBIGUOUS_CARTON',
      'This barcode is received with different contents on more than one pallet. Set it aside for a lead.',
      p_code,p_device,p_actor);
  end if;

  -- Oldest received first (FIFO across pallets carrying the same barcode).
  select l.* into v_line from iq2.lines l join iq2.pallets p on p.id=l.pallet_id
   where l.warehouse_id=v_wh and l.carton_norm=v_norm and l.received_cartons>l.putaway_cartons
   order by p.first_received_at nulls last, p.created_at, l.row_number limit 1;
  select coalesce(sum(received_cartons-putaway_cartons),0) into v_remaining from iq2.lines
   where warehouse_id=v_wh and carton_norm=v_norm and received_cartons>putaway_cartons;
  select * into v_sku from iq2.skus where id=v_line.sku_id;
  return jsonb_build_object('ok',true,'code','CARTON','line_id',v_line.id,
    'carton_code',v_line.carton_code,'sku',v_sku.sku,'description',v_sku.description,
    'units',v_line.units_per_carton,'remaining_cartons',v_remaining);
end $$;

-- Put ONE received carton into a registered location.
create or replace function public.iq2_putaway(
  p_warehouse text, p_code text, p_location text, p_idem text,
  p_line_id uuid default null, p_device text default null, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_norm text := iq2.norm(p_code);
  v_loc iq2.locations;
  v_mv iq2.movements;
  v_line iq2.lines;
  v_sku iq2.skus;
  v_kinds integer;
  v_balance bigint;
  v_remaining integer;
  v_replay boolean := false;
  v_ids uuid[];
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','This device is not set to a known IQ2 warehouse.'); end if;
  if p_idem is null or length(p_idem) < 8 or length(p_idem) > 100 then return iq2.fail('BAD_REQUEST','Missing request key.'); end if;
  if v_norm is null or length(v_norm) > 200 then return iq2.fail('BAD_SCAN','Empty or unreadable carton scan.'); end if;

  -- Lock every line carrying this barcode, in a fixed order (no deadlocks),
  -- so two devices cannot both put away the last carton.
  select array_agg(id order by id) into v_ids from (
    select id from iq2.lines where warehouse_id=v_wh and carton_norm=v_norm order by id for update) x;

  select * into v_mv from iq2.movements where idem_key=p_idem;
  if found then
    if v_mv.kind<>'putaway' then
      return iq2.fail('IDEMPOTENCY_CONFLICT','Request key already used for a different operation.');
    end if;
    v_replay := true;
    select * into v_line from iq2.lines where id=v_mv.line_id;
    select * into v_loc from iq2.locations where id=v_mv.location_id;
  else
    select * into v_loc from iq2.locations where warehouse_id=v_wh and code_norm=iq2.loc_norm(p_location);
    if not found then
      -- A carton scanned where a location was expected: client switches.
      if exists (select 1 from iq2.lines where warehouse_id=v_wh and carton_norm=iq2.norm(p_location)) then
        return iq2.fail('CARTON_SCANNED','That is a carton, not a location. Nothing was moved.');
      end if;
      return iq2.reject(v_wh,'invalid_location','INVALID_LOCATION',
        'Not a registered IQ2 storage location. Nothing was moved.',p_location,p_device,p_actor);
    end if;
    if not v_loc.enabled then
      return iq2.reject(v_wh,'disabled_location','LOCATION_DISABLED',
        'Location '||v_loc.code||' is disabled. Choose another location. Nothing was moved.',
        p_location,p_device,p_actor,null,null,v_loc.id);
    end if;

    if v_ids is null then
      return iq2.reject(v_wh,'unknown_carton','UNKNOWN_CARTON',
        'This barcode is not on any inbound manifest. Nothing was moved.',p_code,p_device,p_actor);
    end if;
    select count(distinct (sku_id, units_per_carton)) into v_kinds from iq2.lines
     where id = any(v_ids) and received_cartons>putaway_cartons;
    if v_kinds = 0 then
      if exists (select 1 from iq2.lines where id = any(v_ids) and received_cartons>0) then
        return iq2.reject(v_wh,'already_putaway','ALREADY_PUT_AWAY',
          'Every received carton with this barcode is already put away. Nothing was moved.',p_code,p_device,p_actor);
      end if;
      return iq2.reject(v_wh,'not_received','NOT_RECEIVED',
        'This carton has not been received yet. Receive it first.',p_code,p_device,p_actor);
    end if;
    if v_kinds > 1 then
      return iq2.reject(v_wh,'ambiguous_carton','AMBIGUOUS_CARTON',
        'This barcode is received with different contents on more than one pallet. Set it aside for a lead.',
        p_code,p_device,p_actor);
    end if;

    -- The carton the worker was shown, if it still has cartons left;
    -- otherwise the oldest equivalent one.
    select * into v_line from iq2.lines
     where id=p_line_id and id = any(v_ids) and received_cartons>putaway_cartons;
    if not found then
      select l.* into v_line from iq2.lines l join iq2.pallets p on p.id=l.pallet_id
       where l.id = any(v_ids) and l.received_cartons>l.putaway_cartons
       order by p.first_received_at nulls last, p.created_at, l.row_number limit 1;
    end if;

    update iq2.lines set putaway_cartons = putaway_cartons + 1 where id=v_line.id returning * into v_line;
    insert into iq2.inventory(warehouse_id,location_id,sku_id,units,cartons)
    values (v_wh,v_loc.id,v_line.sku_id,v_line.units_per_carton,1)
    on conflict (location_id,sku_id) do update
      set units = iq2.inventory.units + excluded.units,
          cartons = iq2.inventory.cartons + 1, updated_at = now();
    insert into iq2.movements(warehouse_id,kind,idem_key,pallet_id,line_id,sku_id,scanned_code,
                              cartons,units,location_id,device_id,actor)
    values (v_wh,'putaway',p_idem,v_line.pallet_id,v_line.id,v_line.sku_id,left(p_code,200),
            1,v_line.units_per_carton,v_loc.id,left(p_device,100),left(p_actor,100));
  end if;

  select * into v_sku from iq2.skus where id=v_line.sku_id;
  select units into v_balance from iq2.inventory where location_id=v_loc.id and sku_id=v_line.sku_id;
  select coalesce(sum(received_cartons-putaway_cartons),0) into v_remaining from iq2.lines
   where warehouse_id=v_wh and carton_norm=v_line.carton_norm;
  return jsonb_build_object('ok',true,'code','PUT_AWAY','replay',v_replay,
    'carton_code',v_line.carton_code,'sku',v_sku.sku,'description',v_sku.description,
    'units',v_line.units_per_carton,'location_code',v_loc.code,
    'location_sku_units',coalesce(v_balance,0),'remaining_cartons',v_remaining);
end $$;

create or replace function public.iq2_location_contents(p_warehouse text, p_location text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_wh uuid := iq2.wh(p_warehouse); v_loc uuid;
begin
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','Unknown warehouse.'); end if;
  select id into v_loc from iq2.locations where warehouse_id=v_wh and code_norm=iq2.loc_norm(p_location);
  if v_loc is null then return iq2.fail('INVALID_LOCATION','Not a registered IQ2 storage location.'); end if;
  return jsonb_build_object('ok',true,'code','LOCATION','location',iq2.location_json(v_loc));
end $$;

-- ════════════════════════════════════════════════════════════════════
-- AUDIT — proves current balances agree with the append-only ledger
-- ════════════════════════════════════════════════════════════════════
create or replace function iq2.audit_mismatches(p_wh uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'inventory', coalesce((select jsonb_agg(x) from (
        select coalesce(i.location_id,m.location_id) as location_id, coalesce(i.sku_id,m.sku_id) as sku_id,
               coalesce(i.units,0) as balance_units, coalesce(m.units,0) as ledger_units,
               coalesce(i.cartons,0) as balance_cartons, coalesce(m.cartons,0) as ledger_cartons
          from (select * from iq2.inventory where warehouse_id=p_wh) i
          full join (select location_id, sku_id, sum(units) units, sum(cartons)::int cartons
                       from iq2.movements where warehouse_id=p_wh and kind='putaway'
                      group by location_id, sku_id) m
            on m.location_id=i.location_id and m.sku_id=i.sku_id
         where coalesce(i.units,0)<>coalesce(m.units,0) or coalesce(i.cartons,0)<>coalesce(m.cartons,0)) x),'[]'::jsonb),
    'lines', coalesce((select jsonb_agg(x) from (
        select l.id as line_id, l.received_cartons, l.putaway_cartons,
               coalesce(r.c,0) as ledger_received, coalesce(p.c,0) as ledger_putaway,
               coalesce(r.u,0) as ledger_received_units,
               l.received_cartons::bigint*l.units_per_carton as expected_received_units
          from iq2.lines l
          left join (select line_id, sum(cartons) c, sum(units) u from iq2.movements where kind='receive' group by line_id) r on r.line_id=l.id
          left join (select line_id, sum(cartons) c from iq2.movements where kind='putaway' group by line_id) p on p.line_id=l.id
         where l.warehouse_id=p_wh
           and (l.received_cartons<>coalesce(r.c,0) or l.putaway_cartons<>coalesce(p.c,0)
                or coalesce(r.u,0)<>l.received_cartons::bigint*l.units_per_carton)) x),'[]'::jsonb))
$$;

-- ════════════════════════════════════════════════════════════════════
-- PUBLIC API — ADMIN (requires IQ2 admin key)
-- ════════════════════════════════════════════════════════════════════

create or replace function public.iq2_admin_create_warehouse(p_key text, p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_code text := iq2.norm(p_code);
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then
    return iq2.fail('BAD_CODE','Warehouse code: letters, digits, - or _, up to 32 characters.');
  end if;
  if coalesce(btrim(p_name),'')='' then return iq2.fail('BAD_NAME','Warehouse name is required.'); end if;
  insert into iq2.warehouses(code,name) values (v_code,btrim(p_name))
  on conflict (code) do update set name=excluded.name;
  return jsonb_build_object('ok',true,'code','WAREHOUSE','warehouse',v_code);
end $$;

-- Manifest/ASN import. p_rows is an array of objects, one per CSV data row:
--   {row, load_ref, pallet, carton_barcode, sku, description, units_per_carton, cartons}
-- All-or-nothing: any error rejects the whole file with every problem listed.
create or replace function public.iq2_admin_import_manifest(
  p_key text, p_warehouse text, p_source_name text, p_rows jsonb, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_hash text;
  v_manifest uuid;
  v_count integer;
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','Unknown warehouse.'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return iq2.fail('EMPTY','The manifest has no data rows.');
  end if;
  if jsonb_array_length(p_rows) > 20000 then return iq2.fail('TOO_LARGE','Split manifests over 20,000 rows.'); end if;

  drop table if exists _r;
  create temp table _r on commit drop as
  select coalesce((r->>'row')::int, ord::int + 1) as row_number,
         nullif(btrim(r->>'load_ref'),'')        as load_ref,
         nullif(btrim(r->>'pallet'),'')          as pallet,
         iq2.norm(r->>'pallet')                  as pallet_norm,
         nullif(btrim(r->>'carton_barcode'),'')  as carton,
         iq2.norm(r->>'carton_barcode')          as carton_norm,
         nullif(btrim(r->>'sku'),'')             as sku,
         coalesce(btrim(r->>'description'),'')   as description,
         btrim(coalesce(r->>'units_per_carton','')) as upc_raw,
         btrim(coalesce(r->>'cartons',''))          as cartons_raw
    from jsonb_array_elements(p_rows) with ordinality as t(r, ord);

  -- Row-level checks
  select v_errors || coalesce(jsonb_agg(e order by (e->>'row')::int),'[]'::jsonb) into v_errors from (
    select jsonb_build_object('row',row_number,'field',f,'message',m) e from _r,
      lateral (values
        ('load_ref',        case when load_ref is null then 'Load reference is required.' end),
        ('pallet',          case when pallet is null then 'Pallet barcode is required.'
                                 when length(pallet)>200 then 'Pallet barcode is too long.' end),
        ('carton_barcode',  case when carton is null then 'Carton barcode is required.'
                                 when length(carton)>200 then 'Carton barcode is too long.' end),
        ('sku',             case when sku is null then 'SKU is required.' end),
        ('units_per_carton',case when upc_raw !~ '^[0-9]{1,7}$' or upc_raw::int < 1
                                 then 'Units per carton must be a whole number of at least 1 (got "'||upc_raw||'").' end),
        ('cartons',         case when cartons_raw !~ '^[0-9]{1,6}$' or cartons_raw::int < 1
                                 then 'Carton quantity must be a whole number of at least 1 (got "'||cartons_raw||'").' end)
      ) v(f,m) where m is not null) x;

  -- Same carton barcode twice on one pallet
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',rows[2],'field','carton_barcode',
     'message','Carton barcode '||carton||' appears more than once on pallet '||pallet||' (rows '||array_to_string(rows,', ')||'). List it once with the total carton quantity.')),'[]'::jsonb)
    into v_errors from (
      select min(carton) carton, min(pallet) pallet, array_agg(row_number order by row_number) rows
        from _r where pallet_norm is not null and carton_norm is not null
       group by pallet_norm, carton_norm having count(*)>1) d;

  -- One pallet, two load references
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','load_ref',
     'message','Pallet '||pallet||' is listed under more than one load reference ('||refs||').')),'[]'::jsonb)
    into v_errors from (
      select min(pallet) pallet, min(row_number) r, string_agg(distinct load_ref, ', ') refs
        from _r where pallet_norm is not null and load_ref is not null
       group by pallet_norm having count(distinct load_ref)>1) d;

  -- One barcode meaning two different things (SKU or units per carton)
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','carton_barcode',
     'message','Carton barcode '||carton||' is listed with different contents (SKU/units per carton) on rows '||rows||'.')),'[]'::jsonb)
    into v_errors from (
      select min(carton) carton, min(row_number) r, string_agg(row_number::text, ', ' order by row_number) rows
        from _r where carton_norm is not null and sku is not null and upc_raw ~ '^[0-9]{1,7}$'
       group by carton_norm having count(distinct (sku, upc_raw::int))>1) d;

  -- One SKU with two descriptions
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','description',
     'message','SKU '||sku||' has different descriptions on rows '||rows||'.')),'[]'::jsonb)
    into v_errors from (
      select sku, min(row_number) r, string_agg(row_number::text, ', ' order by row_number) rows
        from _r where sku is not null group by sku having count(distinct description)>1) d;

  -- Against what is already on file
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','pallet',
     'message','Pallet '||pallet||' is already on file and not closed. It cannot be imported twice.')),'[]'::jsonb)
    into v_errors from (
      select min(r.pallet) pallet, min(r.row_number) r from _r r
       where exists (select 1 from iq2.pallets p where p.warehouse_id=v_wh and p.pallet_norm=r.pallet_norm and p.status<>'closed')
       group by r.pallet_norm) d;

  -- A barcode already live (on an open pallet, or received and not yet put
  -- away) must keep meaning the same contents.
  select v_errors || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','carton_barcode',
     'message','Carton barcode '||carton||' is already on file with different contents (SKU '||old_sku||', '||old_upc||' per carton).')),'[]'::jsonb)
    into v_errors from (
      select distinct on (r.carton_norm) r.carton, r.row_number r, s.sku old_sku, l.units_per_carton old_upc
        from _r r
        join iq2.lines l on l.warehouse_id=v_wh and l.carton_norm=r.carton_norm
        join iq2.skus s on s.id=l.sku_id
        join iq2.pallets p on p.id=l.pallet_id
       where r.sku is not null and r.upc_raw ~ '^[0-9]{1,7}$'
         and (p.status<>'closed' or l.received_cartons>l.putaway_cartons)
         and (s.sku<>r.sku or l.units_per_carton<>r.upc_raw::int)
       order by r.carton_norm, r.row_number) d;

  select v_warnings || coalesce(jsonb_agg(jsonb_build_object('row',r,'field','description',
     'message','SKU '||sku||' is already on file as "'||old||'"; the existing description is kept.')),'[]'::jsonb)
    into v_warnings from (
      select r.sku, min(r.row_number) r, min(s.description) old from _r r
        join iq2.skus s on s.warehouse_id=v_wh and s.sku=r.sku
       where r.description<>'' and s.description<>r.description group by r.sku) d;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok',false,'code','INVALID_MANIFEST','message','Nothing was imported.',
                              'errors',v_errors,'warnings',v_warnings);
  end if;

  select md5(string_agg(concat_ws('|',load_ref,pallet_norm,carton_norm,sku,description,upc_raw,cartons_raw),E'\n'
                        order by pallet_norm,carton_norm)) into v_hash from _r;
  if exists (select 1 from iq2.manifests where warehouse_id=v_wh and content_hash=v_hash) then
    return jsonb_build_object('ok',false,'code','DUPLICATE_MANIFEST',
      'message','This exact manifest was already imported. Nothing was imported.','errors','[]'::jsonb);
  end if;

  insert into iq2.manifests(warehouse_id,source_name,content_hash,load_refs,row_count,pallet_count,
                            expected_cartons,expected_units,imported_by)
  select v_wh,left(p_source_name,200),v_hash,array_agg(distinct load_ref),count(*),count(distinct pallet_norm),
         sum(cartons_raw::int),sum(cartons_raw::bigint*upc_raw::int),left(p_actor,100)
    from _r returning id into v_manifest;

  insert into iq2.skus(warehouse_id,sku,description)
  select distinct on (sku) v_wh, sku, description from _r order by sku, row_number
  on conflict (warehouse_id,sku) do nothing;

  insert into iq2.pallets(warehouse_id,manifest_id,load_ref,pallet_code,pallet_norm)
  select distinct on (pallet_norm) v_wh, v_manifest, load_ref, pallet, pallet_norm
    from _r order by pallet_norm, row_number;

  insert into iq2.lines(warehouse_id,pallet_id,row_number,carton_code,carton_norm,sku_id,units_per_carton,expected_cartons)
  select v_wh, p.id, r.row_number, r.carton, r.carton_norm, s.id, r.upc_raw::int, r.cartons_raw::int
    from _r r
    join iq2.pallets p on p.manifest_id=v_manifest and p.pallet_norm=r.pallet_norm
    join iq2.skus s on s.warehouse_id=v_wh and s.sku=r.sku;
  get diagnostics v_count = row_count;

  return jsonb_build_object('ok',true,'code','IMPORTED','manifest_id',v_manifest,'lines',v_count,
    'pallets',(select pallet_count from iq2.manifests where id=v_manifest),
    'expected_cartons',(select expected_cartons from iq2.manifests where id=v_manifest),
    'expected_units',(select expected_units from iq2.manifests where id=v_manifest),
    'warnings',v_warnings);
end $$;

-- Location registry import/update. rows: {row, code, aisle, bay, shelf, enabled}
create or replace function public.iq2_admin_import_locations(
  p_key text, p_warehouse text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_wh uuid := iq2.wh(p_warehouse);
  v_errors jsonb;
  v_count integer;
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','Unknown warehouse.'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return iq2.fail('EMPTY','The location list has no data rows.');
  end if;

  drop table if exists _l;
  create temp table _l on commit drop as
  select coalesce((r->>'row')::int, ord::int + 1) as row_number,
         iq2.loc_norm(r->>'code') as code,
         nullif(btrim(r->>'aisle'),'') aisle, nullif(btrim(r->>'bay'),'') bay, nullif(btrim(r->>'shelf'),'') shelf,
         lower(coalesce(nullif(btrim(r->>'enabled'),''),'true')) as enabled_raw
    from jsonb_array_elements(p_rows) with ordinality as t(r, ord);

  select coalesce(jsonb_agg(e order by (e->>'row')::int),'[]'::jsonb) into v_errors from (
    select jsonb_build_object('row',row_number,'field','code','message',
             'Location code is required: letters, digits, - _ . / only, up to 40 characters.') e
      from _l where code is null or code !~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'
    union all
    select jsonb_build_object('row',row_number,'field','enabled','message','Enabled must be true/false/yes/no/1/0.')
      from _l where enabled_raw not in ('true','false','yes','no','1','0','y','n')
    union all
    select jsonb_build_object('row',max(row_number),'field','code','message','Location '||code||' is listed more than once.')
      from _l where code is not null group by code having count(*)>1) x;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok',false,'code','INVALID_LOCATIONS','message','Nothing was imported.','errors',v_errors);
  end if;

  insert into iq2.locations(warehouse_id,code,code_norm,aisle,bay,shelf,enabled)
  select v_wh, code, code, aisle, bay, shelf, enabled_raw in ('true','yes','1','y') from _l
  on conflict (warehouse_id,code_norm) do update
    set aisle=excluded.aisle, bay=excluded.bay, shelf=excluded.shelf,
        enabled=excluded.enabled, updated_at=now();
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'code','LOCATIONS_SAVED','locations',v_count);
end $$;

create or replace function public.iq2_admin_set_location_enabled(
  p_key text, p_warehouse text, p_location text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_wh uuid := iq2.wh(p_warehouse); v_code text;
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  update iq2.locations set enabled=p_enabled, updated_at=now()
   where warehouse_id=v_wh and code_norm=iq2.loc_norm(p_location) returning code into v_code;
  if v_code is null then return iq2.fail('INVALID_LOCATION','Not a registered IQ2 storage location.'); end if;
  return jsonb_build_object('ok',true,'code','LOCATION_UPDATED','location',v_code,'enabled',p_enabled);
end $$;

-- Everything the back office needs to see, in one read.
create or replace function public.iq2_admin_report(p_key text, p_warehouse text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_wh uuid := iq2.wh(p_warehouse);
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','Unknown warehouse.'); end if;
  return jsonb_build_object('ok',true,'code','REPORT',
    'pallets', coalesce((select jsonb_agg(iq2.pallet_summary(id) order by created_at desc)
                          from (select id, created_at from iq2.pallets where warehouse_id=v_wh
                                 order by created_at desc limit 200) p),'[]'::jsonb),
    'awaiting_putaway', coalesce((select jsonb_agg(jsonb_build_object('carton_code',l.carton_code,'sku',s.sku,
        'description',s.description,'units_per_carton',l.units_per_carton,
        'cartons',l.received_cartons-l.putaway_cartons,
        'units',(l.received_cartons-l.putaway_cartons)::bigint*l.units_per_carton,'pallet',p.pallet_code)
        order by p.pallet_code, l.row_number)
      from iq2.lines l join iq2.skus s on s.id=l.sku_id join iq2.pallets p on p.id=l.pallet_id
      where l.warehouse_id=v_wh and l.received_cartons>l.putaway_cartons),'[]'::jsonb),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('location',lo.code,'sku',s.sku,
        'description',s.description,'units',i.units,'cartons',i.cartons) order by lo.code, s.sku)
      from iq2.inventory i join iq2.locations lo on lo.id=i.location_id join iq2.skus s on s.id=i.sku_id
      where i.warehouse_id=v_wh and i.units>0),'[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('code',code,'aisle',aisle,'bay',bay,
        'shelf',shelf,'enabled',enabled) order by code) from iq2.locations where warehouse_id=v_wh),'[]'::jsonb),
    'movements', coalesce((select jsonb_agg(x order by x.id desc) from (
        select m.id, m.kind, m.occurred_at, m.scanned_code, s.sku, m.cartons, m.units,
               p.pallet_code, p.load_ref, lo.code as location, m.actor, m.device_id
          from iq2.movements m join iq2.skus s on s.id=m.sku_id join iq2.pallets p on p.id=m.pallet_id
          left join iq2.locations lo on lo.id=m.location_id
         where m.warehouse_id=v_wh order by m.id desc limit 300) x),'[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(x order by x.id desc) from (
        select e.id, e.kind, e.occurred_at, e.scanned_code, e.detail, e.expected_cartons, e.actual_cartons,
               p.pallet_code, e.actor, e.device_id, e.resolved_at
          from iq2.exceptions e left join iq2.pallets p on p.id=e.pallet_id
         where e.warehouse_id=v_wh order by e.id desc limit 300) x),'[]'::jsonb),
    'audit', iq2.audit_mismatches(v_wh));
end $$;

create or replace function public.iq2_admin_audit(p_key text, p_warehouse text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_wh uuid := iq2.wh(p_warehouse); v_m jsonb;
begin
  if not iq2.is_admin(p_key) then return iq2.fail('NOT_AUTHORIZED','IQ2 admin key required.'); end if;
  if v_wh is null then return iq2.fail('UNKNOWN_WAREHOUSE','Unknown warehouse.'); end if;
  v_m := iq2.audit_mismatches(v_wh);
  return jsonb_build_object('ok',true,'code','AUDIT',
    'balanced', jsonb_array_length(v_m->'inventory')=0 and jsonb_array_length(v_m->'lines')=0,
    'mismatches', v_m);
end $$;

-- ── privileges: functions are the only door ─────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname like 'iq2\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='iq2'
  loop
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

commit;
