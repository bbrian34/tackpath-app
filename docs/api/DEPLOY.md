# TackPath API v1: deployment and rollback plan

Nothing in this branch is deployed. The live pages, apps and gateways do not call anything added
here, so the API can be shipped, paused or removed without touching the running system. Every step
below needs an explicit go-ahead from the owner; do them in a quiet hour, in this order.
Open issues are listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## What gets deployed

| Piece | What it is | Off switch (keeps all data) | Full rollback |
|---|---|---|---|
| `supabase/security/69_public_api.sql` | Schema `tp_api`, gateway `public.tp_svc_api` (service_role only), four AFTER triggers (`jobs`, `messages`, `events`, `bin_bindings`) that queue one row each for companies that use the API | Disable the four triggers (below) | `69_public_api.rollback.sql` |
| `supabase/functions/api` | The public HTTPS API (`/functions/v1/api/v1/...`) | Kill switch: every request answers 503 `api_disabled` | `supabase functions delete api` |
| `supabase/functions/api-webhooks` | Processes the queue and sends webhooks, called by cron | Kill switch: processes and sends nothing | `supabase functions delete api-webhooks` |
| `supabase/security/70_api_webhooks_cron.sql` | pg_cron job `api-webhooks-job`, every minute | (the kill switch covers it) | `70_api_webhooks_cron.rollback.sql` |
| `developers.html` | Key and webhook management page for dispatcher companies | Kill switch: its API calls answer 503 | Remove the file from the site |

Migration 69 is additive: new schema, new function, four new triggers. It changes no existing table,
column, function, grant or row. The test `tests/api/migration.test.mjs` proves the existing
gateways (dispatcher, PathIQ, driver, customer portal, tracking) return the same results with and
without it, and that rollback then reapply works.

The triggers only write one row to `tp_api.outbox`, and only for a company that has an active webhook
endpoint or live API orders. For every other company they read one indexed row and return. They
never compute order states, scan a company's jobs or send anything. Measured on a company with
1,500 routes of 20 stops and 20 API orders on one route: one `UPDATE jobs SET status` takes 1.1 ms
(it took 4,275 ms before the fix). Order states, status history and webhook events are computed
from the queue later, by the worker every minute and at the start of the company's own API reads.

## Before you start

1. All suites green on this branch: `node --test tests/api/*.test.mjs` (repository root), the pages
   suite (`cd tests && node --test *.test.js`), `node --test tests/security/*.test.mjs`, and
   `cd operations && npm test`.
2. Take a database backup (Supabase Dashboard, Database, Backups) and note the time.
3. Migration 69's preflight checks only that migration 10's helpers (`tp_sec.insert_json`,
   `tp_sec.rate_ok`) exist, that `public.jobs`, `public.messages` and `public.organizations` exist,
   that `jobs` has the columns it reads (`id, org_id, status, driver_name, surge_stops, archived,
   created_at`), and that 69 is not applied yet. If one of these fails it stops and changes nothing.
   It does **not** check migrations 20 to 68. The tests run 69 on top of 10, 20, 50, 60 to 65, 67 and
   68, the order production has; confirm those are applied before you run it.

## Deploy order

1. **Migration 69.** SQL editor: run `supabase/security/69_public_api.sql`. It runs in one
   transaction; on any error nothing is changed. Check:
   `select count(*) from tp_api.keys;` returns 0,
   `select has_function_privilege('anon', 'public.tp_svc_api(text,jsonb)', 'execute');` returns false, and
   `select tgrelid::regclass, tgname from pg_trigger where tgname like 'tp_api_%';` lists four triggers.
2. **API function.**
   `supabase functions deploy api --no-verify-jwt`
   Secret `SERVICE_ROLE_KEY` must already exist (it does for the other functions). `--no-verify-jwt`
   is required because customer API keys are not Supabase JWTs; the function authenticates every
   request itself through `tp_svc_api`. Check: `curl https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api/v1/health`
   answers 200, and `curl .../api/v1/orders` without a key answers 401 `invalid_api_key`.
3. **Webhook worker.**
   `supabase functions deploy api-webhooks --no-verify-jwt`
   Secret `CRON_SECRET` must equal the Vault secret `tp_cron_secret` (the same pair `swarm-watch`
   uses, migration 40). Without the header the function answers 401. Do not rotate either value
   as part of this rollout.
4. **Migration 70** (optional; without it the queue is processed only by the company's own API reads
   and no webhook is sent). Run `supabase/security/70_api_webhooks_cron.sql`. Check:
   `select jobname, schedule from cron.job where jobname = 'api-webhooks-job';`
