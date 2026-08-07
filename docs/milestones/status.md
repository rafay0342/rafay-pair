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

### Microphone breathing (master specification §6C)

Implemented end to end: `engines/breathing-estimation-spec/MICROPHONE.md`, engine, golden vectors, three ports, capture on iOS (`AVAudioEngine`) and Android (`AudioRecord`, `UNPROCESSED` source), and UI. Breath sounds carry rhythm the camera cannot see — under a blanket, in the dark, out of frame.

Raw audio is never retained, and that is structural: the estimator's input type carries only per-hop features, so audio cannot cross the boundary even by mistake. Listening is opt-in inside a session the user already started. Parity is split into two contracts — feature extraction from raw PCM, and rate recovery from features — so a failure says which half broke.

Validating it exposed a real flaw in the shared core. Breath sound peaks twice per cycle, loud on the inhale and again on the exhale, so the subharmonic ratio test halved every measured rate; replacing it with a margin test then broke the pulse estimator in the opposite direction. The resolution is that harmonic folding is a property of the signal's physics rather than a tuning constant, so each estimator now declares it: one signal cycle per event for a heartbeat, two energy bursts per cycle for breath.

### Face-camera rPPG (master specification §3.3)

Implemented end to end and shipping **off**, which is what "experimental" means here. Every rule the specification attaches is enforced structurally rather than editorially: `FACE_RPPG_ENABLED` is a single flag, `experimental` is a literal on the result type, thresholds are stricter than the fingertip estimator's throughout, and §6 of its specification bars the result from animating the heart, from the consent-gated share, and from the stored latest pulse.

The lighting gate is the substantive addition. Slow illumination drift produces exactly the oscillation an rPPG estimator mistakes for a pulse — the golden vector for it carries a periodicity of 0.83, which would otherwise have been reported as a confident rate. The torch removes that problem on the fingertip path; here it has to be caught, so a session whose brightness swung too far is refused outright.

### Web finger-camera pulse

Not implemented, and the Web client says so. The measurement needs the rear lens with its torch lit and its exposure locked; browsers expose neither reliably, and without a lit fingertip the signal is not recoverable. The master specification anticipates exactly this: web pulse is separately qualified by device capability. Guided breathing, which needs no sensor, runs in the browser from the same deterministic schedule the phones use.

## Gate 4 — Together mode and Rafay AI

Status: server, authorization layer, and all three client surfaces implemented and validated locally on 2026-08-07. Not closed: the voice transport needs a provider account before an end-to-end voice session can be demonstrated, and closure inherits the same real-device evidence the earlier gates are waiting on.

**Together mode** (master specification §10). Both phones detect their own user and exchange only derived state — repetition count, exercise phase, set index, elapsed time, estimated calories, breathing phase. That is enforced structurally rather than by policy: `together_participant_states` has no column, and `togetherParticipantStateSchema` no field, through which a frame, a landmark, or an audio sample could pass. A Kotlin unit test enumerates the declared properties of the transport type and fails if a new one is ever named for media.

- One open session per pair, enforced by a partial unique index rather than by application logic, so two simultaneous invitations cannot both win.
- Partner state is filtered against the _current_ grant at read time, not at write time. Revoking workout sharing therefore hides progress that is already stored, mid-session, without a cleanup job.
- Ending a session deletes the state that was exchanged.
- While a session is active the workout engines publish on a fixed two-second cadence rather than per frame — publishing per frame would put the pose sampling rate itself on the wire, which is a detail of what the camera saw. A final publish on session end settles the partner's screen on the real total.
- The phase vocabulary contains no `ascending`, because the posture classifier does not distinguish it. Reporting one would be inventing a phase.

**Rafay AI.** The server is the broker; the provider is only a media and language transport. Authorization is never delegated to the model.

- `invokeTool` runs allowlist → schema → privacy re-check → execute, in that order, and every mutating tool requires `context.confirmed` — the assistant cannot confirm on its own behalf.
- Tool invocations are recorded with `UNIQUE (session_id, call_id)`, so a replayed call id cannot execute twice.
- The identity disclosure is supplied by the server, not composed by a client, so a client cannot quietly drop or reword it. It is announced at the start of every session.
- Memory is per-account and never travels with the pair. Entries the model proposed are stored with `author = 'assistant'` and are marked as such in all three interfaces, so it is always clear which entries the user actually said.
- Camera-derived numbers reach the model with their provenance attached, and the instructions require them to be spoken about as estimates rather than measured readings.

**Provider.** `QwenRealtimeProvider` implements the documented realtime event protocol. Model and region are exact allowlists rather than free configuration — an arbitrary value there would turn deployment config into an unrestricted server-side egress target — and the endpoint is derived from validated parts instead of accepted whole. When nothing is configured, `UnavailableProvider` refuses to open rather than returning plausible audio; an unconfigured deployment that looks functional is the one failure mode a voice feature must not have.

One fault was found by the module's own test and fixed rather than documented: the API key was reachable through `JSON.stringify(provider)`, because TypeScript's `private` is erased at runtime and leaves an enumerable own property. It is now a `#` field, which is invisible to serialization.

**The voice bridge.** Audio flows client → server → provider and back. The server sits in the middle deliberately: it holds the provider credential, it composes the instructions, and it is the only thing that may authorize a tool call. A client that spoke to the provider directly would have to be trusted with all three.

