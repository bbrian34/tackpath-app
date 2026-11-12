// Staging check for migration 72 on a real PostgreSQL server (not part of CI; needs a disposable server).
// Many dispatcher screens publishing at the same moment, all offering the same box:
// before 72 the box can end up on several routes; after 72 it is on exactly one, every other
// route is published without it, and the box is listed once per route under Needs attention.
// Then the rollback, and 72 again.
//   node security/_stage_box_by_box.mjs <admin-url> <keel-checkout>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TODAY, sqlFile, ORG_A } from './fixture.mjs';
const [ADMIN, KEEL] = process.argv.slice(2);
const pg = createRequire(KEEL + '/package.json')('pg');
const DB = 'tp_box_stage';
const SCREENS = 20;

const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
await admin.query(`drop database if exists ${DB} with (force)`); await admin.query(`create database ${DB}`);
for (const r of ['anon', 'authenticated', 'service_role', 'authenticator']) {
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin${r === 'service_role' ? ' bypassrls' : ''}; end if; end $$`);
}
await admin.query(`grant anon, authenticated, service_role to postgres`);
const url = ADMIN.replace(/\/postgres(\?|$)/, `/${DB}$1`);
const pool = new pg.Pool({ connectionString: url, max: SCREENS + 4 });
const one = async (sql, p) => (await pool.query(sql, p)).rows;
await one(TODAY.replace(/create role [^;]+;/g, '').replace(/grant anon, authenticated, service_role to postgres;/, ''));
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
await one('drop function public.publish_surge_route(jsonb);');
await one(RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length));
await one('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql', '71_keel_inbox.sql']) await one(sqlFile(f));

const asRole = async (role, sql, p) => { const c = await pool.connect(); try { await c.query('begin'); await c.query(`set local role ${role}`); const r = await c.query(sql, p); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };
const tok = (await asRole('anon', `select public.tp_org_sign_in('quickhaul', 'qh-portal-2026') as r`))[0].r.token;
const org = (action, args = {}) => asRole('anon', `select public.tp_org($1, $2, $3) as r`, [tok, action, JSON.stringify(args)]).then((r) => r[0].r);
const plan = (code, ids, partial) => ({ title: 'Surge Route ' + code, job_type: 'surge', master_code: code, total_stops: ids.length, total_packages: ids.length, ...(partial ? { partial: true } : {}),
  surge_stops: ids.map((id, i) => ({ stop_number: i + 1, packages: 1, pkgs: [{ order_id: 'O-' + id, piece_id: id, required_count: 1 }] })) });
const routesWith = async (box) => (await one(`select count(distinct j.id)::int n from public.jobs j, jsonb_array_elements(j.surge_stops) s, jsonb_array_elements(s->'pkgs') p
  where p->>'piece_id' = $1 and coalesce(j.archived, false) = false`, [box]))[0].n;
const burst = (prefix, partial) => Promise.allSettled(Array.from({ length: SCREENS }, (_, i) => org('publish_route', { payload: plan(`${prefix}-${i}`, [`${prefix}-SHARED`, `${prefix}-OWN-${i}`], partial) })));

// before 72: the race exists (whole-route gate, no lock)
let raced = 0;
for (let round = 0; round < 5 && !raced; round++) { await burst('OLD' + round, false); if (await routesWith(`OLD${round}-SHARED`) > 1) raced = await routesWith(`OLD${round}-SHARED`); }
console.log(raced ? `before 72: one box was put on ${raced} routes at once (the race)` : 'before 72: the race did not show in 5 rounds on this machine');
await one(`update public.jobs set archived = true`);

await one(sqlFile('72_box_by_box_publishing.sql'));
for (let round = 0; round < 5; round++) {
  const res = await burst('NEW' + round, true);
  const ok = res.filter((r) => r.status === 'fulfilled' && r.value.ok);
  assert.equal(ok.length, SCREENS, 'every screen published its route: ' + JSON.stringify(res.filter((r) => !(r.status === 'fulfilled' && r.value.ok)).slice(0, 2)));
  assert.equal(await routesWith(`NEW${round}-SHARED`), 1, 'the shared box is on exactly one route');
  assert.equal(ok.filter((r) => r.value.held.length === 0).length, 1, 'one screen got the box; every other was told it is held');
  for (let i = 0; i < SCREENS; i++) assert.equal(await routesWith(`NEW${round}-OWN-${i}`), 1, 'each screen\'s own box was published');
  const held = (await one(`select count(*)::int n from public.dispatch_attention where kind = 'piece_held' and piece_id = $1`, [`NEW${round}-SHARED`]))[0].n;
  assert.equal(held, SCREENS - 1, 'held once per route that offered it');
  // the same burst again: idempotent, nothing new
  await burst('NEW' + round, true);
  assert.equal((await one(`select count(*)::int n from public.jobs where master_code like $1`, [`NEW${round}-%`]))[0].n, SCREENS);
  assert.equal((await one(`select count(*)::int n from public.dispatch_attention where piece_id = $1`, [`NEW${round}-SHARED`]))[0].n, SCREENS - 1);
}
console.log(`after 72: 5 rounds of ${SCREENS} simultaneous screens: the shared box on exactly one route every time, every other box published, retries changed nothing`);

// another company is never locked out by this one, and never sees its items
await one(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
const tokB = (await asRole('anon', `select public.tp_org_sign_in('otherco', 'other-code-2026') as r`))[0].r.token;
const b = await asRole('anon', `select public.tp_org($1, 'attention', '{}') as r`, [tokB]);
assert.equal(b[0].r.items.length, 0);

await one(sqlFile('72_box_by_box_publishing.rollback.sql'));
assert.equal((await one(`select to_regclass('public.dispatch_attention') r`))[0].r, null);
await one(sqlFile('72_box_by_box_publishing.sql'));
console.log('rollback and re-apply on real data: ok');
await pool.end(); await admin.end();
console.log('STAGING CHECK 72 PASSED');
