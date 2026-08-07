# RAFAY PAIR — FINAL CONSOLIDATED MASTER UPDATE
## Smartphone-Only + Pure Native iOS, Android & Web Architecture

**Status:** Final mandatory build specification  
**Date:** 7 August 2026  
**Purpose:** Single source of truth for the autonomous AI development agent.

> This document consolidates the smartphone-only architecture and the pure-native binary/platform specification into one executable development guide. It supersedes any conflicting wearable, watch, BLE, cuff, external-sensor, Flutter, React Native, or cross-platform mobile-runtime requirements from earlier drafts.

---

# RAFAY PAIR — UPDATE 01
## Strict Smartphone-Only Architecture Amendment
### Supersedes all wearable, BLE, cuff, watch, chest-strap, external-sensor and physical-hardware requirements in the original master specification

**Status:** Mandatory architecture override  
**Date:** 7 August 2026  
**Applies to:** `RAFAY_PAIR_MASTER_BUILD_SPEC_2026.md`  
**Priority:** This update overrides any conflicting section in the original master specification.

---

# 0. ABSOLUTE PRODUCT CONSTRAINT

RafayPair must operate using **only the user's own smartphone or web browser**.

The product must NOT require, integrate with, or depend on:

- Apple Watch
- watchOS
- Wear OS
- Smart watches
- Fitness bands
- Chest straps
- Bluetooth heart-rate sensors
- Blood-pressure cuffs
- Smart rings
- BLE medical devices
- External cameras
- External microphones
- Dedicated fitness hardware
- Medical hardware
- IoT devices
- Physical buttons or accessories
- Any hardware other than the phone/computer already running the app

All user-facing features must degrade safely when a smartphone cannot scientifically measure a requested physiological metric.

---

# 1. REVISED PLATFORM TARGETS

Build exactly these primary clients:

1. **iOS native app**
2. **Android native app**
3. **Web app / PWA**
4. **Backend services**

Delete all watchOS, Wear OS and external-device application targets from the architecture.

Final repository:

```text
rafay-pair/
├── apps/
│   ├── ios/
│   ├── android/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
├── engines/
│   ├── pose-spec/
│   ├── exercise-spec/
│   ├── physiology-spec/
│   └── safety-rules/
├── services/
├── infra/
├── docs/
├── tests/
└── scripts/
```

Remove:

```text
apps/watchos/
apps/wearos/
health/ble/
BluetoothDevices/
BloodPressureDeviceAdapter/
WorkoutSessionManager for watch
Wear OS ExerciseClient integrations
WatchConnectivity dependencies
Data Layer watch synchronization
BLE cuff milestones
```

---

# 2. SMARTPHONE SENSOR MATRIX

The agent must treat the smartphone as the only physical sensor platform.

## Available smartphone inputs

### Camera
Use for:

- Full-body pose detection
- Exercise recognition
- Rep counting
- Joint-angle estimation
- Sit / stand / lie-down state
- Optional finger-camera pulse estimation
- Optional face-camera pulse research mode
- Breathing-motion estimation
- Visual exercise form analysis

### Microphone
Use for:

- Realtime conversation
- Voice activity detection
- Guided breathing interaction
- Optional breathing rhythm estimation
- Exercise commands
- User-requested voice notes

Never run secretly.

### Motion sensors
Use:

- Accelerometer
- Gyroscope
- Magnetometer where appropriate
- Device-motion APIs
- Step/activity APIs where available

Applications:

- Movement confirmation
- Phone orientation
- Exercise-state assistance
- Walking / movement cues
- Device stability
- Sensor fusion

### Touch / screen
Use:

- Intent confirmation
- Manual pulse mode activation
- Manual BP entry
- Mood / fatigue / symptoms input
- Care actions
- Consent changes

### OS-provided health repositories
HealthKit and Health Connect may be used only for data already legitimately available on the user's phone.

The app must never assume an external wearable exists.

If health data has an external-device origin, provenance must be preserved and the application must not depend on that source.

---

# 3. HEART RATE — PHONE-ONLY STRATEGY

## 3.1 Continuous workout HR

A normal smartphone is not a reliable continuous heart-rate monitor during unrestricted full-body exercise.

Therefore:

- Do not promise continuous medical-grade live heart rate from the phone.
- Do not fabricate a continuous stream.
- Do not interpolate missing values and present them as measured.
- Do not call camera PPG medical-grade.

## 3.2 Finger-camera pulse mode

Implement an optional active measurement flow.

User intentionally places a fingertip over the rear camera / flash when appropriate.

Pipeline:

```text
Camera frames
→ ROI selection
→ luminance / color-channel extraction
→ detrending
→ band-pass filtering
→ motion and signal-quality gate
→ peak / frequency estimation
→ BPM estimate
→ confidence
→ measurement result
```

Required output:

```text
Estimated pulse
BPM
Measurement duration
Signal quality
Confidence
Timestamp
Source = phone_camera_ppg
Kind = app_estimated
```

