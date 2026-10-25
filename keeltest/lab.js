// Keel test lab. One browser tab runs the whole operation:
//  - Keel: the real Keel server and background worker (keel-backend.js, PGlite)
//    and the real Keel web app in one iframe per station.
//  - TackPath: the real dispatcher, PathIQ and driver app on TackPath's
//    in-browser demo backend (js/hub.js, js/backend.js, js/adapter.js).
//  - The bridge: Keel's real TackPath connection (ops-api: login, manifest,
//    state) answered from what the TackPath apps record.
import { startBackend } from './keel-backend.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OPS = 'https://tackpath-lab.invalid/functions/v1/ops-api';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fmtT = (d = new Date()) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function toast(html, ms = 6000) { const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = html; $('toasts').appendChild(t); setTimeout(() => t.remove(), ms); }
function log(text, kind = '') { const li = document.createElement('li'); li.className = kind; li.innerHTML = `<time>${fmtT()}</time>${text}`; $('log').prepend(li); while ($('log').children.length > 80) $('log').lastChild.remove(); }

// ───────────────────────── stations ─────────────────────────
const STATIONS = [
  { group: 'Customer' },
  { id: 'store', label: 'Online store', kind: 'store', sub: 'Bolt Apparel' },
  { group: 'Keel warehouse' },
  { id: 'manager', label: 'Manager', kind: 'keel', path: '/dashboard', email: 'manager@harbor.test', sub: 'desktop' },
  { id: 'receiver', label: 'Receiving', kind: 'keel', path: '/scan', email: 'receiver@harbor.test', device: 'tc', sub: 'handheld' },
  { id: 'picker', label: 'Picker', kind: 'keel', path: '/scan/pick', email: 'picker@harbor.test', device: 'tc', sub: 'handheld' },
  { id: 'packer', label: 'Packer', kind: 'keel', path: '/pack', email: 'packer@harbor.test', sub: 'pack station' },
  { id: 'merchant', label: 'Bolt portal', kind: 'keel', path: '/m', email: 'ops@bolt.test', sub: 'the merchant' },
  { group: 'TackPath delivery' },
  { id: 'dispatcher', label: 'Dispatcher', kind: 'tp', app: 'dispatcher', sub: 'desktop' },
  { id: 'pathiq', label: 'PathIQ', kind: 'tp', app: 'pathiq', device: 'tc', sub: 'handheld' },
  { id: 'driver', label: 'Driver app', kind: 'tp', app: 'driver', device: 'phone', sub: 'phone' },
];
const byId = Object.fromEntries(STATIONS.filter((s) => s.id).map((s) => [s.id, s]));
let current = null;

// ───────────────────────── Keel ─────────────────────────
const storages = {};
let be = null, META = null;
const inbox = [];      // manifests Keel sent to TackPath
window.KEEL_LAB = {
  storage: (st) => storages[st] || (storages[st] = {}),
  startPath: (st) => byId[st]?.path || '/',
  async request(path, init, st) {
    const headers = new Headers(init.headers || {});
    const req = new Request('https://keel.lab' + path, { method: init.method || 'GET', headers, body: init.body ?? undefined });
    const res = await be.fetch(req);
    if (st && /\/(pack|picking|pick|orders|inbound|scan)/.test(path) && (init.method || 'GET') !== 'GET') setTimeout(refreshCodes, 400);
    return res;
  },
};
async function keelCall(method, path, body, token) {
  const r = await be.fetch(new Request('https://keel.lab' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j?.error?.message || 'HTTP ' + r.status) + (j?.error?.details ? ': ' + JSON.stringify(j.error.details) : '')); return j;
}
const sql = async (q, a) => (await be.db.query(q, a)).rows;

