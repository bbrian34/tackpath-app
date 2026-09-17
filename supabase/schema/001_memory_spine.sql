-- ════════════════════════════════════════════════════════════════════════
-- TackPath Memory Spine — migration 001
--
-- ADDITIVE ONLY. This migration creates new tables and touches nothing that
-- currently works. jobs, messages, drivers, driver_locations, agent_memory
-- and organizations are not altered, not renamed, and not dropped.
--
-- Rollback is a plain DROP of the four new objects. Nothing existing breaks.
--
-- Purpose: TackPath already emits structured operational events -- they are
-- encoded as STOP_DELIVERED:: / STOP_DRIFT:: / SMARTTRACK:: strings inside
-- the messages table. This gives those events a real home so they can be
-- indexed, joined, aggregated and reasoned over, and gives packages and
-- addresses an identity that outlives a single SmartSort run.
-- ════════════════════════════════════════════════════════════════════════

-- ── ADDRESSES ───────────────────────────────────────────────────────────
-- Operational knowledge about a physical location.
--
-- PRIVACY BOUNDARY: this table deliberately contains NO recipient name, no
-- customer identity, no package contents. It holds only facts about the
-- place itself. That boundary is what makes address intelligence safe to
-- aggregate later; personal data lives on packages, scoped to one org.
create table if not exists addresses (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references organizations(id) on delete cascade,
  normalized_address text        not null,
  lat                double precision,
  lng                double precision,
  geocode_precision  text,                      -- ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
  geocode_attempts   integer     not null default 0,
  geocode_failures   integer     not null default 0,
  last_verified_at   timestamptz,
  corrected_from     text,                      -- the original string that failed, when a correction worked
  avg_dwell_seconds  integer,                   -- learned from driver_locations + delivery events
  dwell_sample_size  integer     not null default 0,
  delivery_attempts  integer     not null default 0,
  first_attempt_successes integer not null default 0,
  access_notes       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One row per address per org. This is what makes Marco's cache real and
-- shared instead of dying with a browser tab.
create unique index if not exists addresses_org_norm_uniq
  on addresses (org_id, normalized_address);

-- Confidence gate for learned dwell: never trust a tiny sample.
-- Readers should use avg_dwell_seconds only when dwell_sample_size >= 5,
-- and fall back to the existing 4-minute baseline otherwise.
create index if not exists addresses_dwell_confident
  on addresses (org_id) where dwell_sample_size >= 5;

create index if not exists addresses_failing
  on addresses (org_id, geocode_failures) where geocode_failures > 0;


-- ── PACKAGES ────────────────────────────────────────────────────────────
-- A package that exists independently of today's route.
--
-- Identity rule: tracking_number (falling back to order_id) is the stable
-- real-world identity. smart_id is NOT identity -- it is recomputed from
-- stop position on every SmartSort run. A SmartSort rerun must update
-- current_* fields on an existing row, never insert a new conceptual package.
create table if not exists packages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references organizations(id) on delete cascade,
  tracking_number     text,
  order_id            text,
  recipient           text,
  raw_address         text,
  normalized_address  text,
  address_id          uuid references addresses(id) on delete set null,

  -- Current position in the operation. Denormalized for fast reads;
  -- always reconstructible from events.
  current_job_id      uuid references jobs(id) on delete set null,
  current_stop_number integer,
  current_bin         text,
  current_state       text not null default 'manifested',

  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint packages_state_valid check (current_state in
    ('manifested','geocoded','geocode_failed','sorted','stowed','staged',
     'loaded','out_for_delivery','delivered','problem','exception','cancelled')),
  constraint packages_has_identity check
    (coalesce(tracking_number, order_id) is not null)
);

-- The stable-identity constraint. coalesce mirrors the lookup order already
-- used by PathIQ's binMap, so the database agrees with the scanner.
create unique index if not exists packages_org_identity_uniq
  on packages (org_id, coalesce(tracking_number, order_id));

create index if not exists packages_current_job on packages (current_job_id);
create index if not exists packages_bin          on packages (org_id, current_bin)
  where current_bin is not null;
create index if not exists packages_state        on packages (org_id, current_state);
create index if not exists packages_address      on packages (address_id);


-- ── EVENTS ──────────────────────────────────────────────────────────────
-- Append-only operational history. Never updated, never deleted.
-- This is the spine everything else hangs from.
create table if not exists events (
  id              bigserial primary key,
  org_id          uuid references organizations(id) on delete cascade,

  occurred_at     timestamptz not null default now(),  -- when it happened in the world
  recorded_at     timestamptz not null default now(),  -- when TackPath heard about it
                                                        -- (these differ for offline replay)

  event_type      text not null,
  package_id      uuid references packages(id) on delete set null,
  job_id          uuid references jobs(id)     on delete set null,
  driver_name     text,
  actor           text,        -- worker, driver, dispatcher, or agent name
  device_id       text,
  payload         jsonb not null default '{}'::jsonb,

  idempotency_key text
);

-- ── THE MOST IMPORTANT LINE IN THIS MIGRATION ──
-- A duplicate scanner broadcast, a double tap, a retry after a dropped
-- connection, or a replayed offline queue all produce the same key, and
-- Postgres rejects the second insert. This is the guarantee that currently
-- lives in a JavaScript Set which is wiped every 5 seconds by the polling
-- loop in stow.html. It belongs here instead.
create unique index if not exists events_idempotency_uniq
  on events (idempotency_key) where idempotency_key is not null;

