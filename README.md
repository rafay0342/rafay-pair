# RafayPair

RafayPair is a pure-native, smartphone-only couple-care and fitness platform. The repository contains independent Swift/SwiftUI, Kotlin/Jetpack Compose, and browser-native TypeScript clients plus a TypeScript API, worker, shared contracts, native algorithm specifications, tests, and AWS infrastructure.

The authoritative product and engineering contract is [`RAFAY_PAIR_FINAL_MOBILE_ONLY_NATIVE_MASTER.md`](./RAFAY_PAIR_FINAL_MOBILE_ONLY_NATIVE_MASTER.md). No wearable, BLE health device, external medical sensor, cross-platform mobile UI runtime, fabricated physiological signal, or remotely activated camera/microphone belongs in this product.

## Toolchain baseline

- Xcode 26.6 / Swift 6.3
- iOS 17 minimum deployment target
- Android SDK 36, AGP 9, Kotlin 2.4, JDK 21
- Node.js 24 LTS and pnpm 11
- PostgreSQL 17, Redis-compatible transient storage, S3-compatible object storage
- Terraform-managed AWS ECS Fargate deployment

Run `make bootstrap`, then `make verify`. Native build behavior remains visible through `xcodebuild` and Gradle; pnpm only orchestrates Web and server packages.

## Credential boundary

Copying `.env.example` creates local configuration only. Production credentials, Apple/Google signing material, APNs/FCM credentials, and the Qwen/Model Studio master key are injected from protected CI or cloud secret stores. Mobile and Web clients never contain provider master credentials.

Qwen is the exclusive planned AI provider, but AI runtime remains deferred until the earlier native binary gates close. See the [provider decision](./docs/architecture/decisions/0003-qwen-exclusive-provider.md) and [backend-only configuration contract](./docs/ai/qwen-provider-contract.md).
