// Screenshots of dispatcher.html in the dark and light themes, against the
// same local backend the page tests use (real migrations in PGlite, RPCs as
// anon). Time, randomness, ids and data are fixed so two runs of the same
// file give the same pixels; outside requests (fonts, CDNs, Google Maps)
// are refused so nothing depends on the network.
//
//   node tests/visual/dispatcher-theme.mjs --theme light --out shots/
//   node tests/visual/dispatcher-theme.mjs --file old.html --theme dark --out base/ --still
//   node tests/visual/dispatcher-theme.mjs --theme light --scan   (WCAG AA check of all visible text)
//
// --still turns animations and transitions off (for pixel comparisons).
// Needs the operations dev dependencies (cd operations && npm ci) for Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freshDb, rpc, ORG_A } from '../security/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(ROOT, 'operations/package.json'))('playwright');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FILE = path.resolve(arg('file', path.join(ROOT, 'dispatcher.html')));
const THEME = arg('theme', 'dark');
const OUT = path.resolve(arg('out', path.join(ROOT, 'screenshots')));
const STILL = process.argv.includes('--still');
const NOW = new Date('2026-10-09T15:30:00Z');
fs.mkdirSync(OUT, { recursive: true });

const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const stop = (n, o = {}) => ({ stop_number: n, address: `${100 + n * 7} Peachtree St NE, Atlanta, GA 30303`,
  customer_name: ['Ava Brooks', 'Leo Chen', 'Mia Patel', 'Sam Ortiz', 'Zoe Kim'][n % 5], phone: '4045550' + (100 + n),
  tracking_number: 'TRK' + (1000 + n), packages: 1 + (n % 3), status: 'pending', lat: 33.75 + n / 100, lng: -84.39 + n / 100, ...o });