create index if not exists events_package  on events (package_id, occurred_at desc);
create index if not exists events_job      on events (job_id, occurred_at desc);
create index if not exists events_type_time on events (org_id, event_type, occurred_at desc);
create index if not exists events_driver   on events (org_id, driver_name, occurred_at desc)
  where driver_name is not null;
create index if not exists events_payload  on events using gin (payload);

-- Append-only enforced at the database, not by convention.
create or replace function events_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'events is append-only: % is not permitted', tg_op;
end $$;

drop trigger if exists events_no_update on events;
create trigger events_no_update before update or delete on events
  for each row execute function events_block_mutation();


-- ── EVENT VOCABULARY ────────────────────────────────────────────────────
-- Not enforced as a constraint yet, deliberately: during dual-write we want
-- writers to be able to add a type without a migration. Tighten later once
-- the vocabulary has settled.
--
--   package.manifested      package.geocoded       package.geocode_failed
--   package.scanned         package.stowed         package.mis_scanned
--   package.problem_opened  package.inducted       package.loaded
--   package.delivered       package.undelivered
--   bin.assigned            bin.completed          bin.reset
--   route.staged            route.accepted         route.started
--   stop.arrived            stop.delivered
--   exception.opened        exception.escalated    exception.acknowledged
--   exception.recovering    exception.resolved
--   geocode.corrected       address.access_noted


-- ── DERIVED TRUTH ───────────────────────────────────────────────────────
-- Bin state becomes recoverable instead of living in a JS variable. A device
-- refresh, a second device, or a dispatcher opening five minutes later all
-- read the same reality from here.
--
-- Deliberately a view, not a table: during dual-write there is no second
-- copy of the truth to drift out of sync.
create or replace view bin_state as
with last_bin_event as (
  select distinct on (org_id, payload->>'bin')
         org_id,
         payload->>'bin'  as bin,
         event_type,
         occurred_at,
         job_id
  from events
  where event_type in ('bin.assigned','bin.completed','bin.reset')
    and payload ? 'bin'
  order by org_id, payload->>'bin', occurred_at desc
)
select
  lb.org_id,
  lb.bin,
  lb.job_id,
  lb.event_type                          as last_action,
  lb.occurred_at                         as last_action_at,
  (lb.event_type = 'bin.completed')      as is_staged,
  count(p.id) filter (where p.current_state in ('stowed','staged','loaded')) as packages_present
from last_bin_event lb
left join packages p
  on p.org_id = lb.org_id and p.current_bin = lb.bin
group by lb.org_id, lb.bin, lb.job_id, lb.event_type, lb.occurred_at;


-- Bin shortfall: the fact worth knowing before the van doors close.
create or replace view bin_shortfall as
select
  j.org_id,
  j.id                                   as job_id,
  j.title,
  j.bin_label                            as bin,
  jsonb_array_length(
    case jsonb_typeof(j.surge_stops) when 'array' then j.surge_stops else '[]'::jsonb end
  )                                      as expected_packages,
  count(p.id) filter (where p.current_state in ('stowed','staged','loaded')) as stowed_packages,
  count(p.id) filter (where p.current_state = 'problem')                     as in_problem
from jobs j
left join packages p on p.current_job_id = j.id
where j.status in ('pending','assigned','in_transit')
group by j.org_id, j.id, j.title, j.bin_label, j.surge_stops;


-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────
-- Matches the posture already used on jobs. Tighten to real org membership
-- once auth claims carry org_id; the important part today is that these
-- tables are not open by default.
alter table addresses enable row level security;
alter table packages  enable row level security;
alter table events    enable row level security;

drop policy if exists addresses_rw on addresses;
create policy addresses_rw on addresses for all
  using (true) with check (true);

drop policy if exists packages_rw on packages;
create policy packages_rw on packages for all
  using (true) with check (true);

-- Events are insert-and-read only from the client. No update path exists.
drop policy if exists events_insert on events;
create policy events_insert on events for insert with check (true);

drop policy if exists events_select on events;
create policy events_select on events for select using (true);


-- ── PROOF OF DELIVERY STORAGE ───────────────────────────────────────────
-- The bucket the driver app now uploads to. Without this, POD uploads 404
-- and fall into the device retry queue instead of being stored.
insert into storage.buckets (id, name, public)
values ('pod', 'pod', true)
on conflict (id) do nothing;

drop policy if exists pod_upload on storage.objects;
create policy pod_upload on storage.objects for insert
  with check (bucket_id = 'pod');

drop policy if exists pod_read on storage.objects;
create policy pod_read on storage.objects for select
  using (bucket_id = 'pod');


-- ── updated_at maintenance ──────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists packages_touch on packages;
create trigger packages_touch before update on packages
  for each row execute function touch_updated_at();

drop trigger if exists addresses_touch on addresses;
create trigger addresses_touch before update on addresses
  for each row execute function touch_updated_at();


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--
--   drop view if exists bin_shortfall;
--   drop view if exists bin_state;
--   drop trigger if exists events_no_update on events;
--   drop table if exists events;
--   drop table if exists packages;
--   drop table if exists addresses;
--
-- Nothing in the existing application reads these objects yet, so rollback
-- is safe at any point before readers are migrated.
-- ════════════════════════════════════════════════════════════════════════
