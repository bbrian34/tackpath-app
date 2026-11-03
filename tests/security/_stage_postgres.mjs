// Staging check on a real PostgreSQL server (not part of CI; needs a disposable server).
// Same schema and migrations as the PGlite tests, but with many simultaneous connections:
// overlapping ticks and several dispatcher tabs at once, two companies, rollback on real data,
// and Keel's real client reading predictions over HTTP.
//   node security/_stage_postgres.mjs <admin-url> <keel-checkout>
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TODAY, sqlFile, ORG_A, ORG_B } from './fixture.mjs';
const [ADMIN, KEEL] = process.argv.slice(2);
const pg = createRequire(KEEL + '/package.json')('pg');
const { TackPathOrgClient, etaFor } = await import(KEEL + '/api/dist/integrations/tackpath-org.js');
const DB = 'tp_ops_stage';

const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
await admin.query(`drop database if exists ${DB} with (force)`); await admin.query(`create database ${DB}`);
for (const r of ['anon', 'authenticated', 'service_role', 'authenticator']) {
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin${r === 'service_role' ? ' bypassrls' : ''}; end if; end $$`);
}
await admin.query(`grant anon, authenticated, service_role to postgres`);
const url = ADMIN.replace(/\/postgres(\?|$)/, `/${DB}$1`);
const pool = new pg.Pool({ connectionString: url, max: 24 });
const one = async (sql, p) => (await pool.query(sql, p)).rows;
// the fixture's roles already exist on this server: skip creating them
await one(TODAY.replace(/create role [^;]+;/g, '').replace(/grant anon, authenticated, service_role to postgres;/, ''));
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
await one('drop function public.publish_surge_route(jsonb);');
await one(RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length));
await one('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql']) await one(sqlFile(f));
await one(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);

// existing data BEFORE 70: org-less agent rows and routes in both companies
const N = 15;
const stops = (i) => JSON.stringify([1, 2, 3].map((k) => ({ stop_number: k, order_id: `O-${i}-${k}`, coords: { lat: 33.78 + k * 0.004, lng: -84.38 },
  deliver_by: k === 3 ? new Date(Date.now() + 20 * 60000).toISOString() : null })));
const jobs = { [ORG_A]: [], [ORG_B]: [] };
for (const org of [ORG_A, ORG_B]) for (let i = 0; i < N; i++) {
  const [{ id }] = await one(`insert into public.jobs (org_id, title, status, driver_name, surge_stops, total_stops, stops_completed, estimated_delivery_at, started_at, created_at)
    values ($1, $2, 'in_transit', $3, $4, 3, 0, now() - interval '25 minutes', now() - interval '35 minutes', now() - interval '1 hour') returning id`,
    [org, 'Route ' + i, (org === ORG_A ? 'Dana ' : 'Ollie ') + i, stops(i)]);
  jobs[org].push(id);
  await one(`insert into public.agent_memory (agent_name, event_type, job_id, details) values ('SmartTrack', 'stop_past_eta', $1, '{}')`, [id]);
  await one(`insert into public.messages (job_id, sender, sender_role, body, created_at) values ($1, 'driver', 'driver', 'stuck in traffic', now() - interval '5 minutes')`, [id]);
}
const before = { messages: (await one(`select count(*)::int n from public.messages`))[0].n };

await one(sqlFile('70_ops_loop.sql'));
assert.equal((await one(`select count(*)::int n from public.agent_memory where org_id is null and job_id is not null`))[0].n, 0, 'every route-linked row backfilled');

const asRole = async (role, sql, p) => { const c = await pool.connect(); try { await c.query('begin'); await c.query(`set local role ${role}`); const r = await c.query(sql, p); await c.query('commit'); return r.rows; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };
const tick = () => asRole('service_role', `select public.tp_svc_ops_tick() as r`).then((r) => r[0].r);
const signIn = async (slug, code) => (await asRole('anon', `select public.tp_org_sign_in($1, $2) as r`, [slug, code]))[0].r.token;
const tokA = await signIn('quickhaul', 'qh-portal-2026'), tokB = await signIn('otherco', 'other-code-2026');
const org = (tok, action, args = {}) => asRole('anon', `select public.tp_org($1, $2, $3) as r`, [tok, action, JSON.stringify(args)]).then((r) => r[0].r);

// first tick locks every stop's deadline (as SmartTrack does on first sight)
await tick();
// make the lock old enough to be late: the ETA was 25 minutes ago
// now: 6 overlapping ticks + 6 dispatcher tabs (3 per company) claiming the same check-ins, all at once
const tabs = [];
for (const [tok, o] of [[tokA, ORG_A], [tokB, ORG_B]]) for (let t = 0; t < 3; t++)
  for (const id of jobs[o]) tabs.push(org(tok, 'agent_claim', { key: 'checkin:' + id + ':1', agent: 'SmartComms', job_id: id }));
const results = await Promise.allSettled([...Array.from({ length: 6 }, tick), ...tabs]);
const failed = results.filter((r) => r.status === 'rejected');
assert.equal(failed.length, 0, 'no errors under concurrency: ' + failed.map((f) => f.reason?.message).slice(0, 3).join('; '));

for (const o of [ORG_A, ORG_B]) for (const id of jobs[o]) {
  const m = await one(`select sender, body, org_id from public.messages where job_id = $1`, [id]);
  assert.equal(m.filter((x) => x.body.startsWith('SMARTTRACK::')).length, 1, 'one SmartTrack alert per stop, whatever ran at once');
  assert.ok(m.filter((x) => x.sender === 'SmartComms').length <= 1, 'at most one check-in (none if a tab claimed it first)');
  assert.ok(m.every((x) => x.org_id === o), 'every message in its route\'s company');
  const claims = await one(`select actor from tp_sec.agent_actions where action_key = $1`, ['checkin:' + id + ':1']);
  assert.equal(claims.length, 1, 'one claim per check-in');
  assert.equal(m.filter((x) => x.sender === 'SmartComms').length, claims[0].actor === 'server' ? 1 : 0, 'the server sent it only if it won the claim');
}
const dups = await one(`select org_id, ref, count(*) n from public.ops_decisions group by 1,2 having count(*) > 1`);
assert.deepEqual(dups, [], 'one decision per issue');
const dA = await org(tokA, 'decisions', { limit: 500 }), dB = await org(tokB, 'decisions', { limit: 500 });
assert.ok(dA.length >= N && dB.length >= N);
assert.ok(dA.every((d) => d.org_id === ORG_A) && dB.every((d) => d.org_id === ORG_B), 'decisions stay in their company');
assert.ok(!dB.some((d) => jobs[ORG_A].includes(d.job_id)));
const pA = await org(tokA, 'promise_watch'), pB = await org(tokB, 'promise_watch');
assert.equal(pA.length, N); assert.equal(pB.length, N);
assert.ok(pA.every((p) => jobs[ORG_A].includes(p.job_id)) && pB.every((p) => jobs[ORG_B].includes(p.job_id)));
assert.ok(pA.every((p) => p.risk === 'at_risk' || p.risk === 'late'), 'stop 3 behind a late stop 1 cannot make its 20-minute promise');
assert.deepEqual((await org(tokB, 'agent_memory', { limit: 500 })).filter((m) => jobs[ORG_A].includes(m.job_id)), [], 'agent memory per company');
// a company cannot claim, decide or read for another
await assert.rejects(org(tokB, 'agent_claim', { key: 'x', job_id: jobs[ORG_A][0] }), /TP_FORBIDDEN/);
const review = dA.find((d) => d.status === 'awaiting_approval');
await assert.rejects(org(tokB, 'decide', { id: review.id, verdict: 'approve' }), /TP_INVALID/);
// Ruby: each company's 15 driver messages, counted once
const ruby = await one(`select org_id, (details->>'messages_analyzed')::int n from public.agent_memory where agent_name = 'Ruby' order by org_id`);
assert.deepEqual(ruby.map((r) => r.n), [N, N]);

// another round of overlapping ticks: nothing new is sent
const msgs1 = (await one(`select count(*)::int n from public.messages`))[0].n;
await Promise.all(Array.from({ length: 4 }, tick));
assert.equal((await one(`select count(*)::int n from public.messages`))[0].n, msgs1, 'repeat ticks send nothing twice');

// Keel's real client reads company A's predictions over HTTP (Supabase-style RPC as anon)
const srv = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; const a = JSON.parse(b || '{}'); const fn = req.url.split('/rpc/')[1];
  try {
    const names = Object.keys(a);
    const r = await asRole('anon', `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, names.map((n) => (a[n] !== null && typeof a[n] === 'object' ? JSON.stringify(a[n]) : a[n])));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r[0].r));
  } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: e.message })); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const client = new TackPathOrgClient({ base_url: 'https://tp.test', anon_key: 'anon', org_slug: 'quickhaul' }, 'qh-portal-2026', (u, o) => fetch(String(u).replace('https://tp.test', base), o));
