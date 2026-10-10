/* TackPath demo — in-browser backend.
   Answers exactly the calls the real pages make — /rest/v1/rpc/<fn> and
   /functions/v1/<fn> — from in-memory tables, following the rules in
   supabase/security/10_sessions_and_rpcs.sql (tp_org, tp_driver, sign-in,
   publish gate). Nothing here talks to a network. A restart builds a brand-new
   backend, so every run starts from exactly the same state. */
(function (root) {
  'use strict';

  function createBackend(opts) {
    const D = root.DEMO_DATA, M = root.DEMO_MAP;
    const clock = opts.clock;              // { now(): ms }
    const emit = opts.emit || function () {};
    let seed = 0x5eed1234;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16); return s; };
    const uuid = () => hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
    const iso = () => new Date(clock.now()).toISOString();
    const clone = (o) => JSON.parse(JSON.stringify(o));

    // ── TABLES ──
    const org = { id: D.COMPANY.id, name: D.COMPANY.name, slug: D.COMPANY.slug, access_code: D.COMPANY.code };
    const T = {
      organizations: [org],
      drivers: D.DRIVERS.map((d) => ({ id: d.id, name: d.name, phone: d.phone, status: 'active', org_id: org.id, sms_consent: true, vehicle: d.vehicle, created_at: '2026-09-01T12:00:00.000Z' })),
      jobs: [], messages: [], driver_locations: [], bin_bindings: [], events: [], agent_memory: []
    };
    const sessions = new Map();     // token -> session
    const clientOps = new Map();
    const orgProfile = { [org.id]: D.COMPANY.dispatchPhone };
    const suppressed = [];          // SMS and other outward actions the demo did NOT perform
    const podFiles = new Map();
    const loginCodes = new Map();
    let msgId = 1000;

    function newSession(kind, extra) {
      const tok = 'demo-' + kind + '-' + hex(24);
      sessions.set(tok, Object.assign({ kind, org_key: org.id }, extra || {}));
      return tok;
    }
    function session(tok, kind) {
      const s = sessions.get(tok);
      if (!s || s.kind !== kind) throw new Error('TP_AUTH: please sign in again');
      return s;
    }
    // update_json: set only allowed keys; every expect key must match (null matches null)
    function updateRows(table, id, patch, allowed, expect) {
      const rows = T[table].filter((r) => String(r.id) === String(id) &&
        Object.keys(expect || {}).every((k) => (r[k] == null ? null : String(r[k])) === (expect[k] == null ? null : String(expect[k]))));
      const keys = Object.keys(patch || {}).filter((k) => allowed.includes(k));
      if (!keys.length) throw new Error('TP_INVALID: nothing to change');
      rows.forEach((r) => { keys.forEach((k) => { r[k] = patch[k]; }); });
      if (table === 'jobs') rows.forEach((r) => releaseOnChange(r, patch));
      rows.forEach((r) => emit('row', { table, row: r, patch }));
      return clone(rows);
    }
    const isLive = (j) => !['delivered', 'completed_with_exceptions', 'cancelled'].includes(j.status) && !j.archived;
    const jobById = (id) => T.jobs.find((j) => String(j.id) === String(id));
    const byCreatedDesc = (a, b) => String(b.created_at).localeCompare(String(a.created_at));

    // Migration 65: a binding holds its BIN/LOC/STG only while its route is live.
    const LIVE_DONE = ['archived', 'cancelled', 'delivered', 'completed_with_exceptions', 'closed_with_exceptions', 'in_transit'];
    function healSpots() {
      T.bin_bindings.forEach((b) => {
        if (!['open', 'ready'].includes(b.state)) return;
        const j = jobById(b.job_id);
        if (!j || j.archived || LIVE_DONE.includes(j.status)) { b.state = 'released'; b.released_at = iso(); emit('row', { table: 'bin_bindings', row: b }); }
      });
    }
    // Migrations 60/61: pickup (in_transit / picked_up_at) or finishing frees the route's spots.
    function releaseOnChange(j, patch) {
      if (!patch) return;
      const done = patch.status && ['in_transit', 'cancelled', 'delivered', 'completed_with_exceptions'].includes(patch.status);
      if (!done && !patch.picked_up_at) return;
      T.bin_bindings.forEach((b) => { if (String(b.job_id) === String(j.id) && ['open', 'ready'].includes(b.state)) { b.state = 'released'; b.released_at = iso(); emit('row', { table: 'bin_bindings', row: b }); } });
    }

    // ── tp_org ──
    function tpOrg(tok, action, a) {
      const s = session(tok, 'org');
      a = a || {};
      const jid = a.id;
      if (['bindings', 'open_binding', 'stage_binding'].includes(action) || (action === 'jobs' && a.exclude_archived)) healSpots();
      if (jid != null && ['job', 'update_job', 'set_bin_label', 'set_staged', 'open_binding', 'binding_ready', 'stage_binding'].includes(action)) {
        if (!jobById(jid)) throw new Error('TP_DENIED: not one of your jobs');
      }
      switch (action) {
        case 'me': return { id: org.id, slug: org.slug, name: org.name };
        case 'jobs': {
          let rows = T.jobs.filter((j) =>
            (!a.since || j.created_at >= a.since) &&
            (!a.statuses || a.statuses.includes(j.status)) &&
            (!a.ids || a.ids.map(String).includes(String(j.id))) &&
            (!a.source || j.source === a.source) &&
            (!a.exclude_archived || !j.archived) &&
            (!a.unbinned || j.bin_label == null));
          rows.sort(byCreatedDesc);
          rows = rows.slice(0, Math.min(a.limit || 1000, 2000));
          if (a.order === 'asc') rows.reverse();
          return clone(rows);
        }
        case 'job': return clone(jobById(jid) || null);
        case 'update_job':
          return updateRows('jobs', jid, a.patch || {}, ['status', 'driver_name', 'archived', 'exception_flag', 'exception_detected_at',
            'estimated_delivery_at', 'original_eta_at', 'eta_minutes', 'surge_stops', 'stops_completed', 'bin_label', 'staged_at'], a.expect || {});
        case 'archive_jobs': {
          let n = 0; T.jobs.forEach((j) => { if ((a.ids || []).map(String).includes(String(j.id))) { j.archived = true; n++; emit('row', { table: 'jobs', row: j, patch: { archived: true } }); } });
          return { archived: n };
        }
        case 'publish_route': return publishSurgeRoute(Object.assign({}, a.payload || {}, { org_id: org.id }));
        case 'drivers': return clone(T.drivers.filter((d) => d.status !== 'removed').sort((x, y) => x.name.localeCompare(y.name)));
        case 'messages': {
          let rows = T.messages.filter((m) => (!a.job_id || String(m.job_id) === String(a.job_id)) &&
            (!a.sender_role || m.sender_role === a.sender_role) && (!a.since || m.created_at >= a.since));
          rows.sort(byCreatedDesc); rows = rows.slice(0, Math.min(a.limit || 200, 2000));
          if ((a.order || 'desc') !== 'desc') rows.reverse();
          return clone(rows);
        }
        case 'post_message': {
          if (a.job_id && !jobById(a.job_id)) throw new Error('TP_DENIED: not one of your jobs');
          return addMessage({ job_id: a.job_id || null, sender: a.sender || 'Dispatcher',
            sender_role: ['dispatcher', 'system', 'agent'].includes(a.sender_role) ? a.sender_role : 'dispatcher', body: String(a.body || '').slice(0, 4000) });
        }
        case 'locations': return clone(T.driver_locations.slice().sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at))).slice(0, a.limit || 200));
        case 'agent_memory': {
          let rows = T.agent_memory.filter((m) => (!a.agent_name || m.agent_name === a.agent_name) && (!a.event_type || m.event_type === a.event_type) && (!a.since || m.created_at >= a.since));
          rows.sort(byCreatedDesc); return clone(rows.slice(0, a.limit || 100));
        }
        case 'agent_memory_insert': { const r = Object.assign({ id: T.agent_memory.length + 1, created_at: iso(), org_id: org.id }, pick(a, ['agent_name', 'event_type', 'job_id', 'driver_name', 'details'])); T.agent_memory.push(r); return clone(r); }
        case 'bin_shortfall': case 'shopify_connection': return [];
        case 'set_bin_label': return updateRows('jobs', jid, { bin_label: a.bin_label }, ['bin_label'], {});
        case 'set_staged': return updateRows('jobs', jid, { staged_at: a.staged ? iso() : null }, ['staged_at'], {});
        case 'bindings': return clone(T.bin_bindings.filter((b) => ['open', 'ready'].includes(b.state) && (!a.job_id || String(b.job_id) === String(a.job_id))));
        case 'open_binding': {
          const held = T.bin_bindings.find((x) => ['open', 'ready'].includes(x.state) && x.bin_code === a.bin_code && String(x.job_id) !== String(jid));
          if (held) { const hj = jobById(held.job_id) || {}; return { ok: false, error: 'bin_taken', bin_code: a.bin_code, route: hj.title, status: hj.status, job_id: held.job_id }; }
          const b = { id: uuid(), org_id: org.id, bin_code: a.bin_code, location_code: a.location_code, job_id: jid, state: 'open', opened_by: String(a.opened_by || '').slice(0, 80), opened_at: iso(), ready_at: null, released_at: null };
          T.bin_bindings.push(b); emit('row', { table: 'bin_bindings', row: b }); return clone(b);
        }
        case 'stage_binding': {
          const code = String(a.staging_code || '').trim().toUpperCase().replace(/^(STG|STAGE|STAGING)[:\s-]*/, '').trim();
          if (!code || code.length > 40) throw new Error('TP_INVALID: a staging code is required');
          const b = T.bin_bindings.filter((x) => String(x.job_id) === String(jid) && ['open', 'ready'].includes(x.state)).pop();
          if (!b) return { ok: false, error: 'no_bin' };
          if (b.state !== 'ready') return { ok: false, error: 'not_complete', bin_code: b.bin_code };
          if (b.staging_code === code) return { ok: true, idempotent: true, staging_code: code, bin_code: b.bin_code };
          const other = T.bin_bindings.find((x) => x !== b && x.staging_code === code && ['open', 'ready'].includes(x.state));
          if (other) { const oj = jobById(other.job_id) || {}; return { ok: false, error: 'spot_taken', staging_code: code, route: oj.title, status: oj.status }; }
          b.staging_code = code; b.staged_at = iso();
          const j = jobById(jid); j.staged_at = iso();
          emit('row', { table: 'bin_bindings', row: b }); emit('row', { table: 'jobs', row: j, patch: { staged_at: j.staged_at } });
          return { ok: true, staging_code: code, bin_code: b.bin_code };
        }
        case 'binding_ready': {
          T.bin_bindings.forEach((b) => { if (String(b.job_id) === String(jid) && b.state === 'open') { b.state = 'ready'; b.ready_at = iso(); emit('row', { table: 'bin_bindings', row: b }); } });
          return { ok: true };
        }
        case 'log_event': {
          if (a.idempotency_key && T.events.some((e) => e.idempotency_key === a.idempotency_key)) return { duplicate: true };
          const e = Object.assign({ id: T.events.length + 1, org_id: org.id }, pick(a, ['event_type', 'job_id', 'driver_name', 'actor', 'device_id', 'payload', 'idempotency_key']), { occurred_at: a.occurred_at || iso() });
          T.events.push(e); emit('event', e); return clone(e);
        }
        case 'events': return clone(T.events.filter((e) => (!a.types || a.types.includes(e.event_type)) && (!a.since || e.occurred_at >= a.since)).sort((x, y) => String(x.occurred_at).localeCompare(String(y.occurred_at))));
        case 'dispatch_phone': return { dispatch_phone: orgProfile[org.id] || null };
        case 'set_dispatch_phone': orgProfile[org.id] = String(a.phone || '').replace(/\D/g, '').slice(-10) || null; return { dispatch_phone: orgProfile[org.id] };
        case 'sign_out': return { ok: true };
        default: throw new Error('TP_INVALID: unknown action ' + action);
      }
    }
    function pick(o, ks) { const r = {}; ks.forEach((k) => { if (o[k] !== undefined) r[k] = o[k]; }); return r; }
    function addMessage(m) {
      const r = Object.assign({ id: ++msgId, created_at: iso() }, m);
      T.messages.push(r); emit('message', r); return clone(r);
    }

    // publish_surge_route: piece conservation + no piece already on a live
    // route; the same master_code returns the existing row.
    function publishSurgeRoute(p) {
      const existing = T.jobs.find((j) => j.master_code && j.master_code === p.master_code);
      if (existing) return { ok: true, job: clone(existing), idempotent: true };
      const pieces = [];
      (p.surge_stops || []).forEach((s) => (s.pkgs || []).forEach((pk) => pieces.push(String(pk.tracking_number || pk.order_id))));
      if (new Set(pieces).size !== pieces.length) return { ok: false, error: 'duplicate piece on the route' };
      const live = new Set();
      T.jobs.filter(isLive).forEach((j) => (j.surge_stops || []).forEach((s) => (s.pkgs || []).forEach((pk) => live.add(String(pk.tracking_number || pk.order_id)))));
      const clash = pieces.find((x) => live.has(x));
      if (clash) return { ok: false, error: 'piece ' + clash + ' is already on a live route' };
      const job = Object.assign({ id: uuid(), stops_completed: 0, archived: false, exception_flag: false, staged_at: null, picked_up_at: null, delivered_at: null, driver_name: null },
        pick(p, ['title', 'bin_label', 'job_type', 'org_id', 'pickup_address', 'dropoff_address', 'surge_stops', 'master_code', 'total_stops', 'total_packages', 'price', 'distance_miles', 'estimated_delivery_at', 'original_eta_at']),
        { status: 'pending', created_at: iso() });
      T.jobs.push(job); emit('row', { table: 'jobs', row: job, created: true });
      return { ok: true, job: clone(job) };
    }

    // ── DRIVER ──
    function driverSees(s, j) {
      return j.driver_name === s.driver_name || (['routing', 'pending'].includes(j.status) && !j.driver_name);
    }
    function tpDriver(tok, action, a) {
      const s = session(tok, 'driver');
      a = a || {};
      let op = null;
      if (['update_job', 'post_message'].includes(action) && a.client_id) {
        op = s.driver_key + '|' + String(a.client_id).slice(0, 100);
        if (clientOps.has(op)) return clone(clientOps.get(op));
      }
      const jid = a.id != null ? a.id : a.job_id;
      let j = null;
      if (jid != null && ['job', 'claim', 'update_job', 'messages', 'post_message', 'bin_binding'].includes(action)) {
        j = jobById(jid);
        if (!j || !driverSees(s, j)) throw new Error('TP_DENIED: this job is not available to you');
      }
      switch (action) {
        case 'me': return { id: s.driver_key, name: s.driver_name, phone: s.driver_phone, demo: false, dispatch_phone: orgProfile[org.id] || null };
        case 'jobs': {
          let rows = T.jobs.filter((x) => driverSees(s, x) &&
            (!a.statuses || a.statuses.includes(x.status)) &&
            (!a.mine || x.driver_name === s.driver_name) &&
            (!a.job_type || (a.job_type === 'not_surge' ? x.job_type !== 'surge' : x.job_type === a.job_type)));
          rows.sort(byCreatedDesc); return clone(rows.slice(0, Math.min(a.limit || 10, 50)));
        }
        case 'job': return clone(j);
        case 'claim': return updateRows('jobs', jid, { status: 'assigned', driver_name: s.driver_name }, ['status', 'driver_name'], { status: 'pending', driver_name: null });
        case 'update_job': {
          if (j.driver_name !== s.driver_name) throw new Error('TP_DENIED: this route is assigned to someone else');
          const p = Object.assign({}, a.patch || {});
          if ('status' in p && !['assigned', 'in_transit', 'delivered', 'completed_with_exceptions'].includes(p.status)) throw new Error('TP_INVALID: status ' + p.status + ' is not a driver status');
          if ('driver_name' in p && p.driver_name !== s.driver_name) throw new Error('TP_INVALID: a driver can only keep the route on their own name');
          if ('stops_completed' in p && +p.stops_completed < +(j.stops_completed || 0)) delete p.stops_completed;
          if (['delivered', 'completed_with_exceptions'].includes(j.status) && 'status' in p && !['delivered', 'completed_with_exceptions'].includes(p.status)) delete p.status;
          if (j.status === 'completed_with_exceptions' && p.status === 'delivered') delete p.status;
          if ((p.status === 'delivered' || p.status === 'completed_with_exceptions') && !j.delivered_at) p.delivered_at = iso();
          const res = Object.keys(p).some((k) => k !== 'driver_name')
            ? updateRows('jobs', jid, p, ['status', 'driver_name', 'stops_completed', 'picked_up_at', 'started_at', 'delivered_at'], { driver_name: s.driver_name })
            : [clone(j)];
          if (op) clientOps.set(op, res);
          return res;
        }
        case 'messages': {
          let rows = T.messages.filter((m) => String(m.job_id) === String(jid) && (!a.sender_role || m.sender_role === a.sender_role));
          rows.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
          if (a.order === 'desc') rows.reverse();
          return clone(rows.slice(0, a.limit || 200));
        }
        case 'post_message': {
          const r = addMessage({ job_id: jid, sender: a.sender === 'system' ? 'system' : s.driver_name, sender_role: a.sender === 'system' ? 'dispatcher' : 'driver', body: String(a.body || '').slice(0, 8000) });
          if (op) clientOps.set(op, r);
          return r;
        }
        case 'location': {
          if (a.job_id != null) { const jj = jobById(a.job_id); if (!jj || jj.driver_name !== s.driver_name) return { ok: false }; }
          setLocation(s.driver_name, a.job_id, a.lat, a.lng, a.accuracy, a.speed);
          return { ok: true };
        }
        case 'fcm_token': return { ok: true };
        case 'bin_binding': return clone(T.bin_bindings.filter((b) => String(b.job_id) === String(jid) && ['open', 'ready'].includes(b.state)).map((b) => ({ bin_code: b.bin_code, location_code: b.location_code, state: b.state })));
        case 'sign_out': return { ok: true };
        default: throw new Error('TP_INVALID: unknown action ' + action);
      }
    }
    function setLocation(name, jobId, lat, lng, accuracy, speed) {
      let r = T.driver_locations.find((l) => l.driver_name === name);
      if (!r) { r = { driver_name: name, name }; T.driver_locations.push(r); }
      Object.assign(r, { job_id: jobId || r.job_id || null, lat: +lat, lng: +lng, accuracy: accuracy == null ? null : +accuracy, speed: speed == null ? null : +speed, updated_at: iso() });
      emit('location', clone(r));
    }

    // Driver session for a roster driver (the demo signs drivers in up front;
    // the real app gets this from a texted code).
    function driverToken(name) {
      const d = T.drivers.find((x) => x.name === name);
      return newSession('driver', { driver_key: d.id, driver_name: d.name, driver_phone: d.phone });
    }
    const orgToken = () => newSession('org', {});

    // ── RPC entry point ──
    function rpc(fn, body) {
      body = body || {};
      switch (fn) {
        case 'tp_org': return tpOrg(body.p_token, body.p_action, body.p_args);
        case 'tp_driver': return tpDriver(body.p_token, body.p_action, body.p_args);
        case 'tp_org_lookup': return String(body.p_slug || '').toLowerCase() === org.slug ? { id: org.id, slug: org.slug, name: org.name } : null;
        case 'tp_org_sign_in':
          if (String(body.p_slug || '').trim().toLowerCase() !== org.slug) return { ok: false, error: 'TP_DENIED' };
          return { ok: true, token: orgToken(), org: { id: org.id, slug: org.slug, name: org.name } };
        case 'tp_sign_out': return { ok: true };
        case 'tp_driver_sign_in': {
          const ph = String(body.p_phone || '').replace(/\D/g, '').slice(-10);
          const d = T.drivers.find((x) => x.phone === ph);
          if (!d || !loginCodes.has(ph) || loginCodes.get(ph) !== String(body.p_code || '')) return { ok: false, error: 'TP_DENIED: wrong or expired code' };
          loginCodes.delete(ph);
          return { ok: true, token: driverToken(d.name), driver: { id: d.id, name: d.name, phone: d.phone } };
        }
        case 'publish_surge_route': return publishSurgeRoute(body.payload || {});
        default: throw new Error('TP_INVALID: unknown function ' + fn);
      }
    }

    // ── EDGE FUNCTIONS ──
    const ADDR = new Map();
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    D.STOPS.forEach((s) => ADDR.set(norm(s.address), { lat: s.lat, lng: s.lng }));
    ADDR.set(norm(D.COMPANY.hub.address), { lat: D.COMPANY.hub.lat, lng: D.COMPANY.hub.lng });
    function geocode(address) { return ADDR.get(norm(address)) || null; }
    const parseLL = (s) => { const [a, b] = String(s).split(',').map(Number); return [a, b]; };
    function fn(name, body) {
      body = body || {};
      if (name === 'driver-login') {
        // The real function texts a one-time code. The demo keeps the code here and sends nothing.
        const ph = String(body.phone || '').replace(/\D/g, '').slice(-10);
        loginCodes.set(ph, '481562');
        suppressed.push({ kind: 'sms', what: 'sign-in code', at: iso() }); emit('suppressed', { kind: 'sms', what: 'sign-in code' });
        return { status: 200, data: { ok: true } };
      }
      if (name === 'send-sms') { suppressed.push({ kind: 'sms', job_id: body.job_id, at: iso() }); emit('suppressed', { kind: 'sms', job_id: body.job_id }); return { status: 200, data: { ok: true, demo: 'SMS not sent (demo)' } }; }
      if (name === 'pod') {
        if (body.action === 'upload') {
          const path = body.job_id + '/stop-' + body.stop + '-' + body.kind + '-' + clock.now() + '.' + (/png/.test(body.content_type) ? 'png' : 'jpg');
          podFiles.set(path, body.data); emit('pod', { path, job_id: body.job_id, stop: body.stop, kind: body.kind });
          return { status: 200, data: { path } };
        }
        if (body.action === 'sign') return { status: 200, data: { url: podFiles.get(body.path) || '' } };
        return { status: 400, data: { error: 'unknown pod action' } };
      }
      if (name === 'smooth-api' || name === 'nav-proxy') {
        const p = body.params || {};
        if (body.action === 'geocode') {
          const c = geocode(p.address);
          return { status: 200, data: c ? { status: 'OK', results: [{ geometry: { location: c } }] } : { status: 'ZERO_RESULTS', results: [] } };
        }
        if (body.action === 'routes') {
          const r = M.route(parseLL(p.origin), parseLL(p.destination));
          return { status: 200, data: { routes: [{ duration: Math.round(r.seconds) + 's', distanceMeters: Math.round(r.meters) }] } };
        }
        if (body.action === 'matrix') {
          const out = [];
          (p.origins || []).forEach((o, i) => (p.destinations || []).forEach((d, j) => {
            const r = M.route([o.lat, o.lng], [d.lat, d.lng]);
            out.push({ originIndex: i, destinationIndex: j, condition: 'ROUTE_EXISTS', duration: Math.round(r.seconds) + 's', distanceMeters: Math.round(r.meters) });
          }));
          return { status: 200, data: out };
        }
        return { status: 400, data: { error: { message: 'unknown action' } } };
      }
      return { status: 404, data: { error: 'not available in the demo' } };
    }

    return { T, rpc, fn, geocode, setLocation, addMessage, driverToken, orgToken, tpDriver, tpOrg, suppressed, podFiles, org,
      iso, jobById };
  }

  root.createDemoBackend = createBackend;
})(typeof window !== 'undefined' ? window : globalThis);