Do not measure while the user is doing a full-body pose workout.

Recommended use:

- Before workout
- During intentional pause
- After workout
- During breathing session

## 3.3 Face-camera pulse research mode

May be implemented behind an experimental feature flag using remote photoplethysmography.

Rules:

- Experimental only.
- Must disclose that it is an estimate.
- Never use for diagnosis.
- Never silently activate camera.
- Device / lighting quality gate required.
- Must expose confidence.
- Must be removable without breaking the app.

---

# 4. HEARTBEAT VISUALIZATION

The “live heart” user experience is a **data-driven visualization**, not internal imaging.

Possible states:

```text
Measured recently via phone-camera pulse session
Estimated via experimental rPPG
Using user-selected guided rhythm
No live physiological signal available
Stale
```

The heart orb may animate at the latest valid estimated BPM for a short freshness window.

After expiration, transition to:

```text
Last pulse: 82 BPM
Measured 4 minutes ago
[Measure again]
```

Do not keep animating an old BPM as if it remains current.

---

# 5. BLOOD PRESSURE — STRICT MOBILE-ONLY POLICY

A standard smartphone must NOT be represented as an accurate blood-pressure instrument.

Therefore the production application supports only:

```text
Manual BP entry
Imported OS health record with explicit provenance
Unsupported / unavailable
```

Do NOT ship:

- Camera-only “medical BP”
- Face-based BP
- Voice-based BP
- AI-predicted BP
- Finger-pressure guesses
- Fake systolic / diastolic numbers
- Hidden derived BP

Data model:

```text
blood_pressure:
  source:
    manual_entry
    imported_health_record
  measurement_kind:
    manually_entered
    externally_sourced
```

If a research model is ever explored, keep it entirely outside production and never expose it as a health measurement.

---

# 6. BREATHING — MOBILE-ONLY STRATEGY

Support three phone-native modes.

## A. Guided breathing

No estimation required.

```text
inhale duration
hold duration
exhale duration
cycles
haptics
animation
voice guidance
```

## B. Camera chest-motion estimate

Pipeline:

```text
camera
→ torso landmarks
→ shoulder / chest movement proxy
→ temporal motion extraction
→ breathing-cycle detector
→ confidence gate
→ estimated breaths/minute
```

Kind:

```text
app_estimated
```

## C. Microphone breathing-rhythm estimate

Only during explicit breathing sessions.

Pipeline:

```text
microphone
→ local VAD
→ breath-sound feature extraction
→ noise rejection
→ rhythm estimate
→ confidence
```

Raw audio must not be retained by default.

---

# 7. CALORIES — MOBILE-ONLY STRATEGY

Possible inputs:

- Exercise type
- Rep count
- Duration
- User-provided height / weight / age if they choose to provide it
- Phone movement
- Step data
- Intensity proxy
- OS-provided active-energy records when legitimately available

Output must always be:

```text
Estimated calories
```

Never claim exact calories.

Store:

```text
estimate_algorithm_version
inputs_used
confidence_band
estimated_kcal
```

---

# 8. “VEINS ALIVE” MODE

This remains a visual experience.

No claim of scanning veins.

Rendering may use:

- Animated vascular network
- Pulse propagation
- Heart contraction animation
- Breathing-synchronized chest glow
- Current exercise muscle activation map
- Workout intensity
- Estimated pulse
- User-selected “calm / workout / recovery” state

UI disclosure:

> Sensor-driven visualization — not a medical scan.

---

# 9. POSE DETECTION — PRIMARY FITNESS ENGINE

Pose is now the central physical intelligence subsystem.

Required capabilities:

- Person presence
- Full-body framing quality
- Sit
- Stand
- Lie down
- Squat
- Lunge
- Push-up
- Plank
- Jumping jack
- High knees
- Mountain climber
- Crunch
- Glute bridge
- Shoulder press without equipment
- Arm raise
- Side bend
- Stretch holds
- Balance pose
- Walking-in-place

Architecture:

```text
Camera
→ frame scheduler
→ pose inference
→ landmark normalization
→ temporal smoothing
→ visibility confidence
→ orientation
→ pose classifier
→ exercise state machine
→ rep counter
→ range-of-motion evaluator
→ form feedback
→ session summary
```

Pose inference remains on-device whenever platform capability permits.

---

# 10. NO-HARDWARE PRODUCT EXPERIENCE

The product should still feel “alive” without accessories.

## Home live state

Possible cards:

- Current activity state
- Last pulse estimate
- Breath session
- Steps
- Today’s movement
- Workout streak
- Calories estimate
- Mood / energy check-in
- Partner care status
- Active sharing permissions

## Together mode

Both phones independently detect their respective users.

Each client sends only derived session events:

```text
rep_count
exercise_phase
set_progress
workout_elapsed
estimated_calories
latest_user-approved_pulse
breathing_session_state
```