const st = await client.state([], new Date(Date.now() - 86400000).toISOString());
assert.equal(st.promises.length, N, 'Keel reads its own company\'s predictions');
assert.ok(st.promises.every((p) => jobs[ORG_A].includes(p.job_id)));
const one3 = { ...st, packages: [{ tracking_number: 'T', stop_id: `${jobs[ORG_A][0]}:3` }] };
assert.equal(etaFor(one3, ['T']).risk === 'at_risk' || etaFor(one3, ['T']).risk === 'late', true);
srv.close();

// rollback on real data keeps messages and memory; re-apply works
const kept = { messages: (await one(`select count(*)::int n from public.messages`))[0].n, memory: (await one(`select count(*)::int n from public.agent_memory`))[0].n };
await one(sqlFile('70_ops_loop.rollback.sql'));
assert.equal((await one(`select count(*)::int n from public.messages`))[0].n, kept.messages);
assert.equal((await one(`select count(*)::int n from public.agent_memory`))[0].n, kept.memory);
assert.ok(Array.isArray(await org(tokA, 'jobs')), 'previous gateway answers');
await one(sqlFile('70_ops_loop.sql'));
assert.ok(Array.isArray(await org(tokA, 'decisions')), 're-applied');
assert.ok(kept.messages > before.messages);

await pool.end(); await admin.query(`drop database ${DB} with (force)`); await admin.end();
console.log(`STAGING POSTGRES OK (2 companies x ${N} routes, 6 overlapping ticks + ${tabs.length} simultaneous dispatcher claims)`);
