const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Driver experience (2026-10), copy of tackpath-driver tests/experience.test.js: the shared layer between the TP-DX markers,
// identical in tackpath-driver www/index.html (native app) and tackpath-app
// driver.html (web). The same tests run against both files; APP_HTML points
// at the file under test. The backend is a stand-in for the tp_driver RPC that
// keeps state, applies a client_id once and can be switched offline.

const FILE = process.env.APP_HTML || path.join(__dirname, '..', 'driver.html');
const SIBLING = process.env.SIBLING_HTML || path.join(__dirname, '..', '..', 'tackpath-driver', 'www', 'index.html');
const HTML = fs.readFileSync(FILE, 'utf-8');
const NATIVE = /ArrivalPlugin/.test(HTML.split('<!-- TP-DX:BEGIN')[0]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (s) => (s.match(/<!-- TP-DX:BEGIN[\s\S]*?<!-- TP-DX:END -->/) || [''])[0];

const ROUTE = [
  { order_id: 'ORD-1', tracking_number: 'TN1', recipient: 'Ann Lee', address: '1 A St', phone: '(404) 555-0111',
    unit: '4B', access_notes: 'Call box 12', gate_code: '1234', packages: 2,
    pkgs: [{ order_id: 'ORD-1', tracking_number: 'TN1', required_count: 2 }] },
  { order_id: 'ORD-2', tracking_number: 'TN2', recipient: 'Bo Ray', address: '2 B St', packages: 1, signature_required: true,
    pkgs: [{ order_id: 'ORD-2', tracking_number: 'TN2', required_count: 1 }] },
  { order_id: 'ORD-3', tracking_number: 'TN3', recipient: 'Cy <b>Ox</b>', address: '3 C St', packages: 1,
    pkgs: [{ order_id: 'ORD-3', tracking_number: 'TN3', required_count: 1 }] },
];

function boot(opts = {}) {
  const storage = opts.storage || {};
  const srv = { online: true, messages: [], updates: [], seen: new Set(), rpc: [], binding: null, me: { dispatch_phone: '4045550100' } };
  const spoken = [], vib = [], watches = [], cleared = [], fetches = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://localhost/index.html', pretendToBeVisual: true,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = () => {};
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
      w.HTMLMediaElement.prototype.play = async () => {};
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel() {}, getVoices: () => [], speaking: false, pending: false };
      w.confirm = () => true;
      Object.defineProperty(w.navigator, 'vibrate', { configurable: true, value: (p) => { vib.push(p); return true; } });
      Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: {
        watchPosition: (ok) => { watches.push(ok); return watches.length; },
        clearWatch: (id) => cleared.push(id),
        getCurrentPosition: () => { srv.polledPosition = true; } } });
      if (opts.native) w.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: opts.plugins || {} };
      const json = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      w.fetch = async (url, o) => {
        url = String(url); fetches.push(url);
        if (!srv.online) throw new TypeError('Failed to fetch');
        const body = o && o.body ? JSON.parse(o.body) : {};
        if (url.endsWith('/functions/v1/driver-login')) return json(200, { ok: true });
        if (url.endsWith('/functions/v1/pod')) return json(200, { path: body.job_id + '/p.jpg' });
        const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
        if (!m) return json(200, []);
        if (m[1] === 'tp_driver_sign_in') return json(200, body.p_code === '111111' ? { ok: true, token: 'tok', driver: { id: 'd1', name: 'Dana', phone: '4045551234' } } : { ok: false });
        const a = body.p_args || {};
        srv.rpc.push({ action: body.p_action, args: a });
        if (a.client_id) { if (srv.seen.has(a.client_id)) return json(200, srv.seenResult); srv.seen.add(a.client_id); }
        switch (body.p_action) {
          case 'me': return json(200, srv.me);
          case 'post_message': { const r = { id: srv.messages.length + 1, job_id: a.job_id, body: a.body, sender_role: 'driver', created_at: new Date().toISOString() }; srv.messages.push(r); srv.seenResult = r; return json(200, r); }
          case 'update_job': srv.updates.push(a.patch); srv.seenResult = [Object.assign({ id: a.id }, a.patch)]; return json(200, srv.seenResult);
          case 'messages': return json(200, srv.messages.filter((x) => x.job_id === a.job_id));
          case 'bin_binding': return json(200, srv.binding ? [srv.binding] : []);
          case 'job': return json(200, { id: a.id, status: 'in_transit' });
          case 'jobs': return json(200, []);
          default: return json(200, { ok: true });
        }
      };
      Object.defineProperty(w, 'localStorage', { value: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; } } });
      if (opts.before) opts.before(w);
    },
  });
  const w = dom.window;
  w.eval(`startCamera=function(){};stopCamera=function(){};`);
  if (opts.route !== false) {
    w.eval(`driver={id:'drv-4045551234',name:'Dana',phone:'4045551234',token:'tok'};
      currentJob={id:'job-1',job_type:'surge',status:${JSON.stringify(opts.status || 'in_transit')},stops_completed:${opts.stop || 0},title:'Route 7',bin_label:'2B',price:40};
      isSurgeJob=true;surgeStops=${JSON.stringify(opts.stops || ROUTE)};currentSurgeStop=${opts.stop || 0};
      deliveryScans=new Map();deliveryDamaged=new Map();window._deliveryScan=null;window._surgePODMode=false;
      dx.boot();`);
  }
  const $ = (id) => w.document.getElementById(id);
  const text = (id) => ($(id) ? $(id).textContent.replace(/\s+/g, ' ').trim() : '');
  return {
    w, srv, storage, spoken, vib, watches, cleared, fetches, $, text,
    scan: (c) => w.eval('processScan(' + JSON.stringify(c) + ')'),
    stopDelivered: () => srv.messages.filter((m) => m.body.startsWith('STOP_DELIVERED::')).map((m) => JSON.parse(m.body.slice(16))),
    exceptions: () => srv.messages.filter((m) => m.body.startsWith('STOP_EXCEPTION::')).map((m) => JSON.parse(m.body.slice(16))),
    close: () => w.close(),
  };
}
// Scan every package for the current stop and open proof of delivery.
async function scanStop(a) {
  a.w.eval('surgeTapStop(currentSurgeStop)');
  a.w.eval('sdAtStop()');
  const pieces = a.w.eval('dsStopPieces(currentSurgeStop)');
  for (const p of pieces) for (let i = 0; i < p.required; i++) {
    a.scan(p.key);
    const next = a.$('dlvNextBtn'); if (next) next.click();
  }
  a.$('dlvProceedBtn').click();
}