async function backend() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  const jobs = [
    { n: 1, title: 'Midtown Morning Run', status: 'pending', created: 40, pickup: '55 Ivan Allen Jr Blvd NW, Atlanta, GA', drop: '1280 Peachtree St NE, Atlanta, GA', price: 42.5, miles: 6.1 },
    { n: 2, title: 'Buckhead Express', status: 'assigned', driver: 'Dana Driver', created: 55, pickup: '3393 Peachtree Rd NE, Atlanta, GA', drop: '3500 Lenox Rd NE, Atlanta, GA', price: 38, miles: 4.4 },
    { n: 3, title: 'Surge Route 7', status: 'in_transit', driver: 'Ned NoConsent', type: 'surge', created: 90, stops: [stop(1, { status: 'delivered' }), stop(2, { status: 'delivered' }), stop(3), stop(4), stop(5)], done: 2, master: 'MC-7' },
    { n: 4, title: 'Decatur Pharmacy', status: 'in_transit', driver: 'Dana Driver', created: 120, exception: true, eta: -12, pickup: '101 E Court Sq, Decatur, GA', drop: '2665 N Decatur Rd, Decatur, GA', price: 55, miles: 9.8 },
    { n: 5, title: 'West End Returns', status: 'delivered', driver: 'Dana Driver', created: 240, pickup: '1035 Ralph David Abernathy Blvd SW, Atlanta, GA', drop: '675 Ponce De Leon Ave NE, Atlanta, GA', price: 31, miles: 5.2 },
    { n: 6, title: 'Airport Cargo Drop', status: 'routing', created: 15, pickup: '6000 N Terminal Pkwy, Atlanta, GA', drop: '1 CNN Center NW, Atlanta, GA', price: 70, miles: 12.3 },
  ];
  for (const j of jobs) {
    await db.query(`insert into public.jobs (id, org_id, title, status, driver_name, job_type, surge_stops, total_stops, stops_completed,
      exception_flag, estimated_delivery_at, original_eta_at, pickup_address, dropoff_address, price, distance_miles, master_code, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id(j.n), ORG_A, j.title, j.status, j.driver ?? null, j.type ?? null, j.stops ? JSON.stringify(j.stops) : null, j.stops ? j.stops.length : null,
      j.done ?? 0, !!j.exception, j.eta ? ago(-j.eta) : null, j.eta ? ago(-j.eta + 25) : null, j.pickup ?? null, j.drop ?? null,
      j.price ?? null, j.miles ?? null, j.master ?? null, ago(j.created)]);
  }
  await db.query(`insert into public.driver_locations (driver_name, name, job_id, lat, lng, updated_at) values
    ('Dana Driver','Dana Driver',$1,33.77,-84.38,$2), ('Ned NoConsent','Ned NoConsent',$3,33.74,-84.40,$4)`, [id(4), ago(0.5), id(3), ago(3)]);
  await db.query(`insert into public.messages (job_id, sender, sender_role, body, created_at) values
    ($1,'Dana Driver','driver','Traffic on I-285, running about 10 minutes behind.',$2),
    ($1,'Dispatch','dispatcher','Thanks Dana, I will let the customer know.',$3),
    ($4,'Dana Driver','driver','Can I take Midtown after Decatur?',$5),
    ($4,'Dispatch','dispatcher','Yes, it is yours once Decatur is done.',$6)`, [id(4), ago(12), ago(10), id(1), ago(8), ago(6)]);
  const json = (status, data) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const handle = async (url, body) => {
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) { try { return json(200, await rpc(db, m[1], JSON.parse(body || '{}'), 'anon')); } catch (e) { return json(400, { message: e.message }); } }
    if (/\/functions\/v1\//.test(url)) return json(200, {});
    return json(401, { message: 'permission denied' });
  };
  const token = (await rpc(db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  return { handle, token };
}

const be = await backend();
const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.clock.setFixedTime(NOW);
await ctx.addInitScript(({ token, org, theme }) => {
  let s = 42; Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  try {
    localStorage.setItem('tp_dispatch_org', JSON.stringify({ id: org, slug: 'quickhaul', name: 'Quick Haul', token }));
    if (theme === 'light') localStorage.setItem('tp_dispatch_theme', 'light'); else localStorage.removeItem('tp_dispatch_theme');
    sessionStorage.setItem('tackpath_splash_shown', '1');
  } catch (e) {}
  const Fake = function () { return { setMap() {}, setCenter() {}, addListener() {}, fitBounds() {}, setOptions() {} }; };
  window.google = { maps: { Map: Fake, Marker: Fake, LatLngBounds: Fake, InfoWindow: Fake, SymbolPath: { CIRCLE: 0 }, event: { addListener() {} } } };
}, { token: be.token, org: ORG_A, theme: THEME });
await ctx.route('**/*', async (route) => {
  const req = route.request(); const url = req.url();
  // signed out, the page sends people to portal.html; stay on the page to show its own sign-in screen
  if (url.startsWith('http://app.test/portal.html')) return route.fulfill({ status: 204, body: '' });
  if (url.startsWith('http://app.test/')) {
    const p = url === 'http://app.test/dispatcher.html' || url.startsWith('http://app.test/dispatcher.html?') ? FILE : path.join(ROOT, new URL(url).pathname);
    if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: p.endsWith('.html') ? 'text/html' : undefined, body: fs.readFileSync(p) });
  }
  if (url.includes('.supabase.co/')) return route.fulfill(await be.handle(url, req.postData()));
  return route.abort();
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const settle = async (ms = 700) => {
  if (STILL) {
    for (let tries = 0; ; tries++) {
      try { await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}' }); break; }
      catch (e) { if (tries > 3) throw e; await page.waitForLoadState('load'); }
    }
  }
  await page.waitForTimeout(ms);
};
const SCAN = process.argv.includes('--scan');
const scanSrc = fs.readFileSync(path.join(ROOT, 'tests/visual/contrast-scan.js'), 'utf8');
const failures = {};
const shot = async (name) => {
  const f = path.join(OUT, `dispatcher-${THEME}-${name}.png`); await page.screenshot({ path: f }); console.log(f);
  if (SCAN) {
    const found = await page.evaluate(`${scanSrc};tpContrastScan()`);
    if (found.length) failures[name] = found;
  }
};

await page.goto('http://app.test/dispatcher.html');
await page.waitForFunction(() => window.jobs && window.jobs.length >= 5 || (typeof jobs !== 'undefined' && jobs.length >= 5), null, { timeout: 15000 });
await settle(1500);
await shot('dashboard');

await page.evaluate((jid) => openDrawer(jid), id(4));
await settle(900);
await shot('job-drawer');
await page.evaluate(() => document.getElementById('drawer').classList.remove('open'));
await settle(400);

await page.evaluate((jid) => rpOpen(jid), id(4));
await settle(1200);
await shot('modal-recovery-plan');
await page.evaluate(() => rpClose());
await settle(300);

await page.evaluate(() => setTab('drivers', document.querySelectorAll('.tbtab')[4]));
await settle(1200);
await shot('drivers');

if (!process.argv.includes('--core')) {
  for (const [tab, idx] of [['smartpath', 1], ['smarttrack', 2], ['surge', 3], ['command', null], ['analytics', null], ['shopify', null], ['sprint', null], ['history', null]]) {
    await page.evaluate(([t, i]) => setTab(t, i === null ? null : document.querySelectorAll('.tbtab')[i]), [tab, idx]);
    await settle(900);
    await shot('tab-' + tab);
  }
  await page.evaluate(() => setTab('dispatch', document.querySelectorAll('.tbtab')[0]));
  await settle(500);
  await page.evaluate(() => { toggleChat(); });
  await settle(1200);
  await shot('comms-hub');
  await page.evaluate(() => switchCommsTab('drivers', document.querySelectorAll('.oc-tab')[1]));
  await settle(1200);
  await shot('comms-hub-drivers');
  await page.evaluate(() => { toggleChat(); });
  await page.evaluate(() => openSmartSortDrawer());
  await settle(800);
  await shot('smartsort-drawer');
  await page.evaluate(() => closeSmartSortDrawer());
  await page.evaluate(() => { if (typeof toast === 'function') toast('Route assigned to Dana Driver'); });
  await settle(400);
  await shot('toast');
  // signed out: the sign-in screen (a ?org= link shows it with the company filled in)
  await ctx.addInitScript(() => { try { localStorage.removeItem('tp_dispatch_org'); } catch (e) {} });
  await page.goto('http://app.test/dispatcher.html?org=quickhaul');
  await settle(1200);
  await shot('sign-in');
  // the once-per-session splash, on a fresh visit
  await ctx.addInitScript(() => { try { sessionStorage.removeItem('tackpath_splash_shown'); } catch (e) {} });
  await page.goto('http://app.test/dispatcher.html?org=quickhaul');
  await page.waitForTimeout(2600);   // its own entrance animation, left running
  await shot('splash');
}
if (SCAN) {
  const n = Object.values(failures).reduce((a, b) => a + b.length, 0);
  for (const [k, v] of Object.entries(failures)) {
    console.log(`\n${k}: ${v.length} below WCAG AA`);
    for (const x of v) console.log(`  ${String(x.ratio).padEnd(5)} need ${x.need}  ${x.fg} on ${x.bg}${x.opacity < 1 ? ' (opacity ' + x.opacity + ')' : ''}  ${x.el}  "${x.text}"`);
  }
  console.log(`\ncontrast scan (${THEME}): ${n} failure(s)`);
  if (n) process.exitCode = 1;
}
if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '));
await browser.close();
