# TackPath live demo — guide

A self-running, presentation-ready demonstration of the TackPath operation as it
works today: a courier company receives a shipment, and TackPath runs it from the
manifest to the last delivery. **The screens are the real TackPath pages** —
the dispatcher (`dispatcher.html`), PathIQ (`stow.html`) and the native driver
app (tackpath-driver `www/index.html`, copied to `demo/vendor/driver-app.html`) —
running on demo data inside your browser. Nothing in the production apps was
changed.

## Start it

```bash
cd tackpath-app            # the repo root (the demo loads ../dispatcher.html and ../stow.html)
python3 -m http.server 8765
```

Open **http://localhost:8765/demo/** in Chrome or Edge (a laptop screen is fine;
the stage scales to any window — use full screen, F11, for presenting). Press
**▶ START DEMO**. It runs by itself: about 3 minutes at 1×.

Any static file server works; the demo needs no build step, no install and no
internet connection.

## Controls

The control panel sits in the bottom-right corner and fades while you present;
move the mouse over it to bring it back. Keyboard shortcuts work at any time.

| Control | Key | What it does |
|---|---|---|
| ▶ Start | Space | Starts from the beginning |
| ❚❚ / ▶ (pause / resume) | Space | Freezes everything — the clock, the apps, the drivers |
| ↺ (restart) | R | Reloads and starts again from a clean, identical state |
| 1× 2× 4× | 1 2 4 | Presentation speed |
| ⏮ (previous scene) | ← | Rebuilds from a clean start and fast-forwards to the previous scene |
| ⏭ (next scene) | → | Fast-forwards through the rest of this scene (the apps really do the work) |
| Scene bars | — | Jump to any scene |
| 🔊 / 🔇 | — | The apps' own beeps on or off |

**Reset:** Restart (or reloading the page) always starts from the same state:
an empty board at 7:52 AM. Nothing is stored between runs.

URL options: `?autostart=1`, `?scene=4` (0-based, fast-forwards there),
`?speed=2`, `?sound=0`.

## The scenes

