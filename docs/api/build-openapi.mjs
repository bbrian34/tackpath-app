// Builds docs/api/openapi.json (OpenAPI 3.1) for TackPath API v1.
//   node docs/api/build-openapi.mjs
// tests/api/docs.test.mjs checks that the file is up to date and that its
// paths and methods are exactly the routes the API handler serves.
import fs from 'node:fs';

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const err = (desc) => ({ description: desc, content: { 'application/json': { schema: ref('Error') } } });
const ok = (desc, schema, status = '200') => ({ [status]: { description: desc, content: { 'application/json': { schema } } } });
const list = (item) => ({ type: 'object', required: ['object', 'data', 'has_more'], properties: {
  object: { const: 'list' }, data: { type: 'array', items: item }, has_more: { type: 'boolean' },
  next_cursor: { type: ['string', 'null'], description: 'Pass as ?cursor= to get the next page' } } });
const common = { 401: err('Missing, invalid, revoked or expired credentials'), 429: err('Rate limit exceeded (see Retry-After)'),
  500: err('Unexpected error on TackPath side (safe to retry with the same Idempotency-Key)'),
  503: err('api_disabled: the API is switched off for maintenance (see Retry-After)') };
const idParam = (name, desc) => ({ name: 'id', in: 'path', required: true, description: desc, schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,64}$' } });
const q = (name, desc, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description: desc, schema });
const paging = [q('limit', '1-200, default 50', { type: 'integer', minimum: 1, maximum: 200 }), q('cursor', 'next_cursor from the previous page')];
const idem = { name: 'Idempotency-Key', in: 'header', required: false, description: 'Any unique string (max 200). A retry with the same key and body returns the first response; with another body, 409.', schema: { type: 'string', maxLength: 200 } };
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const ORDER_STATUS = ['received', 'sorted', 'staged', 'assigned', 'out_for_delivery', 'delivered', 'delivery_attempted', 'exception', 'cancelled'];
const ROUTE_STATUS = ['awaiting_confirmation', 'unassigned', 'assigned', 'in_progress', 'completed', 'completed_with_exceptions', 'cancelled'];
const EVENTS = ['order.status_changed', 'route.assignment_changed', 'delivery.completed', 'delivery.exception', 'pod.available'];
const SCOPES = ['orders:write', 'orders:read', 'routes:read', 'tracking:read', 'pod:read', 'webhooks:manage'];

