const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadApp, wait } = require('./helpers');

// Driver experience (2026-10): optional manifest columns the driver sees at
// the stop (phone, unit, access notes, gate code, delivery notes, signature
// required) travel from the dispatcher's CSV upload to the route the driver
// gets; a driver's problem report reads as a plain alert in dispatch chat.

test('manifest: optional stop columns are read and carried to the published route', async () => {
  const app = loadApp('dispatcher.html');
  try {
    await wait(50);
    const w = app.dom.window;
    w.eval(`openSmartSortDrawer=function(){};renderPackageTable=function(){};buildAndAutoDispatch=function(){};`);
    w.eval(`parseCSV(${JSON.stringify('order_id,recipient,address,packages,phone,unit,access_notes,gate_code,delivery_notes,signature_required\n'
      + 'O1,Ann,1 A St,2,(404) 555-0111,4B,Call box 12,1234,Leave at desk,yes\n'
      + 'O2,Bo,2 B St,1,,,,,,\n')})`);
    const pk = JSON.parse(w.eval('JSON.stringify(packages)'));
    assert.deepStrictEqual([pk[0].phone, pk[0].unit, pk[0].access_notes, pk[0].gate_code, pk[0].delivery_notes, pk[0].signature_required],
      ['(404) 555-0111', '4B', 'Call box 12', '1234', 'Leave at desk', true]);
    assert.deepStrictEqual([pk[1].phone, pk[1].unit, pk[1].signature_required], [null, null, false]);
  } finally { app.cleanup(); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'dispatcher.html'), 'utf-8');
  assert.match(src, /phone: s\.phone\|\|null, unit: s\.unit\|\|null, access_notes: s\.access_notes\|\|null,/, 'published surge_stops carry them');
  assert.match(src, /if\(!stop\[k\]&&pkg\[k\]\)stop\[k\]=pkg\[k\]/, 'stop takes them from its packages');
  assert.match(src, /startsWith\('STOP_EXCEPTION::'\)[\s\S]{0,200}PROBLEM/, 'problem reports read as alerts in chat');
});
