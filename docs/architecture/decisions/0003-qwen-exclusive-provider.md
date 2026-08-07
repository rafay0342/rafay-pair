# ADR 0003: Qwen is the exclusive planned AI provider

- Status: accepted; runtime implementation deferred
- Date: 2026-08-07

## Context

The master specification places realtime Rafay AI in Phase E and the fourth native binary delivery milestone. Gate 1 is still open, so selecting a provider must not create an AI route, session broker, client SDK, provider connection, or incomplete production code path.

## Decision

RafayPair selects Alibaba Cloud Model Studio Qwen as its exclusive planned AI provider. The planned realtime model is `qwen3.5-omni-plus-realtime` in the Singapore (`ap-southeast-1`) region. Other-provider credentials, endpoints, SDKs, model identifiers, compatibility layers, and fallback providers are not part of the product architecture.

The permanent Model Studio credential remains in the backend secret manager. It must never be compiled into Swift, Kotlin, browser JavaScript, WebAssembly, mobile resources, client environment variables, downloadable configuration, logs, analytics, or crash reports.

Every AI session remains behind RafayPair's authenticated, consent-aware backend broker. The broker owns context filtering, durable consent checks, tool authorization, confirmation of mutations, rate limits, usage controls, audit metadata, and provider egress. Provider support for temporary credentials does not weaken this boundary. A future direct media transport may be considered only after the earlier delivery gates close and only with a server-issued, short-lived, scoped credential; if provider scoping cannot prevent bypass of RafayPair authorization, direct transport stays disabled.

## Consequences

- Gate 1 contains configuration and architecture documentation only; no AI runtime is enabled.
- The planned backend configuration contract is defined in [`../../ai/qwen-provider-contract.md`](../../ai/qwen-provider-contract.md).
- Clients communicate only with authenticated RafayPair endpoints and never receive the permanent Qwen key.
- Provider failover requires a new reviewed ADR, threat-model update, consent review, and explicit product decision. Silent fallback is prohibited.