- The socket is opened with a single-use ticket carried in the subprotocol header, never in a query string — a credential in a URL is written into every proxy and access log on the path. Only the ticket's hash is stored, and redemption clears it in the same conditional `UPDATE` that checks it, so two sockets racing on one ticket cannot both be admitted.
- The socket is refused until `identity_announced` is true. Generated audio cannot reach someone who was never told what they are hearing, and that is a database predicate rather than a client convention.
- A second connection to a live session is refused rather than silently taking over the first one's audio.
- Tool calls from the model are routed back through the same `invokeTool` authorization and the same audit row as the HTTP dispatch route. There is no second, looser path for the socket. A mutation still stops and asks the user in their interface — never by voice, because a spoken "shall I?" answered aloud would make the model both the asker and the recorder of the answer.
- Both native clients validate the server-supplied socket URL against their configured API origin before connecting. A redirected socket would carry a live microphone wherever the redirect pointed; iOS and Android each have tests that refuse a different host, a different port, a different path, and any URL carrying a query or credentials.
- Capture and playback are torn down on every stop rather than left allocated, so "the session ended" and "the microphone is off" cannot come apart. The listening indicator reads the audio engine's actual state, not the app's belief about it.
- Nothing writes audio or transcript to disk or to the database. The session row records that a session ran and how much of the allowance it used; what was said is not ours to keep.

The iOS microphone usage string was rewritten while building this. It previously said audio is never uploaded, which was true when breathing was the only use of the microphone and would have become false the moment a voice session opened. It now describes both uses separately and says plainly that nothing listens outside them.

**Surfaces.** Together mode, the memory controls, and the voice session are built natively on all three clients — SwiftUI (`Features/Together/TogetherView.swift`), Compose (`ui/together/TogetherScreen.kt`), and React (`pages/TogetherPage.tsx`, `pages/AssistantPage.tsx`). Voice runs on the phones, where the microphone state is visible for the whole session and the disclosure stays on screen for its whole duration rather than appearing once and scrolling away; the Web client says so and offers the memory controls, because a user is entitled to read and delete what is remembered about them in the same place they read anything else about their account.

## Final checklist — production readiness

Status: all twenty-six items of master specification §30 checked on 2026-08-07. Twenty-two pass with a command, a test, or a structural property behind them. Four are open, and none of the four is open because it was skipped: a signed IPA needs an Apple ID that only the account holder can add, real-device pulse validation needs a real fingertip and a reference reading, a live voice session needs a provider account, and metrics are the one place where the honest answer is "partly built".

The evidence, item by item, is in [the final checklist](./final-checklist.md).

Checking it turned up four user-facing statements that were untrue and are now fixed: the Web capability map called camera pose unsupported in a release that ships it, the home page denied showing any derived number while showing repetition counts and calories, all three clients offered a blood-pressure entry and a Health import that do not exist, and the iOS microphone string promised audio is never uploaded after voice sessions made that false. Two of them are now held in place by tests rather than by care.

One guarantee gained a real check rather than a restatement. "Camera/mic cannot be remotely activated" is a claim about reachability, so `pnpm run verify:invariants` reads every module that consumes something the network delivers — realtime clients, push handlers, background sync, the service worker — along with every server module, and fails if any of them so much as names a capture API. A module that cannot name the camera cannot turn it on, whatever message reaches it. The check was confirmed to fail when a capture call is planted in the service worker, and it runs in `pnpm verify` and in CI.

"Pair disconnect revokes all partner access" gained the same treatment. It was covered for care alone; the integration test now proves the partner also loses the pulse snapshot and the together session, asserting each surface separately so a future surface that forgets the pair check fails there rather than passing on care's strength.

## Build and device setup

Three things previously listed as blockers are now handled in the repository rather than left to manual steps.

**Web pose model.** `scripts/fetch-pose-model.mjs` runs before every Web build and dev server. It copies the MediaPipe runtime out of the installed npm package and downloads the BlazePose model, verifying its SHA-256 against a pinned digest. The assets are cached at runtime by the service worker rather than precached, so an installed PWA keeps working offline after one workout without a tens-of-megabytes first install. If the network is unavailable the build still succeeds and the Move page reports local pose unavailable; there is no server fallback path in the client.

**iOS on a real device.** `scripts/build-ios-device.sh` signs with automatic provisioning and installs onto a connected iPhone. No paid Apple Developer membership is involved — a personal Apple ID is enough for a seven-day development install. The team identifier comes from `RAFAYPAIR_DEVELOPMENT_TEAM` or a git-ignored `apps/ios/Config/Local.xcconfig`, and when neither is present the script prints the exact one-time Xcode account steps instead of failing obscurely.

**Android release identifiers.** `docs/operations/android-release-credentials.md` walks through obtaining the four Firebase values and the one Play Integrity value from scratch, and explains which single item is actually secret. Values may now live in a git-ignored `apps/android/local.properties` rather than only in environment variables. Verified end to end: `bundleRelease` succeeds once the five identifiers are present.

What still needs a person: the Xcode account on this machine has half-signed-in credentials (`missing Xcode-Username`), which the command line cannot repair; re-adding the Apple ID in Xcode → Settings → Accounts is a one-time GUI action. Real-device validation of finger-camera pulse additionally needs a reference reading — a smartwatch, a pulse oximeter, or a manually counted rate — because a simulator has no fingertip and no torch, and an estimate with nothing to compare against is not evidence.
