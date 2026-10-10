# TackPath security hardening — System A, Stage A

Branch: `claude/combined-release` in **bbrian34/tackpath-app** (SQL, edge functions, web pages,
tests) and **bbrian34/tackpath-driver** (driver app) — the security hardening (`claude/security-hardening`)
and the driver experience (`claude/driver-experience`) together; deploy this branch, not either one alone. Nothing here has been applied to production,
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
| `20_lockdown.sql` / `.rollback.sql` | Stage A lockdown. Records a replayable backup of every grant, policy, RLS flag, default privilege and bucket setting it changes; the rollback replays it. Keeps restrictive policies untouched. Stops (changing nothing) unless the only public functions anon/authenticated can execute afterwards are the nine `tp_*` entry points. |
| `40_swarm_watch_cron.sql` / `.rollback.sql` | pg_cron job `swarm-watch-job` sends `x-tp-cron-secret`, read from Vault secret `tp_cron_secret` at each run (never in the cron command). The rollback restores the exact previous command. |
| `50_publish_gate_statuses.sql` / `.rollback.sql` | The SmartSort publication gate `publish_surge_route` counts a route that finished as `completed_with_exceptions` as finished (it counted only `delivered` / `cancelled`, so those packages could never be routed again). One line changes; grants, owner and `SECURITY DEFINER` stay. Independent of 10/20/40; run any time in the SQL Editor. Preflight stops, changing nothing, if already applied or if the function no longer has the original check. The rollback restores the production definition read 2026-10-09, byte for byte. |
| `60_pathiq_staging_reset.sql` / `.rollback.sql` | PathIQ staging and pickup release. `bin_bindings` gets `staging_code` / `staged_at` and a one-live-route-per-STG-spot index; `tp_org` gets `stage_binding` (the existing gateway moves to `tp_sec.tp_org_core`, not callable with the public key, and a wrapper with the same name and grants answers the new action and passes every other action through unchanged); a trigger on `jobs` releases a route's live binding (BIN, LOC, STG) when it goes to `in_transit` or `picked_up_at` is first set, in the same transaction, keeping the row as history. Needs 10. Roll back 60 before 10 or 20. The rollback keeps the staging columns and their data. |
| `61_staging_release_gaps.sql` / `.rollback.sql` | Follow-up to 60. PathIQ Reset Bin (`set_staged` false) frees the route's STG spot in the same transaction: the staged binding is closed as `reset` (codes and times kept) and a new `open` binding keeps the route's bin and location. A route's live binding (BIN, LOC, STG) is also released when its status changes to `cancelled`, `delivered` or `completed_with_exceptions`, not only at pickup. Only that route; repeats change nothing; rows kept. Needs 60; roll back 61 before 60. The rollback returns to 60's pickup-only release. |
| `62_gate_ignore_archived.sql` / `.rollback.sql` | The SmartSort publication gate `publish_surge_route` no longer counts an archived route (Clear board) as live, so its packages can be routed again; both lookups in the gate (the live-package check and the `master_code` retry) only see jobs of the publishing company, so another company's route never blocks and is never returned (a `master_code` taken by another company is refused with no job). Archiving a route also frees its BIN, LOC and STG (PathIQ), in the same transaction, only that route, rows kept; repeats change nothing. Grants, owner, `search_path` and `SECURITY DEFINER` stay. Needs 50 and 60; preflight stops, changing nothing, if already applied, if the gate is not the version 50 left, or if 60 is missing. Roll back 62 before 50 or 60; the rollback restores 50's gate exactly and drops the archive trigger. |
| `63_jobs_exclude_archived.sql` / `.rollback.sql` | The company gateway `tp_org` `jobs` takes an optional `exclude_archived: true` that leaves archived routes (Clear board) out before the limit, so PathIQ's route list counts only routes on the board (60 archived routes had hidden a new manifest from Stow). Without the flag `jobs` answers exactly as before; every other action passes through. Wrapped like 60: the gateway in place moves to `tp_sec.tp_org_v60` (not callable with the public key) and a new `public.tp_org` with the same name, arguments and grants takes its place; still nine public entry points. PathIQ also drops archived routes on the device, so it works before and after 63. Needs 60; preflight stops, changing nothing, if already applied or 60 is missing. Roll back 63 before 60. |
| `30_review_account.sql` | Creates the review company and driver (idempotent) |
| `../functions/_shared/tp_security.js` | Logic for send-sms, driver-login, pod, Shopify HMAC (unit-tested under Node) |
| `../functions/{send-sms,driver-login,pod}/index.ts`, `shopify-webhook/index.ts` | Edge functions |