Never stream camera frames to the partner by default.

Optional live video calling must be a separate, explicit call mode.

---

# 11. REALTIME MOBILE AI

The AI layer remains realtime.

Inputs may include:

- User speech
- Current exercise
- Pose errors
- Rep count
- Workout duration
- Latest phone-estimated pulse
- Breathing-session state
- User check-in
- User-approved partner state
- Reminder context
- Relationship preferences

The model must understand provenance.

Example context:

```json
{
  "pulse": {
    "value": 84,
    "kind": "app_estimated",
    "source": "phone_camera_ppg",
    "measured_at": "2026-08-07T06:40:00Z",
    "confidence": 0.87
  }
}
```

The AI must not say:

> “Your heart rate is definitely 84.”

Preferred:

> “Your latest phone-camera pulse estimate is around 84 BPM.”

---

# 12. IOS STRICT-NATIVE IMPLEMENTATION

Language:

```text
Swift
```

UI:

```text
SwiftUI
```

Core platform APIs:

- AVFoundation
- Vision
- Core ML where custom models are needed
- Core Motion
- HealthKit
- Speech / audio session APIs where appropriate
- WebRTC native SDK
- URLSession
- Swift Concurrency
- CryptoKit
- Keychain
- UserNotifications
- BackgroundTasks
- LocalAuthentication
- App Attest / DeviceCheck

Do not use:

- Flutter
- React Native
- Ionic
- Cordova
- Capacitor
- Electron
- Kotlin Multiplatform UI

The iOS release artifact is:

```text
.ipa
```

Distribution:

- Debug simulator/device builds
- Internal signed build
- TestFlight
- App Store

---

# 13. ANDROID STRICT-NATIVE IMPLEMENTATION

Language:

```text
Kotlin
```

UI:

```text
Jetpack Compose
```

Platform technologies:

- CameraX
- ML Kit and/or MediaPipe benchmarked per feature
- TensorFlow Lite / LiteRT where custom model needed
- Android sensor APIs
- Health Connect
- Android Audio APIs
- WebRTC native SDK
- Coroutines
- Flow
- Room
- DataStore
- WorkManager
- Credential Manager
- Android Keystore
- Play Integrity
- FCM

Do not use:

- Flutter
- React Native
- Ionic
- Cordova
- Capacitor
- Xamarin / MAUI
- Kotlin Multiplatform UI

Release artifacts:

```text
.aab   # Google Play
.apk   # testing / direct distribution where appropriate
```

---

# 14. WEB APP WITHOUT CROSS-PLATFORM MOBILE FRAMEWORKS

Web is an independent web implementation.

Primary language:

```text
TypeScript
```

Performance modules may use:

```text
Rust → WebAssembly
```

Browser APIs:

- WebRTC
- WebAudio
- MediaDevices / getUserMedia
- Web Workers
- Service Workers
- WebAssembly
- Web Crypto
- IndexedDB
- Cache Storage
- Web Push where supported
- WebGL / WebGPU where appropriate and available
- MediaPipe Web or equivalent browser pose runtime

Web limitations must be explicit.

The browser version may not have the same:

- background execution
- sensor reliability
- camera control
- push behavior
- health repository access
- OS integration

as native iOS / Android.

Do not pretend feature parity where browser security models prevent it.

---

# 15. HEALTHKIT AND HEALTH CONNECT RULE

HealthKit and Health Connect remain optional smartphone OS repositories.

They may provide:

- Steps
- User-entered health values
- App-generated workouts
- Existing records
- Active energy records where available

But:

- The app never requires a watch.
- The app never assumes a wearable origin.
- External-origin data must retain its origin.
- Features must still function without any health-repository data.

---

# 16. REVISED REPOSITORY TREE

```text
rafay-pair/
├── apps/
│   ├── ios/
│   │   ├── RafayPair/
│   │   ├── Modules/
│   │   ├── Tests/
│   │   └── UITests/
│   ├── android/
│   │   ├── app/
│   │   ├── core/
│   │   ├── feature/
│   │   ├── pose/
│   │   ├── physiology/
│   │   └── tests/
│   ├── web/
│   │   ├── src/
│   │   ├── public/
│   │   ├── workers/
│   │   ├── wasm/
│   │   └── tests/
│   ├── api/
│   └── worker/
├── engines/
│   ├── pose-spec/
│   ├── exercise-state-machines/
│   ├── pulse-estimation-spec/
│   ├── breathing-estimation-spec/
│   ├── calorie-estimation-spec/
│   └── signal-quality/
├── packages/
│   ├── api-contracts/
│   ├── event-contracts/
│   ├── design-tokens/
│   ├── safety-policies/
│   ├── prompt-registry/
│   └── test-fixtures/
├── services/
│   ├── realtime/
│   ├── ai-orchestrator/
│   ├── session-coordinator/
│   └── notifications/
├── infra/
├── docs/
├── tests/
└── scripts/
```

