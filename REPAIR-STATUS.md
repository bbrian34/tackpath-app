# TackPath operational repair — 2026-09-19

The audited SmartSort → PathIQ/Stow → Driver → Dispatcher workflow now uses one transactional Supabase operational model. Physical packages have permanent identities and aliases; route membership, exclusive bin reservations, warehouse/driver custody, delivery proof, cancellation, returns, and closure are persisted separately.

## Shipped behavior

- Manifest rows are retained, including malformed quantities, address failures and identity conflicts. Valid pieces are never silently dropped. Imports and commands have persistent replay protection.
- SmartSort entry points in Dispatcher, standalone SmartSort and PathIQ use the same edge handler. Route hints, geographic sequencing and physical-piece counts are preserved.
- Labels contain one canonical CODE128 barcode per physical piece. The barcode renderer is bundled locally. Order/carrier aliases resolve to that same piece rather than increasing counts.
- Stow confirms only acknowledged placement into the reserved physical bin. Bins are scoped to warehouses; occupied bins cannot be reused or reset away. FARSET and Zebra scanner events enter the same command path.
- Loading requires staged packages and the assigned driver. Departure requires complete loading. Assignment/version checks reject stale clients. Empty bins are released after physical custody transfer.
- Proof is tied to immutable route/stop/driver identity. Delivery requires successful private storage upload and an atomic delivery record. Failed proof workflows survive reload and retry.
- Cancellation creates held/return obligations; it does not create deliveries. Closure derives from stop outcomes and custody reconciliation. Dispatcher history reads committed deliveries rather than parsing messages.
- Driver login verifies SMS challenges, expiration, attempt limits and replay. Drivers enter organization slug and registered phone; dispatcher access codes are not distributed to drivers. Disabling driver access revokes sessions while retaining history.
- Public REST policies cannot bypass the operational jobs, scoped drivers, messages, locations or organization access codes. Existing legacy records are retained.
- Recovery controls expose pending sync, manifest resume, address correction, warehouse/bin setup, driver registration, holds and acknowledged returns. Offline cached state is labeled; unacknowledged work is never shown as saved.
- Legacy Driver, mobile Dispatcher and IQ2 entry URLs lead to the repaired workflow.

## Validation

Run `npm run setup`, then `npm test` from the repository root. The authoritative suite resides in `operations/tests`; `tests/package.json` delegates to it. Earlier mock tests are retained as historical reference and their pre-migration login/direct-write assumptions are superseded.

27 checks pass, including real PostgreSQL-compatible execution, service-role/deferred-trigger privileges, authentication failures, manifest parsing, geocoding failure progression, transaction rollback, package conservation, duplicate/alias scans, occupied bins, incomplete pickup, reassignment, proof and final-write failures, cancellation/return, and signed-in Chrome interaction across the apps. The browser test exercises the actual driver-assignment control, printed barcodes, durable proof retry after reload, and offline cached-state recovery.

The live Supabase check uses isolated test organizations and synthetic proof. It verifies real geocoding, duplicate import protection, stow, load, departure, private proof upload, signed proof retrieval, cancellation, return and archival. Final balance: **3 expected = 2 delivered + 1 returned; 0 unexplained and 0 active exceptions**. Test history is retained and archived; no pre-existing production rows were deleted.

Driver 1.5 (versionCode 6) and PathIQ 1.1 (versionCode 2) compile as installable debug-signed APKs. Source and packaged web assets are compared before release. These are direct-install builds, not Play Store release-signed bundles.

## External conditions and operational setup

The existing Google Maps key is restricted to browser referrers and rejects server geocoding. The deployed service uses a U.S. Census fallback for complete U.S. street addresses, rejecting ambiguous, wrong-state or wrong-ZIP matches. Census coordinates are street-range interpolation, not rooftop/entrance guarantees. Google navigation itself uses the Maps application/web destination URL. Google road-traffic APIs still require an appropriately restricted server credential if those features are enabled.

Source: https://www.census.gov/programs-surveys/geography/technical-documentation/complete-technical-documentation/census-geocoder.html

Each real organization must configure its actual warehouse pickup address, physical bin labels and registered drivers using Operations controls. No warehouse address or driver organization membership was guessed from delivery destinations or existing null-organization records.

No Android device was connected during this repair (`adb devices` was empty). Device installation, real scanner hardware, background GPS/notification behavior and physical printing therefore remain unverified. SMS challenge logic is tested without sending a live OTP to a person; real Twilio delivery is not claimed as tested. These limits are distinct from the passed browser/API/database lifecycle and successful native builds.