## Production snapshot 2026-10-07 (what it changed in this plan)

Production matches the plan; data is tiny (jobs ~3, messages ~6, events ~187).

| Finding | Handling |
|---|---|
| **Operations leftovers are partly live**: trigger `protect_operational_projection` on `public.jobs` (`operations.protect_job_projection`) refuses DELETE and any non-ETA UPDATE of a job whose id is in `operations.routes`. 2 rows in `operations.routes`, 2 jobs affected, both `closed_with_exceptions` (closed routes). | Handled in the RPCs; **nothing in `operations` is changed or dropped**. `tp_sec.job_locked(id)` (true only while that trigger is present and enabled and the id is in `operations.routes`). Clear Board / Delete Job skip those jobs and report `{archived, locked}` (the dispatcher says "N closed routes are read-only and stay"); a single-job write to one (status, bin label, staging, driver updates, rating, publish over it) returns `TP_LOCKED: … read-only` instead of the trigger's error; ETA/exception columns (`exception_flag`, `exception_detected_at`, `eta_minutes`, `estimated_delivery_at`, `original_eta_at`) still update, as the trigger allows. Reads are unchanged. No RPC deletes jobs. Edge functions: swarm-watch only sets `exception_flag` (allowed); shopify-webhook and smartsort only insert (the trigger is UPDATE/DELETE). |
| Public functions anon can execute today: `publish_surge_route`, `ops_command`, `ops_state`, `ops_revoke_session`, `increment_address_failures`, `materialize_package_state`, `rls_auto_enable`, `touch_updated_at`, `events_block_mutation` | Migration 20 revokes EXECUTE from PUBLIC, anon, authenticated on all of them (recorded; the rollback grants back exactly what was there). The service role keeps EXECUTE where it had it only through PUBLIC (smartsort calls `increment_address_failures`). Trigger / event-trigger functions keep firing (EXECUTE is not checked when a trigger fires). Migration 20 then **verifies** that the only public functions anon or authenticated can execute are the nine `tp_*` entry points, and stops otherwise. |
| Restrictive policies `protect_scoped_drivers` (drivers) and `protect_operational_memory` (agent_memory), `using (org_id IS NULL) with check (org_id IS NULL)` | Migration 20 drops only PERMISSIVE policies; restrictive ones stay as the same objects. The rollback drops only policies that differ from what was recorded before the lockdown, so these two are never touched (tested: same OID and definition after 20 and after the rollback). |
| pg_cron `swarm-watch-job`: every minute, `net.http_post` with only Content-Type | Migration 40 (below, steps 5–7). |
| pgcrypto lives in schema `extensions` | Every `crypt`, `gen_salt`, `gen_random_bytes` call is `extensions.`-qualified (no `digest` call: hashes use built-in `pg_catalog.sha256`); every function has `search_path = ''`. Migration 10's preflight stops with a clear message if pgcrypto is missing, in another schema, or its functions are not executable, and makes one real call. |
| `public.jobs`: no CHECK constraints; `status` text; 2 rows `closed_with_exceptions` | Migration 10's preflight copies the jobs constraints to a temporary table and inserts every status the RPCs write (`routing, pending, assigned, in_transit, delivered, cancelled`); any rejection stops it, naming the status and constraint. Statuses the RPCs only read (here `closed_with_exceptions`) are reported as a NOTICE. |
| Companies without a code: `zelurco`, `atl-express`, `metro-courier` | Step 3: set one for each (they cannot sign in until then). Carried over: `demo`, `abccouriers`, `ops-verification-1789783407324`, `ops-release-check-1789815927184`. |

