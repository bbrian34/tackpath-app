// The Android driver app's bundled page (tackpath-driver www/index.html, what the APK loads) in
// Chromium at phone size, against TackPath's real database code (migrations through 70).
// Every request to the TackPath project is answered locally; anything else is blocked, so
// nothing reaches production. Manual (not in CI):
//   node security/_driver_android_page.mjs <tackpath-driver checkout>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, sqlFile, rpc, ORG_A, ORG_B } from './fixture.mjs';
const require = createRequire(import.meta.url);
const { launch } = require('../browser.js');
const DRIVER = process.argv[2];
const PAGE = fs.readFileSync(DRIVER + '/www/index.html', 'utf8');
const PROJECT = 'https://hofijsiphyjpdvujjzfi.supabase.co';
const step = (s) => console.log('  ✓ ' + s);

const db = await freshDb();
const RB50 = sqlFile('50_publish_gate_statuses.rollback.sql');
await db.exec('drop function public.publish_surge_route(jsonb);');
await db.exec(RB50.slice(RB50.indexOf('CREATE OR REPLACE FUNCTION'), RB50.lastIndexOf('$function$;') + '$function$;'.length));
await db.exec('alter table public.jobs add column if not exists delivered_at timestamptz; alter table public.jobs add column if not exists started_at timestamptz');
for (const f of ['10_sessions_and_rpcs.sql', '20_lockdown.sql', '50_publish_gate_statuses.sql', '60_pathiq_staging_reset.sql', '61_staging_release_gaps.sql',
  '62_gate_ignore_archived.sql', '63_jobs_exclude_archived.sql', '64_driver_hide_archived.sql', '65_bins_self_heal.sql', '67_driver_staging_spot.sql',
  '68_job_timestamps.sql', '69_isolation_and_driver_identity.sql', '70_ops_loop.sql']) await db.exec(sqlFile(f));
await db.exec(`select tp_sec.admin_set_org_code('otherco', 'other-code-2026')`);
const tokA = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
// an open single delivery offer in company A (the driver sees only the area until accepting)
const pub = await rpc(db, 'tp_org', { p_token: tokA, p_action: 'publish_route', p_args: { payload: { title: 'Peachtree drop', job_type: 'standard', master_code: 'TP-DRV-1',
  total_stops: 1, total_packages: 1, pickup_address: '1150 Huff Rd NW, Atlanta, GA 30318', dropoff_address: '1075 Peachtree St NE, Atlanta, GA 30309', price: 18,
  surge_stops: [{ stop_number: 1, address: '1075 Peachtree St NE, Atlanta, GA 30309', recipient: 'Private Customer', pkgs: [{ order_id: 'O-1', tracking_number: 'TN-1', piece_id: 'TN-1', required_count: 1 }] }] } } });
assert.equal(pub.ok, true, JSON.stringify(pub));

const outside = [];
async function phone(browser, phoneNo) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u === 'https://localhost/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (u.startsWith(PROJECT + '/functions/v1/driver-login')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });   // the SMS step
    if (u.startsWith(PROJECT + '/rest/v1/rpc/')) {
      const fn = u.split('/rest/v1/rpc/')[1].split('?')[0];
      try { const out = await rpc(db, fn, JSON.parse(route.request().postData() || '{}'), 'anon'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) }); }
      catch (e) { return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: e.message }) }); }
    }
    if (u.startsWith(PROJECT)) outside.push(u);
    return route.abort();
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('https://localhost/index.html'); await p.waitForTimeout(600);
  await p.fill('#loginPhone', phoneNo); await p.click('#loginPhoneBtn'); await p.waitForTimeout(400);
  const code = (await rpc(db, 'tp_svc_driver_code', { p_phone: phoneNo.replace(/\D/g, '') }, 'service_role')).code;
  await p.fill('#loginCode', code); await p.waitForTimeout(300);
  if (await p.isVisible('#loginVerifyBtn')) await p.click('#loginVerifyBtn');   // a full code may already have submitted itself
  await p.waitForTimeout(800);
  return { ctx, p, errors };
}

