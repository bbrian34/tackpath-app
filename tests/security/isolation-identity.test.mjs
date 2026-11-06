// Migration 69: company isolation and driver identity (SmartSort automation, step 1).
// Real migrations in PGlite (the full chain 10, 20, 50, 60-65, 67, 68 with the production
// publication gate), every app call through the public tp_* functions as the anon role.
// Each problem is shown failing on the chain WITHOUT 69 first, then fixed with 69.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, sqlFile, rpc, rpcError, ORG_A, ORG_B } from './fixture.mjs';

const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
const PROD_GATE = RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length);
const CHAIN = ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql'];
const M69 = sqlFile('69_isolation_and_driver_identity.sql');
const R69 = sqlFile('69_isolation_and_driver_identity.rollback.sql');

async function setup({ m69 = true, before } = {}) {
  const db = await freshDb();
  await db.exec('drop function public.publish_surge_route(jsonb);');
  await db.exec(PROD_GATE);
  await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz');
  for (const f of CHAIN) await db.exec(sqlFile(f));
  await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
  if (before) await before(db);
  if (m69) await db.exec(M69);
  const orgA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const orgB = (await rpc(db, 'tp_org_sign_in', { p_slug: 'otherco', p_code: 'other-code-2026' })).token;
  const A = (action, args = {}) => rpc(db, 'tp_org', { p_token: orgA, p_action: action, p_args: args });
  const AE = (action, args = {}) => rpcError(db, 'tp_org', { p_token: orgA, p_action: action, p_args: args });
  const B = (action, args = {}) => rpc(db, 'tp_org', { p_token: orgB, p_action: action, p_args: args });
  const code = async (phone) => (await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role')).code;
  const driver = async (phone, org) => {
    const c = await code(phone);
    const r = await rpc(db, 'tp_driver_sign_in', org ? { p_phone: phone, p_code: c, p_org: org } : { p_phone: phone, p_code: c });
    assert.equal(r.ok, true, 'signed in: ' + JSON.stringify(r));
    const D = (action, args = {}) => rpc(db, 'tp_driver', { p_token: r.token, p_action: action, p_args: args });
    const DE = (action, args = {}) => rpcError(db, 'tp_driver', { p_token: r.token, p_action: action, p_args: args });
    return { D, DE, me: r.driver };
  };
  let n = 0;
  const route = async (O, title, extra = {}) => {
    const res = await O('publish_route', { payload: { title, job_type: 'surge', master_code: 'TP-ISO-' + (++n),
      total_stops: 1, total_packages: 1, pickup_address: '1150 Huff Rd NW, Atlanta, GA 30318', ...extra,
      surge_stops: [{ stop_number: 1, address: '1075 Peachtree St NE, Atlanta, GA 30309', recipient: 'Private Customer ' + n, phone: '4045550111',
        pkgs: [{ order_id: 'O-' + n, tracking_number: 'TN-ISO-' + n, piece_id: 'TN-ISO-' + n, required_count: 1 }] }] } });
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.job.id;
  };
  return { db, A, AE, B, code, driver, route };
}

test('messages: a general message from one company is not shown to another (shown today, fixed by 69)', async () => {
  const before = await setup({ m69: false });
  await before.A('post_message', { body: 'A private note to my drivers' });
  assert.ok((await before.B('messages')).some((m) => m.body === 'A private note to my drivers'), 'without 69 company B sees company A\'s general message');

  const t = await setup();
  await t.A('post_message', { body: 'A private note to my drivers' });
  const jobA = await t.route(t.A, 'Route A');
  await t.A('post_message', { job_id: jobA, body: 'About route A' });
  await t.db.exec(`insert into public.messages (job_id, sender, sender_role, body) values (null, 'old', 'dispatcher', 'legacy no-company note')`);
  const seenA = (await t.A('messages')).map((m) => m.body);
  const seenB = (await t.B('messages')).map((m) => m.body);
  assert.ok(seenA.includes('A private note to my drivers') && seenA.includes('About route A'), 'company A sees its own messages');
  assert.deepEqual(seenB.filter((b) => /A private|route A|legacy/.test(b)), [], 'company B sees none of A\'s messages, nor an old message with no company');
  const [row] = (await t.db.query(`select org_id::text o from public.messages where body = 'About route A'`)).rows;
  assert.equal(row.o, ORG_A, 'a message on a route takes the route\'s company');
});

test('a self-signed-up driver approved by a company sees only that company\'s routes (saw every company today)', async () => {
  const signup = async (db) => rpc(db, 'tp_driver_signup', { p_args: { name: 'Sue Signup', phone: '4045559999', sms_consent: true } });
  const before = await setup({ m69: false });
  await signup(before.db);
  const sueId = (await before.db.query(`select id::text from public.drivers where name = 'Sue Signup'`)).rows[0].id;
  await before.A('driver_approve', { id: sueId });
  await before.route(before.B, 'Other company route');
  const sueBefore = await before.driver('4045559999');
  assert.ok((await sueBefore.D('jobs')).some((j) => j.title === 'Other company route'), 'without 69 an approved signup sees company B\'s open route');

  const t = await setup();
  await signup(t.db);
  const id = (await t.db.query(`select id::text from public.drivers where name = 'Sue Signup'`)).rows[0].id;
  assert.ok((await t.A('drivers')).some((d) => d.id === id), 'company A still sees the applicant to approve');
  await t.A('driver_approve', { id });
  assert.equal((await t.db.query(`select org_id::text o from public.drivers where id::text = $1`, [id])).rows[0].o, ORG_A, 'approval puts the driver in company A');
  await t.route(t.B, 'Other company route');
  await t.route(t.A, 'Own company route');
  const titles = (await (await t.driver('4045559999')).D('jobs')).map((j) => j.title);
  assert.ok(titles.includes('Own company route'), 'sees own company\'s open route');
  assert.ok(!titles.includes('Other company route'), 'never sees another company\'s route');
});

test('open routes reach drivers as a summary; the full route arrives with Accept', async () => {
  const t = await setup();
  const id = await t.route(t.A, 'Morning run');
  await t.db.query(`update public.jobs set pickup_address = '1150 Huff Rd NW, Atlanta, GA 30318' where id::text = $1`, [id]);
  const { D } = await t.driver('4045551234');
  const offer = (await D('jobs')).find((j) => j.id === id);
  assert.equal(offer.summary, true);
  assert.equal(offer.total_stops, 1); assert.equal(offer.total_packages, 1);
  assert.equal(offer.pickup_address, '1150 Huff Rd NW, Atlanta, GA 30318', 'the pickup warehouse is shown');
  assert.ok(!('surge_stops' in offer) && !JSON.stringify(offer).includes('Private Customer') && !JSON.stringify(offer).includes('Peachtree'),
    'no stops, recipients or delivery addresses before the route is theirs: ' + JSON.stringify(offer));
  assert.equal((await D('job', { id })).summary, true, 'the single-route call is a summary too');
  const [claimed] = await D('claim', { id });
  assert.equal(claimed.surge_stops[0].recipient.startsWith('Private Customer'), true, 'Accept returns the whole route, as [row] like before');
  const mine = (await D('jobs')).find((j) => j.id === id);
  assert.ok(mine.surge_stops && !mine.summary, 'from then on the driver gets the full route');
  const dana = (await t.db.query(`select id::text from public.drivers where name = 'Dana Driver'`)).rows[0].id;
  assert.equal(mine.driver_id, dana, 'Accept stores the driver\'s id');
  const ned = await t.driver('4045551235');
  assert.equal((await ned.D('jobs')).some((j) => j.id === id), false, 'a claimed route leaves the other drivers\' list');
});

test('driver ids: unique names are matched, duplicate names are flagged and never guessed; assigning by id is exact', async () => {
  let dupJob, uniqJob;
  const t = await setup({ before: async (db) => {
    // a second "Dana Driver" in company A, and routes assigned by name before 69
    await db.exec(`insert into public.drivers (name, phone, status, org_id) values ('Dana Driver', '4045557777', 'active', '${ORG_A}'),
                                                                                  ('Uma Unique', '4045558888', 'active', '${ORG_A}')`);
    dupJob = (await db.query(`insert into public.jobs (org_id, title, status, driver_name, job_type) values ('${ORG_A}', 'Old dup', 'assigned', 'Dana Driver', 'surge') returning id::text`)).rows[0].id;
    uniqJob = (await db.query(`insert into public.jobs (org_id, title, status, driver_name, job_type) values ('${ORG_A}', 'Old uniq', 'assigned', 'Uma Unique', 'surge') returning id::text`)).rows[0].id;
  } });
  const ids = Object.fromEntries((await t.db.query(`select phone, id::text from public.drivers`)).rows.map((r) => [r.phone, r.id]));
  const jobs = Object.fromEntries((await t.db.query(`select title, driver_id::text from public.jobs`)).rows.map((r) => [r.title, r.driver_id]));
  assert.equal(jobs['Old uniq'], ids['4045558888'], 'a name that names one driver is matched');
  assert.equal(jobs['Old dup'], null, 'a name shared by two drivers is not guessed');
  const review = await t.A('identity_review');
  assert.ok(review.some((r) => r.kind === 'route_driver' && r.id === dupJob && /2 drivers/.test(r.reason)), 'the duplicate is listed for the dispatcher: ' + JSON.stringify(review));
  assert.equal((await t.B('identity_review')).length, 0, 'another company never sees it');

  // neither Dana can work the uncertain route; the dispatcher confirms one by id
  const dana1 = await t.driver('4045551234'), dana2 = await t.driver('4045557777');
  assert.match(await dana1.DE('update_job', { id: dupJob, patch: { status: 'in_transit' } }), /confirm the driver/);
  assert.match(await dana2.DE('update_job', { id: dupJob, patch: { status: 'in_transit' } }), /confirm the driver/);
  await t.A('update_job', { id: dupJob, patch: { driver_id: ids['4045557777'] } });
  assert.equal((await t.A('identity_review')).some((r) => r.id === dupJob), false, 'confirming clears the flag');
  assert.ok((await dana2.D('jobs')).some((j) => j.id === dupJob && !j.summary), 'the confirmed Dana has the route');
  assert.equal((await dana1.D('jobs')).some((j) => j.id === dupJob), false, 'the other Dana does not');
  assert.match(await dana1.DE('update_job', { id: dupJob, patch: { status: 'in_transit' } }), /assigned to someone else/);

  // a driver of another company can never be assigned
  const ollie = (await t.db.query(`select id::text from public.drivers where name = 'Ollie Other'`)).rows[0].id;
  assert.match(await t.AE('update_job', { id: uniqJob, patch: { driver_id: ollie } }), /not an active driver of your company/);
  // assigning by name still works and is matched when unique
  const fresh = await t.route(t.A, 'Assigned by name');
  await t.A('update_job', { id: fresh, patch: { driver_name: 'Uma Unique', status: 'assigned' } });
  assert.equal((await t.db.query(`select driver_id::text d from public.jobs where id::text = $1`, [fresh])).rows[0].d, ids['4045558888']);
});

test('one phone in two companies: the driver chooses; the code stays usable for the choice; single-company phones are unchanged', async () => {
  const t = await setup({ before: async (db) => {
    await db.exec(`insert into public.drivers (name, phone, status, org_id) values ('Dana Driver', '(404) 555-1234', 'active', '${ORG_B}')`);
  } });
  await t.route(t.A, 'A route'); await t.route(t.B, 'B route');
  const c = await t.code('4045551234');
  const choose = await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c });
  assert.equal(choose.ok, false); assert.equal(choose.error, 'TP_CHOOSE_COMPANY');
  assert.deepEqual(choose.companies.map((x) => x.slug).sort(), ['otherco', 'quickhaul']);
  const wrong = await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c, p_org: 'tackpath-review' });
  assert.equal(wrong.ok, false, 'a company the phone is not a driver of is refused');
  const inB = await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c, p_org: 'otherco' });
  assert.equal(inB.ok, true, 'the same code signs in to the chosen company');
  const titles = (await rpc(t.db, 'tp_driver', { p_token: inB.token, p_action: 'jobs', p_args: {} })).map((j) => j.title);
  assert.deepEqual(titles, ['B route'], 'and only that company\'s routes are shown');
  assert.equal((await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551234', p_code: c, p_org: 'otherco' })).ok, false, 'the code is single use');
  const ned = await rpc(t.db, 'tp_driver_sign_in', { p_phone: '4045551235', p_code: await t.code('4045551235') });
  assert.equal(ned.ok, true, 'a phone in one company signs in exactly as before, two arguments');
});

test('rollback puts 65\'s tp_org, 67\'s tp_driver and 10\'s sign-in back; data written is kept', async () => {
  const t = await setup();
  await t.A('post_message', { body: 'kept' });
  await t.db.exec(R69);
  const fns = (await t.db.query(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'tp_%' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).rows.map((r) => r.f);
  assert.ok(fns.includes('tp_driver_sign_in(text,text)') && fns.includes('tp_org(text,text,jsonb)') && fns.includes('tp_driver(text,text,jsonb)'));
  assert.equal(fns.length, 9, 'still the nine public entry points: ' + fns.join(', '));
  assert.ok((await t.A('messages')).some((m) => m.body === 'kept'));
  await t.db.exec(M69);   // and it can be applied again
});