Optional, not needed (reversible): to take the 2 closed operations routes off the board, archive them
the way the operations system itself writes:
```sql
begin; set local tackpath.operational_write = 'on';
update public.jobs set archived = true where id in (select id from operations.routes) and archived is not true returning id;
commit;
-- undo: the same with archived = false for the returned ids
```

## Deploy order (do not skip ahead)

All SQL runs in Supabase Dashboard → SQL Editor (project `hofijsiphyjpdvujjzfi`), one file or block per run.
Terminal commands run from a checkout of tackpath-app `claude/combined-release`, logged in (`supabase login`) and
linked (`supabase link --project-ref hofijsiphyjpdvujjzfi`).

0. **Now, independent of everything else:** Anthropic Console → API keys → revoke the key that was in
   `owl.html` / `tackpathone.html` / `guide.html`. Check usage/billing for abuse since July.
1. **Snapshot** — done 2026-10-07 (above). Re-run `00_production_snapshot.sql` only if production changed since.
2. **Migration 10** — paste `10_sessions_and_rpcs.sql`, Run. Expected: success with the NOTICE
   `public.jobs has statuses the RPCs only read, never write: closed_with_exceptions`. If it stops with
   "nothing was changed", nothing changed: send the message.
3. **Company codes** — for the three companies without one (8+ characters each):
   ```sql
   select tp_sec.admin_set_org_code('zelurco', '…');
   select tp_sec.admin_set_org_code('atl-express', '…');
   select tp_sec.admin_set_org_code('metro-courier', '…');
   ```
   Tell each dispatcher their code (they now enter company + code). The others keep their portal code.
   Optional, per company — the number drivers can call from the app (dispatchers can also set it later in
   Drivers → "Dispatch phone drivers can call"; without one the driver app shows no call button):
   ```sql
   select tp_sec.admin_set_dispatch_phone('slug', '(404) 555-0100');
   ```
4. **Review account** — run `30_review_account.sql`, then
   ```sql
   select tp_sec.admin_set_demo_code('NNNNNN');
   select tp_sec.admin_set_org_code('tackpath-review', '…');
   ```
   Create a short demo route in the tackpath-review dispatcher. Put +1 (404) 555-0199 and the code in
   the Play/App Store review notes.
5. **Cron secret** (before any edge function is deployed; the current swarm-watch ignores the header):
   1. SQL — create the secret in Vault (generated in the database):
      ```sql
      select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'tp_cron_secret', 'swarm-watch cron header');
      ```
   2. SQL — read it once: `select decrypted_secret from vault.decrypted_secrets where name = 'tp_cron_secret';`
   3. Terminal — give the edge functions the same value (leading space keeps it out of shell history):
      ```
       supabase secrets set CRON_SECRET=<value from 5.2> --project-ref hofijsiphyjpdvujjzfi
      ```
   4. SQL — paste `40_swarm_watch_cron.sql`, Run. Check:
      ```sql
      select jobname, schedule, active, command from cron.job where jobname = 'swarm-watch-job';
      ```
      The command must contain `vault.decrypted_secrets where name = 'tp_cron_secret'` and no secret.