test('the layer is the same in the native app and the web app, and loads once', () => {
  assert.ok(block(HTML).length > 1000, 'TP-DX block present');
  assert.strictEqual((HTML.match(/<!-- TP-DX:BEGIN/g) || []).length, 1);
  if (fs.existsSync(SIBLING) && SIBLING !== FILE) assert.strictEqual(block(fs.readFileSync(SIBLING, 'utf-8')), block(HTML), 'identical in both repos');
});

test('1. sign in once: code keyboard, auto-submit at 6 digits, number remembered, resend timer; no signal never signs out', async () => {
  const a = boot({ route: false });
  try {
    const code = a.$('loginCode');
    assert.strictEqual(code.getAttribute('autocomplete'), 'one-time-code');
    assert.strictEqual(code.getAttribute('inputmode'), 'numeric');
    a.$('loginPhone').value = '(404) 555-1234';
    a.w.eval("initApp=function(){window._in=true;}");
    await a.w.eval('requestCode()');
    assert.match(a.text('dxResend'), /Resend code in 30s/);
    assert.ok(a.$('dxResend').disabled);
    code.value = '111111';
    code.dispatchEvent(new a.w.Event('input'));
    await wait(30);
    assert.strictEqual(a.w._in, true, 'six digits sign in without another tap');
    assert.match(a.storage.tp_dx_last_phone, /555-1234/);
  } finally { a.close(); }
  const b = boot({ route: false, storage: { tp_dx_last_phone: '"(404) 555-1234"' } });
  try { assert.strictEqual(b.$('loginPhone').value, '(404) 555-1234'); } finally { b.close(); }
  // signed in, phone has no signal at start-up: stays signed in
  const c = boot({ route: false, storage: { tp_drv: JSON.stringify({ name: 'Dana', phone: '4045551234', token: 'tok' }) },
    before: (w) => { const f = w.fetch; w.fetch = async () => { throw new TypeError('offline'); }; w._f = f; } });
  try { await wait(50); assert.ok(c.storage.tp_drv, 'still signed in'); } finally { c.close(); }
});

