# Backend security and operations

## Required production secrets

The API and worker consume secrets only from the deployment secret store. Required values are:

- `SESSION_PEPPER`: at least 32 random bytes for keyed credential hashes;
- `EMAIL_TOKEN_PEPPER`: a separate value used for pair join-code hashes in Gate 1;
- `DEVICE_TOKEN_ENCRYPTION_KEY`: exactly 32 random bytes encoded as 43-character base64url;
- `PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON`: backend-only Google service-account or workload-identity-federation credentials used solely to decode Android Play Integrity tokens;
- APNs and FCM credentials for the worker when the corresponding native channel is enabled.

`PUBLIC_API_URL=https://api.rafaypair.com` and the distinct `PUBLIC_WEB_ORIGIN=https://app.rafaypair.com` are mandatory in production. Native realtime endpoints use the direct API origin; browser realtime endpoints use the same-origin Web edge so host-only session and CSRF cookies remain valid. TLS terminates only at an approved load balancer/WAF, forwarded-header trust is disabled unless the deployment explicitly enables and constrains it, and browser origins are an allowlist rather than a wildcard.

PostgreSQL transport is verified end to end. The API, migration task, and worker explicitly load the checksum-pinned AWS RDS root bundle from `DATABASE_CA_CERT_PATH`, set `rejectUnauthorized: true`, and retain hostname validation. Production startup fails if the path is absent, relative, unreadable, contains non-certificate material, or contains anything other than bounded self-signed root CAs.

Rotate peppers and encryption keys through a planned dual-read migration; changing them in place invalidates credentials or makes registered device tokens unreadable. Provider master credentials and Qwen credentials never belong in a client binary or browser bundle.

Android Play Integrity uses a two-minute, one-time session-family challenge and Google-managed Standard-token decryption. The API validates package, content-bound request hash, freshness, a Play signing-certificate allowlist, and the supported `versionCode` floor before storing only sanitized risk labels in the append-only assessment table. Provider tokens, certificate digests, and Google credentials are never stored or logged. The signal informs telemetry only; authentication, privacy, pair, and consent authorization continue to come from their existing durable checks. See [Android Play Integrity](../security/android-play-integrity.md).

iOS App Attest uses the same bounded session-family challenge service with server-owned canonical client data. The API pins Apple's public App Attestation root, validates the full attestation nonce/App ID/environment/key binding, stores only the verified public key and receipt, and enforces assertion counters atomically. Unsupported and rejected proofs remain risk telemetry, never authorization. See [iOS App Attest](../security/ios-app-attest.md).

## Durable and transient boundaries

PostgreSQL owns users, sessions, pair membership, consent, privacy, care requests, realtime replay records, notification registrations, audit records, and the outbox. Consent and privacy decisions never come from Redis. Redis contains only short-lived one-time WebSocket tickets, hashed ticket-issuance counters, hashed expiring connection leases, and pub/sub fanout. It never stores realtime event payloads.

Consent, privacy, and security audit tables are append-only through database triggers. Backups must use encrypted storage and point-in-time recovery. Restore exercises must verify that the highest realtime event sequence, consent audit chain, and outbox state agree before traffic is reopened.

## Realtime recovery

The authenticated REST call that creates a ticket binds it to a user, session, pair, and optional last event ID. Redis consumes it atomically with `GETDEL` and a 30-second TTL; atomic sorted-set windows cap ticket minting even when tickets are consumed rapidly. After durable authorization, the gateway atomically acquires per-user and per-session connection leases, renews them before expiry, releases them on disconnect, and fails closed if Redis is unavailable. Crash-orphaned leases expire automatically.

The gateway subscribes before capturing a PostgreSQL replay high-water mark, buffers concurrent events up to `REALTIME_MAX_BUFFERED_EVENTS`, reads replay in `REALTIME_REPLAY_PAGE_SIZE` pages, and flushes the buffer with event-ID deduplication. This recovers long authorized gaps without a fixed 500-event disconnect. Durable rows and current consent are authorized in batches, with the session and pair locks held until each local send is queued. Operators should alert on `realtime connection lease denied`, lease renewal failures, replay buffer exhaustion, and sustained multi-page replay logs; identifiers and ticket secrets are excluded from these records.

HTTP abuse limits use the same managed Redis boundary so login, registration, pair-code, and global request ceilings remain consistent across API containers. The counter update and expiry are one Lua operation, raw client keys are HMACed before storage, and Redis errors fail closed instead of silently bypassing a security limit.

Privacy pause and disconnect are committed before their control events are published. Every subsequent partner action rechecks PostgreSQL, so a missed transient notification cannot restore access. Connected sockets close after a pause or disconnect control event and require a newly authorized ticket to reconnect.

## Incident response

For suspected credential compromise, revoke the affected `auth_sessions.family_id`; do not delete its history. For pair abuse, privacy pause is the immediate user control and disconnect is the durable relationship revocation. Preserve append-only audit rows, request IDs, outbox event UUIDs, and provider response metadata; never copy device tokens, authorization headers, cookies, messages, or physiological context into incident chat or logs.

OpenTelemetry export is enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Logs redact authorization, cookies, and set-cookie headers. Health endpoints expose availability only and return no secret or user data.
