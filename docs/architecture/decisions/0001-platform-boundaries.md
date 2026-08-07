# ADR 0001: Independent native clients and a modular server

- Status: accepted
- Date: 2026-08-07

## Decision

RafayPair uses Swift/SwiftUI for iOS, Kotlin/Jetpack Compose for Android, and a separate strict-TypeScript PWA. Platform engines implement the same published contracts independently and are compared through golden fixtures. No mobile UI or engine runtime is shared across platforms.

The backend begins as a TypeScript modular monolith running on Node.js 24 LTS with PostgreSQL as the durable system of record, a Redis-compatible service for transient realtime coordination, a transactional outbox for delivery, and object storage for explicitly permitted artifacts. Qwen realtime AI is isolated behind a consent-aware server broker; provider credentials never reach a distributable client.

## Consequences

Native clients retain direct platform capabilities and independently test their algorithms. Contract and fixture duplication is deliberate; it prevents a shared cross-platform runtime from becoming an implicit product dependency. Server authorization remains authoritative for every partner-visible event and AI tool call.