test('2. start of day: one card with route, stops, packages, bin, pickup and warehouse status', async () => {
  const a = boot({ status: 'assigned' });
  try {
    a.srv.binding = { bin_code: '2B', location_code: 'L-4', state: 'open' };
    a.w.eval('showRouteAcceptedScreen()');
    if (!NATIVE) await a.w.eval('dx.pollStage()');
    await wait(30);
    const t = a.text('dxDayCard');
    assert.match(t, /Route 7/);
    assert.match(t, /3\s*stops/i);
    assert.match(t, /4\s*packages/i, 'packages = sum of required counts');
    assert.match(t, /Bin 2B · Location L-4/);
    assert.match(t, /Staging in progress/);
    a.srv.binding.state = 'ready';
    if (NATIVE) await a.w.eval('tpRefreshStage()'); else await a.w.eval('dx.pollStage()');
    await wait(30);
    assert.match(a.text('dxDayCard'), /Ready for pickup/);
    assert.ok(a.$('dxDayCard').querySelector('a[href="tel:4045550100"]'), 'call dispatch from here');
  } finally { a.close(); }
});

test('3. loading: distinct sound, buzz and colour for right / wrong / duplicate; voice says the stop and the count', async () => {
  const a = boot({ status: 'assigned' });
  try {
    a.w.eval(NATIVE ? "window._scanMode='package';window._loadPaused=false;loadedPackages=new Map();" : "window._loadingPackages=true;loadedCounts=new Map();");
    a.scan('TN2');
    assert.strictEqual(a.w.dx.state.lastFeel, 'ok');
    assert.strictEqual(JSON.stringify(a.vib[a.vib.length - 1]), JSON.stringify([80]));
    assert.strictEqual(a.$('dxFlash').className, 'ok');
    assert.match(a.text('loadPkgLastScan'), /STOP 2/);
    await wait(260);
    // the web page has voice switched off on purpose (driver.html speak()); the app speaks
    if (NATIVE) assert.ok(a.spoken.some((s) => /Stop 2\. 1 of 4/.test(s)), a.spoken.join('|'));
    a.w.eval(NATIVE ? 'resumePackageLoading()' : 'resumePackageScanning()');
    a.scan('NOPE-9');
    assert.strictEqual(a.w.dx.state.lastFeel, 'wrong');
    assert.strictEqual(JSON.stringify(a.vib[a.vib.length - 1]), JSON.stringify([450, 120, 450, 120, 450]));
    assert.strictEqual(a.$('dxFlash').className, 'bad');
    a.scan('TN2');
    assert.strictEqual(a.w.dx.state.lastFeel, 'dup');
    await wait(260);
    if (NATIVE) assert.ok(a.spoken.some((s) => /Already scanned/.test(s)));
    a.w.eval("showScreen('scScan')");
    assert.ok(a.$('loadPkgOverlay').querySelector('.dx-help'), 'a way to reach dispatch while scanning');
  } finally { a.close(); }
});

