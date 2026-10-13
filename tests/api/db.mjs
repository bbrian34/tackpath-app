// Test database for the API: the security fixture (production as it was before
// hardening), the security migrations in production order, then migration 69.
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from '../security/fixture.mjs';

export { rpc, ORG_A, ORG_B, sqlFile };
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
export const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql',
  '61_staging_release_gaps.sql', '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql',
  '65_bins_self_heal.sql', '67_driver_staging_spot.sql', '68_job_timestamps.sql'];

export async function apiDb({ with69 = true } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  for (const f of CHAIN) await db.exec(sqlFile(f));
  if (with69) await db.exec(sqlFile('69_public_api.sql'));
  return db;
}

// A company session (what the dispatcher gets at sign-in).
export async function orgSession(db, slug = 'quickhaul', code = 'qh-portal-2026') {
  const r = await rpc(db, 'tp_org_sign_in', { p_slug: slug, p_code: code });
  if (!r || !r.token) throw new Error('org sign-in failed: ' + JSON.stringify(r));
  return r.token;
}
export async function setOrgCode(db, slug, code) { await db.query('select tp_sec.admin_set_org_code($1, $2)', [slug, code]); }