// ───────────────────────── TackPath ─────────────────────────
let hub = null, tpBe = null; const W = {};
let van = null;
function bootTackPath() {
  const D = window.DEMO_DATA, C = D.COMPANY;
  hub = window.__TPDEMO__ = window.createDemoHub({ startIso: new Date().toISOString() });
  tpBe = hub.backend();
  const sess = (t) => JSON.stringify({ id: C.id, slug: C.slug, name: C.name, token: t });
  hub.seedStorage('dispatcher', { tp_dispatch_theme: 'light', tp_dispatch_org: sess(tpBe.orgToken()), ['tp_warehouse_address_' + C.id]: C.hub.address, ['tp_ss_policy_' + C.id]: JSON.stringify(C.policy) });
  hub.seedStorage('pathiq', { tp_dispatch_org: sess(tpBe.orgToken()), tp_worker: 'Keisha Moore', tp_device: 'tc56-lab-01' });
  hub.seedStorage('driver', { tp_dx_perm_intro: '1', tp_theme: 'light' });
  hub.sessionSeed = { dispatcher: { tackpath_splash_shown: '1' } };
  hub.clock.resume();
  // addresses: the demo map knows its own streets; an apartment or suite number after the street still matches
  const known = D.STOPS.map((s) => ({ key: norm(s.address.split(',')[0]), c: { lat: s.lat, lng: s.lng } })).concat([{ key: norm(C.hub.address.split(',')[0]), c: { lat: C.hub.lat, lng: C.hub.lng } }]);
  const geo0 = tpBe.geocode.bind(tpBe);
  const geocode = (a) => geo0(a) || (known.find((k) => norm(String(a).split(',')[0]).startsWith(k.key)) || {}).c || null;
  tpBe.geocode = geocode;
  const fn0 = tpBe.fn.bind(tpBe);
  tpBe.fn = (name, body) => {
    if ((name === 'smooth-api' || name === 'nav-proxy') && body && body.action === 'geocode') {
      const c = geocode((body.params || {}).address);
      return { status: 200, data: c ? { status: 'OK', results: [{ geometry: { location: c } }] } : { status: 'ZERO_RESULTS', results: [] } };
    }
    return fn0(name, body);
  };
  // texts and notifications the real apps would send to a phone
  hub.on('suppressed', (e) => {
    if (e.kind !== 'sms') return;
    if (e.what === 'sign-in code') toast('Text message to the driver: <b>TackPath sign-in code 481562</b>', 15000);
    else if (e.job_id) toast('Text message: the driver has a new route assigned.');
  });
  hub.on('notification', (e) => { const n = e.n || {}; if (n.title || n.body) toast(`<b>${esc(n.title || 'TackPath')}</b> ${esc(n.body || '')}`); });
  // the driver taps a stop: TackPath hands navigation to the phone's maps app
  hub.on('openUrl', (e) => {
    if (e.app !== 'driver' || !/^google\.navigation:/.test(e.url || '')) return;
    const m = /q=([-\d.]+),([-\d.]+)/.exec(e.url); if (m) showNav({ lat: +m[1], lng: +m[2] });
  });
  // anything that changes in TackPath: ask Keel to read the progress now
  let t = null;
  const nudge = () => { clearTimeout(t); t = setTimeout(pollNow, 1500); };
  hub.on('row', nudge); hub.on('event', nudge); hub.on('pod', nudge);
  van = { lat: C.hub.lat, lng: C.hub.lng, heading: 0 };
  hub.gpsFix(van.lat, van.lng, 0, 0);
  const base = new URL('../', location.href).href;
  return { base, driverBase: new URL('vendor/', location.href).href };
}