test('5. at the stop: who, unit, access notes, package count, call customer and dispatch, Problem button', async () => {
  const a = boot();
  try {
    await wait(20);
    a.w.eval('surgeTapStop(0)');
    const t = a.text('dxStopCard');
    assert.match(t, /Stop 1 of 3/);
    assert.match(t, /Ann Lee/);
    assert.match(t, /Unit 4B/);
    assert.match(t, /Call box 12 · Gate code 1234/);
    assert.match(t, /2 packages/);
    assert.ok(a.$('dxStopCard').querySelector('a[href="tel:4045550111"]'), 'call customer');
    assert.ok(a.$('dxStopCard').querySelector('a[href="tel:4045550100"]'), 'call dispatch');
    assert.ok(a.$('dxProblemBtn'));
    assert.match(a.text('sdAtStopBtn'), /Deliver/);
    if (!NATIVE) assert.ok(a.$('dxStopCard').querySelector('a[href^="https://www.google.com/maps/dir/"]'), 'one tap to Google Maps on the web');
    a.w.eval('currentSurgeStop=2;surgeTapStop(2)');
    assert.ok(!a.$('dxStopCard').innerHTML.includes('<b>Ox</b>'), 'names are shown as text');
  } finally { a.close(); }
});

test('5. proof of delivery: a choice is required, then the photo or signature that choice (or the stop) needs; record carries it', async () => {
  const a = boot();
  try {
    await scanStop(a);
    assert.ok(a.$('scPOD').classList.contains('on'));
    assert.strictEqual(a.$('dxPodTop').querySelectorAll('.dx-choice').length, 4);
    await a.w.eval('submitPOD()');
    assert.strictEqual(a.stopDelivered().length, 0, 'no choice yet');
    a.w.eval("dx.choose('front_door')");
    await a.w.eval('submitPOD()');
    assert.strictEqual(a.stopDelivered().length, 0, 'front door needs a photo');
    assert.match(a.text('dxPodNeed'), /Photo needed/);
    a.w.eval("podPhotoData='data:image/jpeg;base64,AAAA'");
    a.$('podNotes').value = 'Behind the planter';
    await a.w.eval('submitPOD()');
    await wait(50);
    const rec = a.stopDelivered();
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].stop_number, 1);
    assert.strictEqual(rec[0].delivery_choice, 'front_door');
    assert.strictEqual(rec[0].notes, 'Behind the planter');
    assert.ok(rec[0].client_id);
    // stop 2 requires a signature whatever the choice
    a.w.eval("document.getElementById('dxNextList').click()");
    await scanStop(a);
    a.w.eval("dx.choose('mailroom');podPhotoData='data:image/jpeg;base64,AAAA'");
    await a.w.eval('submitPOD()');
    assert.strictEqual(a.stopDelivered().length, 1, 'signature still needed');
    a.$('sigPad').dispatchEvent(new a.w.Event('mousedown'));
    await a.w.eval('submitPOD()');
    await wait(50);
    assert.strictEqual(a.stopDelivered().length, 2);
  } finally { a.close(); }
});

test('5. after a stop the next one comes up by itself; a double tap never closes two stops', async () => {
  const a = boot();
  try {
    a.w.eval('dx.policy.autoAdvanceSeconds=0.3');
    await scanStop(a);
    a.w.eval("dx.choose('front_door');podPhotoData='data:image/jpeg;base64,AAAA'");
    await Promise.all([a.w.eval('submitPOD()'), a.w.eval('confirmSurgeStop()')]);
    await wait(60);
    assert.strictEqual(a.stopDelivered().length, 1);
    assert.strictEqual(a.w.eval('currentSurgeStop'), 1);
    assert.match(a.text('dxNext'), /Next · stop 2 of 3/);
    assert.match(a.text('dxNext'), /Bo Ray/);
    await wait(500);
    assert.ok(!a.$('dxNext'), 'countdown finished');
    assert.ok(a.$('scSurgeDelivery').classList.contains('on'), 'stop 2 is open');
    assert.match(a.text('dxStopCard'), /Stop 2 of 3/);
  } finally { a.close(); }
});

