// The live pages, end to end, against the locked-down database.
// Each page runs in jsdom; its network calls go to a local backend made of
// the real migrations in PGlite (RPCs run as the anon role, exactly like the
// public key) and the real edge-function handlers. Direct table requests are
// refused as production refuses them after the lockdown, and recorded, so a
// page that still talks to a table fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, rpc, ORG_A } from './fixture.mjs';
import { handleSendSms, handleDriverLogin, handlePod, guardRequest, handleShopifyStart } from '../../supabase/functions/_shared/tp_security.js';

const require = createRequire(import.meta.url);
const { loadApp, wait } = require('../helpers.js');

async function backend() {
  const db = await freshDb({ migrate: ['10_sessions_and_rpcs.sql', '20_lockdown.sql'] });
  const texts = []; const direct = []; const files = {}; const proxied = [];
  const svc = { rpc: async (fn, args) => { try { return { data: await rpc(db, fn, args, 'service_role') }; } catch (e) { return { error: { message: e.message } }; } } };
  const deps = {
    ...svc,
    sms: async (to, body) => { texts.push({ to, body }); return { ok: true, sid: 'SM' + texts.length }; },
    storage: {
      upload: async (path, bytes, type) => { files[path] = { bytes, type }; return { ok: true }; },
      sign: async (path) => (files[path] ? { ok: true, url: 'https://signed.test/' + path + '?token=x' } : { ok: false }),
    },
  };
  const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const handler = async (url, opts) => {
    url = String(url);
    const body = opts && opts.body ? opts.body : '{}';
    let m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      const args = JSON.parse(body || '{}');
      try { return json(200, await rpc(db, m[1], args, 'anon')); }
      catch (e) { return json(400, { message: e.message }); }
    }
    m = url.match(/\/functions\/v1\/([a-z-]+)/);
    if (m) {
      if (m[1] === 'smooth-api') {   // guarded Google proxy: answer only a signed-in caller
        const g = await guardRequest(new Request('https://x/smooth-api', { method: 'POST', body }), deps, { kinds: ['org', 'driver'] });
        if (g.response) return json(401, { error: 'Sign in required' });
        proxied.push(JSON.parse(await g.req.text()).action);
        return json(200, { status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 } } }], routes: [], rows: [] });
      }
      if (m[1] === 'shopify-oauth') {
        const out = await handleShopifyStart(new Request('https://x/shopify-oauth', { method: 'POST', body }),
          { ...deps, shopifySecret: 'secret', shopifyApiKey: 'k', scopes: 'read_orders', redirectUri: 'https://x/cb' });
        return json(out.status, out.body);
      }
      const h = { 'send-sms': handleSendSms, 'driver-login': handleDriverLogin, pod: handlePod }[m[1]];
      if (!h) return json(200, {});
      const out = await h(new Request('https://x/' + m[1], { method: 'POST', body }), deps);
      return json(out.status, out.body);
    }
    if (/\/rest\/v1\//.test(url) || /\/storage\/v1\//.test(url)) {
      direct.push((opts && opts.method || 'GET') + ' ' + url.replace(/apikey=[^&]+/, ''));
      return json(401, { message: 'permission denied' });
    }
    return json(200, []);
  };
  return { db, texts, direct, files, proxied, handler };
}

const job = async (db, o = {}) => (await db.query(
  `insert into public.jobs (org_id, title, status, driver_name, job_type, surge_stops) values ($1,$2,$3,$4,$5,$6) returning id`,
  [o.org ?? ORG_A, o.title ?? 'Route 9', o.status ?? 'pending', o.driver ?? null, o.type ?? null, JSON.stringify(o.stops ?? null)])).rows[0].id;

