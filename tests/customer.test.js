const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

test('customer.html: estimated_delivery_at matches the real calculated currentEta at posting time', async () => {
  let lastPostedJob = null;
  const { dom, cleanup } = loadApp('customer.html', {
    fetchHandler: async (url, opts) => {
      if (url.includes('/jobs') && opts && opts.method === 'POST') {
        lastPostedJob = JSON.parse(opts.body);
        return { ok: true, json: async () => ([{ ...lastPostedJob, id: 'job1' }]) };
      }
    },
  });

  try {
    dom.window.eval(`
      document.getElementById('recipient').value = 'Jane Doe';
      document.getElementById('pickupAddr').value = '100 Main St';
      document.getElementById('pickupCity').value = 'Atlanta';
      document.getElementById('deliveryAddr').value = '200 Elm St';
      document.getElementById('deliveryCity').value = 'Atlanta';
    `);

    const before = Date.now();
    await dom.window.requestQuote();
    const actualCurrentEta = dom.window.eval('currentEta');
    await wait(300);

    assert.ok(lastPostedJob, 'expected a job to be posted');
    assert.ok(lastPostedJob.estimated_delivery_at, 'expected estimated_delivery_at to be set');

    const estimatedAt = new Date(lastPostedJob.estimated_delivery_at).getTime();
    const minutesUsed = Math.round((estimatedAt - before) / 60000);
    assert.ok(
      Math.abs(actualCurrentEta - minutesUsed) <= 1,
      `estimated_delivery_at (${minutesUsed}min) should match the real currentEta (${actualCurrentEta}min) at posting time`
    );
  } finally {
    cleanup();
  }
});
