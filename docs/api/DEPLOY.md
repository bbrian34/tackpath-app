# TackPath API v1: deployment and rollback plan

Nothing in this branch is deployed. The live pages, apps and gateways do not call anything added
here, so the API can be shipped, paused or removed without touching the running system. Every step
below needs an explicit go-ahead from the owner; do them in a quiet hour, in this order.

## What gets deployed

| Piece | What it is | Reversible by |
|---|---|---|
| `supabase/security/69_public_api.sql` | Schema `tp_api`, gateway `public.tp_svc_api` (service_role only), two AFTER triggers that queue webhook events | `69_public_api.rollback.sql` |
| `supabase/functions/api` | The public HTTPS API (`/functions/v1/api/v1/...`) | `supabase functions delete api` |
| `supabase/functions/api-webhooks` | Webhook sender, called by cron | `supabase functions delete api-webhooks` |
| `supabase/security/70_api_webhooks_cron.sql` | pg_cron job `api-webhooks-job`, every minute | `70_api_webhooks_cron.rollback.sql` |
| `developers.html` | Key and webhook management page for dispatcher companies | Remove the file from the site |

Migration 69 is additive: new schema, new function, two new triggers. It changes no existing table,
column, function, grant or row. The test `tests/api/migration.test.mjs` proves the existing
gateways return the same results with and without it, and that rollback then reapply works.

## Before you start

1. All suites green on this branch (see "Tests" in the PR): `node --test tests/api/*.test.mjs`,
   the pages suite, `tests/security`, `operations`.
2. Take a database backup (Supabase Dashboard, Database, Backups) and note the time.
3. Confirm migrations 10, 20, 50, 60 to 65, 67 and 68 are applied (69's preflight refuses otherwise
   and changes nothing).

## Deploy order

1. **Migration 69.** SQL editor: run `supabase/security/69_public_api.sql`. It runs in one
   transaction; on any error nothing is changed. Check:
   `select count(*) from tp_api.keys;` returns 0, and
   `select has_function_privilege('anon', 'public.tp_svc_api(text,jsonb)', 'execute');` returns false.
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
4. **Migration 70** (optional; without it events are queued but not sent). Run
   `supabase/security/70_api_webhooks_cron.sql`. Check: `select jobname, schedule from cron.job where jobname = 'api-webhooks-job';`
5. **Developer page.** Publish `developers.html` with the site. It only calls `tp_org_sign_in`
   (existing) and the `api` function.
6. **Pilot.** Create one test-mode key (`tpk_test_...`) for one company, run
   `docs/api/examples/end-to-end.sh` against it, register a webhook on a server you control and
   confirm a `webhook.test` event arrives with a valid signature. Revoke the key afterwards.
   Then issue live keys company by company.

## Rollback (any step, in reverse order)

1. Remove `developers.html` from the site.
2. `supabase/security/70_api_webhooks_cron.rollback.sql` (stops sending).
3. `supabase functions delete api-webhooks` and `supabase functions delete api` (customers get 404;
   nothing else calls them).
4. `supabase/security/69_public_api.rollback.sql`: drops the two triggers, `tp_svc_api` and schema
   `tp_api` (keys, webhook endpoints, events, delivery logs, audit). Jobs created through the API stay
   in `jobs` as ordinary pending jobs with source `api`; dispatch handles or archives them as usual.
   To keep the audit trail, export `tp_api.audit` and `tp_api.orders` before running it.

Fast kill switch without dropping data: delete the `api` function (step 3), or revoke all keys:
`update tp_api.keys set revoked_at = now() where revoked_at is null;`

## Production requirements

- Supabase project `hofijsiphyjpdvujjzfi`, with pg_cron, pg_net and the Vault secret `tp_cron_secret`.
- Function secrets: `SERVICE_ROLE_KEY` (both functions), `CRON_SECRET` (api-webhooks).
- The private `pod` storage bucket (existing); POD media links are signed for 15 minutes.

## Known risks and limits

- **Webhook signing secrets are stored in plain text** in `tp_api.webhook_endpoints.secret` (the
  sender needs the raw value to sign). The schema is private: no grant to anon or authenticated,
  never returned after creation. Moving them into Supabase Vault is a follow-up; tests run in PGlite,
  which has no Vault.
- **DNS rebinding.** Webhook URLs are resolved and checked against private and reserved ranges at
  registration and again before every send, and redirects are not followed. A host that changes its
  DNS answer between the check and the connection could still reach an internal address. Edge
  Functions run outside the database network, which limits what such a request could reach.
- **API orders are offered to drivers** like Shopify orders: they become pending jobs. A customer
  with a key can add work to their company's board, within rate limits (120 requests per minute per
  key, 500 orders per batch).
- **Status history starts at deploy.** Events and webhooks exist only for changes after migration 69;
  older jobs show their current status without a history.
- **The Deno wrappers are untested.** All logic lives in `_shared/tp_api.js` and is tested under Node
  against the real migrations; the two `index.ts` files only wire secrets and Supabase clients, and
  have not run in the Supabase Edge runtime. Step 6 (pilot) is where that is first exercised.
- **Rate limit storage.** Requests are counted in `tp_sec.rate_events`, which already purges rows
  older than two days; heavy API use grows that table proportionally.
- **Sender throughput.** The worker sends up to 25 deliveries per minute per run; a large backlog
  drains over several minutes. Deliveries never block order intake or driver actions.