test('driver.html: real SMS code sign-in, offers, claim, deliver with private proof, no direct table access', async () => {
  const be = await backend();
  const jid = await job(be.db, { title: 'Offer A' });
  const app = loadApp('driver.html', { fetchHandler: be.handler });
  const w = app.dom.window;
  w.confirm = () => true;
  try {
    w.eval('initApp=function(){window._inited=true;}');
    w.document.getElementById('loginPhone').value = '(404) 555-1234';
    await w.eval('requestCode()');
    assert.equal(be.texts.length, 1, 'one code texted');
    const code = be.texts[0].body.match(/(\d{6})/)[1];
    w.document.getElementById('loginCode').value = String((Number(code) + 1) % 1000000).padStart(6, '0');
    await w.eval('verifyCode()');
    assert.equal(w._inited, undefined, 'a wrong code does not sign in');
    w.document.getElementById('loginCode').value = code;
    await w.eval('verifyCode()');
    assert.equal(w._inited, true);
    const saved = JSON.parse(app.storage.tp_drv);
    assert.equal(saved.name, 'Dana Driver');
    assert.match(saved.token, /^[0-9a-f]{64}$/);
    // the page's own data helpers, now answered by tp_driver
    const offers = await w.eval(`sbGet('jobs?select=*&status=in.(routing,pending,assigned)&order=created_at.desc&limit=10')`);
    assert.deepEqual(Array.from(offers).map((j) => j.id), [jid]);
    const claimed = await w.eval(`sbPatch('jobs?id=eq.${jid}&status=eq.pending',{status:'assigned',driver_name:driver.name})`);
    assert.equal(claimed.length, 1);
    await w.eval(`sbPatch('jobs?id=eq.${jid}&driver_name=eq.'+encodeURIComponent(driver.name),{status:'in_transit',driver_name:driver.name})`);
    const path = await w.eval(`uploadPOD('${jid}',1,'photo','data:image/jpeg;base64,'+btoa('jpegbytes'))`);
    assert.match(path, new RegExp('^' + jid + '/stop-1-photo-\\d+\\.jpg$'));
    assert.ok(be.files[path], 'stored in the private bucket');
    await w.eval(`sbPost('messages',{job_id:'${jid}',sender:driver.name,sender_role:'driver',body:'STOP_DELIVERED::'+JSON.stringify({stop_number:1,pod_url:'${path}'})})`);
    await w.eval(`fetch(SB+'/rest/v1/jobs?id=eq.${jid}',{method:'PATCH',headers:{},body:JSON.stringify({status:'delivered',driver_name:driver.name})})`);
    await w.eval(`fetch(SB+'/rest/v1/driver_locations',{method:'POST',headers:{},body:JSON.stringify({driver_name:driver.name,job_id:'${jid}',lat:33.7,lng:-84.4})})`);
    const row = (await be.db.query('select status, driver_name from public.jobs where id = $1', [jid])).rows[0];
    assert.deepEqual(row, { status: 'delivered', driver_name: 'Dana Driver' });
    assert.equal((await be.db.query(`select count(*)::int n from public.messages where body like 'STOP_DELIVERED::%'`)).rows[0].n, 1);
    assert.equal((await be.db.query(`select lat from public.driver_locations where driver_name = 'Dana Driver'`)).rows[0].lat, 33.7);
    assert.deepEqual(be.direct, [], 'no direct table or storage requests');
  } finally { app.cleanup(); }
});

test('driver.html: a saved login from before the update (no token) must sign in again', async () => {
  const be = await backend();
  const app = loadApp('driver.html', { fetchHandler: be.handler,
    initialStorage: { tp_drv: JSON.stringify({ id: 'drv-4045551234', phone: '4045551234', name: 'Dana Driver' }) } });
  try {
    await wait(50);
    assert.equal(app.storage.tp_drv, undefined, 'old unauthenticated login cleared');
    assert.notEqual(app.dom.window.document.getElementById('loginPhasePhone').style.display, 'none');
  } finally { app.cleanup(); }
});

