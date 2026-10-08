# TackPath workflow map (as the code works today)

Read from the code before the demo was built. Branch base: `claude/driver-experience`
(tackpath-app) and the native driver app at tackpath-driver `86b2bba`. Everything the
demo shows follows this map; where the user's brief and the code differ, the code wins
and the difference is listed at the end.

## Apps and how they talk

| App | File | Who uses it | Talks to |
|---|---|---|---|
| Dispatcher (incl. SmartSort, SmartTrack) | `dispatcher.html` | Dispatch office, desktop | `tp_org` RPC (company session), `publish_surge_route` via `tp_org publish_route`, Google Geocoding REST, `smooth-api` (road matrix, ETAs), `send-sms` |
| PathIQ (stow) | `stow.html` | Warehouse, Zebra TC56 (DataWedge broadcast → `ZebraScanner` plugin) | `tp_org` RPC (same company session) |
| Driver app (native) | tackpath-driver `www/index.html` (Capacitor, Android) | Drivers | `tp_driver` RPC (driver session from a texted code), `pod` function, `smooth-api` geocode; native `ArrivalPlugin` / `ArrivalService` (arrival detection + floating "Back to TackPath" button), `AppLauncher` (opens Google Maps) |
| Driver web | `driver.html` | Drivers in a browser | same as native, no managed dispatch / warehouse status / Google Maps handoff |

Every page funnels its data through `/rest/v1/rpc/<fn>` and `/functions/v1/<fn>`; the
pages never read tables directly (security hardening 2026-10).

## The operation, step by step

1. **Manifest intake** (dispatcher → SmartSort drawer). CSV columns `order_id, recipient,
   address, packages` (+ optional `tracking_number, route_hint, phone, unit, access_notes,
   gate_code, delivery_notes, signature_required`). `parseCSV` → package table + stats
   (packages / stops) → `buildAndAutoDispatch()` starts immediately.
2. **SmartSort** (`buildRoutes`): consolidate packages into unique stops by address →
   geocode each stop (Google Geocoding, progress "Geocoding n of N") → road matrix
   (`smooth-api` `matrix`, "Measuring real road cost between every stop…") → matrix-first
   construction + local search ("Constructing and improving routes against measured road
   cost…") → package-accounting gate (expected = assigned + exceptions) → route cards
   (stops, packages, road miles, est. min, stop list, master code) → each route published
   (`publish_route`, status `pending`, `bin_label` null, `job_type` surge, price, ETA) →
   self-check panel → live labels window. The dispatcher may commit a driver count; then
   SmartSort must build exactly that many routes.
3. **PathIQ stow** (TC56, Stow screen): scan package → route found → if the route has no
   bin: **OPEN NEW BIN** → scan BIN QR → SCAN LOCATION QR → "Bin Open · SCAN THE PACKAGE
   AGAIN" (`open_binding`, `set_bin_label`) → scan package → **card flips** to the green
   side: `BIN 2A · Location A-04 · SCAN BIN OR LOCATION · STOP 3` → scan bin/location →
   success arpeggio, card flips back, "✓ Confirmed BIN 2A · 4 of 11 sorted · STOP 3".
   Wrong bin → error buzz "Wrong Bin · Expected BIN 2A or location A-04". Same package
   again → "ALREADY SCANNED". Last package → **"✓ Bin Complete · STAGED · READY FOR
   PICKUP"** (`set_staged`, `binding_ready` → binding state `ready`). Every scan is an
   `events` row (`package.stowed`, `bin.opened`, `bin.completed`).
4. **Assignment** (dispatcher, Dispatch tab → job drawer → driver select → Assign):
   `update_job {status:'assigned', driver_name}` + assignment SMS (`send-sms`).
5. **Driver receives the route** (managed dispatch, native app): the app polls for its own
   `assigned` surge route → "New route assigned to you" → start-of-day card (route, stops,
   packages, bin, pickup bin+location, status). Warehouse status comes from the bin
   binding: **WAITING FOR WAREHOUSE** (no binding) → **STAGING IN PROGRESS** (open) →
   **READY FOR PICKUP** (ready, alert + "Route ready for pickup" voice). AT PICKUP is locked
   until ready.
6. **Pickup**: AT PICKUP → scan bin (checked against PathIQ's binding; wrong bin → "WRONG
   BIN", red flash, buzz, "Wrong bin.") → "BIN 2A CONFIRMED" → load every package (n of N,
   STOP number, OK between units) → Pickup Complete → START ROUTE (`in_transit`,
   `picked_up_at`) → route list with progress bar.
7. **Driving**: tap the stop → Google Maps opens (`google.navigation:` via AppLauncher),
   the native ArrivalService starts (floating **Back to TackPath** button over Maps, faded
   until ~½ mile, green "✓ ARRIVED · Tap here to deliver" within 80 m, heads-up
   notification with RETURN TO TACKPATH). GPS posts `location` every ≥15 s / 60 m.
8. **Return**: tapping the button opens `tackpath://arrived` → `onDeepLinkArrived()` →
   arrival prompt "STOP n · Arrived · ✓ Mark Arrived".
9. **Delivery**: Deliver → scan every package for the stop (delivery scan gate) → proof of
   delivery: delivery choice (handed to customer = signature; front door / mailroom / back
   door = photo), notes → `STOP_DELIVERED::` message + `stops_completed` → next stop comes
   up by itself after 5 s.
10. **Problems**: Problem → six reasons (no access, business closed, refused, damaged (photo
    required), wrong address, unsafe) → `STOP_EXCEPTION::` message → dispatcher chat shows
    "⚠ PROBLEM — Stop n: reason · packages returning to station"; packages return to the
    station; the route moves on.
11. **Route end**: last stop → route `delivered`, or `completed_with_exceptions` if any
    stop had a problem → driver summary (stops/packages delivered, problems, packages to
    return). Dispatcher: "Finished · problems", exception queue "Finished with problems",
    returns-aware SmartComms message, History/Analytics totals.
12. **Tracking**: dispatcher SmartTrack tab — Fleet Live Map (Google Maps markers from
    `driver_locations`, refreshed every 10 s), driver cards; Dispatch tab pipeline
    (pending / assigned / in transit / delivered stream from `STOP_DELIVERED`), signal
    table with stop progress, ETA, exceptions panel.

## Discrepancies between the brief / labels and the code

- **No warehouse status on the dispatcher.** PathIQ's staging (`staged_at`, bin binding
  `ready`) is shown by PathIQ and the driver app only; the dispatcher board does not show
  per-route staging.
