const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

test('dispatcher.html: SmartSort integration builds real geo-sequenced routes and assigns them with correct org context', async () => {
  const mockOrgs = [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }];
  const geoLookup = {
    '142 Peachtree St NW, Atlanta GA 30303': { lat: 33.7590, lng: -84.3900 },
    '890 Marietta St NW, Atlanta GA 30318': { lat: 33.7770, lng: -84.4130 },
    '1180 Peachtree St NE, Atlanta GA 30309': { lat: 33.7910, lng: -84.3840 },
  };
  let postedJobs = [];
  let allJobs = [];

  const fetchHandler = async (url, opts) => {
    if (url.includes('maps.googleapis.com/maps/api/geocode')) {
      const match = url.match(/address=([^&]+)/);
      const addr = decodeURIComponent(match[1]);
      const coords = geoLookup[addr];
      return coords
        ? { ok: true, json: async () => ({ status: 'OK', results: [{ geometry: { location: coords } }] }) }
        : { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
    }
    if (url.includes('/organizations')) return { ok: true, json: async () => mockOrgs };
    if (url.includes('driver_locations')) return { ok: true, json: async () => ([]) };
    if (url.includes('/jobs') && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      postedJobs.push(body);
      return { ok: true, json: async () => ([{ ...body, id: 'new-job-1' }]) };
    }
    if (url.includes('/jobs')) return { ok: true, json: async () => allJobs };
    return undefined;
  };

  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });
  try {
    dom.window.google = { maps: { Map: function(){}, Marker: function(){}, SymbolPath: { CIRCLE: 0 } } };
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(500);

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

    const pkgTableHtml = dom.window.document.getElementById('pkgRows').innerHTML;
    assert.ok(pkgTableHtml.includes('Marcus') && pkgTableHtml.includes('890 Marietta'), 'package table should show real uploaded data');

    await dom.window.eval('buildRoutes()');
    await wait(200);

    const routes = dom.window.eval('ssRoutes');
    assert.notStrictEqual(routes[0].est_miles, (1.8 + 3 * 1.6).toFixed(1), 'distance should be real, not the old fake formula');

    const gridHtml = dom.window.document.getElementById('routeGrid').innerHTML;
    assert.ok(!gridHtml.includes('Show Map') && !gridHtml.includes('rc-map-btn'), 'map button should be excluded as requested');
    assert.ok(gridHtml.includes('Master Scan Code'), 'master scan code should be shown');

    await dom.window.eval('assignSSRoute(ssRoutes[0].id)');
    await wait(200);

    assert.strictEqual(postedJobs[0] && postedJobs[0].org_id, 'org-demo-uuid', 'posted job should use the real current org id');
    assert.strictEqual(postedJobs[0] && postedJobs[0].job_type, 'surge', 'posted job should be tagged as surge');
    assert.ok(postedJobs[0] && postedJobs[0].estimated_delivery_at, 'posted job should have a real estimated delivery time');
  } finally {
    cleanup();
  }
});