const browser = await launch();
try {
  // one company
  let s = await phone(browser, '4045551234');
  assert.equal(await s.p.evaluate(() => getComputedStyle(document.getElementById('loginPhaseCompany')).display), 'none', 'no company choice for one company');
  const st = await s.p.evaluate(() => JSON.parse(localStorage.getItem('tp_drv') || 'null'));
  assert.ok(st && st.token, 'signed in: ' + JSON.stringify(st));
  step('one-company driver signs in with the texted code');
  // the open offer shows the delivery area, not the street; accepting gets the full route
  const jobs = await rpc(db, 'tp_driver', { p_token: st.token, p_action: 'jobs', p_args: {} });
  const offer = jobs.find((j) => j.id === pub.job.id);
  assert.ok(offer && !offer.dropoff_address && offer.dropoff_area, 'the offer is a summary: ' + JSON.stringify(offer));
  await s.p.evaluate((j) => showOffer(j), offer); await s.p.waitForTimeout(200);
  const shown = await s.p.textContent('#offerDropoff');
  assert.equal(shown, offer.dropoff_area);
  assert.doesNotMatch(shown, /Peachtree St/);
  step('open offer shows "' + shown + '" (no street address)');
  await s.p.evaluate(() => acceptOffer()); await s.p.waitForTimeout(900);
  const row = (await db.query(`select status, driver_name, driver_id::text as did from public.jobs where id = $1`, [pub.job.id])).rows[0];
  assert.equal(row.status, 'assigned'); assert.equal(row.driver_name, 'Dana Driver'); assert.ok(row.did, 'accepted with the driver id');
  const full = await rpc(db, 'tp_driver', { p_token: st.token, p_action: 'job', p_args: { id: pub.job.id } });
  assert.match(JSON.stringify(full), /Peachtree St/, 'after accepting, the full route');
  step('Accept claims the route with the driver id; the full route arrives');
  assert.deepEqual(s.errors, []); await s.ctx.close();

  // the same phone in a second company: asked which company, the same code signs in to the chosen one
  await db.query(`insert into public.drivers (name, phone, sms_consent, status, org_id) values ('Dana Driver', '4045551234', true, 'active', $1)`, [ORG_B]);
  await db.query(`update tp_sec.rate_events set at = at - interval '2 minutes' where bucket = 'code_phone_min'`);   // a minute later
  s = await phone(browser, '4045551234');
  assert.equal(await s.p.evaluate(() => getComputedStyle(document.getElementById('loginPhaseCompany')).display), 'block', 'company choice shown');
  const names = await s.p.$$eval('#loginCompanyList button', (b) => b.map((x) => x.textContent));
  assert.deepEqual(names.sort(), ['Other Co', 'Quick Haul']);
  await s.p.click('#loginCompanyList button:has-text("Other Co")'); await s.p.waitForTimeout(800);
  const st2 = await s.p.evaluate(() => JSON.parse(localStorage.getItem('tp_drv') || 'null'));
  assert.ok(st2 && st2.token);
  const sess = (await rpc(db, 'tp_svc_session', { p_token: st2.token }, 'service_role'));
  assert.equal(sess.org_id, ORG_B, 'signed in to the chosen company');
  const bJobs = await rpc(db, 'tp_driver', { p_token: st2.token, p_action: 'jobs', p_args: {} });
  assert.ok(!bJobs.some((j) => j.id === pub.job.id), 'in Other Co, Quick Haul\'s route is not visible');
  step('two-company driver picks "Other Co"; signed in to that company only');
  assert.deepEqual(s.errors, []); await s.ctx.close();
} finally { await browser.close(); }
assert.deepEqual(outside, [], 'no other request reached the TackPath project');
console.log('ANDROID DRIVER PAGE OK (real TackPath code, 69 + 70)');
