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
- On this development machine the compose PostgreSQL/Redis publish on 127.0.0.1:55432/56379 (see `infra/compose/.env`) because a host PostgreSQL and an SSH tunnel occupy the default ports. The Playwright stack has the same hazard on port 3000, where a tunnel answers the health probe convincingly enough that Playwright skips starting the real API; its ports are now parameterized through `RAFAYPAIR_E2E_API_PORT`, `RAFAYPAIR_E2E_WEB_PORT`, and `RAFAYPAIR_E2E_WORKER_PORT`.

Gate 1 closure additionally requires a real-device iOS install (Apple team identity) and a CI-produced release bundle for Android. Both need credentials that are not held in this repository.

## Gate 2 — Camera intelligence

Status: engines and camera pipelines implemented and validated locally on 2026-08-07. Not closed: closure requires the same real-device evidence Gate 1 is waiting on, plus a provisioned Web pose model asset.

The specification requires camera pose on all three clients with **golden test parity**, which shapes the design: pose _inference_ is platform-specific and cannot be made reproducible, so the parity contract begins at the landmarks. Everything downstream — canonical skeleton, normalization, smoothing, geometry, posture classification, and the exercise state machine — is specified normatively in `engines/pose-spec/SPEC.md` and `engines/exercise-state-machines/SPEC.md` and implemented three times, independently, with no shared code.

- Parity vectors: `tests/golden/pose` (8 static posture cases) and `tests/golden/exercise` (8 scenarios, ~1,900 frames) are generated from a parametric, anthropometrically proportioned skeleton so ground truth is exact. Discrete outputs are asserted exactly; continuous values within `1e-6`, because `atan2` is not guaranteed bit-identical across C libraries.
- TypeScript (`packages/pose-engine`, also the Web engine): 21 tests pass.
- Swift (`apps/ios/RafayPair/Core/Pose`): 27 unit tests pass, including the full parity suite read from the same JSON files.
- Kotlin (`apps/android/.../pose`): 7 parity tests pass, reading the same JSON files as test resources.
- Camera capture, on-device only: iOS uses Vision (`PoseCaptureSession`), Android uses CameraX with ML Kit (`PoseCaptureController`), Web uses `getUserMedia` into a Web Worker running MediaPipe Tasks Vision (`CameraPoseController`). Each is a single auditable boundary: the frame buffer is scored and released, never retained, encoded, stored, or transmitted.
- Local workout surfaces exist on all three clients (a "Move" destination) reporting sit, stand, lie-down, squat, and repetition count with form hints, and stating plainly that nothing is shared without a separate consent choice.

Design decisions worth recording:

- **Sitting versus a squat bottom is not decidable from one frame.** The skeletons are near identical. The static classifier therefore reports `crouched` for both, and the state machine separates them temporally: sitting requires a stable hip height held for 2.5 s, while a squat is an excursion from standing and back. Committing to sitting or lying cancels any repetition in flight, so standing up from a chair never counts as a squat.
- **The stability window is trailing, not whole-run.** A crouched run necessarily begins part-way through the descent, so measuring spread over the entire run would keep it permanently outside the band and a genuinely seated subject would never settle.
- **The engine is invariant to mirroring and to left/right labelling.** Vision, ML Kit, and BlazePose do not document laterality identically. Rather than guess per platform, every derived quantity is a midpoint, a mean, or an unsigned angle, so the question does not arise. This removed the per-platform mirroring code that would otherwise have been an untested source of divergence.
- **The Web pose model is provisioned, not committed.** The MediaPipe runtime and model are multi-megabyte binaries; `apps/web/public/models/README.md` documents fetching them at build time. When absent, the Move page says local pose is unavailable and stops — there is no server-side fallback path in the client, by design.

No physiology, couple-realtime, or AI runtime feature is considered delivered before Gate 2 closes.

## Gate 3 — Phone physiology

Status: engines, capture, sharing, and surfaces implemented and validated locally on 2026-08-07. Not closed: closure inherits the same real-device evidence Gate 1 and Gate 2 are waiting on, and finger-camera pulse in particular cannot be validated on a simulator at all — it needs a real fingertip, a real torch, and a reference reading to compare against.

Built with the same specification-first, golden-parity approach as the pose engines. Four normative specifications (`engines/signal-quality`, `engines/pulse-estimation-spec`, `engines/breathing-estimation-spec`, `engines/calorie-estimation-spec`) implemented three times independently: TypeScript (31 tests), Swift (33), Kotlin (13). Vectors live in `tests/golden/pulse`, `tests/golden/breathing`, and `tests/golden/calories`.

- **Finger-camera pulse** on iOS (AVFoundation) and Android (CameraX), with the torch lit and exposure and white balance locked — automatic adjustment would chase the pulsation and suppress the signal being measured. Each frame is reduced to two channel means over a centred region and released; nothing is retained, encoded, or transmitted.
- **Signal quality and confidence** are separate numbers by design: quality describes the signal, confidence describes the estimate. Both are reported, and a rejection carries its metrics so the interface can name the first thing the user can act on rather than only saying it failed.
- **Consent-gated sharing** through `pulse_snapshots`: the owner grants, the partner reads, revocation blocks the read immediately, and the realtime path re-checks the same grant so a queued snapshot stops in flight.
- **Guided breathing** is a deterministic schedule with no physiological claim, so it is identical on all three clients and two partners can follow the same rhythm without either device being authoritative.
- **Estimated calories** appear in every workout summary with an explicit band and the list of inputs that produced them.
- **Blood pressure** is stated as unsupported on every client. There is no table, no contract field, and no code path that computes one.

Two algorithmic faults were found while validating the vectors and fixed in the algorithm rather than tuned around:

- **Octave error.** Autocorrelation peaks just as strongly at whole multiples of the true period, so an unguarded maximum reported half the real rate — 124 BPM read as 62, 88 as 44, 14 breaths per minute as 7. A fabricated-but-plausible number is worse than no number. Subharmonic suppression compares the candidate at `lag / k` against the peak: a genuine subharmonic correlates comparably, a false one lands antiphase and correlates negatively.
- **Filter not matched to the search band.** The breathing smoothing window was chosen for mild denoising rather than for the top of the band being searched, so ordinary fidgeting at 1.4 Hz survived it and won the correlation peak, producing a confident wrong rate. The window is now matched to the band, and both estimators additionally reject with `unstable` when per-window rates disagree — a rate that jumps between windows is not a rate.

Deliberate omissions, recorded rather than left silent:

- **Web finger-camera pulse is not implemented.** The measurement needs the rear lens with its torch lit and its exposure locked; browsers expose neither reliably. Shipping a browser version would mean a worse estimate under the same label, so the Web client says where the measurement lives instead. The master specification anticipates this: web pulse is separately qualified by device capability.
- **Microphone breathing (master specification §6C) is not implemented.** It needs an audio capture path with its own retention rules, and the camera estimate already covers the same product need; adding microphone permission exposure for no user-visible gain was not justified in this gate.
- **Face-camera rPPG (§3.3) is not implemented.** It is explicitly optional and experimental in the specification.