---

# 17. REVISED MILESTONES

## Phase A — Foundation

- Monorepo
- iOS
- Android
- Web
- API
- Worker
- Auth
- Pairing
- Consent
- CI/CD
- Infrastructure

## Phase B — Camera intelligence

- Pose engine
- Sit / stand / lie-down
- Exercise classification
- Rep counting
- Form analysis
- Performance benchmark

## Phase C — Phone physiology

- Finger-camera pulse estimation
- Signal-quality engine
- Breathing camera estimate
- Guided breathing
- Microphone breathing experiment
- Estimated calories
- Provenance system

## Phase D — Couple realtime

- Presence
- Care requests
- Shared workout
- Rep synchronization
- User-approved pulse snapshots
- Live session recovery
- Privacy pause

## Phase E — Realtime Rafay AI

- Realtime voice
- Context engine
- Exercise tool calls
- Relationship memory
- AI disclosure
- Consent-aware partner data
- Safety rules

## Phase F — Living body UI

- Heart orb
- Vein animation
- Breathing animation
- Muscle activation
- Data confidence
- Stale-state visualization

## Phase G — Production hardening

- Security
- Privacy
- Device matrix
- Camera model validation
- Performance
- Accessibility
- Store builds
- Web deployment
- Observability
- Incident runbooks

---

# 18. DELETE FROM ORIGINAL MASTER SPEC

The autonomous agent must treat the following original concepts as deleted:

```text
Apple Watch integration
watchOS application
Wear OS application
Watch live heart-rate telemetry
Bluetooth chest straps
BLE health adapters
Connected BP cuff
External BP devices
Wearable respiratory sources
Wearable active-energy source as required functionality
Physical medical hardware
Watch haptic partner cues
Watch-to-phone workout mirroring
External sensor pairing
Hardware compatibility matrix
```

---

# 19. MVP DEFINITION OF DONE — MOBILE ONLY

MVP is complete when:

- Two users can pair securely.
- Both native apps work without accessories.
- Web supports the safe subset of the experience.
- Camera detects pose locally.
- Sit, stand and lie-down work.
- Multiple exercises count reps.
- User can run finger-camera pulse estimation.
- Pulse result has confidence and provenance.
- Breathing guidance works.
- Camera breathing estimate is feature-flagged and confidence-aware.
- Calories are clearly estimated.
- BP is manual/imported only.
- Living-heart visualization never fabricates fresh data.
- Couple workout synchronizes derived events.
- Partner cannot activate sensors remotely.
- Realtime AI works with disclosure.
- AI understands estimated vs measured.
- Privacy pause terminates partner sharing.
- iOS produces an installable IPA.
- Android produces AAB and APK artifacts.
- Web produces a deployable production bundle and optional WASM modules.
- CI builds and tests all three platforms.
- No watch / wearable / external health hardware is required.

---

# 20. AUTONOMOUS AGENT FINAL DIRECTIVE

When this amendment conflicts with the original master specification, **this amendment wins**.

The implementation must remain:

> Smartphone-first, accessory-free, native, realtime, privacy-preserving and scientifically honest.

The app should create a rich sense of presence and care using software intelligence, not unsupported physiological claims.

# END UPDATE 01


---

# PART II — PURE NATIVE PLATFORM & BINARY IMPLEMENTATION

# RAFAY PAIR — UPDATE 02
## Pure-Native Platform, Binary Build, Runtime, Engine, Serving and Deployment Specification
### Android + iOS + Web — no Flutter, no React Native, no shared cross-platform UI runtime

**Status:** Mandatory build-system and platform implementation override  
**Date:** 7 August 2026  
**Applies after:** `RAFAY_PAIR_UPDATE_01_MOBILE_ONLY.md`

---

# 0. EXECUTION RULE

Build independent first-class platform clients.

```text
iOS     = Swift + SwiftUI
Android = Kotlin + Jetpack Compose
Web     = TypeScript + native browser APIs + Rust/WASM where performance justifies it
Backend = Rust or TypeScript service layer according to module requirements
```

There must be no shared UI runtime across iOS and Android.

Forbidden UI/application frameworks:

- Flutter
- React Native
- Expo runtime for mobile app
- Ionic
- Capacitor
- Cordova
- MAUI
- Xamarin
- NativeScript
- Electron for the primary client
- Kotlin Multiplatform UI

Shared assets are limited to:

- OpenAPI contracts
- JSON Schema
- Protobuf only if later justified
- Design tokens
- Exercise-rule specifications
- Safety policies
- Prompt templates
- Test fixtures
- Generated API clients
- Mathematical algorithm specifications

---

# 1. PLATFORM OUTPUTS

## iOS

Build configurations:

```text
Debug
Development
Staging
Release
```

Artifacts:

```text
RafayPair.app
RafayPair.ipa
dSYM bundles
XCFrameworks only for internal reusable native binary modules if needed
```

Distribution:

```text
Local device
TestFlight internal
TestFlight external
App Store
```

## Android

Build types / flavors:

```text
debug
development
staging
release
```

Artifacts:

```text
app-debug.apk
app-staging.apk
app-release.aab
mapping.txt
native debug symbols where applicable
```

Distribution:

```text
Local device / emulator
Firebase App Distribution or equivalent internal path
Google Play Internal
Google Play Closed
Google Play Production
```

## Web

Artifacts:

```text
HTML
CSS
ES modules
optimized JavaScript
WebAssembly modules
Service Worker
manifest.webmanifest
hashed assets
source maps stored privately
```

Serving:

```text
CDN
immutable versioned assets
HTML no-cache / short-cache
Brotli / gzip
HTTP/2 or HTTP/3
TLS
CSP
COOP / COEP only where required for WASM capabilities
```

---

# 2. IOS ENGINEERING STACK

## Language

Use current stable Swift.

Compiler settings:

- Strict concurrency checks.
- Warnings treated as errors in CI where practical.
- Whole-module optimization for release.
- Dead-code stripping.
- Debug symbols separated from production package.
- Hardened runtime behavior applicable to iOS.

## UI

SwiftUI first.

UIKit only when required for:

- camera surfaces
- lower-level media integration
- APIs not adequately exposed through SwiftUI

Pattern:

```text
Feature
├── View
├── ViewModel / Store
├── Domain
├── UseCases
├── Repository protocol
└── Adapter
```

Do not create one global state object.

## Concurrency

Use:

- async/await
- AsyncSequence
- actors
- structured concurrency

Avoid callback pyramids.

Sensor coordinators should generally be actors.

Example:

```swift
actor PulseMeasurementEngine {
    // owns camera-derived signal state
}
```

## Persistence

Use the most suitable current native Apple persistence technology for structured local data after confirming platform baseline.

Sensitive values:

- Keychain
- protected local database
- file protection classes

No secrets in UserDefaults.

## Networking

- URLSession
- generated Codable models
- certificate trust handled by platform defaults unless a documented threat model requires additional controls
- WebSocketTask or vetted native realtime transport
- WebRTC native framework for live AI audio

## Camera

- AVFoundation
- AVCaptureSession
- AVCaptureVideoDataOutput
- adaptive frame sampling
- frame dropping under load
- explicit capture state
- torch only under user-triggered pulse measurement when safe and supported

## Vision / ML

Priority:

1. Apple Vision APIs when fit for purpose
2. Core ML model
3. Metal acceleration internally through framework/runtime
4. Custom Metal only after profiling

No server round trip for ordinary pose inference.

## Motion

- Core Motion
- device motion
- accelerometer
- gyro

Fuse motion data only when it materially improves the classifier.

## Audio

- AVAudioSession
- low-latency realtime mode for conversational AI
- interruption handling
- route changes
- Bluetooth audio output may work as normal OS audio routing, but the application must not depend on dedicated sensor hardware

---

# 3. ANDROID ENGINEERING STACK

## Language

Current stable Kotlin.

Compiler/build:

- Kotlin strict settings
- current Android Gradle Plugin
- Gradle version catalog
- configuration cache where supported
- R8 optimization
- baseline profiles
- startup profiles where useful
- reproducible release builds

## UI

Jetpack Compose only for new UI unless a platform-specific View is required.

Architecture:

```text
UI
→ ViewModel
→ UseCase
→ Repository
→ Data Source / Engine
```

State:

- immutable UI models
- StateFlow
- SharedFlow for one-time events only when appropriate

## Concurrency

- Kotlin Coroutines
- Flow
- structured concurrency
- lifecycle-aware collection

## Dependency injection

Use a current stable native Android DI solution such as Hilt, unless a lean manual DI approach is demonstrably simpler.

## Persistence

- Room
- encrypted storage strategy for sensitive values
- DataStore for preferences
- Android Keystore for key material

## Networking

- OkHttp
- Retrofit or generated OpenAPI client
- Kotlin serialization where selected
- WebSocket
- native WebRTC library

## Camera

- CameraX
- ImageAnalysis
- backpressure strategy
- target rotation handling
- lifecycle binding
- explicit user-visible camera state

## ML

Benchmark:

- ML Kit Pose Detection
- MediaPipe
- LiteRT/TFLite custom model

Select per feature rather than ideology.

Use hardware acceleration through platform-supported delegates when stable.

## Motion

- SensorManager
- accelerometer
- gyroscope
- rotation vector

## Audio

- native Android audio stack
- WebRTC audio processing where appropriate
- AudioRecord only when lower-level access is necessary
- foreground user-visible session for long-running live audio when required by platform policy

---

# 4. WEB ENGINEERING STACK

Web is not a wrapper around the mobile applications.

## Language

Use strict TypeScript.

## UI architecture

Preferred:

- standards-based web application
- component architecture
- framework selection must prioritize browser performance, accessibility, long-term support and server rendering where useful

