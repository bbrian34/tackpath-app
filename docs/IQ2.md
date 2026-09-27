# IQ2 — inbound operations (receiving + putaway)

IQ2 is a mode inside the PathIQ Android app (`com.tackpath.pathiq`) on the
Zebra TC56, next to STOW. STOW is untouched: PathIQ's existing IQ2 card
(`stow.html`, `onclick="window.location.href='iq2.html'"`) already opens it.

```
PathIQ app
 ├─ STOW  stow.html  (packaged as www/index.html)   ← unchanged
 └─ IQ2   iq2.html   (packaged as www/iq2.html)     ← this feature
            └─ public.iq2_* database functions → private schema iq2
IQ2 Office  iq2-admin.html + iq2-manifest.js        ← desktop, not in the APK
```

## Files

| File | Purpose |
|---|---|
| `iq2.html` | TC56 page: receiving and putaway state machine, own scanner bridge |
| `iq2-admin.html` | Office page: warehouse, manifest/ASN import, location registry, inventory, ledger, exceptions, audit |
| `iq2-manifest.js` | CSV parser + preview validation (office page and tests) |
| `supabase/schema/005_iq2_inbound.sql` | Schema, functions, privileges (additive) |
| `tests/iq2-*.test.mjs`, `tests/fixtures/iq2/*` | Tests and realistic fixtures |

## Quantity model

* **Carton** = one physical handling unit. One scan = one carton.
* **Units** = inventory units inside it (`units_per_carton`).
* One carton of 100 wallets is scanned **once** and moves **100 units**.
* A shared carton barcode listed with 5 cartons is counted 1 of 5 … 5 of 5;
  the 6th scan is rejected. No per-carton identity (`#1`, `#2`) is ever
  invented. A uniquely-labelled carton is a row with 1 carton; its second
  scan is rejected as already received.
* This is **not** PathIQ `required_count` and does not use it.

## Database (schema `iq2`, not exposed to the API)

| Table | Holds |
|---|---|
| `warehouses`, `admin_keys` | Warehouse codes; SHA-256 hashes of office admin keys |
| `skus` | SKU + description per warehouse |
| `locations` | Permanent storage locations: code, aisle, bay, shelf, enabled |
| `manifests` | Each imported file (content hash blocks re-import) |
| `pallets` | Inbound pallets: real label, load reference, open → receiving → closed |
| `lines` | Expected carton barcode per pallet: SKU, units/carton, expected / received / put-away cartons (check constraints make over-receive and over-putaway impossible) |
| `inventory` | Current units + cartons per location + SKU |
| `movements` | **Append-only ledger** (update/delete/truncate blocked): receive / putaway, cartons, units, scanned value, pallet, line, SKU, location, device, worker, time, unique request key. `cart_code` reserved for future cart tracking |
| `exceptions` | Every rejected or discrepant scan and every short close (delete blocked) |

The only way in is through the `public.iq2_*` functions (SECURITY DEFINER,
pinned `search_path`, one transaction each, row locks):

* TC56: `iq2_list_warehouses`, `iq2_open_pallet`, `iq2_receive_carton`,
  `iq2_close_pallet`, `iq2_putaway_lookup`, `iq2_putaway`, `iq2_location_contents`
* Office (admin key): `iq2_admin_create_warehouse`, `iq2_admin_import_manifest`,
  `iq2_admin_import_locations`, `iq2_admin_set_location_enabled`,
  `iq2_admin_report`, `iq2_admin_audit`

`iq2_admin_audit` recomputes every balance from the ledger and reports any
mismatch.

### Audit questions → where the answer is

| Question | Source |
|---|---|
| What arrived, on which load/pallet? | `movements` (receive) → `pallets.load_ref`, `pallets.pallet_code` |
| What barcode was scanned? | `movements.scanned_code` (exact decoded value) |
| Which SKU/product? | `movements.sku_id` → `skus` |
| How many cartons / units? | `movements.cartons`, `movements.units` |
| When, by whom, on which device? | `movements.occurred_at`, `actor`, `device_id` |
| Where was it put away, how many units? | `movements` (putaway) → `location_id`, `units` |
| What went wrong? | `exceptions` |

## Setup (NOT done — for when you approve deployment)

1. Supabase SQL editor: run `supabase/schema/005_iq2_inbound.sql` once.
2. Create an office admin key (keep the secret; only the hash is stored):
   ```sql
   insert into iq2.admin_keys(key_hash,label)
   values (encode(sha256(convert_to('<long random secret>','UTF8')),'hex'),'office');
   ```
3. Open `iq2-admin.html`, enter the key, create the warehouse (e.g. `MAIN`).
4. Import the location registry CSV, then the inbound manifest CSV.
5. Print permanent location labels encoding `LOC:<code>` (e.g. `LOC:B-4`).
   Pallet and carton labels are the real labels already on the freight.

Rollback: `drop schema iq2 cascade;` and drop the `public.iq2_*` functions.
Nothing else is affected.

## CSV formats

Manifest/ASN — header names are matched flexibly (case, spaces, common synonyms):

```
Load Reference,Pallet Barcode,Carton Barcode,SKU,Description,Units Per Carton,Cartons Expected
LOAD-4471,PLT-0001,00012345600000000011,WALLET-BLK,"Men's Wallet, Black Leather",100,1
LOAD-4471,PLT-0001,10012345678902,CASE-IP15-CLR,Phone Case iPhone 15 Clear,40,5
```