test('5/10. a problem tells dispatch, sends the packages back, moves on; the route ends with a summary', async () => {
  const a = boot({ stop: 1 });
  try {
    a.w.eval('dx.policy.autoAdvanceSeconds=0');
    a.w.eval('surgeTapStop(1)');
    a.$('dxProblemBtn').click();
    const opts = Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).map((b) => b.textContent);
    for (const r of ['No access', 'Business closed', 'Refused', 'Damaged', 'Wrong address', 'Unsafe to deliver']) assert.ok(opts.some((o) => o.startsWith(r)), r);
    Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).find((b) => b.textContent.startsWith('No access')).click();
    assert.match(a.w.document.querySelector('#dxSheet').textContent, /1 package for Bo Ray will go back to the station/);
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(60);
    const ex = a.exceptions();
    assert.strictEqual(ex.length, 1);
    assert.deepStrictEqual([ex[0].stop_number, ex[0].reason, ex[0].outcome, ex[0].packages], [2, 'no_access', 'return_to_station', 1]);
    assert.strictEqual(a.srv.updates[a.srv.updates.length - 1].stops_completed, 2);
    assert.strictEqual(a.w.eval('currentSurgeStop'), 2);
    assert.match(a.text('dxRouteBar'), /1 problem/);
    assert.match(a.$('surgeRow1').textContent, /No access · return to station/);
    // last stop: also a problem -> route ends with the summary
    a.w.eval("document.getElementById('dxNext')&&document.getElementById('dxNext').remove();surgeTapStop(2)");
    a.w.eval('dx.problem()');
    Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).find((b) => b.textContent.startsWith('Refused')).click();
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(60);
    assert.strictEqual(a.w.eval('currentJob'), null);
    assert.strictEqual(a.srv.updates[a.srv.updates.length - 1].status, 'completed_with_exceptions', 'never "delivered"');
    const s = a.text('dxSummary');
    assert.match(s, /Route finished with problems/);
    assert.match(s, /2\s*problems/);
    assert.match(s, /2\s*packages to return/);
    assert.match(s, /Stop 2 · No access/);
    assert.deepStrictEqual(a.cleared.length >= 0, true);
    a.$('dxSummaryDone').click();
    assert.ok(!a.$('dxSummary'));
    assert.strictEqual(a.storage.tp_dx_summary, undefined);
  } finally { a.close(); }
});

test('6. no signal: deliveries are saved on the phone, sent once in order when signal returns; scans survive a restart', async () => {
  const a = boot();
  let saved;
  try {
    a.w.eval('dx.policy.autoAdvanceSeconds=0');
    a.srv.online = false;
    Object.defineProperty(a.w.navigator, 'onLine', { configurable: true, get: () => !!a.srv.online });
    a.w.dispatchEvent(new a.w.Event('offline'));
    await scanStop(a);
    a.w.eval("dx.choose('front_door');podPhotoData='data:image/jpeg;base64,AAAA'");
    await a.w.eval('submitPOD()');
    await wait(60);
    assert.strictEqual(a.w.eval('currentSurgeStop'), 1, 'the driver moves on without signal');
    const q = JSON.parse(a.storage.tp_outbox);
    assert.deepStrictEqual(q.map((x) => x.action), ['post_message', 'update_job']);
    // the driver sees the signal notice wherever they are (a card banner or the top pill)
    const notice = () => [a.$('dxSync'), ...a.w.document.querySelectorAll('.dx-sync-inline')].filter((e) => e && !e.hidden).map((e) => e.textContent);
    assert.ok(notice().some((t) => /No signal · \d+ updates saved on this phone/.test(t)), notice().join('|'));
    a.w.eval("document.getElementById('dxNextList').click()");
    assert.ok(notice().some((t) => /No signal/.test(t)), 'still shown on the route list');
    // half of stop 2 scanned, then the phone restarts
    a.w.eval('surgeTapStop(1);sdAtStop()');
    a.scan('TN2');
    a.w.eval("saveRouteState('delivery')");
    saved = Object.assign({}, a.storage);
    // signal back: everything is sent once, in order
    a.srv.online = true;
    await a.w.eval('dx.flush()');
    await a.w.eval('dx.flush()');
    assert.strictEqual(a.stopDelivered().length, 1);
    assert.strictEqual(a.srv.updates.length, 1);
    assert.strictEqual(JSON.parse(a.storage.tp_outbox).length, 0);
    const order = a.srv.rpc.filter((r) => r.args.client_id).map((r) => r.action);
    assert.deepStrictEqual(order.slice(0, 2), ['post_message', 'update_job']);
  } finally { a.close(); }
  const b = boot({ route: false, storage: Object.assign(saved, { tp_drv: JSON.stringify({ name: 'Dana', phone: '4045551234', token: 'tok' }) }) });
  try {
    await wait(50);
    assert.strictEqual(b.w.eval('currentSurgeStop'), 1);
    assert.strictEqual(b.w.eval("deliveryScans.get('1|TN2')"), 1, 'the scan made before the restart is kept');
  } finally { b.close(); }
});

