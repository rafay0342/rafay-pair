# Delivery evidence

The binary-delivery gates in the master specification determine implementation order. A gate remains open until every listed artifact and workflow is validated.

## Gate 1 — Foundation

Status: locally validated on 2026-08-07. Remaining external dependencies: an Apple team identity for real-device signing and protected CI variables for the Android release bundle.

- iOS: Swift 6/SwiftUI foundation implemented; simulator Development build succeeds (`scripts/build-ios.sh`, Xcode 26.6); XCTest and the XCUITest auth smoke pass (`scripts/test-ios.sh`). Real-device development signing still needs an Apple team identity and provisioning authority.
- Android: debug and development APKs build (`make android`, Gradle + JDK 21); `testDebugUnitTest` and `lintDevelopment` pass. `bundleRelease` intentionally requires production Firebase/Play Integrity identifiers from protected CI variables and is skipped locally.
- Web/PWA: production bundle with service worker builds (`pnpm --filter @rafay-pair/web build`); Vitest suites pass (31 tests including accessibility checks); Playwright E2E passes on Chromium and Mobile Safari against the live API (register → pair → consent → care exchange → privacy pause with server confirmation → disconnect).
- API/worker: TypeScript builds; unit tests pass (45 api, 5 worker); database/Redis integration tests pass (16 api, 1 worker, 3 realtime-lease) against the compose containers; migrations 0001–0007 apply cleanly. Container images build and run: `migrate` completes, `api` and `worker` report healthy on `/health/ready`.
- Terraform: AWS configuration formats and validates with Terraform 1.15.8 and AWS provider 6.58.0 (`terraform validate` clean).
- CI: independent server, Web, iOS, Android, container, infrastructure, and security jobs are defined in `.github/workflows/`; every command referenced by the workflows exists in the packages. Full-pipeline runs on GitHub-hosted runners are pending the first push.

Notable fixes made during Gate 1 validation:

- Realtime/notification consent enforcement compared `consent_grants.updated_at` (database clock) with an event `occurred_at` written from the API process clock; sub-second clock skew between the two machines denied freshly consented events. `occurred_at` now comes from the database `now()` in the same transaction.
- Integration tests previously hard-coded a Unix-socket PostgreSQL connection; they now honor `DATABASE_URL`/`REDIS_URL` exactly as CI provides them.
- `pnpm deploy --legacy` left workspace packages as symlinks into the discarded Docker build stage; the API and worker images now deploy with `node-linker=hoisted`.
- On this development machine the compose PostgreSQL/Redis publish on 127.0.0.1:55432/56379 (see `infra/compose/.env`) because a host PostgreSQL and an SSH tunnel occupy the default ports.

No pose, physiology, couple-workout, or AI runtime feature is considered delivered before Gate 1 closes. Gate 1 closure additionally requires a real-device iOS install (Apple team identity) and a CI-produced release bundle for Android.
