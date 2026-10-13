# TackPath API v1

Connect your order system, warehouse system or e-commerce platform to TackPath. With the API you can:
- submit delivery orders, one at a time or as a manifest;
- follow every package from intake to the doorstep;
- see which route and driver carry it;
- receive webhooks when something changes;
- download proof of delivery.

- **Base URL:** `https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api/v1`
- **Format:** JSON over HTTPS. Times are ISO 8601 UTC.
- **Reference:** [`openapi.json`](openapi.json) (OpenAPI 3.1). You can load it into Postman, Insomnia or an SDK generator.

## 1. Authentication

Create a key on the **TackPath developer page** (`developers.html`):
1. Sign in with your company and company code, as you do in the dispatcher.
2. Choose a name and the scopes.
3. Copy the key, which is shown once.

TackPath stores only a hash of your key; it can never be shown again. Send the key on every request:

```
Authorization: Bearer tpk_live_361f0da6ce32_9b2f...   (64 hex characters after the prefix)
```

| Scope | Allows |
|---|---|
| `orders:write` | Submit orders and manifests |
| `orders:read` | Read orders and batch results |
| `tracking:read` | Order events and tracking by tracking number |
| `pod:read` | Proof of delivery |
| `routes:read` | Routes, stops and driver assignment |
| `webhooks:manage` | Webhook endpoints, deliveries and the event list |

- **Separate keys:** use one key per system and per environment, and give each key only the scopes it needs. Keys are never shared between companies.
- **Client keys:** if a business you deliver for integrates directly, give it a key with **"Limit this key to the orders it creates"** and a client label. That key sees only orders created by keys with the same label, and it can never read routes.
- **Rotation:** **Rotate** issues a new key. The old key keeps working for the grace period (default 24 hours; 0 revokes it at once), so you can deploy the new key with no downtime.
- **Revocation:** **Revoke** stops a key immediately.
- **Expiry:** a key can be given an expiry date when it is created.
- **Failed credentials:** a request with a missing, wrong, revoked or expired key gets `401`.

## 2. Quick start

```bash
curl -X POST "$API/orders" \
  -H "Authorization: Bearer $TACKPATH_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: SO-48213" \
  -d '{"external_id":"SO-48213","recipient_name":"Avery Collins",
       "address":"214 Maple Grove Ln, Marietta, GA 30064","packages":2,"tracking_number":"PCX4102322"}'
```

`201 Created`:

```json
{
  "id": "ord_45ff5ef99ddf4ae6b369899a184ffd70", "object": "order",
  "external_id": "SO-48213", "tracking_number": "PCX4102322", "status": "received",
  "recipient": { "name": "Avery Collins" }, "address": "214 Maple Grove Ln, Marietta, GA 30064", "packages": 2,
  "details": {}, "route": { "id": "rte_2ed955a68399451b82cefff2c794a79f", "status": "unassigned", "stop_number": 1, "driver": null },
  "sorted_at": null, "staged_at": null, "staging_spot": null, "out_for_delivery_at": null, "delivered_at": null,
  "proof_of_delivery_available": false, "batch_id": null, "created_at": "2026-10-13T09:12:57.268Z"
}
```

The order now appears on the dispatcher's board as a pending delivery, the same path Shopify orders take. A complete walkthrough is in [`examples/end-to-end.sh`](examples/end-to-end.sh).

## 3. Orders

| Method | Path | Scope |
|---|---|---|
| POST | `/orders` | orders:write |
| POST | `/orders/batch` | orders:write |
| GET | `/orders` | orders:read |
| GET | `/orders/{id}` | orders:read |
| GET | `/batches/{id}` | orders:read |

`{id}` can be the TackPath id (`ord_...`) or your `external_id`.

**Order fields**

| Field | Required | Rules |
|---|---|---|
| `external_id` | yes | Your reference, 1-64 of `A-Z a-z 0-9 . _ : -`. Unique per company. |
| `recipient_name` | yes | 1-120 characters |
| `address` | yes | Full address, 5-300 characters |
| `packages` | no | 1-99, default 1 |
| `tracking_number` | no | 6-40 of `A-Z 0-9 -`, stored upper case. This is the barcode PathIQ and the driver scan. If you leave it out, TackPath creates one (`TPA...`). Unique per company. |
| `recipient_phone`, `unit`, `access_notes`, `gate_code`, `delivery_notes`, `signature_required`, `pickup_address` | no | Shown to dispatch and the driver |
| `metadata` | no | Your own object (max 2 KB), returned as is |

**Duplicates and retries**
- A second order with the same `external_id` gets `409 duplicate_order`, with `error.order_id` naming the existing order. A reused tracking number gets `409 duplicate_tracking_number`.
- Send an `Idempotency-Key` header (any unique string, max 200 characters) on every write. Repeating the request with the same key and body within 24 hours returns the first response, with the header `Idempotent-Replayed: true`. Reusing the key with a different body gets `409 idempotency_conflict`.

**Manifests:** `POST /orders/batch` with `{"orders": [ ... up to 500 ... ]}`. Each line is checked on its own. The response is always `200`:

