#!/bin/sh
set -eu

# Simulator compilation remains unsigned. Every distributable Release archive
# must carry a real Apple team, the registered bundle ID, and production App
# Attest entitlement; an absent identifier is a hard release failure.
if [ "${CONFIGURATION:-}" != "Release" ] || [ "${PLATFORM_NAME:-}" != "iphoneos" ]; then
  exit 0
fi

case "${DEVELOPMENT_TEAM:-}" in
  [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) ;;
  *) echo "Release requires a real 10-character DEVELOPMENT_TEAM." >&2; exit 1 ;;
esac

if [ "${PRODUCT_BUNDLE_IDENTIFIER:-}" != "com.rafaypair.app" ]; then
  echo "Release PRODUCT_BUNDLE_IDENTIFIER must be com.rafaypair.app." >&2
  exit 1
fi

if [ "${RAFAYPAIR_APP_ATTEST_ENVIRONMENT:-}" != "production" ]; then
  echo "Release App Attest entitlement must use the production environment." >&2
  exit 1
fi

if [ "${CODE_SIGN_ENTITLEMENTS:-}" != "RafayPair/Resources/RafayPair.entitlements" ]; then
  echo "Release must sign the audited RafayPair entitlements file." >&2
  exit 1
fi
