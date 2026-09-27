// IQ2 database layer: the real migration, exercised through the same
// public functions the TC56 and the admin page call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, seed, idem, scalar, fixture, ADMIN_KEY } from './iq2-helpers.mjs';

const require = createRequire(import.meta.url);
const M = require('../iq2-manifest.js');

const WH = 'MAIN';
const DEV = { p_device: 'TC56-TEST', p_actor: 'Tester' };

async function setup() {
  const { db, rpc } = await freshDb();
  await seed(rpc, M);
  const open = async (code) => rpc('iq2_open_pallet', { p_warehouse: WH, p_code: code, ...DEV });
  const palletId = async (code) => (await open(code)).pallet.id;
  const receive = async (pid, code, key = idem()) =>
    rpc('iq2_receive_carton', { p_warehouse: WH, p_pallet_id: pid, p_code: code, p_idem: key, ...DEV });
  const lookup = async (code) => rpc('iq2_putaway_lookup', { p_warehouse: WH, p_code: code, ...DEV });
  const putaway = async (code, loc, key = idem(), line = null) =>
    rpc('iq2_putaway', { p_warehouse: WH, p_code: code, p_location: loc, p_idem: key, p_line_id: line, ...DEV });
  const close = async (pid, confirm = false) =>
    rpc('iq2_close_pallet', { p_warehouse: WH, p_pallet_id: pid, p_confirm_short: confirm, ...DEV });
  const exceptions = async (kind) =>
    Number(await scalar(db, 'select count(*) from iq2.exceptions where kind=$1', [kind]));
  const audit = async () => rpc('iq2_admin_audit', { p_key: ADMIN_KEY, p_warehouse: WH });
  return { db, rpc, open, palletId, receive, lookup, putaway, close, exceptions, audit };
}

// ── manifest import ────────────────────────────────────────────────────
test('manifest import: realistic mixed manifest lands intact', async () => {
  const { db } = await setup();
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.pallets')), 3);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.lines')), 10);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.skus')), 9);
  assert.equal(Number(await scalar(db, 'select sum(expected_cartons) from iq2.lines')), 27);
  assert.equal(Number(await scalar(db, 'select sum(expected_cartons*units_per_carton) from iq2.lines')), 1495);
  // Real identifiers preserved exactly, including a QR-style value
  assert.equal(await scalar(db, "select carton_code from iq2.lines where carton_code like 'IQ2:%'"), 'IQ2:HU:8841-0007');
  assert.equal(await scalar(db, "select description from iq2.skus where sku='WALLET-BLK'"), "Men's Wallet, Black Leather");
  // No invented identities anywhere
  assert.equal(Number(await scalar(db, "select count(*) from iq2.lines where carton_code ~ '#[0-9]+$'")), 0);
});

test('manifest import: bad file is rejected whole, every problem reported, nothing written', async () => {
  const { db, rpc } = await setup();
  const before = Number(await scalar(db, 'select count(*) from iq2.lines'));
  const bad = M.parseManifest(fixture('manifest-bad.csv'));
  const r = await rpc('iq2_admin_import_manifest', { p_key: ADMIN_KEY, p_warehouse: WH, p_source_name: 'bad.csv', p_rows: bad.rows });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_MANIFEST');
  const text = r.errors.map((e) => e.row + ':' + e.field + ':' + e.message).join('\n');
  assert.match(text, /3:carton_barcode:.*appears more than once on pallet PLT-9001/);
  assert.match(text, /units_per_carton:.*got "0"/);
  assert.match(text, /cartons:.*got "two"/);
  assert.match(text, /PLT-9001 is listed under more than one load reference/);
  assert.match(text, /AAA111 is listed with different contents/);
  assert.match(text, /SKU SKU-A has different descriptions/);
  assert.match(text, /9:pallet:Pallet barcode is required/);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.lines')), before);
  assert.equal(Number(await scalar(db, "select count(*) from iq2.pallets where pallet_code like 'PLT-90%'")), 0);
});