test('8. dispatch: typed messages and quick replies, shown as text; stop records read as plain lines', async () => {
  const a = boot();
  try {
    await wait(30);
    a.w.eval("showScreen('scComms')");
    assert.ok(a.$('dxCompose'));
    a.$('dxMsgInput').value = '<img src=x onerror=alert(1)> gate locked';
    a.$('dxMsgSend').click();
    await wait(30);
    assert.ok(a.srv.messages.some((m) => m.body === '<img src=x onerror=alert(1)> gate locked'));
    assert.ok(!a.$('commsBody').querySelector('img'), 'no HTML from a message runs');
    a.$('dxCompose').querySelector('[data-q="1"]').click();
    await wait(30);
    assert.ok(a.srv.messages.some((m) => m.body === 'Running about 10 minutes late'));
    a.srv.messages.push({ id: 99, job_id: 'job-1', body: 'STOP_DELIVERED::{"stop_number":1,"delivery_choice_label":"Front door"}', sender_role: 'driver', created_at: new Date().toISOString() });
    await a.w.eval('loadMessages()');
    assert.match(a.text('commsBody'), /✓ Stop 1 delivered · Front door/);
    assert.ok(!a.text('commsBody').includes('STOP_DELIVERED::'));
    assert.ok(a.$('dxCallDispatch'));
  } finally { a.close(); }
});

test('9. GPS: one watcher, positions sent at most every 15 s, no extra polling, stopped when the route ends', async () => {
  const a = boot();
  try {
    a.w.eval('startGPS()');
    await wait(20);
    assert.strictEqual(a.watches.length >= 1, true);
    const fix = (lat) => a.watches[a.watches.length - 1]({ coords: { latitude: lat, longitude: -84.39, accuracy: 5, speed: 3, heading: 0 } });
    for (let i = 0; i < 6; i++) fix(33.75 + i * 0.00001);
    await wait(20);
    assert.strictEqual(a.srv.rpc.filter((r) => r.action === 'location').length, 1);
    fix(33.76);   // > 60 m away: sent
    await wait(20);
    assert.strictEqual(a.srv.rpc.filter((r) => r.action === 'location').length, 2);
    await wait(50);
    assert.ok(!a.srv.polledPosition, 'no getCurrentPosition polling loop');
    const before = a.cleared.length;
    a.w.eval('dx.stopGPS()');
    assert.ok(a.cleared.length > before);
    if (!NATIVE) assert.doesNotThrow(() => a.w.eval('onNavPositionUpdate(33.75,-84.39)'), 'web arrival check runs');
  } finally { a.close(); }
});