5. **Developer page.** Publish `developers.html` with the site. It only calls `tp_org_sign_in`
   (existing) and the `api` function.
6. **Pilot, on a test company with no drivers.** Create one test-mode key (`tpk_test_...`); test-mode
   orders are stored apart and never create jobs (tested). Run `docs/api/examples/end-to-end.sh`
   against it, register a webhook on a server you control and confirm a `webhook.test` event arrives
   with a valid signature. Then try one live key on the same test company: its orders do become
   pending jobs on that company's board. Also check, from a machine you control, that a
   `cf-connecting-ip` or `x-forwarded-for` header you send yourself does not replace your address in
   the audit (see KNOWN_ISSUES.md). Revoke the keys afterwards. Then issue live keys company by
   company.

## Off switches (no data is dropped; both tested in `tests/api/hardening.test.mjs`, test L7)

**Stop all queueing (the triggers).** Dispatcher, PathIQ and driver writes then never touch `tp_api`:

```sql
alter table public.jobs         disable trigger tp_api_job_change;
alter table public.messages     disable trigger tp_api_message;
alter table public.events       disable trigger tp_api_scan;
alter table public.bin_bindings disable trigger tp_api_bin;
```

Turn back on with the same four statements using `enable trigger`. Changes made while the triggers
were off are not queued: orders show their current state on the next read, but no webhook is sent
for those changes and the status history has a gap.

**Kill switch for both edge functions (the rollback for `api` and `api-webhooks`).**

```sql
update tp_api.settings set enabled = false, updated_at = now();
```

Every API request then answers `503 api_disabled` (with `Retry-After`), the worker processes and
sends nothing, and keys, orders, endpoints and queued events are kept. `enabled = true` restores
both at once; queued work is then processed and sent. Tested: 503 while off, nothing sent while off,
200 and sending again after it is turned back on.

Removing the functions themselves (`supabase functions delete api`, `supabase functions delete
api-webhooks`) is a Supabase CLI step. It cannot be run or tested from this repository; use the
kill switch first, then delete the functions if you want them gone.

## Full rollback (in reverse order)

1. Kill switch on (above), then remove `developers.html` from the site.
2. `supabase/security/70_api_webhooks_cron.rollback.sql` (unschedules the worker). Tested.
3. `supabase functions delete api-webhooks` and `supabase functions delete api` (customers get 404;
   nothing else calls them). Not testable here (see above).
4. `supabase/security/69_public_api.rollback.sql`: drops the four triggers, `tp_svc_api` and schema
   `tp_api` (keys, orders, links, queue, webhook endpoints, events, delivery logs, audit). Jobs created
   through the API stay in `jobs` as ordinary pending jobs with source `api`; dispatch handles or
   archives them as usual. To keep the audit trail, export `tp_api.audit` and `tp_api.orders` first.
   Tested: rollback removes everything 69 added, the API's jobs stay, and 69 applies again.

Revoking every key is also possible: `update tp_api.keys set revoked_at = now() where revoked_at is null;`

## Production requirements

- Supabase project `hofijsiphyjpdvujjzfi`, with pg_cron, pg_net and the Vault secret `tp_cron_secret`.
- Function secrets: `SERVICE_ROLE_KEY` (both functions), `CRON_SECRET` (api-webhooks).
- The private `pod` storage bucket (existing); POD media links are signed for 15 minutes.
- For routed API orders to be tracked on their route, the dispatcher must write each order's
  TackPath id (`tp_order_id`) on the route stop. It does not yet (KNOWN_ISSUES.md); until then
  API orders are tracked on their intake job.

## Known risks and limits

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for the open review findings (M2 DNS rebinding, M4 worker
overlap, L2 to L6) and the limits of the fixes. In short:

- **API orders are offered to drivers** like Shopify orders: live orders become pending jobs. A
  customer with a live key can add work to their company's board, within rate limits (120 requests
  per minute per key, 500 orders per batch, 120 batches per hour). Test-mode keys never create jobs.
- **Status history starts at deploy**, and only for companies that use the API.
- **The Deno wrappers are untested**: `api/index.ts` and `api-webhooks/index.ts` have not run in the
  Supabase Edge runtime. Step 6 (pilot) is where that is first exercised.
- **Rate limit storage.** Requests and failed sign-ins are counted in `tp_sec.rate_events`, which
  purges rows older than two days; heavy API use grows that table proportionally.