test('manifest import: re-importing a live pallet or the same file is refused', async () => {
  const { db, rpc } = await setup();
  const rows = M.parseManifest(fixture('manifest-mixed.csv')).rows;
  const r = await rpc('iq2_admin_import_manifest', { p_key: ADMIN_KEY, p_warehouse: WH, p_source_name: 'again.csv', p_rows: rows });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /PLT-0001 is already on file/.test(e.message)));
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.pallets')), 3);
});

test('manifest import: a live barcode cannot be re-declared with different contents', async () => {
  const { rpc } = await setup();
  const csv = 'load,pallet,carton,sku,description,units_per_carton,cartons\nL-2,PLT-7777,10012345678902,CASE-IP15-CLR,Phone Case iPhone 15 Clear,20,1\n';
  const r = await rpc('iq2_admin_import_manifest', { p_key: ADMIN_KEY, p_warehouse: WH, p_source_name: 'x.csv', p_rows: M.parseManifest(csv).rows });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /already on file with different contents/);
});

test('admin functions require the admin key', async () => {
  const { rpc } = await setup();
  const rows = M.parseManifest(fixture('manifest-mixed.csv')).rows;
  for (const key of [null, '', 'wrong-key-000']) {
    const r = await rpc('iq2_admin_import_manifest', { p_key: key, p_warehouse: WH, p_source_name: 'x', p_rows: rows });
    assert.equal(r.code, 'NOT_AUTHORIZED');
  }
  assert.equal((await rpc('iq2_admin_report', { p_key: 'nope-nope', p_warehouse: WH })).code, 'NOT_AUTHORIZED');
});

// ── pallets ────────────────────────────────────────────────────────────
test('valid pallet opens with a correct summary; lookups are case/whitespace tolerant', async () => {
  const { open } = await setup();
  const r = await open('  plt-0001\r\n');
  assert.equal(r.ok, true);
  assert.equal(r.pallet.code, 'PLT-0001');
  assert.equal(r.pallet.load_ref, 'LOAD-4471');
  assert.equal(r.pallet.expected_cartons, 12);
  assert.equal(r.pallet.received_cartons, 0);
  assert.equal(r.pallet.expected_units, 477);
  assert.equal(r.pallet.skus, 5);
  assert.equal(r.pallet.status, 'open');
});

test('unknown pallet is rejected and recorded; a carton label says so', async () => {
  const { open, exceptions } = await setup();
  const r = await open('PLT-NOPE');
  assert.equal(r.code, 'UNKNOWN_PALLET');
  assert.equal(await exceptions('unknown_pallet'), 1);
  const c = await open('10012345678902');
  assert.equal(c.code, 'NOT_A_PALLET');
});

// ── receiving ──────────────────────────────────────────────────────────
test('mixed-SKU pallet: each carton resolves to its own SKU and unit quantity', async () => {
  const { palletId, receive } = await setup();
  const pid = await palletId('PLT-0001');
  const seen = [];
  for (const code of ['00012345600000000011', '10012345678902', '20012345678909', '30012345678906', '00012345600000000028']) {
    const r = await receive(pid, code);
    assert.equal(r.ok, true, JSON.stringify(r));
    seen.push([r.sku, r.units]);
  }
  assert.deepEqual(seen, [['WALLET-BLK', 100], ['CASE-IP15-CLR', 40], ['TSHIRT-M-NVY', 25], ['LAMP-DESK-BLK', 1], ['WALLET-BRN', 100]]);
});