// ───────────────────────── the bridge (TackPath ops-api) ─────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || []; return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Keel's manifest, as the CSV a dispatcher uploads to SmartSort: one line per Keel box, its label barcode as the tracking number. */
function dispatcherCsv(rows) {
  const out = ['order_id,recipient,address,packages,tracking_number,unit,delivery_notes'];
  for (const r of rows) for (const code of String(r.piece_tracking || r.tracking_number).split(';').filter(Boolean)) {
    const m = /^(.*?)(\s+(?:apt|suite|ste|unit|#)\s*\S+)$/i.exec(r.address || '');
    out.push([r.order_id, r.recipient, `${m ? m[1] : r.address}, ${r.city}, ${r.state} ${r.zip}`, 1, code, m ? m[2].trim() : '', 'Keel order, same-day'].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}
function opsState() {
  const T = tpBe.T, packages = [], bins = [], deliveries = [];
  const delivered = new Map();   // job id -> Set(stop numbers)
  T.messages.forEach((m) => { if (/^STOP_DELIVERED::/.test(m.body)) { try { const x = JSON.parse(m.body.slice(16)); (delivered.get(String(m.job_id)) || delivered.set(String(m.job_id), new Set()).get(String(m.job_id))).add(x.stop_number); } catch (e) {} } });
  for (const mf of inbox) for (const code of mf.codes) {
    let job = null, stopNo = 0;
    for (const j of T.jobs) (j.surge_stops || []).forEach((s, i) => (s.pkgs || [{ tracking_number: s.tracking_number }]).forEach((p) => { if (String(p.tracking_number || '').toUpperCase() === code.toUpperCase()) { job = j; stopNo = i + 1; } }));
    const stowed = T.events.some((e) => e.event_type === 'package.stowed' && String((e.payload || {}).code || '').toUpperCase() === code.toUpperCase());
    const binding = job && T.bin_bindings.filter((b) => String(b.job_id) === String(job.id)).pop();
    const binId = stowed && binding ? 'BIN-' + binding.bin_code : null;
    if (binId && !bins.some((b) => b.id === binId)) bins.push({ id: binId, label: `BIN ${binding.bin_code}${binding.stg_code ? ' · ' + binding.stg_code : binding.location_code ? ' · ' + binding.location_code : ''}` });
    let state = 'awaiting_processing';
    const stopId = job ? `${job.id}:${stopNo}` : null;
    if (job && delivered.get(String(job.id))?.has(stopNo)) {
      state = 'delivered';
      const pod = [...tpBe.podFiles.keys()].find((k) => k.startsWith(job.id + '/stop-' + stopNo + '-'));
      if (!deliveries.some((d) => d.stop_id === stopId)) deliveries.push({ id: 'tp-dlv-' + stopId, stop_id: stopId, proof_id: pod || null, recipient: (job.surge_stops[stopNo - 1] || {}).recipient });
    } else if (job && (job.status === 'in_transit' || job.picked_up_at)) state = 'out_for_delivery';
    else if (stowed) state = 'stowed';
    else if (job) state = 'routed';
    packages.push({ tracking_number: code, state, bin_id: binId, stop_id: stopId, driver_id: job?.driver_name || null, exception_code: job ? null : 'awaiting_processing' });
  }
  return { packages, bins, deliveries };
}
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(OPS)) return realFetch(input, init);
  const body = JSON.parse(init?.body || '{}');
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  if (body.action === 'login') return reply({ token: 'lab-session' });
  if (body.action === 'manifest') {
    const prev = inbox.find((m) => m.external_id === body.external_id);
    if (prev) return reply({ manifest_id: prev.id });
    const rows = parseCsv(body.text || '');
    const codes = rows.flatMap((r) => String(r.piece_tracking || r.tracking_number).split(';').filter(Boolean));
    const mf = { id: 'MF-' + (inbox.length + 1001), external_id: body.external_id, rows, codes, csv: dispatcherCsv(rows), at: new Date(), uploaded: false };
    inbox.push(mf);
    log(`<b>Keel → TackPath</b>: manifest ${esc(mf.id)} for ${esc(rows.map((r) => r.order_id).join(', '))} · ${codes.length} package${codes.length === 1 ? '' : 's'} (${esc(codes.join(', '))})`, 'k');
    toast(`<b>Keel sent a delivery to TackPath.</b> Open the Dispatcher to route it.`);
    renderInbox(); renderSide(); refreshCodes();
    return reply({ manifest_id: mf.id });
  }
  if (body.action === 'state') return reply(opsState());
  return reply({ error: 'unknown action' }, 400);
};
async function pollNow() {
  if (!be || !inbox.length) return;
  try {
    await be.db.query(`select keel.enqueue(i.tenant_id, 'tackpath.poll', jsonb_build_object('integration_id', i.id), 'tplab:' || $1) from keel.integrations i
                       where i.provider = 'tackpath_delivery' and i.status = 'connected'`, [String(Date.now())]);
  } catch (e) { console.warn(e); }
}
// Keel's side of the story, from its own delivery events
let lastEvt = 0;
async function watchKeel() {
  if (!be) return;
  try {
    const rows = await sql(`select e.id, o.number, e.event, e.to_status, e."at" from keel.order_events e join keel.orders o on o.id = e.order_id where e.id > $1 order by e.id`, [lastEvt]);
    for (const r of rows) {
      lastEvt = Math.max(lastEvt, Number(r.id));
      const say = { same_day_accepted: 'accepted for same-day', released: 'released to the floor by Keel', pack_complete: 'packed', shipped: 'shipped (the driver has it)', created: 'received from the store' }[r.event];
      if (say) log(`<b>Keel</b>: ${esc(r.number)} ${say}`, '');
    }
    const ev = await sql(`select le.id, o.number, le.event, le.received_at from keel.local_delivery_events le join keel.local_delivery_dispatches d on d.id = le.dispatch_id
                          join keel.orders o on o.id = d.order_id where le.applied order by le.received_at desc limit 20`);
    for (const r of ev.reverse()) if (!seenEv.has(r.id)) { seenEv.add(r.id); if (r.event !== 'released') log(`<b>TackPath → Keel</b>: ${esc(r.number)} ${esc(r.event.replace(/_/g, ' '))}`, 't'); }
  } catch (e) { console.warn(e); }
}
const seenEv = new Set();

// ───────────────────────── views ─────────────────────────
function renderSide() {
  $('side').innerHTML = STATIONS.map((s) => s.group ? `<h4>${s.group}</h4>`
    : `<button data-st="${s.id}" class="${current === s.id ? 'on' : ''}">${esc(s.label)}${s.id === 'dispatcher' && inbox.some((m) => !m.uploaded) ? '<span class="badge">' + inbox.filter((m) => !m.uploaded).length + '</span>' : `<small>${esc(s.sub || '')}</small>`}</button>`).join('');
}
$('side').addEventListener('click', (e) => { const b = e.target.closest('button[data-st]'); if (b) show(b.dataset.st); });
const views = {};
function viewFor(id) {
  if (views[id]) return views[id];
  const s = byId[id], v = document.createElement('div'); v.className = 'view'; v.id = 'v-' + id;
  const size = s.device === 'tc' ? { w: 360, h: 640 } : s.device === 'phone' ? { w: 392, h: 780 } : null;
  v.innerHTML = `<div class="bar"><b>${esc(s.label)}</b><span class="muted">${esc(barText(s))}</span></div>${id === 'dispatcher' ? '<div id="inbox"></div>' : ''}<div class="body"></div>`;
  $('stage').appendChild(v); views[id] = v;
  const body = v.querySelector('.body');
  if (s.kind === 'store') { body.innerHTML = storeHtml(); wireStore(body); return v; }
  const f = document.createElement('iframe'); f.name = id; f.title = s.label;
  if (size) { const d = document.createElement('div'); d.className = 'device ' + s.device; d.style.width = size.w + 20 + 'px'; f.style.width = size.w + 'px'; f.style.height = size.h + 'px'; d.appendChild(f);
    if (id === 'driver') d.insertAdjacentHTML('beforeend', `<div class="nav" id="navPanel"><div class="muted">Maps · navigation (lab)</div><div class="where" id="navWhere"></div><div class="bar2"><i id="navBar"></i></div><button id="navGo">Drive there</button><button class="lite" id="navBack" hidden>Arrived · back to TackPath</button></div>`);
    body.appendChild(d); }
  else { f.className = 'desk'; body.appendChild(f); }
  if (s.kind === 'keel') f.src = 'app/';
  else window.loadDemoApp(f, s.app === 'driver' ? 'vendor/driver-app.html' : s.app === 'pathiq' ? '../stow.html' : '../dispatcher.html', s.app, s.app === 'driver' ? tpBases.driverBase : tpBases.base);
  if (id === 'driver') wireNav();
  if (s.kind === 'tp') hub.whenReady(s.app).then((w) => { W[s.app] = w; if (s.app === 'driver') driverTiles(w); });
  if (id === 'dispatcher') renderInbox();
  return v;
}
function barText(s) {
  return { store: 'A customer checks out on Bolt Apparel’s website. The store sends the order to Keel with its API key.',
    manager: 'Signed in as Marco Diaz, manager.', receiver: 'Signed in as Rita Alvarez. Scan an ASN, the dock, then cartons.', picker: 'Signed in as Pete Okafor. Same-day work appears here by itself.',
    packer: 'Signed in as Paula Chen. Scan the order number to start.', merchant: 'Signed in as Ben Carter, Bolt Apparel. What the client sees.',
    dispatcher: 'Peachline Courier dispatch: SmartSort, assignment, SmartTrack live.', pathiq: 'Keisha Moore on the sorting handheld.', driver: 'Andre Coleman’s phone.' }[s.id] || '';
}
function show(id) {
  current = id; viewFor(id);
  Object.entries(views).forEach(([k, v]) => v.classList.toggle('on', k === id));
  renderSide(); refreshCodes();
}

// ───────────────────────── online store ─────────────────────────
function storeHtml() {
  const D = window.DEMO_DATA;
  const people = D.STOPS.map((s, i) => `<option value="${i}">${esc(s.recipient)} · ${esc(s.address)}</option>`).join('');
  return `<div class="store">
    <div class="card"><h3>Place an order on Bolt Apparel’s store</h3>
      <label>Customer</label><select id="sCust">${people}<option value="other">Another address…</option></select>
      <div id="sOther" hidden><div class="grid"><div><label>Name</label><input id="sName" value="Test Customer"></div><div><label>Street</label><input id="sStreet" placeholder="123 Peachtree St NE"></div>
        <div><label>City</label><input id="sCity" value="Atlanta"></div><div><label>ZIP</label><input id="sZip" value="30303"></div></div>
        <p class="muted">The TackPath demo map knows the addresses in the list; others are accepted by Keel but TackPath cannot route them.</p></div>
      <label>Items</label><div class="lines" id="sLines"></div><button class="lite" id="sAdd" type="button">+ Add item</button>
      <label>Shipping</label><select id="sSvc"><option value="same_day">Same-day delivery</option><option value="next_day">Next-day delivery</option><option value="ground">Standard (parcel carrier)</option></select>
      <p><button id="sPlace">Place order</button> <span id="sMsg" class="muted"></span></p></div>
    <div class="card"><h3>Orders from the store</h3><table><thead><tr><th>Order</th><th>Customer</th><th>Service</th><th>Status</th><th>Placed</th></tr></thead><tbody id="sOrders"></tbody></table></div></div>`;
}
let products = [];
function wireStore(root) {
  const line = (sku = 'HOOD-NVY-M', qty = 1) => { const d = document.createElement('div'); d.className = 'ln';
    d.innerHTML = `<select>${products.map((p) => `<option value="${p.sku}" ${p.sku === sku ? 'selected' : ''}>${esc(p.name)} (${p.sku}) · ${p.available} available</option>`).join('')}</select><input type="number" min="1" value="${qty}"><button class="lite" type="button">×</button>`;
    d.querySelector('button').onclick = () => d.remove(); root.querySelector('#sLines').appendChild(d); };
  line('HOOD-NVY-M'); line('CAP-OLV');
  root.querySelector('#sAdd').onclick = () => line(products[0]?.sku);
  root.querySelector('#sCust').onchange = (e) => { root.querySelector('#sOther').hidden = e.target.value !== 'other'; };
  root.querySelector('#sPlace').onclick = async () => {
    const msg = root.querySelector('#sMsg'), D = window.DEMO_DATA, c = root.querySelector('#sCust').value;
    let ship_to;
    if (c === 'other') ship_to = { name: root.querySelector('#sName').value, address1: root.querySelector('#sStreet').value, city: root.querySelector('#sCity').value, state: 'GA', postal_code: root.querySelector('#sZip').value, country: 'US' };
    else { const s = D.STOPS[+c], [street, city, sz] = s.address.split(',').map((x) => x.trim()); ship_to = { name: s.recipient, address1: street, address2: s.unit || '', city, state: sz.split(' ')[0], postal_code: sz.split(' ')[1], phone: s.phone, country: 'US' }; }
    const lines = [...root.querySelectorAll('#sLines .ln')].map((d) => ({ sku: d.querySelector('select').value, qty: Number(d.querySelector('input').value) })).filter((l) => l.qty > 0);
    if (!lines.length) { msg.textContent = 'Add an item.'; return; }
    try {
      const o = await keelCall('POST', `/api/t/${META.tenant}/orders`, { warehouse_code: 'ATL1', shipping_service: root.querySelector('#sSvc').value, external_id: 'BOLT-W-' + Date.now().toString().slice(-6), ship_to, lines }, META.store_key);
      const row = (await sql(`select number, same_day, same_day_note from keel.orders where id = $1`, [o.id]))[0];
      msg.innerHTML = `Order <b>${esc(row.number)}</b> placed. ${row.same_day ? '<span class="pill sd">Same-day accepted</span>' : esc(row.same_day_note || '')}`;
      log(`<b>Store → Keel</b>: order ${esc(row.number)} for ${esc(ship_to.name)}`, 'k'); renderStoreOrders(root); refreshProducts();
    } catch (e) { msg.textContent = 'Not accepted: ' + e.message; }
  };
  renderStoreOrders(root);
}
async function renderStoreOrders(root = views.store) {
  if (!root || !be) return;
  const rows = await sql(`select o.number, o.ship_to->>'name' as name, o.shipping_service, o.status, o.same_day, o.created_at,
      (select d.status from keel.local_delivery_dispatches d where d.order_id = o.id order by d.created_at desc limit 1) as dstatus
    from keel.orders o where o.source = 'api' order by o.created_at desc limit 12`);
  const tb = root.querySelector('#sOrders'); if (!tb) return;
  tb.innerHTML = rows.map((r) => `<tr><td><b>${esc(r.number)}</b></td><td>${esc(r.name)}</td><td>${r.same_day ? '<span class="pill sd">same-day</span>' : esc(r.shipping_service)}</td><td>${esc(r.dstatus === 'delivered' ? 'delivered' : r.dstatus && r.status === 'shipped' ? r.dstatus.replace(/_/g, ' ') : r.status)}</td><td>${fmtT(new Date(r.created_at))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No orders yet</td></tr>';
}
async function refreshProducts() { products = await sql(`select p.sku, p.name, coalesce(sum(b.on_hand - b.allocated) filter (where l.type in ('pick','storage') and b.status = 'available'),0)::int as available from keel.products p join keel.merchants m on m.id = p.merchant_id
  left join keel.inventory_balances b on b.product_id = p.id left join keel.locations l on l.id = b.location_id where m.code = 'BOLT' group by p.sku, p.name order by p.sku`).catch((e) => { console.warn('products', e); return products; }); }

// ───────────────────────── dispatcher inbox ─────────────────────────
function renderInbox() {
  const el = $('inbox'); if (!el) return;
  el.innerHTML = inbox.slice().reverse().map((m) => `<div class="inbox ${m.uploaded ? 'done' : ''}"><div><b>Manifest from Keel · ${esc(m.id)}</b><div class="muted">${esc(m.rows.map((r) => r.order_id + ' · ' + r.recipient).join('; '))} · ${m.codes.length} package(s): ${esc(m.codes.join(', '))}</div></div>
    ${m.uploaded ? '<span class="pill ok">Uploaded to SmartSort</span>' : `<button data-mf="${m.id}">Upload to SmartSort</button>`}</div>`).join('');
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-mf]'); if (!b) return;
  const m = inbox.find((x) => x.id === b.dataset.mf); const w = W.dispatcher; if (!m || !w) return;
  b.disabled = true;
  try { w.openSmartSortDrawer && w.openSmartSortDrawer(); await new Promise((r) => setTimeout(r, 400)); w.handleFile(new w.File([m.csv], 'keel-' + m.id + '.csv', { type: 'text/csv' })); m.uploaded = true;
    log(`<b>TackPath</b>: dispatcher uploaded ${esc(m.id)} to SmartSort`, 't'); }
  catch (err) { b.disabled = false; toast('Could not upload: ' + esc(err.message)); }
  renderInbox(); renderSide();
});

// ───────────────────────── scanner panel ─────────────────────────
async function refreshCodes() {
  if (!be || !current) return;
  const s = byId[current], el = $('scanCodes'), help = $('scanHelp');
  const btn = (code, sub = '') => `<button data-code="${esc(code)}"><b>${esc(code)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</button>`;
  const group = (t, items) => items.length ? `<h5>${t}</h5><div class="row">${items.join('')}</div>` : '';
  let html = '';
  const prods = await sql(`select p.sku, p.name, (select barcode from keel.product_barcodes x where x.product_id = p.id limit 1) as upc from keel.products p order by p.sku`).catch(() => []);
  const items = prods.map((p) => btn(p.upc || p.sku, p.sku));
  if (current === 'receiver') {
    const asn = await sql(`select reference from keel.inbound_shipments where status in ('open','receiving') order by created_at`).catch(() => []);
    html = group('Shipments', asn.map((a) => btn(a.reference, 'ASN'))) + group('Docks', [btn('LOC:DOCK-1', 'dock 1'), btn('LOC:DOCK-2', 'dock 2')]) + group('Cartons (product barcodes)', items)
      + group('Bin labels', ['A-01-04', 'A-01-05', 'A-03-01', 'A-03-02', 'B-01-01'].map((b) => btn('LOC:' + b, 'bin')));
    help.textContent = 'Click a code to scan it into the handheld. Typing in the handheld works too.';
  } else if (current === 'picker') {
    const t = await sql(`select l.code, p.sku, o.number from keel.pick_tasks t join keel.locations l on l.id = t.location_id join keel.products p on p.id = t.product_id join keel.orders o on o.id = t.order_id where t.status = 'open' order by t.sequence limit 12`).catch(() => []);
    html = group('Open pick tasks: bins', [...new Set(t.map((x) => x.code))].map((c) => btn(c, 'bin'))) + group('Items', items) + group('Totes', [btn('T-01', 'tote'), btn('T-02', 'tote')]);
    help.textContent = 'Scan the bin first, then the item. The wrong bin or item is refused, as on the floor.';
  } else if (current === 'packer') {
    const o = await sql(`select number from keel.orders where status in ('picked','packing') order by created_at desc limit 8`).catch(() => []);
    html = group('Orders ready to pack', o.map((x) => btn(x.number, 'packing slip'))) + group('Items', items);
    help.textContent = 'Scan the order number, then each item. Then weigh, seal and print the package label.';
  } else if (current === 'pathiq') {
    const codes = inbox.flatMap((m) => m.codes);
    html = group('Keel package labels', codes.map((c) => btn(c, 'package'))) + group('Bins', ['1A', '2A', '3A'].map((b) => btn('BIN:' + b, 'bin QR')))
      + group('Bin locations', ['A-01', 'A-02', 'A-03'].map((b) => btn('LOC:' + b, 'location QR'))) + group('Staging spots', ['S-01', 'S-02', 'S-03'].map((b) => btn('STG:' + b, 'staging QR')));
    help.textContent = 'PathIQ: scan the package, then (first time) BIN and LOC to open its bin, the package again, then BIN to stow. When the route is complete, scan a STG spot.';
  } else if (current === 'driver') {
    const codes = inbox.flatMap((m) => m.codes);
    html = group('Hold to the phone camera: bins', ['1A', '2A', '3A'].map((b) => btn('BIN:' + b, 'bin QR'))) + group('Package labels', codes.map((c) => btn(c, 'package')))
      + group('Delivery photo', [`<button data-door="1"><b>Front door</b><span>for the photo</span></button>`]);
    help.textContent = 'The driver app uses the phone camera. Click a code to hold it in front of the camera while the scanner is open.';
  } else if (current === 'manager' || current === 'merchant') {
    html = ''; help.textContent = 'No scanning on this screen.';
  } else if (current === 'dispatcher') {
    html = ''; help.textContent = 'Dispatcher: upload the Keel manifest above to SmartSort, then open the route and assign a driver.';
  } else { html = ''; help.textContent = 'Place an order here; then follow it through the stations.'; }
  el.innerHTML = html;
}
function scan(code) {
  code = String(code || '').trim(); if (!code) return;
  const s = byId[current];
  if (s?.kind === 'keel') { const w = views[current]?.querySelector('iframe')?.contentWindow; if (!w?.__KEEL_SCAN__ || !w.__KEEL_SCAN__(code)) toast('This screen has no scan field open.'); }
  else if (current === 'pathiq') { try { hub.scan(code); } catch (e) { toast('Open Stow in PathIQ first.'); } }
  else if (current === 'driver') hub.showCamera({ kind: /^BIN:/.test(code) ? 'bin' : 'label', code });
  else toast('Open a scanning station first.');
}
$('scanCodes').addEventListener('click', (e) => {
  const d = e.target.closest('button[data-door]'); if (d) { hub.showCamera({ kind: 'door', unit: '' }, false); toast('The camera now shows the front door. Tap the capture button in the app.'); return; }
  const b = e.target.closest('button[data-code]'); if (b) scan(b.dataset.code);
});
$('scanForm').addEventListener('submit', (e) => { e.preventDefault(); scan($('scanInput').value); $('scanInput').value = ''; });

// ───────────────────────── driving (the phone's maps app) ─────────────────────────
let navTo = null;
function showNav(dest) {
  navTo = dest; $('navPanel')?.classList.add('on');
  const near = window.DEMO_DATA.STOPS.find((s) => Math.abs(s.lat - dest.lat) < 1e-4 && Math.abs(s.lng - dest.lng) < 1e-4);
  $('navWhere').textContent = near ? near.address : `${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}`;
  $('navBar').style.width = '0'; $('navGo').hidden = false; $('navGo').disabled = false; $('navBack').hidden = true;
}
function wireNav() {
  $('navGo').onclick = async () => {
    if (!navTo) return; $('navGo').disabled = true;
    const M = window.DEMO_MAP, r = M.route([van.lat, van.lng], [navTo.lat, navTo.lng]);
    const steps = 120;   // about 12 seconds on screen, whatever the distance
    for (let i = 1; i <= steps; i++) { const p = M.along(r.coords, r.meters * i / steps); van = { lat: p.lat, lng: p.lng, heading: p.heading || van.heading }; hub.gpsFix(van.lat, van.lng, van.heading, i < steps ? 11 : 0); $('navBar').style.width = (100 * i / steps) + '%'; await new Promise((res) => setTimeout(res, 100)); }
    $('navGo').hidden = true; $('navBack').hidden = false;
  };
  $('navBack').onclick = () => { $('navPanel').classList.remove('on'); try { W.driver.onDeepLinkArrived(); } catch (e) {} };
}
function driverTiles(w) {
  (function tiles(n) {
    const L = w.L; if (!L || !L.GridLayer) { if (n < 150) setTimeout(() => tiles(n + 1), 200); return; }
    const Demo = L.GridLayer.extend({ createTile: function (c) { return window.DEMO_MAP.tile(w.document.createElement('canvas'), c.z, c.x, c.y); } });
    L.tileLayer = function (url, o) { return new Demo({ maxZoom: (o && o.maxZoom) || 19, attribution: 'Demo map (offline)' }); };
  })(0);
}

// ───────────────────────── boot ─────────────────────────
let tpBases = null;
async function boot() {
  const step = (t) => { $('loadStep').textContent = t; };
  META = await (await fetch('keel-lab-meta.json')).json();
  $('pwd').textContent = META.password;
  step('Starting the Keel server and database');
  const snap = await (await fetch('keel-lab-db.tar.gz')).blob();
  be = await startBackend({ dataDir: 'memory://', snapshot: snap });
  $('stKeel').classList.add('ok');
  step('Signing in the Keel stations');
  for (const s of STATIONS.filter((x) => x.kind === 'keel')) {
    const r = await keelCall('POST', '/api/auth/login', { email: s.email, password: META.password });
    window.KEEL_LAB.storage(s.id)['keel.session'] = r.token;
    window.KEEL_LAB.storage(s.id)['keel.session.tenant'] = META.tenant;
  }
  step('Starting TackPath');
  tpBases = bootTackPath();
  $('stTp').classList.add('ok');
  await refreshProducts();
  renderSide(); show('store');
  $('loading').remove();
  log('Lab ready. Place an order in the Online store to begin.', '');
  setInterval(() => { watchKeel(); if (current === 'store') renderStoreOrders(); }, 2500);
  setInterval(() => { $('clock').textContent = fmtT(); }, 1000);
  if (!sessionStorage.getItem('keellab.guide')) { $('guide').hidden = false; sessionStorage.setItem('keellab.guide', '1'); }
}
$('guideBtn').onclick = () => { $('guide').hidden = false; };
$('toolsBtn').onclick = () => $('tools').classList.toggle('show');
$('toolsClose').onclick = () => $('tools').classList.remove('show');
const closeGuide = () => { $('guide').hidden = true; };
$('guideClose').onclick = closeGuide; $('guideOk').onclick = closeGuide;
$('guide').addEventListener('click', (e) => { if (e.target === $('guide')) closeGuide(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGuide(); });
$('resetBtn').onclick = () => { if (confirm('Start over? Every order and scan in this lab is cleared.')) location.reload(); };
boot().catch((e) => { console.error(e); $('loadStep').textContent = 'Could not start: ' + e.message; });