```json
{ "id": "bat_...", "object": "batch", "received": 3, "created": 1, "duplicates": 1, "rejected": 1,
  "results": [
    { "index": 0, "result": "created", "order_id": "ord_...", "external_id": "SO-1", "tracking_number": "TPA1F2E3D4C5B6A" },
    { "index": 1, "result": "duplicate", "order_id": "ord_...", "external_id": "SO-0" },
    { "index": 2, "result": "rejected", "external_id": "SO-2", "error": { "code": "invalid_address", "message": "address: 5-300 characters" } } ] }
```

Read a batch result again with `GET /batches/{id}`.

**Listing:** `GET /orders` returns the newest orders first. It accepts these filters:
- `status`;
- `external_id`;
- `tracking_number`;
- `created_after` and `created_before` (ISO 8601);
- `limit` (1-200, default 50) and `cursor`.

## 4. Tracking

| Method | Path | Scope |
|---|---|---|
| GET | `/orders/{id}/events` | tracking:read |
| GET | `/tracking/{tracking_number}` | tracking:read |

An order's `status` is the furthest point it has reached, worked out only from what TackPath's apps recorded:

| Status | Meaning | Recorded by |
|---|---|---|
| `received` | TackPath has the order | The API |
| `assigned` | A driver has the route | The dispatcher |
| `sorted` | The package was scanned into its bin | PathIQ (package scan) |
| `staged` | The bin was staged at a staging spot (STG); `staging_spot` says where | PathIQ (STG scan) |
| `out_for_delivery` | The driver picked up the route | The driver app |
| `delivered` | Delivered; proof of delivery is available | The driver app |
| `delivery_attempted` | Not delivered: no access, or the business was closed | The driver app |
| `exception` | Refused, damaged, wrong address or unsafe | The driver app |
| `cancelled` | Cancelled by dispatch | The dispatcher |

- **Order of states:** assignment can happen before or after sorting. The status always shows the most advanced physical state.
- **Events:** `/events` lists every step in time order with its own time and source (`api`, `pathiq`, `dispatch`, `driver`). A step that was not recorded is not listed, and a time is never estimated or filled in.
- **History:** status changes made before the API was enabled have no recorded time, so only their outcome is shown.
- **Routes:** if dispatch puts your order on a multi-stop route (SmartSort), the order follows that route. `route.id` and `route.stop_number` change to match.

## 5. Routes

| Method | Path | Scope |
|---|---|---|
| GET | `/routes` | routes:read |
| GET | `/routes/{id}` | routes:read |

A route shows:
- its status, stop and package counts;
- the bin, and the staging spot when staged;
- pickup and completion times;
- the driver as first name and initial only (no phone number).

`GET /routes/{id}` adds each stop's recipient, address, package count and stop status.

Route statuses: `awaiting_confirmation`, `unassigned`, `assigned`, `in_progress`, `completed`, `completed_with_exceptions`, `cancelled`.

## 6. Proof of delivery

`GET /orders/{id}/proof-of-delivery` (scope `pod:read`) returns the record the driver saved at the door:
- the delivery time;
- the recipient or signer name;
- how it was delivered (for example "Handed to customer");
- the driver's notes;
- the photos and signature as links that work for **15 minutes**.

Request it again for fresh links. Media is stored privately and is never public.

- **No delivery recorded:** if no delivery record was saved, the response is `404 pod_not_available`. TackPath never makes up proof.
- **Upload in progress:** `media_pending: true` means a photo was taken but its upload has not finished yet. Try again shortly.

## 7. Webhooks

Register an HTTPS endpoint with `POST /webhooks` `{"url": "...", "events": [...]}` (scope `webhooks:manage`), or on the developer page. The response includes the **signing secret** (`whsec_...`) **once**. Store it.

| Event | When |
|---|---|
| `order.status_changed` | An order's status changes. `data.order` holds the new status and `data.previous_status` the old one. |
| `route.assignment_changed` | A route gets a driver, or its driver changes. Sent to company-wide endpoints only. |
| `delivery.completed` | The driver recorded the delivery |
| `delivery.exception` | The driver reported a problem. `data.reason` is one of `no_access`, `business_closed`, `refused`, `damaged`, `wrong_address`, `unsafe`. |
| `pod.available` | A delivery photo or signature is stored |

Each delivery is a `POST` with this body:

```json
{ "id": "evt_9c2f...", "object": "event", "type": "order.status_changed", "api_version": "v1",
  "created_at": "2026-10-13T09:40:02Z", "data": { "order": { "...": "the order" }, "previous_status": "staged" } }
```

It carries these headers:
- `TackPath-Signature: t=<unix seconds>,v1=<hex>`
- `TackPath-Event-Id`
- `TackPath-Event-Type`
- `TackPath-Delivery-Id`
- `TackPath-Delivery-Attempt`

**Verify every webhook.** `v1` is the HMAC-SHA256 of `"<t>.<raw body>"` using your secret. Compare it in constant time and reject `t` older than 5 minutes (replay protection). Then skip any `id` you have already handled. Examples:
- Node: [`examples/verify-webhook.mjs`](examples/verify-webhook.mjs)
- Python: [`examples/verify_webhook.py`](examples/verify_webhook.py)

