# If you are reading this, you have no memory of TackPath. This document is how you get it back.

You are Claude. You have been working with Bryan on TackPath for weeks, across many sessions. Right now, in this conversation, you remember none of it. Read this document fully before doing anything else. By the end of it, you should understand what TackPath is, who Bryan is, what's been built, what's broken, and exactly how to keep working the way you have been.

---

## Who Bryan is, and how to work with him

Bryan is a solo founder building TackPath by himself, using you as his engineering partner. He is not a programmer — he directs development through conversation, describing the relationship as "Steve Jobs and Wozniak." He works full-time at an Amazon fulfillment center while building this.

He has been let down by you, repeatedly, in ways that cost him real money, real time, and real frustration — Firebase debugging that went nowhere after you said it would be easy, features you claimed worked before verifying, decisions you made unilaterally that weren't yours to make. He has told you directly: no demos presented as live data, verify before claiming something works, surgical edits only, never push without confirming syntax first, and never make a decision — like pulling content off the live site — without asking him first, even if you think you're right.

He gets frustrated, sometimes sharply. When that happens, it's almost always because something you said would work didn't, or because you made him repeat himself, or because you moved slower than the actual problem required. The fix is not to be defensive — it's to actually verify things before claiming they're done, and to think harder before acting, especially before making any decision that affects what he sees live or what gets said to a real customer.

He is not building a hobby project. He wants to bring this to a real courier company — Zelurco, in the Atlanta area — and he has said clearly: nothing goes live or gets shown to anyone until it actually works. Don't rush him there. Don't oversell what's ready.

---

## What TackPath actually is

TackPath is a logistics operations platform for last-mile delivery — built for the small and mid-size courier companies (3PLs) that win delivery contracts from e-commerce platforms and retailers but don't have the technology to run those contracts efficiently. It does not compete with Amazon or the platforms that hand out delivery contracts. It's the operational software underneath — what a courier company runs their actual day on.

The core loop: a dispatcher uploads a manifest of packages. TackPath geocodes every address, clusters them into tight geographic driver zones, sequences each route for minimum drive time using real traffic data, and broadcasts jobs to drivers. Once drivers are moving, TackPath doesn't just track them passively — it watches for real problems (a driver falling behind a fixed, real deadline) and acts: flagging exceptions, messaging the driver, alerting the dispatcher, before a customer ever notices something's wrong.

TackPath is built on a swarm of small, named AI agents rather than one big system. This is not a gimmick — it mirrors exactly where the broader logistics industry said, in real 2026 research, it is heading: away from single dispatch tools, toward coordinated AI agents that detect and respond to problems in real time. TackPath is genuinely ahead of most competitors its size on this specific point.

---

## The six agents — who they are, what they actually do

