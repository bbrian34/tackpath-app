// IQ2 under real concurrency: a throwaway PostgreSQL cluster, many
// simultaneous connections, each playing a different TC56. PGlite cannot
// prove this (it serializes every call), so these tests use the system
// Postgres binaries and skip -- loudly -- when they are not available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { prepare, makeRpc, seed, idem, scalar } from './iq2-helpers.mjs';

const require = createRequire(import.meta.url);
const M = require('../iq2-manifest.js');

function findBin() {
  const base = '/usr/lib/postgresql';
  if (!fs.existsSync(base)) return null;
  for (const v of fs.readdirSync(base).sort().reverse()) {
    const bin = path.join(base, v, 'bin');
    if (fs.existsSync(path.join(bin, 'initdb'))) return bin;
  }
  return null;
}
const BIN = findBin();
const asPostgres = (cmd, args) => (process.getuid && process.getuid() === 0)
  ? execFileSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { stdio: 'pipe' })
  : execFileSync(cmd, args, { stdio: 'pipe' });

const skip = !BIN ? 'PostgreSQL server binaries not installed' : false;

test('IQ2 concurrency on real PostgreSQL', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq2pg-'));
  const port = 55000 + (process.pid % 1000);
  if (process.getuid && process.getuid() === 0) execFileSync('chown', ['postgres', dir]);
  asPostgres(path.join(BIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres']);
  asPostgres(path.join(BIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'),
    '-o', `-p ${port} -k ${dir} -c listen_addresses='' -c max_connections=60`, 'start']);
  const pool = new pg.Pool({ host: dir, port, user: 'postgres', database: 'postgres', max: 40 });
  try {
    await prepare(pool);
    const rpc = await makeRpc(pool);
    await seed(rpc, M);
    const WH = 'MAIN';
    const pid = async (code) => (await rpc('iq2_open_pallet', { p_warehouse: WH, p_code: code })).pallet.id;
    const receive = (p, code, key = idem(), dev = 'TC56-A') =>
      rpc('iq2_receive_carton', { p_warehouse: WH, p_pallet_id: p, p_code: code, p_idem: key, p_device: dev, p_actor: dev });
    const putaway = (code, loc, key = idem(), dev = 'TC56-A') =>
      rpc('iq2_putaway', { p_warehouse: WH, p_code: code, p_location: loc, p_idem: key, p_device: dev, p_actor: dev });
    const count = (codes, c) => codes.filter((r) => r.code === c).length;

    await t.test('20 devices racing on a 5-carton barcode: exactly 5 received', async () => {
      const p = await pid('PLT-0001');
      const res = await Promise.all(Array.from({ length: 20 }, (_, i) => receive(p, '10012345678902', idem(), 'TC56-' + i)));
      assert.equal(count(res, 'RECEIVED'), 5);
      assert.equal(count(res, 'OVER_RECEIVE'), 15);
      assert.deepEqual(res.filter((r) => r.ok).map((r) => r.carton_index).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
      assert.equal(Number(await scalar(pool, "select received_cartons from iq2.lines where carton_code='10012345678902' and pallet_id=$1", [p])), 5);
      assert.equal(Number(await scalar(pool, "select count(*) from iq2.movements where kind='receive' and pallet_id=$1 and scanned_code='10012345678902'", [p])), 5);
    });

    await t.test('two devices racing the last carton (4 of 5 received): exactly one wins', async () => {
      const p = await pid('PLT-0003');
      for (let i = 0; i < 5; i++) await receive(p, '50012345678900');
      const res = await Promise.all([receive(p, '50012345678900', idem(), 'A'), receive(p, '50012345678900', idem(), 'B'),
                                     receive(p, '50012345678900', idem(), 'C')]);
      assert.equal(count(res, 'RECEIVED'), 1);
      assert.equal(count(res, 'OVER_RECEIVE'), 2);
    });

    await t.test('same request key sent 8 times at once: one movement, all report success', async () => {
      const p = await pid('PLT-0002');
      const key = idem();
      const res = await Promise.all(Array.from({ length: 8 }, () => receive(p, '40012345678903', key)));
      assert.ok(res.every((r) => r.ok), JSON.stringify(res));
      assert.equal(res.filter((r) => !r.replay).length, 1);
      assert.equal(Number(await scalar(pool, 'select count(*) from iq2.movements where idem_key=$1', [key])), 1);
    });

    await t.test('10 devices putting away 5 received cartons: exactly 5 move, no double putaway', async () => {
      const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        putaway('10012345678902', i % 2 ? 'LOC:A-5-1' : 'LOC:B-4', idem(), 'TC56-' + i)));
      assert.equal(count(res, 'PUT_AWAY'), 5);
      assert.equal(count(res, 'ALREADY_PUT_AWAY'), 5);
      assert.equal(Number(await scalar(pool, "select sum(cartons) from iq2.inventory i join iq2.skus s on s.id=i.sku_id where s.sku='CASE-IP15-CLR'")), 5);
      assert.equal(Number(await scalar(pool, "select sum(units) from iq2.inventory i join iq2.skus s on s.id=i.sku_id where s.sku='CASE-IP15-CLR'")), 200);
    });

    await t.test('close racing receives: every counted carton has exactly one ledger row', async () => {
      const p = await pid('PLT-0002');
      const jobs = [];
      for (let i = 0; i < 6; i++) jobs.push(receive(p, '10012345678902', idem(), 'R' + i));
      jobs.push(rpc('iq2_close_pallet', { p_warehouse: WH, p_pallet_id: p, p_confirm_short: true, p_device: 'LEAD' }));
      for (let i = 0; i < 6; i++) jobs.push(receive(p, 'IQ2:HU:8841-0007', idem(), 'S' + i));
      const res = await Promise.all(jobs);
      const closed = res[6];
      assert.ok(['CLOSED', 'CLOSED_SHORT'].includes(closed.code), JSON.stringify(closed));
      const a = await rpc('iq2_admin_audit', { p_key: 'test-admin-key-123', p_warehouse: WH });
      assert.equal(a.balanced, true, JSON.stringify(a.mismatches));
      assert.equal(await scalar(pool, 'select status from iq2.pallets where id=$1', [p]), 'closed');
      // Nothing was received after the close committed: the count the close
      // saw is the final count, and every later scan was refused.
      const final = (await rpc('iq2_open_pallet', { p_warehouse: WH, p_code: 'PLT-0002' })).pallet;
      assert.equal(final.received_cartons, closed.pallet.received_cartons);
      const accepted = res.filter((r, i) => i !== 6 && r.ok).length;
      const refused = res.filter((r, i) => i !== 6 && !r.ok).map((r) => r.code);
      assert.ok(refused.every((c) => ['PALLET_CLOSED', 'OVER_RECEIVE', 'ALREADY_RECEIVED'].includes(c)), refused.join());
      assert.equal(accepted + 1, final.received_cartons); // +1 = the 4001… carton from the idempotency test
    });

    await t.test('ledger and balances agree after all the racing', async () => {
      const a = await rpc('iq2_admin_audit', { p_key: 'test-admin-key-123', p_warehouse: WH });
      assert.equal(a.balanced, true, JSON.stringify(a.mismatches));
    });
  } finally {
    await pool.end().catch(() => {});
    try { asPostgres(path.join(BIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
