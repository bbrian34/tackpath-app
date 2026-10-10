/* TackPath demo — runs FIRST inside each real TackPath page (dispatcher,
   PathIQ, driver app) before the page's own scripts. It connects the page to
   the demo instead of production:
   - network: /rest/v1/rpc/* and /functions/v1/* answered by the demo
     backend; Google geocoding answered from demo data; everything else
     external is refused (and the page's Content-Security-Policy blocks it too)
   - storage: an in-memory localStorage/sessionStorage owned by the demo
   - time: Date follows the demo clock; timers follow the demo speed and pause
   - Math.random: seeded, so every run is identical
   - native bridges (driver app / TC56): Capacitor plugins, GPS, vibration,
     text-to-speech and the Zebra scanner are demo stand-ins
   Nothing in the page's own code is changed. */
(function () {
  'use strict';
  var H = window.parent && window.parent.__TPDEMO__;
  var APP = window.__TP_APP__ || 'app';
  if (!H) return;
  var W = window;

  // ── errors, for the validation report ──
  W.addEventListener('error', function (e) { H.report('error', APP, String(e.message || e.error || ''), e.filename + ':' + e.lineno); });
  W.addEventListener('unhandledrejection', function (e) { H.report('rejection', APP, String(e.reason && e.reason.message || e.reason || '')); });
  var cerr = console.error.bind(console);
  console.error = function () { try { H.report('console', APP, Array.prototype.map.call(arguments, String).join(' ').slice(0, 300)); } catch (x) {} return cerr.apply(console, arguments); };
  console.log = function () {};   // the real pages log a lot of diagnostics; keep the console readable

  // ── storage (fresh on every run) ──
  function makeStorage(obj) {
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null; },
      setItem: function (k, v) { obj[k] = String(v); },
      removeItem: function (k) { delete obj[k]; },
      clear: function () { Object.keys(obj).forEach(function (k) { delete obj[k]; }); },
      key: function (i) { var ks = Object.keys(obj); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(obj).length; }
    };
  }
  Object.defineProperty(W, 'localStorage', { configurable: true, value: makeStorage(H.storage(APP)) });
  Object.defineProperty(W, 'sessionStorage', { configurable: true, value: makeStorage({}) });
  try { Object.defineProperty(W, 'indexedDB', { configurable: true, value: undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: function () { return Promise.resolve([]); }, register: function () { return Promise.reject(new Error('demo')); } } }); } catch (e) {}

  // ── demo clock ──
  var RealDate = W.Date;
  function DemoDate() {
    var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof DemoDate)) return new RealDate(H.clock.now()).toString();
    if (!a.length) return new RealDate(H.clock.now());
    return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
  }
  DemoDate.prototype = RealDate.prototype;
  DemoDate.now = function () { return H.clock.now(); };
  DemoDate.parse = RealDate.parse; DemoDate.UTC = RealDate.UTC;
  W.Date = DemoDate;

  // ── timers: follow the demo speed, hold while paused ──
  var rST = W.setTimeout.bind(W), rCT = W.clearTimeout.bind(W);
  var timers = new Map(), nextId = 1;
  // Short UI delays follow the presentation speed; polls and waits longer
  // than 1.5 s follow demo time (so a 10 s poll fires after 10 demo seconds).
  function scaled(ms) { ms = +ms || 0; return Math.max(0, ms / H.clock.speed() / (ms > 1500 ? H.clock.rate() : 1)); }
  // Long waits are measured in demo time while they run, so a change of
  // pace (driving faster, pausing) applies to timers already waiting.
  function demoWait(ms, done) {
    var start = H.clock.now(), h;
    var check = function () {
      var left = ms - (H.clock.now() - start);
      if (left <= 0 && !H.clock.paused()) return done();
      h = rST(check, Math.max(16, Math.min(250, scaled(Math.max(left, 0)) || 16)));
      return h;
    };
    return check;
  }
  function schedule(id, ms, fire) {
    if ((+ms || 0) > 1500) { var c = demoWait(+ms, fire); timers.set(id, rST(c, Math.min(250, scaled(ms)))); }
    else timers.set(id, rST(function chk() { if (H.clock.paused()) { timers.set(id, rST(chk, 120)); return; } fire(); }, scaled(ms)));
  }
  W.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2), id = nextId++;
    schedule(id, ms, function () {
      if (!timers.has(id)) return;
      timers.delete(id);
      try { typeof fn === 'function' ? fn.apply(W, args) : W.eval(fn); } catch (e) { H.report('error', APP, String(e && e.message || e), 'timer'); }
    });
    return id;
  };
  W.setInterval = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2), id = nextId++;
    ms = Math.max(16, +ms || 0);
    var tick = function () {
      if (!timers.has(id)) return;
      try { fn.apply(W, args); } catch (e) { H.report('error', APP, String(e && e.message || e), 'interval'); }
      if (timers.has(id)) schedule(id, ms, tick);
    };
    timers.set(id, 0); schedule(id, ms, tick);
    return id;
  };
  W.clearTimeout = W.clearInterval = function (id) { if (timers.has(id)) { rCT(timers.get(id)); timers.delete(id); } };
  W.__demoStop = function () { timers.forEach(function (h) { rCT(h); }); timers.clear(); };

  // ── deterministic randomness ──
  var seed = H.seedFor(APP);
  Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // ── network ──
  function resp(status, data) {
    return new Response(data === undefined ? '' : JSON.stringify(data), { status: status, headers: { 'Content-Type': 'application/json' } });
  }
  function bodyOf(opts) { try { return opts && opts.body ? JSON.parse(opts.body) : {}; } catch (e) { return {}; } }
  W.fetch = function (input, opts) {
    var url = String(typeof input === 'string' ? input : (input && input.url) || '');
    var body = bodyOf(opts);
    return new Promise(function (resolve, reject) {
      W.setTimeout(function () {
        try {
          var m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
          if (m) {
            H.count('rpc', APP, m[1] + (body.p_action ? ':' + body.p_action : ''));
            try { resolve(resp(200, H.backend().rpc(m[1], body))); }
            catch (e) { resolve(resp(/TP_AUTH/.test(e.message) ? 401 : /TP_DENIED/.test(e.message) ? 403 : 400, { message: e.message })); }
            return;
          }
          m = url.match(/\/functions\/v1\/([a-z-]+)/);
          if (m) { H.count('fn', APP, m[1] + (body.action ? ':' + body.action : '')); var r = H.backend().fn(m[1], body); resolve(resp(r.status, r.data)); return; }
          if (/\/rest\/v1\/[a-z_]+/.test(url)) {
            // Direct table access. Production refuses it since the 2026-10
            // lockdown, so the demo answers the same way.
            H.count('denied', APP, url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]);
            resolve(resp(401, { code: '42501', message: 'permission denied' }));
            return;
          }
          if (/maps\.googleapis\.com\/maps\/api\/geocode\/json/.test(url)) {
            H.count('geocode', APP, 'demo');
            var addr = new URL(url).searchParams.get('address');
            var c = H.backend().geocode(addr);
            resolve(resp(200, c ? { status: 'OK', results: [{ geometry: { location: c } }] } : { status: 'ZERO_RESULTS', results: [] }));
            return;
          }
          if (url.indexOf(location.origin) === 0 || /^(\/|\.\.?\/|[a-z0-9_-]+\.(json|png|svg|js|css))/i.test(url) && !/^https?:/i.test(url)) {
            H.count('static', APP, url); resolve(resp(404, {})); return;
          }
          H.blocked(APP, url);
          reject(new TypeError('Blocked by the TackPath demo: no external calls'));
        } catch (e) { reject(e); }
      }, H.latency(APP, url, body));
    });
  };
  W.XMLHttpRequest = function () { H.blocked(APP, 'XMLHttpRequest'); throw new Error('XMLHttpRequest is not available in the demo'); };
  W.WebSocket = function (u) { H.blocked(APP, 'WebSocket ' + u); throw new Error('WebSocket is not available in the demo'); };
  navigator.sendBeacon = function (u) { H.blocked(APP, 'beacon ' + u); return false; };

  // ── dialogs and windows ──
  W.alert = function (m) { H.emit('alert', { app: APP, text: String(m) }); };
  W.confirm = function () { return true; };
  W.prompt = function () { return ''; };
  W.open = function () {
    var buf = [];
    var fake = { closed: false, close: function () { fake.closed = true; }, focus: function () {}, print: function () {},
      document: { open: function () {}, write: function (s) { buf.push(s); }, close: function () { H.emit('window', { app: APP, html: buf.join('') }); } },
      location: { href: '' } };
    return fake;
  };

  // ── maps: the offline demo map instead of Google Maps ──
  // Embedded Google map iframes (maps.google.com/maps?q=…&output=embed)
  // are drawn with the offline map instead of loading Google.
  try {
    var ifd = Object.getOwnPropertyDescriptor(W.HTMLIFrameElement.prototype, 'src');
    Object.defineProperty(W.HTMLIFrameElement.prototype, 'src', { configurable: true,
      get: function () { return this.__demoSrc != null ? this.__demoSrc : ifd.get.call(this); },
      set: function (v) {
        v = String(v);
        if (/^https?:\/\/(maps\.google\.com|www\.google\.com\/maps)/.test(v)) {
          this.__demoSrc = v; H.count('static', APP, 'map-embed'); H.embedMap(this, new URL(v).searchParams.get('q') || ''); return;
        }
        ifd.set.call(this, v);
      } });
  } catch (e) {}
  W.google = H.map.makeGoogleShim(W);

  // ── device bridges ──
  try {
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: function (p) { H.emit('vibrate', { app: APP, pattern: p }); return true; } });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: function () { return H.online(APP); } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: H.geolocation(APP) });
  } catch (e) {}
  if (H.native(APP)) W.Capacitor = H.capacitor(APP, W);
  try { Object.defineProperty(W, 'speechSynthesis', { configurable: true, value: undefined }); } catch (e) {}
  // Sound: the pages' own beeps play, through a context the demo can mute.
  var RealAC = W.AudioContext || W.webkitAudioContext;
  if (RealAC) {
    W.AudioContext = W.webkitAudioContext = function () { var c = new RealAC(); H.audio(c); return c; };
  }

  // Camera (driver app): a simulated camera view the demo paints, and a
  // barcode detector that reads whatever label is held in front of it.
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: function () { return Promise.resolve(H.cameraStream(APP, W)); },
      enumerateDevices: function () { return Promise.resolve([{ kind: 'videoinput', label: 'Back camera', deviceId: 'demo' }]); }
    } });
  } catch (e) {}
  W.BarcodeDetector = function () {};
  W.BarcodeDetector.prototype.detect = function () { var c = H.cameraRead(APP); return Promise.resolve(c ? [{ rawValue: c, format: 'code_128' }] : []); };
  W.BarcodeDetector.getSupportedFormats = function () { return Promise.resolve(['qr_code', 'code_128']); };

  // Read-only peeks at a page's own state, for the demo's checks. The names
  // resolve at call time against the page's globals.
  /* global binMap */
  W.__demoPeek = function (what) {
    if (what === 'binMapSize') return typeof binMap === 'undefined' ? -1 : Object.keys(binMap).length;
    return null;
  };

  H.ready(APP, W);
})();