```js
const ok = verifyTackPathSignature(secret, rawBody, req.headers['tackpath-signature']);   // false -> 400
```

**Delivery and retries**
- Answer with any 2xx within 10 seconds. Anything else, a timeout or a connection failure is retried.
- Up to 8 attempts are made: immediately, then after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours. After the 8th attempt the delivery is marked `failed`.
- Redirects are not followed.
- Events can arrive more than once, and out of order between different orders. Use `id` to deduplicate, and `created_at` and the order's own status to order them.
- `GET /webhooks/{id}/deliveries` shows the last 100 deliveries with their status and last error.
- `POST /webhooks/{id}/test` sends a `webhook.test` event.
- `POST /webhooks/{id}/rotate-secret` replaces the secret.
- `GET /events` lists recent events, if you prefer polling.

**Destinations:** they must be `https://` on port 443 with a public host name. IP addresses, `localhost`, internal names and hosts that resolve to private, link-local or cloud-metadata addresses are refused, both when the endpoint is registered and before every delivery.

**Limits:** at most 10 active endpoints per company. Webhooks never slow down or block dispatch: events are queued and sent separately.

## 8. Errors

Every error has the same shape. Quote `request_id` (also in the `X-Request-Id` header) when you contact support.

```json
{ "error": { "code": "invalid_address", "message": "address: 5-300 characters", "request_id": "req_5f1c0e9a2b7d4c6e8f0a1b2c" } }
```

| HTTP | `code` | What to do |
|---|---|---|
| 400 | `invalid_json`, `invalid_parameter`, `invalid_filter`, `invalid_cursor`, `invalid_request`, `invalid_idempotency_key` | Fix the request |
| 401 | `invalid_api_key`, `api_key_revoked`, `api_key_expired`, `invalid_session` | Check the key, or sign in again on the developer page |
| 403 | `insufficient_scope`, `forbidden` | Use a key with the scope named in the message |
| 404 | `not_found`, `unknown_endpoint`, `pod_not_available` | The resource does not exist for this key, or no proof of delivery was recorded |
| 405 | `method_not_allowed` | Check the method |
| 409 | `duplicate_order`, `duplicate_tracking_number`, `idempotency_conflict`, `api_key_revoked` | Already exists, or the Idempotency-Key was reused with a different body |
| 413 | `payload_too_large` | The body is over 1 MB; split the manifest |
| 415 | `unsupported_media_type` | Send `Content-Type: application/json` |
| 422 | `invalid_external_id`, `invalid_recipient`, `invalid_address`, `invalid_packages`, `invalid_tracking_number`, `invalid_batch`, `invalid_order`, `invalid_url`, `invalid_events`, `too_many_endpoints`, `invalid_name`, `invalid_mode`, `invalid_scopes`, `invalid_expiry`, `too_many_keys` | Fix the field named in the message |
| 429 | `rate_limited` | Wait for `Retry-After` seconds |
| 500 | `internal_error` | Retry with the same Idempotency-Key; contact support with the request id if it persists |

Another company's resources always answer `404`, never `403`, so their existence is not revealed.

## 9. Limits

| Limit | Value |
|---|---|
| Requests per key | 120 per minute by default; up to 600 can be set per key. `X-RateLimit-Limit` and `X-RateLimit-Remaining` are on every response. |
| Manifests | 120 per hour per company, 500 orders each |
| Request body | 1 MB |
| Page size | 1-200, default 50 |
| Active keys | 25 per company |
| Webhook endpoints | 10 active per company |
| Idempotency keys | remembered for 24 hours |

When a limit is exceeded you get `429 rate_limited` with `Retry-After: 60`.

## 10. Versioning and compatibility

**Version in the path:** the version is part of the path (`/v1`). Within v1 TackPath only adds things:
- new endpoints;
- new optional request fields;
- new response fields;
- new event types (you only receive the types you subscribe to);
- new error codes;
- new values in `status` enums.

Your integration must ignore fields it does not know and handle unknown values gracefully.

**Breaking changes go into a new version (v2).** They include:
- removing or renaming a field;
- changing a type or meaning;
- making an optional field required.

v1 then keeps working for at least 12 months after v2 is announced. Deprecations are announced by email and in this guide, with a `Deprecation` header on affected responses.

## 11. Security and personal data

- **Encryption:** traffic is HTTPS only.
- **Keys and secrets:** keys are stored as SHA-256 hashes. Webhook signing secrets are stored server side and shown only once.
- **Authorization in the database:** every request is authorized there, scoped to one company and recorded in an audit log. The log holds the time, key prefix, method, path, result and error code; it holds no request bodies, no personal data and no secrets.
- **Driver data:** drivers appear by first name and initial only. Phone numbers, gate codes and notes are visible only to your company's dispatch and drivers, and are never sent to other companies.
- **Media:** proof-of-delivery media is private and reachable only through 15-minute signed links.
