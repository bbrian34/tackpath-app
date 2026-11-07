// Capture: drives the REAL pages (dispatcher.html, stow.html, the driver app
// page) through the whole TackPath flow against the local stand-in backend,
// and saves a screenshot of each device at every step plus work/shots.json
// (which screens, caption, step text, tap and scan marks, zoom areas).
// compose.mjs turns that into the video.
//
// Nothing here talks to the internet: every request is answered by
// lib/apps.mjs. All names and addresses are made up.
import fs from 'node:fs';
import path from 'node:path';
import { backend, ORG } from './lib/backend.mjs';
import { openApps, signInPhone } from './lib/session.mjs';
import { GEO, PACE } from './lib/apps.mjs';
import { makeCamera } from './lib/camera.mjs';
import { FFMPEG } from './lib/ffmpeg.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = path.join(HERE, 'work', 'shots');
fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
const STOP_AFTER = +(process.env.STOP_AFTER || 99);

// ── Demo data (fictional customers and streets; coordinates only place the dots) ──
GEO['1000 Whitlock Ave, Marietta, GA 30064'] = { lat: 33.9526, lng: -84.5683 };   // the depot SmartSort routes from
const STOPS = [
  ['QH-2041', 'Avery Collins', '214 Maple Grove Ln, Marietta, GA 30064', 1, 33.9601, -84.5602],
  ['QH-2042', 'Jordan Blake', '87 Cedar Hollow Dr, Marietta, GA 30064', 2, 33.9655, -84.5521],
  ['QH-2043', 'Morgan Ellis', '1530 Birch Ridge Ct, Marietta, GA 30064', 1, 33.9712, -84.5598],
  ['QH-2044', 'Riley Bennett', '402 Willow Bend Way, Marietta, GA 30064', 1, 33.9688, -84.5710],
  ['QH-2045', 'Casey Nguyen', '66 Juniper Park Rd, Marietta, GA 30064', 1, 33.9607, -84.5779],
];
for (const s of STOPS) GEO[s[2]] = { lat: s[4], lng: s[5] };
const CSV = 'order_id,recipient,address,packages,tracking_number\n'
  + STOPS.map((s) => [s[0], s[1], '"' + s[2] + '"', s[3], ''].join(',')).join('\n') + '\n';

// What must never be on screen (checked on every screenshot).
const FORBIDDEN = [/\b(Sam|Piper|Marco|Todd|Mario|Ruby)\b/, /12345678/, /\u2014/, /supabase/i, /sb_publishable/, /apikey/i, /qh-portal/i];

