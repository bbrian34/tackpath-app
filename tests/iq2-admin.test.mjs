// iq2-admin.html (office page) against the real IQ2 SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { freshDb, fixture, scalar, ADMIN_KEY, ROOT } from './iq2-helpers.mjs';

const MANIFEST_JS = fs.readFileSync(path.join(ROOT, 'iq2-manifest.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'iq2-admin.html'), 'utf8')
  .replace('<script src="iq2-manifest.js"></script>', '<script>' + MANIFEST_JS + '</script>');

function boot(rpc, key) {
  const ss = key ? { iq2_admin_key: key } : {};
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tackpath.com/iq2-admin.html',
    beforeParse(w) {
      Object.defineProperty(w, 'sessionStorage', { value: { getItem: (k) => ss[k] ?? null, setItem: (k, v) => { ss[k] = v; } } });
      const ls = {};
      Object.defineProperty(w, 'localStorage', { value: { getItem: (k) => ls[k] ?? null, setItem: (k, v) => { ls[k] = v; } } });
      w.fetch = async (u, o) => {
        const fn = /\/rpc\/([a-z0-9_]+)/.exec(u)[1];
        const out = await rpc(fn, JSON.parse(o.body));
        return { ok: true, status: 200, json: async () => out };
      };
    },
  });
  const w = dom.window;
  return { w, text: (id) => w.document.getElementById(id).textContent.replace(/\s+/g, ' '), close: () => w.close() };
}

test('office: without the admin key nothing is shown or changed', async () => {
  const { rpc } = await freshDb();
  const a = boot(rpc, 'wrong-key-xyz');
  try {
    await a.w.iq2AdminReady;
    a.w.document.getElementById('newWhCode').value = 'MAIN';
    a.w.document.getElementById('newWhName').value = 'Main';
    await a.w.createWarehouse();
    assert.match(a.text('whMsg'), /admin key required/);
  } finally { a.close(); }
});

test('office: create warehouse, preview + import manifest and locations, see the report', async () => {
  const { db, rpc } = await freshDb();
  const a = boot(rpc, ADMIN_KEY);
  try {
    await a.w.iq2AdminReady;
    a.w.document.getElementById('newWhCode').value = 'main';
    a.w.document.getElementById('newWhName').value = 'Main DC';
    await a.w.createWarehouse();
    assert.match(a.text('whMsg'), /Warehouse MAIN saved/);

    a.w.previewManifest(fixture('manifest-bad.csv'));
    assert.match(a.text('manifestPreview'), /problem\(s\).*Nothing has been imported/);
    assert.equal(a.w.document.getElementById('importBtn').disabled, true);

    a.w.previewManifest(fixture('manifest-mixed.csv'));
    assert.match(a.text('manifestPreview'), /10 rows · 2 load\(s\) · 3 pallet\(s\) · 9 SKUs · 27 cartons · 1,495 units/);
    assert.equal(a.w.document.getElementById('importBtn').disabled, false);
    await a.w.importManifest();
    assert.match(a.text('manifestPreview'), /Imported: 3 pallet\(s\), 10 carton lines, 27 cartons, 1,495 units expected/);

    a.w.previewLocations(fixture('locations.csv'));
    await a.w.importLocations();
    assert.match(a.text('locPreview'), /Saved 6 location/);
    assert.match(a.text('palletTable'), /PLT-0001.*0 \/ 12/);
    assert.match(a.text('locTable'), /C-1.*disabled/);
    assert.match(a.text('auditBadge'), /balanced/);

    // server-side re-validation: importing the same file again is refused
    a.w.previewManifest(fixture('manifest-mixed.csv'));
    await a.w.importManifest();
    assert.match(a.text('manifestPreview'), /already on file.*Nothing was imported|Nothing was imported/);
    assert.equal(Number(await scalar(db, 'select count(*) from iq2.pallets')), 3);

    await a.w.setLocation('C-1', true);
    assert.equal(await scalar(db, "select enabled from iq2.locations where code='C-1'"), true);
  } finally { a.close(); }
});
