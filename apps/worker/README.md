# RafayPair Worker

The worker drains PostgreSQL's transactional outbox, publishes consent-safe pair events through transient Redis Pub/Sub, and sends native care notifications through APNs or FCM. PostgreSQL is the only durable replay store; Redis retains no envelope stream. Delivery is at least once, and every externally visible event has a stable UUID/event sequence so consumers can deduplicate it.

Before each external effect, the worker rechecks the active pair, both privacy states, the event-specific directional grant, and the event's persisted authorization revision. Revoked or stale rows are durably suppressed. The API repeats that fence while holding the session and pair read locks through socket queueing.

Only the oldest pending event for a pair can be claimed, preserving pair order while allowing different pairs to run concurrently across worker replicas. Claims use `FOR UPDATE SKIP LOCKED`, have a two-minute recovery lease, and use bounded exponential retry. After 25 failed attempts an event is dead-lettered for operator review rather than discarded.

Notification delivery is idempotent per event/device. Device tokens are AES-256-GCM encrypted at rest, never logged, and disabled on permanent provider rejection. Lock-screen text is deliberately generic and contains no physiological or private message content.

Readiness is exposed at `/health/ready` on `WORKER_HEALTH_PORT` (default 3001). Alert on:

- oldest non-dead-letter outbox age above 60 seconds;
- any new `dead_lettered_at` value;
- repeated APNs/FCM authentication failures;
- worker readiness failure or stale polling;
- Redis publish or PostgreSQL connectivity errors.

Reprocessing is safe after the underlying cause is fixed: clear `dead_lettered_at`, reset `available_at` to `now()`, and preserve the original `event_uuid`. Never create a replacement event merely to retry delivery.
