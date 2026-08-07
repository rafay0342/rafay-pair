# Security policy

Report suspected vulnerabilities privately to the repository security contact configured in the hosting platform. Do not open public issues containing credentials, personal data, reproduction tokens, or partner-visible health context.

Production releases require threat-model review, dependency and container scanning, secret scanning, infrastructure validation, authorization tests, backup restoration evidence, and closure of all critical or high-severity findings. A jailbreak, root, App Attest, or Play Integrity signal may increase risk scoring but is never the sole authorization decision. Durable server-side consent remains authoritative.

Secrets must be stored in protected CI environments or the deployment secret manager. They must never be committed, logged, sent to client telemetry, or embedded in native or Web artifacts.
