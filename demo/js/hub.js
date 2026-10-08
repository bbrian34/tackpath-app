/* TackPath demo — the hub every embedded app connects to (window.__TPDEMO__).
   Owns the demo clock, the backend, per-app storage, the GPS stream and the
   native-bridge stand-ins, and loads the real TackPath pages into iframes
   with the adapter injected first. */
(function (root) {
  'use strict';
  const D = root.DEMO_DATA;

  // ── CLOCK ── demo time advances at `rate` × speed while running.
  function createClock(startIso) {
    let base = Date.parse(startIso), realAt = performance.now(), rate = 1, speed = 1, paused = true;
    const listeners = new Set();
    const now = () => paused ? base : base + (performance.now() - realAt) * rate * speed;
    function rebase() { base = now(); realAt = performance.now(); }
    return {
      now, speed: () => speed, paused: () => paused, rate: () => rate,
      setRate(r) { rebase(); rate = r; },
      setSpeed(s) { rebase(); speed = s; listeners.forEach((f) => f()); },
      pause() { if (paused) return; base = now(); paused = true; listeners.forEach((f) => f()); },
      resume() { if (!paused) return; realAt = performance.now(); paused = false; listeners.forEach((f) => f()); },
      jump(ms) { rebase(); base += ms; },
      on(f) { listeners.add(f); return () => listeners.delete(f); }
    };
  }

  function createHub(opts) {
    // The operation starts at 7:52 AM today, in the viewer's own time zone,
    // so every clock in every app reads like a real morning shift.
    const start = new Date(); start.setHours(7, 52, 0, 0);
    const clock = createClock(opts.startIso || start.toISOString());
    const listeners = {};
    const stats = { rpc: {}, fn: {}, geocode: {}, static: {}, denied: {}, blocked: [], errors: [], alerts: [], windows: [], suppressed: [] };
    let backend = null;
    const storages = {}, frames = {}, wins = {}, readyWaiters = {};
    const gps = { watchers: new Map(), last: null, next: 1 };
    let scanner = null;
    const notifications = [];
    let onlineState = true;
    const audioCtxs = [];
    let soundOn = true;
    // Camera: one picture at a time; a code is read once per time it is shown.
    const cam = { scene: null, pending: null, live: 0, shownAt: 0 };

    function emit(type, data) { (listeners[type] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); (listeners['*'] || []).forEach((f) => { try { f(type, data); } catch (e) {} }); }
    function on(type, f) { (listeners[type] = listeners[type] || []).push(f); return () => { listeners[type] = listeners[type].filter((x) => x !== f); }; }

    backend = root.createDemoBackend({ clock, emit });

    const hub = {
      clock, stats, on, emit,
      map: root.DEMO_MAP,
      backend: () => backend,
      storage: (app) => storages[app] || (storages[app] = {}),
      seedFor: (app) => ({ dispatcher: 11, pathiq: 23, driver: 37 }[app] || 5),
      latency: (app, url, body) => (hub.latencyFn && hub.latencyFn(app, url, body)) || 35,
      count(kind, app, what) { const k = app + ' ' + what; stats[kind][k] = (stats[kind][k] || 0) + 1; },
      blocked(app, url) { stats.blocked.push({ app, url }); },
      report(kind, app, msg, where) { stats.errors.push({ kind, app, msg, where, at: clock.now() }); },
      online: () => onlineState,
      native: (app) => app === 'driver' || app === 'pathiq',
      ready(app, w) { wins[app] = w; (readyWaiters[app] || []).forEach((f) => f(w)); readyWaiters[app] = []; },
      geolocation(app) {
        return {
          watchPosition(ok) { const id = gps.next++; gps.watchers.set(id, ok); if (gps.last) setTimeout(() => ok(gps.last), 0); return id; },
          clearWatch(id) { gps.watchers.delete(id); },
          getCurrentPosition(ok) { if (gps.last) setTimeout(() => ok(gps.last), 0); }
        };
      },
      capacitor(app, w) {
        const ls = {};
        const listen = (plugin) => (name, fn) => { (ls[plugin + ':' + name] = ls[plugin + ':' + name] || []).push(fn); return Promise.resolve({ remove() {} }); };
        const ok = (v) => Promise.resolve(v === undefined ? {} : v);
        const P = {
          TextToSpeech: { speak: (o) => { emit('speak', { app, text: o && o.text }); return ok(); }, stop: () => ok() },
          LocalNotifications: {
            requestPermissions: () => ok({ display: 'granted' }), checkPermissions: () => ok({ display: 'granted' }),
            createChannel: () => ok(), registerActionTypes: () => ok(), addListener: listen('LocalNotifications'),
            schedule: (o) => { (o && o.notifications || []).forEach((n) => { notifications.push(n); emit('notification', { app, n }); }); return ok(); },
            cancel: () => ok()
          },
          PushNotifications: {
            createChannel: () => ok(), checkPermissions: () => ok({ receive: 'granted' }), requestPermissions: () => ok({ receive: 'granted' }),
            removeAllListeners: () => ok(), addListener: listen('PushNotifications'), register: () => ok()
          },
          AppLauncher: { openUrl: (o) => { emit('openUrl', { app, url: o && o.url }); return ok({ completed: true }); }, canOpenUrl: () => ok({ value: true }) },
          ArrivalPlugin: {
            start: (o) => { emit('arrivalStart', Object.assign({ app }, o)); return ok(); },
            stop: () => { emit('arrivalStop', { app }); return ok(); },
            overlayStatus: () => ok({ granted: true }), openOverlaySettings: () => ok()
          },
          ZebraScanner: { addListener: (name, fn) => { if (name === 'scan') scanner = fn; return ok({ remove() {} }); } }
        };
        return { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android', Plugins: P, __listeners: ls };
      },

      // ── for the director ──
      win: (app) => wins[app],
      whenReady: (app) => new Promise((res) => { if (wins[app]) res(wins[app]); else (readyWaiters[app] = readyWaiters[app] || []).push(res); }),
      scan(code) { if (!scanner) throw new Error('PathIQ scanner not attached'); scanner({ value: code }); },
      gpsFix(lat, lng, heading, speed) {
        gps.last = { coords: { latitude: lat, longitude: lng, accuracy: 6, heading: heading || 0, speed: speed || 0, altitude: null }, timestamp: clock.now() };
        gps.watchers.forEach((f) => { try { f(gps.last); } catch (e) {} });
        emit('gps', { lat, lng, heading: heading || 0, speed: speed || 0 });
      },
      setOnline(v) { onlineState = v; },
      // A small offline map with a pin, in place of an embedded Google map.
      embedMap(iframe, q) {
        const c = backend.geocode(q);
        iframe.onload = () => {
          try {
            const d = iframe.contentDocument; d.body.style.margin = '0';
            const div = d.createElement('div'); div.style.cssText = 'position:absolute;inset:0'; d.body.appendChild(div);
            const v = new root.DEMO_MAP.MapView(div, { theme: 'dark', center: c || { lat: 33.7790, lng: -84.3930 }, mpp: c ? 2.2 : 6, labels: true });
            if (c) new root.DEMO_MAP.PinMarker(v, c, '<div style="width:18px;height:18px;border-radius:50%;background:#19b7ef;border:3px solid #fff;box-shadow:0 0 0 8px rgba(25,183,239,.25)"></div>');
          } catch (e) {}
        };
        iframe.srcdoc = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"></head><body></body></html>';
      },
      audio(c) { audioCtxs.push(c); if (!soundOn) { try { c.suspend(); } catch (e) {} } },
      setSound(v) { soundOn = !!v; audioCtxs.forEach((c) => { try { v ? c.resume() : c.suspend(); } catch (e) {} }); },
      sound: () => soundOn,
      // Hold something in front of the driver's camera. `read` = the scanner decodes it.
      showCamera(scene, read) { cam.scene = scene; cam.pending = read === false ? null : (scene && scene.code) || null; cam.shownAt = performance.now(); },
      cameraLive: () => cam.live > 0,
      cameraStream(app, w) {
        const c = document.createElement('canvas'); c.width = 720; c.height = 960;
        const ctx = c.getContext('2d');
        let on = true;
        const loop = () => { if (!on) return; try { root.DEMO_CAMERA.draw(ctx, c.width, c.height, cam.scene, performance.now()); } catch (e) {} requestAnimationFrame(loop); };
        loop();
        const stream = c.captureStream(24);
        cam.live++;
        stream.getTracks().forEach((t) => { const stop = t.stop.bind(t); t.stop = () => { if (on) { on = false; cam.live--; } stop(); }; });
        return stream;
      },
      cameraRead(app) {
        // Give the picture a moment on screen before it is decoded, like a real scanner.
        if (!cam.pending || cam.live <= 0 || performance.now() - cam.shownAt < 350 / Math.max(1, clock.speed())) return null;
        const c = cam.pending; cam.pending = null; return c;
      },
      frames, notifications,
      seedStorage(app, obj) { Object.assign(hub.storage(app), obj); }
    };
    return hub;
  }

  // Load a real TackPath page into an iframe with the adapter first.
  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; frame-src 'self' about: data:; " +
    "worker-src 'none'; form-action 'none'";
  let adapterSrc = null, fontCss = null;
  async function pageSource(src, app, baseHref) {
    if (!adapterSrc) adapterSrc = await (await fetch('js/adapter.js')).text();
    if (!fontCss) fontCss = root.DEMO_FONT_CSS(new URL('vendor/fonts/', location.href).href);
    let html = await (await fetch(src)).text();
    const lib = (f) => new URL(f, location.href).href;
    html = html.replace(/https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/JsBarcode|cdn\.jsdelivr\.net\/npm\/jsbarcode)[^"'\\]*/g, lib('../jsbarcode.min.js'))
      .replace(/https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/qrcodejs|cdn\.jsdelivr\.net\/npm\/qrcode@)[^"'\\]*/g, lib('vendor/qrcode.min.js'));
    html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '')
      .replace(/@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/gi, '');
    const head = '<base href="' + baseHref + '">'
      + '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
      + '<style>' + fontCss + '</style>'
      + '<script>window.__TP_APP__=' + JSON.stringify(app) + ';<\/script>'
      + '<script>' + adapterSrc.replace(/<\/script/gi, '<\\/script') + '<\/script>';
    return html.replace(/<head([^>]*)>/i, (m) => m + head);
  }
  async function loadApp(iframe, src, app, baseHref) {
    iframe.srcdoc = await pageSource(src, app, baseHref);
  }

  root.DEMO_FONT_CSS = function (base) {
    const faces = [['DM Sans', 'dm-sans', [400, 500, 600, 700, 800, 900]], ['DM Mono', 'dm-mono', [400, 500]], ['Montserrat', 'montserrat', [500, 700, 800]],
      ['Dancing Script', 'dancing-script', [700]], ['Inter', 'inter', [300, 400, 600, 700, 800, 900]], ['IBM Plex Mono', 'ibm-plex-mono', [400, 500, 600]],
      ['Barlow Condensed', 'barlow-condensed', [700, 900]]];
    return faces.map(([fam, file, ws]) => ws.map((w) => "@font-face{font-family:'" + fam + "';font-weight:" + w + ";font-style:normal;font-display:block;src:url('" + base + file + '-latin-' + w + "-normal.woff2') format('woff2');}").join('')).join('');
  };
  root.createDemoHub = createHub;
  root.loadDemoApp = loadApp;
})(window);
