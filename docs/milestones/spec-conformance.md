# Specification conformance, section by section

Every numbered section of `RAFAY_PAIR_FINAL_MOBILE_ONLY_NATIVE_MASTER.md`, what
implements it, and what proves that. Checked on 2026-08-08 against the tree, not
against memory.

This document exists because a delivery checklist is not a specification. The
four gates and the §30 checklist were all passing while §8 did not exist at all,
§6B was a library with no caller, §5's manual entry had never been built, and
none of §24's six flags existed by name. Reading the specification in order is
what found them.

Where a section is not fully met, it says so in the same words it would use if it
were — and says what is missing, not that it is "planned".

---

## Part I — Product

| §   | Section                       | State                 | Evidence                                                                                                                                                                                                                        |
| --- | ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Absolute product constraint   | Met                   | No accessory is required or referenced. Verified by the §18 sweep below.                                                                                                                                                        |
| 1   | Revised platform targets      | Met                   | iOS Swift (63 files, no Objective-C), Android Kotlin (73 files, no Java), Web TypeScript. No cross-platform mobile runtime in any manifest or lockfile.                                                                         |
| 2   | Smartphone sensor matrix      | Met                   | Camera (pose, fingertip pulse, face rPPG, chest-motion breathing), microphone (breath rhythm, AI voice). No other sensor is read.                                                                                               |
| 3   | Heart rate — phone only       | Met                   | Fingertip PPG on both phones with torch and locked exposure; face rPPG behind `camera_ppg_face_mode`. `engines/pulse-estimation-spec`, golden vectors, three ports.                                                             |
| 4   | Heartbeat visualization       | Met                   | The heart animates only while the estimate is fresh, and rests otherwise. `PulseFreshness` decides, not the screen.                                                                                                             |
| 5   | Blood pressure policy         | Met                   | `blood_pressure_readings` accepts manual entry and imported records only. No camera, face, voice, or model path exists, and `source`/`measurement_kind` constraints make a derived row unwritable. Integration test.            |
| 6A  | Guided breathing              | Met                   | Deterministic schedule, identical on all three clients, no physiological claim.                                                                                                                                                 |
| 6B  | Camera chest-motion breathing | Met                   | `chestSampleFromLandmarks` in three languages, distance-invariance test on each, capture wired on both phones behind `camera_breathing_estimate`.                                                                               |
| 6C  | Microphone breathing          | Met                   | `engines/breathing-estimation-spec/MICROPHONE.md`, three ports, capture on both phones. Raw audio cannot cross the boundary: the estimator's input type carries only per-hop features.                                          |
| 7   | Calories                      | Met                   | Every summary states an estimate with a band and the inputs used. Body mass widens the band rather than being guessed.                                                                                                          |
| 8   | Veins Alive                   | Met                   | All three clients. Rests rather than inventing a rate; provenance has no `measured` case; the disclosure sits above the picture. Behind `living_body_advanced`.                                                                 |
| 9   | Pose detection                | Met                   | iOS Vision, Android ML Kit, Web MediaPipe. `engines/pose-spec` and `engines/exercise-state-machines`, golden vectors, three independent ports.                                                                                  |
| 10  | No-hardware experience        | Met, with one note    | Together mode exchanges derived state only, enforced structurally. See the note below on the shared pulse.                                                                                                                      |
| 11  | Realtime mobile AI            | Met, needs an account | Broker, tool authorization, memory, identity disclosure, and the voice socket are built and tested. A live session needs Model Studio activated for the workspace.                                                              |
| 12  | iOS strict-native             | Met                   | Swift 6, strict concurrency, no third-party UI runtime.                                                                                                                                                                         |
| 13  | Android strict-native         | Met                   | Kotlin, Compose, dependency verification metadata.                                                                                                                                                                              |
| 14  | Web without mobile frameworks | Met                   | React and TypeScript only; the engine packages are parity implementations, not a shared UI runtime.                                                                                                                             |
| 15  | HealthKit / Health Connect    | Partly                | The import **route** exists and is tested; no native repository integration is wired yet, so an import must currently be posted by a client rather than read from Health. Features work without it, which is what §15 requires. |
| 16  | Repository tree               | Met                   | Matches, with `packages/experiment-flags` added for §24.                                                                                                                                                                        |
| 17  | Milestones                    | Met                   | Gates 1–4, recorded in `status.md`.                                                                                                                                                                                             |
| 18  | Deleted concepts              | Met                   | Zero matches for watchOS, Wear OS, chest strap, connected cuff, or external sensor. The only "bluetooth" strings in the tree are `Permissions-Policy` headers that **deny** it.                                                 |
| 19  | MVP definition of done        | Met, minus the IPA    | Every line is now satisfiable except "iOS produces an installable IPA", which needs a signing identity. See the open item.                                                                                                      |
| 20  | Agent final directive         | —                     | Instruction to the agent, not a product requirement.                                                                                                                                                                            |