test('one carton containing 100 units: one scan, 1 carton, 100 units', async () => {
  const { db, palletId, receive } = await setup();
  const pid = await palletId('PLT-0001');
  const r = await receive(pid, '00012345600000000011');
  assert.equal(r.code, 'RECEIVED');
  assert.equal(r.units, 100);
  assert.equal(r.received_cartons, 1);
  assert.equal(r.pallet.received_cartons, 1);
  assert.equal(r.pallet.received_units, 100);
  const mv = (await db.query("select cartons, units, scanned_code from iq2.movements where kind='receive'")).rows;
  assert.deepEqual(mv.map((m) => [m.cartons, Number(m.units), m.scanned_code]), [[1, 100, '00012345600000000011']]);
});

test('unique carton barcode: second scan rejected as already received', async () => {
  const { palletId, receive, exceptions } = await setup();
  const pid = await palletId('PLT-0001');
  assert.equal((await receive(pid, '00012345600000000011')).ok, true);
  const again = await receive(pid, '00012345600000000011');
  assert.equal(again.code, 'ALREADY_RECEIVED');
  assert.equal(await exceptions('duplicate_carton'), 1);
});

test('shared carton barcode: expected 5 counts 1..5, the 6th is rejected; units = 5 × 40', async () => {
  const { palletId, receive, exceptions } = await setup();
  const pid = await palletId('PLT-0001');
  for (let i = 1; i <= 5; i++) {
    const r = await receive(pid, '10012345678902');
    assert.equal(r.code, 'RECEIVED');
    assert.equal(r.carton_index, i);
    assert.equal(r.expected_cartons, 5);
  }
  const sixth = await receive(pid, '10012345678902');
  assert.equal(sixth.code, 'OVER_RECEIVE');
  assert.equal(sixth.received_cartons, 5);
  assert.equal(await exceptions('over_receive'), 1);
  const s = (await receive(pid, '00012345600000000011')).pallet;
  assert.equal(s.received_units, 5 * 40 + 100);
});

test('same shared barcode on two pallets is counted per pallet', async () => {
  const { palletId, receive } = await setup();
  const p1 = await palletId('PLT-0001'), p2 = await palletId('PLT-0002');
  for (let i = 0; i < 2; i++) assert.equal((await receive(p2, '10012345678902')).code, 'RECEIVED');
  assert.equal((await receive(p2, '10012345678902')).code, 'OVER_RECEIVE');
  assert.equal((await receive(p1, '10012345678902')).carton_index, 1);
});

test('unknown carton and wrong-pallet carton are rejected and recorded, nothing received', async () => {
  const { db, palletId, receive, exceptions } = await setup();
  const pid = await palletId('PLT-0001');
  assert.equal((await receive(pid, 'NOT-ON-ANY-MANIFEST')).code, 'UNKNOWN_CARTON');
  const w = await receive(pid, '40012345678903');
  assert.equal(w.code, 'WRONG_PALLET');
  assert.equal(w.pallet_code, 'PLT-0002');
  assert.equal(await exceptions('unknown_carton'), 1);
  assert.equal(await exceptions('wrong_pallet'), 1);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.movements')), 0);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.skus')), 9); // no SKU invented
});

test('scanning another pallet label during receiving hands back that pallet, records nothing', async () => {
  const { db, palletId, receive } = await setup();
  const r = await receive(await palletId('PLT-0001'), 'PLT-0003');
  assert.equal(r.code, 'PALLET_SCANNED');
  assert.equal(r.pallet.code, 'PLT-0003');
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.exceptions')), 0);
});

test('partial pallet: progress is in the database and survives a new session', async () => {
  const { palletId, receive, open } = await setup();
  const pid = await palletId('PLT-0003');
  for (let i = 0; i < 4; i++) await receive(pid, '50012345678900');
  // "restart": a brand-new open of the same label
  const r = await open('PLT-0003');
  assert.equal(r.pallet.status, 'receiving');
  assert.equal(r.pallet.received_cartons, 4);
  assert.equal(r.pallet.expected_cartons, 8);
  const next = await receive(r.pallet.id, '50012345678900');
  assert.equal(next.carton_index, 5);
});