const schemas = {
  Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'request_id'], properties: {
    code: { type: 'string', examples: ['invalid_address'] }, message: { type: 'string' }, request_id: { type: 'string', examples: ['req_5f1c0e9a2b7d4c6e8f0a1b2c'] },
    order_id: { type: 'string', description: 'For duplicate_order: the existing order' } } } } },
  OrderInput: { type: 'object', required: ['external_id', 'recipient_name', 'address'], properties: {
    external_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,64}$', description: 'Your order reference. Unique per company: a second order with it is refused (409).' },
    recipient_name: { type: 'string', minLength: 1, maxLength: 120 },
    address: { type: 'string', minLength: 5, maxLength: 300, description: 'Full delivery address' },
    packages: { type: 'integer', minimum: 1, maximum: 99, default: 1 },
    tracking_number: { type: 'string', pattern: '^[A-Za-z0-9-]{6,40}$', description: 'The barcode on the package. Generated (TPA...) if omitted. Unique per company; a number already used by another order or on any of the company routes is refused (409).' },
    recipient_phone: { type: 'string', maxLength: 30 }, unit: { type: 'string', maxLength: 40 },
    access_notes: { type: 'string', maxLength: 500 }, gate_code: { type: 'string', maxLength: 40 },
    delivery_notes: { type: 'string', maxLength: 1000 }, signature_required: { type: 'boolean' },
    pickup_address: { type: 'string', maxLength: 300 },
    metadata: { type: 'object', description: 'Your own key/values, returned as is (at most 2 KB)' } } },
  Order: { type: 'object', properties: {
    id: { type: 'string', examples: ['ord_45ff5ef99ddf4ae6b369899a184ffd70'] }, object: { const: 'order' },
    mode: { enum: ['live', 'test'], description: 'test: created with a test-mode key; never on the dispatch board' },
    external_id: { type: 'string' }, tracking_number: { type: 'string' },
    status: { enum: ORDER_STATUS, description: 'See the status table in the guide' },
    recipient: { type: 'object', properties: { name: { type: 'string' } } }, address: { type: 'string' }, packages: { type: 'integer' },
    details: { type: 'object' },
    route: { type: ['object', 'null'], properties: { id: { type: 'string' }, status: { enum: ROUTE_STATUS }, stop_number: { type: 'integer' },
      driver: { type: ['object', 'null'], properties: { name: { type: 'string', description: 'First name and initial only' } } } } },
    sorted_at: { type: ['string', 'null'], format: 'date-time' }, staged_at: { type: ['string', 'null'], format: 'date-time' },
    staging_spot: { type: ['string', 'null'] }, out_for_delivery_at: { type: ['string', 'null'], format: 'date-time' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' }, proof_of_delivery_available: { type: 'boolean' },
    batch_id: { type: ['string', 'null'] }, created_at: { type: 'string', format: 'date-time' } } },
  OrderEvent: { type: 'object', properties: {
    type: { enum: ['received', 'received_at_warehouse', 'sorted', 'staged', 'assigned', 'unassigned', 'out_for_delivery', 'delivered', 'delivery_attempted', 'exception', 'cancelled'] },
    occurred_at: { type: 'string', format: 'date-time' }, source: { enum: ['api', 'pathiq', 'dispatch', 'driver'] },
    bin: { type: 'string' }, staging_spot: { type: 'string' }, driver: { type: 'string' }, reason: { type: 'string' }, reason_label: { type: 'string' } } },
  Batch: { type: 'object', properties: { id: { type: 'string' }, object: { const: 'batch' }, received: { type: 'integer' }, created: { type: 'integer' },
    duplicates: { type: 'integer' }, rejected: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' },
    results: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, result: { enum: ['created', 'duplicate', 'rejected'] },
      order_id: { type: 'string' }, external_id: { type: 'string' }, tracking_number: { type: 'string' },
      error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } } } } },
  ProofOfDelivery: { type: 'object', properties: { order_id: { type: 'string' }, object: { const: 'proof_of_delivery' },
    delivered_at: { type: ['string', 'null'], format: 'date-time' }, recorded_at: { type: 'string', format: 'date-time' },
    recipient_name: { type: ['string', 'null'] }, delivery_method: { type: ['string', 'null'] }, delivery_method_label: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] }, packages_verified: { type: ['integer', 'null'] },
    media_pending: { type: 'boolean', description: 'A photo was taken but has not finished uploading yet' },
    media: { type: 'array', items: { type: 'object', properties: { kind: { enum: ['photo', 'signature'] }, url: { type: 'string', format: 'uri' },
      expires_at: { type: 'string', format: 'date-time', description: 'The link works for 15 minutes' } } } } } },
  Route: { type: 'object', properties: { id: { type: 'string', examples: ['rte_2ed955a68399451b82cefff2c794a79f'] }, object: { const: 'route' },
    type: { enum: ['route', 'single_delivery'] }, title: { type: 'string' }, status: { enum: ROUTE_STATUS },
    stops_total: { type: 'integer' }, stops_completed: { type: 'integer' }, packages_total: { type: ['integer', 'null'] },
    driver: { type: ['object', 'null'], properties: { name: { type: 'string' } } }, bin: { type: ['string', 'null'] },
    staging_spot: { type: ['string', 'null'] }, staged_at: { type: ['string', 'null'] }, estimated_delivery_at: { type: ['string', 'null'] },
    picked_up_at: { type: ['string', 'null'] }, completed_at: { type: ['string', 'null'] }, created_at: { type: 'string' },
    stops: { type: 'array', description: 'GET /routes/{id} only', items: { type: 'object', properties: { stop_number: { type: 'integer' },
      order_id: { type: ['string', 'null'] }, tracking_number: { type: ['string', 'null'] }, recipient: { type: ['string', 'null'] },
      address: { type: ['string', 'null'] }, packages: { type: ['integer', 'null'] }, status: { enum: ['pending', 'delivered', 'exception', 'cancelled'] } } } } } },
  WebhookEndpointInput: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', description: 'https, port 443, public host name' },
    events: { type: 'array', items: { enum: EVENTS }, description: 'Default: all' }, description: { type: 'string', maxLength: 200 },
    active: { type: 'boolean', description: 'PATCH only' } } },
  WebhookEndpoint: { type: 'object', properties: { id: { type: 'string' }, object: { const: 'webhook_endpoint' }, url: { type: 'string' },
    description: { type: ['string', 'null'] }, events: { type: 'array', items: { enum: EVENTS } }, active: { type: 'boolean' },
    secret: { type: 'string', description: 'Only in the create and rotate-secret responses' },
    created_at: { type: 'string' }, updated_at: { type: 'string' } } },
  WebhookDelivery: { type: 'object', properties: { id: { type: 'string' }, event_id: { type: 'string' }, event_type: { type: 'string' },
    status: { enum: ['pending', 'delivered', 'failed'] }, attempts: { type: 'integer' }, last_status_code: { type: ['integer', 'null'] },
    last_error: { type: ['string', 'null'] }, next_attempt_at: { type: ['string', 'null'] }, delivered_at: { type: ['string', 'null'] }, created_at: { type: 'string' } } },
  Event: { type: 'object', required: ['id', 'object', 'type', 'api_version', 'created_at', 'data'], properties: {
    id: { type: 'string', examples: ['evt_9c2f0d41e1b84d6f9f3a2b1c0d9e8f7a'] }, object: { const: 'event' }, type: { enum: [...EVENTS, 'webhook.test'] },
    api_version: { const: 'v1' }, created_at: { type: 'string', format: 'date-time' },
    data: { type: 'object', properties: { order: ref('Order'), route: ref('Route'), previous_status: { type: ['string', 'null'] },
      reason: { type: 'string' }, reason_label: { type: 'string' } } } } },
  ApiKey: { type: 'object', properties: { id: { type: 'string' }, object: { const: 'api_key' }, name: { type: 'string' }, prefix: { type: 'string' },
    mode: { enum: ['live', 'test'] }, scopes: { type: 'array', items: { enum: SCOPES } }, own_orders_only: { type: 'boolean' },
    client_label: { type: ['string', 'null'] }, rate_per_minute: { type: 'integer' }, status: { enum: ['active', 'revoked', 'expired'] },
    created_at: { type: 'string' }, expires_at: { type: ['string', 'null'] }, revoked_at: { type: ['string', 'null'] }, last_used_at: { type: ['string', 'null'] },
    key: { type: 'string', description: 'Only in the create and rotate responses' } } },
};