- **SmartSort route cards still show "Bin 1A / 2A / 3A"** computed from the route number,
  but SmartSort no longer assigns bins (PathIQ does when a worker opens a bin). The badge
  can disagree with the real bin.
- **"Master Scan Code — driver scans once to load entire route"** on SmartSort cards: the
  driver app never uses the master code; pickup is a bin scan plus one scan per package.
- **Bins are never released** after pickup, although a comment says the driver pickup
  releases them (`bin_bindings.released_at` is never written).
- **PathIQ home tiles SmartSort, Connect, Support, Login, Settings** only show "still
  deciding exactly what this does" alerts; IQ2 opens a one-line stub page.
- **Dispatcher Command tab** shows fixed placeholder SLA percentages (98 % / 96 % / 91 % /
  97 %) and "Client A / Client B" panels that are not computed from data.
- **Font links are malformed** (`family=family=Montserrat…`) on dispatcher and driver app,
  so the first font in each request does not load from Google Fonts.
- **Driver web (`driver.html`)** has no managed dispatch or warehouse status and no Google
  Maps handoff; the demo therefore uses the native app (the driver product).
- **Dispatcher fleet map** redraws markers every 10 s (no interpolation); the demo keeps
  that behaviour and only shortens the interval with the demo speed.
- **OWL** (`owl.html`) is a retired page (no database access after the security
  migration) and is not shown. Billing beyond the per-route `price` written by SmartSort
  (`stops × 8 + packages × 2`) is not part of the live workflow.

## Found while running the real apps end to end (demo build, 2026-10-08)

These are behaviours of the production code, reproduced in the demo. None was
changed; the demo works around them as noted.

1. **Driver app, cold start offers every pending route (bug).** On a start with a
   saved session, `initApp()` runs *before* the managed-dispatch block replaces
   `pollJobs`, and `setInterval(pollJobs, 5000)` keeps the original function. The
   original poll offers any pending, unassigned route as an Accept/Decline
   "New Job" — so after an app restart drivers are offered routes nobody assigned
   to them. Signing in fresh (code screen) is not affected. The demo signs Andre in
   through the code screen. Fix: have `startPolling` call `pollJobs` through a
   wrapper (`setInterval(()=>pollJobs(),5000)`), or move the boot call below the
   managed-dispatch block.
2. **PathIQ: scans during a refresh read "Not on any route" (race).** `loadRoutes()`
   sets `binMap={}` and then awaits the events fetch before rebuilding it, every
   5 s. A package scanned during that wait is rejected as *Not on any route*. The
   demo waits for the index between scans. Fix: build the new map in a local
   variable and assign it once.
3. **Dispatcher Exceptions card ignores routes that finished with problems.** The
   card on the Dispatch board (`renderExceptionQueue`) lists only stale-unassigned
   and SmartTrack-flagged jobs; *completed_with_exceptions* appears only in the
   table row ("⚠ Finished · problems") and in the exception filter panel.
4. **Driver chat follows one job only.** The Dispatch Comms → Drivers tab shows the
   messages of the first *active* job. A problem report on a route that has just
   finished, or on one of several active routes, may not be visible there.
5. **Driver chat shows `POD_ATTACHED::{…}` as raw JSON bubbles** for every proof
   photo/signature.
6. **SmartSort drawer wording:** the *Stops* tile counts manifest lines (21), not
   addresses (17); the toast says "21 packages loaded" for 30 packages; each publish
   toasts "created and broadcast to drivers", though managed dispatch never
   broadcasts routes.
7. **The Dispatch board's Delivered counter counts stops**, not routes or packages.

## How TackPath uses Google today (inspected before building the demo)

| Where | API | Billable | Frequency |
|---|---|---|---|
| Dispatcher SmartSort | Geocoding REST (browser key) | yes | once per new address per upload |
| Dispatcher SmartSort | Routes matrix via `smooth-api` | yes | once per upload |
| Dispatcher live ETA | Routes via `smooth-api` | yes | **every 30 s per active route** (`ETA_REFRESH_MINUTES=0.5`) |
| Dispatcher SmartTrack | Maps JavaScript API | yes (map loads) | on opening the tab |
| Driver app stop map | Maps Embed iframe (`maps.google.com/maps?q=…&output=embed`) | no | per stop |
| Driver app navigation | `google.navigation:` intent (Google Maps app) | no | per stop |
| Driver app | Geocoding via `smooth-api` only when a stop has no coordinates | yes | rare |

The demo calls none of these: geocoding and road times come from the offline
map, the Maps JS map and the embed iframes are drawn by the offline map, and the
navigation intent opens the simulated navigation screen.
8. **Proof of delivery: the "Photo needed" line does not update after the photo is
   taken** (`capturePODPhoto` does not call the driver-experience `renderNeeds`);
   Confirm still works because `submitPOD` checks the photo itself.