test('dispatcher.html: company code sign-in, board, assignment SMS, clear board archives, proof link', async () => {
  const be = await backend();
  const jid = await job(be.db, { title: 'Route 7', status: 'pending' });
  const other = await job(be.db, { org: '22222222-2222-4222-8222-222222222222', title: 'Other company' });
  const app = loadApp('dispatcher.html', { fetchHandler: be.handler });
  const w = app.dom.window;
  w.confirm = () => true;
  const opened = []; w.open = (u) => opened.push(u);
  w.google = { maps: { Map: function () {}, Marker: function () {}, SymbolPath: { CIRCLE: 0 } } };
  try {
    w.document.getElementById('loginOrgCode').value = 'quickhaul';
    w.document.getElementById('loginOrgPassword').value = 'wrong';
    await w.eval('doLogin()');
    assert.equal(JSON.parse(app.storage.tp_dispatch_org || 'null'), null, 'wrong company code refused');
    w.document.getElementById('loginOrgPassword').value = 'qh-portal-2026';
    await w.eval('doLogin()');
    assert.match(JSON.parse(app.storage.tp_dispatch_org).token, /^[0-9a-f]{64}$/);
    await wait(300);
    const ids = Array.from(w.eval('jobs')).map((j) => j.id);
    assert.ok(ids.includes(jid) && !ids.includes(other), 'own jobs only');
    // assign + the assignment text
    await w.eval(`sbPatch('jobs?id=eq.${jid}',{driver_name:'Dana Driver',status:'assigned'})`);
    await w.eval(`sendDriverAssignmentSMS('Dana Driver','${jid}')`);
    assert.deepEqual(be.texts, [{ to: '+14045551234', body: 'TackPath: You have been assigned a new route: Route 7. Open the TackPath driver app for details. Reply STOP to opt out.' }]);
    // proof link
    be.files[jid + '/stop-1-photo-1.jpg'] = { bytes: new Uint8Array(1), type: 'image/jpeg' };
    await w.eval(`tpViewPod('${jid}','https://hofijsiphyjpdvujjzfi.supabase.co/storage/v1/object/public/pod/${jid}/stop-1-photo-1.jpg')`);
    assert.deepEqual(opened, ['https://signed.test/' + jid + '/stop-1-photo-1.jpg?token=x'], 'old public URL opens as a signed link');
    // messages, drivers roster, publish route
    await w.eval(`sbPostMsg('${jid}','Running late?','dispatcher')`);
    assert.equal((await be.db.query(`select count(*)::int n from public.messages where body = 'Running late?'`)).rows[0].n, 1, 'sbPostMsg works again');
    const roster = await w.eval(`fetch(sbUrl('drivers?order=name.asc'),{headers:H}).then(r=>r.json())`);
    assert.ok(Array.from(roster).some((d) => d.name === 'Dana Driver'));
    const pub = await w.eval(`fetch(SB_URL+'/rest/v1/rpc/publish_surge_route',{method:'POST',headers:{},body:JSON.stringify({payload:{title:'S',master_code:'MC-1',surge_stops:[]}})}).then(r=>r.json())`);
    assert.equal(pub.ok, true);
    // clear board = archive, nothing deleted
    await w.eval('clearAllJobs()');
    assert.equal((await be.db.query('select count(*)::int n from public.jobs where org_id = $1 and archived is not true', [ORG_A])).rows[0].n, 0);
    assert.equal((await be.db.query('select count(*)::int n from public.jobs')).rows[0].n, 3, 'nothing deleted');
    assert.deepEqual(be.direct, [], 'no direct table or storage requests');
  } finally { app.cleanup(); }
});

test('dispatcher.html: ?org= link no longer signs anyone in without the company code', async () => {
  const be = await backend();
  const app = loadApp('dispatcher.html', { fetchHandler: be.handler, url: 'https://tackpath.com/dispatcher.html?org=quickhaul' });
  try {
    await wait(300);
    assert.equal(app.dom.window.document.getElementById('shell').style.display, 'none');
    assert.equal(app.dom.window.document.getElementById('loginOrgCode').value, 'quickhaul', 'company pre-filled');
  } finally { app.cleanup(); }
});

