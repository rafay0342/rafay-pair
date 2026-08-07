# Incident response

## Severity

- SEV-1: unauthorized partner access; remote sensor activation; leaked credentials; fabricated or mislabeled physiological data; complete production outage; unrecoverable data loss.
- SEV-2: material authentication, pairing, consent, realtime, AI safety, or notification failure without confirmed unauthorized disclosure.
- SEV-3: isolated functional, performance, accessibility, or delivery degradation with a safe workaround.

The on-call engineer acknowledges SEV-1 in 10 minutes and SEV-2 in 30 minutes. A security/privacy incident immediately freezes releases, disables affected experiment flags, revokes exposed credentials or sessions, preserves audit evidence, and engages the incident commander and privacy owner. Do not delete or mutate forensic logs during containment.

## First checks

1. Confirm scope by environment, version, pair, endpoint, and first observed UTC timestamp without copying health content into chat or tickets.
2. Inspect WAF, ALB, ECS, PostgreSQL, Redis, outbox, and provider health. Durable consent and audit records override transient caches.
3. For partner-data exposure, activate server-side sharing denial, invalidate pair/realtime/AI sessions, and verify privacy pause and disconnect paths independently.
4. For a physiology-labeling defect, disable the affected feature flag globally. Never replace a missing measurement with a generated value.
5. Roll back Web or ECS using the documented immutable release identity. Native mitigations use remote flags and an expedited store release.
6. Publish status updates without personal, relationship, audio, camera, or health data.

SEV-1 and SEV-2 incidents receive a blameless review within five business days. The review includes cause, detection gap, affected data classes, timeline in UTC, consent impact, recovery evidence, corrective owners, and verification dates.
