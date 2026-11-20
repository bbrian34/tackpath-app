// A local stand-in for TackPath's server, for the product video only.
// It is the same one the security tests use: the real migrations
// (supabase/security) running in PGlite in this process, called the way
// PostgREST calls them, as the anon role. Nothing leaves the machine: every
// browser request is answered here (no real network, no real keys, no
// production data). Demo data only: a fictional company, driver and customers.
import { freshDb, sqlFile, rpc, ORG_A } from '../../tests/security/fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql',
  '61_staging_release_gaps.sql', '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql',
  '65_bins_self_heal.sql', '67_driver_staging_spot.sql', '68_job_timestamps.sql'];

export const ORG = { slug: 'quickhaul', code: 'qh-portal-2026', name: 'Quick Haul' };   // fictional demo company (fixture)
export const DRIVER = { name: 'Dana Reyes', phone: '4045551234' };
export const WORKER = 'Jamie Ortiz';  // the warehouse worker on PathIQ (made up)

export async function backend() {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  for (const f of CHAIN) await db.exec(sqlFile(f));
  await db.exec(`alter table public.jobs add column if not exists delivered_at timestamptz`);
  // demo data: one company, one driver; the fixture's other test rows are not shown
  await db.query(`delete from public.drivers where org_id is distinct from $1 or name <> 'Dana Driver'`, [ORG_A]);
  await db.query(`update public.drivers set name = $1, status = 'active' where name = 'Dana Driver'`, [DRIVER.name]);
  await db.query(`delete from public.organizations where id <> $1`, [ORG_A]);
  // one request at a time: the helper switches database roles per call
  let chain = Promise.resolve();
  const call = (fn, args, role = 'anon') => {
    const p = chain.then(() => rpc(db, fn, args, role));
    chain = p.catch(() => {});
    return p;
  };
  const driverCode = async () => (await call('tp_svc_driver_code', { p_phone: DRIVER.phone }, 'service_role')).code;
  return { db, call, driverCode };
}
