const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

function buildMockBackend() {
  const mockOrgs = [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }];
  const allJobs = [
    {
      id: 'job-active-1', title: 'Active Job', org_id: 'org-demo-uuid', status: 'in_transit',
      archived: false, created_at: '2026-07-25T10:00:00Z', driver_name: 'Marcus',
    },
    {
      id: 'job-delivered-1', title: 'Delivered On Time', org_id: 'org-demo-uuid', status: 'delivered',
      archived: false, driver_name: 'Marcus',
      created_at: '2026-07-25T09:00:00Z',
      picked_up_at: '2026-07-25T09:05:00Z',
      estimated_delivery_at: '2026-07-25T09:35:00Z',
      delivered_at: '2026-07-25T09:30:00Z', // 5 min early
    },
  ];

  const fetchHandler = async (url, opts) => {
    if (url.includes('/organizations')) return { ok: true, json: async () => mockOrgs };
    if (url.includes('/jobs') && opts && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      const idMatch = url.match(/id=eq\.([^&]+)/);
      if (idMatch) {
        const job = allJobs.find((j) => j.id === idMatch[1]);
        if (job) Object.assign(job, body);
      }
      return { ok: true, json: async () => ([]) };
    }
    if (url.includes('/jobs')) {
      // The app now fetches all org-matched jobs and filters archived client-side,
      // so the mock simply returns everything and trusts the app to split it correctly.
      return { ok: true, json: async () => allJobs };
    }
    return undefined;
  };

  return { mockOrgs, allJobs, fetchHandler };
}

test('dispatcher.html: manual login starts live polling so new jobs appear without a manual refresh', async () => {
  const mockOrgs = [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }];
  let allJobs = [];

  const fetchHandler = async (url) => {
    if (url.includes('/organizations')) return { ok: true, json: async () => mockOrgs };
    if (url.includes('driver_locations')) return { ok: true, json: async () => ([]) };
    if (url.includes('/jobs')) return { ok: true, json: async () => allJobs };
    return undefined;
  };

  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });
  try {
    dom.window.google = { maps: { Map: function(){}, Marker: function(){}, SymbolPath: { CIRCLE: 0 } } };
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(300);

    assert.strictEqual(dom.window.eval('jobs.length'), 0, 'no jobs should exist at login time');
    assert.ok(dom.window.eval('dispatchPollId') !== null, 'polling interval should be started after manual login');

    // Simulate a job appearing (e.g. via SmartSort + driver acceptance) with no manual refresh
    allJobs = [{ id: 'new-job', title: 'New Job', org_id: 'org-demo-uuid', status: 'in_transit',
      archived: false, driver_name: 'Marcus', created_at: new Date().toISOString() }];

    await wait(5300); // past one real poll cycle

    assert.strictEqual(dom.window.eval('jobs.length'), 1, 'new job should appear automatically without a manual refresh');
    assert.strictEqual(dom.window.eval('jobs[0].id'), 'new-job');
  } finally {
    cleanup();
  }
});

test('dispatcher.html: a job with no org_id (e.g. from SmartSort) still shows up when a specific org is logged in', async () => {
  const mockOrgs = [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }];
  const allJobs = [
    {
      id: 'job-no-org', title: 'SmartSort Route', org_id: null, status: 'in_transit',
      archived: false, created_at: '2026-07-27T10:00:00Z', driver_name: 'Marcus',
    },
  ];
  const fetchHandler = async (url, opts) => {
    if (url.includes('/organizations')) return { ok: true, json: async () => mockOrgs };
    if (url.includes('/jobs')) return { ok: true, json: async () => allJobs };
    return undefined;
  };

  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });
  try {
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(400);

    assert.strictEqual(dom.window.eval('jobs.length'), 1, 'a null-org job should still appear on the board of a logged-in org');
    assert.strictEqual(dom.window.eval('jobs[0].id'), 'job-no-org');
  } finally {
    cleanup();
  }
});