If using a framework, keep the browser engine modules framework-independent.

Core engine interfaces must be plain TypeScript.

## High-performance modules

Use Rust compiled to WebAssembly only for modules proven by profiling to benefit from it, for example:

- signal processing
- FFT
- filters
- peak detection
- landmark post-processing
- math-heavy visualization
- deterministic exercise state machines

Do not move ordinary UI logic to WASM.

## Browser media

Use:

```text
navigator.mediaDevices.getUserMedia
MediaStreamTrack APIs
WebRTC
WebAudio
AudioWorklet
Web Workers
OffscreenCanvas where supported
requestVideoFrameCallback where supported
```

## Pose

Possible browser pipeline:

```text
getUserMedia
→ video frame
→ Web Worker / model runtime
→ landmarks
→ post-processing
→ exercise engine
→ UI
```

Never send frames to the backend merely because browser implementation is easier.

## Storage

- IndexedDB
- Cache Storage
- Web Crypto

No sensitive persistent data in LocalStorage.

## PWA

Support:

- installability
- offline shell
- queued non-sensitive actions
- push where available
- share target only if useful
- safe upgrade strategy

Do not claim identical background behavior to native apps.

---

# 5. NATIVE ENGINE BOUNDARIES

Each platform implements the same logical engine contracts independently.

## Pose engine contract

```text
Input:
- frame
- timestamp
- orientation
- camera metadata

Output:
- landmarks
- pose confidence
- body orientation
- visibility flags
```

## Exercise engine

```text
Input:
- normalized landmarks
- previous state
- timestamps

Output:
- exercise type
- phase
- rep delta
- form events
- hold duration
- confidence
```

## Pulse engine

```text
Input:
- camera signal samples
- timestamps

Output:
- bpm estimate
- confidence
- signal quality
- rejected reason
```

## Breathing engine

```text
Input:
- pose motion samples OR audio features

Output:
- breaths_per_minute estimate
- confidence
- signal quality
```

## Calorie engine

```text
Input:
- exercise
- duration
- reps
- optional user profile
- movement intensity

Output:
- estimated_kcal
- confidence_band
- algorithm_version
```

Shared behavior is enforced through a cross-platform golden test suite, not a shared runtime.

---

# 6. CROSS-PLATFORM GOLDEN TEST SYSTEM

Create canonical fixture files:

```text
tests/golden/
├── pose/
├── exercise/
├── pulse/
├── breathing/
├── calories/
└── consent/
```

Each native engine must consume equivalent fixtures.

Expected output tolerance is explicit.

Example:

```json
{
  "fixture": "squat_sequence_001",
  "expected": {
    "reps": 10,
    "tolerance": 0,
    "invalid_frames_max": 4
  }
}
```

This maintains behavioral parity while keeping implementation native.

---

# 7. BUILD ORCHESTRATION

Top-level commands:

```bash
make bootstrap
make verify
make ios
make android
make web
make api
make test-native
make test-web
make package-all
```

Suggested root orchestration:

```text
Makefile
scripts/
mise.toml
pnpm workspace for backend/web tooling only
```

Do not force Swift or Gradle inside a JavaScript monorepo abstraction if it hides native build behavior.

Use native build tools directly:

```text
xcodebuild
swift package
gradlew
cargo
pnpm
docker
terraform
```

---

# 8. CI MATRIX

GitHub Actions matrix:

```text
ios-build
ios-unit
ios-ui-smoke

android-build
android-unit
android-instrumented-smoke

web-build
web-unit
web-e2e

api-build
api-unit
api-integration

rust-wasm-build
golden-cross-platform-tests

security-sast
dependency-audit
secret-scan
container-scan
terraform-validate
```

Protected release jobs:

```text
package-ios
package-android
publish-web
deploy-api
```

---

# 9. IOS PIPELINE

```text
checkout
→ toolchain verify
→ resolve Swift packages
→ generate API client
→ lint
→ unit tests
→ simulator build
→ UI smoke tests
→ archive
→ export IPA
→ upload symbols
→ TestFlight
```

Code signing:

- Managed through protected CI secret store
- No `.p12` or provisioning secrets committed
- Separate development and release credentials
- App Store Connect API keys restricted to required role

---

# 10. ANDROID PIPELINE

```text
checkout
→ JDK/toolchain verify
→ Gradle dependency verification
→ API client generation
→ lint
→ unit tests
→ assembleDebug
→ instrumented smoke tests
→ bundleRelease
→ R8
→ artifact signing
→ symbols/mapping upload
→ Play testing track
```

Signing keys:

- Never in repository
- Protected CI environment
- Play App Signing recommended where appropriate
- Key rotation and recovery documented

---

# 11. WEB PIPELINE

```text
checkout
→ Node/toolchain verify
→ Rust toolchain verify if WASM enabled
→ install locked deps
→ typecheck
→ lint
→ tests
→ build WASM
→ production web build
→ Playwright E2E
→ CSP validation
→ asset integrity check
→ upload immutable assets
→ atomic deployment
→ smoke test
```

