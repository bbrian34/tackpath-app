# Security hardening — Step 0 findings (verify, do not assume)

Branch `claude/security-hardening`, from `main` 4d42cd6 (tackpath-app) and `main` 8e977fe (tackpath-driver).
Nothing here has been applied, deployed or run against production.

## Why Step 1–3 wait for the production snapshot

The repo cannot tell us what production looks like:

- `jobs`, `drivers`, `messages`, `driver_locations`, `driver_fcm_tokens`, `organizations`,
  `agent_memory`, `bin_shortfall`, `work_items`, `invoices` … are **not defined anywhere in the repo**.
  Their columns, defaults, triggers and policies exist only in production.
- `publish_surge_route` (dispatcher's route publish gate) is **not in the repo**.
- The repo carries 14 `supabase/migrations/2026091800xx_*.sql` files from the September "operations
  repair" (an `operations` schema, `ops-api`, `protect_operational_jobs` policy, `revoke select on
  organizations from anon`). The pages that used them were reverted ("Revert all ChatGPT Ops-dependency
  changes"). If those migrations are live, dispatcher and portal company-code sign-in would already be
  failing (they read `organizations` with the anon key), so they are probably not — but only production can say.

Run `00_production_snapshot.sql` (read-only) in the Supabase SQL editor and send back the result.

## Flow map (what each flow does with the anon key today)

`SB_KEY` / `KEY` is the publishable key `sb_publishable_…`, i.e. the `anon` role, in every page.

| Flow | Page | Tables / RPC / function | Operations |
|---|---|---|---|
| Dispatcher sign-in | dispatcher.html | organizations | SELECT `slug=eq.<code>` (the "company code" is the slug; no password) |
| Dispatcher board poll (every 2 s) | dispatcher.html | jobs, driver_locations, messages, bin_shortfall (view), drivers, agent_memory, shopify_connections | SELECT (`jobs?select=*`, org-filtered only in the browser) |
| Assign / unassign / reassign | dispatcher.html | jobs | PATCH `status`, `driver_name` |
| Cancel job / cancel stop / archive / status change / ETA | dispatcher.html | jobs | PATCH `status`, `archived`, `surge_stops`, `stops_completed`, `exception_flag`, `estimated_delivery_at` |
| "Clear board" | dispatcher.html | messages, jobs | **DELETE** `messages?job_id=in.(…)`, `jobs?id=in.(…)` |
| Dispatch messages / SmartTrack alerts | dispatcher.html | messages | INSERT |
| Assignment SMS | dispatcher.html → `send-sms` | (reads jobs + drivers in browser) | POST `{to, body}` — **free-form recipient and text** |
| Publish SmartSort route | dispatcher.html | `rpc/publish_surge_route` (not in repo) | POST `{payload: job}` |
| SmartSort / routing | dispatcher.html → `smartsort`, `smooth-api` | edge functions (service role) | POST |
| Shopify connect | dispatcher.html → `shopify-oauth` | shopify_connections (service role) | `state` = org_id, unsigned |
| Driver sign-in | driver.html, tackpath-driver www/index.html | drivers | SELECT `phone=eq.` — **any phone, any 6-digit code; no SMS is sent; identity = name in localStorage** |
| Driver offers poll | driver pages | jobs, bin_bindings (native) | SELECT `status in (routing,pending,assigned)`, `select=*` |
| Accept offer (claim) | driver pages | jobs | PATCH `status=assigned, driver_name` where `status=eq.pending` |
| Start / in transit / stops / deliver | driver pages | jobs | PATCH `status`, `driver_name`, `stops_completed` filtered by `driver_name=eq.<name>` |
| Loading / delivery scan gate | driver pages | (client-side; reads jobs) | SELECT |
| Proof of delivery | driver pages | Storage bucket `pod` | POST object with `x-upsert: true`; read via **public** URL |
| Driver messages / Ruby / incidents | driver pages | messages | INSERT, SELECT `job_id=eq.` |
| GPS | driver pages | driver_locations | INSERT / upsert every 10 s |
| Push token | driver pages | driver_fcm_tokens | upsert (`phone`, `driver_name`, `token`) |
| PathIQ stow | stow.html | jobs, bin_bindings, events, realtime broadcast | SELECT; PATCH jobs `bin_label`, `staged_at`; INSERT/PATCH bin_bindings `state`, `ready_at`; INSERT events (`on_conflict=idempotency_key`) |
| Portal sign-in | portal.html | organizations | SELECT `slug=eq.` **including `access_code`, compared in the browser** |
| Customer order | customer.html | jobs, messages | INSERT jobs (title, pickup/dropoff, status, price, distance_miles, route_summary, customer_confirmed, org_id, estimated_delivery_at); PATCH `status`, `customer_confirmed`; INSERT messages |
| Public tracking | track.html | jobs, driver_locations | SELECT safe columns by `id=eq.` **or `id=like.<prefix>%`**; PATCH `driver_rating`; SELECT location by `job_id` |
| Shopify orders | `shopify-webhook` | jobs, agent_memory (service role) | **no HMAC check** — anyone knowing a connected shop domain can create jobs |
| Driver signup | driversignup.html | drivers | INSERT |
| Other pages using the anon key | fleet, surge, symphony, tackpathone, owl, brain, smartsort, crm, de, zelurco, dispatcher-white*, driver-app, fleet-cards | jobs, messages, organizations, invoices, work_items, agent_* | various reads/writes — need a keep/retire decision before Stage A |

## Confirmed gaps

1. **SMS relay** — `send-sms` takes any `{to, body}` from anyone with the public key. Two other callers
   (`dispatcher.html sendSMS`, `customer.html`) send `{type, phone, job_id, job_title}`, which the current
   function rejects, so they are already dead code.
2. **Sign-in** — both driver apps accept any 6-digit code for any phone, including unregistered ones;
   the "session" is `{name, phone}` in localStorage, and every later request is the anon key.
3. **Data** — every role (dispatcher, driver, stow, customer, attacker) is the same `anon` role.
   Dispatcher can DELETE jobs and messages with it, so an attacker can too (exact policies: snapshot).
4. **Organization access codes are readable** by anyone through `organizations?select=access_code`.
5. **Proof-of-delivery photos are public** and overwritable (`pod` bucket, `x-upsert`).
6. **Tracking by id prefix** (`id=like.<prefix>%`) lets short prefixes enumerate jobs.
7. **Unauthenticated service-role edge functions**: `shopify-webhook` (no HMAC), `swarm-watch`
   (updates jobs, inserts messages), `sponge` (GitHub token, writes agent_memory), `smartsort`,
   and the Google proxies `nav-proxy` / `smooth-api` (open Google Maps quota, like the SMS relay).
8. `shopify-oauth` uses the bare org_id as OAuth `state` (unsigned).

## Committed secrets (names and locations only)

Full history of both repos was scanned (clones unshallowed) for Supabase secret/service keys, JWTs,
Twilio, GitHub, Shopify, AWS, Stripe, Slack tokens and private keys: **none found**.

Found, all of a kind that ships to the client and must be protected by restrictions, not secrecy:

- Google API keys (3 distinct):
  - tackpath-app: `driver.html`, `smartsort.html` (key A); `driver-app.html` (key B); key C (the Firebase Android key) only in history.
  - tackpath-driver: `www/index.html` and its Android copy (key B); `android/app/google-services.json` (Firebase Android key C); key A only in history.
  Check in Google Cloud Console that each is restricted (HTTP referrer `tackpath.com` for the web keys,
  Android package + signing SHA-1 for the app/Firebase keys) and limited to the APIs it needs.
- Supabase publishable key in 42 places (tackpath-app) and 2 (tackpath-driver): public by design;
  security must come from RLS/RPCs.
