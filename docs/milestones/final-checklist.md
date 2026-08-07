# Final agent checklist

Master specification §30 lists twenty-six things to prove before the platform is
called production-ready. This document records how each was checked on
2026-08-07, and — for the three that are not yet closed — exactly what is
outstanding and who can close it.

Two rules were followed while assembling it. A claim is only recorded here if a
command, a test, or a structural property backs it; and where checking turned up
something untrue, the product was corrected rather than the claim softened. Four
such corrections were made, listed at the end.

## Identity

| Item                                 | Proof                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Flutter                           | No match for `flutter` in any manifest, lockfile, Gradle script, or Xcode project.                                                                        |
| No React Native                      | No match for `react-native` in any manifest or lockfile.                                                                                                  |
| No wearable app                      | No watchOS or Wear OS target exists. `security find-identity`, `project.yml`, and `settings.gradle.kts` describe one app each.                            |
| No external sensor requirement       | No Bluetooth permission on either platform. `AndroidManifest.xml` declares internet, network state, notifications, camera, and microphone — nothing else. |
| iOS is Swift-native                  | 63 Swift files, zero Objective-C, zero JavaScript, zero cross-platform runtime.                                                                           |
| Android is Kotlin-native             | 73 Kotlin files, zero Java, zero Dart.                                                                                                                    |
| Web is independent browser-native TS | Its own React/TypeScript sources; it shares only the engine packages, which are specification-parity implementations rather than a shared UI runtime.     |
| WASM only where justified            | One use: the MediaPipe vision runtime behind the Web pose engine, self-hosted under `dist/models`. No WASM elsewhere.                                     |

## Pipelines

Every artifact below was produced from this machine's terminal on 2026-08-07.

| Item                  | Proof                                                                                                        | Bytes         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| APK pipeline works    | `./gradlew assembleRelease`, signed and verified with `apksigner verify --print-certs`.                      | 126,693,811   |
| AAB pipeline works    | `./gradlew bundleRelease`.                                                                                   | 51,738,936    |
| IPA pipeline works    | **Partially proven.** `xcodebuild archive` produces a complete `Release` `.xcarchive` with dSYMs. See below. | 4,453,996 app |
| Web production bundle | `pnpm --filter @rafay-pair/web build`, including the service worker and the fetched pose model.              | 41,879,794    |

Notes that matter more than the numbers:

- The 126 MB APK is the universal one, carrying native libraries for all four
  ABIs; 80 MB of it is the three ABIs a given phone will not use. Play delivers
  from the 51 MB AAB and splits per device. The universal APK is a sideloading
  artifact and should not be quoted as the install size.
- The Web bundle is 42 MB because the MediaPipe runtime and BlazePose model are
  self-hosted. They are **not** precached: the generated service worker's
  precache manifest is 18 entries totalling 1,568 KiB, and the model is fetched
  and runtime-cached on first use instead. An installed PWA therefore does not
  pay 42 MB at install time.
- The release build refuses to run without the five Firebase and Play Integrity
  identifiers — `verifyProductionPushConfig` and
  `verifyProductionPlayIntegrityConfig` fail the build by design. The artifacts
  above were produced with syntactically valid throwaway values and a throwaway
  keystore, to prove the pipeline rather than to ship. Real values are the
  account holder's; see `docs/operations/android-release-credentials.md`.

**What is outstanding on the IPA.** Everything up to the signature is proven:
the `Release` configuration compiles for `generic/platform=iOS`, the App Attest
production entitlement check passes, and the archive and dSYMs are produced.
`xcodebuild -exportArchive` then needs a signing identity, and this machine has
none — `security find-identity -v -p codesigning` reports zero valid identities.
That is a one-time GUI action nobody else can perform: add the Apple ID in
Xcode → Settings → Accounts. `scripts/archive-ios.sh` performs the archive and
the export together and is already wired into `.github/workflows/release.yml`.

## Honesty about measurement

| Item                             | Proof                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera pose runs locally         | iOS Vision, Android ML Kit, Web MediaPipe, each in-process. No frame or landmark appears in any API contract, so there is no field through which one could be uploaded.                                                                                  |
| Phone pulse is labeled estimated | `pulse_snapshots.kind` is `CHECK (kind IN ('app_estimated'))` and `source` is `CHECK (source IN ('phone_camera_ppg'))`. A measured-grade reading is not representable, in the database or in the result types on any client.                             |
| BP is never fabricated           | No systolic, diastolic, or blood-pressure field exists in any schema, contract, or client model. All three clients carry a card that says so. Checked by test: the Web capability map may not list blood pressure in any state, including "unsupported". |

## Privacy and consent