const op = (summary, scope, extra) => ({ summary, security: scope === 'session' ? [{ CompanySession: [] }] : [{ ApiKey: [] }],
  ...(scope && scope !== 'session' ? { 'x-required-scope': scope } : {}), ...extra });

const paths = {
  '/health': { get: { summary: 'Health check (no credentials)', security: [], responses: ok('The API is up', { type: 'object', properties: { ok: { type: 'boolean' }, api_version: { const: 'v1' } } }) } },
  '/orders': {
    post: op('Submit one delivery order', 'orders:write', { parameters: [idem], requestBody: body(ref('OrderInput')),
      responses: { ...ok('Created', ref('Order'), '201'), 409: err('duplicate_order, duplicate_tracking_number or idempotency_conflict'),
        413: err('Body over 1 MB'), 415: err('Not application/json'), 422: err('A field is not valid (see error.code)'), ...common } }),
    get: op('List orders, newest first', 'orders:read', { parameters: [q('status', 'Filter by status', { enum: ORDER_STATUS }), q('external_id', 'Exact'),
      q('tracking_number', 'Exact, any case'), q('created_after', 'ISO 8601', { type: 'string', format: 'date-time' }),
      q('created_before', 'ISO 8601', { type: 'string', format: 'date-time' }), ...paging], responses: { ...ok('A page of orders', list(ref('Order'))), 400: err('Bad filter or cursor'), ...common } }),
  },
  '/orders/batch': { post: op('Submit a manifest (1-500 orders)', 'orders:write', { parameters: [idem],
    requestBody: body({ type: 'object', required: ['orders'], properties: { orders: { type: 'array', minItems: 1, maxItems: 500, items: ref('OrderInput') } } }),
    responses: { ...ok('Per-order results (created, duplicate, rejected)', ref('Batch')), 422: err('Not a list of 1-500 orders'), ...common } }) },
  '/orders/{id}': { get: op('Get an order (by ord_... id or your external_id)', 'orders:read', { parameters: [idParam('id', 'ord_... or external_id')],
    responses: { ...ok('The order', ref('Order')), 404: err('No such order for this key'), ...common } }) },
  '/orders/{id}/events': { get: op('Lifecycle events of an order, oldest first', 'tracking:read', { parameters: [idParam('id', 'ord_... or external_id')],
    responses: { ...ok('Events', { type: 'object', properties: { object: { const: 'list' }, order_id: { type: 'string' }, status: { enum: ORDER_STATUS }, data: { type: 'array', items: ref('OrderEvent') } } }),
      404: err('No such order'), ...common } }) },
  '/orders/{id}/proof-of-delivery': { get: op('Proof of delivery (photos and signatures as 15-minute links)', 'pod:read', { parameters: [idParam('id', 'ord_... or external_id')],
    responses: { ...ok('Proof of delivery', ref('ProofOfDelivery')), 404: err('not_found, or pod_not_available when no delivery was recorded'), ...common } }) },
  '/batches/{id}': { get: op('Get a batch result', 'orders:read', { parameters: [idParam('id', 'bat_...')], responses: { ...ok('The batch', ref('Batch')), 404: err('No such batch'), ...common } }) },
  '/tracking/{id}': { get: op('Track by tracking number', 'tracking:read', { parameters: [idParam('id', 'The tracking number (any case)')],
    responses: { ...ok('Order and events', { type: 'object', properties: { object: { const: 'tracking' }, order: ref('Order'), events: { type: 'array', items: ref('OrderEvent') } } }), 404: err('Unknown tracking number'), ...common } }) },
  '/routes': { get: op('List routes and deliveries, newest first', 'routes:read', { parameters: [q('status', 'Filter', { enum: ROUTE_STATUS }),
    q('created_after', 'ISO 8601', { type: 'string', format: 'date-time' }), ...paging], responses: { ...ok('A page of routes', list(ref('Route'))), ...common } }) },
  '/routes/{id}': { get: op('Get a route with its stops', 'routes:read', { parameters: [idParam('id', 'rte_...')], responses: { ...ok('The route', ref('Route')), 404: err('No such route'), ...common } }) },
  '/webhooks': {
    post: op('Register a webhook endpoint (returns the signing secret once)', 'webhooks:manage', { parameters: [idem], requestBody: body(ref('WebhookEndpointInput')),
      responses: { ...ok('Created', ref('WebhookEndpoint'), '201'), 422: err('invalid_url, invalid_events or too_many_endpoints'), ...common } }),
    get: op('List webhook endpoints', 'webhooks:manage', { responses: { ...ok('Endpoints', list(ref('WebhookEndpoint'))), ...common } }),
  },
  '/webhooks/{id}': {
    get: op('Get a webhook endpoint', 'webhooks:manage', { parameters: [idParam('id', 'whk_...')], responses: { ...ok('Endpoint', ref('WebhookEndpoint')), 404: err('No such endpoint'), ...common } }),
    patch: op('Change url, events, description or active', 'webhooks:manage', { parameters: [idParam('id', 'whk_...')], requestBody: body(ref('WebhookEndpointInput')),
      responses: { ...ok('Endpoint', ref('WebhookEndpoint')), 404: err('No such endpoint'), 422: err('Invalid change'), ...common } }),
    delete: op('Delete (disable) an endpoint; pending deliveries are dropped', 'webhooks:manage', { parameters: [idParam('id', 'whk_...')],
      responses: { ...ok('Deleted', { type: 'object', properties: { id: { type: 'string' }, deleted: { const: true } } }), 404: err('No such endpoint'), ...common } }),
  },
  '/webhooks/{id}/rotate-secret': { post: op('Replace the signing secret (returned once)', 'webhooks:manage', { parameters: [idParam('id', 'whk_...'), idem],
    responses: { ...ok('Endpoint with the new secret', ref('WebhookEndpoint')), 404: err('No such endpoint'), ...common } }) },
  '/webhooks/{id}/test': { post: op('Queue a webhook.test event to this endpoint', 'webhooks:manage', { parameters: [idParam('id', 'whk_...')],
    responses: { ...ok('Queued', { type: 'object', properties: { event_id: { type: 'string' }, queued: { const: true } } }, '202'), 404: err('No such endpoint'), ...common } }) },
  '/webhooks/{id}/deliveries': { get: op('The last 100 deliveries to this endpoint', 'webhooks:manage', { parameters: [idParam('id', 'whk_...')],
    responses: { ...ok('Deliveries', list(ref('WebhookDelivery'))), 404: err('No such endpoint'), ...common } }) },
  '/events': { get: op('Recent events (the same ones sent to webhooks), newest first', 'webhooks:manage', { parameters: paging,
    responses: { ...ok('Events', list(ref('Event'))), ...common } }) },
  '/admin/keys': {
    get: op('List API keys (developer page)', 'session', { responses: { ...ok('Keys', list(ref('ApiKey'))), 401: err('Sign in again') } }),
    post: op('Create an API key (the key is returned once)', 'session', { requestBody: body({ type: 'object', required: ['name'], properties: {
      name: { type: 'string', maxLength: 80 }, scopes: { type: 'array', items: { enum: SCOPES } }, mode: { enum: ['live', 'test'] },
      own_orders_only: { type: 'boolean' }, client_label: { type: 'string', maxLength: 80 }, expires_in_days: { type: 'integer', minimum: 1, maximum: 3650 },
      rate_per_minute: { type: 'integer', minimum: 1, maximum: 600 } } }), responses: { ...ok('Created', ref('ApiKey'), '201'), 422: err('Invalid field'), 401: err('Sign in again') } }),
  },
  '/admin/keys/{id}/revoke': { post: op('Revoke a key (effective immediately)', 'session', { parameters: [idParam('id', 'key_...')], responses: { ...ok('Revoked', ref('ApiKey')), 404: err('No such key'), 401: err('Sign in again') } }) },
  '/admin/keys/{id}/rotate': { post: op('Create a replacement key; the old one keeps working for grace_hours (0-168, default 24)', 'session', { parameters: [idParam('id', 'key_...')],
    requestBody: body({ type: 'object', properties: { grace_hours: { type: 'integer', minimum: 0, maximum: 168 } } }, false),
    responses: { ...ok('The new key', ref('ApiKey'), '201'), 404: err('No such key'), 409: err('The key is revoked'), 401: err('Sign in again') } }) },
};

