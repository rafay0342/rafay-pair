#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_root="$project_root/artifacts"
mkdir -p "$artifact_root"

"$project_root/scripts/build-ios.sh"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}" \
  ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/Users/irfanali/Library/Android/sdk}" \
  "$project_root/scripts/build-android.sh"
pnpm --dir "$project_root" web
pnpm --dir "$project_root" api

find "$project_root/apps/android" -type f \( -name '*.apk' -o -name '*.aab' \) -exec cp {} "$artifact_root" \;
cp -R "$project_root/apps/web/dist" "$artifact_root/web"

echo "Unsigned/local artifacts are in $artifact_root. Protected signing jobs produce store artifacts in CI."

