#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
required_node_major=24

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$node_major" != "$required_node_major" ]]; then
  echo "Node.js 24 LTS is required; found $(node --version)." >&2
  exit 1
fi

pnpm --version >/dev/null
xcodebuild -version
swift --version
xcodegen --version
xcrun swift-format --version

java_home="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
if [[ ! -x "$java_home/bin/java" ]]; then
  echo "OpenJDK 21 was not found at $java_home." >&2
  exit 1
fi
"$java_home/bin/java" -version

android_sdk_root="${ANDROID_SDK_ROOT:-/Users/irfanali/Library/Android/sdk}"
if [[ ! -d "$android_sdk_root/platforms/android-36" ]]; then
  echo "Android SDK 36 is required at $android_sdk_root." >&2
  exit 1
fi

terraform version | head -n 1
docker version --format 'Docker server {{.Server.Version}}'
if docker compose version >/dev/null 2>&1; then
  docker compose version
else
  docker-compose version
fi
actionlint -version
shellcheck --version | head -n 1

git -C "$project_root" diff --check
