#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# bundleRelease verifies production FCM and Play Integrity identifiers that are
# only injected through protected CI variables. Build it when they are present;
# local machines produce the debug and development APKs required by Gate 1.
tasks=(assembleDebug assembleDevelopment)
if [[ -n "${RAFAYPAIR_FIREBASE_API_KEY:-}" &&
  -n "${RAFAYPAIR_FIREBASE_APPLICATION_ID:-}" &&
  -n "${RAFAYPAIR_FIREBASE_PROJECT_ID:-}" &&
  -n "${RAFAYPAIR_FIREBASE_SENDER_ID:-}" &&
  -n "${RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER:-}" ]]; then
  tasks+=(bundleRelease)
else
  echo "build-android: production identifiers absent; skipping bundleRelease (CI-only)." >&2
fi

"$project_root/apps/android/gradlew" -p "$project_root/apps/android" \
  --configuration-cache \
  "${tasks[@]}"