const log = (...a) => console.log('[capture]', ...a);
const be = await backend();
const A = await openApps(be, { log, camera: await makeCamera(path.join(HERE, 'work'), FFMPEG) });
const PAGES = { dispatch: A.dispatch, pathiq: A.pathiq, phone: A.phone };
const D = A.dispatch, PQ = A.pathiq, PH = A.phone;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Shot list helpers ──
const shots = [];
let scene = 0, n = 0;
function startScene(no, caption) { scene = no; shots.push({ kind: 'mark', scene: no, caption }); log('scene', no, caption); }
async function snap(dev) {
  const p = PAGES[dev];
  const text = await p.evaluate(() => document.body.innerText);
  for (const f of FORBIDDEN) if (f.test(text)) { const i = text.search(f); throw new Error(dev + ' shows forbidden text ' + f + ': ...' + text.slice(Math.max(0, i - 80), i + 60) + '...'); }
  const file = String(++n).padStart(3, '0') + '-' + dev + '.png';
  await p.screenshot({ path: path.join(WORK, file) });
  return file;
}
// One shot: screenshots of the named devices + { step, w (share of the scene), tap, scan, zoom, crop }.
async function shot(layout, devs, opts = {}) {
  const img = {};
  for (const d of devs) img[d] = await snap(d);
  shots.push(Object.assign({ kind: 'shot', scene, layout, img }, opts));
}
// Where an element is (css px), for the tap ring.
async function at(dev, sel) {
  const b = await PAGES[dev].locator(sel).first().boundingBox();
  return b ? { dev, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null;
}
async function failShots() { for (const d in PAGES) await PAGES[d].screenshot({ path: path.join(HERE, 'work', 'fail-' + d + '.png') }).catch(() => {}); }
// A real pointer tap at the element's centre (works on pulsing buttons too).
async function tap(dev, sel) {
  const loc = PAGES[dev].locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 }).catch(async () => { await failShots(); throw new Error('not visible on ' + dev + ': ' + sel + ' (see work/fail-*.png)'); });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const t = await at(dev, sel);
  await PAGES[dev].mouse.click(t.x, t.y); return t;
}
// A shot of the screen with the ring where the finger is about to go, then the tap.
async function tapShot(layout, devs, dev, sel, opts = {}) {
  const loc = PAGES[dev].locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 }).catch(async () => { await failShots(); throw new Error('not visible on ' + dev + ': ' + sel); });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await shot(layout, devs, Object.assign({ tap: await at(dev, sel), w: 0.6 }, opts));
  return tap(dev, sel);
}
async function until(dev, fn, arg, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await PAGES[dev].evaluate(fn, arg).catch(() => false)) return true; await wait(250); }
  await failShots();
  throw new Error('timed out waiting on ' + dev + ': ' + fn.toString().slice(0, 120));
}
// The area (css px) around the visible text matching each pattern: the
// smallest visible element whose text matches, all of them united, padded.
async function area(dev, pats, pad = 12) {
  const r = await PAGES[dev].evaluate(([srcs, pad]) => {
    const vis = (e) => { const s = getComputedStyle(e); const b = e.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight; };
    let u = null;
    for (const src of srcs) {
      const re = new RegExp(src, 'i'); let best = null;
      for (const e of document.body.querySelectorAll('*')) {
        if (!vis(e) || !re.test(e.innerText || '')) continue;
        const b = e.getBoundingClientRect(); const a = b.width * b.height;
        if (!best || a < best.a) best = { a, b };
      }
      if (!best) continue;
      const b = best.b;
      u = u ? { l: Math.min(u.l, b.left), t: Math.min(u.t, b.top), r: Math.max(u.r, b.right), b: Math.max(u.b, b.bottom) } : { l: b.left, t: b.top, r: b.right, b: b.bottom };
    }
    if (!u) return null;
    const l = Math.max(0, u.l - pad), t = Math.max(0, u.t - pad), rr = Math.min(innerWidth, u.r + pad), bb = Math.min(innerHeight, u.b + pad);
    return [Math.round(l), Math.round(t), Math.round(rr - l), Math.round(bb - t)];
  }, [pats.map((p) => p.source || p), pad]);
  if (!r) log('no area for', pats.join(' | '));
  return r;
}
const zoomSel = async (dev, sel, pad = 10) => { const b = await PAGES[dev].locator(sel).first().boundingBox(); if (!b) return undefined;
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad); return { dev, rect: [x, y, b.width + 2 * pad, b.height + 2 * pad].map(Math.round) }; };
const zoom = async (dev, ...pats) => { const rect = await area(dev, pats); return rect ? { dev, rect } : undefined; };
// A signature, drawn with the pointer on the real signature pad.
async function sign(p) {
  await p.evaluate(() => document.getElementById('sigPad').scrollIntoView({ block: 'center' })); await wait(300);
  const b = await p.locator('#sigPad').boundingBox();
  if (!b) { await failShots(); throw new Error('no signature pad on screen (work/fail-phone.png)'); }
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.01) pts.push([0.1 + 0.8 * t, 0.58 - 0.26 * Math.sin(t * 14) * Math.exp(-t * 1.2) - 0.1 * Math.sin(t * 31) * t]);
  await p.mouse.move(b.x + b.width * pts[0][0], b.y + b.height * pts[0][1]); await p.mouse.down();
  for (const [x, y] of pts) await p.mouse.move(b.x + b.width * x, b.y + b.height * y);
  await p.mouse.up();
}
const done = async () => {
  fs.writeFileSync(path.join(HERE, 'work', 'shots.json'), JSON.stringify({ shots }, null, 1));
  await A.browser.close(); log('wrote', shots.filter((s) => s.kind === 'shot').length, 'shots'); process.exit(0);
};