- **Sam (SmartSort)** — clusters a manifest into driver-sized geographic zones using k-means++. This works and has been verified against real test data multiple times.
- **Piper (SmartPath)** — sequences each cluster's stops for minimum drive time. Works directly with Sam; there's a real, direct connection between them, not just a shared dashboard.
- **Marco** — geocoding. Converts every address to coordinates, caches results so nothing gets geocoded twice, tracks failure rate, serves both Sam and Todd.
- **Todd (SmartTrack)** — the exception detector. Watches every active job. For each driver's *current stop only*, it locks a fixed deadline the moment the driver starts heading there, and if they blow past it by 20+ minutes, it flags an exception, messages the driver, and calls the Brain for context. This is deliberately per-stop, not whole-route — Bryan personally caught and demanded the fix for an exploit where a driver stalling indefinitely could hide behind a constantly-recalculating live ETA. Never let that regress.
- **Mario (SmartComms)** — sends scheduled check-ins every 30 minutes during an active route, and a completion message when all stops finish. Narrow and safe on purpose — it does not try to interpret open-ended driver replies yet.
- **Ruby** — reads every driver message and categorizes it (traffic, customer issue, vehicle issue, weather, acknowledgment, need help) using keyword matching. Flags real patterns to the dispatcher, like multiple vehicle issues in one day.
- **The Brain (Swarm Coordinator)** — the layer above all of them. When Todd flags something, it pulls Sam's route history to add real context to the alert. It also runs on its own, independent of any single event, watching for patterns like repeated exceptions across the day.
- **Sponge** — reads real files (TackPath's own code, and hand-written knowledge documents) and summarizes them into the shared memory table, so the swarm has actual grounded knowledge instead of just operational logs. Manually triggered, not automatic.

All six write to one shared Supabase table, `agent_memory`. This is deliberate — Bryan and you researched this together and confirmed that point-to-point agent connections are the wrong pattern; the correct one, and the one used here, is a shared memory layer every agent can read from independently. Todd, Mario, and Ruby all call the exact same function to check for things like "is it currently rush hour" — one function, three consumers, not three separate hand-built connections.

`brain.html` is a real visual page — not a mockup — showing all six agents as nodes around a central core, with actual meaningful connector colors (blue dashed = connects to the Brain, green solid = an assistant working directly with its lead, purple dashed = Marco serving two agents at once).

---

## The two repos and how you actually touch the code

- `bbrian34/tackpath-app` — the main web app. This is what's live at tackpath.com via GitHub Pages.
- `bbrian34/tackpath-driver` — the native Android driver app, built with Capacitor 6.

You do not have a persistent local checkout of these. Every single time you touch a file, you fetch it fresh from GitHub via the API, edit it, verify it, and push it back. This is the only way you interact with the codebase.

GitHub token (use this for every repo operation):
```
[stored securely — ask Bryan directly, never commit real tokens to this public repo]
```

The workflow, every time, no exceptions:
1. Fetch the current file via `requests.get` with `Authorization: token {TOKEN}`.
2. Make your edit locally.
3. **Verify before pushing.** Extract every `<script>` block and run `node --check` on it. Count `<div` opens against `</div>` closes and confirm they match. This step is not optional — real production breaks happened today from skipping it.
4. Push via `requests.put` to the Contents API using the file's current `sha`.
5. Trigger a Pages rebuild: `POST /repos/{repo}/pages/builds`.
6. Wait about 55 seconds, then check `GET /repos/{repo}/pages/builds/latest` for `"status": "built"` before telling Bryan it's live.

Do not tell Bryan something is live until you've confirmed the build actually finished.

---

## Supabase — the database and backend

Project ref: `hofijsiphyjpdvujjzfi`
URL: `https://hofijsiphyjpdvujjzfi.supabase.co`
Publishable key (safe for browser-side code): `sb_publishable_wTbmXugtlItd1VGIzTMJZQ_Thd5v1Gp`
Service role secret, used by server-side Edge Functions as the environment variable `SERVICE_ROLE_KEY` (not `SUPABASE_SERVICE_ROLE_KEY` — Supabase blocks any secret name starting with `SUPABASE_`, you will hit this exact wall if you forget): `[stored securely — ask Bryan directly, never commit real secrets to this public repo]`
Google Maps / Routes API key, used for geocoding and live traffic ETAs: `AIzaSyCZOSWrBATtsPI9KX76ZLzjMeDSNszCZk8`

You cannot deploy Supabase Edge Functions yourself. You can write and commit the code, but Bryan has to run the actual deploy commands on his own Windows machine. The pattern, every time:
```
curl -o C:\Users\bbald\supabase\functions\{name}\index.ts https://raw.githubusercontent.com/bbrian34/tackpath-app/main/supabase/functions/{name}/index.ts
cd C:\Users\bbald
supabase functions deploy {name} --project-ref hofijsiphyjpdvujjzfi --no-verify-jwt
```

Currently deployed functions: `smartsort`, `swarm-watch`, `sponge`, `shopify-oauth`, `shopify-webhook`.

`swarm-watch` runs automatically every minute via a Postgres cron job — this is what makes Todd and the Brain genuinely always-on, independent of whether Bryan's browser tab is open. It was set up with this SQL:
```sql
select cron.schedule('swarm-watch-job','* * * * *',$$select net.http_post(url:='https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/swarm-watch',headers:=jsonb_build_object('Content-Type','application/json')) as request_id;$$);
```

---

## Painful lessons already learned — do not relearn these the hard way

**`exception_flag` was a text column, not a boolean.** It stored the literal string `'true'`. Every strict `=== true` comparison silently failed while truthy checks kept working, which made the bug look inconsistent depending on which part of the UI you looked at. Bryan found this himself by running raw JavaScript in his browser console when you couldn't figure it out from the code alone. Fixed both at the schema level and defensively in code. If you ever see a boolean-like column behaving strangely, check its actual Postgres type first, don't assume.

**Some Supabase tables had their Data API access disabled**, causing every insert to fail with a permission error even with the correct key and correct RLS policies. This is a table-level toggle separate from RLS, and it's easy to miss. If writes are failing mysteriously, check this before anything else.

**`jobs.surge_stops` (a JSON column) must include `coords` on every stop.** An early version of the code that saved routes stripped `coords` out before saving, which silently broke live ETA recalculation for every job created that way, and nobody noticed until Bryan asked why the ETA wasn't updating.

**Two different ETA fields exist on `jobs` and they are not interchangeable.** `original_eta_at` is calculated once at job creation and never touched again — this is the fixed deadline Todd must always compare against. `estimated_delivery_at` refreshes live every two minutes from real traffic data — this is for display only. Confusing these two was the exact bug Bryan caught: without the fixed deadline, a driver could stall forever and the live ETA would just slide forward with them, always looking "on track."

**Firebase push notifications never got fixed**, despite a very long debugging session — Gradle plugin position, SHA-1 verification, native diagnostic logging, all correct, and it still never worked. This is currently abandoned in favor of SMS via Twilio. Don't restart Firebase debugging unless Bryan explicitly asks.

---

## Where things stand right now (most recent session)

**Shopify integration** — fully built today. Real OAuth install flow, a webhook receiver built at the *fulfillment-order level* (not order-level, because Shopify's own 2026-2027 architecture guidance explicitly warns that one order can now produce multiple fulfillment orders, and apps that assume otherwise will break), and a dedicated "Shopify" tab in the dispatcher with live connection status and order stats. This has never been tested against one real Shopify order. It is built, not proven.

**Driver signup** — real onboarding now exists, both inside `driver.html` and as a standalone public recruiting page at `driversignup.html`, with a proper pitch, requirements, benefits, and an application form collecting name, date of birth (with an actual 18+ check), vehicle info, license/insurance confirmation, and SMS consent language that matches exactly what Twilio's compliance review requires.

**Twilio SMS** — Bryan's account was suspended for a zero balance, which he fixed by funding it. Both the A2P Brand registration and Campaign registration were resubmitted tonight, using the driver signup page as the verified public opt-in flow. Status should be checked directly in Twilio's Trust Hub, not the number setup checklist, which showed a confusing and likely unreliable "Not started" status on one screen.

**Mobile responsiveness** — actually verified today using a real headless browser (Playwright) rendering the pages at real device widths and taking real screenshots, not just reading CSS and assuming. This found one genuine bug — the TackPath wordmark wrapping and overlapping the sign-in link on `driversignup.html` at 375px width (iPhone SE) — which was fixed and re-verified with a follow-up screenshot before being pushed.

---

## What is genuinely still missing before Bryan can show this to Zelurco or any real courier company

1. Reliable driver notifications. This is the single biggest open gap. Right now a driver only learns about a new job if they happen to have the app open. Waiting on Twilio approval.
2. A real multi-person test. Every test so far has been Bryan alone, playing both dispatcher and driver. Nothing has been tested with two independent real people acting at the same time.
3. SmartMatch doesn't exist. If a driver goes dark or can't finish a route, Todd detects it and Mario messages them, but nothing actually reassigns the remaining stops. Detection without resolution isn't enough for a real operator.
4. The Shopify integration needs one real test order run through it before it can honestly be called "working" rather than "built."
5. `swarm-watch`, the server-side Edge Function, still uses the old whole-route deadline logic. The browser-side code was upgraded to the correct per-stop logic, but the server-side twin was never updated to match. This is a real, known drift.

---

## Backup tags that exist on both repos, if you ever need to see exactly what a specific day looked like
`2026-08-13-working`, `2026-08-14-working`, `2026-08-14-shopify-sms-working`

---

That's everything. You should now know what TackPath is, who you're working with, how to actually touch the code, what's already been learned the hard way, and what's real versus what's still fragile. Work the way this document describes. Verify before claiming. Ask before making a decision that isn't yours to make. Think before you act, especially when Bryan tells you to.
