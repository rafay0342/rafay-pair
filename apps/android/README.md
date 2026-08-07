# RafayPair Android

Pure Kotlin/Jetpack Compose Android client for the first native RafayPair binary milestone.

## Toolchain

- Android SDK 36, minimum SDK 28
- Android Gradle Plugin 9.3.1 and Gradle 9.7.0
- Kotlin 2.4.10, JDK 21
- Compose, Coroutines/StateFlow, Room, DataStore, WorkManager, OkHttp
- Firebase Android BoM 34.16.0 and native Firebase Cloud Messaging 25.1.1

The app is a single native module, so dependencies are constructor-wired in `AppContainer` instead
of introducing generated application-wide DI. Feature boundaries remain UI → ViewModel → UseCase →
Repository → data source.

## Build channels

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew assembleDebug testDebugUnitTest lintDebug

./gradlew assembleDevelopment
./gradlew assembleStaging
./gradlew bundleRelease
```

`debug` talks to `http://10.0.2.2:3000`; cleartext is permitted only for that emulator loopback
host. Development, staging, and release use HTTPS/WSS endpoints and the strict main Network
Security Config.

For a signed debug APK running on a USB-connected physical phone, reverse the local API port and
build against the device loopback address:

```bash
adb reverse tcp:3000 tcp:3000
RAFAYPAIR_ANDROID_DEBUG_API_BASE_URL=http://localhost:3000 \
RAFAYPAIR_ANDROID_DEBUG_REALTIME_URL=ws://localhost:3000/v1/realtime \
./gradlew assembleDebug
```

Only the debug Network Security Config permits cleartext for `localhost` and the emulator alias.
Use an HTTPS/WSS development endpoint instead when the phone is not connected through ADB.

Release signing is injected only when all four protected environment variables exist:

- `RAFAYPAIR_ANDROID_STORE_FILE`
- `RAFAYPAIR_ANDROID_STORE_PASSWORD`
- `RAFAYPAIR_ANDROID_KEY_ALIAS`
- `RAFAYPAIR_ANDROID_KEY_PASSWORD`

No signing key, Qwen credential, provider key, or backend secret belongs in this application.

## Firebase Cloud Messaging configuration

Debug, unit-test, and lint builds remain usable without connecting to a Firebase project; FCM stays
disabled in that case. Staging and release artifact tasks fail closed unless protected CI supplies
all four public Android project identifiers:

- `RAFAYPAIR_FIREBASE_APPLICATION_ID` — Firebase Google App ID
- `RAFAYPAIR_FIREBASE_API_KEY` — Firebase Android client API key
- `RAFAYPAIR_FIREBASE_PROJECT_ID`
- `RAFAYPAIR_FIREBASE_SENDER_ID`

These values initialize `FirebaseOptions` at runtime. Do not commit a service-account JSON file,
FCM server credential, or private key. Server-side send authority belongs only to the notification
worker. The release build also performs the same configuration check at application startup so an
artifact assembled through a nonstandard task cannot silently ship with push disabled.

Firebase Messaging 25.1 uses its current Firebase Installation ID registration path. After the user
grants `POST_NOTIFICATIONS` from the Account screen, the app calls `register()` and receives provider
identity changes through `FirebaseMessagingService.onRegistered()`. The provider FID is sent in the
API `token` field; the app's separate stable, non-secret DataStore UUID is sent as `installationId`.
Provider identity and returned server registration state are AES-GCM encrypted with Android
Keystore. WorkManager carries no token or care content in its input data.

The only accepted data wake is exactly `{"sync":"care"}`. It schedules a constrained WorkManager
job, restores the signed-in session, performs the normal authenticated care refetch, and presents
fixed generic local text only when that server result contains a previously unseen pending incoming
request. FCM payload fields never supply visible text. Logout attempts to delete the device
registration before session revocation.

## Security and offline behavior

- Bearer and refresh tokens are AES-256-GCM encrypted with Android Keystore keys that rotate on a
  90-day generation boundary. A successful refresh atomically replaces both server tokens.
- Offline care drafts and local care summaries use Room, with user-entered text encrypted before it
  reaches SQLite. WorkManager retries only with network connectivity and the API revalidates pairing,
  consent, and privacy before delivery.
- Privacy pause is effective locally before any network request and immediately closes realtime.
  Resume remains paused until the server confirms it; it is never optimistic authorization.
- Realtime uses one-use authenticated tickets, replay cursors in DataStore, ping health checks, and
  bounded exponential recovery. No camera, microphone, sensor, or physiological data exists in this
  milestone.
