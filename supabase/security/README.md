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
| Shopify connect | Any page could link any store to any company (`org_id` in the link) | The dispatcher starts it with its company session; the OAuth state (company + store + 15-minute expiry) is signed with `SHOPIFY_API_SECRET`; the callback also checks Shopify's own signature and the store name. |
| Other edge functions | `smooth-api`, `nav-proxy` (Google key), `smartsort`, `sponge`, `swarm-watch` (service role) answered anyone | Each requires a live TackPath session (company or driver as appropriate) or, for scheduled `swarm-watch`, the `CRON_SECRET` header. `smartsort` takes the company from the session, never from the request. |
| Driver login screen | Google / Apple buttons that did nothing; old logo on driver.html | Hidden (`<div id="socialSignIn" hidden>`, restore in Stage B); driver.html shows the new symbol. |
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
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` must be set; if `swarm-watch` runs on a schedule, also
   `supabase secrets set CRON_SECRET=<long random string>` and add the header
   `x-tp-cron-secret: <that string>` to the scheduled call — the snapshot's `12_cron` row shows it):
   ```
   supabase functions deploy send-sms --no-verify-jwt
   supabase functions deploy driver-login --no-verify-jwt
   supabase functions deploy pod --no-verify-jwt
   supabase functions deploy shopify-webhook --no-verify-jwt
   supabase functions deploy shopify-oauth --no-verify-jwt
   supabase functions deploy smooth-api --no-verify-jwt
   supabase functions deploy nav-proxy --no-verify-jwt
   supabase functions deploy smartsort --no-verify-jwt
   supabase functions deploy sponge --no-verify-jwt
   supabase functions deploy swarm-watch --no-verify-jwt
   ```
   (They check the TackPath session themselves; the publishable key is not a JWT.) From this moment
   the SMS relay and the Google/Shopify/AI functions are closed to strangers. Assignment texts,
   dispatcher routing/ETA (smooth-api) and the driver app's address lookup resume when steps 6 and 7
   are live (the old pages and app do not send a session), so deploy step 5 together with step 6.
6. **Web pages** — merge tackpath-app `claude/security-hardening` into `main` (GitHub Pages deploys it).
   Everyone signs in again once (dispatchers with company + code, drivers with a texted code).
7. **Driver app** — merge tackpath-driver `claude/security-hardening`, build a new version
   (bump versionCode), upload to Play closed testing, and wait until every tester has updated.
   Old app builds keep working until step 10, then stop.
8. **PathIQ on the Zebra TC56** (its own copy of stow.html in `C:\Users\bbald\Downloads\pathiq-app`,
   not in git). The current APK keeps working until step 10, then cannot load routes. Rebuild it now:
   ```powershell
   cd C:\Users\bbald\Downloads\pathiq-app
   copy www\index.html www\index.before-security.html            # backup
   # 1. Does your copy have local edits the repo does not have?
   curl.exe -o stow-old.html https://raw.githubusercontent.com/bbrian34/tackpath-app/4d42cd6/stow.html
   fc.exe /N stow-old.html www\index.html                          # "no differences" = safe to replace
   # 2. Take the new page (from main, after step 6)
   curl.exe -o www\index.html https://raw.githubusercontent.com/bbrian34/tackpath-app/main/stow.html
   #    (re-apply any local edits that fc showed in step 1)
   npx cap sync android
   cd android; .\gradlew assembleDebug
   adb install -r app\build\outputs\apk\debug\app-debug.apk
   ```
   On the TC56: open PathIQ → the new **PathIQ sign-in** screen → company + company code (once per
   device). Stow one test package to confirm.

   What is different in the APK copy (no edits to the file itself):
   - **Sign-in per device.** The app's storage is separate from tackpath.com, so each TC56 signs in
     once. Changing a company code (`tp_sec.admin_set_org_code`) signs every device out; sign in again.
     To sign a device out: Android Settings → Apps → PathIQ → Storage → Clear data.
   - **Scanner input during sign-in.** If DataWedge Keystroke output is on, a scan while the sign-in
     screen is open types into the field. Sign in before scanning. The page's ZebraScanner /
     FarsetScanner plugin hooks are unchanged.
   - **Network.** The page calls only the database API (`/rest/v1/rpc/tp_org…`) and the realtime
     broadcast, which accept the app's `https://localhost` origin; it calls no edge functions, so no
     CORS change is needed.
   - **IQ2 button.** It opens `iq2.html`, which is not in the APK (it was not before either); on the
     web it redirects to stow.html. Unchanged.
9. **Check every flow** with the anon key still open (checklist below), on the TC56 too.
10. **Migration 20 (lockdown)** — SQL Editor: paste `20_lockdown.sql`, Run.
11. **Check again**, plus confirm the anon key is closed:
    ```
    curl "https://hofijsiphyjpdvujjzfi.supabase.co/rest/v1/jobs?select=id&limit=1" -H "apikey: sb_publishable_…"
    ```
    must return a permission error, not rows.

Flow checklist: dispatcher sign-in, board, assign (driver gets the text), broadcast, cancel stop,
archive, Clear Board, drivers add/edit/approve/remove, SmartSort publish, fleet page; driver sign-in
(code arrives), offers, accept, start, stops, delivery scan gate, proof photo, deliver, messages,
Ruby, address lookup while navigating; PathIQ sign-in (web and TC56), bin open, stow, reset; Shopify
connect; portal sign-in; customer order → confirm; track.html
and tracking.html links; driver application → Approve → sign-in; dispatcher "View proof of delivery".

## Rollback

- **Something breaks after step 10:** SQL Editor → `20_lockdown.rollback.sql`. Restores exactly the
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
- `edge.test.mjs` (10): relay closed (`{to, body}` refused, nothing sent), only the fixed text to the
  assigned consenting driver of the caller's company, rate limits, driver-login, pod upload/view rules,
  Shopify webhook HMAC, CORS; the session guard (who passes, who gets 401, cron secret only where set)
  and that each of smooth-api, nav-proxy, smartsort, sponge, swarm-watch runs it before any work;
  Shopify OAuth: a store links only to the company that started it (forged, tampered, expired,
  other-store and unsigned callbacks refused).
- `pages.test.mjs` (10): the real pages in jsdom against that database — driver sign-in by texted code,
  dispatcher (incl. the Google proxy and Shopify connect carrying the session), PathIQ, portal,
  customer, track, tracking, fleet, signup — with **zero** direct table or storage requests.
- `tests/driver-login-ui.test.js` (2): no dead sign-in button is visible; driver.html shows the new symbol.

tackpath-driver: `cd tests && node --test` (33, including `security.test.js` and `login-ui.test.js`).

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
7. **Retired pages** lose database access at step 10 as agreed: owl, brain, crm, smartsort, de, zelurco,
   dispatcher-white(-preview), dispatcher-mobile, driver-app, fleet-cards, symphony(.trial), tackpathone,
   policy-engine(-recovery), index-white, guide.

## Still open (outside this change)

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
