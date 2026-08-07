#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root/apps/ios"

if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
fi

destination="platform=iOS Simulator,name=iPhone 17 Pro"
xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration Debug \
  -destination "$destination" \
  test