test('close: shortages need confirmation, are recorded per line, and the pallet stays closed', async () => {
  const { db, palletId, receive, close, open, exceptions } = await setup();
  const pid = await palletId('PLT-0003');
  for (let i = 0; i < 6; i++) await receive(pid, '50012345678900');
  await receive(pid, '60012345678907');
  const ask = await close(pid, false);
  assert.equal(ask.code, 'SHORT_CONFIRM_REQUIRED');
  assert.equal(ask.pallet.shortages.length, 1);
  assert.equal(ask.pallet.shortages[0].sku, 'HOODIE-L-BLK');
  assert.equal(ask.pallet.shortages[0].short_cartons, 1);
  assert.equal(await scalar(db, 'select status from iq2.pallets where id=$1', [pid]), 'receiving');
  const done = await close(pid, true);
  assert.equal(done.code, 'CLOSED_SHORT');
  assert.equal(done.pallet.status, 'closed');
  assert.equal(done.pallet.received_cartons, 7);
  assert.equal(done.pallet.expected_cartons, 8); // never pretends it was full
  assert.equal(await exceptions('short_on_close'), 1);
  assert.equal((await receive(pid, '60012345678907')).code, 'PALLET_CLOSED');
  assert.equal((await open('PLT-0003')).code, 'PALLET_CLOSED');
  assert.equal((await close(pid, true)).code, 'ALREADY_CLOSED');
});

test('close: a fully received pallet closes without confirmation', async () => {
  const { palletId, receive, close } = await setup();
  const pid = await palletId('PLT-0002');
  for (const [code, n] of [['10012345678902', 2], ['40012345678903', 4], ['IQ2:HU:8841-0007', 1]])
    for (let i = 0; i < n; i++) assert.equal((await receive(pid, code)).ok, true);
  const r = await close(pid, false);
  assert.equal(r.code, 'CLOSED');
  assert.equal(r.pallet.shortages.length, 0);
});

test('idempotent retry: the same request key never receives twice', async () => {
  const { db, palletId, receive } = await setup();
  const pid = await palletId('PLT-0001');
  const key = idem();
  const a = await receive(pid, '10012345678902', key);
  const b = await receive(pid, '10012345678902', key);
  assert.equal(a.replay, false);
  assert.equal(b.ok, true);
  assert.equal(b.replay, true);
  assert.equal(b.received_cartons, 1);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.movements')), 1);
  const c = await receive(pid, '10012345678902');
  assert.equal(c.carton_index, 2);
});

// ── putaway ────────────────────────────────────────────────────────────
test('putaway lookup: not-received, unknown, pallet and location scans are explicit', async () => {
  const { lookup, exceptions } = await setup();
  assert.equal((await lookup('00012345600000000011')).code, 'NOT_RECEIVED');
  assert.equal((await lookup('ZZZ-UNKNOWN')).code, 'UNKNOWN_CARTON');
  assert.equal((await lookup('PLT-0001')).code, 'PALLET_SCANNED');
  const l = await lookup('LOC:B-4');
  assert.equal(l.code, 'LOCATION_SCANNED');
  assert.equal(l.location.code, 'B-4');
  assert.equal(await exceptions('not_received'), 1);
  assert.equal(await exceptions('unknown_carton'), 1);
});

test('putaway: one carton moves its full unit quantity into the location', async () => {
  const { db, palletId, receive, lookup, putaway } = await setup();
  await receive(await palletId('PLT-0001'), '00012345600000000011');
  const l = await lookup('00012345600000000011');
  assert.equal(l.code, 'CARTON');
  assert.equal(l.sku, 'WALLET-BLK');
  assert.equal(l.description, "Men's Wallet, Black Leather");
  assert.equal(l.units, 100);
  const p = await putaway('00012345600000000011', 'LOC:B-4', idem(), l.line_id);
  assert.equal(p.code, 'PUT_AWAY');
  assert.equal(p.units, 100);
  assert.equal(p.location_code, 'B-4');
  assert.equal(p.location_sku_units, 100);
  const mv = (await db.query("select cartons, units from iq2.movements where kind='putaway'")).rows[0];
  assert.deepEqual([mv.cartons, Number(mv.units)], [1, 100]);
  assert.equal((await putaway('00012345600000000011', 'LOC:B-5')).code, 'ALREADY_PUT_AWAY');
});