**The note on §10.** The specification lists `latest_user-approved_pulse` among
the derived events a together session may exchange. It is not in the together
payload here. Pulse sharing is implemented as its own consent-gated channel
(`pulse_snapshots`, capability `pulse_snapshots`), because pulse has a consent
switch of its own and folding it into the workout payload would let a workout
grant carry a physiological one. The capability is present; the routing is
deliberately different, and this is the one place where that is true.

---

## Part II — Platform and binaries

| §   | Section                      | State                  | Evidence                                                                                                                                                                                            |
| --- | ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Execution rule               | Met                    | Gates delivered in order; each proved before the next began.                                                                                                                                        |
| 1   | Platform outputs             | Partly                 | APK, AAB, and the Web bundle are produced and signed. The IPA needs a signing identity.                                                                                                             |
| 2   | iOS engineering stack        | Met                    | SwiftUI, AVFoundation, Vision, `AVAudioEngine`, Swift 6 strict concurrency.                                                                                                                         |
| 3   | Android engineering stack    | Met                    | Compose, CameraX, ML Kit, `AudioRecord`/`AudioTrack`, Gradle dependency verification.                                                                                                               |
| 4   | Web engineering stack        | Met                    | Vite, React, TypeScript, MediaPipe WASM self-hosted and digest-pinned.                                                                                                                              |
| 5   | Native engine boundaries     | Met                    | Engines share no code across platforms; parity is held by committed vectors.                                                                                                                        |
| 6   | Cross-platform golden tests  | Met                    | `tests/golden/**`, consumed by all three ports.                                                                                                                                                     |
| 7   | Build orchestration          | Met                    | `Makefile` and `scripts/*` build every target from the terminal.                                                                                                                                    |
| 8   | CI matrix                    | Met                    | Server, web, iOS, Android, instrumented, containers, infrastructure, SAST, security.                                                                                                                |
| 9   | iOS pipeline                 | Partly                 | `scripts/archive-ios.sh` archives and exports; export needs an identity. `scripts/build-ios-personal.sh` produces a 7-day personal-team build without push or App Attest.                           |
| 10  | Android pipeline             | Met                    | Signed APK and AAB produced from the terminal and verified with `apksigner`.                                                                                                                        |
| 11  | Web pipeline                 | Met                    | Production bundle, service worker, digest-pinned model fetch.                                                                                                                                       |
| 12  | Backend stack                | Met                    | Fastify-style TypeScript, PostgreSQL, Redis.                                                                                                                                                        |
| 13  | Backend runtime              | Met                    | Containers, health endpoints, migrations with checksums.                                                                                                                                            |
| 14  | Server deployment            | Met                    | Terraform for managed cloud; `infra/compose/docker-compose.vps.yml` and `scripts/deploy-vps.sh` for a single host. Deployed and serving at a real certificate.                                      |
| 15  | Web serving                  | Met                    | Immutable releases, `scripts/deploy-web.sh`, `scripts/rollback-web.sh`.                                                                                                                             |
| 16  | Source code quality          | Met                    | Formatters, linters, and typecheckers on every workspace; `pnpm verify` runs all of it.                                                                                                             |
| 17  | Size and performance budgets | Partly                 | Sizes have measured baselines and enforced ceilings that fail CI. Cold start, warm start, memory, CPU, GPU, thermal, battery, and network need a device; each is listed unbudgeted with the reason. |
| 18  | Feature parity policy        | Met                    | Capability map on the Web client, held to the shipped surfaces by a test.                                                                                                                           |
| 19  | Security of native binaries  | Met, minus attestation | App Attest and Play Integrity are implemented; enforcement needs the paid Apple program and Google credentials, and the deployment says so rather than pretending.                                  |
| 20  | Realtime interactivity       | Partly                 | Pose geometry and session scoring have enforced ceilings. Tap feedback, partner sync, and AI turn start need a device and a paired session.                                                         |
| 21  | Offline behavior             | Met                    | Care drafts, queued sync, idempotent replay, consent revalidation before publishing queued partner-visible data.                                                                                    |
| 22  | Database and events          | Met                    | Outbox, realtime events, authorization revision, twelve checksummed migrations.                                                                                                                     |
| 23  | Versioning                   | Met                    | Version code and name per build type; API contracts versioned under `/v1`.                                                                                                                          |
| 24  | Experiment flags             | Met                    | All six, by name, in three registries with parity tests. Every one ships off.                                                                                                                       |
| 25  | Release channels             | Met                    | Android debug/development/staging/release; Web preview/staging/production; backend dev/staging/production.                                                                                          |
| 26  | First milestone              | Met                    | Gate 1.                                                                                                                                                                                             |
| 27  | Second milestone             | Met                    | Gate 2.                                                                                                                                                                                             |
| 28  | Third milestone              | Met                    | Gate 3.                                                                                                                                                                                             |
| 29  | Fourth milestone             | Met                    | Gate 4.                                                                                                                                                                                             |
| 30  | Final agent checklist        | 23 of 26               | [final-checklist.md](./final-checklist.md), item by item.                                                                                                                                           |
| 31  | Final build directive        | Met                    | Identity holds: pure-native, smartphone-only, no external health hardware.                                                                                                                          |