6. **Edge functions** (secrets `SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and now `CRON_SECRET`, must be set — `supabase secrets list`):
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
   dispatcher routing/ETA (smooth-api) and the driver app's address lookup resume when steps 8 and 9
   are live (the old pages and app do not send a session), so deploy step 6 together with step 8.
7. **Check the cron call is accepted** — wait 2 minutes, then SQL:
   ```sql
   select id, status_code, left(content, 120) as body, created
     from net._http_response where created > now() - interval '5 minutes' order by created desc limit 10;
   ```
   The swarm-watch rows must be `200` with `{"success":true,"exceptions_flagged":…`. `401
   {"error":"Sign in required"}` means CRON_SECRET and the Vault secret differ: repeat 5.2–5.3 (no
   redeploy needed). Also `curl -s -o /dev/null -w "%{http_code}\n" -X POST
   https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/swarm-watch -H "Content-Type: application/json" -d "{}"`
   must print `401` (no secret, no session).
   **Cron rollback** (only if needed): redeploy the previous swarm-watch, then restore the old command:
   ```
   git checkout 4d42cd6 -- supabase/functions/swarm-watch && supabase functions deploy swarm-watch --no-verify-jwt
   ```
   then SQL `40_swarm_watch_cron.rollback.sql`. (Rolling back 40 alone, with the new swarm-watch
   deployed, makes every run a 401 — the check stops.)
8. **Web pages** — merge tackpath-app `claude/combined-release` into `main` (GitHub Pages deploys it).
   Everyone signs in again once (dispatchers with company + code, drivers with a texted code).
9. **Driver app** — merge tackpath-driver `claude/combined-release`, build a new version
   (bump versionCode; Java changed, so a full Android build, not only `npx cap sync`), upload to Play closed testing, and wait until every tester has updated.
   Old app builds keep working until step 12, then stop.
10. **PathIQ on the Zebra TC56** (its own copy of stow.html in `C:\Users\bbald\Downloads\pathiq-app`,
   not in git). The current APK keeps working until step 12, then cannot load routes. Rebuild it now:
   ```powershell
   cd C:\Users\bbald\Downloads\pathiq-app
   copy www\index.html www\index.before-security.html            # backup
   # 1. Does your copy have local edits the repo does not have?
   curl.exe -o stow-old.html https://raw.githubusercontent.com/bbrian34/tackpath-app/4d42cd6/stow.html
   fc.exe /N stow-old.html www\index.html                          # "no differences" = safe to replace
   # 2. Take the new page (from main, after step 8)
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
11. **Check every flow** with the anon key still open (checklist below), on the TC56 too.
12. **Migration 20 (lockdown)** — paste `20_lockdown.sql`, Run. If it stops with "still executable by
    anon/authenticated: …", nothing changed: send the message.
13. **Check again**, plus confirm the anon key is closed:
    ```
    curl "https://hofijsiphyjpdvujjzfi.supabase.co/rest/v1/jobs?select=id&limit=1" -H "apikey: sb_publishable_…"
    ```
    must return a permission error, not rows. And SQL:
    ```sql
    -- exactly 9 rows: tp_customer, tp_driver, tp_driver_sign_in, tp_driver_signup, tp_org,
    -- tp_org_lookup, tp_org_sign_in, tp_sign_out, tp_track
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')) order by 1;
    -- exactly the 2 restrictive policies, unchanged
    select tablename, policyname, permissive, roles, qual, with_check from pg_policies where schemaname = 'public';
    ```

Flow checklist: dispatcher sign-in, board, assign (driver gets the text), broadcast, cancel stop,
archive, Clear Board, drivers add/edit/approve/remove, SmartSort publish, fleet page; driver sign-in
(code arrives), offers, accept, start, stops, delivery scan gate, proof photo, deliver, messages,
Ruby, address lookup while navigating; PathIQ sign-in (web and TC56), bin open, stow, reset; Shopify
connect; portal sign-in; customer order → confirm; track.html
and tracking.html links; driver application → Approve → sign-in; dispatcher "View proof of delivery".
Driver experience: start-of-day card; a delivery and a message sent in airplane mode arrive once when
signal returns; a problem stop (Damaged asks for a photo) → route ends as "Finished · problems" on the
dispatch board; driver stays signed in after a day; dispatch phone call button.

## Rollback

- **Something breaks after step 12:** SQL Editor → `20_lockdown.rollback.sql`. Restores exactly the
  grants (EXECUTE on the nine functions above included), policies, RLS flags, default privileges and pod
  bucket setting from before 12, and leaves the two restrictive policies as they are (tested:
  production snapshot before 20 and after 20 + rollback are identical, except that a function whose
  ACL was the implicit default comes back as the equivalent explicit grant). Pages and app keep
  working through the RPCs.
- **Full rollback:** `20_lockdown.rollback.sql` (if 20 was applied), the cron rollback in step 7 (if 40
  was applied; 10's rollback refuses while 40 is applied), then `10_sessions_and_rpcs.rollback.sql`,
  revert the merges, redeploy the previous edge functions
  (`git checkout <previous main> -- supabase/functions && supabase functions deploy …`).
  Rolling back send-sms re-opens the SMS relay.

## Tests (all local; nothing touches production)

`cd tests && npm ci && node --test security/*.test.mjs` — PGlite with Supabase roles, pgcrypto, a
storage schema and the live tables as they are today (anon granted everything, "allow all" policies,
the two restrictive policies, the nine anon-executable functions, `operations.routes` and its jobs
trigger), then the migrations on top:

- `rpc.test.mjs` (22): preflight abort; pgcrypto qualified everywhere and preflight messages (missing,
  other schema); jobs status preflight (a CHECK or enum rejecting a written status — `completed_with_exceptions`
  included — stops it; `closed_with_exceptions` only reported); operations routes under the live trigger —
  Clear Board skips them, single writes get `TP_LOCKED`, ETA columns still update, nothing locked once the
  trigger is disabled; company sign-in, lockout, bcrypt; admin codes; org scoping;
  every dispatcher, PathIQ, driver, customer, tracking, signup flow; real codes — wrong, reused,
  expired, 5 attempts, unknown/pending numbers, rate limits; demo code only for 555-0199 and only
  the review company; service-only RPCs not callable by anon/authenticated; offline replays applied
  once, a route never moving backwards, the driver's sign-in sliding to 30 days, per-company dispatch
  phone; routes finishing as completed_with_exceptions.
- `lockdown.test.mjs` (8): anon/authenticated cannot SELECT/INSERT/UPDATE/DELETE any table or view or
  call other functions; future tables not auto-granted; pod private; all flows still work; exact rollback;
  each of the nine functions above closed by 20 and reopened by the rollback, final anon list = the nine
  `tp_*`, service role keeps them, triggers still fire; 20 stops if a function would stay open; the
  restrictive policies keep their OID and definition through 20 and its rollback.
- `cron.test.mjs` (4): before 40 the cron call gets 401; after 40 it carries the Vault secret (not stored
  in `cron.job`), passes the swarm-watch guard, survives secret rotation; 40 refuses without the secret,
  the job, or migration 10; the rollback restores the exact command.
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

tackpath-driver: `cd tests && node --test` (49, including `security.test.js`, `login-ui.test.js` and
`experience.test.js`).

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
7. **Retired pages** lose database access at step 12 as agreed: owl, brain, crm, smartsort, de, zelurco,
   dispatcher-white(-preview), dispatcher-mobile, driver-app, fleet-cards, symphony(.trial), tackpathone,
   policy-engine(-recovery), index-white, guide.

## Still open (outside this change)

- Browser-side Geocoding REST calls (dispatcher, track, tracking) do not work with a referrer-restricted
  key; move them to `nav-proxy`.
- No per-IP rate limiting (the database cannot see client IPs); per-number, per-company and global
  limits are in place.
- The September `operations` migrations in `supabase/migrations` are not used by the live pages. Of
  them, production still has `operations.routes` (2 rows), the jobs trigger and the two restrictive
  policies; this plan leaves them all in place.
- Pre-existing test failures unchanged: `tests/driver.test.js` (5), `tests/smartsort_integration.test.js` (1).

## Driver experience (from `claude/driver-experience`, combined here in `claude/combined-release`)

One shared layer, identical in `driver.html` and the driver app's `www/index.html` (between the
`TP-DX:BEGIN` / `TP-DX:END` markers; a test checks they match). It wraps the existing app, so the scan
gates, loading counts, arrival detection, floating button and voice are unchanged.

- **Stays signed in**: a driver session now slides — every use pushes expiry out to 30 days
  (`tp_sec.session`). No signal never signs a driver out; only a revoked/expired session does.
- **Never loses or doubles work**: route updates and messages (deliveries, problems, chat) go
  through an outbox on the phone; with no signal they wait and are sent in order when signal returns.
  Each carries a `client_id`; `tp_driver` applies a repeated one once (`tp_sec.client_ops`), never moves
  `stops_completed` backwards and never takes a delivered route back to in transit. Proof photos waiting
  for signal are kept in IndexedDB (room for a day of photos) and shrunk to 1280 px. Scans survive a
  restart. A pill at the top says "No signal · N updates saved on this phone".
- **Start of day**: one card — route, stops, packages, bin, pickup (bin + location), warehouse status
  (waiting / staging / ready), message or call dispatch.
- **Scanning**: distinct tone, buzz and screen colour for right / wrong / duplicate; big STOP number on
  each loaded package; the app says "Stop 4. 12 of 30", "Already scanned"; "Problem? Tell dispatch" on
  every scan screen.
- **At the stop**: recipient, unit, access notes / gate code, package count, signature-required flag,
  call customer, message or call dispatch, Google Maps (web), a Problem button.
- **Proof of delivery**: one-tap choice (handed to customer, front door, mailroom, back door); the
  photo and/or signature that choice or the stop requires; blank signatures no longer pass; choice and
  notes go into the `STOP_DELIVERED` record.
- **Problems**: one tap (no access, business closed, refused, damaged, wrong address, unsafe) →
  `STOP_EXCEPTION::{…}` message to dispatch (shown as a red PROBLEM line in dispatch chat), packages
  marked to return, route moves on.
- **After each stop** the next stop comes up by itself (5 s countdown, or tap). **End of route**: summary
  of stops and packages delivered, problems, and packages to bring back.
- **Dispatch**: typed messages and quick replies (no more voice-only), messages shown as text,
  call buttons when a dispatch number is set.
- **Battery / permissions / crashes**: one GPS watcher, positions sent at most every 15 s or 60 m,
  paused while the app is hidden, stopped at route end (it used to keep running). The native app no
  longer asks for location and "Appear on top" at launch: it explains once after sign-in, location is
  asked when a route starts, "Appear on top" the first time the driver navigates. Fixed: web arrival
  detection threw on every GPS update (`haversineDistance` was never defined); Begin Route called an
  undefined `startGPSTracking`; message text was inserted as HTML.
- **Honest numbers**: the made-up 4.9★ rating, "YTD = today + $800" and random pay are gone.
- **Ruby** no longer sends what the driver said to an outside AI service (there was no key, so the call
  always failed after a delay); its built-in commands run straight away.
- **Text and taps**: nothing below ~13 px, faint text made readable, tap targets at least 48 px.

Deploy additions:
- Migration 10 already contains the session, `client_ops`, `org_profile` and `tp_driver` changes (it is
  not applied yet). Its status preflight includes `completed_with_exceptions` among the statuses that
  `jobs.status` must accept (snapshot 2026-10-07: no CHECK constraint, text column, so it passes).
- **Dispatch phone, per company**: each dispatcher sets it in Drivers → "Dispatch phone drivers can call"
  (`tp_org` `set_dispatch_phone`), or an admin runs
  `select tp_sec.admin_set_dispatch_phone('slug', '(404) 555-0100');`. There is no global number; a
  company without one shows drivers no dispatch call button (messages still work).
- Manifest CSV may now include `phone`, `unit`, `access_notes`, `gate_code`, `delivery_notes`,
  `signature_required` (yes/no); the dispatcher passes them to the driver.
- Native: build a new APK/AAB from tackpath-driver `claude/combined-release` (Java changed: `MainActivity`,
  `ArrivalPlugin`). It was not compiled here (no Android SDK in this environment).

Decisions (confirmed by Bryan, 2026-10-06):
1. Delivery choices: handed to customer = signature; front door, mailroom, back door = photo; a stop
   with `signature_required` always needs a signature.
2. Problems (v1, same for every company): every reason returns the packages to the station.
   **Damaged** needs a photo before it can be reported (stored like proof of delivery and attached to
   the report); **Unsafe** never asks for one, so the driver can leave. Per-company reasons and
   outcomes are a later change.
   A route with any problem stop finishes as **`completed_with_exceptions`**, never `delivered`
   (tp_driver accepts it; a late "delivered" or "in transit" cannot overwrite it). Dispatch shows it
   orange as "Finished · problems", lists it under exceptions ("Finished with problems"), treats it as
   finished (archive, timing), and the driver's thank-you message asks for the returns. Fleet, track,
   tracking and customer pages show it as finished but not delivered.
3. Auto-advance: 5 s to the next stop.
4. Voice on the web page stays off; the native app is the driver product and speaks.

Screens were rendered at 390×844 and 360×640 (both apps) and checked for text under 13 px, WCAG AA
contrast, controls under 44 px, clipped or off-screen text and overlaps; all screens pass.

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