test('putaway: invalid and disabled locations are rejected, nothing moves', async () => {
  const { db, palletId, receive, putaway, exceptions } = await setup();
  await receive(await palletId('PLT-0001'), '00012345600000000011');
  assert.equal((await putaway('00012345600000000011', 'LOC:Z-99')).code, 'INVALID_LOCATION');
  assert.equal((await putaway('00012345600000000011', 'LOC:C-1')).code, 'LOCATION_DISABLED');
  assert.equal((await putaway('00012345600000000011', '10012345678902')).code, 'CARTON_SCANNED');
  assert.equal(await exceptions('invalid_location'), 1);
  assert.equal(await exceptions('disabled_location'), 1);
  assert.equal(Number(await scalar(db, "select count(*) from iq2.movements where kind='putaway'")), 0);
  assert.equal(Number(await scalar(db, 'select count(*) from iq2.inventory')), 0);
  // prefix-less and lowercase label for a registered location is fine
  assert.equal((await putaway('00012345600000000011', ' b-4 ')).code, 'PUT_AWAY');
});

test('same SKU into multiple locations, and repeated cartons accumulate in one location', async () => {
  const { db, rpc, palletId, receive, putaway } = await setup();
  const p1 = await palletId('PLT-0001');
  for (let i = 0; i < 5; i++) await receive(p1, '10012345678902');
  for (let i = 0; i < 3; i++) assert.equal((await putaway('10012345678902', 'LOC:A-5-1')).code, 'PUT_AWAY');
  const last = await putaway('10012345678902', 'LOC:B-5');
  assert.equal(last.location_sku_units, 40);
  const again = await putaway('10012345678902', 'LOC:B-5');
  assert.equal(again.location_sku_units, 80);
  assert.equal(again.remaining_cartons, 0);
  const inv = (await db.query(`select l.code, i.units, i.cartons from iq2.inventory i
      join iq2.locations l on l.id=i.location_id order by l.code`)).rows.map((r) => [r.code, Number(r.units), r.cartons]);
  assert.deepEqual(inv, [['A-5-1', 120, 3], ['B-5', 80, 2]]);
  const c = await rpc('iq2_location_contents', { p_warehouse: WH, p_location: 'LOC:A-5-1' });
  assert.deepEqual(c.location.contents.map((x) => [x.sku, Number(x.units)]), [['CASE-IP15-CLR', 120]]);
});

test('shared barcode across pallets is put away oldest-received first', async () => {
  const { db, palletId, receive, putaway } = await setup();
  const p2 = await palletId('PLT-0002'), p1 = await palletId('PLT-0001');
  await receive(p2, '10012345678902');           // PLT-0002 received first
  await receive(p1, '10012345678902');
  await putaway('10012345678902', 'LOC:A-5-2');
  const pal = await scalar(db, `select p.pallet_code from iq2.movements m join iq2.pallets p on p.id=m.pallet_id
                                where m.kind='putaway'`);
  assert.equal(pal, 'PLT-0002');
});