---

## What is genuinely open

Four things, none of them unwritten software.

1. **A signed IPA.** The free personal team `HPBV3NY87T` cannot sign this app:
   Apple restricts Push Notifications and App Attest to the paid Developer
   Program, and the audited entitlements declare both.
   `scripts/build-ios-personal.sh` produces a 7-day build without them, and must
   be run from Terminal.app because signing reads a key an automation session
   cannot reach. The real IPA needs the paid membership.
2. **Real-device validation of finger-camera pulse.** Needs a fingertip, a
   torch, and a reference rate to compare against. A simulator has none of them.
3. **A live voice session.** The transport, the authorization, and both clients
   are built and tested against a real Model Studio workspace — the handshake
   reaches `session.created`. Using a model returns
   `AccessDenied.Unpurchased`, which means the workspace has no model
   entitlement yet; activation is a console action.
4. **Device-side performance numbers.** Cold start, memory, battery, thermal,
   and network usage under a real workout.

## What changed because of this pass

Reading the specification section by section rather than re-reading the delivery
checklist found five things, and four of them were product defects rather than
missing documentation:

- **§8 Veins Alive** did not exist at all.
- **§6B camera breathing** had an engine, golden vectors, and three ports — and
  no caller. It was a library, not a feature.
- **§5 and §19 blood pressure** had no entry and no import, and the clients had
  recently been _edited away_ from the specification: copy promising a cuff
  entry was removed instead of the feature being built.
- **§24's six flags** existed by name nowhere. Microphone breathing and form
  coaching were shipping unflagged.
- **§17 budgets** were measured and compared against nothing, which is a record
  rather than a check.
