# RafayPair API

The API is a Node.js 24/Fastify modular monolith. PostgreSQL is the canonical store; Redis is used only for short-lived one-time realtime tickets, distributed connection leases, issuance counters, and transient fanout. Start-up intentionally fails when production security configuration is incomplete.

## Local operation

Set `DATABASE_URL`, `REDIS_URL`, `SESSION_PEPPER`, and `EMAIL_TOKEN_PEPPER`, then run:

```bash
pnpm --filter @rafay-pair/api migrate
pnpm --filter @rafay-pair/api dev
```

Readiness is exposed at `/health/ready`, liveness at `/health/live`, and the exact OpenAPI 3.1 contract at `/openapi.yaml`. Validate the checked-in contract with:

```bash
pnpm --filter @rafay-pair/api-contracts validate
```

Production migration is a separate, idempotent release task:

```bash
node apps/api/dist/migrate.js
```

Never let multiple application revisions auto-migrate on boot. The migration runner takes a PostgreSQL advisory lock and rejects changes to an already-applied migration checksum.

## Authentication boundary

- iOS and Android receive opaque 15-minute access tokens and rotating 30-day refresh tokens. Clients store them only in Keychain or Keystore and send the access token as `Authorization: Bearer`.
- Web receives `rafay_access` and `rafay_refresh` HttpOnly cookies plus a readable `rafay_csrf` double-submit token. Every state-changing cookie-authenticated request must copy it into `X-CSRF-Token` and originate from an allowed origin.
- Refresh credentials rotate on every use. Reuse of a rotated token durably revokes its entire session family.
- Only keyed hashes of session and join credentials are stored. Passwords use Argon2id.

Realtime tickets are single-use and offered only through `Sec-WebSocket-Protocol` beside `rafaypair.v1`; URLs remain credential-free and the server echoes only `rafaypair.v1`. Browser tickets target `PUBLIC_WEB_ORIGIN` for same-origin host-only cookies, while native tickets target `PUBLIC_API_URL`. Ticket minting and concurrent sockets are capped per user and session with atomic, expiring Redis records; lease acquisition and renewal fail closed. Established sockets reauthorize durably every five seconds. Replay captures a PostgreSQL high-water mark and reads bounded pages, while a bounded in-memory buffer bridges live events. Each page or live burst performs one durable authorization batch and holds session and pair authorization locks through local socket queueing. PostgreSQL—not Redis—is the durable replay source.

## Relationship authorization

A pair can have no more than two active members, enforced in PostgreSQL as well as in the service transaction. Joining creates every directional consent row as denied. Partner actions serialize on the pair row, then read current pair membership, both privacy states, and the appropriate durable grant inside the authorization transaction. Consent, privacy, and pair-status changes advance an authorization revision stamped onto each event, preventing queued or replayed data from becoming visible after revocation/re-grant. Privacy pause overrides all grants. Disconnect marks all memberships ended and all grants denied before returning.

Care sends require the recipient's `care_requests` grant. `clientRequestId` is a mandatory offline-safe idempotency key; reusing it with a different payload is rejected.