Rejected with every problem listed (whole file, nothing imported): missing
fields, non-positive or non-numeric quantities, the same carton barcode twice
on one pallet, one pallet under two loads, one barcode with two different
contents (in the file or against live data), one SKU with two descriptions,
a pallet already on file and not closed, the identical file imported twice.

Locations:

```
code,aisle,bay,shelf,enabled
LOC:A-5-1,A-5,1,1,true
LOC:B-4,A-5,4,2,true
```

## TC56 workflow

**IQ2 home** → RECEIVE or PUTAWAY (first launch: choose the warehouse once).

**Receive**
1. `SCAN PALLET` → pallet summary `0 / 60 CARTONS RECEIVED`.
   Unknown → `UNKNOWN PALLET`. Closed → `PALLET ALREADY RECEIVED / CLOSED` (not reopened).
2. `SCAN CARTON`, any order → `RECEIVED ✓  SKU · description · QTY n · CARTON k OF N · PALLET x OF y`,
   then straight back to `SCAN CARTON`. Unknown / wrong pallet → red, nothing received.
   Over-receive / already received → amber, not counted. Another pallet label switches pallets.
3. **Finish pallet** → complete, or shortage list with *Keep receiving* / *Close short*.
   **Leave pallet** keeps progress; scan the pallet again to resume.

**Putaway**
1. `SCAN CARTON` → card flips: `DESCRIPTION · SKU · QTY n · SCAN LOCATION`.
2. Scan `LOC:…` → `PUTAWAY COMPLETE ✓  n × SKU → LOC · LOC NOW: total`, back to `SCAN CARTON`.
   Invalid/disabled location → red, carton stays in hand. Another carton → switches, nothing moved.
   A location scanned with no carton in hand shows its contents.

Connection: `NO CONNECTION · NOTHING RECORDED` when offline; `NOT CONFIRMED`
when the answer was lost — scanning the same item again re-sends the same
request key, so it can never be counted twice.

## Packaging into the PathIQ APK (NOT done)

On the build machine (`C:\Users\bbald\Downloads\pathiq-app`):

1. Keep `www\index.html` = current `stow.html` (unchanged).
2. Copy `iq2.html` → `www\iq2.html`. Optionally `manifest-iq2.json` → `www\`.
3. Confirm no stale `android\assets\` folder exists (see
   `knowledge/pathiq_stale_build_recovery.md`).
4. Bump `versionCode`/`versionName` in `android\app\build.gradle`.
5. `npx cap sync android`, `cd android`, `gradlew assembleDebug`, `adb install -r …`.

DataWedge needs no change: IQ2 listens to the same `ZebraScanner` plugin
(broadcast `com.tackpath.pathiq.SCAN`). IQ2 attaches its own listener only
while `iq2.html` is open.

## Security limitations (current)

* There is still no worker login in PathIQ. Receiving/putaway functions are
  callable with the publishable key, as STOW is today; `actor`/`device` are
  self-reported. Integrity (counts, locations, idempotency, no double
  putaway) is enforced server-side regardless of the caller.
* Office functions require an admin key checked against a stored hash; the
  key is kept only in the browser session.
* Tables are unreachable directly (private schema, no grants, RLS on).
* Warehouse scoping is by code; there is no org-level tenancy check yet.

## Physical TC56 test procedure

Prerequisites: SQL applied to a **test** Supabase project (or approved
production), admin key, warehouse `MAIN`, `tests/fixtures/iq2/locations.csv`
and `manifest-mixed.csv` imported, labels printed for the pallet, carton
and location values in those files, IQ2 packaged as above.

1. PathIQ home → **IQ2** opens IQ2 (not STOW). Choose `MAIN`.
2. **Back** → PathIQ home. Repeat IQ2 ⇄ PathIQ 5 times; then in STOW scan a
   known package once: it must register **exactly once** (listener check).
3. Receive → scan `PLT-0001` → `0 / 12`.
4. Scan `00012345600000000011` → WALLET-BLK, QTY 100, CARTON 1 OF 1, PALLET 1 OF 12.
5. Scan it again → ALREADY RECEIVED, not counted.
6. Scan `10012345678902` five times (other cartons in between are fine) → 1…5 OF 5; sixth → OVER-RECEIVE.
7. Scan `40012345678903` → WRONG PALLET (PLT-0002). Scan a random barcode → UNKNOWN CARTON.
8. Scan `PLT-0002` → switches pallet. Leave pallet. Kill and reopen the app → IQ2 → Receive → scan `PLT-0001` → progress intact.
9. Wi-Fi off → scan a carton → NO CONNECTION · NOTHING RECORDED. Wi-Fi on → scan again → counted once.
10. Finish pallet with cartons missing → shortage list → Close short → scan `PLT-0001` → PALLET ALREADY RECEIVED / CLOSED.
11. Putaway → scan `00012345600000000011` → MEN'S WALLET… / WALLET-BLK / QTY 100 / SCAN LOCATION.
12. Scan `LOC:Z-99` → INVALID LOCATION (carton kept). Scan `LOC:C-1` → LOCATION DISABLED.
13. Scan `LOC:B-4` → 100 × WALLET-BLK → B-4, B-4 NOW: 100.
14. Scan `10012345678902` → `LOC:A-5-1`; again → `LOC:A-5-1` (A-5-1 NOW: 80); again → `LOC:B-5` (same SKU, second location).
15. Scan `LOC:B-4` with nothing in hand → shows contents.
16. Second TC56: both scan the last remaining carton of a barcode at the same moment → exactly one succeeds.
17. Office page → ledger audit shows **balanced**; movements, exceptions and inventory match what you did.
