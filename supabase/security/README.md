# TackPath security hardening — System A, Stage A

Branches: `claude/security-hardening` in **bbrian34/tackpath-app** (SQL, edge functions, web pages,
tests) and **bbrian34/tackpath-driver** (driver app). Nothing here has been applied to production,
deployed, or merged. Bryan applies everything after review, in the order below.

## What changes

| Gap | Before | After |
|---|---|---|
| SMS relay | `send-sms` sent any text to any number for anyone with the public key | `send-sms` takes only `{session, job_id}`. The database checks the dispatcher session, that the job is that company's, assigned to exactly one driver with `sms_consent` and a valid phone, and builds the fixed assignment text (with "Reply STOP to opt out"). Limits: once per job per 10 min, 10/driver/hour, 30/driver/day, 200/company/day, 500/day overall. Anything else is refused. |
| Driver sign-in | Any 6-digit code, any phone, even unregistered; "session" = name in localStorage | `driver-login` texts a random 6-digit code to registered, approved drivers only (same answer for every number). Stored as salted SHA-256, expires in 10 min, single use, 5 wrong tries burn it, 1 code/min and 5/hour per number, 300/hour overall, 10 wrong codes/hour per number. A successful sign-in returns a server session (30 days). |
| Reviewer account | — | +1 (404) 555-0199 only, fixed code set by Bryan (`tp_sec.admin_set_demo_code`), stored as bcrypt. It is compared only for that number and that session sees only the `tackpath-review` company. |
| Dispatcher identity | The company slug alone | Company slug **and** company code, checked by the server (bcrypt), 10 failures/15 min lock. The session is shared by dispatcher, fleet, PathIQ stow and portal on the same device. |
| Portal | Downloaded every company's `access_code` and compared it in the browser | Server-side check; codes are never sent to the browser. |
| Tables | anon could read, insert, update and **delete** everything | anon has **no** table access at all. Every live page goes through security-definer RPCs: `tp_org` (company), `tp_driver` (driver), `tp_customer` (order token), `tp_track` (exact tracking id/number, tracking fields only), `tp_driver_signup`. |
| Delete | Dispatcher "Clear all" / "Delete job" deleted jobs and messages | Archived (board → Archive tab). Nothing can be deleted with the public key. |
| Proof of delivery | Public bucket, overwritable | Private bucket. Upload only by the assigned driver (`pod` function); dispatch opens a 1-hour signed link ("View proof of delivery" on delivered cards). |
| Tracking | id **prefix** search; whole route (every customer's name and address) returned for a tracking number | Exact id / exact tracking number only; only that customer's stop; live location only while assigned/in transit; one rating after delivery. |
| Shopify webhook | No signature check | Rejects anything not signed with `SHOPIFY_API_SECRET`. |
| Committed Anthropic API key | In `owl.html`, `tackpathone.html`, `guide.html` (public since 2026-07-12) | Removed from the files on this branch. **It must be revoked** (see below) — removing it from the files does not un-publish it. |

Also: unapproved applicants (`driversignup.html` → `pending_approval`) cannot sign in until a
dispatcher clicks **Approve** in the Drivers tab; removing a driver signs them out.

## Files

| File | Purpose |
|---|---|
| `00_production_snapshot.sql` | Read-only snapshot of production security settings |
| `10_sessions_and_rpcs.sql` / `.rollback.sql` | Additive: private `tp_sec` schema, sessions, codes, RPCs. Changes nothing existing. Preflight aborts (changing nothing) if a needed column is missing. |
| `20_lockdown.sql` / `.rollback.sql` | Stage A lockdown. Records a replayable backup of every grant, policy, RLS flag, default privilege and bucket setting it changes; the rollback replays it. |
| `30_review_account.sql` | Creates the review company and driver (idempotent) |
| `../functions/_shared/tp_security.js` | Logic for send-sms, driver-login, pod, Shopify HMAC (unit-tested under Node) |
| `../functions/{send-sms,driver-login,pod}/index.ts`, `shopify-webhook/index.ts` | Edge functions |

## Deploy order (do not skip ahead)

0. **Now, independent of everything else:** Anthropic Console → API keys → revoke the key that was in
   `owl.html` / `tackpathone.html` / `guide.html`. Check usage/billing for abuse since July.
1. **Snapshot** — SQL Editor: run `00_production_snapshot.sql`, export CSV, keep it (and send it for
   review). Confirm the tables, RLS and policies match what this plan assumes.
2. **Migration 10** — SQL Editor: paste `10_sessions_and_rpcs.sql`, Run. If it stops with "Production
   differs…", nothing changed: send the message.
3. **Company codes** — existing portal access codes were carried over. For every company without one:
   `select tp_sec.admin_set_org_code('slug', 'a code of 8+ characters');`
   Tell each dispatcher their code (they now enter company + code).
4. **Review account** — run `30_review_account.sql`, then
   `select tp_sec.admin_set_demo_code('NNNNNN');` and
   `select tp_sec.admin_set_org_code('tackpath-review', '…');`. Create a short demo route in the
   tackpath-review dispatcher. Put +1 (404) 555-0199 and the code in the Play/App Store review notes.
5. **Edge functions** (secrets `SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `SHOPIFY_API_SECRET` must be set):
   ```
   supabase functions deploy send-sms --no-verify-jwt
   supabase functions deploy driver-login --no-verify-jwt
   supabase functions deploy pod --no-verify-jwt
   supabase functions deploy shopify-webhook --no-verify-jwt
   ```
   (They check the TackPath session themselves; the publishable key is not a JWT.) From this moment
   the SMS relay is closed. Assignment texts resume when step 6 is live.
6. **Web pages** — merge tackpath-app `claude/security-hardening` into `main` (GitHub Pages deploys it).
   Everyone signs in again once (dispatchers with company + code, drivers with a texted code).
7. **Driver app** — merge tackpath-driver `claude/security-hardening`, build a new version
   (bump versionCode), upload to Play closed testing, and wait until every tester has updated.
   Old app builds keep working until step 9, then stop.
8. **Check every flow** with the anon key still open (checklist below).
9. **Migration 20 (lockdown)** — SQL Editor: paste `20_lockdown.sql`, Run.
10. **Check again**, plus confirm the anon key is closed:
    ```
    curl "https://hofijsiphyjpdvujjzfi.supabase.co/rest/v1/jobs?select=id&limit=1" -H "apikey: sb_publishable_…"
    ```
    must return a permission error, not rows.

Flow checklist: dispatcher sign-in, board, assign (driver gets the text), broadcast, cancel stop,
archive, Clear Board, drivers add/edit/approve/remove, SmartSort publish, fleet page; driver sign-in
(code arrives), offers, accept, start, stops, delivery scan gate, proof photo, deliver, messages,
Ruby; PathIQ sign-in, bin open, stow, reset; portal sign-in; customer order → confirm; track.html
and tracking.html links; driver application → Approve → sign-in; dispatcher "View proof of delivery".

## Rollback

- **Something breaks after step 9:** SQL Editor → `20_lockdown.rollback.sql`. Restores exactly the
  grants, policies, RLS flags, default privileges and pod bucket setting from before 9 (tested:
  production snapshot before 20 and after 20 + rollback are identical, except that a function whose
  ACL was the implicit default comes back as the equivalent explicit grant). Pages and app keep
  working through the RPCs.
- **Full rollback:** `20_lockdown.rollback.sql` (if 20 was applied), then `10_sessions_and_rpcs.rollback.sql`,
  revert the merges, redeploy the previous edge functions
  (`git checkout <previous main> -- supabase/functions && supabase functions deploy …`).
  Rolling back send-sms re-opens the SMS relay.

## Tests (all local; nothing touches production)

`cd tests && npm ci && node --test security/*.test.mjs` — PGlite with Supabase roles, pgcrypto, a
storage schema and the live tables as they are today (anon granted everything, "allow all" policies),
then the migrations on top:

- `rpc.test.mjs` (15): preflight abort; company sign-in, lockout, bcrypt; admin codes; org scoping;
  every dispatcher, PathIQ, driver, customer, tracking, signup flow; real codes — wrong, reused,
  expired, 5 attempts, unknown/pending numbers, rate limits; demo code only for 555-0199 and only
  the review company; service-only RPCs not callable by anon/authenticated.
- `lockdown.test.mjs` (5): anon/authenticated cannot SELECT/INSERT/UPDATE/DELETE any table or view or
  call other functions; future tables not auto-granted; pod private; all flows still work; exact rollback.
- `edge.test.mjs` (7): relay closed (`{to, body}` refused, nothing sent), only the fixed text to the
  assigned consenting driver of the caller's company, rate limits, driver-login, pod upload/view rules,
  Shopify HMAC, CORS.
- `pages.test.mjs` (9): the real pages in jsdom against that database — driver sign-in by texted code,
  dispatcher, PathIQ, portal, customer, track, tracking, fleet, signup — with **zero** direct table or
  storage requests.

tackpath-driver: `cd tests && node --test` (31, including `security.test.js`).

## Decisions made (please confirm)

1. **Legacy rows without a company** (`org_id` NULL) stay visible to every signed-in company
   (`tp_sec.settings.include_null_org_rows = true`), and drivers without a company see every
   company's offers (`driver_without_org_sees_all = true`) — as today. Turn both off after Stage B
   backfills `org_id` (`update tp_sec.settings set value='false' where key=…`).
2. **Clear Board / Delete Job archive** instead of deleting; messages are never deleted.
3. **PathIQ** uses the company sign-in (same code as the dispatcher), once per device.
4. **Customer orders** are capped at 60/hour overall and 30/hour per company; the customer-order SMS
   (which never worked) was removed.
5. **Pending applicants cannot sign in** until approved (new Approve button).
6. **`tracking.html`** now receives only the customer's own stop (it used to receive the whole route).
7. **Retired pages** lose database access at step 9 as agreed: owl, brain, crm, smartsort, de, zelurco,
   dispatcher-white(-preview), dispatcher-mobile, driver-app, fleet-cards, symphony(.trial), tackpathone,
   policy-engine(-recovery), index-white, guide.

## Still open (outside this change)

- `swarm-watch`, `sponge`, `smartsort`, `nav-proxy`, `smooth-api` accept unauthenticated calls with the
  service role or the Google server key (quota/cost abuse, like the SMS relay). Next step: require a
  `tp_org` / `tp_driver` session in each (same pattern as `pod`).
- `shopify-oauth` uses the bare org id as OAuth `state`: sign it (HMAC with `SHOPIFY_API_SECRET`).
- Browser-side Geocoding REST calls (dispatcher, track, tracking) do not work with a referrer-restricted
  key; move them to `nav-proxy`.
- No per-IP rate limiting (the database cannot see client IPs); per-number, per-company and global
  limits are in place.
- The September `operations` migrations in `supabase/migrations` are not used by the live pages.
- Pre-existing test failures unchanged: `tests/driver.test.js` (5), `tests/smartsort_integration.test.js` (1).

## Stage B (plan only): Supabase Auth with per-company RLS

1. **Backfill `org_id`** on jobs, drivers, messages (via job), driver_locations, bin_bindings, events,
   agent_memory; make it NOT NULL; then switch off the two legacy settings above.
2. **Identities in Supabase Auth**: drivers via Phone OTP (Twilio provider — replaces `tp_sec`
   codes); dispatchers/owners as email users. A `memberships(user_id, org_id, role)` table
   (owner, dispatcher, warehouse, driver) managed by owners.
3. **JWT claims**: a custom access-token hook adds `org_id` and `role` to the JWT.
4. **RLS per table** on `(auth.jwt()->>'org_id')` and role: drivers see offers + own routes and update
   only own route columns (column privileges + trigger); warehouse sees jobs/bins; dispatcher full
   company scope; no DELETE except owner where needed. Storage policies on `pod/<org_id>/…`.
5. **Pages** move from the `tp_*` gateways to supabase-js with the user's session (or keep the gateways
   as thin wrappers that use `auth.uid()` instead of `tp_sec.sessions`).
6. **Edge functions** verify the user JWT (`verify_jwt = true`) and read the org from claims.
7. **Cut over** per role behind a flag, then drop `tp_sec.sessions`/codes; keep rate limits and the SMS log.
8. **Tests**: the PGlite harness here extends with `auth.jwt()` stubs per role.

## OWL (Ascend plan) — what a secured rebuild needs

OWL (`owl.html`) today reads `jobs` (latest 200/500), `work_items` (pending), `agent_audit_log` (latest 30),
`bcl_snapshots` (latest), updates `work_items` status, and calls Anthropic **from the browser with a
committed key**. A rebuild needs: an owner role on the company session (Stage A: `tp_org` actions
`owl_overview`, `work_item_update` restricted to role owner; Stage B: membership role `owner`), org
scoping on `work_items`, `agent_audit_log`, `bcl_snapshots` (add `org_id`), and a server-side `owl-ai`
edge function holding the Anthropic key as a secret, checking the owner session, with per-company limits.

## Google API keys — restrictions to set (Google Cloud Console → APIs & Services → Credentials)

Three keys are in the code. Set restrictions, then test the listed pages before relying on them.

**Key A — web pages** (ends `…CZk8`; `dispatcher.html`, `driver.html`, `track.html`, `tracking.html`;
retired pages too)
- Application restrictions → **Websites**: `https://tackpath.com/*`, `https://www.tackpath.com/*`
  (add `https://bbrian34.github.io/*` only if you still open the site there).
- API restrictions → **Restrict key**: Maps JavaScript API, Maps Embed API, Directions API (used by the
  map's DirectionsService in driver.html), Geocoding API, Routes API (tracking.html).
- Note: the browser calls to the Geocoding *web service* (`/maps/api/geocode/json` in dispatcher, track,
  tracking) are rejected by Google for referrer-restricted keys ("API keys with referer restrictions
  cannot be used with this API"); if those features matter, route them through `nav-proxy`, which uses
  the server key `GOOGLE_MAPS_KEY`.

**Key B — driver app WebView** (ends `…57Ts`; `www/index.html` in tackpath-driver, also the retired
`driver-app.html`). It is only used by the **Maps Embed** iframe inside the app's WebView, so it is a
*website* key, not an Android key:
- Application restrictions → **Websites**: `https://localhost/*` (the Android app's WebView origin
  under Capacitor). Add `https://tackpath.com/*` only if the web driver page should use it too.
- API restrictions → **Maps Embed API** only.
- Android-app restrictions would not work here: the iframe request comes from the WebView origin,
  not from the Android SDK. (iOS later: its WebView origin is `capacitor://localhost`, which Google's
  website restriction may not accept; check when the iOS app ships.)

**Key C — Firebase / push** (ends `…4Wnc`; `android/app/google-services.json`)
- Application restrictions → **Android apps**, package `com.tackpath.driver`, with these SHA-1s:
  1. **Play App Signing key** — Play Console → TackPath Driver → Test and release → App integrity →
     App signing → "App signing key certificate" → SHA-1. (Play re-signs the app; installs from Play
     carry this certificate, not your upload key.)
  2. **Upload key** — `keytool -list -v -keystore android\tackpath-upload.jks -alias tackpath-upload`
     (needed for builds you install directly, e.g. internal testing APKs you sideload).
  3. Optional, debug builds: `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android -keypass android`.
- API restrictions → Firebase Installations API, FCM Registration API (and Firebase Cloud Messaging API
  if the console lists it for this key). After saving, open the Play build and confirm a push arrives.

Do not use key B or C for anything else. Keys changes take a few minutes to apply.
