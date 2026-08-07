#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

xcrun swift-format format \
  --in-place \
  --recursive \
  --parallel \
  --configuration "$project_root/apps/ios/.swift-format" \
  "$project_root/apps/ios/RafayPair" \
  "$project_root/apps/ios/RafayPairTests" \
  "$project_root/apps/ios/RafayPairUITests"
