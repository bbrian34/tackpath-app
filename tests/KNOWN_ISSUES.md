# Known test issues (2026-10-11)

The suites are green except for the tests listed here. Each is **skipped**
(not failing) because it exposes a **real product bug**. The product code is
deliberately not changed by the test cleanup. Un-skip the test in the same PR
that fixes the bug.

## Status (2026-10-11): both fixed SERVER-SIDE by migration 68

`supabase/security/68_job_timestamps.sql` is a trigger on `public.jobs`. It
sets `picked_up_at` when a route goes `in_transit` and `delivered_at` when it
goes `delivered` or `completed_with_exceptions`, never overwriting a value.
The app is unchanged.

- Proof that the server writes them: `tests/security/job-timestamps.test.mjs`.
- Proof that the dispatcher shows them: `tests/dispatcher-job-timestamps.test.js`.

The two tests below stay **skipped**. They check what `driver.html` *sends*
in its update, and the page still sends no timestamp. They would pass only if
the app also sent the times, which is not needed now. Delete them, or re-point
them at the server, once 68 is applied in production.

## 1. `driver.html: captures picked_up_at when the route is picked up (Start Route)` (tests/driver.test.js)

- **What breaks:** no driver code ever writes `jobs.picked_up_at`. Start Route
  (`confirmPickup()`) sets `status: 'in_transit'` only.
- **Who is affected:** dispatchers. In `dispatcher.html`:
  - the job detail **Picked up** time is blank;
  - the on-time progress bar has no start (it needs `picked_up_at` and
    `estimated_delivery_at`);
  - the **Driver dark** exception (no update for 30 min) falls back to
    `created_at`. A route created hours before pickup is therefore flagged as
    dark as soon as it is picked up.
- **Suggested fix:** in `confirmPickup()` (`driver.html` and the native
  `www/index.html`), add `picked_up_at: new Date().toISOString()` to the
  in-transit patch. `tp_driver update_job` already allows the column
  (`10_sessions_and_rpcs.sql`), and migrations 60/61/65 already react to it.
- **Why the old test was also wrong:** it expected the timestamp at
  **acceptance**. Pickup is Start Route by design, so the rewritten test
  checks Start Route.

## 2. `driver.html: captures delivered_at when the final stop is confirmed` (tests/driver.test.js)

- **What breaks:** the final stop writes `status: 'delivered'` and
  `stops_completed`, but not `jobs.delivered_at`. Each stop's
  `STOP_DELIVERED::` message carries its own `delivered_at`; the job row never
  gets one.
- **Who is affected:** dispatchers and reporting. In `dispatcher.html`:
  - the job **Delivered** time is blank;
  - the on-time / late result (`delivered_at` against `estimated_delivery_at`)
    is never shown;
  - the "Finished with problems" age uses `created_at`.
- **Suggested fix:** add `delivered_at: new Date().toISOString()` to the final
  `{status:'delivered', ...}` patch in `driver.html` and `www/index.html`.
  `update_job` already allows the column.
- **Caveat:** no SQL in this repo sets it either. If production has a trigger
  outside the repo, check it before changing the app.

## Fixed or removed as outdated (no product change)

| Test | Why it failed | Action |
|---|---|---|
| `driver.html: clears saved route state on delivery completion ...` | Built a fake route with no server session and wrote raw PATCHes to `/rest/v1/jobs`. Accept now claims through `tp_driver`, so it never got a route. | Rewritten on the gateway harness. Passes. |
| `driver.html: a deleted job ... still clears the driver` | Same setup failure; also polled the old `/jobs?select=status` endpoint. | Rewritten: the job disappears from the server and TP-GONE clears it. Passes. |
| `driver.html: restores in-progress route state after ... close/reopen` | Same setup failure. | Rewritten: stop 1 done, reopen, restored at stop 2. Passes. |
| `dispatcher.html: SmartSort integration ...` | Read `#pkgRows`, which was removed from the drawer (it now shows counts and a progress bar). Signed in through a raw `/organizations` read and expected a raw `POST /jobs`. Now it is `tp_org_sign_in` plus the publication gate (`tp_org publish_route`), and routing needs the depot geocode and the road matrix. | Rewritten with the same checks against the current flow. Passes. |
| operations `all shipped operational HTML scripts parse and share the authenticated client` | Required `operations-client.js` in `dispatcher.html`, `driver.html` and `stow.html`. They never loaded it; they use the `tp_org` / `tp_driver` gateway instead. | Still parses all six pages. Requires the ops client only on the three pages that use it, and the gateway on the other three. Passes. |
| operations `signed-in browser lifecycle uses persisted package custody across all apps` (`browser.test.mjs`) | Drove `window.Ops` inside `dispatcher.html` and `stow.html`, an integration that was never shipped. It also required an installed Google Chrome (`channel:'chrome'`). It could not pass against the shipped pages. | Deleted. The shipped flows are covered by `tests/driver-core-flows.test.js`, `tests/driver-*.test.js`, `tests/stow*.test.js` and the PGlite security suite. |