test('putaway idempotent retry: same key never moves twice', async () => {
  const { db, palletId, receive, putaway } = await setup();
  const pid = await palletId('PLT-0003');
  for (let i = 0; i < 2; i++) await receive(pid, '50012345678900');
  const key = idem();
  const a = await putaway('50012345678900', 'LOC:B-4', key);
  const b = await putaway('50012345678900', 'LOC:B-4', key);
  assert.equal(a.replay, false);
  assert.equal(b.replay, true);
  assert.equal(b.location_sku_units, 144);
  assert.equal(Number(await scalar(db, "select count(*) from iq2.movements where kind='putaway'")), 1);
  // retry key reused for a different operation is refused
  const pal = await palletId('PLT-0003');
  const x = await receive(pal, '50012345678900', key);
  assert.equal(x.code, 'IDEMPOTENCY_CONFLICT');
});

// ── integrity ──────────────────────────────────────────────────────────
test('inventory balance agrees with the ledger; the ledger is append-only', async () => {
  const { db, palletId, receive, putaway, audit } = await setup();
  const p1 = await palletId('PLT-0001'), p3 = await palletId('PLT-0003');
  for (let i = 0; i < 5; i++) await receive(p1, '10012345678902');
  for (let i = 0; i < 6; i++) await receive(p3, '50012345678900');
  await receive(p1, '00012345600000000011');
  for (let i = 0; i < 4; i++) await putaway('10012345678902', i < 2 ? 'LOC:A-5-1' : 'LOC:B-4');
  for (let i = 0; i < 6; i++) await putaway('50012345678900', 'LOC:B-4');
  await putaway('00012345600000000011', 'LOC:B-4');
  const a = await audit();
  assert.equal(a.balanced, true, JSON.stringify(a.mismatches));
  // Reconstruct balances purely from the ledger and compare
  const ledger = (await db.query(`select location_id, sku_id, sum(units)::bigint u from iq2.movements
                                  where kind='putaway' group by 1,2 order by 1,2`)).rows;
  const bal = (await db.query('select location_id, sku_id, units::bigint u from iq2.inventory order by 1,2')).rows;
  assert.deepEqual(bal.map((r) => [r.location_id, r.sku_id, Number(r.u)]), ledger.map((r) => [r.location_id, r.sku_id, Number(r.u)]));
  assert.equal(Number(await scalar(db, "select units from iq2.inventory i join iq2.skus s on s.id=i.sku_id join iq2.locations l on l.id=i.location_id where s.sku='SOCKS-6PK' and l.code='B-4'")), 864);
  await assert.rejects(db.query('update iq2.movements set units=1'), /append-only/);
  await assert.rejects(db.query('delete from iq2.movements'), /append-only/);
  await receive(p1, 'NOT-A-REAL-CARTON');   // creates an exception row
  await assert.rejects(db.query('delete from iq2.exceptions'), /append-only/);
  await assert.rejects(db.query('truncate iq2.movements'), /append-only/);
  await assert.rejects(db.query('truncate iq2.exceptions'), /append-only/);
  // Tampering with a balance is detected by the audit
  await db.query("update iq2.inventory set units=units+1 where sku_id=(select id from iq2.skus where sku='SOCKS-6PK')");
  assert.equal((await audit()).balanced, false);
});

test('database constraints block over-receive and over-putaway even without the functions', async () => {
  const { db } = await setup();
  await assert.rejects(db.query('update iq2.lines set received_cartons=expected_cartons+1'), /check constraint/);
  await assert.rejects(db.query('update iq2.lines set putaway_cartons=1 where received_cartons=0'), /check constraint/);
});

test('the publishable (anon) role can only reach IQ2 through its functions', async () => {
  const { db } = await setup();
  await db.query('set role anon');
  try {
    await assert.rejects(db.query('select * from iq2.lines'), /permission denied/);
    await assert.rejects(db.query("insert into iq2.movements(warehouse_id) values (gen_random_uuid())"), /permission denied/);
    const r = await db.query('select public.iq2_list_warehouses() as r');
    assert.deepEqual(r.rows[0].r, [{ code: 'MAIN', name: 'Main DC' }]);
    await assert.rejects(db.query('select iq2.is_admin($1)', ['x']), /permission denied/);
  } finally { await db.query('reset role'); }
});
