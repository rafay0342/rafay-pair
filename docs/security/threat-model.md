# Threat model

## Protected assets

Credentials and refresh tokens; pair membership; directional consent; privacy state; care content; partner-visible derived fitness and physiology events; Qwen context and tool authorization; notification tokens; audit records; signing keys; provider and cloud credentials.

## Trust boundaries

Native and Web clients are untrusted authorization callers. TLS terminates at the managed load balancer/WAF, then requests enter private API tasks. PostgreSQL is the durable authorization authority. Redis carries transient fanout only. The worker reads the transactional outbox. Qwen receives only the context approved for the current disclosed session through a backend-owned broker; it cannot query partner data or execute tools directly.

## Primary abuse cases and controls

| Abuse case                              | Required control                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pair-code guessing or reuse             | high-entropy short-lived hashed codes, rate limits, one successful use, atomic two-member limit, audit event                                                                                  |
| Stolen access token                     | short lifetime, hashed server sessions, refresh rotation with family-reuse detection, Keychain/Keystore or HttpOnly cookies, global revocation                                                |
| Cross-site request forgery              | SameSite secure cookies, synchronizer token header, strict Origin allowlist; bearer native calls do not use cookies                                                                           |
| Partner reads disabled data             | default-deny directional scope check against PostgreSQL on every mutation/fanout; cache cannot grant access                                                                                   |
| Queued event leaks after consent change | idempotent sync plus fresh consent and pair-revision check immediately before publication                                                                                                     |
| Partner starts a sensor                 | no remote sensor-start command exists; local visible user action and OS permission are both required                                                                                          |
| Raw media disclosure                    | pose and physiology stay on device; no raw-frame upload endpoint; breathing audio is not retained; video calling is a separate mode                                                           |
| AI bypasses consent                     | server builds context after durable authorization, allowlists tools, validates schemas, binds tool calls to user/session, and requires confirmation for mutations                             |
| Client tampering                        | backend authorization, TLS, content-bound one-time Play Integrity/App Attest risk signals, rate limits, anomaly alerts; attestation or root/jailbreak state is never sole authorization logic |
| Insider or cloud credential misuse      | least-privilege roles, KMS, protected environments, secret rotation, audit logs, private subnets, break-glass review                                                                          |
| False health claim                      | provenance/algorithm version/confidence required, BP derivation absent from production, stale-value state machines, policy tests                                                              |

Release review requires no open critical or high findings. Medium findings need an owner, bounded exposure analysis, and deadline. Authorization, privacy pause, disconnect, token replay, CSRF, object-level access, and AI tool tests are mandatory on every material change.
