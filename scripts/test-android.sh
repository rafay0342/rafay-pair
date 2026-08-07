#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$project_root/apps/android/gradlew" -p "$project_root/apps/android" \
  --configuration-cache \
  testDebugUnitTest lintDevelopment
