const test = require('node:test');
const assert = require('node:assert');
const { loadApp, wait } = require('./helpers');

test('driver.html: captures picked_up_at when a job is accepted', async () => {
  const patchCalls = [];
  const { dom, cleanup } = loadApp('driver.html', {
    initialStorage: {
      tp_drv: JSON.stringify({ id: 'drv-1', phone: '4045551234', name: 'Marcus', first: 'Marcus' }),
    },
    fetchHandler: async (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        patchCalls.push({ url, body: JSON.parse(opts.body) });
      }
    },
  });

  try {
    await wait(1200);
    assert.strictEqual(dom.window.eval('driver ? driver.name : "NULL"'), 'Marcus');

    dom.window.eval(`
      pendingJob = {
        id: 'job-ts-test', job_type: 'single',
        surge_stops: JSON.stringify([{ address: '100 A St, Atlanta, GA', recipient: 'Alice' }]),
        price: 30
      };
    `);
    const acceptTime = Date.now();
    await dom.window.eval('acceptOffer()');
    await wait(300);

    const pickupPatch = patchCalls.find((c) => c.body.picked_up_at);
    assert.ok(pickupPatch, 'expected a PATCH call setting picked_up_at');
    const delta = Math.abs(new Date(pickupPatch.body.picked_up_at).getTime() - acceptTime);
    assert.ok(delta < 2000, 'picked_up_at should be captured at the moment of acceptance');
  } finally {
    cleanup();
  }
});

test('driver.html: captures delivered_at when the final stop is confirmed', async () => {
  const patchCalls = [];
  const { dom, cleanup } = loadApp('driver.html', {
    initialStorage: {
      tp_drv: JSON.stringify({ id: 'drv-1', phone: '4045551234', name: 'Marcus', first: 'Marcus' }),
    },
    fetchHandler: async (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        patchCalls.push({ url, body: JSON.parse(opts.body) });
      }
    },
  });

  try {
    await wait(1200);

    dom.window.eval(`
      pendingJob = {
        id: 'job-ts-test-2', job_type: 'single',
        surge_stops: JSON.stringify([{ address: '100 A St, Atlanta, GA', recipient: 'Alice' }]),
        price: 30
      };
    `);
    await dom.window.eval('acceptOffer()');
    await wait(300);

    const confirmTime = Date.now();
    assert.strictEqual(dom.window.eval('typeof confirmSurgeStop'), 'function');
    await dom.window.eval('confirmSurgeStop()');
    await wait(300);

    const deliveredPatch = patchCalls.find((c) => c.body.delivered_at);
    assert.ok(deliveredPatch, 'expected a PATCH call setting delivered_at');
    const delta = Math.abs(new Date(deliveredPatch.body.delivered_at).getTime() - confirmTime);
    assert.ok(delta < 2000, 'delivered_at should be captured at final-stop confirmation');
  } finally {
    cleanup();
  }
});

test('driver.html: clears saved route state on delivery completion so a stale job cannot block future offers', async () => {
  const { dom, storage, cleanup } = loadApp('driver.html', {
    initialStorage: {
      tp_drv: JSON.stringify({ id: 'drv-1', phone: '4045551234', name: 'Marcus', first: 'Marcus' }),
    },
  });

  let dom2Cleanup = null;
  try {
    await wait(1200);
    dom.window.eval(`
      pendingJob = {
        id: 'job-complete-test', job_type: 'single',
        surge_stops: JSON.stringify([{ address: '100 A St, Atlanta, GA', recipient: 'Alice' }]),
        price: 30
      };
    `);
    await dom.window.eval('acceptOffer()');
    await wait(300);
    await dom.window.eval('confirmSurgeStop()'); // completes the only stop
    await wait(300);

    assert.strictEqual(
      storage.tp_route_state,
      undefined,
      'saved route state should be cleared once the delivery is complete, not left stale'
    );

    // Simulate closing and reopening the app right after completion.
    const second = loadApp('driver.html', { initialStorage: { ...storage } });
    dom2Cleanup = second.cleanup;
    await wait(1200);

    const restoredCurrentJob = second.dom.window.eval('currentJob');
    assert.strictEqual(
      restoredCurrentJob,
      null,
      'a completed job should never be restored as the active job after reopening'
    );
  } finally {
    cleanup();
    if (dom2Cleanup) dom2Cleanup();
  }
});

test('driver.html: a deleted job (not just cancelled) still clears the driver, so a hard delete can never strand a driver', async () => {
  let jobExists = true;
  const { dom, cleanup } = loadApp('driver.html', {
    initialStorage: { tp_drv: JSON.stringify({ id: 'drv-1', phone: '4045551234', name: 'Marcus', first: 'Marcus' }) },
    fetchHandler: async (url) => {
      if (url.includes('/jobs') && url.includes('select=status')) {
        return { ok: true, json: async () => (jobExists ? [{ status: 'in_transit' }] : []) };
      }
    },
  });

  try {
    await wait(1200);
    dom.window.eval(`
      pendingJob = {
        id: 'about-to-be-deleted', job_type: 'single',
        surge_stops: JSON.stringify([{ address: '100 A St, Atlanta, GA', recipient: 'Alice' }]),
        price: 30
      };
    `);
    await dom.window.eval('acceptOffer()');
    await wait(300);

    assert.ok(dom.window.eval('currentJob') !== null, 'driver should have an active job before deletion');

    jobExists = false; // simulates dispatcher hard-deleting the job
    await wait(4300); // past one real poll cycle

    assert.strictEqual(
      dom.window.eval('currentJob'),
      null,
      'a deleted job should clear the driver automatically, same as a cancelled one'
    );
  } finally {
    cleanup();
  }
});

test('driver.html: restores in-progress route state after a simulated app close/reopen', async () => {
  const { dom, storage, cleanup } = loadApp('driver.html', {
    initialStorage: {
      tp_drv: JSON.stringify({ id: 'drv-1', phone: '4045551234', name: 'Marcus', first: 'Marcus' }),
    },
  });

  let dom2Cleanup = null;
  try {
    await wait(1200);
    dom.window.eval(`
      pendingJob = {
        id: 'job-persist-test', job_type: 'surge',
        surge_stops: JSON.stringify([
          { address: '1 A St, Atlanta, GA', recipient: 'Bob' },
          { address: '2 B St, Atlanta, GA', recipient: 'Carol' }
        ]),
        price: 45
      };
    `);
    await dom.window.eval('acceptOffer()');
    await wait(300);
    await dom.window.eval('confirmSurgeStop()');
    await wait(300);

    assert.ok(storage.tp_route_state, 'expected route state to be saved to localStorage');

    // Simulate a full app close/reopen against the same saved storage.
    const second = loadApp('driver.html', { initialStorage: { ...storage } });
    dom2Cleanup = second.cleanup;
    await wait(1200);

    const restoredStop = second.dom.window.eval('currentSurgeStop');
    const restoredRecipient = second.dom.window.eval(
      'surgeStops && surgeStops[currentSurgeStop] ? surgeStops[currentSurgeStop].recipient : null'
    );
    assert.strictEqual(restoredStop, 1, 'should resume on the second stop, not restart the route');
    assert.strictEqual(restoredRecipient, 'Carol', 'should restore the correct in-progress recipient');
  } finally {
    cleanup();
    if (dom2Cleanup) dom2Cleanup();
  }
});
