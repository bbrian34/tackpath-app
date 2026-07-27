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
      let results = allJobs;
      if (url.includes('archived.eq.true')) results = results.filter((j) => j.archived === true);
      else results = results.filter((j) => j.archived !== true);
      return { ok: true, json: async () => results };
    }
    return undefined;
  };

  return { mockOrgs, allJobs, fetchHandler };
}

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