const spec = {
  openapi: '3.1.0',
  info: { title: 'TackPath API', version: 'v1', description: 'Submit delivery orders, follow routes and packages, receive webhooks and read proof of delivery. Guide: docs/api/README.md.' },
  servers: [{ url: 'https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api/v1', description: 'Production' }],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: {
      ApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tpk_live_<prefix>_<secret>', description: 'Authorization: Bearer tpk_live_...' },
      CompanySession: { type: 'apiKey', in: 'header', name: 'X-TackPath-Session', description: 'The developer page only (a dispatcher company session)' },
    },
    schemas,
  },
  paths,
  webhooks: Object.fromEntries(EVENTS.map((e) => [e, { post: { summary: `${e} event`, parameters: [
    { name: 'TackPath-Signature', in: 'header', required: true, schema: { type: 'string' }, description: 't=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>' },
    { name: 'TackPath-Event-Id', in: 'header', required: true, schema: { type: 'string' } },
    { name: 'TackPath-Delivery-Attempt', in: 'header', required: true, schema: { type: 'string' } }],
    requestBody: body(ref('Event')), responses: { 200: { description: 'Any 2xx acknowledges the event; anything else is retried' } } } }])),
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) {
  fs.writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(spec, null, 2) + '\n');
  console.log('wrote docs/api/openapi.json');
}
