// Shared IQ2 test infrastructure.
//
// Boots the real IQ2 migration into an in-process Postgres (PGlite) and
// exposes `rpc(name,args)`, which calls public.iq2_* exactly the way
// PostgREST does (named arguments, typed by the function signature). The
// jsdom UI tests route iq2.html's fetch() through the same adapter, so the
// page is exercised against the real SQL, not a mock of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase/schema/005_iq2_inbound.sql'), 'utf8');
export const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures/iq2', name), 'utf8');
export const ADMIN_KEY = 'test-admin-key-123';

// Creates the roles Supabase provides, then the migration.
export async function prepare(db) {
  await db.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;`);
  await (db.exec ? db.exec(SCHEMA) : db.query(SCHEMA));   // PGlite or node-postgres
  await db.query(`insert into iq2.admin_keys(key_hash,label)
                  values (encode(sha256(convert_to($1,'UTF8')),'hex'),'tests')`, [ADMIN_KEY]);
}

export async function makeRpc(db) {
  const res = await db.query(`
    select p.proname as name, p.proargnames as names,
           array(select format_type(t,null) from unnest(p.proargtypes::oid[]) t) as types
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'iq2\\_%'`);
  const sigs = {};
  for (const r of res.rows) sigs[r.name] = { names: r.names || [], types: r.types || [] };
  const rpc = async (name, args = {}) => {
    const s = sigs[name];
    if (!s) throw new Error('No such IQ2 function: ' + name);
    const parts = [], vals = [];
    for (const [k, v] of Object.entries(args)) {
      const i = s.names.indexOf(k);
      if (i < 0) throw new Error(name + ' has no argument ' + k);
      vals.push(v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v));
      parts.push(`${k} => $${vals.length}::${s.types[i]}`);
    }
    const r = await db.query(`select public.${name}(${parts.join(', ')}) as r`, vals);
    const out = r.rows[0].r;
    return typeof out === 'string' ? JSON.parse(out) : out;
  };
  rpc.sigs = sigs;
  return rpc;
}

export async function freshDb() {
  const db = new PGlite();
  await prepare(db);
  const rpc = await makeRpc(db);
  return { db, rpc };
}

// Loads the realistic mixed manifest + location registry into warehouse MAIN.
export async function seed(rpc, mod) {
  let r = await rpc('iq2_admin_create_warehouse', { p_key: ADMIN_KEY, p_code: 'MAIN', p_name: 'Main DC' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const m = mod.parseManifest(fixture('manifest-mixed.csv'));
  r = await rpc('iq2_admin_import_manifest', { p_key: ADMIN_KEY, p_warehouse: 'MAIN', p_source_name: 'manifest-mixed.csv', p_rows: m.rows });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const l = mod.parseLocations(fixture('locations.csv'));
  r = await rpc('iq2_admin_import_locations', { p_key: ADMIN_KEY, p_warehouse: 'MAIN', p_rows: l.rows });
  if (!r.ok) throw new Error(JSON.stringify(r));
}

let n = 0;
export const idem = () => 'test-' + process.pid + '-' + (++n) + '-' + Math.random().toString(36).slice(2, 10);

export async function scalar(db, sql, params) {
  const r = await db.query(sql, params);
  const row = r.rows[0];
  return row ? Object.values(row)[0] : undefined;
}
