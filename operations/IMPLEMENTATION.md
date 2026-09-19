# TackPath operational repair sequence

1. Protect source versions; capture deployed schema and functions. No production rows deleted.
2. Implement additive operations schema and transactional commands: scoped sessions, physical pieces and aliases, manifests/rows, immutable stops, bin reservations, custody, exceptions, delivery attempts and idempotency.
3. Test actual PostgreSQL functions locally, including rollback, alias collisions, retries and conservation. Reconcile compatibility with existing jobs/packages/events.
4. Implement one authenticated SmartSort intake and recoverable geocoding/publication path. Preserve all input rows and pieces before routing.
5. Integrate shared command/state client into Dispatcher, Stow and Driver while preserving working screens. Replace direct operational writes and message-derived truth.
6. Integrate authenticated login, secure scoped reads/storage, durable client retries, immutable POD association, and native navigation lifecycle.
7. Run automated database, service, browser and Android checks; execute full conservation and fault matrix. Deploy non-destructively only after tests; validate remote behavior with isolated test data.
8. Commit and push tested repair branches; record exact deployment/build/test evidence and unresolved external blockers honestly.

## Deployment discovered
Project hofijsiphyjpdvujjzfi, Postgres 17.6. Existing memory-spine tables and event materialization trigger deployed, but packages/events empty. At initial inventory query jobs empty; one legacy driver has null org. No Supabase Auth users. Current apps use publishable credentials and custom login. Organization identity cannot be trusted from a client-supplied org_id; session issuance and scoped server commands must be implemented before enabling the repaired operation.

## Acceptance
Every manifested physical piece must be delivered, held/returned, or explicitly unresolved. No unexplained piece, duplicate alias count, occupied-bin reuse, false persisted success, stale driver ownership, cancelled-as-delivered, or orphaned proof. Test duplicate/wrong/alias scans, DB/geocode/publication/POD/final-write failures, manifest retry, reconnect, incomplete loading, reassignment, cancellation and retry.