await until('dispatch', () => typeof openSmartSortDrawer === 'function' && document.querySelector('.tbtab'));
await signInPhone(PH, be);
await wait(1500);

// ── 1. Title card (drawn by the stage) ──
startScene(1, 'Dispatch, simplified');
shots.push({ kind: 'shot', scene, layout: 'title' });

// ── 2. Manifest upload ──
startScene(2, 'Load your manifest in seconds');
await shot('dispatch', ['dispatch'], { step: 'The dispatch board, ready for today', w: 0.9 });
PACE.geo = 700;                                   // slow the map lookups a little, so SmartSort can be seen at work
// New Route opens the file picker; the manifest is chosen in it
const chooser = D.waitForEvent('filechooser');
await tapShot('dispatch', ['dispatch'], 'dispatch', 'button:has-text("New Route")', { step: 'Tap New Route and pick the CSV manifest', w: 1 });
await (await chooser).setFiles({ name: 'quick-haul-manifest.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
await until('dispatch', () => document.getElementById('smartSortDrawer').classList.contains('open'), null, 5000);
await wait(1100);
await shot('dispatch', ['dispatch'], { step: '6 packages, 5 stops, read from the manifest' });
await until('dispatch', () => /Sequenc|Optimi|Building|route/i.test((document.getElementById('statusMsg') || {}).textContent || ''), null, 8000).catch(() => {});
await wait(900);
await shot('dispatch', ['dispatch'], { step: 'SmartSort finds the addresses and orders the stops' });
await until('dispatch', () => /Surge Route RT-001/.test(document.body.innerText), null, 30000);
PACE.geo = 0;
await wait(1500);
await shot('dispatch', ['dispatch'], { step: 'Route RT-001 is on the board', w: 1.3 });
if (STOP_AFTER <= 2) await done();

// ── 3. Assign a driver ──
startScene(3, 'Assign a driver. They see it instantly');
const job = (await be.db.query('select id from public.jobs limit 1')).rows[0];
await D.evaluate((id) => openDrawer(id), job.id);
await wait(900);
await D.selectOption('#assignDriverSelect', { label: 'Dana Reyes' });
await wait(400);
await tapShot('dispatch+phone', ['dispatch', 'phone'], 'dispatch', '#drawer button:has-text("Assign")', { step: 'Open the route, pick Dana Reyes, tap Assign', w: 1.4 });
await wait(1200);
await shot('dispatch+phone', ['dispatch', 'phone'], { step: 'Assigned to Dana Reyes' });
await until('phone', () => /Today.s route/i.test(document.body.innerText), null, 15000);
await wait(1200);
await shot('dispatch+phone', ['dispatch', 'phone'], { step: 'Seconds later, the route is on Dana\'s phone', w: 1.4 });
if (STOP_AFTER <= 3) await done();

// ── 4. PathIQ on the TC56 ──
startScene(4, 'Warehouse scans every package');
// one trigger pull on the TC56 (DataWedge delivers it to PathIQ's scanner plugin)
const scan = async (v, ms = 1200) => { await PQ.evaluate((x) => window.__scan(x), v); await wait(ms); };
await shot('pathiq+phone', ['pathiq', 'phone'], { step: 'PathIQ on the Zebra TC56: scan your badge to sign in', w: 1.2 });
await scan('TP|' + ORG.slug + '|' + ORG.code, 2500);   // the badge (its code is never shown)
await shot('pathiq+phone', ['pathiq', 'phone'], { step: 'Signed in. Stow: scan a package' });
for (const [v, step, w] of [
  ['QH-2041', 'First package of the route: PathIQ asks for a bin'], ['BIN:12', 'Scan an empty bin'], ['LOC:A-07', 'Scan its shelf location'],
  ['QH-2041', 'Scan the package again'], ['BIN:12', 'Confirmed into BIN 12'],
  ['QH-2042', 'Next package', 0.7], ['LOC:A-07', 'Confirm by bin or by location', 0.7], ['QH-2042', 'Second box for the same stop', 0.7], ['BIN:12', '2 of 2 for stop 2', 0.7],
  ['QH-2043', 'Stop 3', 0.5], ['BIN:12', 'Into BIN 12', 0.5], ['QH-2044', 'Stop 4', 0.5], ['BIN:12', 'Into BIN 12', 0.5], ['QH-2045', 'Stop 5', 0.5],
  ['BIN:12', 'All 6 packages are in BIN 12', 1.2]]) {
  await scan(v); await shot('pathiq+phone', ['pathiq', 'phone'], { step, w, scan: { dev: 'pathiq', text: v } });
}
if (STOP_AFTER <= 4) await done();

// ── 5. Stage ──
startScene(5, 'Stage the route. The driver is alerted');
await shot('pathiq+phone', ['pathiq', 'phone'], { step: 'The phone still says: waiting for the warehouse', w: 0.8 });
await scan('STG:S-01', 1500);
await shot('pathiq+phone', ['pathiq', 'phone'], { step: 'Scan the staging spot: BIN 12 staged at STG S-01', scan: { dev: 'pathiq', text: 'STG:S-01' } });
await PH.evaluate(() => tpRefreshStage()).catch(() => {});
await until('phone', () => /Ready for pickup/i.test(document.body.innerText), null, 15000);
await wait(1500);
await shot('pathiq+phone', ['pathiq', 'phone'], { step: 'Dana\'s phone: Ready for pickup' });
await shot('phone', ['phone'], { step: 'Ready for pickup, with the STG spot and the bin', w: 1.3, zoom: await zoom('phone', /Pickup location/, /Ready for pickup/) });
if (STOP_AFTER <= 5) await done();

// ── 6. Pickup: BIN scan, route preview, load ──
startScene(6, 'Driver scans the bin and loads the route');
await tapShot('phone', ['phone'], 'phone', '#scRouteAccepted button:not(.dx-btn)', { step: 'At the staging spot: tap AT PICKUP', zoom: await zoom('phone', /AT PICKUP/, /Pickup location/) });
await wait(1500);
// a camera scan on the phone: the decoded value goes to the app's own processScan
const pscan = async (v, ms = 900) => { await PH.evaluate((x) => processScan(x), v); await wait(ms); };
await shot('phone', ['phone'], { step: 'Scan the bin shown on screen', zoom: await zoom('phone', /^SCAN BIN/, /Scan the bin shown/) });
await pscan('BIN:12', 2500);
await shot('phone', ['phone'], { step: 'Right bin. The route preview: every stop, numbered on the map', w: 1.4, scan: { dev: 'phone', text: 'BIN:12' }, zoom: { dev: 'phone', rect: [0, 70, 412, 420] } });
await tap('phone', 'button:has-text("Load")'); await wait(1200);
await shot('phone', ['phone'], { step: 'Load tab: scan each package into the vehicle', stripOn: 5, zoom: { dev: 'phone', rect: [0, 0, 412, 130] } });
const okLoad = () => PH.evaluate(() => { const ok = document.getElementById('loadPkgOkBtn') || (document.getElementById('loadPkgLastScan') || document).querySelector('button'); if (ok && ok.offsetParent) ok.click(); });
for (const [i, v] of ['QH-2041', 'QH-2042', 'QH-2042', 'QH-2043', 'QH-2044', 'QH-2045'].entries()) {
  await pscan(v, 800);
  if (i === 0 || i === 2) await shot('phone', ['phone'], { step: i ? 'Stop 2: both boxes loaded' : 'Loaded: stop 1, Avery Collins', stripOn: 5, w: 0.8, scan: { dev: 'phone', text: v }, zoom: await zoom('phone', /of 6 loaded/, /LOADED/) });
  await okLoad(); await wait(300);
}
await wait(1800);
await shot('phone', ['phone'], { step: 'All 6 loaded. Start Route unlocks', stripOn: 5, w: 1.2, zoom: await zoom('phone', /Stops in delivery order/, /START ROUTE/) });
if (STOP_AFTER <= 6) await done();

// ── 7. Start Route, Route Map, arrival ──
startScene(7, 'Navigate every stop in order');
await tapShot('phone', ['phone'], 'phone', '#tpPickStart', { step: 'Tap START ROUTE', zoom: await zoom('phone', /START ROUTE/) });
await wait(2500);
await D.evaluate(() => { try { closeDrawer(); } catch (e) {} try { loadJobs(); } catch (e) {} }); await wait(1500);
await shot('dispatch+phone', ['dispatch', 'phone'], { step: 'In transit: the dispatcher sees it move', w: 1.2 });
await tap('phone', 'button:has-text("Route Map")'); await wait(2500);
await shot('phone', ['phone'], { step: 'Route Map: every stop numbered, in order', w: 1.4, zoom: { dev: 'phone', rect: [0, 360, 412, 340] } });
await tap('phone', '#routeMapOverlay .rmo-close'); await wait(800);
await PH.evaluate(() => surgeTapStop(0)); await wait(2000);
await shot('phone', ['phone'], { step: 'Stop 1: turn-by-turn directions open in Google Maps', zoom: await zoom('phone', /STOP 1 OF 5/, /Navigate with Google Maps/) });
await PH.evaluate(() => onDeepLinkArrived()); await wait(2000);
await tapShot('phone', ['phone'], 'phone', '#arrivalPrompt button', { step: 'Arrived at stop 1', w: 1, zoom: await zoom('phone', /Arrived/, /Mark Arrived/) });
await wait(1200);
if (STOP_AFTER <= 7) await done();

// ── 8. At the door ──
startScene(8, 'Proof of delivery, captured at the door');
await shot('phone', ['phone'], { step: 'Scan the package at the door', zoom: { dev: 'phone', rect: [0, 0, 412, 520] } });
await pscan('QH-2041', 1500);
await shot('phone', ['phone'], { step: 'Right package, right stop', scan: { dev: 'phone', text: 'QH-2041' }, zoom: await zoomSel('phone', '#dlvScanResult') });
await tap('phone', '#dlvProceedBtn'); await wait(1200);
await tapShot('phone', ['phone'], 'phone', '.dx-choice[data-c="handed"]', { step: 'How was it delivered? Handed to the customer', zoom: await zoom('phone', /How was it delivered/, /Back door/) });
await wait(400);
await tap('phone', '#podTabSig'); await wait(500);
await sign(PH);
await shot('phone', ['phone'], { step: 'Avery signs on the glass', w: 1.3, zoom: { dev: 'phone', rect: await PH.evaluate(() => { const b = document.getElementById('sigPad').getBoundingClientRect(); return [0, Math.max(0, Math.round(b.top - 90)), 412, Math.round(b.height + 170)]; }) } });
await tapShot('phone', ['phone'], 'phone', '#podSubmitBtn', { step: 'Confirm the delivery' });
await wait(2000);
await shot('phone', ['phone'], { step: 'Stop 1 delivered. On to stop 2', zoom: await zoom('phone', /STOP 1 DELIVERED/, /Go to stop 2/) });
if (STOP_AFTER <= 8) await done();

// Stops 2 to 5, off camera: the same app steps, quickly.
const PKGS = { 1: ['QH-2042', 'QH-2042'], 2: ['QH-2043'], 3: ['QH-2044'], 4: ['QH-2045'] };
const on = (id) => until('phone', (x) => { const e = document.getElementById(x); return e && e.classList.contains('on'); }, id, 10000);
for (const i of [1, 2, 3, 4]) {
  log('stop', i + 1);
  // the driver taps "Go to stop N" on the delivered screen (it also counts down by itself)
  await until('phone', () => { const b = document.getElementById('dxNextGo'); return b && b.offsetParent; }, null, 8000);
  await PH.evaluate(() => document.getElementById('dxNextGo').click());
  await until('phone', (k) => document.getElementById('scSurgeDelivery').classList.contains('on') && currentSurgeStop === k, i, 10000); await wait(800);
  await PH.evaluate(() => onDeepLinkArrived());
  await until('phone', () => { const e = document.getElementById('arrivalPrompt'); return e && e.offsetParent; }, null, 8000); await wait(300);
  await PH.evaluate(() => confirmArrival()); await on('scScan'); await wait(600);
  for (const v of PKGS[i]) {
    await pscan(v, 600);
    await PH.evaluate(() => { const nx = document.getElementById('dlvNextBtn'), r = document.getElementById('dlvScanResult');
      if (nx && nx.offsetParent && !/ACCOUNTED FOR/.test(r ? r.textContent : '')) nx.click(); });
    await wait(300);
  }
  await until('phone', (k) => new RegExp('STOP ' + k + ' ACCOUNTED FOR').test((document.getElementById('dlvScanResult') || {}).textContent || ''), i + 1, 8000);
  await PH.evaluate(() => document.getElementById('dlvProceedBtn').click()); await on('scPOD'); await wait(600);
  await PH.evaluate(() => { dx.choose('handed'); switchPODTab('sig'); }); await wait(600); await sign(PH);
  await PH.evaluate(() => document.getElementById('podSubmitBtn').click()); await wait(1800);
}
const fin = (await be.db.query('select status, picked_up_at, delivered_at from public.jobs where id = $1', [job.id])).rows[0];
log('route', fin.status, fin.picked_up_at, fin.delivered_at);
if (fin.status !== 'delivered' || !fin.picked_up_at || !fin.delivered_at) throw new Error('the route did not finish as delivered');

// ── 9. The dispatcher sees it all ──
startScene(9, 'You see it all, live');
await D.evaluate(() => { try { closeDrawer(); } catch (e) {} try { loadJobs(); } catch (e) {} });
await until('dispatch', () => /DELIVERED/.test(document.body.innerText), null, 15000);
await wait(2500);
await shot('dispatch', ['dispatch'], { step: 'Route RT-001: delivered, 5 of 5 stops' });
await D.evaluate((id) => openDrawer(id), job.id); await wait(1500);
const timing = await D.evaluate(() => { const f = Array.from(document.querySelectorAll('#drawer .dr-field')).filter((e) => /picked up/i.test(e.textContent)).pop();
  if (!f) return null; f.scrollIntoView({ block: 'center' }); return true; });
if (!timing) log('no timing block in the drawer');
await wait(700);
const tb = await D.evaluate(() => { const f = Array.from(document.querySelectorAll('#drawer .dr-field')).filter((e) => /delivery timing/i.test(e.textContent)).pop();
  if (!f) return null; const b = f.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); });
await shot('dispatch', ['dispatch'], { step: 'Picked up and delivered times, recorded by the server', w: 1.4, crop: tb ? { dispatch: widen(tb) } : undefined });
shots.push({ kind: 'shot', scene, layout: 'end', caption: 'Dispatch, simplified', w: 1.1 });
await done();

// a crop of the dispatcher at the video's shape, centred on r
function widen(r) {
  const W = 1280, H = 720, ar = 16 / 8.6;
  let w = Math.max(r[2] + 200, 640), h = w / ar;
  if (h < r[3] + 80) { h = r[3] + 80; w = h * ar; }
  w = Math.min(W, w); h = Math.min(H, h);
  const x = Math.min(Math.max(0, r[0] + r[2] / 2 - w / 2), W - w), y = Math.min(Math.max(0, r[1] + r[3] / 2 - h / 2), H - h);
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}