| Item                                       | Proof                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera/mic cannot be remotely activated    | `pnpm run verify:invariants`. Every module that consumes something the network delivers — realtime clients, push handlers, background sync, the service worker — and every server module is read, and must not name a capture API at all. 13 network-driven and 45 server modules currently pass. The check was confirmed to fail when a capture token is planted in the service worker. |
| Consent enforced server-side               | Every partner-visible route goes through `SessionCoordinator`. Integration tests cover default-deny, grant, revocation mid-flight, and re-check after the lock.                                                                                                                                                                                                                          |
| AI cannot bypass consent                   | `invokeTool` re-reads privacy state on every call, not once per session, and mutations require `context.confirmed`. Covered by the tool-authorization integration test and by the voice bridge unit tests.                                                                                                                                                                               |
| AI identifies generated voice              | The disclosure is server-supplied. The voice socket is refused until `identity_announced` is true — a database predicate in the same `UPDATE` that redeems the ticket, not a client convention. Covered by integration test.                                                                                                                                                             |
| Raw camera is not uploaded by default      | Not by default and not at all: no contract field can carry a frame. The `together_participant_states` transport type is checked field-by-field by a Kotlin test that fails if a property is ever named for a frame, landmark, or audio buffer.                                                                                                                                           |
| Raw mic is not retained by default         | The breathing estimator's input type carries only per-hop features, so audio cannot cross the boundary. Voice audio is relayed and never written to disk or database.                                                                                                                                                                                                                    |
| Privacy pause works                        | Integration test: pause blocks partner delivery, resume restores it, and both publish control events immediately.                                                                                                                                                                                                                                                                        |
| Pair disconnect revokes all partner access | Integration test, added while assembling this checklist. Care alone was previously covered; the test now also proves the partner loses the pulse snapshot and the together session. Each surface is asserted separately so a new surface that forgets the pair check fails here.                                                                                                         |

## Operations

| Item                   | Proof                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI builds all targets  | `.github/workflows/ci.yml` runs server, web, iOS, Android, Android instrumented, containers, infrastructure, SAST, and security jobs. `release.yml` adds the signed iOS and Android release jobs and staging acceptance.                                                                                                                                                               |
| Rollback exists        | `scripts/rollback-ecs.sh` (previous task definitions, forward-compatible migrations only) and `scripts/rollback-web.sh` (restores a prior immutable release prefix). Both documented in `docs/operations/deployment.md`.                                                                                                                                                               |
| Observability exists   | OpenTelemetry traces and metrics via OTLP, structured JSON logs, `/health/live` and `/health/ready`, and a security audit trail (`recordSecurityAudit`). Three counters: authorization refusals by failure code, realtime events withheld at delivery time, and AI tool decisions by outcome. None carries a user, pair, or session identifier, and a test fails if one is ever added. |
| Security review passes | `pnpm audit --audit-level high` reports no known vulnerabilities. CI additionally runs gitleaks, Trivy (vuln, secret, misconfig; HIGH and CRITICAL fail the build), and CodeQL for TypeScript, Kotlin, and Swift.                                                                                                                                                                      |

## What is genuinely not closed

All three need something from outside this machine. None is a piece of unwritten
software: observability was briefly on this list, and the metrics were built
rather than left recorded as a gap.

1. **A signed IPA.** Needs the Apple ID added in Xcode → Settings → Accounts.
   Nothing else in the iOS pipeline is unproven.
2. **Real-device validation of finger-camera pulse.** A simulator has no
   fingertip and no torch. It needs a real finger on a real rear camera and a
   reference rate to compare against — another phone's pulse app, a smartwatch,
   a pulse oximeter, or a rate counted by hand for a minute.
3. **A live voice session.** The transport, authorization, and both clients are
   built and tested; a provider account is needed to hear it. Four values,
   obtained as described in `docs/ai/qwen-provider-contract.md`.

## Corrections made while checking

Four user-facing statements were found to be untrue and were fixed, not
reworded around:

- The Web capability map said camera pose was "not part of this foundation
  release" for a release that ships camera pose, and listed nothing about
  Together mode or the assistant. It now describes what is actually built, and a
  test imports the surfaces it describes so the two cannot drift apart again.
- The Web home page said the release "does not show physiological measurements"
  while showing repetition counts and estimated calories. It now says what those
  numbers are and are not.
- All three clients told users they could "enter a reading from a real cuff or
  import it from Health / Health Connect". The app has no blood-pressure entry
  and no health-repository entitlement, so both were promises it could not keep.
  They now say plainly that RafayPair holds no blood pressure value of its own.
- The iOS microphone usage string said audio is never uploaded. That was true
  when breathing was the only use of the microphone and stopped being true when
  voice sessions were added. It now describes both uses separately.