Web release must be rollbackable by deployment version.

---

# 12. BACKEND STACK

Recommended baseline:

```text
TypeScript + Node.js active LTS + NestJS/Fastify
```

Alternative performance-critical services:

```text
Rust + Axum/Tokio
```

Do not rewrite the whole backend in Rust without profiling.

Use Rust selectively for:

- high-rate signal processing service if ever server-side
- cryptographic utilities when justified
- high-throughput realtime gateway only if Node limits are actually reached

Initial backend should remain a secure modular monolith.

---

# 13. BACKEND RUNTIME

```text
HTTP REST
WebSocket
AI session broker
notification worker
background job worker
PostgreSQL
Redis
object storage
OpenTelemetry
```

Realtime:

```text
Client
→ authenticated websocket gateway
→ pair/session authorization
→ event fanout
```

AI voice:

```text
Client WebRTC
→ realtime AI provider

Client
→ backend
→ ephemeral AI session authorization/token
```

Provider master credentials remain server-side.

---

# 14. SERVER DEPLOYMENT

Preferred initial deployment:

```text
CDN/WAF
→ Load Balancer
→ API containers
→ Worker containers
→ PostgreSQL
→ Redis
→ encrypted object storage
```

Recommended technologies:

- Docker
- Terraform
- AWS ECS Fargate or equivalent managed containers
- RDS PostgreSQL
- ElastiCache / managed Redis-compatible service
- S3
- KMS
- Secrets Manager
- CloudFront / Cloudflare
- OpenTelemetry

Kubernetes is NOT required initially.

Adopt Kubernetes only when:

- service count grows materially
- scaling patterns justify it
- operational team can support it
- managed containers become limiting

---

# 15. WEB SERVING

Static/SSR architecture depends on selected web framework.

Required edge behavior:

```text
/index.html               short cache
/assets/hash.*             immutable long cache
/*.wasm                    correct MIME + immutable
/service-worker.js         no stale uncontrolled caching
/api/*                     never cached unless endpoint explicitly permits
```

Headers:

- Content-Security-Policy
- Strict-Transport-Security
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
- appropriate frame-ancestors policy

Camera/mic permissions should be narrowed through Permissions Policy.

---

# 16. SOURCE CODE QUALITY

iOS:

- SwiftFormat or selected formatter
- SwiftLint if rules add value
- XCTest
- XCUITest

Android:

- ktlint
- detekt
- JUnit
- Compose UI tests
- Macrobenchmark
- Baseline Profile tests

Web:

- ESLint
- formatter
- Vitest
- Playwright
- accessibility testing

Rust:

- rustfmt
- clippy
- cargo test
- cargo audit

Backend:

- strict TypeScript
- unit
- integration
- API contract
- load tests

---

# 17. BINARY SIZE AND PERFORMANCE BUDGETS

Track release artifact size on every build.

Budgets must be set after baseline measurement.

Alert on regression.

Track:

```text
IPA size
AAB download size
APK size
JS initial bundle
WASM bundle
cold start
warm start
camera-to-pose latency
pulse processing latency
memory
CPU
GPU
battery
thermal state
network usage
```

Never optimize by removing privacy or safety checks.

---

# 18. FEATURE PARITY POLICY

Three platforms do not need fake parity.

Define feature capability states:

```text
full
limited
experimental
unsupported
```

Example:

| Capability | iOS | Android | Web |
|---|---|---|---|
| Pose workout | full | full | full/limited by browser |
| Finger camera pulse | full | full | experimental/limited |
| HealthKit | full | unsupported | unsupported |
| Health Connect | unsupported | full | unsupported |
| Realtime AI voice | full | full | full |
| Background workout | full native constraints | full native constraints | limited |
| Push | full | full | browser-dependent |
| Camera breathing | experimental | experimental | experimental |
| Manual BP | full | full | full |

The UI must not expose an unavailable control merely to look consistent.

---

# 19. SECURITY OF NATIVE BINARIES

## iOS

- Keychain secrets
- no hardcoded API keys
- ATS
- app attestation risk signals
- release logs reduced
- symbol files private
- jailbreak state may be a risk signal but must not become sole authorization logic

## Android

- Keystore
- R8
- no hardcoded secrets
- Play Integrity risk signal
- Network Security Config
- release logs stripped
- root detection may be a signal only

## Web

- Assume client source is inspectable
- no server secrets
- CSP
- secure cookies
- CSRF protection
- origin checks
- Web Crypto
- short-lived tokens

Authorization always lives on backend.

---

# 20. REALTIME INTERACTIVITY TARGETS

Design targets:

```text
Tap feedback                <100ms perceived
Local pose feedback         target <150ms
Rep increment UI            immediate after validated transition
Partner rep sync            target <500-1000ms typical
Care request delivery       near realtime
AI turn start               minimized through WebRTC
Privacy pause               immediate locally, server propagation in seconds
```