test('stow.html (PathIQ): company sign-in, routes, bin binding and stow events through the session', async () => {
  const be = await backend();
  const jid = await job(be.db, { title: 'Stow route', status: 'assigned', stops: [{ stop_number: 1, tracking_number: 'TRK1', pkgs: [{ tracking_number: 'TRK1', required_count: 1 }] }] });
  const t = (await rpc(be.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const app = loadApp('stow.html', { fetchHandler: be.handler, initialStorage: { tp_worker: 'Sam',
    tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token: t }) } });
  const w = app.dom.window;
  try {
    await wait(400);
    assert.ok(Array.from(w.eval('jobs')).some((j) => j.id === jid));
    assert.equal(await w.eval(`persistBinBinding('${jid}','1A','L-01')`), true);
    await w.eval(`logEvent('package.stowed',{job_id:'${jid}',payload:{bin:'1A'},idem:'s1'})`);
    assert.equal((await be.db.query(`select bin_label from public.jobs where id = $1`, [jid])).rows[0].bin_label, '1A');
    assert.equal((await be.db.query(`select count(*)::int n from public.events where idempotency_key = 's1'`)).rows[0].n, 1);
    assert.deepEqual(be.direct, []);
  } finally { app.cleanup(); }

  const app2 = loadApp('stow.html', { fetchHandler: be.handler });
  try {
    await wait(100);
    assert.ok(app2.dom.window.document.getElementById('tpSignIn'), 'no session -> PathIQ sign-in screen');
  } finally { app2.cleanup(); }
});

test('portal.html: company code checked by the server; access codes are never downloaded', async () => {
  const be = await backend();
  const app = loadApp('portal.html', { fetchHandler: be.handler });
  const w = app.dom.window;
  try {
    w.document.getElementById('loginOrgCode').value = 'quickhaul';
    w.document.getElementById('loginOrgPassword').value = 'nope';
    await w.eval('doPortalLogin()');
    assert.equal(app.storage.tp_dispatch_org, undefined);
    w.document.getElementById('loginOrgPassword').value = 'qh-portal-2026';
    await w.eval('doPortalLogin()');
    const s = JSON.parse(app.storage.tp_dispatch_org);
    assert.equal(s.name, 'Quick Haul');
    assert.ok(s.token);
    assert.ok(!JSON.stringify(s).includes('qh-portal'), 'no access code in the browser');
    assert.deepEqual(be.direct, []);
  } finally { app.cleanup(); }
});

test('customer.html order -> confirm, then public tracking pages show tracking fields only', async () => {
  const be = await backend();
  const app = loadApp('customer.html', { fetchHandler: be.handler, url: 'https://tackpath.com/customer.html?org=quickhaul' });
  const w = app.dom.window;
  try {
    await wait(100);
    w.eval(`document.getElementById('recipient').value='Jane Doe';document.getElementById('pickupAddr').value='100 Main St';
      document.getElementById('pickupCity').value='Atlanta';document.getElementById('deliveryAddr').value='200 Elm St';
      document.getElementById('deliveryCity').value='Atlanta';`);
    await w.requestQuote();
    await wait(400);
    const id = w.eval('currentJobId');
    assert.ok(id, 'order created');
    assert.ok(w.eval('currentOrderToken'), 'order token held by this browser only');
    await w.eval(`tpOrder('confirm')`);
    const row = (await be.db.query('select status, org_id, customer_confirmed from public.jobs where id = $1', [id])).rows[0];
    assert.deepEqual(row, { status: 'pending', org_id: ORG_A, customer_confirmed: true });
    assert.deepEqual(be.direct, []);

    const tr = loadApp('track.html', { fetchHandler: be.handler, url: 'https://tackpath.com/track.html?job=' + id });
    try {
      await wait(300);
      const cj = tr.dom.window.eval('currentJob');
      assert.equal(cj.id, id);
      assert.ok(!('surge_stops' in cj) && !('org_id' in cj), 'tracking fields only');
    } finally { tr.cleanup(); }
  } finally { app.cleanup(); }
});

