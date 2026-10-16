const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

// SmartSort in dispatcher.html (rewritten 2026-10). The earlier version
// signed in through a raw /organizations read, read the per-package table
// (#pkgRows, removed from the drawer: it now shows the stop / package counts
// and the progress bar) and expected a raw POST to /rest/v1/jobs; sign-in is
// now tp_org_sign_in and routes are published through the publish_surge_route
// gate (sent by the page as tp_org 'publish_route' with the org session). Same checks: real data in, real geo-sequenced routes, real distance,
// the master scan code, and the route published as surge with the org id and
// an ETA.
test('dispatcher.html: SmartSort integration builds real geo-sequenced routes and assigns them with correct org context', async () => {
  const org = { id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' };
  const geoLookup = {
    '142 Peachtree St NW, Atlanta GA 30303': { lat: 33.7590, lng: -84.3900 },
    '890 Marietta St NW, Atlanta GA 30318': { lat: 33.7770, lng: -84.4130 },
    '1180 Peachtree St NE, Atlanta GA 30309': { lat: 33.7910, lng: -84.3840 },
    '1000 Whitlock Ave, Marietta, GA 30064': { lat: 33.9520, lng: -84.5650 },   // the depot
  };
  const published = [];
  const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const fetchHandler = async (url, opts) => {
    if (url.includes('maps.googleapis.com/maps/api/geocode')) {
      const coords = geoLookup[decodeURIComponent(url.match(/address=([^&]+)/)[1])];
      return json(coords ? { status: 'OK', results: [{ geometry: { location: coords } }] } : { status: 'ZERO_RESULTS', results: [] });
    }
    if (url.includes('/functions/v1/smooth-api')) {                       // the road matrix (Routes API shape)
      const { action, params } = JSON.parse(opts.body);
      if (action !== 'matrix') return json([]);
      const m = (a, b) => { const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; };
      const out = [];
      params.origins.forEach((o, i) => params.destinations.forEach((d, j) => { const meters = Math.round(m(o, d));
        out.push({ originIndex: i, destinationIndex: j, condition: 'ROUTE_EXISTS', distanceMeters: meters, duration: Math.round(meters / 13.4) + 's' }); }));
      return json(out);
    }
    if (url.includes('/rpc/tp_org_sign_in')) return json({ ok: true, token: 'org-tok', org });
    if (url.includes('/rpc/tp_org')) {                                      // the page sends publish_surge_route through tp_org
      const body = JSON.parse(opts.body);
      if (body.p_action === 'publish_route') {
        assert.strictEqual(body.p_token, 'org-tok', 'published with the org session');
        published.push(body.p_args.payload);
        return json({ ok: true, id: 'new-job-1' });
      }
      return json([]);
    }
    if (url.includes('/rpc/')) return json([]);
    return json([]);
  };

  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });
  try {
    dom.window.google = { maps: { Map: function () {}, Marker: function () {}, SymbolPath: { CIRCLE: 0 } } };
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(500);
    assert.strictEqual(dom.window.eval('currentOrgId'), 'org-demo-uuid', 'signed in through tp_org_sign_in');

    dom.window.openSmartSortDrawer();
    assert.ok(dom.window.document.getElementById('smartSortDrawer').classList.contains('open'), 'drawer should open');

    dom.window.eval(`
      packages = [
        { order_id: 'TP1', recipient: 'Marcus', address: '142 Peachtree St NW, Atlanta GA 30303', packages: 2 },
        { order_id: 'TP2', recipient: 'Sarah', address: '890 Marietta St NW, Atlanta GA 30318', packages: 1 },
        { order_id: 'TP3', recipient: 'David', address: '1180 Peachtree St NE, Atlanta GA 30309', packages: 3 },
      ];
      renderPackageTable();
    `);
    await wait(100);
    const $ = (id) => dom.window.document.getElementById(id);
    assert.strictEqual($('statStops').textContent, '3', 'the uploaded stops are counted');
    assert.strictEqual($('statPkgs').textContent, '6', 'the uploaded packages are counted');

    await dom.window.eval('buildRoutes()');
    await wait(200);

    const routes = dom.window.eval('ssRoutes');
    assert.ok(routes && routes.length >= 1, 'routes built');
    const stops = JSON.parse(JSON.stringify(routes.flatMap((r) => r.stops.flatMap((s) => (s.pkgs || []).map((p) => p.order_id))))).sort();
    assert.deepStrictEqual(stops, ['TP1', 'TP2', 'TP3'], 'every stop routed exactly once');
    assert.ok(routes[0].stops.every((s) => s.coords && typeof s.coords.lat === 'number'), 'geocoded stops');
    assert.notStrictEqual(routes[0].est_miles, (1.8 + 3 * 1.6).toFixed(1), 'distance should be real, not the old fake formula');

    const gridHtml = $('routeGrid').innerHTML;
    assert.ok(!gridHtml.includes('Show Map') && !gridHtml.includes('rc-map-btn'), 'map button should be excluded as requested');
    assert.ok(gridHtml.includes('Master Scan Code'), 'master scan code should be shown');

    await dom.window.eval('assignSSRoute(ssRoutes[0].id)');
    await wait(200);

    assert.strictEqual(published.length, 1, 'published through the publish_surge_route gate');
    assert.strictEqual(published[0].org_id, 'org-demo-uuid', 'posted job should use the real current org id');
    assert.strictEqual(published[0].job_type, 'surge', 'posted job should be tagged as surge');
    assert.ok(published[0].estimated_delivery_at, 'posted job should have a real estimated delivery time');
    assert.strictEqual(published[0].master_code, routes[0].master_code);
  } finally {
    cleanup();
  }
});
