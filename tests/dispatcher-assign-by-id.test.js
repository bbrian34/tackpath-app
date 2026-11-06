const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Migration 69: the dispatcher assigns a route to a driver id, so two drivers with the same
// name are never mixed up. The picker's values are driver ids (names stay the labels, with
// the phone's last four digits when two drivers share a name), and Assign sends driver_id.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'dispatcher.html'), 'utf-8');

test('the driver picker lists active drivers by id and Assign sends driver_id', async () => {
  const sent = [];
  const dom = new JSDOM('<select id="assignDriverSelect"></select>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = async (url, o) => {
    if (o && o.method === 'PATCH') { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => [] }; }
    return { ok: true, json: async () => [
      { id: 'd1', name: 'Dana Driver', phone: '4045551234', status: 'active' },
      { id: 'd2', name: 'Dana Driver', phone: '4045557777', status: 'active' },
      { id: 'd3', name: 'Pat Pending', phone: '4045551236', status: 'pending_approval' }] };
  };
  const pick = (name) => HTML.slice(HTML.indexOf('async function ' + name), HTML.indexOf('\n}\n', HTML.indexOf('async function ' + name)) + 2);
  w.eval(`var H={},sbUrl=(p)=>p,toast=()=>{},openDrawer=()=>{},loadJobs=()=>{},sendDriverAssignmentSMS=(n,j)=>{window.sms=[n,j];};`
    + pick('populateDriverPicker') + pick('assignJobToDriver'));
  await w.populateDriverPicker();
  const opts = [...w.document.querySelectorAll('#assignDriverSelect option')].map((o) => [o.value, o.textContent]);
  assert.deepStrictEqual(opts, [['', 'Select a driver...'], ['d1', 'Dana Driver (1234)'], ['d2', 'Dana Driver (7777)']], 'ids as values, pending drivers left out');
  w.document.getElementById('assignDriverSelect').value = 'd2';
  await w.assignJobToDriver('job-9');
  assert.deepStrictEqual(sent, [{ driver_id: 'd2', status: 'assigned' }]);
  assert.strictEqual(JSON.stringify(w.sms), JSON.stringify(['Dana Driver', 'job-9']), 'the assignment text still names the driver');
  dom.window.close();
});