test('tracking.html: a tracking number shows only that customer\'s stop', async () => {
  const be = await backend();
  await job(be.db, { status: 'in_transit', driver: 'Dana Driver', type: 'surge', stops: [
    { stop_number: 1, tracking_number: 'TPAAA111', recipient: 'Ann', address: '1 A St' },
    { stop_number: 2, tracking_number: 'TPBBB222', recipient: 'Bob', address: '2 B St' }] });
  const app = loadApp('tracking.html', { fetchHandler: be.handler });
  try {
    const r = await app.dom.window.eval(`lookupTracking('tpbbb222')`);
    assert.equal(r.stop.recipient, 'Bob');
    assert.equal(r.job.surge_stops.length, 1);
    assert.ok(!JSON.stringify(r).includes('Ann'));
    assert.deepEqual(be.direct, []);
  } finally { app.cleanup(); }
});

test('fleet.html and driversignup.html work through the RPCs', async () => {
  const be = await backend();
  await job(be.db, { status: 'in_transit', driver: 'Dana Driver' });
  const t = (await rpc(be.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const fl = loadApp('fleet.html', { fetchHandler: be.handler,
    initialStorage: { tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token: t }) } });
  try {
    await fl.dom.window.eval('load()');
    assert.equal(Array.from(fl.dom.window.eval('jobs')).length, 1);
    assert.deepEqual(be.direct, []);
  } finally { fl.cleanup(); }

  const su = loadApp('driversignup.html', { fetchHandler: be.handler });
  const w = su.dom.window;
  try {
    w.eval(`document.getElementById('suName').value='Avery Applicant';document.getElementById('suPhone').value='(470) 555-3333';`);
    for (const id of ['suDob', 'suDOB', 'suBirth']) { const el = w.document.getElementById(id); if (el) el.value = '1990-01-01'; }
    w.eval(`document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=true)`);
    await w.eval('submitApplication()');
    const d = (await be.db.query(`select status from public.drivers where phone = '4705553333'`)).rows[0];
    assert.equal(d && d.status, 'pending_approval');
    assert.deepEqual(be.direct, []);
  } finally { su.cleanup(); }
});

test('dispatcher.html: the Google proxy and the Shopify connection carry the company session', async () => {
  const be = await backend();
  const t = (await rpc(be.db, 'tp_org_sign_in', { p_slug: 'quickhaul', p_code: 'qh-portal-2026' })).token;
  const app = loadApp('dispatcher.html', { fetchHandler: be.handler,
    initialStorage: { tp_dispatch_org: JSON.stringify({ id: ORG_A, slug: 'quickhaul', name: 'Quick Haul', token: t }) } });
  const w = app.dom.window;
  w.google = { maps: { Map: function () {}, Marker: function () {}, SymbolPath: { CIRCLE: 0 } } };
  const popup = { location: { href: null }, close() { this.closed = true; } };
  w.open = () => popup;
  w.prompt = () => 'Acme-Store.myshopify.com';
  try {
    await wait(200);
    await w.eval(`callRealMatrixAction([{lat:1,lng:2}],[{lat:3,lng:4}])`).catch(() => {});
    await w.eval(`getTrafficAwareLegData({lat:1,lng:2},{lat:3,lng:4})`).catch(() => {});
    assert.deepEqual(be.proxied, ['matrix', 'routes'], 'both proxy calls accepted (they carry the session)');
    w.eval('connectShopify()');
    await wait(200);
    assert.match(String(popup.location.href), /^https:\/\/acme-store\.myshopify\.com\/admin\/oauth\/authorize\?.*state=/);
    assert.ok(!popup.closed);
  } finally { app.cleanup(); }
});
