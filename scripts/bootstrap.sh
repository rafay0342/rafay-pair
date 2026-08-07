#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

./scripts/verify-toolchains.sh
corepack enable
pnpm install --frozen-lockfile=false

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  chmod 600 .env.local
  echo "Created ignored .env.local; replace development-only values before starting services."
fi

if [[ -x apps/android/gradlew ]]; then
  JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}" \
    ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/Users/irfanali/Library/Android/sdk}" \
    apps/android/gradlew -p apps/android tasks >/dev/null
fi

echo "RafayPair toolchains and workspace dependencies are ready."

