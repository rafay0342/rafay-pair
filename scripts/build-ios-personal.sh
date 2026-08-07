#!/usr/bin/env bash
set -euo pipefail

# Build and export a signed iOS app using a free personal Apple ID.
#
# Run this from Terminal.app, not from an automation session. Signing needs the
# private key in your login keychain, and a background session cannot reach it —
# it reports "User interaction is not allowed" and the certificate install fails
# with a write-permissions error. Nothing else about this is manual.
#
# A personal team cannot sign Push Notifications or App Attest; Apple restricts
# both to the paid Developer Program. This build therefore declares neither, and
# what that costs is stated in RafayPair-personal.entitlements: push does not
# arrive, and the server cannot verify this install's integrity. Everything else
# works.
#
# The resulting app is signed for seven days. That is the free-account rule, not
# a choice made here.

TEAM_ID="${APPLE_TEAM_ID:-HPBV3NY87T}"
# The deployed endpoint. Xcode's build settings treat "//" as a comment, which
# is why every xcconfig in this project writes a URL as `https:/$()/host`; the
# same escape is applied here rather than leaving a truncated URL in Info.plist.
API_URL="${RAFAYPAIR_IOS_API_URL:-https://34-134-185-230.sslip.io}"
OUT_DIR="${RAFAYPAIR_OUT_DIR:-$HOME/Desktop/RafayPair-release}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RAFAYPAIR_IOS_WORK_DIR:-$PROJECT_ROOT/artifacts/ios-personal}"
ENTITLEMENTS="RafayPair/Resources/RafayPair-personal.entitlements"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking this is a session that can sign"
if ! security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  fail "The login keychain is not reachable from this shell.
    Open Terminal.app and run this script there. Signing reads a private key
    from the login keychain, which an automation session cannot open."
fi
note "login keychain reachable"

step "Checking for a connected iPhone"
# A personal team's provisioning profile lists the specific devices it may run
# on, so the phone has to be present when the profile is created. Plugged in
# over USB is the reliable way; wireless works only if the device is unlocked
# and already paired.
if xcrun devicectl list devices 2>/dev/null | grep -qi "connected"; then
  note "a device is connected"
else
  printf '    \033[33mNo connected device detected.\033[0m\n'
  note "Unlock the iPhone, connect it by cable, and trust this Mac if asked."
  note "Continuing anyway — Xcode may still succeed if the device is already registered."
fi

step "Generating the project"
cd "$PROJECT_ROOT/apps/ios"
xcodegen generate >/dev/null

step "Archiving with the personal-team entitlements"
mkdir -p "$WORK_DIR"
rm -rf "$WORK_DIR/RafayPair.xcarchive"
# Debug rather than Release: the Release archive runs a pre-build check that
# requires the audited production entitlements, which is exactly what a personal
# team cannot sign. Keeping that check intact matters more than the
# configuration name.
xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK_DIR/RafayPair.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS" \
  RAFAYPAIR_API_BASE_URL="$(printf '%s' "$API_URL" | sed 's|://|:/$()/|')" \
  archive \
  || fail "The archive failed. If it mentions a certificate or a profile, open
    Xcode once, go to Settings -> Accounts, select the Apple ID, and click
    'Manage Certificates' -> '+' -> 'Apple Development'. Then run this again."

step "Exporting an installable app"
export_options="$WORK_DIR/ExportOptions.plist"
cat > "$export_options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>development</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>stripSwiftSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
PLIST

rm -rf "$WORK_DIR/export"
xcodebuild \
  -exportArchive \
  -archivePath "$WORK_DIR/RafayPair.xcarchive" \
  -exportPath "$WORK_DIR/export" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates \
  || fail "The export failed. The archive is still at $WORK_DIR/RafayPair.xcarchive."

ipa="$(find "$WORK_DIR/export" -maxdepth 1 -name '*.ipa' -print -quit)"
[[ -n "$ipa" ]] || fail "No .ipa was produced."

mkdir -p "$OUT_DIR"
cp "$ipa" "$OUT_DIR/RafayPair-personal.ipa"

step "Verifying what was signed"
codesign -dv --entitlements :- "$WORK_DIR/RafayPair.xcarchive/Products/Applications/RafayPair.app" 2>&1 \
  | grep -E "Authority|TeamIdentifier|aps-environment|appattest" | sed 's/^/    /' || true

cat <<SUMMARY

$(printf '\033[1mDone.\033[0m')

  IPA        $OUT_DIR/RafayPair-personal.ipa
  Archive    $WORK_DIR/RafayPair.xcarchive
  API        $API_URL

  Install it with the iPhone connected:

    xcrun devicectl device install app --device <name> "$OUT_DIR/RafayPair-personal.ipa"

  Or drag the .ipa onto the device in Xcode -> Window -> Devices and Simulators.

$(printf '\033[1mWhat this build cannot do\033[0m')

  Push notifications and App Attest are absent, because a free personal team
  cannot sign either. It also stops working after seven days — an Apple rule for
  free accounts, not a setting. Both go away with a paid Developer Program
  membership, after which scripts/archive-ios.sh produces the real signed IPA
  with those capabilities intact.

SUMMARY
