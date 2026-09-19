import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
export async function database(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create table public.organizations(id uuid primary key,name text,slug text,access_code text);create table public.drivers(id uuid primary key,org_id uuid,name text,phone text);create table public.jobs(id uuid primary key default gen_random_uuid(),org_id uuid,title text,status text,driver_name text,assigned_driver_id uuid,job_type text,surge_stops jsonb,bin_label text,total_stops integer,total_packages integer,stops_completed integer,staged_at timestamptz,picked_up_at timestamptz,started_at timestamptz,delivered_at timestamptz,created_at timestamptz default now(),pickup_address text,dropoff_address text,master_code text,archived boolean default false);`);
 for(const name of fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).sort())await db.exec(fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8').replace(/^\uFEFF/,''));
 return db;
}