test('dispatcher.html: Sprint-tab exceptions panel correctly detects Late, Unassigned, Driver Dark, and Cancelled jobs', async () => {
  const mockOrgs = [{ id: 'org-demo-uuid', slug: 'demo', name: 'Demo Company' }];
  const now = Date.now();
  const allJobs = [
    { id: 'j-late', title: 'Late job', org_id: 'org-demo-uuid', status: 'in_transit', archived: false,
      created_at: new Date(now - 60*60000).toISOString(), updated_at: new Date(now - 5*60000).toISOString(),
      estimated_delivery_at: new Date(now - 10*60000).toISOString(), driver_name: 'Marcus' },
    { id: 'j-unassigned', title: 'Unassigned job', org_id: 'org-demo-uuid', status: 'pending', archived: false,
      created_at: new Date(now - 20*60000).toISOString() },
    { id: 'j-dark', title: 'Dark driver job', org_id: 'org-demo-uuid', status: 'in_transit', archived: false,
      created_at: new Date(now - 90*60000).toISOString(), updated_at: new Date(now - 40*60000).toISOString(),
      driver_name: 'Alex' },
    { id: 'j-cancelled', title: 'Cancelled job', org_id: 'org-demo-uuid', status: 'cancelled', archived: false,
      created_at: new Date(now - 30*60000).toISOString() },
    { id: 'j-healthy', title: 'Healthy job', org_id: 'org-demo-uuid', status: 'in_transit', archived: false,
      created_at: new Date(now - 5*60000).toISOString(), updated_at: new Date(now - 1*60000).toISOString(),
      estimated_delivery_at: new Date(now + 20*60000).toISOString(), driver_name: 'Sam' },
  ];

  const fetchHandler = async (url) => {
    if (url.includes('/organizations')) return { ok: true, json: async () => mockOrgs };
    if (url.includes('/jobs')) return { ok: true, json: async () => allJobs };
    return undefined;
  };

  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });
  try {
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(500);

    await dom.window.eval('renderSprint()');
    await wait(200);

    const badge = dom.window.document.getElementById('sl-exc-badge').textContent;
    const excHtml = dom.window.document.getElementById('sl-exceptions').innerHTML;

    assert.strictEqual(badge, '4 OPEN', 'expected exactly 4 flagged jobs');
    assert.ok(excHtml.includes('j-late') && excHtml.includes('past estimated delivery'), 'late job should be flagged with the right reason');
    assert.ok(excHtml.includes('j-unassi') && excHtml.includes('Unassigned - no driver'), 'unassigned job should be flagged with the right reason');
    assert.ok(excHtml.includes('j-dark') && excHtml.includes('Driver dark'), 'dark-driver job should be flagged with the right reason');
    assert.ok(excHtml.includes('j-cancel') && excHtml.includes('Order cancelled'), 'cancelled job should be flagged with the right reason');
    assert.ok(!excHtml.includes('j-health'), 'a healthy, on-time job should not be flagged');
  } finally {
    cleanup();
  }
});

test('dispatcher.html: archiving a delivered job removes it from the active board and into History', async () => {
  const { allJobs, fetchHandler } = buildMockBackend();
  const { dom, cleanup } = loadApp('dispatcher.html', { fetchHandler });

  try {
    dom.window.document.getElementById('loginOrgCode').value = 'demo';
    await dom.window.doLogin();
    await wait(400);

    assert.strictEqual(dom.window.eval('jobs.length'), 2, 'expected both jobs visible before archiving');

    dom.window.confirm = () => true; // auto-confirm the archive dialog
    await dom.window.archiveJob('job-delivered-1');
    await wait(400);

    assert.strictEqual(
      allJobs.find((j) => j.id === 'job-delivered-1').archived,
      true,
      'archived flag should be set on the underlying record'
    );
    assert.strictEqual(dom.window.eval('jobs.length'), 1, 'archived job should drop off the active board');
    assert.ok(
      !dom.window.eval('jobs.some(j => j.id === "job-delivered-1")'),
      'active job list should no longer include the archived job'
    );

    await dom.window.renderHistory();
    await wait(200);
    const historyHtml = dom.window.document.getElementById('historyList').innerHTML;

    assert.ok(historyHtml.includes('Delivered On Time'), 'History should show the archived delivery');
    assert.ok(historyHtml.includes('5 min early'), 'History should show the correct early/late timing label');
    assert.ok(!historyHtml.includes('Active Job'), 'History should not include jobs that are still active');
  } finally {
    cleanup();
  }
});