Use optimistic UI only for reversible local actions.

Never optimistic-authorize sensitive partner access.

---

# 21. OFFLINE BEHAVIOR

Native apps should support:

- local workout
- pose
- rep count
- guided breathing
- local reminders
- pending care draft
- latest local summaries
- queued sync

Unavailable offline:

- partner live state
- realtime AI provider
- remote care delivery
- cloud pair actions

On reconnect:

- idempotent sync
- conflict resolution
- consent revalidation before publishing queued partner-visible data

---

# 22. DATABASE AND EVENTS

PostgreSQL is canonical system of record.

Use:

- UUID
- UTC
- transactional outbox
- idempotent workers
- migrations
- backup
- point-in-time recovery

Do not introduce Kafka before necessary.

Realtime transient state may use Redis.

Consent truth always comes from durable storage.

---

# 23. VERSIONING

Version:

```text
iOS app
Android app
Web app
API
event contracts
exercise definitions
pulse algorithm
breathing algorithm
calorie algorithm
AI prompt
AI policy
```

Every health-related derived result stores its algorithm version.

---

# 24. EXPERIMENT FLAGS

Mandatory experimental flags:

```text
camera_ppg_face_mode
camera_breathing_estimate
microphone_breathing_estimate
advanced_form_coaching
living_body_advanced
ai_relationship_memory
```

Finger-camera pulse may move from experimental to standard only after internal validation.

No experimental physiological feature may be enabled silently.

---

# 25. RELEASE CHANNELS

iOS:

```text
dev
internal
alpha
beta
production
```

Android:

```text
dev
internal
closed-alpha
closed-beta
production
```

Web:

```text
preview
staging
production
```

Backend:

```text
dev
staging
production
```

Feature flags separate code deployment from feature exposure.

---

# 26. FIRST NATIVE BINARY DELIVERY MILESTONE

The development agent must produce these artifacts before moving to advanced physiology:

```text
ios:
  signed development build installable on a real iPhone

android:
  debug APK installable on a real Android phone

web:
  deployable production bundle

api:
  production container image

worker:
  production container image
```

All clients must:

- sign in
- create/join pair
- show consent center
- send care request
- receive care request
- privacy pause
- disconnect pair

Only after this milestone may the agent add pose and pulse.

---

# 27. SECOND NATIVE BINARY DELIVERY MILESTONE

Artifacts must support:

- iOS camera pose
- Android camera pose
- Web camera pose
- sit
- stand
- lie-down
- squat
- rep count
- local workout
- no camera upload
- golden test parity

---

# 28. THIRD NATIVE BINARY DELIVERY MILESTONE

Artifacts must support:

- finger-camera pulse on iOS
- finger-camera pulse on Android
- signal quality
- confidence
- latest pulse share by consent
- guided breathing
- estimated calories
- living heart visualization
- no fake BP

Web pulse remains separately qualified based on browser/device capability.

---

# 29. FOURTH NATIVE BINARY DELIVERY MILESTONE

Artifacts must support:

- realtime couple workout
- derived event sync
- privacy pause
- partner request controls
- WebSocket recovery
- realtime Rafay AI voice
- explicit AI identity
- tool authorization
- memory controls

---

# 30. FINAL AGENT CHECKLIST

Before declaring the platform production-ready, prove:

```text
[ ] No Flutter
[ ] No React Native
[ ] No wearable app
[ ] No external sensor requirement
[ ] iOS is Swift-native
[ ] Android is Kotlin-native
[ ] Web is independent browser-native TypeScript
[ ] WASM is used only where justified
[ ] IPA pipeline works
[ ] AAB pipeline works
[ ] APK pipeline works
[ ] Web production bundle works
[ ] Camera pose runs locally
[ ] Phone pulse is labeled estimated
[ ] BP is never fabricated
[ ] Camera/mic cannot be remotely activated
[ ] Consent enforced server-side
[ ] AI cannot bypass consent
[ ] AI identifies generated voice
[ ] Raw camera is not uploaded by default
[ ] Raw mic is not retained by default
[ ] Privacy pause works
[ ] Pair disconnect revokes all partner access
[ ] CI builds all targets
[ ] Rollback exists
[ ] Observability exists
[ ] Security review passes
```

---

# 31. FINAL BUILD DIRECTIVE

The technical identity of RafayPair is:

> **A pure-native, smartphone-only, realtime couple-care and fitness platform with independently engineered iOS, Android and Web clients, on-device vision and signal-processing engines, governed realtime AI, and no dependency on external health hardware.**

The development agent must optimize for:

- low latency
- local intelligence
- native platform quality
- battery efficiency
- scientific honesty
- privacy
- consent
- binary reliability
- maintainability
- current stable platform technology

Do not chase framework fashion at the expense of native capability.

# END UPDATE 02