Times are the demo clock (the operation's own morning).

| # | Scene | What you see | Apps on screen |
|---|---|---|---|
| 1 | **Intake · SmartSort** (7:52) | The client's manifest (21 lines, 30 packages, 17 addresses) arrives. The dispatcher (light theme) uploads it; SmartSort geocodes, measures road time between every pair of stops, builds 3 routes, passes the package-accounting gate and publishes them as *pending*. | Dispatcher |
| 2 | **Dispatch assigns drivers** | The dispatcher assigns Andre Coleman to RT-001, then Priya Nair (RT-002) and Luis Ortega (RT-003). Andre's phone picks up *his* route: 7 stops, 16 packages, pickup locked: **Waiting for warehouse**. | Dispatcher + driver app |
| 3 | **PathIQ · sort and stage** (8:04) | Keisha sorts on the TC56 (step bar PACKAGE › BIN › LOCATION › STAGE): scan the package → card flips to its bin → scan the bin. A route's first package opens a bin (BIN QR + LOCATION QR). One wrong-bin scan is rejected. When a route is complete PathIQ asks for a staging spot and she scans **STG S-0x**. The pace speeds up. Andre's app reads **Staging in progress**. | PathIQ + staging-rack illustration + driver app |
| 4 | **Route ready for pickup** | RT-001's last package: bin 1A complete. Andre's app turns **Ready for pickup — bin 1A · A-01**; Keisha stages the bin at S-01. | PathIQ + driver app |
| 5 | **Driver pickup** | AT PICKUP → bin scan: bin 2A by mistake → **Wrong bin**; bin 1A → confirmed. All 16 packages scanned into the van (each shows its stop), START ROUTE → **in transit** (the bin, location and staging spot are released). | Driver app + rack illustration |
| 6 | **On the road · back to TackPath** | Dispatch opens SmartTrack. Andre taps stop 1: TackPath hands navigation to Google Maps (simulated). One GPS stream moves the phone's navigation and Andre's dot on the dispatcher's map. Inside ½ mile the floating *↩ TackPath* button appears; inside 80 m it turns green, *ARRIVED — tap here to deliver*; one tap returns to TackPath. | Driver phone + dispatcher |
| 7 | **Delivery · proof** | Mark arrived → scan the stop's packages → proof of delivery (front door + photo) → *Delivered*; the next stop opens by itself and Maps starts guiding to stop 2. Stops 2–5 are the same steps, so they run behind a **time-skip** card. | Driver phone + dispatcher |
| 8 | **Exception · business closed** | Stop 6, Gilbert Street Bakery, is closed. Andre taps Problem → *Business closed* → *Report and go to the next stop*. Dispatch's driver chat shows **⚠ PROBLEM — Stop 6: Business closed · 3 packages returning to station**. Stop 7 runs behind a time-skip card. | Driver phone + dispatcher |
| 9 | **Route complete · the day reconciled** | Andre's summary: 6 stops / 13 packages delivered, 1 problem, 3 packages to bring back. The board: RT-002 and RT-003 delivered, RT-001 *finished · problems*. Reconciliation counted from what the apps recorded: **30 received = 27 delivered + 3 returning**. | Driver app, dispatcher |

**Order note.** In the brief, staging (Act 3) came before assignment (Act 4).
The demo assigns first, because that is the only order in which the driver app
can be *seen* going **Waiting for warehouse → Staging in progress → Ready for
pickup**: an app assigned after staging opens straight on *Ready*. Assigning
routes right after SmartSort is also how a dispatcher would normally work.

## What is real and what is simulated

**Real (unchanged production code, running in iframes):**
- Dispatcher: SmartSort (parsing, geocoding calls, road-matrix construction,
  route building, the accounting gate, publishing), the Dispatch board and
  drawer, assignment, SmartTrack fleet map, driver chat, SmartComms messages.
- PathIQ stow: package lookup, bin opening and binding, card flip, wrong-bin
  rejection, counting, *bin complete / staged / ready*.
- Native driver app: sign-in, managed dispatch, warehouse status, bin check,
  package loading, route start, Google Maps hand-off call, arrival deep link,
  delivery scan gate, proof of delivery, auto-advance, problem reporting,
  route summary.
- Every status change, message, bin binding and event is written by those apps
  through the same RPC calls they make in production.

**Simulated (by the demo, clearly outside the apps):**
- **The backend.** `demo/js/backend.js` answers `/rest/v1/rpc/*` and
  `/functions/v1/*` in the browser, following the rules in
  `supabase/security/10_sessions_and_rpcs.sql` (sessions, `tp_org`,
  `tp_driver`, the publish gate, no-regress rules). Tables live in memory.
- **People's hands:** taps, scans, the TC56 trigger (Zebra scanner plugin), the
  phone camera picture (a painted label with a real Code 128 barcode, a bin QR,
  a doorstep), the signature strokes.
- **Google:** geocoding and road times come from a hand-drawn offline map of
  real Atlanta street names (`demo/js/map.js`); the navigation screen and the
  dispatcher's map are drawn by the demo. No Google service is called.
- **Phone system layer:** the navigation app, the floating *Back to TackPath*
  button (drawn the way the native `ArrivalService` draws it), notifications,
  spoken prompts (shown as captions).
- **GPS:** one simulated stream for Andre; Priya and Luis are simulated drivers
  whose positions and deliveries are posted through the same driver RPCs their
  phones would use.
- **Warehouse floor:** the staging-rack panel is an illustration.
- **Time:** a demo clock starting at 7:52 AM; driving and sorting run faster
  than real time, and the clock moves forward between scenes.

## Isolation and safety

- The demo page and every embedded app run under a Content-Security-Policy of
  `connect-src 'self'`: the browser itself refuses any request to another host.
- Inside each app, `fetch` is replaced before the app's own code runs:
  Supabase RPC/function calls go to the in-browser backend; direct table calls
  get the same *permission denied* production gives; anything else is refused
  and counted. `XMLHttpRequest`, `WebSocket` and `sendBeacon` are blocked.
- No SMS: `send-sms` and the sign-in code are recorded and **not sent**.
- No real dispatch, no real GPS, no charges, no route changes: there is no
  connection to production Supabase at all, and storage is in memory per run.
- No Google APIs are called, so there is no loop that could bill an API; route
  geometry is computed locally once and cached.
- Validation (below) checks on every run that zero outside requests were made.

## Validation

```bash
python3 -m http.server 8765 &
PLAYWRIGHT_MODULE=$(npm root -g)/playwright node demo/test/validate.js 4 2
```

Runs the full demo twice at 4× and checks: all 10 scenes finish; every status
change is legal; counts reconcile (30 = 27 + 3); final states; the driver
app's stored locations are exactly the simulated GPS fixes; the dispatcher's
map shows Andre on the same stream; no outside requests; no failed requests; no
app or console errors; every run produces identical routes, stops, statuses,
events, bins and driver messages (the dispatcher's own SmartComms check-ins are
timed by its polling, so their exact count and moment can differ by one); pause freezes everything; next, previous and
restart work and restart resets to an empty board at 7:52.

## Known limitations

- The navigation screen is a simulation of Google Maps, not Google Maps.
- The dispatcher has no per-route warehouse-staging status (see
  `WORKFLOW-MAP.md`), so the *Ready for pickup* moment is shown on PathIQ and
  the driver app only.
- The dispatcher's fleet map redraws every 10 demo-seconds (its real
  behaviour); the demo glides the dots between redraws.
- Spoken prompts are shown as captions; the apps' beeps play if sound is on.
- The demo needs Chrome or Edge (it uses canvas streams for the phone camera).
- Running faster than 4× is not offered: the apps' own animations and timers
  set the pace.
- `demo/vendor/driver-app.html` is a copy of the native app at
  tackpath-driver `86b2bba`; refresh it when the app changes.