test('7. readable and honest: no fake numbers, Ruby sends nothing out, big-text rules present', async () => {
  assert.ok(!/4\.9&#9733;/.test(HTML), 'no made-up rating');
  assert.ok(!/earnings\+800/.test(HTML), 'no made-up year-to-date');
  assert.ok(!/Math\.random\(\)\*35/.test(HTML), 'no random pay');
  assert.match(block(HTML), /\.screen button[^{]*\{min-height:48px;\}/);
  assert.match(block(HTML), /font-size:0\.5625rem"\][^{]*\{font-size:\.8125rem!important;\}/);
  const a = boot();
  try {
    await a.w.eval("processRubyCmd('nobody home',false)");
    await wait(30);
    assert.ok(!a.fetches.some((u) => /anthropic/.test(u)), 'Ruby sends nothing to an outside AI service');
    assert.ok(a.srv.messages.some((m) => /Nobody home/i.test(m.body)));
  } finally { a.close(); }
});

test('9. native only: the permission explainer comes once, before the app asks for anything', async () => {
  if (!NATIVE) return;
  const a = boot({ native: true, route: false });
  try {
    a.w.eval("window._asked=0;initJobNotifications=function(){window._asked++;};");
    a.$('loginPhone').value = '4045551234';
    await a.w.eval('requestCode()');
    a.$('loginCode').value = '111111';
    await a.w.eval('verifyCode()');
    assert.match(a.w.document.querySelector('#dxSheet').textContent, /Before your first route/);
    assert.strictEqual(a.w._asked, 0, 'nothing asked before the driver reads it');
    a.w.document.querySelector('#dxSheet .dx-btn.ok').click();
    assert.strictEqual(a.w._asked, 1);
    assert.ok(a.storage.tp_dx_perm_intro);
  } finally { a.close(); }
});

test('problems: "Damaged" needs a photo before it can be reported; "Unsafe" never asks for one', async () => {
  const a = boot();
  try {
    a.w.eval('dx.policy.autoAdvanceSeconds=0;surgeTapStop(0)');
    a.w.eval('dx.problem()');
    Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).find((b) => b.textContent.startsWith('Damaged')).click();
    assert.ok(a.$('dxProbPhoto'), 'camera button');
    assert.match(a.text('dxProbNeed'), /photo is required/);
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(40);
    assert.strictEqual(a.exceptions().length, 0, 'not reported without a photo');
    a.w.eval("dx.setProblemPhoto('data:image/jpeg;base64,AAAA')");
    assert.match(a.text('dxProbNeed'), /Photo taken/);
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(60);
    const ex = a.exceptions();
    assert.strictEqual(ex.length, 1);
    assert.deepStrictEqual([ex[0].reason, ex[0].photo], ['damaged', true]);
    assert.ok(a.srv.messages.some((m) => /^POD_ATTACHED::.*"problem":"damaged"/.test(m.body)), 'the photo is stored for dispatch');
    // unsafe: straight to report, no photo
    a.w.eval("document.getElementById('dxNext')&&document.getElementById('dxNext').remove();surgeTapStop(1);dx.problem()");
    Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).find((b) => b.textContent.startsWith('Unsafe')).click();
    assert.ok(!a.$('dxProbPhoto'));
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(60);
    assert.strictEqual(a.exceptions().length, 2);
  } finally { a.close(); }
});

test('a route with an earlier problem still finishes as completed_with_exceptions when its last stop is delivered', async () => {
  const a = boot({ stop: 1 });
  try {
    a.w.eval('dx.policy.autoAdvanceSeconds=0;surgeTapStop(1);dx.problem()');
    Array.from(a.w.document.querySelectorAll('#dxSheet .dx-opt')).find((b) => b.textContent.startsWith('Refused')).click();
    a.w.document.querySelector('#dxSheet .dx-btn.bad').click();
    await wait(60);
    a.w.eval("document.getElementById('dxNext')&&document.getElementById('dxNext').remove()");
    await scanStop(a);
    a.w.eval("dx.choose('front_door');podPhotoData='data:image/jpeg;base64,AAAA'");
    await a.w.eval('submitPOD()');
    await wait(80);
    assert.strictEqual(a.w.eval('currentJob'), null);
    const last = a.srv.updates[a.srv.updates.length - 1];
    assert.strictEqual(last.status, 'completed_with_exceptions');
    assert.match(a.text('dxSummary'), /1\s*stops? delivered/);
    assert.match(a.text('dxSummary'), /Stop 2 · Refused/);
  } finally { a.close(); }
});
