// A local stand-in for TackPath's production database AS IT IS TODAY
// (before hardening): Supabase roles, pgcrypto in schema extensions, the
// storage schema, the live tables with the anon key granted everything and
// always-true RLS policies, a public "pod" bucket, and a publish_surge_route
// gate. Columns are what the live pages read and write.
//
// The security migrations run on top of this, so the tests prove both that
// the lockdown closes the holes and that every flow still works.
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SEC = new URL('../../supabase/security/', import.meta.url);
export const sqlFile = (name) => fs.readFileSync(new URL(name, SEC), 'utf8');

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const ORG_REVIEW = '33333333-3333-4333-8333-333333333333';

export const TODAY = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator nologin;
grant anon, authenticated, service_role to postgres;
create schema extensions; create extension pgcrypto schema extensions;
grant usage on schema public to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
insert into storage.buckets (id, name, public) values ('pod', 'pod', true), ('avatars', 'avatars', true);
create policy "pod public read" on storage.objects for select to public using (bucket_id = 'pod');
create policy "pod anon upload" on storage.objects for insert to anon with check (bucket_id = 'pod');
create policy "pod anon update" on storage.objects for update to anon using (bucket_id = 'pod');
create policy "avatars read" on storage.objects for select to public using (bucket_id = 'avatars');
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

create table public.organizations (id uuid primary key default gen_random_uuid(), name text, slug text unique,
  access_code text, created_at timestamptz default now());
create table public.drivers (id uuid primary key default gen_random_uuid(), name text, phone text,
  sms_consent boolean default false, status text, date_of_birth date, vehicle text, org_id uuid,
  created_at timestamptz default now());
create table public.jobs (id uuid primary key default gen_random_uuid(), org_id uuid, title text, status text,
  driver_name text, job_type text, surge_stops jsonb, stops_completed integer default 0, total_stops integer,
  total_packages integer, bin_label text, staged_at timestamptz, picked_up_at timestamptz, archived boolean default false,
  exception_flag boolean default false, estimated_delivery_at timestamptz, original_eta_at timestamptz,
  pickup_address text, dropoff_address text, price numeric, distance_miles numeric, route_summary text,
  customer_confirmed boolean, driver_rating integer, master_code text, source text, created_at timestamptz default now());
create table public.messages (id bigserial primary key, job_id uuid, sender text, sender_role text, body text,
  created_at timestamptz default now());
create table public.driver_locations (driver_name text primary key, name text, job_id uuid, lat double precision,
  lng double precision, accuracy double precision, speed double precision, updated_at timestamptz default now());
create table public.driver_fcm_tokens (phone text primary key, driver_name text, token text, updated_at timestamptz);
create table public.agent_memory (id bigserial primary key, agent_name text, event_type text, job_id uuid,
  driver_name text, details jsonb, org_id uuid, created_at timestamptz default now());
create table public.shopify_connections (id bigserial primary key, org_id uuid, shop_domain text, access_token text,
  active boolean, auto_dispatch boolean, created_at timestamptz default now());
create table public.bin_bindings (id uuid primary key default gen_random_uuid(), org_id uuid, bin_code text not null,
  location_code text, job_id uuid references public.jobs(id) on delete cascade, state text not null default 'open',
  opened_by text, opened_at timestamptz not null default now(), ready_at timestamptz, released_at timestamptz);
create unique index bin_one_live_per_job on public.bin_bindings (job_id) where state in ('open','ready');
create table public.events (id bigserial primary key, org_id uuid, event_type text not null, job_id uuid,
  driver_name text, actor text, device_id text, payload jsonb not null default '{}', idempotency_key text,
  occurred_at timestamptz not null default now(), recorded_at timestamptz not null default now());
create unique index events_idem on public.events (idempotency_key) where idempotency_key is not null;
create view public.bin_shortfall as
  select org_id, count(*) as missing from public.jobs where bin_label is null and status = 'pending' group by org_id;
create table public.invoices (id bigserial primary key, org_id uuid, amount numeric);
create table public.work_items (id bigserial primary key, title text);

-- the route publication gate (security invoker, as the anon key calls it today)
create function public.publish_surge_route(payload jsonb) returns jsonb language plpgsql as $$
declare r public.jobs;
begin
  select * into r from public.jobs where master_code = payload->>'master_code';
  if found then return jsonb_build_object('ok', true, 'job', to_jsonb(r), 'existing', true); end if;
  insert into public.jobs (title, status, job_type, org_id, surge_stops, master_code, total_stops)
  values (payload->>'title', 'pending', 'surge', (payload->>'org_id')::uuid, payload->'surge_stops',
          payload->>'master_code', jsonb_array_length(coalesce(payload->'surge_stops','[]')))
  returning * into r;
  return jsonb_build_object('ok', true, 'job', to_jsonb(r));
end $$;
create function public.increment_address_failures(p text) returns void language sql as $$ select $$;

-- Today: RLS on with always-true policies, everything granted to anon.
do $$ declare t text; begin
  foreach t in array array['organizations','drivers','jobs','messages','driver_locations','driver_fcm_tokens',
                           'agent_memory','shopify_connections','bin_bindings','events','invoices','work_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "allow all" on public.%I for all using (true) with check (true)', t);
  end loop;
end $$;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

insert into public.organizations (id, name, slug, access_code) values
  ('${ORG_A}', 'Quick Haul', 'quickhaul', 'qh-portal-2026'),
  ('${ORG_B}', 'Other Co', 'otherco', null),
  ('${ORG_REVIEW}', 'TackPath Review', 'tackpath-review', null);
insert into public.drivers (name, phone, sms_consent, status, org_id) values
  ('Dana Driver', '(404) 555-1234', true, null, '${ORG_A}'),
  ('Ned NoConsent', '4045551235', false, 'active', '${ORG_A}'),
  ('Pat Pending', '4045551236', true, 'pending_approval', null),
  ('Ollie Other', '6785550000', true, 'active', '${ORG_B}'),
  ('Rita Reviewer', '4045550199', false, 'active', '${ORG_REVIEW}');
`;

export async function freshDb({ migrate = [] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(TODAY);
  for (const f of migrate) await db.exec(sqlFile(f));
  return db;
}

// Run one statement as a Supabase API role (anon = the public key).
export async function as(db, role, sql, params = []) {
  await db.exec(`set role ${role}`);
  try { return await db.query(sql, params); }
  finally { await db.exec('reset role'); }
}

// Call an RPC the way PostgREST does (named arguments, as the given role).
export async function rpc(db, fn, args = {}, role = 'anon') {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
  const res = await as(db, role, sql, vals);
  return res.rows[0].r;
}

export async function rpcError(db, fn, args = {}, role = 'anon') {
  try { await rpc(db, fn, args, role); } catch (e) { return e.message; }
  return null;
}
